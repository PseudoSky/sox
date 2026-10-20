"""P2 posture, P4 income, concentration flag, screen/edge/0DTE output fixes. Bars are SYNTHETIC cache entries."""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from finance_core import analyze, income, intraday, posture, report  # noqa: E402
from finance_core.errors import FinanceError  # noqa: E402
from finance_core.layout import Layout  # noqa: E402


def seed(layout: Layout, symbol: str, closes: list[float], dividends=None, adjusted=True, provider="yahoo") -> None:
    start = date(2026, 10, 19) - timedelta(days=len(closes) - 1)
    bars = [{"date": (start + timedelta(days=i)).isoformat(), "open": f"{c:.4f}", "high": f"{c:.4f}",
             "low": f"{c:.4f}", "close": f"{c:.4f}", "adj_close": f"{c:.4f}", "volume": 1000}
            for i, c in enumerate(closes)]
    market = layout.base / "market"
    market.mkdir(parents=True, exist_ok=True)
    (market / f"{symbol}.json").write_text(json.dumps({
        "symbol": symbol, "range": "2y", "bars": bars, "provider": provider, "adjusted": adjusted, "source": provider,
        "currency": "USD", "name": symbol, "dividends": dividends or [], "splits": [],
        "fetched_at": datetime.now(timezone.utc).isoformat()}), encoding="utf-8")


def rising(n=300, top=None):
    return [100 + i * 0.1 for i in range(n)] if top is None else top


def test_clear_trend_is_full(tmp_path):
    layout = Layout(tmp_path)
    for s in ("SPY", "QQQ", "IWM"):
        seed(layout, s, rising())
    result = posture.compute_posture(layout)
    assert result["posture"] == "full" and result["reasons"] == ["trend and drawdown checks all clear"]


def test_spy_below_fast_average_is_reduced(tmp_path):
    layout = Layout(tmp_path)
    for s in ("QQQ", "IWM"):
        seed(layout, s, rising())
    seed(layout, "SPY", rising(295) + [129.0, 128.5, 128.0, 127.5, 127.0])
    result = posture.compute_posture(layout)
    assert result["posture"] == "reduced" and any("50-day" in r for r in result["reasons"])


def test_spy_below_slow_average_blocks_new_entries(tmp_path):
    layout = Layout(tmp_path)
    for s in ("QQQ", "IWM"):
        seed(layout, s, rising())
    seed(layout, "SPY", rising(200) + [120 - i * 0.5 for i in range(100)])
    result = posture.compute_posture(layout)
    assert result["posture"] == "no-new-entries"


def test_short_history_is_refused_and_leader_required(tmp_path):
    layout = Layout(tmp_path)
    seed(layout, "SPY", rising(120))
    with pytest.raises(FinanceError, match="200 are needed"):
        posture.compute_posture(layout, ("SPY",))
    with pytest.raises(FinanceError, match="SPY must be among"):
        posture.compute_posture(layout, ("QQQ",))


def test_unadjusted_bars_add_a_warning(tmp_path):
    layout = Layout(tmp_path)
    for s in ("SPY", "QQQ", "IWM"):
        seed(layout, s, rising(), adjusted=False, provider="nasdaq")
    assert posture.compute_posture(layout)["warnings"][0]["symbols"] == ["SPY", "QQQ", "IWM"]


def _account(layout: Layout, positions: dict[str, tuple[str, str, str]]) -> None:
    """positions: symbol -> (qty, price, asset_type). SYNTHETIC snapshot, cash 0."""
    from finance_core import accounts
    accounts.create_account(layout, "acct", "USD")
    accounts.write_snapshot(layout, "acct", {
        "as_of": "2026-10-19", "account_id": "acct", "base_currency": "USD",
        "source": {"file_sha256": "ab" * 32, "imported_at": "2026-10-19T00:00:00+00:00", "note": "SYNTHETIC"},
        "cash": "0", "warnings": [],
        "positions": [{"symbol": sym, "asset_type": t, "option": None, "qty": q, "avg_cost": p, "last_price": p,
                       "price_as_of": "2026-10-19", "currency": "USD"} for sym, (q, p, t) in positions.items()]})


def test_concentration_flag_and_report_action_item(tmp_path):
    layout = Layout(tmp_path)
    _account(layout, {"BIG": ("100", "100", "etf"), "SMALL": ("10", "100", "etf"), "MM": ("1000", "1", "cash_equivalent")})
    result = analyze.analyze_account(layout, "acct")
    assert [f["key"] for f in result["concentration_flags"]] == ["BIG"]
    md = report.render_markdown(report.build_report(layout))
    assert "Concentration: acct holds BIG" in md


def test_income_sums_trailing_year_and_warns_on_single_payment(tmp_path):
    layout = Layout(tmp_path)
    _account(layout, {"PAY": ("100", "50", "etf"), "ONE": ("10", "50", "etf"), "NONE": ("5", "50", "etf")})
    seed(layout, "PAY", rising(), dividends=[{"date": "2026-01-02", "amount": "0.5000"}, {"date": "2026-07-01", "amount": "0.5000"},
                                              {"date": "2025-01-02", "amount": "9.0000"}])
    seed(layout, "ONE", rising(), dividends=[{"date": "2026-03-01", "amount": "1.0000"}])
    seed(layout, "NONE", rising())
    result = income.income_for_account(layout, "acct")
    rows = {r["symbol"]: r for r in result["positions"]}
    assert rows["PAY"]["per_share_12m"] == "1.0000" and rows["PAY"]["payments_12m"] == 2 and rows["PAY"]["income_12m"] == "100.00"
    assert result["income_12m_total"] == "110.00"
    assert any("ONE: one payment" in w for w in result["warnings"]) and any("NONE: no dividends" in w for w in result["warnings"])


def test_zero_dte_warns_about_scaled_caps_and_checks_the_underlying():
    ok = dict(grade="A", signal="mega_bull", rvol="1.4", time_et="10:15", trend_age=6, weekday=1)
    r = intraday.check_entry(**ok, account_size="500", symbol="spy", day_pnl="0")
    assert r["allowed"] and r["max_daily_loss"] == "400.00" and "80%" in r["warnings"][0]
    assert r["max_per_trade"] == "200.00"
    assert any(x["rule"] == "daily_loss_not_reached" for x in r["rules"])
    silent = intraday.check_entry(**ok, account_size="500")
    assert not any(x["rule"] == "daily_loss_not_reached" for x in silent["rules"])
    assert any("NOT evaluated" in w for w in silent["warnings"])
    wrong = intraday.check_entry(**ok, symbol="TSLA")
    assert wrong["failed"] == ["signal_on_spy"]


def _book(layout: Layout) -> None:
    from finance_core import accounts
    accounts.create_account(layout, "acct", "USD")
    accounts.write_snapshot(layout, "acct", {
        "as_of": "2026-10-19", "account_id": "acct", "base_currency": "USD",
        "source": {"file_sha256": "ab" * 32, "imported_at": "2026-10-19T00:00:00+00:00", "note": "SYNTHETIC"},
        "cash": "0", "warnings": [],
        "positions": [
            {"symbol": "BIG", "asset_type": "etf", "option": None, "qty": "100", "avg_cost": "60", "last_price": "100",
             "price_as_of": "2026-10-19", "currency": "USD"},
            {"symbol": "SMALL", "asset_type": "etf", "option": None, "qty": "10", "avg_cost": "100", "last_price": "100",
             "price_as_of": "2026-10-19", "currency": "USD"},
            {"symbol": "MM", "asset_type": "cash_equivalent", "option": None, "qty": "1000", "avg_cost": "1", "last_price": "1",
             "price_as_of": "2026-10-19", "currency": "USD"}]})


def _screen_file(tmp_path: Path) -> str:
    data = {"results": [
        {"symbol": "WATCHA", "composite_score": 58.0, "rating": "Weak VCP", "execution_state": "Pre-breakout",
         "valid_vcp": False, "price": 50.0, "vcp_pattern": {"pivot_price": 52.5}},
        {"symbol": "LOW", "composite_score": 20.0, "rating": "No VCP", "execution_state": "Damaged", "valid_vcp": False},
        {"symbol": "VALID", "composite_score": 90.0, "valid_vcp": True}]}
    path = tmp_path / "screen.json"
    path.write_text(json.dumps(data))
    return str(path)


def test_trim_proposal_is_hand_computed_and_cash_equivalents_never_flagged(tmp_path):
    from finance_core import recommend
    layout = Layout(tmp_path)
    _book(layout)
    out = recommend.recommend_for_account(layout, "acct", today=date(2026, 10, 19))
    trim = next(i for i in out["items"] if i["type"] == "trim")
    assert [i["symbol"] for i in out["items"] if i["type"] == "trim"] == ["BIG"]
    assert trim["proposal"]["qty"] == "70" and trim["proposal"]["est_proceeds"] == "7000.00"
    assert trim["after"]["position_pct"] == "25.00" and trim["est_realized_gain"] == "2800.00"
    assert trim["alternative"]["new_money_in_other_holdings"] == "28000.00"
    assert trim["text"].startswith("Sell 70 BIG at about 100 for roughly $7,000.00") and "$2,800.00" in trim["text"]
    assert trim["caveat"].startswith("The gain is an estimate")
    assert out["items"][-1]["posture"] is None and "market posture" in out["items"][-1]["action"]


def test_entry_policy_follows_the_posture_receipt(tmp_path):
    from finance_core import recommend
    layout = Layout(tmp_path)
    _book(layout)
    for state, risk in (("full", "0.5"), ("reduced", "0.25"), ("no-new-entries", "0")):
        posture.write_posture(layout, {"posture": state, "as_of": "2026-10-19", "reasons": [state]})
        policy = recommend.recommend_for_account(layout, "acct", today=date(2026, 10, 19))["items"][-1]
        assert policy["posture"] == state and Decimal(policy["risk_pct_per_trade"]) == Decimal(risk)


def test_watchlist_lists_only_near_misses_with_pivots_and_no_planner_when_blocked(tmp_path):
    from finance_core import recommend
    layout = Layout(tmp_path)
    _book(layout)
    posture.write_posture(layout, {"posture": "no-new-entries", "as_of": "2026-10-19", "reasons": ["x"]})
    out = recommend.recommend_for_account(layout, "acct", _screen_file(tmp_path), today=date(2026, 10, 19))
    assert [w["symbol"] for w in out["watchlist"]] == ["WATCHA"] and out["watchlist"][0]["pivot_price"] == 52.5
    assert out["proposals"] == [] and "no-new-entries" in out["planner_summary"]


def test_stale_posture_receipt_is_ignored(tmp_path):
    layout = Layout(tmp_path)
    posture.write_posture(layout, {"posture": "full", "as_of": "2026-10-10", "reasons": []})
    assert posture.latest_posture(layout, date(2026, 10, 19)) is None
    assert posture.latest_posture(layout, date(2026, 10, 12))["posture"] == "full"


def test_breakout_plan_halves_risk_when_reduced_and_refuses_when_blocked(tmp_path, monkeypatch):
    import argparse
    from finance_core import cli, screen
    layout = Layout(tmp_path)
    _book(layout)
    seen = {}

    def fake_planner(lay, path, equity, risk):
        seen["risk"] = risk
        return {"planner_output": "x", "result": {"summary": {}, "actionable_orders": []}}

    monkeypatch.setattr(screen, "run_planner", fake_planner)
    args = argparse.Namespace(account="acct", screen="s.json", risk_pct="0.5", write=False, ignore_posture=False)
    posture.write_posture(layout, {"posture": "reduced", "as_of": date.today().isoformat(), "reasons": ["r"]})
    out = cli._plan_breakouts(args, layout)
    assert Decimal(seen["risk"]) == Decimal("0.25") and out["posture"]["posture"] == "reduced"
    posture.write_posture(layout, {"posture": "no-new-entries", "as_of": date.today().isoformat(), "reasons": ["r"]})
    with pytest.raises(FinanceError, match="no-new-entries"):
        cli._plan_breakouts(args, layout)
    args.ignore_posture = True
    cli._plan_breakouts(args, layout)


def test_analysis_has_cash_bucket_summing_to_100_and_unrealized_pnl(tmp_path):
    layout = Layout(tmp_path)
    _book(layout)
    a = analyze.analyze_account(layout, "acct")
    assert a["allocation"]["by_asset_type"] == {"cash_equivalent": "8.33", "etf": "91.67"}
    big = next(p for p in a["positions"] if p["key"] == "BIG")
    assert big["cost_basis"] == "6000.00" and big["unrealized_pnl"] == "4000.00" and big["unrealized_pct"] == "66.67"
    assert a["unrealized"]["pnl"] == "4000.00"


def test_report_renders_posture_income_recommendations_and_pnl(tmp_path):
    from finance_core import recommend
    layout = Layout(tmp_path)
    _book(layout)
    posture.write_posture(layout, {"posture": "reduced", "as_of": "2026-10-19", "reasons": ["SPY below 50d"],
                                   "signals": [{"symbol": "SPY", "close": "1", "vs_50d_pct": "-1", "vs_200d_pct": "2",
                                                "drawdown_from_52w_high_pct": "3"}]})
    recommend.write_recommendations(layout, recommend.recommend_for_account(layout, "acct", today=date(2026, 10, 19)))
    md = report.render_markdown(report.build_report(layout))
    for needle in ("Posture **reduced**", "Trim BIG:", "Unrealized P&L 4000.00", "no income receipt", "Entry policy"):
        assert needle in md
