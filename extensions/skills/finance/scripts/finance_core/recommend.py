"""Decision-support recommendations for one account: concentration trims, entry policy, watchlist, proposals.

Every number is derived from the snapshot, the posture receipt and an optional screen file. Nothing here
places an order; a proposal is a sized suggestion the owner may reject.
"""
from __future__ import annotations

import json
from datetime import date
from decimal import ROUND_CEILING, ROUND_DOWN, Decimal
from pathlib import Path
from typing import Any

from . import analyze, paper, posture, screen
from .layout import Layout, write_receipt
from .money import money_str, parse_money

CENT = Decimal("0.01")
WATCH_MIN_SCORE = 45
WATCH_MAX = 8
BASE_RISK_PCT = Decimal("0.5")


def _trims(layout: Layout, account_id: str, result: dict[str, Any], limit: Decimal,
           notes: list[str]) -> list[dict[str, Any]]:
    equity = parse_money(result["equity"], "equity")
    held = paper.positions_now(layout, account_id)["positions"]
    out = []
    for flag in result["concentration_flags"]:
        row = next(p for p in result["positions"] if p["key"] == flag["key"])
        pos = held[flag["key"]]
        price, qty = parse_money(row["last_price"], "price"), parse_money(row["qty"], "qty")
        value = price * qty
        excess = value - equity * limit / 100
        if (excess / price).to_integral_value(rounding=ROUND_DOWN) < 1:
            notes.append(f"{row['key']} is {flag['pct']}% of equity, above the {limit}% limit, but the excess "
                         f"(${excess.quantize(CENT):,.2f}) is less than one share at {money_str(price)}, so no trim is proposed")
            continue
        shares = (excess / price).to_integral_value(rounding=ROUND_CEILING)  # whole shares that reach the limit
        proceeds = shares * price
        avg = parse_money(pos["avg_cost"], "avg_cost") if pos.get("avg_cost") is not None else None
        after_pct = ((value - proceeds) / equity * 100).quantize(CENT)
        gain = (shares * (price - avg)).quantize(CENT) if avg is not None else None
        text = (f"Sell {shares} {row['key']} at about {money_str(price)} for roughly ${proceeds:,.2f}, which takes it "
                f"from {flag['pct']}% to {after_pct}% of equity")
        text += f"; the estimated realized gain on average cost is ${gain:,.2f}." if gain is not None else "."
        out.append({
            "type": "trim", "priority": 1, "symbol": row["key"], "text": text,
            "reason": f"{row['key']} is {flag['pct']}% of equity, above the {limit}% single-position limit",
            "proposal": {"side": "sell", "qty": str(shares), "reference_price": money_str(price),
                         "order_type": "limit", "est_proceeds": money_str(proceeds.quantize(CENT))},
            "after": {"position_pct": money_str(after_pct),
                      "proceeds_as_pct_of_equity": money_str((proceeds / equity * 100).quantize(CENT))},
            "est_realized_gain": money_str(gain) if gain is not None else None,
            "alternative": {"new_money_in_other_holdings": money_str((value / limit * 100 - equity).quantize(CENT)),
                            "meaning": "instead of selling, adding this much new money to other holdings brings "
                                       "the same position down to the limit"},
            "caveat": "The gain is an estimate from average cost; taxes and wash-sale rules are not modelled and "
                      "this is not advice.",
        })
    return out


def _entry_policy(posture_receipt: dict[str, Any] | None) -> dict[str, Any]:
    if posture_receipt is None:
        return {"type": "entry-policy", "priority": 2, "posture": None, "risk_pct_per_trade": None,
                "action": "run `market posture` first; no current posture receipt, so no entry policy is stated"}
    state = posture_receipt["posture"]
    risk = {"full": BASE_RISK_PCT, "reduced": BASE_RISK_PCT * posture.REDUCED_RISK_FACTOR, "no-new-entries": Decimal(0)}[state]
    action = {"full": "new entries allowed at the normal risk",
              "reduced": f"new entries allowed at half the normal risk ({risk}% of equity per trade)",
              "no-new-entries": "no new entries"}[state]
    return {"type": "entry-policy", "priority": 2, "posture": state, "as_of": posture_receipt["as_of"],
            "risk_pct_per_trade": str(risk), "action": action, "because": posture_receipt["reasons"]}


def _watch(data: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for r in data.get("results", []):
        if r.get("valid_vcp") or (r.get("composite_score") or 0) < WATCH_MIN_SCORE:
            continue
        pattern = r.get("vcp_pattern") or {}
        rows.append({"symbol": r["symbol"], "score": r.get("composite_score"), "rating": r.get("rating"),
                     "state": r.get("execution_state"), "pivot_price": pattern.get("pivot_price"),
                     "price": r.get("price"), "status": "monitor only: not a valid VCP, no entry"})
    rows.sort(key=lambda w: -(w["score"] or 0))
    return rows[:WATCH_MAX]


def recommend_for_account(layout: Layout, account_id: str, screen_path: str | None = None,
                          limit_pct: str = "25", today: date | None = None) -> dict[str, Any]:
    limit = parse_money(limit_pct, "limit_pct")
    result = analyze.analyze_account(layout, account_id)
    receipt = posture.latest_posture(layout, today)
    notes: list[str] = []
    items = _trims(layout, account_id, result, limit, notes)
    policy = _entry_policy(receipt)
    items.append(policy)
    out: dict[str, Any] = {"account_id": account_id, "as_of": result["as_of"], "limit_pct": str(limit),
                           "decision_support": True, "items": items, "proposals": [], "watchlist": [],
                           "positions_seq": result["ledger_seq"], "screen": screen_path,
                           "warnings": list(result["warnings"]) + notes}
    age = analyze.snapshot_age_warning(result["snapshot_as_of"], today or date.today())
    if age:
        out["warnings"].append(age)
    if screen_path is not None:
        data = json.loads(Path(screen_path).read_text(encoding="utf-8"))
        out["watchlist"] = _watch(data)
        risk = policy["risk_pct_per_trade"]
        if risk is None or Decimal(risk) > 0:
            planner = screen.run_planner(layout, screen_path, result["equity"], risk or str(BASE_RISK_PCT))
            out["proposals"] = screen.plans_from_planner(layout, account_id, planner, write=False)
            out["planner_summary"] = planner["result"]["summary"]
        else:
            out["planner_summary"] = "not run: posture is no-new-entries"
    out["summary"] = {"trims": sum(1 for i in items if i["type"] == "trim"), "entry_proposals": len(out["proposals"]),
                      "watchlist": len(out["watchlist"]), "posture": policy["posture"]}
    return out


def write_recommendations(layout: Layout, result: dict[str, Any]) -> str:
    layout.ensure_base()
    folder = layout.base / "recommendations"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{result['account_id']}-{result['as_of']}.json"
    write_receipt(path, result)
    return str(path)
