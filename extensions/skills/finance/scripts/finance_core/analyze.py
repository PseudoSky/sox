"""P0 portfolio analysis. Analysis only: reads the current snapshot and plans, never creates orders."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

from . import paper, plans
from .accounts import list_accounts, load_account, load_current
from .errors import FinanceError
from .layout import Layout, atomic_write_json, check_id
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
    equity = cash + sum((v for _, _, v in valued), Decimal(0))
    cash_equivalents = sum((v for _, p, v in valued if p["asset_type"] == "cash_equivalent"), Decimal(0))
    by_type: dict[str, Decimal] = {}
    by_ccy: dict[str, Decimal] = {account["base_currency"]: cash}
    for _, pos, value in valued:
        by_type[pos["asset_type"]] = by_type.get(pos["asset_type"], Decimal(0)) + value
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
                       "market_value": _cents(v)} for k, p, v in valued],
        "concentration_flags": sorted(flags, key=lambda f: -Decimal(f["pct"])),
        "top_concentration": [{"key": k, "pct": _pct(abs(v), equity)} for k, _, v in top],
        "open_risk": money_str(risk),
        "open_risk_pct": _pct(risk, equity),
        "active_plans": [{"plan_id": p["plan_id"], "symbol": p["symbol"], "status": p["status"]} for p in active],
        "warnings": warnings,
    }


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
    atomic_write_json(path, analysis)
    return path
