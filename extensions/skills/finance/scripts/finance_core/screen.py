"""Run the harvested VCP screener and breakout planner, keyless, in isolated subprocesses.

The screener's FMPClient is replaced by `YahooFMPAdapter` inside the child process only, so no
harvested source is edited and a crash or memory spike in either tool cannot take down the caller.
"""
from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .breakout import translate_breakout
from .errors import FinanceError
from .layout import Layout
from .marketdata import UNADJUSTED_WARNING, check_symbol, unadjusted_symbols
from .plans import put_plan

SKILL_ROOT = Path(__file__).resolve().parents[2]
VCP_SCRIPTS = SKILL_ROOT / "sources" / "vcp-screener" / "scripts"
PLANNER = SKILL_ROOT / "sources" / "breakout-trade-planner" / "scripts" / "plan_breakout_trades.py"
TIMEOUT_SECONDS = 900

_BOOTSTRAP = """
import json, runpy, sys, types
spec = json.loads(sys.argv[1])
sys.path.insert(0, spec["core_parent"]); sys.path.insert(0, spec["vcp_scripts"])
from finance_core.layout import Layout
from finance_core.marketdata import YahooFMPAdapter
layout = Layout(spec["root"])
stub = types.ModuleType("fmp_client")
stub.FMPClient = lambda api_key=None: YahooFMPAdapter(layout)
sys.modules["fmp_client"] = stub
sys.argv = ["screen_vcp.py"] + spec["args"]
runpy.run_path(spec["vcp_scripts"] + "/screen_vcp.py", run_name="__main__")
"""


def _run(cmd: list[str], what: str) -> str:
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT_SECONDS, check=False)
    except subprocess.TimeoutExpired as exc:
        raise FinanceError(f"{what}: timed out after {TIMEOUT_SECONDS}s") from exc
    if done.returncode != 0:
        tail = (done.stderr or done.stdout).strip().splitlines()[-6:]
        raise FinanceError(f"{what}: exited {done.returncode}", tail)
    return done.stdout


def _reported_path(stdout: str, pattern: str, what: str) -> Path:
    match = re.search(pattern, stdout)
    if not match or not Path(match.group(1).strip()).is_file():
        raise FinanceError(f"{what}: output file not reported")
    return Path(match.group(1).strip())


def run_screen(layout: Layout, symbols: list[str], max_candidates: int = 100, top: int = 20) -> dict[str, Any]:
    symbols = [check_symbol(s) for s in symbols]
    if not symbols:
        raise FinanceError("screen: at least one symbol is required")
    out_dir = layout.base / "market" / "screens"
    out_dir.mkdir(parents=True, exist_ok=True)
    layout.ensure_base()
    spec = {"core_parent": str(Path(__file__).resolve().parents[1]), "vcp_scripts": str(VCP_SCRIPTS),
            "root": str(layout.root),
            "args": ["--universe", *symbols, "--max-candidates", str(max_candidates), "--top", str(top),
                     "--output-dir", str(out_dir)]}
    stdout = _run([sys.executable, "-I", "-c", _BOOTSTRAP, json.dumps(spec)], "screen")
    path = _reported_path(stdout, r"JSON Report:\s+(\S+\.json)", "screen")
    data = json.loads(path.read_text(encoding="utf-8"))
    out = {"screen": str(path), "universe": symbols, "candidates": len(data.get("results", [])),
           "schema_version": data.get("schema_version")}
    flagged = unadjusted_symbols(layout, symbols)
    if flagged:
        out["warnings"] = [{"symbols": flagged, "warning": UNADJUSTED_WARNING}]
    return out


def run_planner(layout: Layout, screen_path: str | Path, account_size: str, risk_pct: str = "0.5") -> dict[str, Any]:
    out_dir = layout.base / "market" / "plans"
    out_dir.mkdir(parents=True, exist_ok=True)
    layout.ensure_base()
    stdout = _run([sys.executable, "-I", str(PLANNER), "--input", str(screen_path),
                   "--account-size", str(account_size), "--risk-pct", str(risk_pct),
                   "--output-dir", str(out_dir)], "planner")
    path = _reported_path(stdout, r"JSON plan saved to:\s+(\S+\.json)", "planner")
    return {"planner_output": str(path), "result": json.loads(path.read_text(encoding="utf-8"))}


def plans_from_planner(layout: Layout, account_id: str, planner: dict[str, Any], write: bool = False) -> list[dict[str, Any]]:
    """Translate each actionable order into a plan v0. Stored only when write is True."""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    out = []
    for item in planner["result"].get("actionable_orders", []):
        canonical = json.dumps(item, sort_keys=True, separators=(",", ":"))
        plan_id = f"{item['symbol'].lower()}-breakout-{stamp}"
        plan = translate_breakout(item, account_id, plan_id, hashlib.sha256(canonical.encode()).hexdigest())
        if write:
            put_plan(layout, plan)
        out.append(plan)
    return out
