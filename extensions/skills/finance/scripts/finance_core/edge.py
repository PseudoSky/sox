"""Run the harvested edge research pipeline (P10) on bars from the market-data capability.

The pipeline reads an OHLCV parquet, so this step needs pandas and pyarrow. They load only in the
`edge_support/to_parquet.py` subprocess, keeping the core stdlib-only; a missing dependency is
reported with the install command, never skipped.
"""
from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .errors import FinanceError
from .layout import Layout
from .marketdata import get_bars

SKILL_ROOT = Path(__file__).resolve().parents[2]
CONVERTER = SKILL_ROOT / "scripts" / "edge_support" / "to_parquet.py"
ORCHESTRATOR = SKILL_ROOT / "sources" / "edge-pipeline-orchestrator" / "scripts" / "orchestrate_edge_pipeline.py"
TIMEOUT_SECONDS = 900
MIN_SYMBOLS = 3
NO_TICKETS = "no valid ticket files found"


def write_ohlcv(layout: Layout, symbols: list[str], range_: str, dest: Path) -> dict[str, Any]:
    """Write the cached bars of `symbols` as the pipeline's long-format OHLCV parquet."""
    rows: list[dict[str, Any]] = []
    providers: set[str] = set()
    for symbol in symbols:
        record = get_bars(layout, symbol, range_)
        providers.add(record["provider"])
        for bar in record["bars"]:
            rows.append({"symbol": record["symbol"], "timestamp": bar["date"],
                         "open": float(bar["open"]), "high": float(bar["high"]),
                         "low": float(bar["low"]), "close": float(bar["close"]),
                         "volume": float(bar["volume"])})
    source = dest.with_suffix(".json")
    source.write_text(json.dumps(rows), encoding="utf-8")
    done = subprocess.run([sys.executable, "-I", str(CONVERTER), str(source), str(dest)],
                          capture_output=True, text=True, timeout=TIMEOUT_SECONDS, check=False)
    source.unlink(missing_ok=True)
    if done.returncode != 0:
        raise FinanceError("edge: could not write the OHLCV parquet", (done.stderr or done.stdout).strip().splitlines()[-3:])
    written = json.loads(done.stdout)
    return {"rows": written["rows"], "symbols": len(symbols), "providers": sorted(providers),
            "first": written["first"], "last": written["last"]}


def run_edge(layout: Layout, symbols: list[str], range_: str = "1y", dry_run: bool = True,
             as_of: str | None = None) -> dict[str, Any]:
    if len(symbols) < MIN_SYMBOLS:
        raise FinanceError(f"edge: needs at least {MIN_SYMBOLS} symbols; cross-sectional detection has no peer group below that")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = layout.base / "edge" / stamp
    out_dir.mkdir(parents=True, exist_ok=True)
    layout.ensure_base()
    ohlcv = out_dir / "ohlcv.parquet"
    summary = write_ohlcv(layout, symbols, range_, ohlcv)
    cmd = [sys.executable, "-I", str(ORCHESTRATOR), "--from-ohlcv", str(ohlcv), "--output-dir", str(out_dir / "pipeline")]
    if as_of:
        cmd += ["--as-of", as_of]
    if dry_run:
        cmd.append("--dry-run")
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT_SECONDS, check=False)
    except subprocess.TimeoutExpired as exc:
        raise FinanceError(f"edge: timed out after {TIMEOUT_SECONDS}s") from exc
    tickets_manifest = out_dir / "pipeline" / "tickets" / "run_manifest.json"
    if done.returncode != 0 and NO_TICKETS in (done.stderr + done.stdout) and tickets_manifest.is_file():
        found = json.loads(tickets_manifest.read_text(encoding="utf-8"))
        return {"output_dir": str(out_dir / "pipeline"), "dry_run": dry_run, "input": summary,
                "candidates": 0, "regime": found.get("regime"), "as_of": found.get("as_of"),
                "note": "detection ran and found no edge candidates in this universe; add symbols or widen the range",
                "report": str(out_dir / "pipeline" / "tickets" / "daily_report.md")}
    if done.returncode != 0:
        raise FinanceError(f"edge: orchestrator exited {done.returncode}", (done.stderr or done.stdout).strip().splitlines()[-8:])
    manifest_path = out_dir / "pipeline" / "pipeline_run_manifest.json"
    if not manifest_path.is_file():
        raise FinanceError("edge: pipeline_run_manifest.json not written")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    return {"output_dir": str(out_dir / "pipeline"), "manifest": str(manifest_path), "dry_run": dry_run,
            "input": summary, "adjusted_prices": False not in summary["providers"] and "nasdaq" not in summary["providers"],
            "manifest_summary": {k: manifest[k] for k in manifest if k in ("status", "stages", "summary", "counts")}}
