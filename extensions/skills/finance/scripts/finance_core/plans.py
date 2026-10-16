"""Plan v0 store: validated plan files plus a rebuilt index. No broker; live mode records intent only."""

from __future__ import annotations

import re
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

from .errors import FinanceError
from .layout import Layout, atomic_write_json, check_id, read_json
from .money import parse_money

SIDES = {"buy", "sell"}
STATUSES = {"draft", "active", "superseded", "expired", "closed", "cancelled"}
HEX64 = re.compile(r"^[0-9a-f]{64}$")
MODE_RE = re.compile(r"^(planned|paper:[a-z0-9][a-z0-9_-]{0,63}|live:[a-z0-9][a-z0-9_-]{0,63})$")
RISK_PS_TOL = Decimal("0.01")
RISK_AMT_TOL = Decimal("0.05")


def _iso(value: Any) -> date | None:
    try:
        return date.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        return None


def _money(plan: dict[str, Any], key: str, errors: list[str]) -> Decimal | None:
    try:
        return parse_money(plan.get(key), key)
    except FinanceError as exc:
        errors.append(str(exc))
        return None


def validate_plan(plan: Any) -> list[str]:
    if not isinstance(plan, dict):
        return ["plan: must be an object"]
    errors: list[str] = []
    if plan.get("schema_version") != 0:
        errors.append("schema_version: must be 0")
    for key in ("plan_id", "account_id"):
        try:
            check_id(plan.get(key), key)
        except FinanceError as exc:
            errors.append(str(exc))
    if not isinstance(plan.get("symbol"), str) or not plan["symbol"]:
        errors.append("symbol: required")
    if plan.get("side") not in SIDES:
        errors.append(f"side: must be one of {sorted(SIDES)}")
    if not isinstance(plan.get("setup"), str) or not plan["setup"]:
        errors.append("setup: required")
    if not isinstance(plan.get("mode"), str) or not MODE_RE.match(plan["mode"]):
        errors.append(f"mode: must be planned, paper:<account_id> or live:<account_id>, got {plan.get('mode')!r}")
    trigger, stop = _money(plan, "trigger_price", errors), _money(plan, "stop_price", errors)
    rps, amount = _money(plan, "risk_per_share", errors), _money(plan, "risk_amount", errors)
    targets = plan.get("targets")
    if not isinstance(targets, list) or not targets:
        errors.append("targets: non-empty list required")
    else:
        for i, t in enumerate(targets):
            try:
                parse_money(t, f"targets[{i}]")
            except FinanceError as exc:
                errors.append(str(exc))
    qty = plan.get("quantity")
    if isinstance(qty, bool) or not isinstance(qty, int) or qty <= 0:
        errors.append("quantity: positive int required")
    if trigger is not None and stop is not None and rps is not None and rps < abs(trigger - stop) - RISK_PS_TOL:
        errors.append(f"risk_per_share: {rps} understates |trigger - stop| = {abs(trigger - stop)}")
    if (rps is not None and amount is not None and isinstance(qty, int) and not isinstance(qty, bool)
            and abs(amount - rps * qty) > RISK_AMT_TOL):
        errors.append(f"risk_amount: {amount} != risk_per_share * quantity = {rps * qty}")
    if _iso(plan.get("valid_until")) is None:
        errors.append("valid_until: ISO date required")
    gates = plan.get("gates")
    if not isinstance(gates, list) or not all(
            isinstance(g, dict) and isinstance(g.get("name"), str) and isinstance(g.get("passed"), bool)
            and isinstance(g.get("detail"), str) for g in gates):
        errors.append("gates: list of {name, passed(bool), detail(str)} required")
    src = plan.get("source")
    if not isinstance(src, dict) or not all(isinstance(src.get(k), str) and src[k] for k in ("playbook", "version")):
        errors.append("source: {playbook, version, input_hash} required")
    elif not HEX64.match(str(src.get("input_hash"))):
        errors.append("source.input_hash: 64-hex sha256 required")
    if plan.get("status") not in STATUSES:
        errors.append(f"status: must be one of {sorted(STATUSES)}")
    if plan.get("supersedes") is not None:
        try:
            check_id(plan["supersedes"], "supersedes")
        except FinanceError as exc:
            errors.append(str(exc))
    if plan.get("order") is not None and not isinstance(plan["order"], dict):
        errors.append("order: null or object required")
    if not isinstance(plan.get("exits"), list):
        errors.append("exits: list required")
    if not isinstance(plan.get("created_at"), str) or not plan["created_at"]:
        errors.append("created_at: required")
    return errors


def _path(layout: Layout, plan_id: str) -> Path:
    return layout.plans_dir() / f"{check_id(plan_id, 'plan_id')}.json"


def get_plan(layout: Layout, plan_id: str) -> dict[str, Any]:
    return read_json(_path(layout, plan_id))


def _rebuild_index(layout: Layout) -> None:
    rows = []
    for p in sorted(layout.plans_dir().glob("*.json")):
        if p.name == "index.json":
            continue
        plan = read_json(p)
        rows.append({k: plan[k] for k in ("plan_id", "symbol", "account_id", "mode", "status", "valid_until")})
    rows.sort(key=lambda r: r["plan_id"])
    atomic_write_json(layout.plans_dir() / "index.json", rows)


def put_plan(layout: Layout, plan: dict[str, Any], approval: dict[str, Any] | None = None) -> Path:
    errors = validate_plan(plan)
    if errors:
        raise FinanceError("plan rejected: " + "; ".join(errors), errors)
    if plan["plan_id"] == "index":
        raise FinanceError("plan_id: 'index' is reserved")
    if plan["mode"].startswith("live:"):
        if not (isinstance(approval, dict) and approval.get("approved") is True
                and approval.get("approved_by") and approval.get("approved_at")
                and approval.get("account_id") == plan["account_id"]):
            raise FinanceError("live plan requires approval {account_id, approved: true, approved_by, "
                               "approved_at} matching the plan's account_id")
    layout.ensure_base()
    path = _path(layout, plan["plan_id"])
    if path.exists():
        raise FinanceError(f"plan already exists: {plan['plan_id']}")
    prior = None
    if plan.get("supersedes"):
        ppath = _path(layout, plan["supersedes"])
        if not ppath.exists():
            raise FinanceError(f"supersedes: plan not found: {plan['supersedes']}")
        prior = read_json(ppath)
        if prior.get("account_id") != plan["account_id"]:
            raise FinanceError("supersedes: prior plan belongs to a different account")
    if prior is not None:
        prior["status"] = "superseded"
        atomic_write_json(ppath, prior)
    atomic_write_json(path, plan)
    _rebuild_index(layout)
    return path


def _effective(plan: dict[str, Any], as_of: str | None) -> str:
    if as_of and plan["status"] == "active" and plan["valid_until"] < as_of:
        return "expired"
    return plan["status"]


def list_plans(layout: Layout, account_id: str | None = None, status: str | None = None,
               as_of: str | None = None) -> list[dict[str, Any]]:
    out = []
    for p in sorted(layout.plans_dir().glob("*.json")):
        if p.name == "index.json":
            continue
        plan = read_json(p)
        eff = _effective(plan, as_of)
        if account_id and plan["account_id"] != account_id:
            continue
        if status and eff != status:
            continue
        out.append({**plan, "status": eff})
    return out


def open_risk(layout: Layout, account_id: str, as_of: str) -> Decimal:
    return sum((parse_money(p["risk_amount"], "risk_amount")
                for p in list_plans(layout, account_id=account_id, status="active", as_of=as_of)), Decimal(0))
