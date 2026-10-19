"""P11 rules, checked against the 0dte-flow tables. Values are SYNTHETIC observations."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from finance_core import intraday  # noqa: E402
from finance_core.errors import FinanceError  # noqa: E402

OK = dict(grade="A", signal="mega_bull", rvol="1.5", time_et="10:00", trend_age=5, weekday=1)


def test_all_rules_holding_allows_entry_and_sizes_from_account():
    r = intraday.check_entry(**OK, account_size="75")
    assert r["allowed"] and r["failed"] == []
    assert r["max_per_trade"] == "30.00" and r["max_daily_loss"] == "60.00"


@pytest.mark.parametrize("change,rule", [
    ({"grade": "C"}, "grade_at_least_B"), ({"signal": "other"}, "signal_is_mega"),
    ({"rvol": "1.2"}, "rvol_above_1.2"), ({"time_et": "11:31"}, "entry_window_0930_1130"),
    ({"time_et": "09:29"}, "entry_window_0930_1130"), ({"trend_age": 15}, "trend_age_under_15_bars"),
    ({"open_positions": 1}, "no_open_position"), ({"trades_today": 2}, "under_two_trades_today"),
    ({"weekday": 4}, "no_friday_0dte"),
])
def test_each_entry_rule_blocks_alone(change, rule):
    r = intraday.check_entry(**{**OK, **change})
    assert not r["allowed"] and r["failed"] == [rule]


def test_daily_loss_cap_blocks_when_account_given():
    r = intraday.check_entry(**OK, day_pnl="-60", account_size="75")
    assert r["failed"] == ["daily_loss_not_reached"]


@pytest.mark.parametrize("args,rule", [
    (dict(pnl_pct="-50", grade="A", signal_flipped=False, time_et="10:00"), "S1"),
    (dict(pnl_pct="5", grade="D", signal_flipped=False, time_et="10:00"), "S2"),
    (dict(pnl_pct="5", grade="A", signal_flipped=True, time_et="10:00"), "S3"),
    (dict(pnl_pct="5", grade="A", signal_flipped=False, time_et="14:30"), "T1"),
    (dict(pnl_pct="100", grade="A", signal_flipped=False, time_et="10:00"), "P1"),
    (dict(pnl_pct="30", grade="C", signal_flipped=False, time_et="10:00", entry_grade="A"), "P2"),
    (dict(pnl_pct="50", grade="B", signal_flipped=False, time_et="13:01"), "P3"),
    (dict(pnl_pct="-10", grade="B", signal_flipped=False, time_et="12:00"), "T2"),
])
def test_each_exit_rule_fires(args, rule):
    assert intraday.check_exit(**args) == {"action": "sell", "rule": rule, "reason": intraday.check_exit(**args)["reason"]}


def test_first_match_wins_and_hold_otherwise():
    both = intraday.check_exit("-60", "F", True, "15:00")
    assert both["rule"] == "S1"
    assert intraday.check_exit("20", "B", False, "10:30")["action"] == "hold"


def test_bad_inputs_are_named():
    with pytest.raises(FinanceError, match="grade"):
        intraday.check_exit("1", "Z", False, "10:00")
    with pytest.raises(FinanceError, match="HH:MM"):
        intraday.check_entry(**{**OK, "time_et": "10am"})


def test_fading_without_an_entry_grade_follows_the_source_table():
    """0dte-flow P2 reads 'gain >= 30% AND grade -> C'; an unknown entry grade must not disable it."""
    assert intraday.check_exit("30", "C", False, "10:00")["rule"] == "P2"
    assert intraday.check_exit("30", "B", False, "10:00")["action"] == "hold"
