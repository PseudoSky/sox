"""Regression tests for the blind-test-6 findings. All data is SYNTHETIC."""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from finance_core import accounts, analyze, intraday, paper, posture, recommend, report, screen, universe  # noqa: E402
from finance_core.cli import main  # noqa: E402
from finance_core.errors import FinanceError  # noqa: E402
from finance_core.layout import Layout, atomic_write_json, write_receipt  # noqa: E402

TODAY = date(2026, 10, 19)


def book(layout: Layout, as_of: str = "2026-10-16") -> None:
    """SYNTHETIC: BIG 100 @ avg 60 marked 100 (a 10000 position), SMALL 10 @ 100, cash 0. Equity 11000."""
    accounts.create_account(layout, "acct", "USD")
    accounts.write_snapshot(layout, "acct", {
        "as_of": as_of, "account_id": "acct", "base_currency": "USD",
        "source": {"file_sha256": "ab" * 32, "imported_at": f"{as_of}T00:00:00+00:00", "note": "SYNTHETIC"},
        "cash": "0", "warnings": [],
        "positions": [
            {"symbol": "BIG", "asset_type": "etf", "option": None, "qty": "100", "avg_cost": "60.00",
             "last_price": "100", "price_as_of": as_of, "currency": "USD"},
            {"symbol": "SMALL", "asset_type": "etf", "option": None, "qty": "10", "avg_cost": "100",
             "last_price": "100", "price_as_of": as_of, "currency": "USD"}]})


def sell_big(layout: Layout, qty: str, bar_open: str, ts: str) -> dict:
    oid = paper.place_order(layout, "acct", {"symbol": "BIG", "side": "sell", "qty": qty, "type": "limit",
                                             "limit_price": "100"})
    bar = {"open": bar_open, "high": "103", "low": "99", "close": "102", "ts": ts}
    return paper.fill_bar(layout, "acct", oid, bar)


# --- receipts keep history (blind-test-6 #6)
def test_changed_receipt_keeps_the_previous_one_in_history(tmp_path):
    path = tmp_path / "r" / "a-2026-10-16.json"
    write_receipt(path, {"v": 1})
    write_receipt(path, {"v": 1})
    assert not (path.parent / "history").exists()
    write_receipt(path, {"v": 2})
    kept = list((path.parent / "history").glob("a-2026-10-16-*.json"))
    assert len(kept) == 1 and json.loads(kept[0].read_text()) == {"v": 1}
    assert json.loads(path.read_text()) == {"v": 2}


# --- realized P&L (#10) and the position sequence (#5)
def test_sell_fill_records_realized_pnl_from_average_cost(tmp_path):
    layout = Layout(tmp_path)
    book(layout)
    fill = sell_big(layout, "70", "101", "2026-10-19")
    assert fill["status"] == "filled" and fill["price"] == "101"
    assert Decimal(fill["realized_pnl"]) == (Decimal("101") - 60) * 70 - Decimal(fill["fee"]) == Decimal("2870")
    assert fill["fill_rule"] == {"order_type": "limit", "mode": "limit", "bar_open": "101"}
    summary = paper.realized_fills(layout, "acct")
    assert summary["realized_pnl"] == f"{(Decimal('101') - 60) * 70 - Decimal(fill['fee']):.2f}"
    assert len(summary["fills"]) == 1 and summary["unknown_cost_fills"] == 0
    assert analyze.analyze_account(layout, "acct")["realized"]["realized_pnl"] == summary["realized_pnl"]


# --- mixed marks (#7)
def test_fill_on_a_later_bar_warns_about_mixed_price_dates(tmp_path):
    layout = Layout(tmp_path)
    book(layout)
    assert not any("mixed price dates" in w for w in analyze.analyze_account(layout, "acct")["warnings"])
    sell_big(layout, "10", "101", "2026-10-19")
    result = analyze.analyze_account(layout, "acct")
    warning = next(w for w in result["warnings"] if "mixed price dates" in w)
    assert "2026-10-16, 2026-10-19" in warning and "BIG marked 2026-10-19" in warning
    marks = {p["key"]: p["price_as_of"] for p in result["positions"]}
    assert marks == {"BIG": "2026-10-19", "SMALL": "2026-10-16"}


# --- a recommendation made before a fill is flagged stale in the report (#5)
def test_report_flags_a_recommendation_older_than_the_latest_fill(tmp_path):
    layout = Layout(tmp_path)
    book(layout)
    posture.write_posture(layout, {"posture": "full", "as_of": "2026-10-19", "reasons": ["x"], "signals": []})
    rec = recommend.recommend_for_account(layout, "acct", today=TODAY)
    recommend.write_recommendations(layout, rec)
    fresh = report.render_markdown(report.build_report(layout, today=TODAY))
    assert "STALE" not in fresh
    sell_big(layout, "10", "101", "2026-10-19")
    md = report.render_markdown(report.build_report(layout, today=TODAY))
    assert "STALE: positions changed after this recommendation" in md
    assert "Re-run `recommend --account acct`" in md
    assert "Realized on paper fills since the snapshot" in md


# --- stale snapshot (#8)
def test_snapshot_age_warning_thresholds():
    assert analyze.snapshot_age_warning("2026-10-16", date(2026, 10, 17)) is None
    text = analyze.snapshot_age_warning("2026-10-16", date(2026, 10, 19))
    assert text.startswith("snapshot is 3 days old (2026-10-16") and "re-ingest" in text


def test_report_and_recommend_carry_the_stale_snapshot_warning(tmp_path):
    layout = Layout(tmp_path)
    book(layout)
    rep = report.build_report(layout, as_of="2026-10-19")
    assert any("acct: snapshot is 3 days old" in w for w in rep["warnings"])
    assert any("snapshot is 3 days old" in w for w in recommend.recommend_for_account(layout, "acct", today=TODAY)["warnings"])
    assert not any("snapshot is" in w for w in report.build_report(layout, as_of="2026-10-16")["warnings"])


def test_report_can_be_limited_to_one_account(tmp_path, capsys):
    layout = Layout(tmp_path)
    book(layout)
    accounts.create_account(layout, "other", "USD")
    accounts.write_snapshot(layout, "other", {
        "as_of": "2026-10-16", "account_id": "other", "base_currency": "USD",
        "source": {"file_sha256": "cd" * 32, "imported_at": "2026-10-16T00:00:00+00:00"},
        "cash": "5", "positions": [], "warnings": []})
    assert [a["account_id"] for a in report.build_report(layout, as_of="2026-10-16", account_id="other")["accounts"]] == ["other"]
    assert main(["--root", str(tmp_path), "report", "--account", "acct", "--as-of", "2026-10-16"]) == 0
    assert "other" not in capsys.readouterr().out.split("md_path")[0]


# --- recommendation wording (#11)
def test_trim_text_is_a_complete_sentence_with_the_alternative_explained(tmp_path):
    layout = Layout(tmp_path)
    book(layout)
    trim = next(i for i in recommend.recommend_for_account(layout, "acct", today=TODAY)["items"] if i["type"] == "trim")
    # equity 11000, limit 25% = 2750, excess 7250 -> 72 whole shares = 7200; 2800/11000 = 25.45%; 72*(100-60) = 2880
    assert trim["text"] == ("Sell 72 BIG at about 100 for roughly $7,200.00, which takes it from 90.91% to 25.45% of "
                            "equity; the estimated realized gain on average cost is $2,880.00.")
    assert trim["after"]["proceeds_as_pct_of_equity"] == "65.45"
    assert "adding this much new money" in trim["alternative"]["meaning"]
    assert trim["caveat"][0].isupper()


# --- paper fill from the latest cached bar (#9)
def seed_bars(layout: Layout, symbol: str, last: dict) -> None:
    bar = {"date": "2026-10-19", "adj_close": last["close"], "volume": 1_000_000, **last}
    atomic_write_json(layout.base / "market" / f"{symbol}.json", {
        "symbol": symbol, "currency": "USD", "name": symbol, "bars": [bar], "dividends": [], "splits": [],
        "range": "1y", "source": "synthetic", "provider": "yahoo", "adjusted": True,
        "fetched_at": datetime.now(timezone.utc).isoformat()})


def test_paper_fill_latest_bar_uses_the_cached_bar(tmp_path, capsys):
    layout = Layout(tmp_path)
    book(layout)
    seed_bars(layout, "BIG", {"open": "101.00", "high": "103.00", "low": "99.00", "close": "102.00"})
    oid = paper.place_order(layout, "acct", {"symbol": "BIG", "side": "sell", "qty": "5", "type": "limit",
                                             "limit_price": "100"})
    assert main(["--root", str(tmp_path), "paper", "fill", "--account", "acct", "--order-id", oid, "--latest-bar"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["status"] == "filled" and out["price"] == "101.00" and out["bar_ts"] == "2026-10-19"
    assert out["fill_rule"]["mode"] == "limit" and out["fill_rule"]["bar_open"] == "101.00"


def test_paper_fill_needs_a_bar_source(tmp_path, capsys):
    layout = Layout(tmp_path)
    book(layout)
    oid = paper.place_order(layout, "acct", {"symbol": "BIG", "side": "sell", "qty": "5", "type": "market"})
    assert main(["--root", str(tmp_path), "paper", "fill", "--account", "acct", "--order-id", oid]) == 2
    assert "--bar" in capsys.readouterr().err


# --- intraday caps (#12) and exit codes (#14)
def test_large_account_gets_no_default_dollar_caps():
    ok = dict(grade="A", signal="mega_bull", rvol="1.4", time_et="10:15", trend_age=6, weekday=1)
    r = intraday.check_entry(**ok, account_size="229848.55", symbol="SPY", day_pnl="0")
    assert "max_per_trade" not in r and "max_daily_loss" not in r and r["allowed"]
    assert any("State your own limits" in w for w in r["warnings"])
    assert any("daily-loss rule was NOT evaluated" in w for w in r["warnings"])
    assert not any(x["rule"] == "daily_loss_not_reached" for x in r["rules"])


def test_stated_percent_limits_set_the_caps_and_evaluate_the_daily_loss():
    ok = dict(grade="A", signal="mega_bull", rvol="1.4", time_et="10:15", trend_age=6, weekday=1)
    r = intraday.check_entry(**ok, account_size="200000", symbol="SPY", day_pnl="-1500",
                             max_trade_pct="1", max_daily_loss_pct="0.5")
    assert r["max_per_trade"] == "2000.00" and r["max_daily_loss"] == "1000.00"
    assert r["failed"] == ["daily_loss_not_reached"] and r["warnings"] == []


def test_not_allowed_is_a_verdict_with_exit_zero(capsys):
    code = main(["intraday", "entry", "--grade", "A", "--signal", "mega_bull", "--rvol", "1.5", "--time", "10:00",
                 "--trend-age", "5", "--weekday", "4"])
    assert code == 0 and json.loads(capsys.readouterr().out)["failed"] == ["no_friday_0dte"]


# --- screen output (#3)
def test_screen_reports_truncation_and_funnel(tmp_path, monkeypatch):
    layout = Layout(tmp_path)
    results = [{"symbol": f"S{i}", "valid_vcp": False} for i in range(20)]
    out_file = tmp_path / "screen.json"
    out_file.write_text(json.dumps({"schema_version": "1.0", "results": results,
                                    "metadata": {"funnel": {"universe": 108, "pre_filter_passed": 66,
                                                            "trend_template_passed": 26, "vcp_candidates": 26}}}))
    monkeypatch.setattr(screen, "_run", lambda *a, **k: f"JSON Report: {out_file}\n")
    out = screen.run_screen(layout, ["AAA", "BBB"], max_candidates=1, top=20)
    assert out["truncated"] is True and out["funnel"]["vcp_candidates"] == 26
    assert "best-scoring of 26 VCP candidates" in out["note"] and "--top 20" in out["note"]
    assert "only the 1 highest" in out["pre_filter_cap"]


# --- keyless universe (#4)
CSV_HEADER = "Symbol,Security,GICS Sector,GICS Sub-Industry,Headquarters Location,Date added,CIK,Founded\n"


def fake_opener(rows: int, calls: list):
    def opener(url, headers):
        calls.append(url)
        lines = [f'T{i:03d},Corp {i},{"Energy" if i % 2 else "Financials"},x,"Y, Z",2000-01-01,{i},1900'
                 for i in range(rows)]
        lines[0] = 'BRK.B,Berkshire,Financials,x,"Omaha, Nebraska",2010-02-16,1067983,1839'
        return 200, (CSV_HEADER + "\n".join(lines)).encode()
    return opener


def test_universe_parses_caches_and_filters(tmp_path):
    layout, calls = Layout(tmp_path), []
    first = universe.get_universe(layout, opener=fake_opener(120, calls))
    assert first["count"] == 120 and first["symbols"][0] == "BRK-B" and first["sectors"] == ["Energy", "Financials"]
    energy = universe.get_universe(layout, sector="energy", opener=fake_opener(120, calls))
    assert energy["count"] == 60 and len(calls) == 1
    assert universe.get_universe(layout, limit=3, opener=fake_opener(120, calls))["symbols"][1:] == ["T001", "T002"]


def test_universe_rejects_a_short_list_and_an_unknown_sector(tmp_path):
    with pytest.raises(FinanceError, match="index-sized"):
        universe.get_universe(Layout(tmp_path / "a"), opener=fake_opener(10, []))
    layout = Layout(tmp_path / "b")
    universe.get_universe(layout, opener=fake_opener(120, []))
    with pytest.raises(FinanceError, match="sectors: Energy, Financials"):
        universe.get_universe(layout, sector="Utilities")


def test_screen_requires_exactly_one_universe_source(tmp_path, capsys):
    assert main(["--root", str(tmp_path), "market", "screen"]) == 2
    assert "exactly one of --symbols or --index" in capsys.readouterr().err


# --- exact cost basis (#1)
COST_EXPORT = ("SYNTHETIC export. Not real data.\nAs of 10/16/2026\nAccount: SYN-0000-4321\n"
               "Symbol,Quantity,Price,Cost/Share,Cost Basis\n"
               'AAA,246,713.17,470.83,"$115,825.00"\n')
COST_MAPPING = {
    "schema_version": 0, "broker_label": "synthetic", "format": "csv", "header_line": 4,
    "as_of": {"regex": r"As of (\d{2}/\d{2}/\d{4})", "group": 1}, "as_of_format": "%m/%d/%Y",
    "cash": {"value": "100.00"}, "account_number": {"regex": r"Account: (\S+)", "group": 1},
    "control_total": {"value": "175539.82"},
    "fields": {"symbol": {"column": "Symbol"}, "quantity": {"column": "Quantity"}, "last_price": {"column": "Price"},
               "avg_cost": {"column": "Cost/Share"}, "cost_basis": {"column": "Cost Basis"}},
}


def test_total_cost_basis_beats_the_rounded_per_share_cost(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    (tmp_path / "e.csv").write_text(COST_EXPORT)
    (tmp_path / "m.json").write_text(json.dumps(COST_MAPPING))
    layout = Layout(root)
    accounts.create_account(layout, "syn", "USD", account_mask="4321")
    from finance_core.inlet import ingest
    ingest(layout, "syn", tmp_path / "m.json", tmp_path / "e.csv")
    row = analyze.analyze_account(layout, "syn")["positions"][0]
    # 246 x 470.83 = 115824.18 from the rounded column; the broker's total is 115825.00
    assert row["cost_basis"] == "115825.00" and row["unrealized_pnl"] == "59614.82"


# --- blind-test-7 findings
def test_realized_pnl_is_rounded_to_cents(tmp_path):
    layout = Layout(tmp_path)
    book(layout)
    snap = next((layout.account_dir("acct") / "snapshots").glob("*.json"))
    data = json.loads(snap.read_text())
    data["positions"][0]["avg_cost"] = "60.3333333"
    snap.write_text(json.dumps(data))
    fill = sell_big(layout, "7", "101", "2026-10-19")
    # (101 - 60.3333333) * 7 = 284.6666669 -> 284.67
    assert fill["realized_pnl"] == "284.67"


def test_sub_share_excess_is_stated_not_dropped(tmp_path):
    layout = Layout(tmp_path)
    book(layout)
    sell_big(layout, "72", "100", "2026-10-19")  # 28 BIG + 10 SMALL, equity 11000: BIG 25.45%, excess $50
    out = recommend.recommend_for_account(layout, "acct", today=TODAY)
    assert [i for i in out["items"] if i["type"] == "trim"] == []
    note = next(w for w in out["warnings"] if "less than one share" in w)
    assert "BIG is 25.45% of equity" in note and "$50.00" in note
    recommend.write_recommendations(layout, out)
    assert "Note: BIG is 25.45%" in report.render_markdown(report.build_report(layout, today=TODAY))


def test_bar_in_progress_follows_the_eastern_session():
    from finance_core.marketdata import bar_in_progress
    morning = datetime(2026, 10, 20, 13, 42, tzinfo=timezone.utc)   # 09:42 ET
    evening = datetime(2026, 10, 20, 21, 0, tzinfo=timezone.utc)    # 17:00 ET
    assert bar_in_progress("2026-10-20", morning) and not bar_in_progress("2026-10-20", evening)
    assert not bar_in_progress("2026-10-19", morning)


def test_latest_bar_fill_warns_while_the_session_is_open(tmp_path, capsys, monkeypatch):
    from finance_core import marketdata
    layout = Layout(tmp_path)
    book(layout)
    seed_bars(layout, "BIG", {"open": "101.00", "high": "103.00", "low": "99.00", "close": "102.00"})
    monkeypatch.setattr(marketdata, "bar_in_progress", lambda d: True)
    oid = paper.place_order(layout, "acct", {"symbol": "BIG", "side": "sell", "qty": "5", "type": "limit",
                                             "limit_price": "100"})
    assert main(["--root", str(tmp_path), "paper", "fill", "--account", "acct", "--order-id", oid, "--latest-bar"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["status"] == "filled" and "still forming" in out["warnings"][0]
