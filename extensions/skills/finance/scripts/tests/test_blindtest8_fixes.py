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


def test_breakout_size_respects_the_position_cap(tmp_path, capsys):
    book(Layout(tmp_path))
    code, out, _ = run(tmp_path, capsys, "breakout", "size", "--account", "acct", "--entry", "100", "--stop", "99",
                       "--max-position-pct", "5")
    # budget 55 / 1 per share = 55 shares, but 5% of 11000 = 550 -> 5 shares
    assert code == 0 and out["shares"] == 5


# --- paper fills that overdraw cash say so
def test_overdrawing_fill_warns_about_negative_cash(tmp_path):
    layout = Layout(tmp_path)
    book(layout)  # cash 0
    oid = paper.place_order(layout, "acct", {"symbol": "BIG", "side": "buy", "qty": "1", "type": "market"})
    fill = paper.fill_bar(layout, "acct", oid, {"open": "100", "high": "101", "low": "99", "close": "100", "ts": "2026-10-19"})
    assert fill["status"] == "filled" and "cash is now -100" in fill["warnings"][0]


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


