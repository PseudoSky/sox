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
from .marketdata import UNADJUSTED_WARNING, get_bars, unadjusted_symbols

SKILL_ROOT = Path(__file__).resolve().parents[2]
CONVERTER = SKILL_ROOT / "scripts" / "edge_support" / "to_parquet.py"
ORCHESTRATOR = SKILL_ROOT / "sources" / "edge-pipeline-orchestrator" / "scripts" / "orchestrate_edge_pipeline.py"
TIMEOUT_SECONDS = 900
MIN_SYMBOLS = 3
MIN_BARS_FOR_REGIME = 200  # the regime filter needs a 200-day average
NO_TICKETS = "no valid ticket files found"


def write_ohlcv(layout: Layout, symbols: list[str], range_: str, dest: Path) -> dict[str, Any]:
    """Write the cached bars of `symbols` as the pipeline's long-format OHLCV parquet."""
    rows: list[dict[str, Any]] = []
    providers: set[str] = set()
    counts: dict[str, int] = {}
    for symbol in symbols:
        record = get_bars(layout, symbol, range_)
        providers.add(record["provider"])
        counts[record["symbol"]] = len(record["bars"])
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
    short = sorted(s for s, n in counts.items() if n < MIN_BARS_FOR_REGIME)
    return {"rows": written["rows"], "symbols": len(symbols), "providers": sorted(providers),
            "short_history": short,
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
    flagged = unadjusted_symbols(layout, symbols)
    warnings = [{"symbols": flagged, "warning": UNADJUSTED_WARNING}] if flagged else []
    if summary["short_history"]:
        warnings.append({"symbols": summary["short_history"],
                         "warning": f"fewer than {MIN_BARS_FOR_REGIME} bars: the pipeline drops these from its universe; "
                                    "use --range 2y or longer"})
    tickets_manifest = out_dir / "pipeline" / "tickets" / "run_manifest.json"
    if done.returncode != 0 and NO_TICKETS in (done.stderr + done.stdout) and tickets_manifest.is_file():
        found = json.loads(tickets_manifest.read_text(encoding="utf-8"))
        return {"output_dir": str(out_dir / "pipeline"), "dry_run": dry_run, "input": summary,
                "candidates": 0, "warnings": warnings, "adjusted_prices": not flagged, "regime": found.get("regime"), "as_of": found.get("as_of"),
                "note": "detection ran and found no edge candidates in this universe; that is a valid result",
                "drafts": [], "notes": ["No candidates, so no drafts were written. tickets/anomalies.json (if present) lists "
                                        "single-symbol outliers, which are observations and not edge candidates."],
                "report": str(out_dir / "pipeline" / "tickets" / "daily_report.md")}
    if done.returncode != 0:
        raise FinanceError(f"edge: orchestrator exited {done.returncode}", (done.stderr or done.stdout).strip().splitlines()[-8:])
    manifest_path = out_dir / "pipeline" / "pipeline_run_manifest.json"
    if not manifest_path.is_file():
        raise FinanceError("edge: pipeline_run_manifest.json not written")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    stages = manifest.get("stages", {})
    review, export = stages.get("review_loop", {}), stages.get("export", {})
    not_exportable = export.get("skipped_not_eligible", [])
    drafts = sorted(str(p) for p in (out_dir / "pipeline" / "drafts").glob("*.yaml"))
    notes = ["The pipeline's universe_count can be smaller than the symbols passed: it keeps only symbols with a 200-day "
             "average, a price above its minimum and enough average volume. Optional news and futures modules need "
             "inputs this skill does not supply and are skipped.",
             "tickets/anomalies.json lists statistical outliers (for example gap z-scores). They are observations "
             "about single symbols, not trade signals and not edge candidates."]
    if drafts:
        notes.append("Draft conditions are the concept's observed values after the review loop rounds them "
                     "(one significant figure below 1). They are single observations, not fitted thresholds: open "
                     "each draft and check its conditions before backtesting it in P7.")
    return {"output_dir": str(out_dir / "pipeline"), "manifest": str(manifest_path), "dry_run": dry_run, "warnings": warnings,
            "drafts": drafts, "notes": notes,
            "review": {"passed": review.get("passed_count", 0), "rejected": review.get("rejected_count", 0),
                       "downgraded": review.get("downgraded_count", 0), "export_status": export.get("status"), "export_listed": len(export.get("exported", [])),
                       "not_export_eligible": not_exportable,
                       "meaning": "passed means the draft survived review; only export-eligible drafts can be exported. "
                                  "A passed draft that is not export-eligible is a research hypothesis: backtest it in P7 first."},
            "input": summary, "adjusted_prices": not flagged,
            "manifest_summary": {k: manifest[k] for k in manifest if k in ("status", "stages", "summary", "counts")}}
