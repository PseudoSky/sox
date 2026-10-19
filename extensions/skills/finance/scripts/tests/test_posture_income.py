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
    r = intraday.check_entry(**ok, account_size="500", symbol="spy")
    assert r["allowed"] and r["max_daily_loss"] == "400.00" and "80%" in r["warnings"][0]
    wrong = intraday.check_entry(**ok, symbol="TSLA")
    assert wrong["failed"] == ["signal_on_spy"]
