"""Translate breakout-trade-planner output (one actionable entry) into plan v0."""

from __future__ import annotations

from typing import Any

from .accounts import utc_now
from .errors import FinanceError
from .money import money_str, parse_money
from .plans import validate_plan

REQUIRED_PLAN_KEYS = ("signal_entry", "worst_entry", "stop_loss_price", "risk_per_share", "target_price",
                      "shares", "risk_dollars", "binding_constraint")


def _m(value: Any, field: str) -> str:
    return money_str(parse_money(str(value), field))


def translate_breakout(item: dict[str, Any], account_id: str, plan_id: str, input_hash: str,
                       mode: str = "planned", playbook_version: str = "0.1.0") -> dict[str, Any]:
    reasons: list[str] = []
    if not isinstance(item, dict):
        raise FinanceError("breakout item: must be an object")
    for key in ("symbol", "plan_valid_for_session", "trade_plan"):
        if item.get(key) in (None, ""):
            reasons.append(f"missing key: {key}")
    tp = item.get("trade_plan")
    if tp is not None and not isinstance(tp, dict):
        reasons.append("trade_plan: must be an object")
        tp = None
    for key in REQUIRED_PLAN_KEYS:
        if tp is not None and tp.get(key) in (None, ""):
            reasons.append(f"missing key: trade_plan.{key}")
    shares = None
    if not reasons:
        try:
            dec = parse_money(str(tp["shares"]), "shares")
            if dec != dec.to_integral_value() or dec <= 0:
                reasons.append(f"shares: must be a positive whole number, got {tp['shares']!r}")
            else:
                shares = int(dec)
        except FinanceError as exc:
            reasons.append(str(exc))
    if reasons:
        raise FinanceError("breakout item rejected: " + "; ".join(reasons), reasons)
    try:
        plan = {
            "schema_version": 0,
            "plan_id": plan_id,
            "account_id": account_id,
            "symbol": item["symbol"],
            "side": "buy",
            "setup": "breakout",
            "mode": mode,
            "trigger_price": _m(tp["signal_entry"], "signal_entry"),
            "stop_price": _m(tp["stop_loss_price"], "stop_loss_price"),
            "targets": [_m(tp["target_price"], "target_price")],
            "risk_per_share": _m(tp["risk_per_share"], "risk_per_share"),
            "quantity": shares,
            "risk_amount": _m(tp["risk_dollars"], "risk_dollars"),
            "valid_until": item["plan_valid_for_session"],
            "gates": [
                {"name": "sizing", "passed": True, "detail": f"binding_constraint={tp['binding_constraint']}"},
                {"name": "entry_ceiling", "passed": True, "detail": f"worst_entry={tp['worst_entry']}"},
            ],
            "source": {"playbook": "P5", "version": playbook_version, "input_hash": input_hash},
            "status": "active",
            "supersedes": None,
            "order": None,
            "exits": [],
            "created_at": utc_now(),
        }
    except FinanceError as exc:
        raise FinanceError(f"breakout item rejected: {exc}", [str(exc)]) from exc
    errors = validate_plan(plan)
    if errors:
        raise FinanceError("translated plan invalid: " + "; ".join(errors), errors)
    return plan
