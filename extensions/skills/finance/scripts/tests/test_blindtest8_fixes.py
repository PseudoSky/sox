"""Regression tests for the blind-test-8 findings. All data is SYNTHETIC."""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from finance_core import accounts, intraday, marketdata, paper, report  # noqa: E402
from finance_core.cli import main  # noqa: E402
from finance_core.errors import FinanceError  # noqa: E402
from finance_core.layout import Layout, atomic_write_json  # noqa: E402

from test_blindtest6_fixes import book  # noqa: E402


def run(tmp_path, capsys, *argv):
    code = main(["--root", str(tmp_path), *argv])
    captured = capsys.readouterr()
    return code, (json.loads(captured.out) if captured.out.strip() else None), captured.err


# --- a missing snapshot says how to get one
def test_missing_snapshot_names_the_ingest_step(tmp_path, capsys):
    accounts.create_account(Layout(tmp_path), "empty", "USD")
    code, _, err = run(tmp_path, capsys, "recommend", "--account", "empty")
    assert code == 2 and "inlet ingest --account empty" in err


# --- snapshot age is measured against today even when --as-of pins the valuation date
def test_report_warns_about_an_old_snapshot_when_as_of_equals_the_snapshot_date(tmp_path):
    layout = Layout(tmp_path)
    book(layout, as_of="2026-10-16")
    out = report.build_report(layout, as_of="2026-10-16", today=date(2026, 10, 21))
    assert any("snapshot is 5 days old" in w for w in out["warnings"])


# --- bars: cached superset is trimmed to the requested range and a forming bar is flagged
def seed_history(layout: Layout, last: date, count: int = 600) -> None:
    bars = [{"date": (last - timedelta(days=count - 1 - i)).isoformat(), "open": "10", "high": "11", "low": "9",
             "close": "10", "adj_close": "10", "volume": 1000} for i in range(count)]
    atomic_write_json(layout.base / "market" / "ZZZ.json", {
        "symbol": "ZZZ", "currency": "USD", "name": "ZZZ", "bars": bars, "dividends": [], "splits": [],
        "range": "5y", "source": "synthetic", "provider": "yahoo", "adjusted": True,
        "fetched_at": datetime.now(timezone.utc).isoformat()})


def test_bars_reply_counts_only_the_requested_range(tmp_path, capsys):
    seed_history(Layout(tmp_path), date(2026, 10, 16))
    code, out, _ = run(tmp_path, capsys, "market", "bars", "--symbol", "ZZZ", "--range", "1y")
    assert code == 0 and out["cached_bars"] == 600
    assert out["bars"] == 367 and out["first"] == (date(2026, 10, 16) - timedelta(days=366)).isoformat()
    assert "warnings" not in out


def test_bars_warns_while_the_last_session_is_forming(tmp_path, capsys, monkeypatch):
    seed_history(Layout(tmp_path), date(2026, 10, 16))
    monkeypatch.setattr(marketdata, "bar_in_progress", lambda d, now=None: True)
    code, out, _ = run(tmp_path, capsys, "market", "bars", "--symbol", "ZZZ", "--range", "1y")
    assert code == 0 and "still forming" in out["warnings"][0] and "2026-10-16" in out["warnings"][0]


# --- sizing without a plan (P6): hand-computed
def test_breakout_size_matches_the_hand_computation(tmp_path, capsys):
    book(Layout(tmp_path))  # equity 11000
    code, out, _ = run(tmp_path, capsys, "breakout", "size", "--account", "acct", "--entry", "100", "--stop", "95")
    # risk budget 0.5% of 11000 = 55; risk per share 5 -> 11 shares; 11 * 100 = 1100 = 10% cap
    assert code == 0 and out["shares"] == 11 and out["position_value"] == 1100
    assert out["risk_dollars"] == 55 and Path(out["sizer_output"]).is_file()
    assert out["binding_constraint"].startswith("risk_budget")  # no cap reduced the 11 shares; they tie


def test_breakout_size_respects_the_position_cap(tmp_path, capsys):
    book(Layout(tmp_path))
    code, out, _ = run(tmp_path, capsys, "breakout", "size", "--account", "acct", "--entry", "100", "--stop", "99",
                       "--max-position-pct", "5")
    # budget 55 / 1 per share = 55 shares, but 5% of 11000 = 550 -> 5 shares
    assert code == 0 and out["shares"] == 5 and not out["binding_constraint"].startswith("risk_budget")


# --- paper buys are limited to cash plus cash equivalents unless the account allows margin
def buy_one(layout, qty="1"):
    oid = paper.place_order(layout, "acct", {"symbol": "BIG", "side": "buy", "qty": qty, "type": "market"})
    return paper.fill_bar(layout, "acct", oid, {"open": "100", "high": "101", "low": "99", "close": "100", "ts": "2026-10-19"})


def test_buy_beyond_buying_power_is_rejected(tmp_path):
    layout = Layout(tmp_path)
    book(layout)  # cash 0, no cash equivalents
    fill = buy_one(layout)
    assert fill["status"] == "rejected" and "buying power" in fill["reason"] and "100" in fill["reason"]
    assert paper.positions_now(layout, "acct")["cash"] == 0


def test_margin_account_may_overdraw_and_is_warned(tmp_path):
    layout = Layout(tmp_path)
    book(layout)
    accounts.update_config(layout, "acct", "allow_margin", True)
    fill = buy_one(layout)
    assert fill["status"] == "filled" and "cash is now -100" in fill["warnings"][0]


def test_cash_equivalents_count_as_buying_power(tmp_path):
    layout = Layout(tmp_path)
    book(layout)
    snap, _ = accounts.load_current(layout, "acct")
    snap["positions"].append({"symbol": "SWEEP", "asset_type": "cash_equivalent", "option": None, "qty": "500",
                              "avg_cost": "1", "last_price": "1", "price_as_of": "2026-10-16", "currency": "USD"})
    snap["source"]["file_sha256"] = "cd" * 32
    accounts.write_snapshot(layout, "acct", snap)
    assert buy_one(layout, "5")["status"] == "filled"      # 500 cost <= 500 sweep
    assert buy_one(layout, "1")["status"] == "rejected"    # cash is already -500


# --- 0DTE entry: the order cost is checked against the per-trade cap
OK = dict(grade="A", signal="mega_bull", rvol="1.5", time_et="10:00", trend_age=5, weekday=1)


def test_order_cost_within_cap_passes():
    out = intraday.check_entry(**OK, account_size="600", premium="1.10", contracts=2)
    # 1.10 * 100 * 2 = 220; cap 40% of 600 = 240
    assert out["allowed"] and out["order_cost"] == "220.00" and out["order_cost_pct_of_account"] == "36.67"


def test_order_cost_over_cap_fails():
    out = intraday.check_entry(**OK, account_size="600", premium="1.10", contracts=3)
    assert not out["allowed"] and out["failed"] == ["order_cost_within_max_per_trade"]
    assert out["order_cost"] == "330.00"


def test_order_cost_is_reported_but_not_judged_without_a_cap():
    out = intraday.check_entry(**OK, account_size="25000", premium="1.10", contracts=1)
    assert out["allowed"] and out["order_cost"] == "110.00" and out["order_cost_pct_of_account"] == "0.44"




def test_stop_premium_reports_distance_and_loss():
    out = intraday.check_entry(**OK, account_size="600", premium="1.10", contracts=2, stop_premium="0.80")
    # (1.10 - 0.80) * 100 * 2 = 60; 0.80 / 1.10 - 1 = -27.27%
    assert out["stop_loss_pct"] == "-27.27" and out["risk_if_stopped"] == "60.00"
    wide = intraday.check_entry(**OK, account_size="600", premium="1.10", contracts=1, stop_premium="0.40")
    assert any("past the -50% hard stop" in w for w in wide["warnings"])


def test_check_mapping_against_the_source_catches_a_dead_regex(tmp_path, capsys):
    src = tmp_path / "export.csv"
    src.write_text('"Positions for account ****496 as of 01:34 PM ET, 2026/10/16"\nSymbol,Qty\nAAA,1\n')
    mapping = {"schema_version": 0, "broker_label": "x", "format": "csv", "header_line": 2,
               "as_of": {"regex": "ET, ([0-9/]+)", "group": 1}, "as_of_format": "%Y/%m/%d",
               "cash": {"value": "0"}, "control_total": {"regex": "Total Value,([0-9.]+)", "group": 1},
               "fields": {"symbol": {"column": "Symbol"}, "quantity": {"column": "Qty"}, "last_price": {"value": "1"}, "asset_type": {"value": "etf"}}, "rows": {}}
    atomic_write_json(tmp_path / "m.json", mapping)
    code, _, err = run(tmp_path, capsys, "inlet", "check-mapping", "--mapping", str(tmp_path / "m.json"),
                       "--source", str(src))
    assert code == 2 and "control_total" in err
    del mapping["control_total"]
    atomic_write_json(tmp_path / "m.json", mapping)
    code, out, _ = run(tmp_path, capsys, "inlet", "check-mapping", "--mapping", str(tmp_path / "m.json"),
                       "--source", str(src))
    assert code == 0 and out["resolved"]["as_of"] == "2026/10/16"


def test_report_summary_states_posture_concentration_and_warnings(tmp_path):
    layout = Layout(tmp_path)
    book(layout)  # BIG is 10000 of 11000 = 90.91%
    text = report.render_markdown(report.build_report(layout, as_of="2026-10-16", today=date(2026, 10, 16)))
    summary = text.split("## Executive summary")[1].split("## Holdings")[0]
    assert "No posture receipt" in summary and "over the 25% limit: BIG 90.91%" in summary


# --- a finished trade can end its plan; a flat position names the plans still open
def test_plan_close_ends_a_plan_and_removes_its_open_risk(tmp_path, capsys):
    from finance_core import breakout, plans
    layout = Layout(tmp_path)
    book(layout)
    item = {"symbol": "BIG", "sector": "x", "plan_valid_for_session": "2026-10-30",
            "trade_plan": {"signal_entry": 100.0, "worst_entry": 101.0, "stop_loss_price": 95.0, "risk_per_share": 6.0,
                           "target_price": 120.0, "shares": 10, "risk_dollars": 60.0, "position_value": 1000.0,
                           "cumulative_risk_pct": 0.5, "binding_constraint": "risk_budget"}}
    plans.put_plan(layout, breakout.translate_breakout(item, "acct", "big-1", input_hash="0" * 64))
    assert plans.open_risk(layout, "acct", "2026-10-19") == 60
    code, out, _ = run(tmp_path, capsys, "plan", "close", "--plan-id", "big-1", "--reason", "target hit")
    assert code == 0 and out["status"] == "closed"
    assert plans.open_risk(layout, "acct", "2026-10-19") == 0
    assert plans.get_plan(layout, "big-1")["close_reason"] == "target hit"
    code, _, err = run(tmp_path, capsys, "plan", "close", "--plan-id", "big-1")
    assert code == 2 and "only an active or draft plan" in err


def test_selling_the_last_share_names_plans_that_are_still_active(tmp_path, capsys):
    from finance_core import breakout, plans
    layout = Layout(tmp_path)
    book(layout)
    item = {"symbol": "BIG", "sector": "x", "plan_valid_for_session": "2026-10-30",
            "trade_plan": {"signal_entry": 100.0, "worst_entry": 101.0, "stop_loss_price": 95.0, "risk_per_share": 6.0,
                           "target_price": 120.0, "shares": 10, "risk_dollars": 60.0, "position_value": 1000.0,
                           "cumulative_risk_pct": 0.5, "binding_constraint": "risk_budget"}}
    plans.put_plan(layout, breakout.translate_breakout(item, "acct", "big-1", input_hash="0" * 64))
    oid = paper.place_order(layout, "acct", {"symbol": "BIG", "side": "sell", "qty": "100", "type": "market"})
    code, out, _ = run(tmp_path, capsys, "paper", "fill", "--account", "acct", "--order-id", oid,
                       "--bar", '{"open":"100","high":"101","low":"99","close":"100","ts":"2026-10-19"}')
    assert code == 0 and any("plan(s) big-1 are still active" in w for w in out["warnings"])


# --- sizing honours the market posture exactly as breakout plan does
def synthetic_posture(layout: Layout, state: str) -> None:
    from finance_core import posture
    posture.write_posture(layout, {"posture": state, "as_of": date.today().isoformat(), "reasons": ["SYNTHETIC"],
                                   "signals": [], "sources": ["SYNTHETIC"], "rules": {}})


def test_reduced_posture_halves_the_size(tmp_path, capsys):
    layout = Layout(tmp_path)
    book(layout)  # equity 11000
    synthetic_posture(layout, "reduced")
    code, out, _ = run(tmp_path, capsys, "breakout", "size", "--account", "acct", "--entry", "100", "--stop", "99",
                       "--max-position-pct", "100")
    # 0.5% halves to 0.25% of 11000 = 27.50; risk per share 1 -> 27 shares (full risk would give 55)
    assert code == 0 and out["shares"] == 27 and out["risk_pct"] == "0.25" and out["risk_pct_requested"] == "0.5"
    assert out["posture"]["posture"] == "reduced"


def test_no_new_entries_refuses_sizing_unless_overridden(tmp_path, capsys):
    layout = Layout(tmp_path)
    book(layout)
    synthetic_posture(layout, "no-new-entries")
    args = ["breakout", "size", "--account", "acct", "--entry", "100", "--stop", "99", "--max-position-pct", "100"]
    code, _, err = run(tmp_path, capsys, *args)
    assert code == 2 and "no-new-entries" in err
    code, out, _ = run(tmp_path, capsys, *args, "--ignore-posture")
    assert code == 0 and out["shares"] == 55 and "--ignore-posture used" in out["posture"]["override"]
    assert out["posture"]["posture"] == "no-new-entries"


def test_bars_reply_names_the_requested_and_the_cached_range(tmp_path, capsys):
    seed_history(Layout(tmp_path), date(2026, 10, 16))
    code, out, _ = run(tmp_path, capsys, "market", "bars", "--symbol", "ZZZ", "--range", "1y")
    assert out["range"] == "1y" and out["cached_range"] == "5y"


# --- trims round up to the limit; ingest and posture warn about stale or forming data
def test_trim_never_leaves_the_position_above_the_limit(tmp_path):
    from finance_core import recommend
    layout = Layout(tmp_path)
    book(layout)
    trim = next(i for i in recommend.recommend_for_account(layout, "acct", today=date(2026, 10, 16))["items"]
                if i["type"] == "trim")
    assert trim["proposal"]["qty"] == "73"  # 72.5 shares of excess rounds up


def test_ingest_warns_when_the_export_is_old(tmp_path, capsys):
    src = tmp_path / "export.csv"
    src.write_text('"Positions as of 2026/10/01"\nSymbol,Qty,Price\nAAA,2,10\n')
    atomic_write_json(tmp_path / "m.json", {
        "schema_version": 0, "broker_label": "x", "format": "csv", "header_line": 2,
        "as_of": {"regex": "as of ([0-9/]+)", "group": 1}, "as_of_format": "%Y/%m/%d", "cash": {"value": "0"},
        "fields": {"symbol": {"column": "Symbol"}, "quantity": {"column": "Qty"}, "last_price": {"column": "Price"},
                   "asset_type": {"value": "etf"}}, "rows": {"require_numeric": ["Qty", "Price"]}})
    assert run(tmp_path, capsys, "account", "create", "--account", "a", "--base-currency", "USD")[0] == 0
    code, out, _ = run(tmp_path, capsys, "inlet", "ingest", "--account", "a", "--mapping", str(tmp_path / "m.json"),
                       "--source", str(src))
    assert code == 0 and any("days old (2026-10-01" in w for w in out["warnings"])


def test_posture_warns_while_the_session_is_forming(tmp_path, capsys, monkeypatch):
    from finance_core import posture
    monkeypatch.setattr(marketdata, "bar_in_progress", lambda d, now=None: True)
    monkeypatch.setattr(posture, "compute_posture", lambda layout, symbols: {
        "posture": "full", "as_of": "2026-10-21", "reasons": ["x"], "signals": [], "sources": [], "rules": {}})
    code, out, _ = run(tmp_path, capsys, "market", "posture")
    assert code == 0 and "still forming" in out["warnings"][0]


def test_size_warns_when_the_position_exceeds_buying_power(tmp_path, capsys):
    book(Layout(tmp_path))  # cash 0
    code, out, _ = run(tmp_path, capsys, "breakout", "size", "--account", "acct", "--entry", "100", "--stop", "95")
    assert code == 0 and out["buying_power"] == "0.00" and "rejected at fill time" in out["warnings"][0]
