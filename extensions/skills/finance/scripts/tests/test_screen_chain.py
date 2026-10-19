"""Screener -> planner -> stored plan chain. All data is SYNTHETIC; no network, no key."""
from __future__ import annotations

import json
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from finance_core import accounts, plans, screen  # noqa: E402
from finance_core.cli import main  # noqa: E402
from finance_core.errors import FinanceError  # noqa: E402
from finance_core.inlet import ingest  # noqa: E402
from finance_core.layout import Layout, atomic_write_json  # noqa: E402

EXPORT = ("SYNTHETIC export. Not real data.\nAs of 10/16/2026\nAccount: SYN-0000-7777\n"
          "Symbol,Asset Type,Quantity,Last Price\nAAA,Stock,100,50.00\n")
MAPPING = {
    "schema_version": 0, "broker_label": "synthetic", "format": "csv", "header_line": 4,
    "as_of": {"regex": r"As of (\d{2}/\d{2}/\d{4})", "group": 1}, "as_of_format": "%m/%d/%Y",
    "cash": {"value": "95000.00"}, "account_number": {"regex": r"Account: (\S+)", "group": 1},
    "control_total": {"value": "100000.00"},
    "fields": {"symbol": {"column": "Symbol"}, "quantity": {"column": "Quantity"},
               "last_price": {"column": "Last Price"}, "asset_type": {"column": "Asset Type"}},
    "asset_type_map": {"Stock": "equity"},
}


def candidate(symbol="PRE", price=98.0, pivot=100.0, last_low=95.0):
    return {
        "symbol": symbol, "company_name": f"{symbol} Inc.", "sector": "Technology", "price": price,
        "market_cap": 50_000_000_000, "composite_score": 85.0, "rating": "Strong VCP",
        "execution_state": "Pre-breakout", "valid_vcp": True, "entry_ready": False,
        "vcp_pattern": {"pivot_price": pivot, "atr_value": 2.5, "contractions": [
            {"label": "T1", "high_price": 105.0, "low_price": 92.0, "depth_pct": 12.4},
            {"label": "T2", "high_price": pivot, "low_price": last_low, "depth_pct": 5.0}]},
        "volume_pattern": {"breakout_volume_detected": False, "avg_volume_50d": 1_000_000, "dry_up_ratio": 0.5},
        "pivot_proximity": {"stop_loss_price": last_low * 0.99, "risk_pct": 5.0, "distance_from_pivot_pct": -2.0},
        "trend_template": {"score": 100}, "relative_strength": {"rs_percentile": 80},
    }


def screen_file(root: Path, results) -> Path:
    path = root / "screen.json"
    path.write_text(json.dumps({"schema_version": "1.0", "metadata": {"generated_at": "2026-10-16 12:00:00"},
                                "results": results, "summary": {"total": len(results)},
                                "sector_distribution": {}}))
    return path


@pytest.fixture
def env(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    layout = Layout(root)
    accounts.create_account(layout, "syn", "USD", account_mask="7777")
    src, mp = tmp_path / "e.csv", tmp_path / "m.json"
    src.write_text(EXPORT)
    mp.write_text(json.dumps(MAPPING))
    ingest(layout, "syn", mp, src)
    return layout, root


def test_planner_output_becomes_stored_plan(env):
    layout, root = env
    planner = screen.run_planner(layout, screen_file(root, [candidate()]), "100000.00")
    assert planner["result"]["summary"]["actionable_count"] == 1
    built = screen.plans_from_planner(layout, "syn", planner, write=True)
    assert [p["symbol"] for p in built] == ["PRE"]
    stored = plans.list_plans(layout, account_id="syn")
    assert [p["symbol"] for p in stored] == ["PRE"] and stored[0]["plan_id"] == built[0]["plan_id"]


def test_dry_run_translates_without_storing(env):
    layout, root = env
    planner = screen.run_planner(layout, screen_file(root, [candidate()]), "100000.00")
    built = screen.plans_from_planner(layout, "syn", planner, write=False)
    assert len(built) == 1 and plans.list_plans(layout, account_id="syn") == []


def test_non_actionable_candidate_yields_no_plan(env):
    layout, root = env
    invalid = {**candidate("BAD"), "valid_vcp": False}  # the screener did not confirm a pattern
    planner = screen.run_planner(layout, screen_file(root, [invalid]), "100000.00")
    assert planner["result"]["summary"]["rejected_count"] == 1
    assert screen.plans_from_planner(layout, "syn", planner, write=True) == []


def test_planner_failure_surfaces_cause(env):
    layout, root = env
    with pytest.raises(FinanceError) as exc:
        screen.run_planner(layout, root / "missing.json", "100000.00")
    assert "planner: exited" in str(exc.value) and exc.value.reasons


def test_cli_breakout_plan_uses_account_equity(env, capsys):
    layout, root = env
    path = screen_file(root, [candidate()])
    code = main(["--root", str(root), "breakout", "plan", "--account", "syn", "--screen", str(path)])
    out = json.loads(capsys.readouterr().out)
    assert code == 0 and out["account_equity"] == "100000.00" and out["written"] is False
    assert [p["symbol"] for p in out["plans"]] == ["PRE"] and plans.list_plans(layout, account_id="syn") == []


def _seed(layout: Layout, symbol: str, drift: float) -> None:
    random.seed(7)
    price, day, bars = 50.0, datetime(2026, 10, 15, tzinfo=timezone.utc) - timedelta(days=725), []
    while len(bars) < 500:
        day += timedelta(days=1)
        if day.weekday() >= 5:
            continue
        o, price = price, max(1.0, price * (1 + drift + random.uniform(-0.012, 0.012)))
        bars.append({"date": day.strftime("%Y-%m-%d"), "open": f"{o:.4f}", "high": f"{max(o, price) * 1.004:.4f}",
                     "low": f"{min(o, price) * 0.996:.4f}", "close": f"{price:.4f}", "adj_close": f"{price:.4f}",
                     "volume": 2_000_000})
    atomic_write_json(layout.base / "market" / f"{symbol}.json", {
        "symbol": symbol, "currency": "USD", "name": f"SYNTHETIC {symbol}", "bars": bars, "dividends": [],
        "splits": [], "range": "2y", "source": "synthetic", "fetched_at": datetime.now(timezone.utc).isoformat()})


def test_real_screener_runs_through_adapter_without_key_or_network(tmp_path):
    layout = Layout(tmp_path)
    layout.ensure_base()
    _seed(layout, "SYN", 0.0035)
    _seed(layout, "SPY", 0.0012)
    result = screen.run_screen(layout, ["SYN"])
    assert result["schema_version"] == "1.0" and Path(result["screen"]).is_file()
    assert result["universe"] == ["SYN"] and result["results"] >= 0 and result["valid_vcp"] <= result["results"]
    assert "fundamentals are not provided" in result["note"]


def test_screen_rejects_bad_symbols_before_spawning(tmp_path):
    with pytest.raises(FinanceError, match="symbol"):
        screen.run_screen(Layout(tmp_path), ["AAPL;rm -rf"])
    with pytest.raises(FinanceError, match="at least one"):
        screen.run_screen(Layout(tmp_path), [])
