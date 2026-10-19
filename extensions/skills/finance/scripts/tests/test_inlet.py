"""Tests for finance_core.inlet.

ALL FIXTURES IN THIS FILE ARE SYNTHETIC: invented tickers, invented account numbers, invented
balances. Nothing here is real brokerage data.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from finance_core.accounts import create_account, load_current, load_mapping  # noqa: E402
from finance_core.errors import FinanceError  # noqa: E402
from finance_core.inlet import ingest, validate_mapping  # noqa: E402
from finance_core.layout import Layout  # noqa: E402

RAW_ACCT = "987654321012"

CSV_TEXT = (
    "Symbol,Quantity,Price,Cost,Type,Cash,AsOf,Acct,Total\n"
    f'SYN1,10,5.00,4.00,Stock,"$1,234.50",2026-01-02,{RAW_ACCT},1334.50\n'
    "SYN2,5,10.00,,ETF,,,,\n"
    ",,,,,,,,SYNTHETIC footer row no symbol\n"
)


def csv_mapping(**over):
    mapping = {
        "schema_version": 0, "broker_label": "synbroker", "format": "csv",
        "as_of": {"column": "AsOf"}, "cash": {"column": "Cash"},
        "account_number": {"column": "Acct"}, "control_total": {"column": "Total"},
        "fields": {"symbol": {"column": "Symbol"}, "quantity": {"column": "Quantity"},
                   "last_price": {"column": "Price"}, "avg_cost": {"column": "Cost"},
                   "asset_type": {"column": "Type"}},
        "asset_type_map": {"Stock": "equity", "ETF": "etf"},
    }
    mapping.update(over)
    return mapping


def json_doc():
    return {"_note": "SYNTHETIC", "data": {"asof": "2026-02-03", "cash": "100.00",
            "positions": [
                {"sym": "SYNA", "q": "2", "px": "50.5", "kind": "STK"},
                {"sym": "SYNA", "q": 1, "px": "50.5", "kind": "OPT", "und": "SYNA",
                 "exp": "2026-06-19", "k": "55", "cp": "c", "mult": "100"}]}}


def json_mapping(**over):
    mapping = {
        "schema_version": 0, "broker_label": "synjson", "format": "json",
        "as_of": {"path": "data.asof"}, "cash": {"path": "data.cash"},
        "rows": {"rows_path": "data.positions"},
        "fields": {"symbol": {"path": "sym"}, "quantity": {"path": "q"},
                   "last_price": {"path": "px"}, "asset_type": {"path": "kind"},
                   "option_underlying": {"path": "und"}, "option_expiry": {"path": "exp"},
                   "option_strike": {"path": "k"}, "option_right": {"path": "cp"},
                   "option_multiplier": {"path": "mult"}},
        "asset_type_map": {"STK": "equity", "OPT": "option"},
    }
    mapping.update(over)
    return mapping


@pytest.fixture
def env(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    layout = Layout(root)
    create_account(layout, "syn", "USD", account_mask="****1012")
    ext = tmp_path / "exports"
    ext.mkdir()

    def put(name, content, mapping):
        src = ext / name
        src.write_text(content if isinstance(content, str) else json.dumps(content))
        mp = ext / f"{name}.map.json"
        mp.write_text(json.dumps(mapping))
        return mp, src
    return layout, put


def account_files(layout):
    return [p for p in layout.account_dir("syn").rglob("*")
            if p.is_file() and p.name != "account.json"]


def test_csv_happy_path(env):
    layout, put = env
    mp, src = put("a.csv", CSV_TEXT, csv_mapping())
    out = ingest(layout, "syn", mp, src)
    record, _ = load_current(layout, "syn")
    assert out["positions"] == 2 and out["reconciled"] is True
    assert record["cash"] == "1234.50" and record["as_of"] == "2026-01-02"
    assert record["base_currency"] == "USD"
    assert record["warnings"] == ["skipped 1 rows with no symbol"]
    p1, p2 = record["positions"]
    assert (p1["symbol"], p1["asset_type"], p1["qty"], p1["avg_cost"]) == ("SYN1", "equity", "10", "4.00")
    assert p2["asset_type"] == "etf" and p2["avg_cost"] is None
    assert p1["price_as_of"] == "2026-01-02" and p1["currency"] == "USD" and p1["option"] is None
    assert load_mapping(layout, "syn", "synbroker")["broker_label"] == "synbroker"


def test_json_happy_path_with_option_row(env):
    layout, put = env
    mp, src = put("b.json", json_doc(), json_mapping())
    ingest(layout, "syn", mp, src)
    record, _ = load_current(layout, "syn")
    equity, option = record["positions"]
    assert equity["qty"] == "2" and equity["last_price"] == "50.5"
    assert option["asset_type"] == "option"
    assert option["option"] == {"underlying": "SYNA", "expiry": "2026-06-19", "strike": "55",
                                "right": "C", "multiplier": "100"}


def test_option_row_missing_field_rejected(env):
    layout, put = env
    doc = json_doc()
    del doc["data"]["positions"][1]["k"]
    mp, src = put("b.json", doc, json_mapping())
    with pytest.raises(FinanceError) as exc:
        ingest(layout, "syn", mp, src)
    assert any("option_strike" in r for r in exc.value.reasons)


def test_reject_writes_nothing(env):
    layout, put = env
    bad = CSV_TEXT.replace("SYN2,5,10.00", "SYN2,five,10.00")
    mp, src = put("bad.csv", bad, csv_mapping())
    with pytest.raises(FinanceError) as exc:
        ingest(layout, "syn", mp, src)
    assert any("SYN2" in r for r in exc.value.reasons)
    assert account_files(layout) == []
    assert not (layout.account_dir("syn") / "current.json").exists()
    assert not (layout.account_dir("syn") / "mappings").exists()
    assert not (layout.account_dir("syn") / "snapshots").exists()


def test_unmapped_asset_type_rejected(env):
    layout, put = env
    mp, src = put("a.csv", CSV_TEXT.replace("ETF", "Warrant"), csv_mapping())
    with pytest.raises(FinanceError) as exc:
        ingest(layout, "syn", mp, src)
    assert any("unmapped asset type" in r for r in exc.value.reasons)


def test_control_total_mismatch_rejected(env):
    layout, put = env
    mp, src = put("a.csv", CSV_TEXT.replace("1334.50", "1400.00"), csv_mapping())
    with pytest.raises(FinanceError) as exc:
        ingest(layout, "syn", mp, src)
    assert any("control_total mismatch" in r for r in exc.value.reasons)
    assert account_files(layout) == []


def test_duplicate_key_rejected(env):
    layout, put = env
    dup = CSV_TEXT.replace("SYN2,5", "SYN1,5")
    mapping = csv_mapping()
    del mapping["control_total"]
    mp, src = put("a.csv", dup, mapping)
    with pytest.raises(FinanceError) as exc:
        ingest(layout, "syn", mp, src)
    assert any("duplicate position key" in r for r in exc.value.reasons)


def test_repo_internal_source_rejected(tmp_path):
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    layout = Layout(repo)
    create_account(layout, "syn", "USD")
    src = repo / "inside.csv"
    src.write_text(CSV_TEXT)
    mp = tmp_path / "m.json"
    mp.write_text(json.dumps(csv_mapping()))
    with pytest.raises(FinanceError, match="outside the repo"):
        ingest(layout, "syn", mp, src)


def test_account_number_mismatch_rejected(env):
    layout, put = env
    mp, src = put("a.csv", CSV_TEXT.replace(RAW_ACCT, "111122223333"), csv_mapping())
    with pytest.raises(FinanceError) as exc:
        ingest(layout, "syn", mp, src)
    assert any("account_number" in r for r in exc.value.reasons)
    assert not any("111122223333" in r for r in exc.value.reasons)
    assert account_files(layout) == []


def test_raw_account_number_never_persisted(env):
    layout, put = env
    mp, src = put("a.csv", CSV_TEXT, csv_mapping())
    ingest(layout, "syn", mp, src)
    files = account_files(layout)
    assert files
    for path in layout.account_dir("syn").rglob("*"):
        if path.is_file():
            assert RAW_ACCT not in path.read_text()


def test_ledger_difference_warns_statement_wins(env):
    layout, put = env
    mp, src = put("a.csv", CSV_TEXT, csv_mapping())
    out = ingest(layout, "syn", mp, src, ledger_positions={"SYN1": "12", "SYN2": "5"})
    assert any("SYN1" in w and "statement wins" in w for w in out["warnings"])
    assert not any("SYN2" in w and "statement wins" in w for w in out["warnings"])


def test_same_file_twice_is_finance_error(env):
    layout, put = env
    mp, src = put("a.csv", CSV_TEXT, csv_mapping())
    ingest(layout, "syn", mp, src)
    with pytest.raises(FinanceError, match="already exists"):
        ingest(layout, "syn", mp, src)


def test_validate_mapping_unknown_format():
    errors = validate_mapping(csv_mapping(format="xlsx"))
    assert any("format" in e for e in errors)


def test_validate_mapping_partial_option_fields():
    mapping = json_mapping()
    del mapping["fields"]["option_right"]
    assert any("option_*" in e for e in validate_mapping(mapping))


def test_format_not_in_account_import_formats(tmp_path):
    layout = Layout(tmp_path / "r")
    create_account(layout, "syn", "USD", import_formats=["json"])
    src = tmp_path / "x.csv"
    src.write_text(CSV_TEXT)
    mp = tmp_path / "m.json"
    mp.write_text(json.dumps(csv_mapping()))
    with pytest.raises(FinanceError) as exc:
        ingest(layout, "syn", mp, src)
    assert any("import_formats" in r for r in exc.value.reasons)


PREAMBLE_CSV = (
    "SYNTHETIC brokerage export with a two-line preamble. Not real data.\n"
    "As of 2026-01-02\n"
    "Symbol,Quantity,Price,Cost,Type,Cash,AsOf,Acct,Total\n"
    f'SYN1,10,5.00,4.00,Stock,"$1,234.50",2026-01-02,{RAW_ACCT},1284.50\n'
)


def test_header_line_skips_preamble(env):
    layout, put = env
    mp, src = put("pre.csv", PREAMBLE_CSV, csv_mapping(header_line=3))
    summary = ingest(layout, "syn", mp, src)
    record, _ = load_current(layout, "syn")
    assert summary["positions"] == 1
    assert [p["symbol"] for p in record["positions"]] == ["SYN1"]


def test_default_header_line_on_preamble_rejects_not_drops(env):
    layout, put = env
    mp, src = put("pre2.csv", PREAMBLE_CSV, csv_mapping())
    with pytest.raises(FinanceError):
        ingest(layout, "syn", mp, src)
    assert account_files(layout) == []


def test_validate_mapping_rejects_bad_header_line():
    errors = validate_mapping(csv_mapping(header_line=0))
    assert any(e.startswith("header_line") for e in errors)


def test_blank_asset_type_cell_rejected_when_mapped(env):
    layout, put = env
    csv_text = (
        "Symbol,Quantity,Price,Cost,Type,Cash,AsOf,Acct,Total\n"
        f'SYN1,10,5.00,4.00,,"$50.00",2026-01-02,{RAW_ACCT},100.00\n'
    )
    mapping = csv_mapping()
    del mapping["control_total"]
    mp, src = put("blank_type.csv", csv_text, mapping)
    with pytest.raises(FinanceError) as exc:
        ingest(layout, "syn", mp, src)
    assert any("asset_type" in reason for reason in exc.value.reasons)
    assert account_files(layout) == []


def test_wrong_header_line_lists_the_columns_it_read(env):
    layout, put = env
    mp, src = put("a.csv", CSV_TEXT, csv_mapping(header_line=200, as_of={"value": "2026-01-02"}, cash={"value": "0"},
                                        account_number={"value": "1012"}, control_total={"value": "0"}))
    with pytest.raises(FinanceError) as caught:
        ingest(layout, "syn", mp, src)
    text = " ".join([str(caught.value)] + caught.value.reasons)
    assert "header_line 200" in text and "blanks included" in text and "0 data rows" in text


def test_missing_scalar_names_the_pattern_that_matched_nothing(env):
    layout, put = env
    mp, src = put("a.csv", CSV_TEXT, csv_mapping(control_total={"regex": r"NoSuchTotal:(\d+)", "group": 1}))
    with pytest.raises(FinanceError) as caught:
        ingest(layout, "syn", mp, src)
    text = " ".join([str(caught.value)] + caught.value.reasons)
    assert "NoSuchTotal" in text and "matched nothing" in text
