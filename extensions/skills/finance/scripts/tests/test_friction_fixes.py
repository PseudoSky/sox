"""Regression tests for the blind-test friction fixes.

SYNTHETIC data only. Each test names the friction it pins.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from finance_core import accounts, paper  # noqa: E402
from finance_core.cli import main  # noqa: E402
from finance_core.errors import FinanceError  # noqa: E402
from finance_core.inlet import ingest  # noqa: E402
from finance_core.layout import Layout  # noqa: E402
from finance_core.analyze import analyze_account  # noqa: E402
from decimal import Decimal  # noqa: E402

# Summary rows share the asset-type column with real positions, and carry "--" in quantity.
EXPORT = """SYNTHETIC export. Not real data.
As of 10/16/2026
Account: SYN-0000-7777
Symbol,Asset Type,Quantity,Last Price,Current Value
AAA,Stock,20,45.00,900.00
Cash & Cash Investments,Cash,--,--,100.00
Positions Total,,--,--,1000.00
"""

MAPPING = {
    "schema_version": 0, "broker_label": "synthetic-broker", "format": "csv", "header_line": 4,
    "as_of": {"regex": r"As of (\d{2}/\d{2}/\d{4})", "group": 1}, "as_of_format": "%m/%d/%Y",
    "cash": {"value": "100.00"},
    "account_number": {"regex": r"Account: (\S+)", "group": 1},
    "control_total": {"value": "1000.00"},
    "rows": {"row_filter": {"column": "Symbol", "not_equals": "Positions Total"},
             "require_numeric": ["Quantity"]},
    "fields": {"symbol": {"column": "Symbol"}, "quantity": {"column": "Quantity"},
               "last_price": {"column": "Last Price"}, "asset_type": {"column": "Asset Type"}},
    "asset_type_map": {"Stock": "equity", "Cash": "other"},
}


@pytest.fixture
def root(tmp_path):
    r = tmp_path / "root"
    r.mkdir()
    return r


def _run(root, *args, capsys):
    code = main(["--root", str(root), *args])
    out = capsys.readouterr()
    return code, json.loads(out.out or "{}"), json.loads(out.err or "{}")


def test_summary_rows_skipped_by_require_numeric_with_named_warning(tmp_path, root):
    layout = Layout(root)
    accounts.create_account(layout, "syn", "USD", account_mask="7777")
    src = tmp_path / "export.csv"
    src.write_text(EXPORT)
    mp = tmp_path / "map.json"
    mp.write_text(json.dumps(MAPPING))
    summary = ingest(layout, "syn", mp, src)
    assert summary["positions"] == 1
    warning = next(w for w in summary["warnings"] if "require_numeric" in w)
    assert "Cash & Cash Investments" in warning and "Quantity" in warning


def test_invalid_mapping_exits_2(tmp_path, root, capsys):
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"schema_version": 0}))
    code, _, err = _run(root, "inlet", "check-mapping", "--mapping", str(bad), capsys=capsys)
    assert code == 2
    assert err["reasons"]


def test_quantity_field_name_gets_direct_error(root, capsys):
    accounts.create_account(Layout(root), "syn", "USD")
    order = '{"symbol":"AAA","side":"sell","quantity":"1","type":"market"}'
    code, _, err = _run(root, "paper", "order", "--account", "syn", "--order", order, capsys=capsys)
    assert code == 2
    assert "'qty', not 'quantity'" in err["error"]


def test_analysis_values_snapshot_plus_ledger(root):
    layout = Layout(root)
    accounts.create_account(layout, "syn", "USD")
    record = {
        "schema_version": 0, "account_id": "syn", "as_of": "2026-10-16", "base_currency": "USD",
        "cash": "1000.00",
        "positions": [{"symbol": "SMH", "asset_type": "etf", "option": None, "qty": "20",
                       "avg_cost": "500", "last_price": "550.00", "price_as_of": "2026-10-16",
                       "currency": "USD"}],
        "source": {"file_sha256": "a" * 64, "imported_at": "2026-10-16T12:00:00+00:00"},
        "warnings": [],
    }
    accounts.write_snapshot(layout, "syn", record)
    oid = paper.place_order(layout, "syn", {"symbol": "SMH", "side": "sell", "qty": "1", "type": "market"})
    paper.fill_bar(layout, "syn", oid, {"open": "550", "high": "551", "low": "549", "close": "550",
                                        "ts": "2026-10-16T14:30:00Z"})
    result = analyze_account(layout, "syn")
    smh = next(p for p in result["positions"] if p["key"] == "SMH")
    assert smh["qty"] == "19"
    assert result["cash"] != "1000.00"
    expected = (paper.positions_now(layout, "syn")["cash"] + Decimal("19") * Decimal("550")).quantize(Decimal("0.01"))
    assert result["equity"] == str(expected)



def test_short_visible_tail_matches_longer_mask(tmp_path, root):
    # The broker shows only "****496"; mask "0496" must match that visible tail (blind-run 1 rejection).
    layout = Layout(root)
    accounts.create_account(layout, "syn", "USD", account_mask="0496")
    src = tmp_path / "export.csv"
    src.write_text(EXPORT.replace("SYN-0000-7777", "****496"))
    mp = tmp_path / "map.json"
    mp.write_text(json.dumps(MAPPING))
    assert ingest(layout, "syn", mp, src)["positions"] == 1


def test_wrong_mask_rejected_with_fix_and_fixable_in_place(tmp_path, root, capsys):
    layout = Layout(root)
    accounts.create_account(layout, "syn", "USD", account_mask="7777")
    src = tmp_path / "export.csv"
    src.write_text(EXPORT.replace("SYN-0000-7777", "****496"))
    mp = tmp_path / "map.json"
    mp.write_text(json.dumps(MAPPING))
    with pytest.raises(FinanceError) as exc:
        ingest(layout, "syn", mp, src)
    assert "fix with: account config --account syn --key account_mask" in exc.value.reasons[0]
    code, _, _ = _run(root, "account", "config", "--account", "syn", "--key", "account_mask",
                      "--value", "496", capsys=capsys)
    assert code == 0
    assert ingest(layout, "syn", mp, src)["positions"] == 1


def test_cash_equivalents_count_toward_cash_pct_like_a_brokerage_sweep(tmp_path, root):
    layout = Layout(root)
    accounts.create_account(layout, "syn", "USD", account_mask="7777")
    src = tmp_path / "export.csv"
    src.write_text("SYNTHETIC export. Not real data.\nAs of 10/16/2026\nAccount: SYN-0000-7777\n"
                   "Symbol,Asset Type,Quantity,Last Price,Current Value\n"
                   "AAA,Stock,20,45.00,900.00\n"
                   "MMF,Money Market,100,1.00,100.00\n")
    mp = tmp_path / "map.json"
    mp.write_text(json.dumps({
        "schema_version": 0, "broker_label": "synthetic-broker", "format": "csv", "header_line": 4,
        "as_of": {"regex": r"As of (\d{2}/\d{2}/\d{4})", "group": 1}, "as_of_format": "%m/%d/%Y",
        "cash": {"value": "100.00"}, "account_number": {"regex": r"Account: (\S+)", "group": 1},
        "control_total": {"value": "1100.00"},
        "fields": {"symbol": {"column": "Symbol"}, "quantity": {"column": "Quantity"},
                   "last_price": {"column": "Last Price"}, "asset_type": {"column": "Asset Type"}},
        "asset_type_map": {"Stock": "equity", "Money Market": "cash_equivalent"},
    }))
    assert ingest(layout, "syn", mp, src)["reconciled"] is True
    result = analyze_account(layout, "syn")
    assert result["equity"] == "1100.00"
    assert result["cash_equivalents"] == "100.00"
    assert result["cash_pct"] == "18.18"
    assert result["allocation"]["by_asset_type"]["cash_equivalent"] == "9.09"
