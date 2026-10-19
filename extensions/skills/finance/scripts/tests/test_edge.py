"""P10 edge pipeline wiring. Bars are SYNTHETIC, pre-seeded into the market cache; no network."""
from __future__ import annotations

import json
import random
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from finance_core import edge  # noqa: E402
from finance_core.errors import FinanceError  # noqa: E402
from finance_core.layout import Layout  # noqa: E402

SYMBOLS = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH", "III", "JJJ", "KKK", "LLL"]


def seed(layout: Layout, breakout: bool) -> None:
    """260 weekdays of SYNTHETIC random-walk bars; with `breakout`, AAA-CCC gap up on huge volume."""
    random.seed(7)
    days, d = [], date(2025, 6, 2)
    while len(days) < 260:
        if d.weekday() < 5:
            days.append(d)
        d += timedelta(days=1)
    market = layout.base / "market"
    market.mkdir(parents=True, exist_ok=True)
    for n, sym in enumerate(SYMBOLS):
        price, bars = 50 + n * 7, []
        for i, day in enumerate(days):
            o = price
            price *= 1 + random.gauss(0.0005, 0.01)
            high, low, vol = max(o, price) * 1.004, min(o, price) * 0.996, 1_500_000 + random.randint(-200_000, 200_000)
            if breakout and sym in ("AAA", "BBB", "CCC") and i == len(days) - 1:
                o = price
                price *= 1.09
                high, low, vol = price * 1.01, o * 0.995, 9_000_000
            bars.append({"date": day.isoformat(), "open": f"{o:.4f}", "high": f"{high:.4f}", "low": f"{low:.4f}",
                         "close": f"{price:.4f}", "adj_close": f"{price:.4f}", "volume": vol})
        record = {"symbol": sym, "range": "1y", "bars": bars, "provider": "synthetic", "adjusted": False,
                  "source": "synthetic", "currency": "USD", "name": sym, "dividends": [], "splits": [],
                  "fetched_at": datetime.now(timezone.utc).isoformat()}
        (market / f"{sym}.json").write_text(json.dumps(record), encoding="utf-8")


def test_pipeline_runs_through_every_stage_on_a_universe_with_candidates(tmp_path):
    pytest.importorskip("pandas")
    pytest.importorskip("pyarrow")
    layout = Layout(tmp_path)
    seed(layout, breakout=True)
    result = edge.run_edge(layout, SYMBOLS)
    manifest = json.loads(Path(result["manifest"]).read_text(encoding="utf-8"))
    assert result["input"]["symbols"] == 12 and result["input"]["rows"] == 12 * 260
    assert (Path(result["output_dir"]) / "tickets").is_dir()
    assert manifest  # sibling edge-* scripts were all located and chained
    assert list((Path(result["output_dir"]) / "drafts").glob("*.yaml"))
    assert result["adjusted_prices"] is False and result["warnings"][0]["symbols"] == SYMBOLS


def test_empty_detection_is_a_clean_result_not_an_error(tmp_path):
    pytest.importorskip("pandas")
    pytest.importorskip("pyarrow")
    layout = Layout(tmp_path)
    seed(layout, breakout=False)
    result = edge.run_edge(layout, SYMBOLS)
    assert result["candidates"] == 0 and "no edge candidates" in result["note"]
    assert result["warnings"] and result["adjusted_prices"] is False


def test_fewer_than_three_symbols_is_refused(tmp_path):
    with pytest.raises(FinanceError, match="at least 3"):
        edge.run_edge(Layout(tmp_path), ["AAA", "BBB"])


def test_missing_pandas_names_the_install_command(tmp_path, monkeypatch):
    stub = tmp_path / "no_pandas.py"
    stub.write_text("import sys\nsys.stderr.write('missing pandas: python3 -m pip install pandas pyarrow\\n')\nsys.exit(3)\n")
    monkeypatch.setattr(edge, "CONVERTER", stub)
    layout = Layout(tmp_path)
    seed(layout, breakout=False)
    with pytest.raises(FinanceError, match="could not write the OHLCV parquet") as caught:
        edge.write_ohlcv(layout, SYMBOLS, "1y", tmp_path / "x.parquet")
    assert any("pip install pandas pyarrow" in r for r in caught.value.reasons)
