"""Tests for plans.py and breakout.py. All fixtures are SYNTHETIC."""

import copy
import json
import re

import pytest

from finance_core import breakout, plans
from finance_core.errors import FinanceError
from finance_core.layout import Layout

H = "a" * 64


def make_plan(plan_id="p1", **over):
    """SYNTHETIC plan v0: buy XYZ at 50.00, stop 48.00, 100 shares, risk 200."""
    plan = {
        "schema_version": 0, "plan_id": plan_id, "account_id": "acc1", "symbol": "XYZ", "side": "buy",
        "setup": "breakout", "mode": "planned", "trigger_price": "50.00", "stop_price": "48.00",
        "targets": ["56.00"], "risk_per_share": "2.00", "quantity": 100, "risk_amount": "200.00",
        "valid_until": "2026-03-10", "gates": [{"name": "sizing", "passed": True, "detail": "ok"}],
        "source": {"playbook": "P5", "version": "0.1.0", "input_hash": H}, "status": "active",
        "supersedes": None, "order": None, "exits": [], "created_at": "2026-03-01T00:00:00+00:00",
    }
    plan.update(over)
    return plan


def test_valid_plan_has_no_errors():
    assert plans.validate_plan(make_plan()) == []


def test_bad_mode_rejected():
    assert any("mode" in e for e in plans.validate_plan(make_plan(mode="yolo")))


def test_risk_mismatch_rejected_and_all_errors_collected():
    errs = plans.validate_plan(make_plan(risk_per_share="1.00", risk_amount="999", side="hold"))
    assert any("risk_per_share" in e for e in errs)
    assert any("side" in e for e in errs)


def test_risk_amount_mismatch():
    assert any("risk_amount" in e for e in plans.validate_plan(make_plan(risk_amount="250.00")))


def test_live_without_approval_rejected(tmp_path):
    with pytest.raises(FinanceError, match="approval"):
        plans.put_plan(Layout(tmp_path), make_plan(mode="live:acc1"))


def test_live_with_wrong_account_approval_rejected(tmp_path):
    bad = {"account_id": "other", "approved": True, "approved_by": "me", "approved_at": "2026-03-01"}
    with pytest.raises(FinanceError):
        plans.put_plan(Layout(tmp_path), make_plan(mode="live:acc1"), approval=bad)


def test_live_with_matching_approval_accepted_and_places_nothing(tmp_path):
    ok = {"account_id": "acc1", "approved": True, "approved_by": "me", "approved_at": "2026-03-01"}
    layout = Layout(tmp_path)
    path = plans.put_plan(layout, make_plan(mode="live:acc1"), approval=ok)
    assert json.loads(path.read_text())["order"] is None


def test_duplicate_plan_id_rejected(tmp_path):
    layout = Layout(tmp_path)
    plans.put_plan(layout, make_plan())
    with pytest.raises(FinanceError, match="already exists"):
        plans.put_plan(layout, make_plan())


def test_supersedes_marks_prior_and_rebuilds_index(tmp_path):
    layout = Layout(tmp_path)
    plans.put_plan(layout, make_plan("p1"))
    plans.put_plan(layout, make_plan("p0"))
    plans.put_plan(layout, make_plan("p2", supersedes="p1"))
    assert plans.get_plan(layout, "p1")["status"] == "superseded"
    index = json.loads((layout.plans_dir() / "index.json").read_text())
    assert [r["plan_id"] for r in index] == ["p0", "p1", "p2"]
    assert {r["plan_id"]: r["status"] for r in index}["p1"] == "superseded"
    assert set(index[0]) == {"plan_id", "symbol", "account_id", "mode", "status", "valid_until"}


def test_supersedes_missing_or_cross_account_rejected(tmp_path):
    layout = Layout(tmp_path)
    with pytest.raises(FinanceError, match="not found"):
        plans.put_plan(layout, make_plan("p2", supersedes="nope"))
    plans.put_plan(layout, make_plan("p1", account_id="acc2"))
    with pytest.raises(FinanceError, match="different account"):
        plans.put_plan(layout, make_plan("p3", supersedes="p1"))
    assert plans.get_plan(layout, "p1")["status"] == "active"


def test_list_effective_expiry_does_not_rewrite_and_open_risk(tmp_path):
    layout = Layout(tmp_path)
    plans.put_plan(layout, make_plan("p1", valid_until="2026-03-05"))
    plans.put_plan(layout, make_plan("p2", valid_until="2026-03-20"))
    listed = plans.list_plans(layout, as_of="2026-03-10")
    assert {p["plan_id"]: p["status"] for p in listed} == {"p1": "expired", "p2": "active"}
    assert plans.get_plan(layout, "p1")["status"] == "active"
    assert str(plans.open_risk(layout, "acc1", "2026-03-10")) == "200.00"
    assert str(plans.open_risk(layout, "acc1", "2026-01-01")) == "400.00"


def synthetic_item():
    """SYNTHETIC breakout-trade-planner entry with float values."""
    return {"symbol": "ZZZ", "sector": "Tech",
            "trade_plan": {"signal_entry": 52.35, "worst_entry": 52.9, "stop_loss_price": 49.8,
                           "risk_per_share": 2.55, "target_price": 60.0, "shares": 78,
                           "risk_dollars": 198.9, "position_value": 4083.3, "cumulative_risk_pct": 0.4,
                           "binding_constraint": "risk_budget"},
            "plan_valid_for_session": "2026-03-10"}


def test_translate_breakout_realistic():
    plan = breakout.translate_breakout(synthetic_item(), "acc1", "zzz-1", input_hash=H)
    assert plans.validate_plan(plan) == []
    assert plan["trigger_price"] == "52.35" and plan["stop_price"] == "49.8"
    assert plan["targets"] == ["60.0"] and plan["quantity"] == 78
    assert plan["risk_amount"] == "198.9" and plan["valid_until"] == "2026-03-10"
    assert plan["source"] == {"playbook": "P5", "version": "0.1.0", "input_hash": H}
    assert plan["gates"][0] == {"name": "sizing", "passed": True, "detail": "binding_constraint=risk_budget"}
    assert plan["gates"][1]["detail"] == "worst_entry=52.9"
    assert (plan["side"], plan["setup"], plan["status"], plan["order"], plan["exits"]) == \
        ("buy", "breakout", "active", None, [])
    assert re.match(r"\d{4}-", plan["created_at"])


def test_translate_breakout_stores(tmp_path):
    plan = breakout.translate_breakout(synthetic_item(), "acc1", "zzz-1", mode="paper:acc1", input_hash=H)
    plans.put_plan(Layout(tmp_path), plan)


def test_breakout_missing_key_rejected():
    item = synthetic_item()
    del item["trade_plan"]["stop_loss_price"]
    with pytest.raises(FinanceError) as exc:
        breakout.translate_breakout(item, "acc1", "zzz-1", input_hash=H)
    assert any("stop_loss_price" in r for r in exc.value.reasons)


@pytest.mark.parametrize("shares", [0, -5, 1.5, "abc"])
def test_breakout_bad_shares_rejected(shares):
    item = copy.deepcopy(synthetic_item())
    item["trade_plan"]["shares"] = shares
    with pytest.raises(FinanceError):
        breakout.translate_breakout(item, "acc1", "zzz-1", input_hash=H)


def test_breakout_inconsistent_risk_fails_validation():
    item = synthetic_item()
    item["trade_plan"]["risk_dollars"] = 500.0
    with pytest.raises(FinanceError, match="invalid"):
        breakout.translate_breakout(item, "acc1", "zzz-1", input_hash=H)
