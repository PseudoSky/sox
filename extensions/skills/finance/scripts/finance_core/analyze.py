"""P0 portfolio analysis. Analysis only: reads the current snapshot and plans, never creates orders."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

from . import paper, plans
from .accounts import list_accounts, load_account, load_current
from .errors import FinanceError
from .layout import Layout, check_id, write_receipt
from .money import money_str, parse_money

STALE_DAYS = 5
CONCENTRATION_LIMIT_PCT = Decimal("25")
PCT = Decimal("0.01")
CENT = Decimal("0.01")


def _cents(value: Decimal) -> str:
    return money_str(value.quantize(CENT))


def _pct(part: Decimal, equity: Decimal) -> str | None:
    if equity == 0:
        return None
    return money_str((part / equity * 100).quantize(PCT))


def _multiplier(pos: dict[str, Any]) -> Decimal:
    opt = pos.get("option")
    if opt:
        return parse_money(str(opt.get("multiplier", 100)), "multiplier")
    return Decimal(1)


def analyze_account(layout: Layout, account_id: str, as_of: str | None = None) -> dict[str, Any]:
    account = load_account(layout, account_id)
    record, _ = load_current(layout, account_id)
    as_of = as_of or record["as_of"]
    as_of_date = date.fromisoformat(as_of)
    state = paper.positions_now(layout, account_id)
    cash = state["cash"]
    warnings: list[str] = []
    valued: list[tuple[str, dict[str, Any], Decimal]] = []
    complete = True
    for pos in state["positions"].values():
        key = pos["symbol"]
        if pos.get("last_price") is None:
            warnings.append(f"missing last_price: {key}")
            complete = False
            continue
        value = parse_money(pos["qty"], "qty") * parse_money(pos["last_price"], "last_price") * _multiplier(pos)
        valued.append((key, pos, value))
        pad = (pos.get("price_as_of") or "")[:10]
        if pad and (as_of_date - date.fromisoformat(pad)).days > STALE_DAYS:
            warnings.append(f"stale price: {key}")
    marks = sorted({(p.get("price_as_of") or "")[:10] for _, p, _ in valued} - {""})
    if len(marks) > 1:
        newer = [k for k, p, _ in valued if (p.get("price_as_of") or "")[:10] == marks[-1]]
        warnings.append(f"mixed price dates {', '.join(marks)}: {', '.join(newer)} marked {marks[-1]}, "
                        "the other positions keep their earlier marks; equity moves with the re-mark")
    equity = cash + sum((v for _, _, v in valued), Decimal(0))
    cash_equivalents = sum((v for _, p, v in valued if p["asset_type"] == "cash_equivalent"), Decimal(0))
    by_type: dict[str, Decimal] = {"cash": cash} if cash else {}
    cost_total = Decimal(0)
    value_total = Decimal(0)
    pnl_rows: dict[str, dict[str, str | None]] = {}
    by_ccy: dict[str, Decimal] = {account["base_currency"]: cash}
    for _, pos, value in valued:
        by_type[pos["asset_type"]] = by_type.get(pos["asset_type"], Decimal(0)) + value
        avg = pos.get("avg_cost")
        if avg is not None and pos["asset_type"] != "cash_equivalent":
            cost = parse_money(pos["qty"], "qty") * parse_money(avg, "avg_cost") * _multiplier(pos)
            cost_total += cost
            value_total += value
            pnl_rows[pos["symbol"]] = {"cost_basis": _cents(cost), "unrealized_pnl": _cents(value - cost),
                                       "unrealized_pct": _pct(value - cost, cost)}
        ccy = pos.get("currency", account["base_currency"])
        by_ccy[ccy] = by_ccy.get(ccy, Decimal(0)) + value
    top = sorted(valued, key=lambda t: (-abs(t[2]), t[0]))[:5]
    flags = [{"key": k, "pct": _pct(abs(v), equity)} for k, p, v in valued
             if p["asset_type"] != "cash_equivalent" and equity != 0 and abs(v) / equity * 100 > CONCENTRATION_LIMIT_PCT]
    risk = plans.open_risk(layout, account_id, as_of)
    active = plans.list_plans(layout, account_id=account_id, status="active", as_of=as_of)
    return {
        "account_id": account_id,
        "base_currency": account["base_currency"],
        "as_of": as_of,
        "snapshot_as_of": record["as_of"],
        "cash": _cents(cash),
        "cash_equivalents": _cents(cash_equivalents),
        "equity": _cents(equity),
        "equity_complete": complete,
        "allocation": {
            "by_asset_type": {k: _pct(v, equity) for k, v in sorted(by_type.items())},
            "by_currency": {k: _pct(v, equity) for k, v in sorted(by_ccy.items())},
        },
        "cash_pct": _pct(cash + cash_equivalents, equity),
        "positions": [{"key": k, "qty": p["qty"], "last_price": p["last_price"],
                       "market_value": _cents(v), "price_as_of": (p.get("price_as_of") or "")[:10] or None,
                       "avg_cost": p.get("avg_cost"), **pnl_rows.get(p["symbol"], {})}
                      for k, p, v in valued],
        "unrealized": {"cost_basis": _cents(cost_total), "market_value": _cents(value_total),
                       "pnl": _cents(value_total - cost_total), "pnl_pct": _pct(value_total - cost_total, cost_total),
                       "basis": "average cost from the broker snapshot; cash equivalents excluded; not tax advice"},
        "realized": paper.realized_fills(layout, account_id),
        "ledger_seq": paper.ledger_seq(layout, account_id),
        "concentration_flags": sorted(flags, key=lambda f: -Decimal(f["pct"])),
        "top_concentration": [{"key": k, "pct": _pct(abs(v), equity)} for k, _, v in top],
        "open_risk": money_str(risk),
        "open_risk_pct": _pct(risk, equity),
        "active_plans": [{"plan_id": p["plan_id"], "symbol": p["symbol"], "status": p["status"]} for p in active],
        "warnings": warnings,
    }


SNAPSHOT_WARN_DAYS = 2


def snapshot_age_warning(snapshot_as_of: str, ref: date) -> str | None:
    """Warn when the imported snapshot is at least two days older than the reference date."""
    age = (ref - date.fromisoformat(snapshot_as_of)).days
    if age < SNAPSHOT_WARN_DAYS:
        return None
    return (f"snapshot is {age} days old ({snapshot_as_of}, reference {ref.isoformat()}): positions and prices "
            "may have moved; re-ingest a fresh export before acting")


def consolidated(layout: Layout, account_ids: list[str] | None = None) -> dict[str, Any]:
    groups: dict[str, dict[str, Any]] = {}
    for account_id in (account_ids if account_ids is not None else list_accounts(layout)):
        result = analyze_account(layout, account_id)
        grp = groups.setdefault(result["base_currency"], {"accounts": [], "_eq": Decimal(0), "equity_complete": True})
        grp["accounts"].append(account_id)
        grp["_eq"] += parse_money(result["equity"], "equity")
        grp["equity_complete"] = grp["equity_complete"] and result["equity_complete"]
    return {"groups": {c: {"accounts": g["accounts"], "equity": _cents(g["_eq"]),
                           "equity_complete": g["equity_complete"]} for c, g in sorted(groups.items())}}


def write_analysis(layout: Layout, analysis: dict[str, Any]) -> Path:
    check_id(analysis.get("account_id"), "account_id")
    if not analysis.get("as_of"):
        raise FinanceError("analysis: as_of required")
    layout.ensure_base()
    path = layout.analysis_dir() / f"{analysis['account_id']}-{analysis['as_of']}.json"
    write_receipt(path, analysis)
    return path
