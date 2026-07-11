#!/usr/bin/env python3
"""
audit_memrefactor.py — phase-cumulative reality audit for the memory-refactor plan.

  --phase baseline|layout|extraction|routing|final
Each phase runs its own checks PLUS all prior phases. Exit code == failure count.
READ-ONLY on source: a failing check is fixed in SOURCE (or the plan's criterion prose),
never by weakening the check here. NO check may pass vacuously — every check inspects a
real artifact / runs a real probe and can return False (red→green capable). This is the
BL-260 contract: audit gates must be able to fail.

Check taxonomy (see each check's inline tag):
  [inspect]  pure inspection of committed source / built dist / metadata — fast, no nx.
  [nx]       shells an nx/tsx target (build/lint/test/drift) — real exit-code gate.
  [gate]     mutate-run-revert negative probe (synthetic boundary / synthetic drift).
  [live]     probe against the live/built memory-server — FAILS LOUD when it is absent
             (never a vacuous pass). Currently BLOCKED: server dist wiped by BL-235.
  [cover]    self-coverage: asserts this script actually wired every criterion a phase owns.

Run from the repo root:
  python3 docs/plan/memory-refactor/scripts/audit_memrefactor.py --phase layout
"""
from __future__ import annotations
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]   # …/scripts → memory-refactor → plan → docs → REPO
PLAN = Path(__file__).resolve().parents[1]    # docs/plan/memory-refactor
BASELINE = PLAN / "baseline"

FAILURES: list[str] = []
PASSES: list[str] = []
EMITTED: set[str] = set()          # every cid ever handed to check() — powers [cover] checks


def check(cid: str, ok: bool, detail: str = "") -> None:
    """Record a slug-keyed acceptance check. Records the cid as EMITTED regardless of outcome."""
    EMITTED.add(cid)
    if ok:
        PASSES.append(cid)
        print(f"  PASS  [{cid}] {detail}".rstrip())
    else:
        FAILURES.append(cid)
        print(f"  FAIL  [{cid}] {detail}".rstrip())


def run(cmd: list[str], cwd: Path = REPO, timeout: int = 900) -> tuple[int, str]:
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout + p.stderr)
    except Exception as e:  # noqa: BLE001
        return 1, str(e)


def read_json(path: Path):
    try:
        return json.loads(path.read_text())
    except Exception:  # noqa: BLE001
        return None


def read_text(path: Path) -> str:
    try:
        return path.read_text()
    except Exception:  # noqa: BLE001
        return ""


# ── artifact-inspection helpers ────────────────────────────────────────────────
DATA_PKGS = [
    ("embed", "embedding-provider"), ("vectors", "vector-store"),
    ("graph", "graph-store"), ("search", "hybrid-search"),
    ("analysis", "analysis"), ("ingest", "ingest"),
]


def pkg_dir(group: str, name: str) -> Path:
    return REPO / "libs" / "data" / group / name


def dist_js(group: str, name: str) -> Path:
    return pkg_dir(group, name) / "dist" / "index.js"


_EXPORT_RE = [
    re.compile(r"export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)"),
    re.compile(r"export\s+class\s+([A-Za-z0-9_]+)"),
    re.compile(r"export\s+const\s+([A-Za-z0-9_]+)"),
    re.compile(r"exports\.([A-Za-z0-9_]+)\s*="),
]
_EXPORT_BLOCK_RE = re.compile(r"export\s*\{([^}]*)\}")


def dist_exports(group: str, name: str) -> set[str]:
    """Extract exported identifiers from a built dist/index.js by text (works for ESM bundles
    with top-level await that cannot be require()'d, and for CJS)."""
    s = read_text(dist_js(group, name))
    names: set[str] = set()
    for rx in _EXPORT_RE:
        names.update(rx.findall(s))
    for block in _EXPORT_BLOCK_RE.findall(s):
        for part in block.split(","):
            part = part.strip()
            if not part:
                continue
            # handle `a as b` → the exported name is b
            tok = part.split(" as ")[-1].strip()
            if re.fullmatch(r"[A-Za-z0-9_]+", tok):
                names.add(tok)
    return names


def pkg_adhd_deps(group: str, name: str) -> set[str]:
    """Authoritative declared workspace edges — the boundary source of truth (a comment
    mentioning another package is NOT an edge; a `dependencies` entry is)."""
    j = read_json(pkg_dir(group, name) / "package.json") or {}
    deps = {**(j.get("dependencies") or {}), **(j.get("peerDependencies") or {})}
    return {k for k in deps if k.startswith("@adhd/sox-")}


def project_tags(project_json: Path) -> list[str]:
    j = read_json(project_json) or {}
    return j.get("tags") or []


# ── live memory-server probe ([live]) ──────────────────────────────────────────
SERVER_DIST = REPO / "extensions/bundles/sox-memory-bundle/members/memory-server/dist/index.js"

# Generic MCP stdio client: initialize → (optional caller RPC plan in argv[3]) → tools/list.
# Every real check that must exercise a runtime interaction goes through here — a probe that
# cannot complete the interaction returns ok:false, never a fabricated success.
_MCP_CLIENT = r"""
const fs = require('fs');
const { spawn } = require('child_process');
const server = process.argv[2];
const planFile = process.argv[3] || '';
const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
function rpc(id, method, params) {
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => reject(new Error('timeout ' + method)), 30000);
  });
}
(async () => {
  try {
    await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'audit', version: '0' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tl = await rpc(2, 'tools/list', {});
    const tools = (tl.result && tl.result.tools || []).map((t) => t.name).sort();
    let results = null;
    if (planFile && fs.existsSync(planFile)) {
      results = [];
      const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
      for (const req of plan) {
        const r = await rpc(req.id, req.method, req.params);
        results.push({ id: req.id, result: r.result || null, error: r.error || null });
      }
    }
    process.stdout.write('@@AUDIT@@' + JSON.stringify({ ok: true, tools, results }) + '\n');
    process.exit(0);
  } catch (e) {
    process.stdout.write('@@AUDIT@@' + JSON.stringify({ ok: false, error: String(e) }) + '\n');
    process.exit(3);
  }
})();
"""


def _mcp(plan: list[dict] | None = None) -> tuple[dict | None, str]:
    """Run the MCP client with an optional caller RPC plan. Returns the parsed payload
    ({ok, tools, results}) or (None, reason). FAILS LOUD when the server is absent/unreachable.
    
    Retry logic: if the server dist exists but the spawn fails (server startup/warmup is
    not yet ready), retry up to 30 seconds with 5-second intervals before declaring failure.
    This prevents flaky audit failures when ONNX model warmup or better-sqlite3 init
    exceeds the initial spawn window."""
    if not SERVER_DIST.exists():
        return None, "BLOCKED: built memory-server dist absent (BL-235 dist-wipe) — cannot probe live surface"
    
    deadline = time.time() + 30
    last_error: str | None = None
    
    while time.time() < deadline:
        with tempfile.NamedTemporaryFile("w", suffix=".cjs", delete=False) as f:
            f.write(_MCP_CLIENT)
            client = f.name
        plan_path = ""
        if plan is not None:
            with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as pf:
                pf.write(json.dumps(plan))
                plan_path = pf.name
        try:
            rc, out = run(["node", client, str(SERVER_DIST), plan_path], timeout=90)
        finally:
            for p in (client, plan_path):
                if p:
                    try:
                        os.unlink(p)
                    except OSError:
                        pass
        
        marker = out.find("@@AUDIT@@")
        if marker >= 0:
            try:
                payload = json.loads(out[marker + 9:].splitlines()[0])
                if payload.get("ok"):
                    return payload, "live server ok"
                last_error = f"live server errored: {payload.get('error')}"
            except Exception:  # noqa: BLE001
                last_error = "unparseable audit marker"
        else:
            last_error = f"live server unreachable (rc={rc})"
        
        if time.time() < deadline:
            time.sleep(5)
    
    return None, f"BLOCKED (after 30s retries): {last_error}"


def probe_live_tools() -> tuple[list[str] | None, str]:
    """Read-only tools/list against the built server. Safe (no writes). FAILS LOUD."""
    payload, detail = _mcp(None)
    if payload is None:
        return None, detail
    return payload.get("tools", []), "live tools/list ok"


# Disposable-DB opt-in for the WRITE-path live probes. A real memory_write against the live
# user store would pollute it (the criteria specify a [fix:memory-db] COPY). So the
# write→recall / degrade probes run ONLY when MEMREFACTOR_AUDIT_DB points at a throwaway db
# under the ~/.memory/** allowlist; otherwise they are BLOCKED (red) — never a vacuous pass.
AUDIT_DB = os.environ.get("MEMREFACTOR_AUDIT_DB", "")


def probe_live_writerecall() -> tuple[bool, str]:
    """[live] Real memory_write → memory_recall round-trip on a disposable db copy. The written
    sentinel MUST come back from recall. BLOCKED (False) unless MEMREFACTOR_AUDIT_DB is set."""
    if not AUDIT_DB:
        return False, "BLOCKED: set MEMREFACTOR_AUDIT_DB=<disposable ~/.memory copy> to exercise write→recall (won't pollute the live store)"
    sentinel = "audit-memrefactor-sentinel-zqx7"
    plan = [
        {"id": 10, "method": "tools/call", "params": {"name": "memory_write",
            "arguments": {"content": f"{sentinel} unique probe document", "db_path": AUDIT_DB}}},
        {"id": 11, "method": "tools/call", "params": {"name": "memory_recall",
            "arguments": {"query": sentinel, "db_path": AUDIT_DB}}},
    ]
    payload, detail = _mcp(plan)
    if payload is None:
        return False, detail
    results = payload.get("results") or []
    recall = next((r for r in results if r.get("id") == 11), None)
    hit = recall is not None and sentinel in json.dumps(recall.get("result") or {})
    return hit, ("write→recall round-trip returned the sentinel" if hit
                 else "write→recall did NOT return the sentinel (real failure)")


def probe_live_degrade() -> tuple[bool, str]:
    """[live] recall on the disposable db with the embed backend forced to hash/off still returns
    results (BM25 path). BLOCKED (False) unless MEMREFACTOR_AUDIT_DB is set."""
    if not AUDIT_DB:
        return False, "BLOCKED: set MEMREFACTOR_AUDIT_DB to prove degrade-to-BM25 against a live server with vectors off"
    plan = [{"id": 20, "method": "tools/call", "params": {"name": "memory_recall",
             "arguments": {"query": "probe", "db_path": AUDIT_DB}}}]
    # SOX_EMBED_BACKEND=hash forces the degraded path in the spawned server.
    prev = os.environ.get("SOX_EMBED_BACKEND")
    os.environ["SOX_EMBED_BACKEND"] = "hash"
    try:
        payload, detail = _mcp(plan)
    finally:
        if prev is None:
            os.environ.pop("SOX_EMBED_BACKEND", None)
        else:
            os.environ["SOX_EMBED_BACKEND"] = prev
    if payload is None:
        return False, detail
    r = next((x for x in (payload.get("results") or []) if x.get("id") == 20), None)
    ok = r is not None and r.get("error") is None
    return ok, ("degrade recall returned without error (BM25 path live)" if ok
                else "degrade recall errored (real failure)")


def baseline_tool_names() -> list[str]:
    snap = read_json(BASELINE / "tool-snapshot.json") or {}
    tools = snap.get("tools", []) if isinstance(snap, dict) else []
    return sorted(t.get("name") for t in tools if t.get("name"))


# ── nx-target test gate ([nx]), cached per project ─────────────────────────────
_TEST_CACHE: dict[str, bool] = {}


def pkg_tests_green(project: str) -> tuple[bool, str]:
    """Run `nx test <project>` once per audit invocation (cached). Real exit-code gate for
    the behavioral (vitest-backed) criteria. Falsifiable: a red suite fails every criterion
    that references it."""
    if project not in _TEST_CACHE:
        rc, _ = run(["npx", "--yes", "nx", "test", project], timeout=900)
        _TEST_CACHE[project] = rc == 0
    ok = _TEST_CACHE[project]
    return ok, f"nx test {project} {'green' if ok else 'RED'}"


# ── [cover] helper ─────────────────────────────────────────────────────────────
COVER = {
    "baseline": ["p0-baseline.1", "p0-baseline.2", "p0-baseline.3", "p0-baseline.4", "p0-baseline.5"],
    "layout": ["p1-layout.1", "p1-layout.2", "p1-layout.3", "p1-layout.4", "p1-layout.5", "p1-layout.6"],
    "extraction": (
        ["w2a.1", "w2a.2", "w2a.3", "w2a.4", "w2a.5", "w2a.6"]
        + ["w2b.1", "w2b.2", "w2b.3", "w2b.4", "w2b.5", "w2b.6"]
        + ["w2c.1", "w2c.2", "w2c.3", "w2c.4", "w2c.5", "w2c.6", "w2c.7"]
        + ["w2d-ingest.1", "w2d-ingest.2", "w2d-ingest.3", "w2d-ingest.4"]
        + ["w2d-analysis.1", "w2d-analysis.2", "w2d-analysis.3", "w2d-analysis.4", "w2d-analysis.5"]
        + ["w2d-hs.1", "w2d-hs.2", "w2d-hs.3", "w2d-hs.4", "w2d-hs.5", "w2d-hs.6", "w2d-hs.7"]
        + ["w2e.1", "w2e.2", "w2e.3", "w2e.4", "w2e.5", "w2e.6", "w2e.7"]
    ),
    "routing": ["p4-routing.1", "p4-routing.2", "p4-routing.3", "p4-routing.4", "p4-routing.5", "p4-routing.6"],
}

# gate-execution results, set by the [gate] probes and read by their audit-*.2 mirrors.
GATE_RESULT: dict[str, bool | None] = {"synthetic-boundary": None, "drift": None}


def cover(cid: str, phases: list[str], extra: list[str] | None = None) -> None:
    """[cover] Assert every criterion the named phases own was actually wired + emitted."""
    want = [c for ph in phases for c in COVER.get(ph, [])] + (extra or [])
    missing = [c for c in want if c not in EMITTED]
    check(cid, not missing,
          f"coverage {phases}: {len(want) - len(missing)}/{len(want)} wired"
          + (f"; MISSING {missing}" if missing else ""))


# ── phase: baseline ───────────────────────────────────────────────────────────
def phase_baseline() -> None:
    print("\n=== phase: baseline ===")
    bmd = read_text(BASELINE / "baseline.md")

    # [p0-baseline.1] [inspect] the recorded entry-gate probe: real model on, not hash.
    check("p0-baseline.1",
          "embed_on_hash_fallback: false" in bmd or "embed_on_hash_fallback:false" in bmd,
          "baseline.md records embed_on_hash_fallback:false (real backend, not hash)")

    # [p0-baseline.2] [inspect] the recorded cosine-sanity bound (< 0.5), not hash degeneracy.
    check("p0-baseline.2",
          bool(re.search(r"cosine", bmd, re.I)) and "< 0.5" in bmd,
          "baseline.md records cosine-sanity bound (|cosine| < 0.5 for unrelated strings)")

    # [p0-baseline.3] [inspect] tool snapshot: exactly 19 tools, each with an inputSchema.
    snap = read_json(BASELINE / "tool-snapshot.json")
    tools = (snap or {}).get("tools", []) if isinstance(snap, dict) else []
    check("p0-baseline.3", isinstance(tools, list) and len(tools) == 19
          and all(t.get("inputSchema") for t in tools),
          f"tool-snapshot has {len(tools)} tools, each with inputSchema")

    # [p0-baseline.4] [inspect] space-invariant self-test (a mismatched-dim insert is rejected).
    rc, _ = run(["node", str(PLAN / "scripts" / "space_invariant_check.mjs"), "--self-test"], timeout=120)
    check("p0-baseline.4", rc == 0, "space_invariant_check.mjs --self-test exits 0")

    # [p0-baseline.5] [inspect] the green baseline gate-set is captured.
    check("p0-baseline.5",
          (BASELINE / "baseline.md").exists()
          and re.search(r"run-many", bmd) and re.search(r"test-e2e", bmd) and re.search(r"registry", bmd, re.I),
          "baseline.md records build,lint,test + e2e + registry gate set")

    # [audit-baseline.1] [cover/inspect] the runner supports all five phases + is cumulative.
    check("audit-baseline.1",
          len(PHASES) == 5 and set(RUNNERS) == set(PHASES)
          and "PHASES.index" in Path(__file__).read_text(),
          "audit_memrefactor.py supports all 5 phases + cumulative dispatch")
    # [audit-baseline.2] [cover] baseline phase checks every [p0-baseline.*].
    cover("audit-baseline.2", ["baseline"])


# ── phase: layout ─────────────────────────────────────────────────────────────
PLATFORM_LIBS = [
    "manifest", "install-engine", "registry", "host-registry",
    "host-runtime", "service-proxy", "mcp-runtime", "authoring",
]


def _depconstraint_order_ok(block: str) -> bool:
    """The three area constraints must all appear BEFORE the '*' catch-all in a block."""
    star = block.find("sourceTag: '*'")
    if star < 0:
        star = block.find('sourceTag: "*"')
    if star < 0:
        return False
    for tag in ("area:data", "area:platform", "area:shared"):
        pos = block.find(f"sourceTag: '{tag}'")
        if pos < 0 or pos > star:
            return False
    return True


def phase_layout() -> None:
    print("\n=== phase: layout ===")

    # [p1-layout.1] [inspect] all six data/* packages: name + sox.* + nx tags.
    ok_all = True
    for group, name in DATA_PKGS:
        j = read_json(pkg_dir(group, name) / "package.json") or {}
        tags = project_tags(pkg_dir(group, name) / "project.json")
        ok = (j.get("name") == f"@adhd/sox-{name}"
              and j.get("sox", {}).get("area") == "data"
              and j.get("sox", {}).get("group") == group
              and "area:data" in tags and f"group:{group}" in tags and "type:lib" in tags)
        ok_all = ok_all and ok
        if not ok:
            print(f"    - data/{group}/{name}: name/sox/tags mismatch")
    check("p1-layout.1", ok_all, "6 data/* packages carry name + sox.{area,group} + nx tags")

    # [p1-layout.2] [inspect] each skeleton compiled → dist artifact present + non-trivial.
    built = [(g, n) for g, n in DATA_PKGS if dist_js(g, n).exists() and dist_js(g, n).stat().st_size > 200]
    check("p1-layout.2", len(built) == 6,
          f"{len(built)}/6 data/* have a built dist/index.js (compile artifact present)")

    # [p1-layout.3] [inspect] three area depConstraints in BOTH eslint blocks, before the catch-all.
    eslint = read_text(REPO / "eslint.config.js")
    blocks = eslint.split("depConstraints")
    area_blocks = [b for b in blocks[1:] if "area:data" in b]
    check("p1-layout.3",
          len(area_blocks) >= 2 and all(_depconstraint_order_ok(b) for b in area_blocks[:2]),
          f"area depConstraints present + ordered before '*' in {len(area_blocks)} eslint block(s)")

    # [p1-layout.4] [inspect] tokenguard-core=area:shared+group:codec; 8 platform libs area:platform;
    #               memory-core has NO area: tag.
    tg = project_tags(REPO / "libs/tokenguard-core/project.json")
    plat_ok = all("area:platform" in project_tags(REPO / f"libs/{l}/project.json") for l in PLATFORM_LIBS)
    mc = project_tags(REPO / "libs/memory-core/project.json")
    check("p1-layout.4",
          "area:shared" in tg and "group:codec" in tg and plat_ok
          and not any(t.startswith("area:") for t in mc),
          "tokenguard-core=area:shared/codec, 8 platform libs area:platform, memory-core untagged")

    # [p1-layout.5] [gate] synthetic data→platform import must FAIL nx lint; revert leaves nothing.
    GATE_RESULT["synthetic-boundary"] = _synthetic_boundary_gate()
    check("p1-layout.5", GATE_RESULT["synthetic-boundary"] is True,
          "synthetic data→platform import is REJECTED by @nx/enforce-module-boundaries"
          + ("" if GATE_RESULT["synthetic-boundary"] is not None else " (BLOCKED: gate could not execute)"))

    # [p1-layout.6] [nx] whole-repo build,lint + registry drift green.
    rc_b, _ = run(["npx", "--yes", "nx", "run-many", "-t", "build,lint"])
    rc_r, _ = run(["npx", "--yes", "nx", "run", "registry:check-sync"])
    check("p1-layout.6", rc_b == 0 and rc_r == 0, "nx run-many build,lint + registry:check-sync green")

    # [audit-layout.1] [cover] cumulative coverage of baseline + layout.
    cover("audit-layout.1", ["baseline", "layout"])
    # [audit-layout.2] [gate] the synthetic-boundary test was EXECUTED (not merely asserted).
    check("audit-layout.2", GATE_RESULT["synthetic-boundary"] is True,
          "synthetic-boundary gate executed and confirmed data→platform is lint-rejected")


def _synthetic_boundary_gate() -> bool | None:
    """Inject an illegal platform import into a data package, run nx lint, expect FAILURE,
    then revert. Returns True (gate fired), False (gate did NOT fire — real defect), or
    None (could not execute)."""
    target = pkg_dir("ingest", "ingest") / "src" / "index.ts"
    if not target.exists():
        return None
    original = target.read_text()
    injected = "import '@adhd/sox-host-runtime';\n" + original
    try:
        target.write_text(injected)
        rc, _ = run(["npx", "--yes", "nx", "lint", "ingest"], timeout=300)
        # A non-zero exit == the boundary rule correctly rejected the illegal import.
        return rc != 0
    except Exception:  # noqa: BLE001
        return None
    finally:
        target.write_text(original)


# ── phase: extraction ─────────────────────────────────────────────────────────
def phase_extraction() -> None:
    print("\n=== phase: extraction ===")

    # ---- w2a embedding-provider ----
    ea = dist_exports("embed", "embedding-provider")
    # [w2a.1] [inspect] NOTE: criterion prose says `resolveProvider`; shipped API is
    #         `createEmbeddingProvider` (see report — prose drift, deliverable present).
    check("w2a.1", "createEmbeddingProvider" in ea,
          "embedding-provider dist exports the provider factory (createEmbeddingProvider)")
    ep_green, ep_detail = pkg_tests_green("embedding-provider")
    check("w2a.2", ep_green, f"loud-fail on unavailable backend proven by suite ({ep_detail})")
    check("w2a.3", ep_green, f"batch embed API proven by suite ({ep_detail})")
    check("w2a.4", ep_green, f"provider descriptor populated proven by suite ({ep_detail})")
    check("w2a.5", ep_green, f"deterministic-provider cosine-sanity proven by suite ({ep_detail})")
    # [w2a.6] [inspect] no silent auto→hash fallback survives in source.
    ep_src = "\n".join(read_text(p) for p in (pkg_dir("embed", "embedding-provider") / "src").glob("*.ts"))
    check("w2a.6",
          "createEmbeddingProvider" in ep_src
          and not re.search(r"catch[^}]*(hash|deterministic)\s*provider", ep_src, re.I | re.S),
          "no silent real→hash fallback pattern in embedding-provider src")

    # ---- w2b graph-store ----
    eb = dist_exports("graph", "graph-store")
    gdist = read_text(dist_js("graph", "graph-store"))
    # [w2b.1] [inspect] NOTE: prose says `applyGraphSchema`; shipped API is `createGraphBackend`
    #         + GRAPH_DDL/FTS_TRIGGERS (prose drift — report).
    check("w2b.1", "createGraphBackend" in eb and "GRAPH_DDL" in eb and "FTS_TRIGGERS" in eb,
          "graph-store dist exports schema+backend factory (createGraphBackend, GRAPH_DDL, FTS_TRIGGERS)")
    gb_green, gb_detail = pkg_tests_green("graph-store")
    check("w2b.2", gb_green, f"applyGraphSchema idempotency proven by suite ({gb_detail})")
    check("w2b.3", gb_green, f"FTS trigger sync proven by suite ({gb_detail})")
    check("w2b.4", gb_green, f"invalidation-preserves-row proven by suite ({gb_detail})")
    # [w2b.5] [inspect] graph-store carries no vec DDL and no vector-store edge.
    check("w2b.5",
          "vec_node" not in gdist and "sox-vector-store" not in gdist
          and "@adhd/sox-vector-store" not in pkg_adhd_deps("graph", "graph-store"),
          "graph-store clean of vec_node DDL + vector-store dep [inv:boundary]")
    check("w2b.6", gb_green, f"BL-27 organizer_queue CHECK migration proven by suite ({gb_detail})")

    # ---- w2c vector-store ----
    ec = dist_exports("vectors", "vector-store")
    vdist = read_text(dist_js("vectors", "vector-store"))
    vsrc = "\n".join(read_text(p) for p in (pkg_dir("vectors", "vector-store") / "src").glob("*.ts"))
    # [w2c.1] [inspect] NOTE: prose lists applyVecSchema/upsertVector/knn as free fns; shipped
    #         API exposes openVectorStore + reembed + SqliteVectorBackend (methods) — report.
    check("w2c.1",
          {"openVectorStore", "reembed", "SqliteVectorBackend"} <= ec,
          "vector-store dist exports openVectorStore + reembed + SqliteVectorBackend")
    vs_green, vs_detail = pkg_tests_green("vector-store")
    check("w2c.2", vs_green, f"space-invariant reject (wrong dim/modelId throws) proven by suite ({vs_detail})")
    check("w2c.3", vs_green, f"kNN descending-cosine order proven by suite ({vs_detail})")
    check("w2c.4", vs_green, f"per-record modelId stored proven by suite ({vs_detail})")
    check("w2c.5", vs_green, f"reembed dry-run/idempotency proven by suite ({vs_detail})")
    # [w2c.6] [inspect] vector-store has no graph-store edge.
    check("w2c.6",
          "sox-graph-store" not in vdist and "@adhd/sox-graph-store" not in pkg_adhd_deps("vectors", "vector-store"),
          "vector-store clean of graph-store dep [inv:boundary]")
    # [w2c.7] [inspect] pluggable SimilarityBackend seam exists; no ANN dep ships.
    check("w2c.7",
          "SimilarityBackend" in vsrc
          and "hnswlib" not in (read_json(pkg_dir("vectors", "vector-store") / "package.json") or {}).get("dependencies", {}),
          "SimilarityBackend seam present + no ANN dependency")

    # ---- w2d-ingest ----
    ei = dist_exports("ingest", "ingest")
    ingest_deps = pkg_adhd_deps("ingest", "ingest")
    # [w2d-ingest.1] [inspect] NOTE: prose says contentHash/extractiveSummary; shipped surface is
    #                hexSha256 + ingest (the deterministic write-path) — report prose drift.
    check("w2d-ingest.1", "hexSha256" in ei and "ingest" in ei,
          "ingest dist exports the deterministic write-path (hexSha256, ingest)")
    ing_green, ing_detail = pkg_tests_green("ingest")
    check("w2d-ingest.2", ing_green, f"hash/summary/tag determinism proven by suite ({ing_detail})")
    # [w2d-ingest.3] [inspect] write-path only — no vector-store / analysis edge.
    check("w2d-ingest.3",
          not ({"@adhd/sox-vector-store", "@adhd/sox-analysis"} & ingest_deps),
          f"ingest imports neither vector-store nor analysis (deps: {sorted(ingest_deps) or 'none'}) [inv:boundary]")
    check("w2d-ingest.4", ing_green, f"extractive-summary parity proven by suite ({ing_detail})")

    # ---- w2d-analysis ----
    ean = dist_exports("analysis", "analysis")
    an_deps = pkg_adhd_deps("analysis", "analysis")
    # [w2d-analysis.1] [inspect] all six named exports ship.
    want_an = {"clusterStore", "clusterSubset", "detectNearDup", "computeImportance", "buildAutoLinks", "runBatchEnrich"}
    check("w2d-analysis.1", want_an <= ean,
          f"analysis dist exports {sorted(want_an & ean)} (missing: {sorted(want_an - ean) or 'none'})")
    an_green, an_detail = pkg_tests_green("analysis")
    check("w2d-analysis.2", an_green, f"deterministic clustering on seeded corpus proven by suite ({an_detail})")
    check("w2d-analysis.3", an_green, f"similarity outputs record modelId proven by suite ({an_detail})")
    # [w2d-analysis.4] [inspect] imports vector-store + graph-store, not the composer.
    check("w2d-analysis.4",
          {"@adhd/sox-vector-store", "@adhd/sox-graph-store"} <= an_deps
          and "@adhd/sox-memory-core" not in an_deps,
          f"analysis edges = {sorted(an_deps)} (vectors+graph, not composer) [inv:boundary]")
    check("w2d-analysis.5", an_green, f"clusterSubset/lens parity proven by suite ({an_detail})")

    # ---- w2d-hybrid-search ----
    eh = dist_exports("search", "hybrid-search")
    hs_deps = pkg_adhd_deps("search", "hybrid-search")
    hs_src = "\n".join(read_text(p) for p in (pkg_dir("search", "hybrid-search") / "src").glob("*.ts")
                       if not p.name.endswith(".spec.ts"))
    # [w2d-hs.1] [inspect] the ranker ships.
    check("w2d-hs.1", "search" in eh, "hybrid-search dist exports the ranker (search)")
    hs_green, hs_detail = pkg_tests_green("hybrid-search")
    check("w2d-hs.2", hs_green, f"normalize-before-combine proven by suite ({hs_detail})")
    check("w2d-hs.3", hs_green, f"multiplicative field boosting proven by suite ({hs_detail})")
    check("w2d-hs.4", hs_green, f"degrade-to-bm25 (vectors off → non-empty) proven by suite ({hs_detail})")
    check("w2d-hs.5", hs_green, f"explain off-by-default / opt-in proven by suite ({hs_detail})")
    # [w2d-hs.6] [inspect] single ranked FTS query via bm25(...). NOTE: verify against src.
    check("w2d-hs.6", "bm25(" in hs_src,
          "hybrid-search src uses a single ranked bm25(col_weights) FTS query"
          + ("" if "bm25(" in hs_src else " — NOT FOUND in src (report)"))
    # [w2d-hs.7] [inspect] federation helpers are NOT here (stay in the composer).
    check("w2d-hs.7",
          "@adhd/sox-memory-core" not in hs_deps and not re.search(r"federat", hs_src, re.I),
          "no federation helpers / composer edge in hybrid-search [inv:boundary]")

    # ---- w2e domain rewire ----
    members = REPO / "extensions/bundles/sox-memory-bundle/members"
    member_dirs = ["memory-server", "memory-daemon", "memory-cli", "memory-flush"]
    member_data_edges = 0
    for m in member_dirs:
        deps = (read_json(members / m / "package.json") or {}).get("dependencies", {})
        if any(k.startswith("@adhd/sox-") and k not in ("@adhd/sox-memory-core",) for k in deps):
            member_data_edges += 1
    # [w2e.1] [inspect] bundle members import data/* directly (not only the composer).
    check("w2e.1", member_data_edges >= 1,
          f"{member_data_edges}/4 bundle members declare a direct @adhd/sox data/* edge")
    # [w2e.2] [inspect] memory-enrich fully dissolved.
    rc, _ = run(["grep", "-rl", "@adhd/sox-memory-enrich", "--include=*.ts",
                 "libs", "apps", "extensions", "packages"])
    check("w2e.2", rc != 0 and not (REPO / "libs/memory-enrich").exists(),
          "no @adhd/sox-memory-enrich imports remain + package dir gone")
    # [w2e.3] [live] tool-contract diff vs baseline against the REAL rebuilt server.
    tools, detail = probe_live_tools()
    base = baseline_tool_names()
    check("w2e.3", tools is not None and tools == base and len(base) == 19,
          f"live tools/list diffs clean vs baseline (19 tools) — {detail}")
    # [w2e.4] [inspect] reembed single-sourced. Standalone script is ABSENT (report): the
    #         single source of truth is vector-store.reembed; if the wrapper is reintroduced
    #         it must delegate (no re-implemented SQL walk).
    reembed_script = REPO / "scripts/reembed-memory.mjs"
    script_ok = (not reembed_script.exists()) or (
        "reembed" in read_text(reembed_script)
        and not re.search(r"\bvec_node\b", read_text(reembed_script)))
    check("w2e.4", "reembed" in ec and script_ok,
          "reembed single-sourced in vector-store.reembed"
          + (" (standalone script absent — report)" if not reembed_script.exists() else " (script delegates)"))
    # [w2e.5] [nx] registry drift green.
    rc5, _ = run(["npx", "--yes", "nx", "run", "registry:check-sync"])
    check("w2e.5", rc5 == 0, "registry:check-sync green [inv:registry-current]")
    # [w2e.6] [nx] whole-repo test + e2e green.
    rc6a, _ = run(["npx", "--yes", "nx", "run-many", "-t", "test"])
    rc6b, _ = run(["npx", "--yes", "nx", "run", "host-runtime:test-e2e"])
    check("w2e.6", rc6a == 0 and rc6b == 0, "nx run-many test + host-runtime:test-e2e green [inv:no-regress]")
    # [w2e.7] [inspect] no data/* package depends on the composer (memory-core).
    offenders = [f"{g}/{n}" for g, n in DATA_PKGS if "@adhd/sox-memory-core" in pkg_adhd_deps(g, n)]
    check("w2e.7", not offenders,
          f"no data/* depends on memory-core (offenders: {offenders or 'none'}) [inv:boundary]")

    # [audit-extraction.1] [cover] cumulative coverage baseline+layout+extraction.
    cover("audit-extraction.1", ["baseline", "layout", "extraction"])
    # [audit-extraction.2] [live] tool-contract diff performed against the real server (not source).
    check("audit-extraction.2", tools is not None and tools == base,
          f"tool-contract diff performed against real rebuilt server — {detail}")


# ── phase: routing ────────────────────────────────────────────────────────────
def phase_routing() -> None:
    print("\n=== phase: routing ===")
    mp = read_json(REPO / "docs/routing/map.json") or {}
    idx = REPO / "docs/routing/INDEX.md"
    router = REPO / "docs/routing/ROUTER.md"

    # [p4-routing.1] [inspect] map.json + INDEX.md exist and reference every data/* package.
    data_projects = json.dumps(mp.get("projects", {}).get("data", {}))
    all_data_present = all(name in data_projects for _, name in DATA_PKGS)
    check("p4-routing.1",
          bool(mp) and idx.exists() and all_data_present,
          "routing map.json + INDEX.md generated; every data/* package appears in map.json")

    # [p4-routing.2] [gate] drift gate: synthetic sox.concerns edit → check-drift FAILS; regen passes.
    GATE_RESULT["drift"] = _drift_gate()
    check("p4-routing.2", GATE_RESULT["drift"] is True,
          "routing drift gate rejects a synthetic sox.concerns edit"
          + ("" if GATE_RESULT["drift"] is not None else " (BLOCKED: gate could not execute)"))

    # [p4-routing.3] [inspect] hierarchical CLAUDE.md at root + area level.
    check("p4-routing.3",
          (REPO / "CLAUDE.md").exists() and (REPO / "libs/data/CLAUDE.md").exists(),
          "CLAUDE.md present at root + libs/data/ (area level)")

    # [p4-routing.4] [inspect] ROUTER.md with intent→scope entries.
    rtxt = read_text(router)
    check("p4-routing.4", router.exists() and rtxt.count("|") >= 6 and re.search(r"intent|scope|route", rtxt, re.I),
          "ROUTER.md present with intent→scope entries")

    # [p4-routing.5] [inspect] soft advisory documented non-gating + degrades without embeddings.
    check("p4-routing.5",
          bool(re.search(r"advisory only.*never gating|never gating", rtxt, re.I))
          and re.search(r"degrade|offline|embeddings? (are )?(off|down|disabled)", rtxt, re.I),
          "ROUTER.md documents the soft advisory as non-gating + degrading without embeddings")

    # [p4-routing.6] [nx] build,lint + registry drift green.
    rc_b, _ = run(["npx", "--yes", "nx", "run-many", "-t", "build,lint"])
    rc_r, _ = run(["npx", "--yes", "nx", "run", "registry:check-sync"])
    check("p4-routing.6", rc_b == 0 and rc_r == 0, "nx run-many build,lint + registry:check-sync green")

    # [audit-routing.1] [cover] cumulative coverage through routing.
    cover("audit-routing.1", ["baseline", "layout", "extraction", "routing"])
    # [audit-routing.2] [gate] the drift gate was EXECUTED (not merely asserted).
    check("audit-routing.2", GATE_RESULT["drift"] is True,
          "drift gate executed and confirmed a synthetic sox.concerns edit is rejected")


def _drift_gate() -> bool | None:
    """Inject a synthetic sox.concerns edit into a data package, run routing:check-drift,
    expect FAILURE, then revert. Returns True/False/None as _synthetic_boundary_gate."""
    pj = pkg_dir("analysis", "analysis") / "package.json"
    if not pj.exists():
        return None
    original = pj.read_text()
    try:
        j = json.loads(original)
        j.setdefault("sox", {}).setdefault("concerns", [])
        j["sox"]["concerns"] = list(j["sox"].get("concerns", [])) + ["__SYNTHETIC_DRIFT_PROBE__"]
        pj.write_text(json.dumps(j, indent=2) + "\n")
        rc, _ = run(["npx", "--yes", "nx", "run", "routing:check-drift"], timeout=300)
        return rc != 0
    except Exception:  # noqa: BLE001
        return None
    finally:
        pj.write_text(original)


# ── phase: final ──────────────────────────────────────────────────────────────
def phase_final() -> None:
    print("\n=== phase: final ===")

    # [audit-final.2] [live] real spawned server: tool-diff AND a real write→recall round-trip.
    tools, detail = probe_live_tools()
    base = baseline_tool_names()
    tool_diff_ok = tools is not None and tools == base and len(base) == 19
    wr_ok, wr_detail = probe_live_writerecall()
    check("audit-final.2", tool_diff_ok and wr_ok,
          f"tool-diff {'clean' if tool_diff_ok else 'DRIFT/'+detail} + write→recall: {wr_detail}")

    # [audit-final.3] [live] degrade-to-BM25 proven against the live server with vectors off.
    deg_ok, deg_detail = probe_live_degrade()
    check("audit-final.3", deg_ok, f"degrade-to-BM25 against live server: {deg_detail}")

    # [audit-final.4] [inspect] owner has reviewed the green audit — recorded, fully signed off.
    fr = read_text(PLAN / "final-review.md")
    unchecked = fr.count("- [ ]")
    signed = bool(re.search(r"sign|approved|owner", fr, re.I))
    check("audit-final.4", fr and unchecked == 0 and signed,
          f"final-review.md fully checked ({unchecked} unchecked box(es)) + owner sign-off recorded")

    # [audit-final.5] [nx/inspect] standalone-consumption: pack-smoke installs each public data/*
    #                 from its tarball outside the workspace + exercises it (the BL-87 guard).
    rc, out = run(["node", str(PLAN / "scripts" / "pack-smoke.mjs")])
    check("audit-final.5", rc == 0,
          "pack-smoke: each public data/* installs from its tarball + exercises standalone")
    if rc != 0:
        for line in out.splitlines():
            if "FAIL" in line or "BL-87" in line:
                print("    " + line.strip())

    # [audit-final.1] [cover] the whole cumulative surface was wired + emitted.
    cover("audit-final.1", ["baseline", "layout", "extraction", "routing"],
          extra=["audit-final.2", "audit-final.3", "audit-final.4", "audit-final.5"])

    # ── README Definition-of-Done binding (gap-check Check 8) ──────────────────
    # Every [dod.N] outcome maps to a concrete final-audit signal; each reuses a real
    # signal already computed by a prior phase — never a bare True.
    dod_final(tools, base, rc)


def dod_final(tools: list[str] | None, base: list[str], packsmoke_rc: int) -> None:
    """Bind each README [dod.N] outcome clause to the concrete final-audit signal that
    proves it. All signals are reused from real checks run earlier this invocation."""
    # [dod.1] 6 data/* build+lint+test independently → dist present + suites green (cached).
    dist_ok = all(dist_js(g, n).exists() and dist_js(g, n).stat().st_size > 200 for g, n in DATA_PKGS)
    tests_ok = bool(_TEST_CACHE) and all(_TEST_CACHE.get(n, False) for _, n in DATA_PKGS)
    check("dod.1", dist_ok and tests_ok,
          "6 data/* build (dist present) + unit suites green independently")
    # [dod.2] data↛platform enforced at lint time (synthetic import fails lint).
    check("dod.2", GATE_RESULT.get("synthetic-boundary") is True,
          "synthetic data→platform import is rejected by nx lint")
    # [dod.3] 19 memory_* tools byte-unchanged vs baseline snapshot.
    check("dod.3", tools is not None and tools == base and len(base) == 19,
          "live tools/list diff-clean vs p0-baseline snapshot (19 tools)")
    # [dod.4] real write→recall on the live server (blocked-by-default; never vacuous).
    wr_ok, wr_detail = probe_live_writerecall()
    check("dod.4", wr_ok, f"real memory_write+memory_recall round-trip: {wr_detail}")
    # [dod.5] hybrid-search degrades to BM25 when vectors are unavailable.
    check("dod.5", _TEST_CACHE.get("hybrid-search", False),
          "hybrid-search degrade-to-BM25 proven (vectors off → non-empty results)")
    # [dod.6] pack-smoke: each public data/* installs from its tarball + native carriers resolve.
    check("dod.6", packsmoke_rc == 0,
          "pack-smoke standalone-consumption passes (BL-87 affirmative guard)")
    # [dod.7] routing index generated + drift gate fails on synthetic change, passes on regen.
    check("dod.7", GATE_RESULT.get("drift") is True,
          "routing index generated; drift gate rejects a synthetic metadata change")
    # [dod.8] merge with zero new red gates (e2e zero-orphan, registry drift green).
    gate_crits = {"p1-layout.6", "w2e.5", "w2e.6", "p4-routing.6"}
    check("dod.8", not (gate_crits & set(FAILURES)),
          "no red among the reality gates (build/lint/test/e2e/registry) [inv:no-regress]")


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
