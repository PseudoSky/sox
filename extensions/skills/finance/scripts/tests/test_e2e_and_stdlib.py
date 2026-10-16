"""End-to-end flow through the CLI, plus the stdlib-only check.

SYNTHETIC data only: the export, account numbers, prices and plan are invented for this test.
"""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from finance_core.cli import main  # noqa: E402

PKG = Path(__file__).resolve().parents[1] / "finance_core"

EXPORT = """SYNTHETIC brokerage export with a three-line preamble. Not real data.
As of 10/15/2026
Account: SYN-0000-1012
Row Type,Symbol,Quantity,Average Cost,Last Price,Type
Position,AAA,100,40.00,45.50,Stock
Position,BBB,20,100,110.25,ETF
,,,,,
Cash Balance,"$1,000.00",,,,
Total Value,"$7,755.00",,,,
"""

MAPPING = {
    "schema_version": 0, "broker_label": "synthetic-broker", "format": "csv", "header_line": 4,
    "as_of": {"regex": r"As of (\d{2}/\d{2}/\d{4})", "group": 1}, "as_of_format": "%m/%d/%Y",
    "cash": {"regex": r'Cash Balance,"?\$?([-0-9,.()]+)', "group": 1},
    "account_number": {"regex": r"Account: (\S+)", "group": 1},
    "control_total": {"regex": r'Total Value,"?\$?([-0-9,.()]+)', "group": 1},
    "rows": {"row_filter": {"column": "Row Type", "equals": "Position"}},
    "fields": {"symbol": {"column": "Symbol"}, "quantity": {"column": "Quantity"},
               "avg_cost": {"column": "Average Cost"}, "last_price": {"column": "Last Price"},
               "asset_type": {"column": "Type"}, "currency": {"value": "USD"}},
    "asset_type_map": {"Stock": "equity", "ETF": "etf"},
}

ITEM = {"symbol": "CCC", "sector": "Synthetic",
        "trade_plan": {"signal_entry": 52.10, "worst_entry": 52.90, "stop_loss_price": 49.50,
                       "risk_per_share": 2.60, "target_price": 58.80, "shares": 40,
                       "risk_dollars": 104.00, "position_value": 2084.00,
                       "cumulative_risk_pct": 1.2, "binding_constraint": "risk"},
        "plan_valid_for_session": "2026-10-20"}


def _cli(root: Path, *args: str, capsys) -> tuple[int, dict]:
    code = main(["--root", str(root), *args])
    out = capsys.readouterr()
    payload = json.loads(out.out or out.err or "{}")
    return code, payload


def test_end_to_end_flow(tmp_path, capsys):
    export = tmp_path / "exports" / "export.csv"
    export.parent.mkdir()
    export.write_text(EXPORT)
    mapping = tmp_path / "exports" / "map.json"
    mapping.write_text(json.dumps(MAPPING))
    item = tmp_path / "exports" / "item.json"
    item.write_text(json.dumps(ITEM))
    root = tmp_path / "root"
    root.mkdir()

    assert _cli(root, "account", "create", "--account", "syn-main", "--base-currency", "USD",
                "--account-mask", "1012", "--slippage-bps", "5",
                "--commission", '{"per_share":"0.005","per_contract":"0.65"}', capsys=capsys)[0] == 0
    assert _cli(root, "inlet", "ingest", "--account", "syn-main", "--mapping", str(mapping),
                "--source", str(export), capsys=capsys)[0] == 0
    code, placed = _cli(root, "paper", "order", "--account", "syn-main",
                        "--order", '{"symbol":"AAA","side":"sell","qty":"10","type":"market"}',
                        capsys=capsys)
    assert code == 0
    bar = '{"open":"46.00","high":"47.00","low":"45.00","close":"46.50","ts":"2026-10-16T14:30:00Z"}'
    code, fill = _cli(root, "paper", "fill", "--account", "syn-main",
                      "--order-id", placed["order_id"], "--bar", bar, capsys=capsys)
    assert code == 0 and fill["status"] == "filled"
    assert fill["price"] == "45.977000" and fill["fee"] == "0.050"

    code, positions = _cli(root, "paper", "positions", "--account", "syn-main", capsys=capsys)
    assert code == 0
    assert positions["positions"]["AAA"]["qty"] == "90"
    assert positions["cash"] == "1459.720000"

    code, _ = _cli(root, "breakout", "translate", "--account", "syn-main", "--item", str(item),
                   "--plan-id", "syn-plan-1", "--write", capsys=capsys)
    assert code == 0
    code, rep = _cli(root, "report", "--as-of", "2026-10-16", capsys=capsys)
    assert code == 0
    md = Path(rep["md_path"]).read_text()
    headings = [line for line in md.splitlines() if line.startswith("## ")]
    assert headings == sorted(headings, key=lambda h: md.index(h))
    assert len(headings) >= 6


def test_no_shorting_refused_with_exit_2(tmp_path, capsys):
    export = tmp_path / "export.csv"
    export.write_text(EXPORT)
    mapping = tmp_path / "map.json"
    mapping.write_text(json.dumps(MAPPING))
    root = tmp_path / "root"
    root.mkdir()
    _cli(root, "account", "create", "--account", "syn-main", "--base-currency", "USD",
         "--account-mask", "1012", capsys=capsys)
    _cli(root, "inlet", "ingest", "--account", "syn-main", "--mapping", str(mapping),
         "--source", str(export), capsys=capsys)
    code, err = _cli(root, "paper", "order", "--account", "syn-main",
                     "--order", '{"symbol":"ZZZ","side":"sell","qty":"1","type":"market"}',
                     capsys=capsys)
    assert code == 2
    assert "no shorting" in err["error"]


def _stdlib_names() -> set[str]:
    return set(sys.stdlib_module_names)


def test_core_is_stdlib_only():
    allowed = _stdlib_names() | {"finance_core"}
    offenders: list[str] = []
    for path in sorted(PKG.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [a.name.split(".")[0] for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0:
                names = [node.module.split(".")[0]] if node.module else []
            else:
                continue
            for name in names:
                if name not in allowed:
                    offenders.append(f"{path.name}: {name}")
    assert offenders == [], offenders


def test_no_bare_except_in_core():
    offenders = []
    for path in sorted(PKG.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.ExceptHandler) and node.type is None:
                offenders.append(f"{path.name}:{node.lineno}")
    assert offenders == []
