#!/usr/bin/env python3
"""
audit_memrefactor.py — phase-cumulative reality audit for the memory-refactor plan.

Mirror of .workflow/plans/permission-enforcement/scripts/audit_c6.py:
  --phase baseline|layout|extraction|routing|final
Each phase runs its own checks PLUS all prior phases. Exit code == failure count.
READ-ONLY: a failing check is fixed in SOURCE, never by weakening the check here.

The executor of each `audit-*` state FILLS IN that phase's checks (one check per
slug-keyed acceptance criterion in the corresponding context file). This scaffold
provides the phase dispatch, the cumulative ordering, the check harness, and a worked
example per phase so the structure is unambiguous.

Run from the repo root:
  python3 docs/plan/memory-refactor/scripts/audit_memrefactor.py --phase layout
"""
from __future__ import annotations
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]   # …/scripts → memory-refactor → plan → docs → REPO
PLAN = Path(__file__).resolve().parents[1]    # docs/plan/memory-refactor
BASELINE = PLAN / "baseline"

FAILURES: list[str] = []
PASSES: list[str] = []


def check(cid: str, ok: bool, detail: str = "") -> None:
    """Record a slug-keyed acceptance check."""
    if ok:
        PASSES.append(cid)
        print(f"  PASS  [{cid}] {detail}".rstrip())
    else:
        FAILURES.append(cid)
        print(f"  FAIL  [{cid}] {detail}".rstrip())


def run(cmd: list[str], cwd: Path = REPO) -> tuple[int, str]:
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=900)
        return p.returncode, (p.stdout + p.stderr)
    except Exception as e:  # noqa: BLE001
        return 1, str(e)


def read_json(path: Path):
    try:
        return json.loads(path.read_text())
    except Exception:  # noqa: BLE001
        return None


# ── phase: baseline ───────────────────────────────────────────────────────────
def phase_baseline() -> None:
    print("\n=== phase: baseline ===")
    snap = read_json(BASELINE / "tool-snapshot.json")
    tools = (snap or {}).get("tools", []) if isinstance(snap, dict) else []
    check("p0-baseline.3", isinstance(tools, list) and len(tools) == 19
          and all(t.get("inputSchema") for t in tools),
          f"tool-snapshot has {len(tools)} tools")
    check("p0-baseline.4",
          run(["node", str(PLAN / "scripts" / "space_invariant_check.mjs"), "--self-test"])[0] == 0,
          "space_invariant_check --self-test")
    check("p0-baseline.5", (BASELINE / "baseline.md").exists(), "baseline.md captured")
    # [p0-baseline.1]/[.2] are live-server probes — the executor records their result into
    # baseline.md and asserts it here (parse the recorded embed_on_hash_fallback + cosine).


# ── phase: layout ─────────────────────────────────────────────────────────────
DATA_PKGS = [
    ("embed", "embedding-provider"), ("vectors", "vector-store"),
    ("graph", "graph-store"), ("search", "hybrid-search"),
    ("analysis", "analysis"), ("ingest", "ingest"),
]


def phase_layout() -> None:
    print("\n=== phase: layout ===")
    for group, name in DATA_PKGS:
        pj = REPO / "libs" / "data" / group / name / "package.json"
        j = read_json(pj)
        ok = bool(j) and j.get("name") == f"@adhd/sox-{name}" \
            and (j.get("sox", {}).get("area") == "data") \
            and (j.get("sox", {}).get("group") == group)
        check("p1-layout.1", ok, f"data/{group}/{name} package.json + sox.*")
    eslint = (REPO / "eslint.config.js").read_text() if (REPO / "eslint.config.js").exists() else ""
    check("p1-layout.3", "area:data" in eslint and "area:platform" in eslint and "area:shared" in eslint,
          "three area depConstraints present")
    # [p1-layout.2] nx build each; [p1-layout.5] synthetic-boundary lint; [p1-layout.6]
    # run-many build,lint — the executor wires these as run([...]) checks.


# ── phase: extraction ─────────────────────────────────────────────────────────
def phase_extraction() -> None:
    print("\n=== phase: extraction ===")
    # [w2e.2] memory-enrich dissolved
    rc, _ = run(["grep", "-rl", "@adhd/sox-memory-enrich", "--include=*.ts",
                 "libs", "apps", "extensions", "packages"])
    check("w2e.2", rc != 0, "no @adhd/sox-memory-enrich imports remain")
    # [w2b.5] graph-store has no vec_node / vector-store import (built dist)
    gdist = REPO / "libs/data/graph/graph-store/dist/index.js"
    if gdist.exists():
        s = gdist.read_text()
        check("w2b.5", "vec_node" not in s and "sox-vector-store" not in s,
              "graph-store clean of vec/vector-store")
    # [w2c.6] vector-store has no graph-store import (built dist)
    vdist = REPO / "libs/data/vectors/vector-store/dist/index.js"
    if vdist.exists():
        check("w2c.6", "sox-graph-store" not in vdist.read_text(),
              "vector-store clean of graph-store")
    # [w2e.3] tool-contract diff vs baseline — the executor spawns the rebuilt server,
    # captures tools/list, and diffs names+inputSchemas against baseline/tool-snapshot.json.


# ── phase: routing ────────────────────────────────────────────────────────────
def phase_routing() -> None:
    print("\n=== phase: routing ===")
    check("p4-routing.1",
          (REPO / "docs/routing/map.json").exists() and (REPO / "docs/routing/INDEX.md").exists(),
          "routing map.json + INDEX.md generated")
    check("p4-routing.4", (REPO / "docs/routing/ROUTER.md").exists(), "ROUTER.md present")
    # [p4-routing.2] drift gate (synthetic edit → check-drift fails → regenerate passes):
    # the executor performs this in a sandbox and asserts the gate bit.


# ── phase: final ──────────────────────────────────────────────────────────────
def phase_final() -> None:
    print("\n=== phase: final ===")
    # Reality: spawn the real built memory-server, tools/list diff-clean vs baseline,
    # real write→recall ranked by real vectors, cosine-sanity, degrade-to-BM25, reembed
    # dry-run on a memory.db copy, then the whole-repo gate. The executor implements these
    # as live subprocess probes ([audit-final.1]-[.3]); this scaffold leaves those slots
    # explicit and wires the standalone-consumption guard now.
    print("  (server/vector/degrade/reembed reality checks implemented by the executor)")
    # [audit-final.5] standalone-consumption — the affirmative BL-87/F1 guard.
    # Requires `nx run-many -t build` first so each data/* dist/ exists (BL-4).
    rc, out = run(["node", str(PLAN / "scripts" / "pack-smoke.mjs")])
    check("audit-final.5", rc == 0,
          "pack-smoke: each public data/* installs from its tarball + exercises standalone")
    if rc != 0:
        for line in out.splitlines():
            if "FAIL" in line or "BL-87" in line:
                print("    " + line.strip())


PHASES = ["baseline", "layout", "extraction", "routing", "final"]
RUNNERS = {
    "baseline": phase_baseline, "layout": phase_layout,
    "extraction": phase_extraction, "routing": phase_routing, "final": phase_final,
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", required=True, choices=PHASES)
    args = ap.parse_args()
    for ph in PHASES[: PHASES.index(args.phase) + 1]:
        RUNNERS[ph]()
    print(f"\n=== audit --phase {args.phase}: {len(PASSES)} pass, {len(FAILURES)} fail ===")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
    return len(FAILURES)


if __name__ == "__main__":
    sys.exit(main())
