#!/usr/bin/env node
/**
 * audit.js — plan-state-machine multi-plan auditor (dispatch-optimizer edition)
 *
 * Accepts N plan directories, evaluates a typed expectation suite, and emits
 * a structured JSON report with multiple size-controlled views so a 30-plan
 * audit doesn't overflow context.
 *
 * Usage:
 *   node audit.js <plan-dir> [<plan-dir>...]          audit one or more plans
 *   node audit.js --paths-file <file>                 read paths from file (one per line, # comments ok)
 *   node audit.js --list-expectations                 print expectation catalog and exit
 *
 * View flags (pick one):
 *   --view summary          (default) one row per plan, pass/fail/health
 *   --view violations       only failed expectations, grouped by expectation
 *   --view plan <id>        all expectations for one plan
 *   --view expectation <e>  one expectation across all plans
 *   --view synthesis        synthesis block only (top violations + category breakdown)
 *   --view full             everything (can be large for 30+ plans)
 *
 * Format flags:
 *   --format json           (default) pretty-printed JSON
 *   --format ndjson         one JSON object per line
 *   --format table          ASCII table (summary view only)
 *
 * Other:
 *   --only-failures         in any view, suppress passing results
 *   --category <cat>        filter expectations to a category
 *
 * Exit codes:
 *   0  all critical expectations pass
 *   1  one or more critical expectations fail
 *   2  usage error
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── safe accessors ────────────────────────────────────────────────────────────

/** Deep-get obj[k1][k2]... safely, returning undefined on any miss/error. */
function get(obj, ...keys) {
  try {
    return keys.reduce((a, k) => (a == null ? undefined : a[k]), obj);
  } catch {
    return undefined;
  }
}

/** get() returning [] on miss. */
function getArr(obj, ...keys) {
  const v = get(obj, ...keys);
  return Array.isArray(v) ? v : [];
}

/** get() returning "" on miss. */
function getStr(obj, ...keys) {
  const v = get(obj, ...keys);
  return typeof v === "string" ? v : "";
}

/** Entries of an object safely. */
function entries(obj) {
  try {
    return obj != null && typeof obj === "object" ? Object.entries(obj) : [];
  } catch {
    return [];
  }
}

// ── file I/O ──────────────────────────────────────────────────────────────────

function tryReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { exists: false, data: null, error: null };
    const raw = fs.readFileSync(filePath, "utf-8");
    return { exists: true, data: JSON.parse(raw), error: null };
  } catch (e) {
    return { exists: true, data: null, error: e.message };
  }
}

function tryReadText(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { exists: false, text: null, error: null };
    return { exists: true, text: fs.readFileSync(filePath, "utf-8"), error: null };
  } catch (e) {
    return { exists: true, text: null, error: e.message };
  }
}

function tryReadNdjson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { exists: false, lines: [], error: null };
    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
    return { exists: true, lines, error: null };
  } catch (e) {
    return { exists: true, lines: [], error: e.message };
  }
}

function tryFileStat(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

// ── forge sink resolution ─────────────────────────────────────────────────────
// Mirrors the two-stream, two-env-var resolution documented in METRICS.md §0.
// Both streams can land in different directories — hence two separate resolvers.

/** Walk up from startDir to find the repo root (.git or package.json). */
function findRepoRoot(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, ".git")) || fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve the two durable sink directories for a plan.
 *
 * Stream 1 — training + failure events (lib/emit-event.js → resolveForgeSink):
 *   1. AGENT_FORGE_DIR env — used AS-IS (points at the training dir)
 *   2. .agent-forge-sink pointer at repo root
 *   3. <repo-root>/data/training
 *
 * Stream 3 — metrics (lib/metrics-sink.js → resolveSink):
 *   1. AGENT_FORGE_SINK env + /data/training (env is a project root, not the dir)
 *   2. <plan-dir>/.metrics-sink pointer
 *   3. forgeDir (same fallback, already resolved above)
 *
 * Returns { forgeDir: string|null, metricsDir: string|null, resolved_via: {} }
 */
function resolveForgeSinks(planDir) {
  const repoRoot = findRepoRoot(planDir);
  const resolved_via = {};

  // ── Stream 1: forgeDir ────────────────────────────────────────────────────
  let forgeDir = process.env.AGENT_FORGE_DIR ?? null;
  if (forgeDir) {
    resolved_via.forge = "AGENT_FORGE_DIR env";
  } else {
    const ptr = repoRoot ? path.join(repoRoot, ".agent-forge-sink") : null;
    if (ptr && fs.existsSync(ptr)) {
      try { forgeDir = fs.readFileSync(ptr, "utf-8").trim(); resolved_via.forge = ".agent-forge-sink pointer"; } catch {}
    }
    if (!forgeDir) {
      forgeDir = repoRoot ? path.join(repoRoot, "data", "training") : null;
      resolved_via.forge = "fallback: <repo-root>/data/training";
    }
  }

  // ── Stream 3: metricsDir ─────────────────────────────────────────────────
  let metricsDir = null;
  const agentForgeSink = process.env.AGENT_FORGE_SINK ?? null;
  if (agentForgeSink) {
    metricsDir = path.join(agentForgeSink, "data", "training");
    resolved_via.metrics = "AGENT_FORGE_SINK env + /data/training";
  } else {
    const mptr = path.join(planDir, ".metrics-sink");
    if (fs.existsSync(mptr)) {
      try { metricsDir = fs.readFileSync(mptr, "utf-8").trim(); resolved_via.metrics = ".metrics-sink pointer"; } catch {}
    }
    if (!metricsDir && forgeDir) {
      // Check if forgeDir has a data/training subdir (the standard layout)
      const candidate = path.join(forgeDir, "data", "training");
      metricsDir = fs.existsSync(candidate) ? candidate : forgeDir;
      resolved_via.metrics = `fallback: ${metricsDir}`;
    }
  }

  return { forgeDir, metricsDir, resolved_via };
}

// ── plan loading ──────────────────────────────────────────────────────────────

/** Extract <project>/<slug> from a path matching …/<project>/docs/plan/<slug> */
function extractPlanId(planDir) {
  const abs = path.resolve(planDir);
  // match: .../docs/plan/<slug> anywhere in the path
  const m = abs.match(/^(.*?)\/docs\/plan\/([^/]+)\/?$/);
  if (!m) {
    // fallback: use last two path components
    const parts = abs.replace(/\/$/, "").split("/");
    const slug = parts.at(-1) || "unknown";
    const project = parts.at(-2) || "unknown";
    return { id: `${project}/${slug}`, project, slug };
  }
  const projectDir = m[1];
  const slug = m[2];
  const project = projectDir.split("/").at(-1) || "unknown";
  return { id: `${project}/${slug}`, project, slug };
}

/** Load all relevant files for a plan directory. */
function loadPlan(planDir) {
  const abs = path.resolve(planDir);
  const { id, project, slug } = extractPlanId(abs);

  const dag = tryReadJson(path.join(abs, "dag.json"));
  const state = tryReadJson(path.join(abs, "state.json"));
  const references = tryReadJson(path.join(abs, "references.json"));
  const interfaces_ = tryReadJson(path.join(abs, "interfaces.json"));
  const humanBlockers = tryReadJson(path.join(abs, "human-blockers.json"));
  const criteria = tryReadJson(path.join(abs, "criteria.json"));
  const overlapMatrix = tryReadJson(path.join(abs, "overlap-matrix.json"));
  const dispatchCalib = tryReadJson(path.join(abs, "dispatch-calibration.json"));
  const sharedCtx = tryReadText(path.join(abs, "contexts", "_shared.md"));
  const events = tryReadNdjson(path.join(abs, "events.ndjson"));

  // Load per-slug context files
  const nodes = dag.data?.nodes ?? {};
  const contextFiles = {};
  for (const [sslug, node] of Object.entries(nodes)) {
    if (node?.context) {
      contextFiles[sslug] = tryReadText(path.join(abs, node.context));
    }
  }

  // ── plan-index (one level above the plan slug dir) ────────────────────────
  const planIndex = tryReadJson(path.join(abs, "..", "plan-index.json"));

  // ── agent-forge durable sinks ─────────────────────────────────────────────
  const { forgeDir, metricsDir, resolved_via: sinkResolvedVia } = resolveForgeSinks(abs);
  const planBasename = slug; // plan-executions files are keyed by plan basename

  // Stream 1: training records + cross-plan failure events
  const forgeAggregate = forgeDir ? tryReadNdjson(path.join(forgeDir, "aggregate.jsonl")) : { exists: false, lines: [], error: "forgeDir unresolved" };
  const forgeFailureEvents = forgeDir ? tryReadNdjson(path.join(forgeDir, "failure-events.ndjson")) : { exists: false, lines: [], error: "forgeDir unresolved" };

  // Per-state training files: plan-executions/<planBasename>-<slug>.jsonl
  const forgePerState = {};
  for (const sslug of Object.keys(nodes)) {
    const p = forgeDir ? path.join(forgeDir, "plan-executions", `${planBasename}-${sslug}.jsonl`) : null;
    forgePerState[sslug] = p ? tryReadNdjson(p) : { exists: false, lines: [], error: "forgeDir unresolved" };
  }

  // Stream 3: metrics aggregate + per-state metrics
  const metricsAggregate = metricsDir ? tryReadNdjson(path.join(metricsDir, "metrics-aggregate.jsonl")) : { exists: false, lines: [], error: "metricsDir unresolved" };
  const metricsPerState = {};
  for (const sslug of Object.keys(nodes)) {
    const p = metricsDir ? path.join(metricsDir, "plan-executions", `${planBasename}-${sslug}-metrics.jsonl`) : null;
    metricsPerState[sslug] = p ? tryReadNdjson(p) : { exists: false, lines: [], error: "metricsDir unresolved" };
  }

  return {
    id, project, slug, planDir: abs,
    forgeSinks: { forgeDir, metricsDir, resolved_via: sinkResolvedVia },
    files: {
      dag, state, references, interfaces: interfaces_, humanBlockers,
      criteria, overlapMatrix, dispatchCalib, sharedCtx, events, contextFiles,
      planIndex,
      forge: { aggregate: forgeAggregate, failureEvents: forgeFailureEvents, perState: forgePerState },
      metrics: { aggregate: metricsAggregate, perState: metricsPerState },
    },
  };
}

// ── config extraction ─────────────────────────────────────────────────────────

function extractConfig(plan) {
  const { id, project, slug, planDir } = plan;
  const { dag, state } = plan.files;

  const dagData = dag.data;
  const stateData = state.data;

  const nodes = dagData?.nodes ?? {};
  const slugs = Object.keys(nodes);
  const states = stateData?.states ?? {};

  // Derive timestamps
  const allStarted = Object.values(states).map((s) => s?.started_at).filter(Boolean);
  const allDone = Object.values(states).map((s) => s?.done_at).filter(Boolean);
  const dateCreated = allStarted.length ? allStarted.sort()[0] : null;
  const lastUpdate = allDone.length ? [...allDone].sort().at(-1) : (allStarted.length ? [...allStarted].sort().at(-1) : null);

  // Current phase
  const currentState = stateData?.current_state;
  const currentNode = currentState ? nodes[currentState] : null;
  const currentPhase = currentNode?.phase ?? null;

  // Completion counts
  const completedCount = Object.values(states).filter((s) => s?.status === "complete").length;
  const pendingCount = Object.values(states).filter((s) => s?.status === "pending").length;
  const blockedCount = Object.values(states).filter((s) => s?.status === "blocked").length;
  const inProgressCount = Object.values(states).filter((s) => s?.status === "in_progress").length;

  // Authored with (from state.json)
  const authoredWith = stateData?.authored_with;

  // File stat for plan dir
  const dagStat = tryFileStat(path.join(planDir, "dag.json"));

  return {
    id, project, slug, path: planDir,
    version: authoredWith?.version ?? authoredWith?.plugin ?? null,
    author: dagData?.executor ?? null,
    date_created: dateCreated ?? (dagStat ? dagStat.birthtime.toISOString() : null),
    last_update: lastUpdate,
    current_state: currentState ?? null,
    current_phase: currentPhase,
    plan_kind: dagData?.plan_kind ?? null,
    phases: getArr(dagData, "phases"),
    terminal: dagData?.terminal ?? null,
    executor: dagData?.executor ?? null,
    state_count: slugs.length,
    phase_count: new Set(Object.values(nodes).map((n) => n?.phase).filter(Boolean)).size,
    completed_count: completedCount,
    pending_count: pendingCount,
    blocked_count: blockedCount,
    in_progress_count: inProgressCount,
    schema_version_dag: dagData?.schema_version ?? null,
    schema_version_state: stateData?.schema_version ?? null,
    transition_log_length: getArr(stateData, "transition_log").length,
    amendment_log_length: getArr(stateData, "amendment_log").length,
    dod_provenance: stateData?.dod_provenance ?? null,
    authored_with: authoredWith ?? null,
    files_present: {
      dag: dag.exists,
      state: state.exists,
      references: plan.files.references.exists,
      sharedCtx: plan.files.sharedCtx.exists,
      events: plan.files.events.exists,
      overlapMatrix: plan.files.overlapMatrix.exists,
      dispatchCalib: plan.files.dispatchCalib.exists,
    },
  };
}

// ── guard pinning ─────────────────────────────────────────────────────────────

function isGuardPinned(guard, planData) {
  if (!guard || typeof guard !== "string") return null;
  const g = guard.trim();
  if (!g) return null;
  // Plan declares explicit env → credited as pinned
  if (g.includes("PLAN_ENV_LABEL")) return true;
  if (g.startsWith("./node_modules/.bin/")) return true;
  if (g.startsWith("npx --yes ") || g.startsWith("npx -y ")) return true;
  if (/^python3?\s+\S+\.py/.test(g)) return true;
  // bare `node script.js` — UNPINNED (node is ambient)
  if (/^node\s+\S/.test(g)) return false;
  if (/^bash\s+/.test(g) || /^sh\s+/.test(g)) return false;
  // Bare tool name (no slash in first word)
  const firstWord = g.split(/\s+/)[0];
  if (!firstWord.includes("/") && !firstWord.startsWith(".")) return false;
  return null; // unknown / indeterminate
}

// ── expectations catalog ──────────────────────────────────────────────────────
//
// Each expectation is:
//   hypothesis  — the claim being tested
//   category    — structural | topology | guard | runtime | tasks | metrics | optimizer
//   severity    — critical | warning | info
//   check(plan) — returns { values, does_match_expected, detail, errors }
//
// check() must NEVER throw. All errors are caught and placed in `errors`.

const EXPECTATIONS = {

  // ─── structural ─────────────────────────────────────────────────────────────

  "dag-exists": {
    hypothesis: "dag.json must exist in every plan directory — it is the plan's sole structural source of truth.",
    category: "structural",
    severity: "critical",
    check({ files }) {
      const exists = files.dag.exists;
      const errors = files.dag.error ? [files.dag.error] : [];
      return { values: [exists], does_match_expected: exists, detail: exists ? "dag.json found" : "dag.json MISSING", errors };
    },
  },

  "state-exists": {
    hypothesis: "state.json must exist in every plan directory — it is the live execution cursor.",
    category: "structural",
    severity: "critical",
    check({ files }) {
      const exists = files.state.exists;
      const errors = files.state.error ? [files.state.error] : [];
      return { values: [exists], does_match_expected: exists, detail: exists ? "state.json found" : "state.json MISSING", errors };
    },
  },

  "dag-schema-version": {
    hypothesis: "dag.json schema_version should be 2 (v1 plans lack tasks[], plan_kind, and changes blocks).",
    category: "structural",
    severity: "warning",
    check({ files }) {
      if (!files.dag.exists) return { values: [null], does_match_expected: null, detail: "dag.json absent", errors: [] };
      const v = get(files.dag.data, "schema_version");
      const ok = v === 2;
      return { values: [v], does_match_expected: ok, detail: ok ? `schema_version=${v}` : `schema_version=${v} (expected 2)`, errors: [] };
    },
  },

  "state-schema-version": {
    hypothesis: "state.json schema_version should be 2.",
    category: "structural",
    severity: "warning",
    check({ files }) {
      if (!files.state.exists) return { values: [null], does_match_expected: null, detail: "state.json absent", errors: [] };
      const v = get(files.state.data, "schema_version");
      const ok = v === 2;
      return { values: [v], does_match_expected: ok, detail: ok ? `schema_version=${v}` : `schema_version=${v} (expected 2)`, errors: [] };
    },
  },

  "nodes-non-empty": {
    hypothesis: "dag.json must have at least one node — a plan with no states cannot be dispatched.",
    category: "structural",
    severity: "critical",
    check({ files }) {
      if (!files.dag.exists) return { values: [0], does_match_expected: false, detail: "dag.json absent", errors: [] };
      const nodes = get(files.dag.data, "nodes") ?? {};
      const count = Object.keys(nodes).length;
      return { values: [count], does_match_expected: count > 0, detail: `${count} node(s)`, errors: [] };
    },
  },

  "phases-declared": {
    hypothesis: "dag.json must declare a phases[] array — it is required for phase-boundary detection and series-parallel DAG classification.",
    category: "structural",
    severity: "warning",
    check({ files }) {
      if (!files.dag.exists) return { values: [null], does_match_expected: null, detail: "dag.json absent", errors: [] };
      const phases = get(files.dag.data, "phases");
      const ok = Array.isArray(phases) && phases.length > 0;
      return { values: phases ?? [null], does_match_expected: ok, detail: ok ? `${phases.length} phase(s): ${phases.join(", ")}` : "phases[] missing or empty", errors: [] };
    },
  },

  "terminal-declared": {
    hypothesis: "dag.json must declare a terminal slug — needed by HLFET to compute critical-path length from any node to the sink.",
    category: "structural",
    severity: "warning",
    check({ files }) {
      if (!files.dag.exists) return { values: [null], does_match_expected: null, detail: "dag.json absent", errors: [] };
      const terminal = get(files.dag.data, "terminal");
      const ok = typeof terminal === "string" && terminal.length > 0;
      return { values: [terminal ?? null], does_match_expected: ok, detail: ok ? `terminal="${terminal}"` : "terminal field missing", errors: [] };
    },
  },

  "plan-kind-declared": {
    hypothesis: "dag.json must declare plan_kind as 'brownfield' or 'greenfield' — affects prior on file-overlap density for optimizer.",
    category: "structural",
    severity: "info",
    check({ files }) {
      if (!files.dag.exists) return { values: [null], does_match_expected: null, detail: "dag.json absent", errors: [] };
      const kind = get(files.dag.data, "plan_kind");
      const ok = kind === "brownfield" || kind === "greenfield";
      return { values: [kind ?? null], does_match_expected: ok, detail: ok ? `plan_kind="${kind}"` : `plan_kind="${kind}" (expected brownfield|greenfield)`, errors: [] };
    },
  },

  "executor-declared": {
    hypothesis: "dag.json executor field must be set — determines the default B (base dispatch overhead) for states without per-task model overrides.",
    category: "structural",
    severity: "warning",
    check({ files }) {
      if (!files.dag.exists) return { values: [null], does_match_expected: null, detail: "dag.json absent", errors: [] };
      const exec = get(files.dag.data, "executor");
      const ok = typeof exec === "string" && exec.length > 0;
      return { values: [exec ?? null], does_match_expected: ok, detail: ok ? `executor="${exec}"` : "executor field missing", errors: [] };
    },
  },

  "shared-context-exists": {
    hypothesis: "contexts/_shared.md must exist — it carries the [inv:] entries (shared invariants) that the optimizer deduplicates across wave states.",
    category: "structural",
    severity: "warning",
    check({ files }) {
      const exists = files.sharedCtx.exists;
      const errors = files.sharedCtx.error ? [files.sharedCtx.error] : [];
      const bytes = files.sharedCtx.text ? Buffer.byteLength(files.sharedCtx.text) : 0;
      return { values: [exists ? bytes : null], does_match_expected: exists, detail: exists ? `${bytes} bytes` : "contexts/_shared.md MISSING", errors };
    },
  },

  "references-json-exists": {
    hypothesis: "references.json must exist — it is the reference pattern catalog. Missing it means all [ref:X] citations are unresolvable.",
    category: "structural",
    severity: "warning",
    check({ files }) {
      const exists = files.references.exists;
      const errors = files.references.error ? [files.references.error] : [];
      return { values: [exists], does_match_expected: exists, detail: exists ? "references.json found" : "references.json MISSING", errors };
    },
  },

  // ─── topology ────────────────────────────────────────────────────────────────

  "slug-set-identity": {
    hypothesis: "Every slug in dag.json nodes must have a matching entry in state.json states, and vice versa. Divergence indicates a hand-edited file or failed add-state.",
    category: "topology",
    severity: "critical",
    check({ files }) {
      if (!files.dag.exists || !files.state.exists) return { values: [null], does_match_expected: null, detail: "dag.json or state.json absent", errors: [] };
      const dagSlugs = new Set(Object.keys(get(files.dag.data, "nodes") ?? {}));
      const stateSlugs = new Set(Object.keys(get(files.state.data, "states") ?? {}));
      const onlyInDag = [...dagSlugs].filter((s) => !stateSlugs.has(s));
      const onlyInState = [...stateSlugs].filter((s) => !dagSlugs.has(s));
      const ok = onlyInDag.length === 0 && onlyInState.length === 0;
      const detail = ok
        ? `${dagSlugs.size} slugs match`
        : `only-in-dag: [${onlyInDag.join(", ")}]; only-in-state: [${onlyInState.join(", ")}]`;
      return { values: [{ dagSlugs: dagSlugs.size, stateSlugs: stateSlugs.size, onlyInDag, onlyInState }], does_match_expected: ok, detail, errors: [] };
    },
  },

  "current-state-valid": {
    hypothesis: "state.json current_state must be a slug in dag.json or the literal string 'done'.",
    category: "topology",
    severity: "critical",
    check({ files }) {
      if (!files.dag.exists || !files.state.exists) return { values: [null], does_match_expected: null, detail: "dag.json or state.json absent", errors: [] };
      const cur = get(files.state.data, "current_state");
      if (cur === "done") return { values: [cur], does_match_expected: true, detail: "current_state=done (terminal)", errors: [] };
      const nodes = get(files.dag.data, "nodes") ?? {};
      const ok = cur != null && cur in nodes;
      return { values: [cur], does_match_expected: ok, detail: ok ? `current_state="${cur}" valid` : `current_state="${cur}" not found in dag.json nodes`, errors: [] };
    },
  },

  "context-files-exist": {
    hypothesis: "Every context path referenced in dag.json must have a corresponding file on disk. Missing context files mean executors cannot resume.",
    category: "topology",
    severity: "critical",
    check({ files, planDir }) {
      if (!files.dag.exists) return { values: [null], does_match_expected: null, detail: "dag.json absent", errors: [] };
      const nodes = get(files.dag.data, "nodes") ?? {};
      const missing = [];
      const present = [];
      for (const [slug, node] of Object.entries(nodes)) {
        if (!node?.context) continue;
        const full = path.join(planDir, node.context);
        if (fs.existsSync(full)) present.push(node.context);
        else missing.push({ slug, context: node.context });
      }
      const ok = missing.length === 0;
      return {
        values: [{ present: present.length, missing: missing.length }],
        does_match_expected: ok,
        detail: ok ? `all ${present.length} context file(s) exist` : `${missing.length} missing: ${missing.map((m) => m.context).join(", ")}`,
        errors: [],
      };
    },
  },

  "depends-on-valid": {
    hypothesis: "All depends_on[] references must point to real slugs in the same plan. Dangling edges prevent valid topological sort.",
    category: "topology",
    severity: "critical",
    check({ files }) {
      if (!files.dag.exists) return { values: [null], does_match_expected: null, detail: "dag.json absent", errors: [] };
      const nodes = get(files.dag.data, "nodes") ?? {};
      const slugSet = new Set(Object.keys(nodes));
      const broken = [];
      for (const [slug, node] of Object.entries(nodes)) {
        for (const dep of getArr(node, "depends_on")) {
          if (!slugSet.has(dep)) broken.push({ slug, dep });
        }
      }
      const ok = broken.length === 0;
      return {
        values: [broken],
        does_match_expected: ok,
        detail: ok ? "all depends_on refs valid" : broken.map((b) => `${b.slug}→${b.dep}`).join(", "),
        errors: [],
      };
    },
  },

  "dag-acyclic": {
    hypothesis: "dag.json must be a DAG (no cycles in depends_on). A cycle causes infinite scheduling loops.",
    category: "topology",
    severity: "critical",
    check({ files }) {
      if (!files.dag.exists) return { values: [null], does_match_expected: null, detail: "dag.json absent", errors: [] };
      const nodes = get(files.dag.data, "nodes") ?? {};
      // Kahn's algorithm
      const inDeg = {};
      const adj = {};
      for (const slug of Object.keys(nodes)) { inDeg[slug] = 0; adj[slug] = []; }
      for (const [slug, node] of Object.entries(nodes)) {
        for (const dep of getArr(node, "depends_on")) {
          if (dep in adj) { adj[dep].push(slug); inDeg[slug] = (inDeg[slug] ?? 0) + 1; }
        }
      }
      const queue = Object.keys(inDeg).filter((s) => inDeg[s] === 0);
      let visited = 0;
      while (queue.length) {
        const n = queue.shift(); visited++;
        for (const next of (adj[n] ?? [])) { if (--inDeg[next] === 0) queue.push(next); }
      }
      const total = Object.keys(nodes).length;
      const ok = visited === total;
      return {
        values: [{ total, visited, cyclic_count: total - visited }],
        does_match_expected: ok,
        detail: ok ? "DAG is acyclic" : `cycle detected — ${total - visited} node(s) not reachable in topo sort`,
        errors: [],
      };
    },
  },

  "is-forest-or-series-parallel": {
    hypothesis: "If every node's depends_on references only nodes from earlier phases, the DAG is a forest/series-parallel — enabling the exact polynomial Tree DP O(N²·W) algorithm instead of CP-SAT.",
    category: "topology",
    severity: "info",
    check({ files }) {
      if (!files.dag.exists) return { values: [null], does_match_expected: null, detail: "dag.json absent", errors: [] };
      const nodes = get(files.dag.data, "nodes") ?? {};
      const phases = get(files.dag.data, "phases") ?? [];
      const phaseIdx = Object.fromEntries(phases.map((p, i) => [p, i]));
      const violations = [];
      for (const [slug, node] of Object.entries(nodes)) {
        const myPhase = phaseIdx[node?.phase] ?? -1;
        for (const dep of getArr(node, "depends_on")) {
          const depPhase = phaseIdx[nodes[dep]?.phase] ?? -1;
          if (depPhase >= myPhase) violations.push({ slug, dep, reason: "same or later phase" });
        }
      }
      const ok = violations.length === 0 && phases.length > 0;
      return {
        values: [{ is_forest_sp: ok, violations: violations.length }],
        does_match_expected: ok,
        detail: ok ? "forest/series-parallel — Tree DP applicable" : violations.length > 0 ? `${violations.length} cross-phase dep(s): ${violations.map((v) => `${v.slug}→${v.dep}`).join(", ")}` : "no phases declared",
        errors: [],
      };
    },
  },

  "audit-nodes-present": {
    hypothesis: "Every plan should have at least one audit-kind node. Plans without audit hold-points cannot enforce the non-regression invariant.",
    category: "topology",
    severity: "warning",
    check({ files }) {
      if (!files.dag.exists) return { values: [null], does_match_expected: null, detail: "dag.json absent", errors: [] };
      const nodes = get(files.dag.data, "nodes") ?? {};
      const auditNodes = Object.entries(nodes).filter(([, n]) => n?.kind === "audit").map(([s]) => s);
      const ok = auditNodes.length > 0;
      return { values: [auditNodes], does_match_expected: ok, detail: ok ? `${auditNodes.length} audit node(s): ${auditNodes.join(", ")}` : "no audit nodes found", errors: [] };
    },
  },

  "kind-values-valid": {
    hypothesis: "All dag.json node kind values must be work, audit, or review. Unknown kinds break orchestrator routing.",
    category: "topology",
    severity: "warning",
    check({ files }) {
      if (!files.dag.exists) return { values: [null], does_match_expected: null, detail: "dag.json absent", errors: [] };
      const nodes = get(files.dag.data, "nodes") ?? {};
      const valid = new Set(["work", "audit", "review", null, undefined]);
      const invalid = Object.entries(nodes).filter(([, n]) => !valid.has(n?.kind)).map(([s, n]) => `${s}:${n?.kind}`);
      const ok = invalid.length === 0;
      const kindDist = {};
      for (const node of Object.values(nodes)) {
        const k = node?.kind ?? "null";
        kindDist[k] = (kindDist[k] ?? 0) + 1;
      }
      return { values: [kindDist], does_match_expected: ok, detail: ok ? `kind distribution: ${JSON.stringify(kindDist)}` : `invalid kinds: ${invalid.join(", ")}`, errors: [] };
    },
  },

  // ─── guard ───────────────────────────────────────────────────────────────────

  "guards-non-empty": {
    hypothesis: "Every work-kind node must have a non-empty guard command. An empty guard means the state can never be verified complete.",
    category: "guard",
    severity: "critical",
    check({ files }) {
      if (!files.dag.exists) return { values: [null], does_match_expected: null, detail: "dag.json absent", errors: [] };
      const nodes = get(files.dag.data, "nodes") ?? {};
      const missing = Object.entries(nodes).filter(([, n]) => n?.kind !== "audit" && (!n?.guard || !n.guard.trim())).map(([s]) => s);
      const ok = missing.length === 0;
      return { values: [{ missing }], does_match_expected: ok, detail: ok ? "all work nodes have guards" : `missing guard: ${missing.join(", ")}`, errors: [] };
    },
  },

  "guards-pinned": {
    hypothesis: "All guard commands must be environment-pinned (./node_modules/.bin/, npx --yes, python script.py). Unpinned guards (bare tsc, jest, node) are non-deterministic across environments.",
    category: "guard",
    severity: "warning",
    check({ files }) {
      if (!files.dag.exists) return { values: [null], does_match_expected: null, detail: "dag.json absent", errors: [] };
      const nodes = get(files.dag.data, "nodes") ?? {};
      const unpinned = [];
      const unknown = [];
      const pinned = [];
      for (const [slug, node] of Object.entries(nodes)) {
        if (!node?.guard) continue;
        const result = isGuardPinned(node.guard);
        if (result === true) pinned.push(slug);
        else if (result === false) unpinned.push({ slug, guard: node.guard.slice(0, 60) });
        else unknown.push(slug);
      }
      const ok = unpinned.length === 0;
      return {
        values: [{ pinned: pinned.length, unpinned: unpinned.length, unknown: unknown.length }],
        does_match_expected: ok,
        detail: ok ? `${pinned.length} pinned` + (unknown.length ? `, ${unknown.length} unknown` : "") : `${unpinned.length} unpinned: ${unpinned.map((u) => u.slug).join(", ")}`,
        errors: [],
      };
    },
  },

  "artifacts-non-empty": {
    hypothesis: "Work nodes should declare artifacts[] — without them the optimizer cannot compute the Si file sets or overlap matrix.",
    category: "guard",
    severity: "warning",
    check({ files }) {
      if (!files.dag.exists) return { values: [null], does_match_expected: null, detail: "dag.json absent", errors: [] };
      const nodes = get(files.dag.data, "nodes") ?? {};
      const noArtifacts = Object.entries(nodes).filter(([, n]) => n?.kind !== "audit" && (!n?.artifacts || n.artifacts.length === 0)).map(([s]) => s);
      const withArtifacts = Object.entries(nodes).filter(([, n]) => n?.kind !== "audit" && n?.artifacts?.length > 0).length;
      const ok = noArtifacts.length === 0;
      return {
        values: [{ with_artifacts: withArtifacts, missing_artifacts: noArtifacts.length }],
        does_match_expected: ok,
        detail: ok ? `all ${withArtifacts} work node(s) have artifacts` : `${noArtifacts.length} work node(s) missing artifacts: ${noArtifacts.join(", ")}`,
        errors: [],
      };
    },
  },

  "artifacts-are-paths-not-globs": {
    hypothesis: "artifacts[] should be explicit file paths, not glob patterns (*, **, {}, ?). Globs must be expanded before computing the Si overlap matrix (SCOPE.md Gap 2).",
    category: "guard",
    severity: "info",
    check({ files }) {
      if (!files.dag.exists) return { values: [null], does_match_expected: null, detail: "dag.json absent", errors: [] };
      const nodes = get(files.dag.data, "nodes") ?? {};
      const globs = [];
      for (const [slug, node] of Object.entries(nodes)) {
        for (const artifact of getArr(node, "artifacts")) {
          if (/[*?{}\[\]]/.test(artifact)) globs.push({ slug, artifact });
        }
      }
      const ok = globs.length === 0;
      return {
        values: [{ glob_count: globs.length, examples: globs.slice(0, 5).map((g) => g.artifact) }],
        does_match_expected: ok,
        detail: ok ? "all artifacts are explicit paths" : `${globs.length} glob pattern(s) need expansion: ${globs.slice(0, 3).map((g) => g.artifact).join(", ")}`,
        errors: [],
      };
    },
  },

  // ─── runtime ─────────────────────────────────────────────────────────────────

  "completed-states-have-end-ref": {
    hypothesis: "States with status=complete must have end_ref set. Missing end_ref means training-record extraction is degraded and Ki actuals cannot be recovered.",
    category: "runtime",
    severity: "warning",
    check({ files }) {
      if (!files.state.exists) return { values: [null], does_match_expected: null, detail: "state.json absent", errors: [] };
      const states = get(files.state.data, "states") ?? {};
      const completeWithoutRef = Object.entries(states).filter(([, s]) => s?.status === "complete" && !s?.end_ref).map(([slug]) => slug);
      const completeCount = Object.values(states).filter((s) => s?.status === "complete").length;
      const ok = completeWithoutRef.length === 0;
      return {
        values: [{ complete: completeCount, missing_end_ref: completeWithoutRef.length }],
        does_match_expected: ok,
        detail: ok ? `${completeCount} complete state(s), all have end_ref` : `${completeWithoutRef.length} complete state(s) missing end_ref: ${completeWithoutRef.join(", ")}`,
        errors: [],
      };
    },
  },

  "no-orphan-in-progress": {
    hypothesis: "No state should be stuck in in_progress without a start_ref. This indicates an interrupted run where the transition script was not called with --start.",
    category: "runtime",
    severity: "warning",
    check({ files }) {
      if (!files.state.exists) return { values: [null], does_match_expected: null, detail: "state.json absent", errors: [] };
      const states = get(files.state.data, "states") ?? {};
      const orphans = Object.entries(states).filter(([, s]) => s?.status === "in_progress" && !s?.start_ref).map(([slug]) => slug);
      const inProgress = Object.values(states).filter((s) => s?.status === "in_progress");
      const ok = orphans.length === 0;
      return {
        values: [{ in_progress: inProgress.length, orphans }],
        does_match_expected: ok,
        detail: ok ? `${inProgress.length} in_progress state(s), none orphaned` : `${orphans.length} orphaned in_progress: ${orphans.join(", ")}`,
        errors: [],
      };
    },
  },

  "transition-log-populated": {
    hypothesis: "If any state has completed, transition_log should have at least one entry. An empty transition_log means state-transition.js --complete was never called (hand-edited state.json).",
    category: "runtime",
    severity: "warning",
    check({ files }) {
      if (!files.state.exists) return { values: [null], does_match_expected: null, detail: "state.json absent", errors: [] };
      const states = get(files.state.data, "states") ?? {};
      const completedCount = Object.values(states).filter((s) => s?.status === "complete").length;
      if (completedCount === 0) return { values: [0], does_match_expected: true, detail: "no completed states — N/A", errors: [] };
      const logLen = getArr(files.state.data, "transition_log").length;
      const ok = logLen > 0;
      return { values: [logLen], does_match_expected: ok, detail: ok ? `${logLen} transition(s) logged` : `0 transitions logged but ${completedCount} state(s) complete — hand-edited state.json suspected`, errors: [] };
    },
  },

  "dod-provenance-set": {
    hypothesis: "If current_state=done (plan terminal), dod_provenance must be set — proving the DoD was explicitly confirmed. A missing dod_provenance means the plan shipped without explicit sign-off.",
    category: "runtime",
    severity: "critical",
    check({ files }) {
      if (!files.state.exists) return { values: [null], does_match_expected: null, detail: "state.json absent", errors: [] };
      const cur = get(files.state.data, "current_state");
      if (cur !== "done") return { values: [null], does_match_expected: null, detail: `current_state="${cur}" — not terminal, N/A`, errors: [] };
      const prov = get(files.state.data, "dod_provenance");
      const ok = prov != null;
      return { values: [prov ?? null], does_match_expected: ok, detail: ok ? `dod_provenance confirmed at ${prov?.confirmed_at ?? "?"}` : "plan is terminal but dod_provenance NOT set — DoD was never confirmed", errors: [] };
    },
  },

  "authored-with-stamp": {
    hypothesis: "state.json authored_with must be set — it is the skill-version drift signal. Missing it means we cannot determine if the plan was built with an incompatible skill version.",
    category: "runtime",
    severity: "info",
    check({ files }) {
      if (!files.state.exists) return { values: [null], does_match_expected: null, detail: "state.json absent", errors: [] };
      const aw = get(files.state.data, "authored_with");
      const ok = aw != null && (aw.version || aw.plugin);
      return { values: [aw ?? null], does_match_expected: ok, detail: ok ? `${aw.plugin ?? ""}@${aw.version ?? "?"}+${(aw.hash ?? "").slice(0, 8)}` : "authored_with not set", errors: [] };
    },
  },

  // ─── tasks ───────────────────────────────────────────────────────────────────

  "tasks-have-model": {
    hypothesis: "If tasks[] are declared in dag.json nodes, each task must specify model (Haiku|Sonnet|Opus). Missing model prevents cost-tier routing — all tasks default to an unknown B.",
    category: "tasks",
    severity: "warning",
    check({ files }) {
      if (!files.dag.exists) return { values: [null], does_match_expected: null, detail: "dag.json absent", errors: [] };
      const nodes = get(files.dag.data, "nodes") ?? {};
      const allTasks = Object.entries(nodes).flatMap(([slug, node]) =>
        (node?.tasks ?? []).map((t) => ({ ...t, _slug: slug }))
      );
      if (allTasks.length === 0) return { values: [0], does_match_expected: true, detail: "no tasks[] declared — N/A", errors: [] };
      const valid = new Set(["Haiku", "Sonnet", "Opus"]);
      const missing = allTasks.filter((t) => !valid.has(t.model)).map((t) => t.id ?? `${t._slug}[?]`);
      const ok = missing.length === 0;
      const dist = {};
      for (const t of allTasks) dist[t.model ?? "null"] = (dist[t.model ?? "null"] ?? 0) + 1;
      return { values: [dist], does_match_expected: ok, detail: ok ? `${allTasks.length} task(s), model dist: ${JSON.stringify(dist)}` : `${missing.length} task(s) missing model: ${missing.slice(0, 5).join(", ")}`, errors: [] };
    },
  },

  "tasks-have-writes": {
    hypothesis: "If tasks[] are declared, each task must specify writes[]. Missing writes[] prevents parallel-safety analysis — the optimizer cannot determine which tasks conflict.",
    category: "tasks",
    severity: "warning",
    check({ files }) {
      if (!files.dag.exists) return { values: [null], does_match_expected: null, detail: "dag.json absent", errors: [] };
      const nodes = get(files.dag.data, "nodes") ?? {};
      const allTasks = Object.entries(nodes).flatMap(([slug, node]) =>
        (node?.tasks ?? []).map((t) => ({ ...t, _slug: slug }))
      );
      if (allTasks.length === 0) return { values: [0], does_match_expected: true, detail: "no tasks[] declared — N/A", errors: [] };
      const missing = allTasks.filter((t) => !Array.isArray(t.writes) || t.writes.length === 0).map((t) => t.id ?? `${t._slug}[?]`);
      const ok = missing.length === 0;
      return { values: [{ total: allTasks.length, missing: missing.length }], does_match_expected: ok, detail: ok ? `all ${allTasks.length} task(s) have writes[]` : `${missing.length} task(s) missing writes[]: ${missing.slice(0, 5).join(", ")}`, errors: [] };
    },
  },

  "no-intra-state-write-conflicts": {
    hypothesis: "No two tasks within the same state should write to the same file. Write conflicts require serialization or worktree isolation — unmarked conflicts corrupt parallel execution.",
    category: "tasks",
    severity: "critical",
    check({ files }) {
      if (!files.dag.exists) return { values: [null], does_match_expected: null, detail: "dag.json absent", errors: [] };
      const nodes = get(files.dag.data, "nodes") ?? {};
      const conflicts = [];
      for (const [slug, node] of Object.entries(nodes)) {
        const tasks = node?.tasks ?? [];
        if (tasks.length < 2) continue;
        const fileSeen = {};
        for (const task of tasks) {
          for (const f of getArr(task, "writes")) {
            if (fileSeen[f]) conflicts.push({ slug, file: f, tasks: [fileSeen[f], task.id ?? "?"] });
            else fileSeen[f] = task.id ?? "?";
          }
        }
      }
      const ok = conflicts.length === 0;
      return { values: [conflicts], does_match_expected: ok, detail: ok ? "no write conflicts" : `${conflicts.length} conflict(s): ${conflicts.map((c) => `${c.slug}→${c.file}`).join(", ")}`, errors: [] };
    },
  },

  // ─── metrics ─────────────────────────────────────────────────────────────────

  "events-log-exists": {
    hypothesis: "events.ndjson should exist once any execution has occurred. Missing it means the failure/rework event stream was never wired or the skill version predates stream 1.",
    category: "metrics",
    severity: "info",
    check({ files }) {
      const exists = files.events.exists;
      const count = files.events.lines.length;
      return { values: [{ exists, count }], does_match_expected: exists, detail: exists ? `${count} event(s)` : "events.ndjson absent (no execution yet or pre-stream-1 skill)", errors: [] };
    },
  },

  "dod-events-present": {
    hypothesis: "If current_state=done, events.ndjson should contain at least one dod_confirmed or dod_unconfirmed event. Missing events indicate the skill predates Fix A (METRICS.md §7).",
    category: "metrics",
    severity: "warning",
    check({ files }) {
      const cur = get(files.state.data, "current_state");
      if (cur !== "done") return { values: [null], does_match_expected: null, detail: "plan not terminal — N/A", errors: [] };
      if (!files.events.exists) return { values: [null], does_match_expected: false, detail: "events.ndjson absent", errors: [] };
      const dodEvents = files.events.lines.filter((e) => e?.event_type === "dod_confirmed" || e?.event_type === "dod_unconfirmed");
      const ok = dodEvents.length > 0;
      return {
        values: [dodEvents.map((e) => ({ type: e.event_type, ts: e.ts }))],
        does_match_expected: ok,
        detail: ok ? `${dodEvents.length} DoD event(s): ${dodEvents.map((e) => e.event_type).join(", ")}` : "no dod_confirmed/dod_unconfirmed events — likely pre-Fix-A skill version",
        errors: [],
      };
    },
  },

  "guard-retries-recoverable": {
    hypothesis: "If events.ndjson has guard_retry events, the retry count is recoverable. If guard_retry events exist but metrics show retry_count=null, Fix C (METRICS.md §7) has not been deployed.",
    category: "metrics",
    severity: "info",
    check({ files }) {
      if (!files.events.exists) return { values: [null], does_match_expected: null, detail: "events.ndjson absent — N/A", errors: [] };
      const retries = files.events.lines.filter((e) => e?.event_type === "guard_retry");
      const ok = retries.length >= 0; // always informational
      return {
        values: [{ guard_retry_event_count: retries.length }],
        does_match_expected: true, // informational only
        detail: retries.length > 0 ? `${retries.length} guard_retry event(s) recorded — retry counts recoverable from event stream` : "no guard_retry events (all guards passed first try, or no execution yet)",
        errors: [],
      };
    },
  },

  // ─── references ──────────────────────────────────────────────────────────────

  "references-flat-shape": {
    hypothesis: "references.json must be a flat slug-keyed object with NO wrapper key. A wrapper key (e.g. {refs: {...}}) is rejected by gap-check.js Check 6.",
    category: "references",
    severity: "critical",
    check({ files }) {
      if (!files.references.exists) return { values: [null], does_match_expected: null, detail: "references.json absent", errors: [] };
      if (files.references.error) return { values: [null], does_match_expected: false, detail: `parse error: ${files.references.error}`, errors: [files.references.error] };
      const data = files.references.data;
      if (typeof data !== "object" || data === null) return { values: [null], does_match_expected: false, detail: "references.json is not an object", errors: [] };
      // Detect wrapper: if any top-level value is itself an object of objects (nested), it's wrapped
      const keys = Object.keys(data);
      const hasWrapper = keys.some((k) => {
        const v = data[k];
        return v && typeof v === "object" && Object.values(v).every((vv) => vv && typeof vv === "object");
      });
      const ok = !hasWrapper;
      return { values: [{ key_count: keys.length, has_wrapper: hasWrapper }], does_match_expected: ok, detail: ok ? `${keys.length} ref(s), flat shape` : "wrapper key detected — references.json is not flat", errors: [] };
    },
  },

  "every-ref-has-audit-check": {
    hypothesis: "Every references.json entry must have an audit_check field. Missing audit_check means gap-check.js Check 7 will block publish.",
    category: "references",
    severity: "warning",
    check({ files }) {
      if (!files.references.exists) return { values: [null], does_match_expected: null, detail: "references.json absent", errors: [] };
      if (files.references.error) return { values: [null], does_match_expected: false, detail: `parse error: ${files.references.error}`, errors: [files.references.error] };
      const data = files.references.data ?? {};
      const missing = Object.entries(data).filter(([, v]) => typeof v === "object" && !v?.audit_check).map(([k]) => k);
      const total = Object.keys(data).length;
      const ok = missing.length === 0;
      return { values: [{ total, missing_audit_check: missing.length }], does_match_expected: ok, detail: ok ? `all ${total} ref(s) have audit_check` : `${missing.length} ref(s) missing audit_check: ${missing.join(", ")}`, errors: [] };
    },
  },

  // ─── optimizer (SCOPE.md gaps) ───────────────────────────────────────────────

  "overlap-matrix-exists": {
    hypothesis: "overlap-matrix.json should exist (SCOPE.md Gap 2). Without it the optimizer cannot compute |Si ∩ Sj| and falls back to prose-only deduplication via compile-wave.js.",
    category: "optimizer",
    severity: "info",
    check({ files }) {
      const exists = files.overlapMatrix.exists;
      const errors = files.overlapMatrix.error ? [files.overlapMatrix.error] : [];
      return { values: [exists], does_match_expected: exists, detail: exists ? "overlap-matrix.json found" : "overlap-matrix.json absent (Gap 2 not yet implemented)", errors };
    },
  },

  "dispatch-calibration-exists": {
    hypothesis: "dispatch-calibration.json should exist (SCOPE.md Gap 1). Without it B (base dispatch overhead) is not measured and the optimizer omits the dominant cost term.",
    category: "optimizer",
    severity: "info",
    check({ files }) {
      const exists = files.dispatchCalib.exists;
      const errors = files.dispatchCalib.error ? [files.dispatchCalib.error] : [];
      return { values: [exists], does_match_expected: exists, detail: exists ? "dispatch-calibration.json found" : "dispatch-calibration.json absent (Gap 1 not yet implemented)", errors };
    },
  },

  // ─── plan-index ──────────────────────────────────────────────────────────────
  // plan-index.json sits one level above the plan slug dir at docs/plan/plan-index.json.
  // Written by scripts/plan-index.js --update; used by cross-plan-check.js.

  "plan-index-exists": {
    hypothesis: "plan-index.json should exist at docs/plan/plan-index.json (one level above the plan slug dir). Its absence means cross-plan conflict detection is blind.",
    category: "plan-index",
    severity: "warning",
    check({ files }) {
      const exists = files.planIndex.exists;
      const errors = files.planIndex.error ? [files.planIndex.error] : [];
      return { values: [exists], does_match_expected: exists, detail: exists ? "plan-index.json found" : "plan-index.json absent (../plan-index.json relative to plan dir)", errors };
    },
  },

  "plan-index-registered": {
    hypothesis: "This plan's slug must appear as a key in plan-index.json. An unregistered plan is invisible to cross-plan scheduling and conflict detection.",
    category: "plan-index",
    severity: "warning",
    check({ files, slug }) {
      if (!files.planIndex.exists) return { values: [null], does_match_expected: null, detail: "plan-index.json absent", errors: [] };
      if (files.planIndex.error) return { values: [null], does_match_expected: false, detail: `parse error: ${files.planIndex.error}`, errors: [files.planIndex.error] };
      const index = files.planIndex.data;
      // plan-index.json shape: { plans: { <slug>: { ... } } } or flat { <slug>: { ... } }
      const plans = index?.plans ?? index ?? {};
      const registered = slug in plans;
      const allSlugs = Object.keys(plans);
      return {
        values: [{ registered, index_size: allSlugs.length }],
        does_match_expected: registered,
        detail: registered ? `"${slug}" registered (${allSlugs.length} plan(s) in index)` : `"${slug}" NOT in plan-index (${allSlugs.length} registered: ${allSlugs.slice(0, 5).join(", ")})`,
        errors: [],
      };
    },
  },

  "plan-index-mutate-set-populated": {
    hypothesis: "This plan's entry in plan-index.json must have a non-empty mutate_set. An empty mutate_set means the plan's file ownership is unknown — cross-plan conflict detection will miss real collisions.",
    category: "plan-index",
    severity: "info",
    check({ files, slug }) {
      if (!files.planIndex.exists) return { values: [null], does_match_expected: null, detail: "plan-index.json absent", errors: [] };
      if (files.planIndex.error) return { values: [null], does_match_expected: false, detail: `parse error: ${files.planIndex.error}`, errors: [files.planIndex.error] };
      const plans = files.planIndex.data?.plans ?? files.planIndex.data ?? {};
      const entry = plans[slug];
      if (!entry) return { values: [null], does_match_expected: null, detail: `"${slug}" not registered in plan-index — N/A`, errors: [] };
      const mutateSet = entry.mutate_set ?? entry.mutateSet ?? [];
      const ok = Array.isArray(mutateSet) && mutateSet.length > 0;
      return {
        values: [mutateSet],
        does_match_expected: ok,
        detail: ok ? `mutate_set has ${mutateSet.length} file(s)` : "mutate_set is empty or absent — file ownership unknown",
        errors: [],
      };
    },
  },

  // ─── agent-forge ─────────────────────────────────────────────────────────────
  // The durable external sinks written by extract-training-record.js (Stream 2)
  // and emit-state-metrics.js (Stream 3). Resolved via AGENT_FORGE_DIR /
  // AGENT_FORGE_SINK env vars or fallback pointer files (see METRICS.md §0).

  "agent-forge-sink-resolved": {
    hypothesis: "At least one agent-forge sink directory must be resolvable (via AGENT_FORGE_DIR env, .agent-forge-sink pointer, or <repo-root>/data/training fallback). An unresolvable sink means all training and metrics records are lost.",
    category: "agent-forge",
    severity: "warning",
    check({ forgeSinks }) {
      const { forgeDir, metricsDir, resolved_via } = forgeSinks;
      const forgeOk = !!forgeDir && fs.existsSync(forgeDir);
      const metricsOk = !!metricsDir && fs.existsSync(metricsDir);
      const ok = forgeOk || metricsOk;
      return {
        values: [{ forgeDir: forgeDir ?? null, metricsDir: metricsDir ?? null, forge_exists: forgeOk, metrics_exists: metricsOk, resolved_via }],
        does_match_expected: ok,
        detail: ok
          ? `forge=${forgeOk ? "✓" : "✗"} (${resolved_via.forge ?? "?"}), metrics=${metricsOk ? "✓" : "✗"} (${resolved_via.metrics ?? "?"})`
          : "neither forgeDir nor metricsDir resolved to an existing directory — set AGENT_FORGE_DIR / AGENT_FORGE_SINK",
        errors: [],
      };
    },
  },

  "agent-forge-aggregate-has-records": {
    hypothesis: "aggregate.jsonl (cross-plan training record stream) must exist and contain at least one record for this plan's slug. Missing records mean training data is not flowing from this plan's execution.",
    category: "agent-forge",
    severity: "info",
    check({ files, slug, forgeSinks }) {
      if (!forgeSinks.forgeDir) return { values: [null], does_match_expected: null, detail: "forgeDir unresolved — cannot check aggregate.jsonl", errors: [] };
      const agg = files.forge.aggregate;
      if (!agg.exists) return { values: [{ exists: false, total_records: 0, this_plan: 0 }], does_match_expected: false, detail: `aggregate.jsonl absent at ${forgeSinks.forgeDir}`, errors: agg.error ? [agg.error] : [] };
      const thisplan = agg.lines.filter((r) => r?.plan === slug || r?.plan === path.basename(slug));
      const ok = thisplan.length > 0;
      return {
        values: [{ exists: true, total_records: agg.lines.length, this_plan: thisplan.length }],
        does_match_expected: ok,
        detail: ok
          ? `${thisplan.length} training record(s) for "${slug}" in aggregate.jsonl (${agg.lines.length} total)`
          : `no records for "${slug}" in aggregate.jsonl (${agg.lines.length} total for other plans)`,
        errors: [],
      };
    },
  },

  "agent-forge-per-state-training-files": {
    hypothesis: "Per-state training files (plan-executions/<plan>-<slug>.jsonl) must exist for every completed state. Missing files indicate the training extractor was not called or the state was hand-advanced.",
    category: "agent-forge",
    severity: "info",
    check({ files, slug, forgeSinks }) {
      if (!forgeSinks.forgeDir) return { values: [null], does_match_expected: null, detail: "forgeDir unresolved", errors: [] };
      const stateData = files.state.data;
      const completedSlugs = Object.entries(stateData?.states ?? {})
        .filter(([, s]) => s?.status === "complete")
        .map(([ss]) => ss);
      if (completedSlugs.length === 0) return { values: [{ complete: 0, with_file: 0 }], does_match_expected: true, detail: "no completed states — N/A", errors: [] };

      const withFile = completedSlugs.filter((ss) => files.forge.perState[ss]?.exists);
      const missing = completedSlugs.filter((ss) => !files.forge.perState[ss]?.exists);
      const ok = missing.length === 0;
      return {
        values: [{ complete: completedSlugs.length, with_file: withFile.length, missing: missing.length, missing_slugs: missing }],
        does_match_expected: ok,
        detail: ok
          ? `${withFile.length}/${completedSlugs.length} per-state training file(s) present`
          : `${missing.length} completed state(s) missing training files: ${missing.join(", ")}`,
        errors: [],
      };
    },
  },

  "agent-forge-failure-events-mirror": {
    hypothesis: "failure-events.ndjson (cross-plan aggregate mirror) must exist and contain records for this plan. It mirrors events.ndjson; absence means the cross-plan failure dataset is incomplete for ML training.",
    category: "agent-forge",
    severity: "info",
    check({ files, slug, forgeSinks }) {
      if (!forgeSinks.forgeDir) return { values: [null], does_match_expected: null, detail: "forgeDir unresolved", errors: [] };
      const fe = files.forge.failureEvents;
      if (!fe.exists) return { values: [{ exists: false }], does_match_expected: false, detail: `failure-events.ndjson absent at ${forgeSinks.forgeDir}`, errors: fe.error ? [fe.error] : [] };
      const thisplan = fe.lines.filter((r) => r?.plan === slug || r?.plan === path.basename(slug));
      const planEventsLocal = files.events.lines.length;
      const ok = planEventsLocal === 0 || thisplan.length > 0; // ok if no local events yet
      const mirrorRate = planEventsLocal > 0 ? Math.round((thisplan.length / planEventsLocal) * 100) : null;
      return {
        values: [{ failure_events_total: fe.lines.length, this_plan: thisplan.length, local_events: planEventsLocal, mirror_rate_pct: mirrorRate }],
        does_match_expected: ok,
        detail: ok
          ? `${thisplan.length} event(s) for "${slug}" in failure-events.ndjson (${fe.lines.length} total); mirror rate ${mirrorRate ?? "N/A"}%`
          : `0 events for "${slug}" in failure-events.ndjson but ${planEventsLocal} local events exist — mirror broken`,
        errors: [],
      };
    },
  },

  "agent-forge-metrics-aggregate-has-records": {
    hypothesis: "metrics-aggregate.jsonl (cross-plan metrics stream) must exist and contain records for this plan. These are the Ki actuals the dispatch optimizer uses for calibration (SCOPE.md Gap 7).",
    category: "agent-forge",
    severity: "info",
    check({ files, slug, forgeSinks }) {
      if (!forgeSinks.metricsDir) return { values: [null], does_match_expected: null, detail: "metricsDir unresolved — cannot check metrics-aggregate.jsonl", errors: [] };
      const agg = files.metrics.aggregate;
      if (!agg.exists) return { values: [{ exists: false, total: 0, this_plan: 0 }], does_match_expected: false, detail: `metrics-aggregate.jsonl absent at ${forgeSinks.metricsDir}`, errors: agg.error ? [agg.error] : [] };
      const thisplan = agg.lines.filter((r) => r?.plan === slug || r?.plan === path.basename(slug));
      const ok = thisplan.length > 0;
      // Check how many have non-null input_tokens_reported (Gap 7 signal)
      const withTokens = thisplan.filter((r) => r?.context_cost?.input_tokens_reported != null);
      const degraded = thisplan.filter((r) => r?.degraded === true);
      return {
        values: [{
          exists: true,
          total_records: agg.lines.length,
          this_plan: thisplan.length,
          with_actual_tokens: withTokens.length,
          degraded: degraded.length,
          gap7_coverage_pct: thisplan.length > 0 ? Math.round((withTokens.length / thisplan.length) * 100) : null,
        }],
        does_match_expected: ok,
        detail: ok
          ? `${thisplan.length} metrics record(s) for "${slug}"; ${withTokens.length} with actual tokens (Gap 7: ${thisplan.length > 0 ? Math.round((withTokens.length / thisplan.length) * 100) : 0}% coverage); ${degraded.length} degraded`
          : `no metrics records for "${slug}" in metrics-aggregate.jsonl (${agg.lines.length} total)`,
        errors: [],
      };
    },
  },

  "agent-forge-per-state-metrics-files": {
    hypothesis: "Per-state metrics files (plan-executions/<plan>-<slug>-metrics.jsonl) must exist for every completed state. These are the per-state cost actuals for Ki calibration.",
    category: "agent-forge",
    severity: "info",
    check({ files, slug, forgeSinks }) {
      if (!forgeSinks.metricsDir) return { values: [null], does_match_expected: null, detail: "metricsDir unresolved", errors: [] };
      const stateData = files.state.data;
      const completedSlugs = Object.entries(stateData?.states ?? {})
        .filter(([, s]) => s?.status === "complete")
        .map(([ss]) => ss);
      if (completedSlugs.length === 0) return { values: [{ complete: 0, with_file: 0 }], does_match_expected: true, detail: "no completed states — N/A", errors: [] };

      const withFile = completedSlugs.filter((ss) => files.metrics.perState[ss]?.exists);
      const missing = completedSlugs.filter((ss) => !files.metrics.perState[ss]?.exists);
      const ok = missing.length === 0;

      // For files that exist, check for non-null input_tokens_reported (Gap 7)
      const withTokens = withFile.filter((ss) => {
        const rec = files.metrics.perState[ss]?.lines?.[0];
        return rec?.context_cost?.input_tokens_reported != null;
      });

      return {
        values: [{
          complete: completedSlugs.length,
          with_file: withFile.length,
          missing: missing.length,
          with_actual_tokens: withTokens.length,
          missing_slugs: missing,
        }],
        does_match_expected: ok,
        detail: ok
          ? `${withFile.length}/${completedSlugs.length} per-state metrics file(s); ${withTokens.length} with actual token counts (Gap 7 signal)`
          : `${missing.length} completed state(s) missing metrics files: ${missing.join(", ")}`,
        errors: [],
      };
    },
  },
};

// ── run expectations ──────────────────────────────────────────────────────────

function runExpectations(plans, categoryFilter) {
  const expectations = {};
  const filtered = categoryFilter
    ? Object.entries(EXPECTATIONS).filter(([, e]) => e.category === categoryFilter)
    : Object.entries(EXPECTATIONS);

  for (const [eSlug, eDef] of filtered) {
    expectations[eSlug] = {
      hypothesis: eDef.hypothesis,
      category: eDef.category,
      severity: eDef.severity,
    };

    for (const plan of plans) {
      let result;
      try {
        result = eDef.check(plan);
      } catch (err) {
        result = { values: [], does_match_expected: false, detail: `check threw: ${err.message}`, errors: [err.message] };
      }
      expectations[eSlug][plan.id] = {
        values: result.values ?? [],
        file_exists: plan.files.dag.exists,
        errors: result.errors ?? [],
        count: (result.values ?? []).length,
        does_match_expected: result.does_match_expected ?? null,
        detail: result.detail ?? "",
      };
    }
  }
  return expectations;
}

// ── synthesis ─────────────────────────────────────────────────────────────────

function buildSynthesis(plans, expectations) {
  const planIds = plans.map((p) => p.id);
  const byExpectation = {};
  const byPlan = Object.fromEntries(planIds.map((id) => [id, { pass: 0, fail: 0, null_: 0, critical_fail: 0, failing: [] }]));
  const byCategory = {};

  for (const [eSlug, eData] of Object.entries(expectations)) {
    const cat = eData.category;
    const sev = eData.severity;
    if (!byCategory[cat]) byCategory[cat] = { pass: 0, fail: 0, null_: 0, critical_fail: 0 };

    let pass = 0, fail = 0, null_ = 0;
    const failing = [];

    for (const id of planIds) {
      const r = eData[id];
      if (!r) continue;
      if (r.does_match_expected === true) { pass++; byPlan[id].pass++; byCategory[cat].pass++; }
      else if (r.does_match_expected === false) {
        fail++;
        byPlan[id].fail++;
        byCategory[cat].fail++;
        failing.push(id);
        if (sev === "critical") { byPlan[id].critical_fail++; byCategory[cat].critical_fail++; }
      } else {
        null_++;
        byPlan[id].null_++;
        byCategory[cat].null_++;
      }
    }

    byExpectation[eSlug] = {
      hypothesis: eData.hypothesis,
      category: cat,
      severity: sev,
      pass,
      fail,
      null_,
      pass_rate: pass + fail > 0 ? Number(((pass / (pass + fail)) * 100).toFixed(1)) : null,
      failing_plans: failing,
    };
  }

  // Health scores per plan
  for (const id of planIds) {
    const p = byPlan[id];
    p.health_score = p.pass + p.fail > 0 ? Number(((p.pass / (p.pass + p.fail)) * 100).toFixed(1)) : null;
  }

  // Category summaries
  for (const cat of Object.keys(byCategory)) {
    const c = byCategory[cat];
    c.pass_rate = c.pass + c.fail > 0 ? Number(((c.pass / (c.pass + c.fail)) * 100).toFixed(1)) : null;
  }

  // Top violations (highest fail count, critical first)
  const topViolations = Object.entries(byExpectation)
    .filter(([, e]) => e.fail > 0)
    .sort((a, b) => {
      const sevOrder = { critical: 0, warning: 1, info: 2 };
      const sevDiff = (sevOrder[a[1].severity] ?? 3) - (sevOrder[b[1].severity] ?? 3);
      return sevDiff !== 0 ? sevDiff : b[1].fail - a[1].fail;
    })
    .slice(0, 10)
    .map(([slug, e]) => ({
      expectation: slug,
      severity: e.severity,
      fail_count: e.fail,
      fail_rate: `${100 - (e.pass_rate ?? 0)}%`,
      failing_plans: e.failing_plans,
    }));

  const totalExpectations = Object.keys(expectations).length;
  const totalChecks = totalExpectations * planIds.length;
  const totalPass = Object.values(byPlan).reduce((s, p) => s + p.pass, 0);
  const totalFail = Object.values(byPlan).reduce((s, p) => s + p.fail, 0);

  return {
    overall: {
      plan_count: planIds.length,
      expectation_count: totalExpectations,
      total_checks: totalChecks,
      total_pass: totalPass,
      total_fail: totalFail,
      overall_pass_rate: totalPass + totalFail > 0 ? Number(((totalPass / (totalPass + totalFail)) * 100).toFixed(1)) : null,
    },
    top_violations: topViolations,
    by_expectation: byExpectation,
    by_plan: byPlan,
    by_category: byCategory,
  };
}

// ── views ─────────────────────────────────────────────────────────────────────

function viewSummary(config, synthesis, format) {
  const rows = Object.values(config).map((c) => {
    const p = synthesis.by_plan[c.id] ?? {};
    return {
      id: c.id,
      health: p.health_score != null ? `${p.health_score}%` : "?",
      pass: p.pass ?? 0,
      fail: p.fail ?? 0,
      critical_fail: p.critical_fail ?? 0,
      null_: p.null_ ?? 0,
      current_state: c.current_state ?? "?",
      current_phase: c.current_phase ?? "?",
      version: c.version ?? "?",
      plan_kind: c.plan_kind ?? "?",
      state_count: c.state_count,
      top_failures: (p.failing ?? []).slice(0, 3).join(", "),
    };
  });

  if (format === "table") {
    const cols = ["id", "health", "pass", "fail", "critical_fail", "current_state", "version", "top_failures"];
    const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
    const header = cols.map((c, i) => c.padEnd(widths[i])).join("  ");
    const sep = widths.map((w) => "-".repeat(w)).join("  ");
    const lines = [header, sep, ...rows.map((r) => cols.map((c, i) => String(r[c] ?? "").padEnd(widths[i])).join("  "))];
    return lines.join("\n");
  }

  return JSON.stringify({ view: "summary", generated_at: new Date().toISOString(), rows }, null, 2);
}

function viewViolations(expectations, synthesis, onlyFailures) {
  const failing = Object.entries(synthesis.by_expectation)
    .filter(([, e]) => e.fail > 0)
    .sort((a, b) => {
      const sevOrder = { critical: 0, warning: 1, info: 2 };
      return (sevOrder[a[1].severity] ?? 3) - (sevOrder[b[1].severity] ?? 3) || b[1].fail - a[1].fail;
    });

  const out = {};
  for (const [eSlug, eMeta] of failing) {
    out[eSlug] = {
      severity: eMeta.severity,
      category: eMeta.category,
      hypothesis: eMeta.hypothesis,
      fail_count: eMeta.fail,
      pass_rate: eMeta.pass_rate,
      plan_results: {},
    };
    for (const planId of eMeta.failing_plans) {
      const r = expectations[eSlug][planId];
      out[eSlug].plan_results[planId] = { detail: r?.detail, errors: r?.errors ?? [] };
    }
  }
  return JSON.stringify({ view: "violations", generated_at: new Date().toISOString(), violation_count: Object.keys(out).length, violations: out }, null, 2);
}

function viewPlan(planId, config, expectations, synthesis) {
  const cfg = Object.values(config).find((c) => c.id === planId || c.slug === planId);
  if (!cfg) return JSON.stringify({ error: `plan not found: ${planId}` }, null, 2);
  const id = cfg.id;
  const results = {};
  for (const [eSlug, eData] of Object.entries(expectations)) {
    const r = eData[id];
    if (!r) continue;
    results[eSlug] = {
      category: eData.category,
      severity: eData.severity,
      hypothesis: eData.hypothesis,
      ...r,
    };
  }
  const planSynth = synthesis.by_plan[id] ?? {};
  return JSON.stringify({
    view: "plan",
    plan: id,
    config: cfg,
    health_score: planSynth.health_score,
    pass: planSynth.pass,
    fail: planSynth.fail,
    critical_fail: planSynth.critical_fail,
    failing_expectations: planSynth.failing,
    results,
  }, null, 2);
}

function viewExpectation(eSlug, expectations, synthesis) {
  const eData = expectations[eSlug];
  if (!eData) return JSON.stringify({ error: `expectation not found: ${eSlug}` }, null, 2);
  const eSynth = synthesis.by_expectation[eSlug] ?? {};
  const planResults = {};
  for (const [key, val] of Object.entries(eData)) {
    if (typeof val === "object" && val !== null && "does_match_expected" in val) {
      planResults[key] = val;
    }
  }
  return JSON.stringify({ view: "expectation", expectation: eSlug, hypothesis: eData.hypothesis, category: eData.category, severity: eData.severity, synthesis: eSynth, plan_results: planResults }, null, 2);
}

function viewSynthesis(synthesis) {
  return JSON.stringify({ view: "synthesis", ...synthesis }, null, 2);
}

function viewFull(meta, config, expectations, synthesis) {
  return JSON.stringify({ view: "full", meta, config, expectations, synthesis }, null, 2);
}

// ── list expectations ─────────────────────────────────────────────────────────

function listExpectations() {
  const byCat = {};
  for (const [slug, e] of Object.entries(EXPECTATIONS)) {
    if (!byCat[e.category]) byCat[e.category] = [];
    byCat[e.category].push({ slug, severity: e.severity, hypothesis: e.hypothesis });
  }
  for (const [cat, items] of Object.entries(byCat)) {
    console.log(`\n## ${cat}`);
    for (const item of items) {
      console.log(`  [${item.severity.toUpperCase().padEnd(8)}] ${item.slug}`);
      console.log(`            ${item.hypothesis}`);
    }
  }
  console.log(`\nTotal: ${Object.keys(EXPECTATIONS).length} expectations`);
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const planPaths = [];
  let pathsFile = null;
  let view = "summary";
  let viewArg = null;
  let format = "json";
  let onlyFailures = false;
  let categoryFilter = null;
  let listExpectationsFlag = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--paths-file") { pathsFile = args[++i]; }
    else if (a === "--view") { view = args[++i]; if (["plan", "expectation"].includes(view)) viewArg = args[++i]; }
    else if (a === "--format") { format = args[++i]; }
    else if (a === "--only-failures") { onlyFailures = true; }
    else if (a === "--category") { categoryFilter = args[++i]; }
    else if (a === "--list-expectations") { listExpectationsFlag = true; }
    else if (!a.startsWith("--")) { planPaths.push(a); }
  }

  if (pathsFile) {
    try {
      const lines = fs.readFileSync(pathsFile, "utf-8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      planPaths.push(...lines);
    } catch (e) {
      console.error(`audit.js: cannot read --paths-file: ${e.message}`);
      process.exit(2);
    }
  }

  return { planPaths, view, viewArg, format, onlyFailures, categoryFilter, listExpectationsFlag };
}

function main() {
  const { planPaths, view, viewArg, format, onlyFailures, categoryFilter, listExpectationsFlag } = parseArgs(process.argv);

  if (listExpectationsFlag) { listExpectations(); process.exit(0); }

  if (planPaths.length === 0) {
    console.error("usage: node audit.js <plan-dir>... [--view summary|violations|plan <id>|expectation <e>|synthesis|full]");
    console.error("       node audit.js --paths-file <file>");
    console.error("       node audit.js --list-expectations");
    process.exit(2);
  }

  // Load all plans
  const plans = planPaths.map((p) => {
    try { return loadPlan(p); }
    catch (e) { console.error(`audit.js: failed to load plan at ${p}: ${e.message}`); return null; }
  }).filter(Boolean);

  if (plans.length === 0) { console.error("audit.js: no plans loaded"); process.exit(2); }

  const config = Object.fromEntries(plans.map((p) => [p.id, extractConfig(p)]));
  const expectations = runExpectations(plans, categoryFilter);
  const synthesis = buildSynthesis(plans, expectations);

  const meta = {
    generated_at: new Date().toISOString(),
    plan_count: plans.length,
    expectation_count: Object.keys(expectations).length,
    view,
    category_filter: categoryFilter ?? null,
    only_failures: onlyFailures,
  };

  let out;
  switch (view) {
    case "summary":     out = viewSummary(config, synthesis, format); break;
    case "violations":  out = viewViolations(expectations, synthesis, onlyFailures); break;
    case "plan":        out = viewPlan(viewArg, config, expectations, synthesis); break;
    case "expectation": out = viewExpectation(viewArg, expectations, synthesis); break;
    case "synthesis":   out = viewSynthesis(synthesis); break;
    case "full":        out = viewFull(meta, config, expectations, synthesis); break;
    default:
      console.error(`audit.js: unknown view "${view}"`);
      process.exit(2);
  }

  process.stdout.write(out + "\n");

  // Exit 1 if any critical expectation fails
  const criticalFailure = Object.values(synthesis.by_expectation).some(
    (e) => e.severity === "critical" && e.fail > 0
  );
  process.exit(criticalFailure ? 1 : 0);
}

main();
