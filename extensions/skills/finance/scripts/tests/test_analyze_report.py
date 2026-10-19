"""Tests for analyze.py and report.py. All fixtures are SYNTHETIC."""

import json

from finance_core import accounts, analyze, plans, report
from finance_core.layout import Layout

H = "b" * 64


def snapshot(account_id, cash, positions, as_of="2026-03-06", ccy="USD"):
    """SYNTHETIC snapshot record."""
    return {"schema_version": 0, "account_id": account_id, "as_of": as_of, "base_currency": ccy,
            "cash": cash, "positions": positions,
            "source": {"file_sha256": H, "imported_at": "2026-03-06T00:00:00+00:00"}, "warnings": []}


def pos(symbol, qty, last, asset="equity", option=None, price_as_of="2026-03-06", ccy="USD"):
    return {"symbol": symbol, "asset_type": asset, "option": option, "qty": qty, "avg_cost": "1",
            "last_price": last, "price_as_of": price_as_of, "currency": ccy}


OPTION = {"underlying": "BBB", "expiry": "2026-06-19", "strike": "210", "right": "call", "multiplier": 100}


def setup_book(tmp_path, plan_risk=True):
    """SYNTHETIC book: cash 10000, AAA etf 100@50=5000, BBB equity 10@200.50=2005,
    BBB option 2@3.50x100=700, CCC unpriced. Equity = 17705."""
    layout = Layout(tmp_path)
    accounts.create_account(layout, "acc1", "USD")
    accounts.write_snapshot(layout, "acc1", snapshot("acc1", "10000.00", [
        pos("AAA", "100", "50", asset="etf"), pos("BBB", "10", "200.50"),
        pos("BBB260619C210", "2", "3.50", asset="option", option=OPTION),
        pos("CCC", "5", None, price_as_of=None)]))
    if plan_risk:
        plans.put_plan(layout, {
            "schema_version": 0, "plan_id": "p1", "account_id": "acc1", "symbol": "AAA", "side": "buy",
            "setup": "breakout", "mode": "planned", "trigger_price": "50.00", "stop_price": "48.00",
            "targets": ["56.00"], "risk_per_share": "2.00", "quantity": 100, "risk_amount": "200.00",
            "valid_until": "2026-03-08", "gates": [], "source": {"playbook": "P5", "version": "0.1.0",
                                                              "input_hash": H},
            "status": "active", "supersedes": None, "order": None, "exits": [],
            "created_at": "2026-03-01T00:00:00+00:00"})
    return layout


def test_equity_math_hand_computed(tmp_path):
    a = analyze.analyze_account(setup_book(tmp_path), "acc1")
    assert a["equity"] == "17705.00"
    assert a["cash_pct"] == "56.48"
    assert a["allocation"]["by_asset_type"] == {"cash": "56.48", "equity": "11.32", "etf": "28.24", "option": "3.95"}
    assert a["allocation"]["by_currency"] == {"USD": "100.00"}
    assert a["top_concentration"] == [{"key": "AAA", "pct": "28.24"}, {"key": "BBB", "pct": "11.32"},
                                      {"key": "BBB260619C210", "pct": "3.95"}]
    assert a["open_risk"] == "200.00" and a["open_risk_pct"] == "1.13"
    assert a["active_plans"] == [{"plan_id": "p1", "symbol": "AAA", "status": "active"}]


def test_missing_last_price_marks_incomplete(tmp_path):
    a = analyze.analyze_account(setup_book(tmp_path), "acc1")
    assert a["equity_complete"] is False
    assert "missing last_price: CCC" in a["warnings"]
    assert all(p["key"] != "CCC" for p in a["positions"])


def test_complete_book_and_stale_price(tmp_path):
    layout = Layout(tmp_path)
    accounts.create_account(layout, "acc1", "USD")
    accounts.write_snapshot(layout, "acc1", snapshot("acc1", "100", [
        pos("AAA", "1", "10", price_as_of="2026-02-20")]))
    a = analyze.analyze_account(layout, "acc1")
    assert a["equity_complete"] is True and a["equity"] == "110.00"
    assert a["warnings"] == ["stale price: AAA"]


def test_zero_equity_gives_null_percentages(tmp_path):
    layout = Layout(tmp_path)
    accounts.create_account(layout, "acc1", "USD")
    accounts.write_snapshot(layout, "acc1", snapshot("acc1", "0", []))
    a = analyze.analyze_account(layout, "acc1")
    assert a["cash_pct"] is None and a["open_risk_pct"] is None


def test_expired_plan_excluded_from_open_risk_as_of(tmp_path):
    a = analyze.analyze_account(setup_book(tmp_path), "acc1", as_of="2026-03-09")
    assert a["open_risk"] == "0" and a["active_plans"] == []


def test_consolidated_groups_by_currency_without_fx(tmp_path):
    layout = Layout(tmp_path)
    for acct, ccy, cash in (("a1", "USD", "100"), ("a2", "USD", "50.5"), ("c1", "CAD", "70")):
        accounts.create_account(layout, acct, ccy)
        accounts.write_snapshot(layout, acct, snapshot(acct, cash, [], ccy=ccy))
    groups = analyze.consolidated(layout)["groups"]
    assert groups["USD"] == {"accounts": ["a1", "a2"], "equity": "150.50", "equity_complete": True}
    assert groups["CAD"]["equity"] == "70.00"


def test_write_analysis_receipt(tmp_path):
    layout = setup_book(tmp_path)
    path = analyze.write_analysis(layout, analyze.analyze_account(layout, "acc1"))
    assert path == layout.analysis_dir() / "acc1-2026-03-06.json"
    assert json.loads(path.read_text())["equity"] == "17705.00"


def test_report_sections_in_order_and_receipts(tmp_path):
    layout = setup_book(tmp_path)
    rep = report.build_report(layout)
    assert len(rep["receipts"]) == 1 and (layout.analysis_dir() / "acc1-2026-03-06.json").exists()
    md = report.render_markdown(rep)
    heads = [f"## {s}" for s in report.SECTIONS]
    positions = [md.index(h + "\n") for h in heads]
    assert positions == sorted(positions)
    assert "acc1 equity 17705.00 USD (incomplete)" in md
    assert "| p1 | AAA | planned | 50.00 | 48.00 | 100 | 2026-03-08 |" in md
    assert "Resolve: acc1: missing last_price: CCC" in md
    assert "Plan p1 (AAA) expires 2026-03-08" in md
    assert "Snapshot as_of acc1: 2026-03-06" in md


def test_write_report_files(tmp_path):
    layout = setup_book(tmp_path)
    rep = report.build_report(layout)
    paths = report.write_report(layout, rep)
    assert paths["md_path"] == layout.reports_dir() / "2026-03-06.md"
    assert json.loads(paths["json_path"].read_text())["as_of"] == "2026-03-06"
    assert paths["md_path"].read_text().startswith("# Portfolio report 2026-03-06")
