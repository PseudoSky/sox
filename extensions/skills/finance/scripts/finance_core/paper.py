"""Paper brokerage: current snapshot + append-only ledger (<account_dir>/ledger.jsonl).

Paper only. Live brokerages are NOT implemented: there is no network access, no
credentials, and no broker calls anywhere in this module. State is the current
snapshot plus every ledger event whose ``ts`` is later than the snapshot's
``imported_at``. The ledger is opened in append mode and never rewritten.

Ledger ``ts`` is the wall-clock time the event was recorded (it orders replay
against the snapshot); a fill additionally carries ``bar_ts``, the bar it filled on.
"""

from __future__ import annotations

import json
import os
from decimal import Decimal
from typing import Any

from .accounts import (DEFAULT_FILL_RULES, ORDER_TYPES, load_account, load_current, utc_now)
from .errors import FinanceError
from .layout import Layout
from .money import money_str, parse_money, parse_qty

SIDES = {"buy", "sell"}
_ZERO = Decimal(0)


def _norm(value: object, field: str) -> str:
    number = value if isinstance(value, Decimal) else parse_money(value, field)
    return money_str(number.normalize()) if number != 0 else "0"


def position_key(position: dict[str, Any]) -> str:
    """Options key by 'SYMBOL|YYYY-MM-DD|C|strike|multiplier'; equities by symbol."""
    option = position.get("option")
    if option:
        return "|".join([str(option["underlying"]), str(option["expiry"]), str(option["right"]),
                         _norm(option["strike"], "strike"), _norm(option.get("multiplier", "100"), "multiplier")])
    return str(position["symbol"])


def _ledger_path(layout: Layout, account_id: str):
    return layout.account_dir(account_id) / "ledger.jsonl"


def _read_events(layout: Layout, account_id: str) -> list[dict[str, Any]]:
    path = _ledger_path(layout, account_id)
    if not path.exists():
        return []
    events = []
    with path.open("r", encoding="utf-8") as handle:
        for number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise FinanceError(f"ledger line {number} is not valid JSON: {exc}") from exc
    return events


def record_event(layout: Layout, account_id: str, event: dict[str, Any]) -> dict[str, Any]:
    """Append one event with the next seq and a fresh ts. Never rewrites the file."""
    path = _ledger_path(layout, account_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    events = _read_events(layout, account_id)
    seq = (events[-1]["seq"] if events else 0) + 1
    stored = {**event, "seq": seq, "ts": utc_now()}
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(stored, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    return stored


def _apply_fill(cash: Decimal, positions: dict[str, dict[str, Any]], fill: dict[str, Any]) -> Decimal:
    qty, price, fee = Decimal(fill["qty"]), Decimal(fill["price"]), Decimal(fill["fee"])
    mult = Decimal(fill["multiplier"])
    option = fill.get("option")
    key = position_key({"symbol": fill["symbol"], "option": option})
    pos = positions.get(key)
    if fill["side"] == "buy":
        cash -= price * qty * mult + fee
        if pos is None:
            pos = {"symbol": fill["symbol"], "asset_type": "option" if option else "equity",
                   "option": option, "qty": "0", "avg_cost": money_str(price),
                   "currency": fill.get("currency")}
        held = Decimal(pos["qty"])
        new_qty = held + qty
        if held > 0:
            pos["avg_cost"] = money_str((held * Decimal(pos["avg_cost"]) + qty * price) / new_qty)
        else:
            pos["avg_cost"] = money_str(price)
        pos["qty"] = money_str(new_qty)
        positions[key] = pos
    else:
        cash += price * qty * mult - fee
        assert pos is not None
        remaining = Decimal(pos["qty"]) - qty
        if remaining == 0:
            del positions[key]
        else:
            pos["qty"] = money_str(remaining)
    if key in positions:
        positions[key]["last_price"] = fill["price"]
        positions[key]["price_as_of"] = fill.get("bar_ts")
    return cash


def positions_now(layout: Layout, account_id: str) -> dict[str, Any]:
    record, pointer = load_current(layout, account_id)
    cash = parse_money(record.get("cash", "0"), "cash")
    positions = {position_key(p): dict(p) for p in record.get("positions", [])}
    orders: dict[str, dict[str, Any]] = {}
    as_of = record.get("as_of", "")
    for event in _read_events(layout, account_id):
        if event["ts"] <= pointer["imported_at"]:
            continue
        kind = event["type"]
        as_of = event["ts"]
        if kind == "order":
            orders[event["order_id"]] = event["order"]
        elif kind == "fill":
            cash = _apply_fill(cash, positions, event)
            orders.pop(event["order_id"], None)
        elif kind in ("reject", "cancel"):
            orders.pop(event["order_id"], None)
    open_list = [{"order_id": oid, **order} for oid, order in orders.items()]
    return {"cash": cash, "positions": positions, "open_orders": open_list, "as_of": as_of}


def open_orders(layout: Layout, account_id: str) -> list[dict[str, Any]]:
    return positions_now(layout, account_id)["open_orders"]


def _option_spec(asset: dict[str, Any]) -> dict[str, Any]:
    for field in ("underlying", "expiry", "strike", "right"):
        if field not in asset:
            raise FinanceError(f"asset.{field}: missing")
    if asset["right"] not in ("C", "P"):
        raise FinanceError("asset.right: must be C or P")
    expiry = str(asset["expiry"])
    if len(expiry) != 10 or expiry[4] != "-" or expiry[7] != "-" or not expiry.replace("-", "").isdigit():
        raise FinanceError("asset.expiry: expected YYYY-MM-DD")
    strike = parse_money(asset["strike"], "asset.strike")
    if strike <= 0:
        raise FinanceError("asset.strike: must be positive")
    mult = parse_money(asset.get("multiplier", "100"), "asset.multiplier")
    if mult <= 0:
        raise FinanceError("asset.multiplier: must be positive")
    return {"underlying": str(asset["underlying"]), "expiry": expiry, "right": asset["right"],
            "strike": _norm(strike, "strike"), "multiplier": _norm(mult, "multiplier")}


def _held_long(state: dict[str, Any], key: str) -> Decimal:
    pos = state["positions"].get(key)
    return max(Decimal(pos["qty"]), _ZERO) if pos else _ZERO


def place_order(layout: Layout, account_id: str, order: dict[str, Any]) -> str:
    account = load_account(layout, account_id)
    order_type, side = order.get("type"), order.get("side")
    if order_type not in ORDER_TYPES:
        raise FinanceError(f"type: must be one of {sorted(ORDER_TYPES)}")
    if side not in SIDES:
        raise FinanceError("side: must be buy or sell")
    qty = parse_qty(order.get("qty"), "qty")
    if qty <= 0:
        raise FinanceError("qty: must be positive")
    if not order.get("symbol"):
        raise FinanceError("symbol: missing")
    stored: dict[str, Any] = {"symbol": order["symbol"], "side": side, "qty": money_str(qty),
                              "type": order_type, "plan_id": order.get("plan_id"),
                              "fill_rules": order.get("fill_rules") or {}, "option": None}
    if order_type == "limit":
        stored["limit_price"] = money_str(parse_money(order.get("limit_price"), "limit_price"))
    if order_type in ("stop_entry", "stop_loss"):
        stored["stop_price"] = money_str(parse_money(order.get("stop_price"), "stop_price"))
    if order.get("asset"):
        if account.get("options") != "full_fills":
            raise FinanceError("option orders are refused: account options mode is holdings_only")
        stored["option"] = _option_spec(order["asset"])
    if side == "sell":
        held = _held_long(positions_now(layout, account_id),
                          position_key({"symbol": stored["symbol"], "option": stored["option"]}))
        if qty > held:
            raise FinanceError(f"sell {money_str(qty)} exceeds held long quantity {money_str(held)} (no shorting)")
    seq = (_read_events(layout, account_id) or [{"seq": 0}])[-1]["seq"] + 1
    order_id = f"ord-{seq}"
    record_event(layout, account_id, {"type": "order", "order_id": order_id, "order": stored})
    return order_id


def _rule(account: dict[str, Any], order: dict[str, Any]) -> dict[str, Any]:
    t = order["type"]
    return {**DEFAULT_FILL_RULES[t], **(account.get("fill_rules") or {}).get(t, {}),
            **(order.get("fill_rules") or {}).get(t, {})}


def _fill_price(mode: str, order: dict[str, Any], o: Decimal, hi: Decimal, lo: Decimal) -> Decimal | None:
    buy = order["side"] == "buy"
    if mode == "open":
        return o
    if mode == "limit":
        limit = parse_money(order.get("limit_price"), "limit_price")
        if buy:
            return min(o, limit) if lo <= limit else None
        return max(o, limit) if hi >= limit else None
    if mode in ("trigger", "trigger_or_gap"):
        stop = parse_money(order.get("stop_price"), "stop_price")
        if buy:
            return max(o, stop) if hi >= stop else None
        return min(o, stop) if lo <= stop else None
    raise FinanceError(f"unknown fill mode {mode!r}")


def fill_bar(layout: Layout, account_id: str, order_id: str, bar: dict[str, Any]) -> dict[str, Any]:
    account = load_account(layout, account_id)
    state = positions_now(layout, account_id)
    order = next((o for o in state["open_orders"] if o["order_id"] == order_id), None)
    if order is None:
        raise FinanceError(f"order {order_id} is not open")
    o, hi, lo = (parse_money(bar.get(k), f"bar.{k}") for k in ("open", "high", "low"))
    parse_money(bar.get("close"), "bar.close")
    rule = _rule(account, order)
    price = _fill_price(rule["fill"], order, o, hi, lo)
    if price is None:
        return {"status": "open"}
    bps = parse_money(account.get("slippage_bps", "0"), "slippage_bps")
    if rule.get("slippage") and bps:
        factor = Decimal(1) + bps / 10000 if order["side"] == "buy" else Decimal(1) - bps / 10000
        price = price * factor
    qty = Decimal(order["qty"])
    option = order.get("option")
    commission = account["commission"]
    fee = parse_money(commission["per_contract" if option else "per_share"], "commission") * qty
    key = position_key({"symbol": order["symbol"], "option": option})
    if order["side"] == "sell" and qty > _held_long(state, key):
        ev = record_event(layout, account_id, {"type": "reject", "order_id": order_id,
                                               "reason": "sell exceeds held long quantity at fill time",
                                               "bar_ts": bar.get("ts")})
        return {"status": "rejected", "order_id": order_id, "seq": ev["seq"]}
    realized = None
    if order["side"] == "sell":
        held = state["positions"].get(key, {})
        if held.get("avg_cost") is not None:
            mult = Decimal(option["multiplier"]) if option else Decimal(1)
            realized = money_str(((price - Decimal(held["avg_cost"])) * qty * mult - fee).quantize(Decimal("0.01")))
    fill = {"type": "fill", "order_id": order_id, "price": money_str(price), "qty": money_str(qty),
            "fee": money_str(fee), "side": order["side"], "symbol": order["symbol"], "option": option,
            "multiplier": option["multiplier"] if option else "1", "bar_ts": bar.get("ts"),
            "currency": account.get("base_currency"), "realized_pnl": realized,
            "fill_rule": {"order_type": order["type"], "mode": rule["fill"], "bar_open": money_str(o)}}
    ev = record_event(layout, account_id, fill)
    after = positions_now(layout, account_id)["cash"]
    warnings = [f"cash is now {money_str(after)}: the fill exceeds the account's cash and the paper ledger has no "
                "margin or buying-power limit"] if after < 0 else []
    return {"status": "filled", "warnings": warnings, "side": order["side"], "symbol": order["symbol"], "realized_pnl": realized,
            "fill_rule": fill["fill_rule"],
            **{k: ev[k] for k in ("order_id", "price", "qty", "fee", "seq", "ts", "bar_ts")}}


def ledger_seq(layout: Layout, account_id: str) -> int:
    """Sequence number of the last ledger event; 0 when the account has no paper activity."""
    events = _read_events(layout, account_id)
    return events[-1]["seq"] if events else 0


def realized_fills(layout: Layout, account_id: str) -> dict[str, Any]:
    """Paper sells since the current snapshot, with realized P&L from the average cost at the fill."""
    _, pointer = load_current(layout, account_id)
    rows, total, unknown = [], Decimal(0), 0
    for event in _read_events(layout, account_id):
        if event["type"] != "fill" or event["ts"] <= pointer["imported_at"] or event["side"] != "sell":
            continue
        pnl = event.get("realized_pnl")
        unknown += pnl is None
        total += Decimal(pnl) if pnl is not None else 0
        rows.append({"seq": event["seq"], "symbol": event["symbol"], "qty": event["qty"], "price": event["price"],
                     "realized_pnl": pnl, "bar_ts": event.get("bar_ts")})
    return {"fills": rows, "realized_pnl": money_str(total.quantize(Decimal("0.01"))),
            "unknown_cost_fills": unknown,
            "basis": "price minus the average cost at the fill, times quantity, minus fees; not tax advice"}


def cancel_order(layout: Layout, account_id: str, order_id: str) -> dict[str, Any]:
    if not any(o["order_id"] == order_id for o in open_orders(layout, account_id)):
        raise FinanceError(f"order {order_id} is not open; cannot cancel")
    return record_event(layout, account_id, {"type": "cancel", "order_id": order_id})


def reconcile(layout: Layout, account_id: str, statement_record: dict[str, Any]) -> list[dict[str, Any]]:
    """Pure comparison of ledger-derived state to a broker statement. Never fixes anything."""
    state = positions_now(layout, account_id)
    ledger = state["positions"]
    statement = {position_key(p): p for p in statement_record.get("positions", [])}
    out: list[dict[str, Any]] = []
    for key in sorted(set(ledger) | set(statement)):
        if key not in statement:
            out.append({"kind": "missing_in_statement", "key": key, "ledger_qty": ledger[key]["qty"]})
        elif key not in ledger:
            out.append({"kind": "missing_in_ledger", "key": key, "statement_qty": statement[key]["qty"]})
        elif Decimal(ledger[key]["qty"]) != parse_money(statement[key]["qty"], "qty"):
            out.append({"kind": "qty_mismatch", "key": key, "ledger_qty": ledger[key]["qty"],
                        "statement_qty": statement[key]["qty"]})
    stmt_cash = parse_money(statement_record.get("cash", "0"), "cash")
    if state["cash"] != stmt_cash:
        out.append({"kind": "cash_mismatch", "ledger_cash": money_str(state["cash"]),
                    "statement_cash": money_str(stmt_cash)})
    return out


__all__ = ["record_event", "positions_now", "place_order", "fill_bar", "cancel_order",
           "open_orders", "reconcile", "position_key"]
