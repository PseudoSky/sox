"""P4 income read: trailing-12-month dividends per position from the market-data capability's cache."""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from . import paper
from .accounts import load_current
from .errors import FinanceError
from .layout import Layout, atomic_write_json
from .marketdata import get_bars
from .money import money_str, parse_money

CENT = Decimal("0.01")
YIELD_PLACES = Decimal("0.01")


def write_income(layout: Layout, result: dict[str, Any]) -> str:
    layout.ensure_base()
    folder = layout.base / "income"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{result['account_id']}-{result['as_of']}.json"
    atomic_write_json(path, result)
    return str(path)


def income_for_account(layout: Layout, account_id: str, as_of: str | None = None) -> dict[str, Any]:
    record, _ = load_current(layout, account_id)
    as_of_date = date.fromisoformat(as_of or record["as_of"])
    since = as_of_date - timedelta(days=365)
    rows: list[dict[str, Any]] = []
    warnings: list[str] = []
    total = Decimal(0)
    for pos in paper.positions_now(layout, account_id)["positions"].values():
        if pos["asset_type"] in ("cash_equivalent", "option"):
            continue
        symbol = pos["symbol"]
        try:
            bars = get_bars(layout, symbol, "2y")
        except FinanceError as exc:
            warnings.append(f"{symbol}: dividend history unavailable ({exc})")
            continue
        paid = [d for d in bars["dividends"] if since < date.fromisoformat(d["date"]) <= as_of_date]
        per_share = sum((Decimal(d["amount"]) for d in paid), Decimal(0))
        qty = parse_money(pos["qty"], "qty")
        annual = per_share * qty
        total += annual
        last_close = Decimal(bars["bars"][-1]["close"])
        rows.append({"symbol": symbol, "qty": pos["qty"], "payments_12m": len(paid),
                     "per_share_12m": money_str(per_share), "income_12m": money_str(annual.quantize(CENT)),
                     "trailing_yield_pct": money_str((per_share / last_close * 100).quantize(YIELD_PLACES)) if last_close else None})
        if len(paid) == 1:
            warnings.append(f"{symbol}: one payment in 12 months; the history may be partial or the payer is annual")
        if not paid:
            warnings.append(f"{symbol}: no dividends recorded in the last 12 months")
    return {"account_id": account_id, "as_of": as_of_date.isoformat(), "positions": rows,
            "income_12m_total": money_str(total.quantize(CENT)), "warnings": warnings,
            "basis": "paid dividends in the trailing 365 days times current quantity; not a forecast. "
                     "A broker-reported yield may use a different basis (for example last payment times 12)."}
