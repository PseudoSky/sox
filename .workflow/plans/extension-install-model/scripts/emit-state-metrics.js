#!/usr/bin/env node
/**
 * emit-state-metrics.js — emit one per-state execution METRICS record per
 * completed plan-state-machine state.
 *
 * Phase 2 of the plan-state-machine evolution plan
 * (docs/experiments/plan-state-machine-metrics-extraction-spec.md).
 *
 * Called by state-transition.js at --complete time (step 6), alongside
 * extract-training-record.js. This is a SEPARATE, leaner sidecar to the 12-point
 * training record — diagnostic cost/quality signals (context/token burn, guard
 * retries, audit pass-rate, amendment volume, wall-clock), NOT the full training
 * triple. It reads only dag.json + state.json for structure, measures file
 * bytes, and writes a metrics record to the configured sink.
 *
 * Node standard library only — no npm dependencies (the skill runs in an
 * isolated agent context). Mirrors extract-training-record.js / gap-check.js
 * style: top-level pure helpers, execSync for git, an explicit main() with argv
 * parsing, structured stdout, well-defined exit codes.
 *
 * It reuses the Phase 0/1 substrate:
 *   - lib/normalize-state.js  → canonical timestamps + wallClockSeconds
 *   - lib/env-pin.js          → environment.env_pinned heuristic
 *   - lib/emit-event.js       → repoRoot(), currentActor()
 *   - lib/metrics-sink.js     → config-driven sink resolution
 *
 * Usage:
 *   node scripts/emit-state-metrics.js <plan-dir> <slug> \
 *     --start-ref <sha> --end-ref <sha> \
 *     [--audit-passed <N> --audit-total <N> --audit-exit <N>] \
 *     [--guard-retries <N>] \
 *     [--input-tokens <N> --output-tokens <N> --tool-call-count <N>]
 *
 * Retrospective mode (old plans with no start_ref):
 *   node scripts/emit-state-metrics.js <plan-dir> <slug> --retrospective
 *   - refs.start_ref / refs.end_ref are null
 *   - context bytes measured from current file content (not at start_ref)
 *   - wall_clock_s from transition_log/state timestamps if available
 *   - guard.retry_count is null (no scratch history)
 *   - degraded: true always
 *
 * Exit codes:
 *   0 — metrics record written (full or degraded)
 *   2 — usage error (missing plan-dir/slug, or plan-dir not a directory)
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { currentActor, repoRoot } from "./lib/emit-event.js";
import { isEnvPinned } from "./lib/env-pin.js";
import { resolveSink } from "./lib/metrics-sink.js";
import { normalizeStateEntry, wallClockSeconds } from "./lib/normalize-state.js";

const AMENDMENT_TYPES = ["expand-artifacts", "add-criterion", "fix-guard", "update-shared"];
const AUTHORING_FIX_TYPES = ["add-criterion", "fix-guard"];
const VALUELESS_FLAGS = ["--retrospective"];

// ── git helpers (execSync-based, mirror extract-training-record.js style) ──

/** Run a git command in `cwd`; return trimmed stdout, or null on failure. */
function git(cwd, argline) {
  try {
    return execSync(`git ${argline}`, {
      cwd,
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

/** `git show <ref>:<file>` — file content at a ref, or null if unavailable. */
function gitShow(cwd, ref, file) {
  if (!ref) return null;
  return git(cwd, `show ${JSON.stringify(`${ref}:${file}`)}`);
}

// ── file/parse helpers ──

function readFileOrNull(file) {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

function readJsonOrNull(file) {
  const raw = readFileOrNull(file);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** UTF-8 byte length of a string, or null when the string is null/undefined. */
function byteLenOrNull(text) {
  if (text === null || text === undefined) return null;
  return Buffer.byteLength(text, "utf-8");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  if (i === -1 || i + 1 >= args.length) return null;
  return args[i + 1];
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

/** Coerce a CLI string to an integer, or null if absent/unparseable. */
function intOrNull(raw) {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// ── domain extractors (pure; exported for unit tests) ──

/**
 * Measure context-cost bytes for a slug. In retrospective mode (no startRef)
 * the files are read from the working tree; otherwise from `git show start_ref`.
 * Falls back to working-tree content when the ref read fails (file may be new).
 *
 * @returns {{context_file_bytes, shared_md_bytes, total_input_bytes}}
 */
export function measureContextBytes(planDir, slug, startRef, opts = {}) {
  const cwd = opts.cwd || planDir;
  const relContext = path.posix.join("contexts", `${slug}.md`);
  const relShared = path.posix.join("contexts", "_shared.md");

  const readAtRef = (rel) => {
    if (!startRef) return readFileOrNull(path.join(planDir, rel));
    const atRef = gitShow(cwd, startRef, rel);
    return atRef !== null ? atRef : readFileOrNull(path.join(planDir, rel));
  };

  const contextText = readAtRef(relContext);
  const sharedText = readAtRef(relShared);

  const contextBytes = byteLenOrNull(contextText);
  const sharedBytes = byteLenOrNull(sharedText);

  // total_input_bytes is the sum of whatever components were measurable. When
  // neither file is present it is null (nothing measured), not 0 (measured-empty).
  let total = null;
  if (contextBytes !== null || sharedBytes !== null) {
    total = (contextBytes || 0) + (sharedBytes || 0);
  }

  return {
    context_file_bytes: contextBytes,
    shared_md_bytes: sharedBytes,
    total_input_bytes: total,
  };
}

/**
 * Tally amendment_log entries for one slug into total + by_class + by_type, and
 * detect whether an authoring-phase fix-loop is present (add-criterion /
 * fix-guard amendment exists for this slug).
 *
 * @param {Array} amendmentLog top-level state.json amendment_log
 * @param {string} slug
 */
export function tallyAmendments(amendmentLog, slug) {
  const by_class = { executor: 0, planner: 0 };
  const by_type = {
    "expand-artifacts": 0,
    "add-criterion": 0,
    "fix-guard": 0,
    "update-shared": 0,
    other: 0,
  };
  let total = 0;
  let fix_loop_present = false;

  const entries = Array.isArray(amendmentLog)
    ? amendmentLog.filter((e) => e && e.state === slug)
    : [];

  for (const e of entries) {
    total += 1;
    if (e.class === "executor") by_class.executor += 1;
    else if (e.class === "planner") by_class.planner += 1;

    if (AMENDMENT_TYPES.includes(e.type)) by_type[e.type] += 1;
    else by_type.other += 1;

    if (AUTHORING_FIX_TYPES.includes(e.type)) fix_loop_present = true;
  }

  return { total, by_class, by_type, fix_loop_present };
}

/**
 * Compute audit metrics. When no audit script ran (auditTotal absent/0 with no
 * exit), pass_rate is null (1.0 would be misleading) and the caller marks the
 * record degraded.
 *
 * @returns {{criteria_passed, criteria_total, pass_rate, audit_exit_code, degraded}}
 */
export function computeAudit(auditPassed, auditTotal, auditExit) {
  const passed = intOrNull(auditPassed);
  const total = intOrNull(auditTotal);
  const exit = intOrNull(auditExit);

  // An audit "ran" if we were given a total > 0 (criteria parsed) or an exit code.
  const ran = (total !== null && total > 0) || exit !== null;

  if (!ran) {
    return {
      criteria_passed: null,
      criteria_total: null,
      pass_rate: null,
      audit_exit_code: null,
      degraded: true,
    };
  }

  let pass_rate = null;
  if (total !== null && total > 0 && passed !== null) {
    pass_rate = Number((passed / total).toFixed(6));
  }

  return {
    criteria_passed: passed,
    criteria_total: total,
    pass_rate,
    audit_exit_code: exit,
    degraded: pass_rate === null,
  };
}

/**
 * Read the per-slug guard-retry scratch counter written by state-transition.js
 * (<plan-dir>/data/metrics/.guard-retries/<slug>.count). Returns the integer
 * count or null if the file is absent/unreadable. The CLI prefers an explicit
 * --guard-retries flag; this is the fallback source.
 */
export function readGuardRetries(planDir, slug) {
  const file = path.join(planDir, "data", "metrics", ".guard-retries", `${slug}.count`);
  const raw = readFileOrNull(file);
  if (raw === null) return null;
  return intOrNull(raw.trim());
}

/**
 * Build the full metrics record (pure). All I/O is done by the caller and
 * passed in, so the record assembly is unit-testable without a filesystem.
 */
export function buildMetricsRecord(input) {
  const {
    planName,
    slug,
    node,
    stateEntry,
    amendmentLog,
    startRef,
    endRef,
    retrospective,
    contextBytes,
    audit,
    guardRetries,
    inputTokens,
    outputTokens,
    toolCallCount,
    envLabel,
    executor,
  } = input;

  const wall = wallClockSeconds(stateEntry);
  const norm = normalizeStateEntry(stateEntry);

  const amendments = tallyAmendments(amendmentLog, slug);

  const guardCommand = node && typeof node.guard === "string" ? node.guard : null;
  const env_pinned = isEnvPinned(guardCommand, { envLabel: envLabel || undefined });

  // Token telemetry: present only when the orchestrator passed it. method is
  // agent_mcp_usage when ANY token/tool figure is reported, else the byte proxy.
  const haveUsage = inputTokens !== null || outputTokens !== null || toolCallCount !== null;
  const method = haveUsage ? "agent_mcp_usage" : "transcript_byte_proxy";
  const measurement_note = haveUsage
    ? "agent_mcp_usage: orchestrator-reported token/tool telemetry"
    : "transcript_byte_proxy: no MCP usage telemetry — input_tokens_reported=null means not instrumented, not zero";

  // degraded is true when any trust precondition is unmet (spec §1.3):
  //   - retrospective mode (no refs)
  //   - no token telemetry (byte proxy only)
  //   - audit did not run cleanly
  //   - guard retry history unavailable
  //   - either timestamp missing (wall clock null)
  //   - guard not environment-pinned (gate metrics not comparable)
  const degraded =
    retrospective ||
    !haveUsage ||
    audit.degraded ||
    guardRetries === null ||
    wall === null ||
    !env_pinned;

  return {
    schema_version: 1,
    source: "plan-state-machine",
    plan: planName,
    slug,
    kind: node?.kind || null,
    phase: node?.phase || null,
    executor: executor || null,
    degraded,

    timing: {
      started_at: norm.started_at,
      done_at: norm.done_at,
      wall_clock_s: wall,
    },

    context_cost: {
      method,
      context_file_bytes: contextBytes.context_file_bytes,
      shared_md_bytes: contextBytes.shared_md_bytes,
      total_input_bytes: contextBytes.total_input_bytes,
      tool_call_count: toolCallCount,
      input_tokens_reported: inputTokens,
      output_tokens_reported: outputTokens,
      measurement_note,
    },

    authoring: {
      // Authoring fix-loop instrumentation does not exist yet (spec Q2): the
      // iteration/failure counts stay null. fix_loop_present is derivable from
      // amendment_log today, so it is populated.
      gap_check_iterations: null,
      gap_check_failure_count: null,
      fix_loop_present: amendments.fix_loop_present,
    },

    guard: {
      retry_count: guardRetries,
      final_exit_code: 0,
    },

    audit: {
      criteria_passed: audit.criteria_passed,
      criteria_total: audit.criteria_total,
      pass_rate: audit.pass_rate,
      audit_exit_code: audit.audit_exit_code,
    },

    amendments: {
      total: amendments.total,
      by_class: amendments.by_class,
      by_type: amendments.by_type,
    },

    environment: {
      env_label: envLabel || null,
      env_pinned,
    },

    refs: {
      start_ref: retrospective ? null : startRef || null,
      end_ref: retrospective ? null : endRef || null,
    },
  };
}

// ── CLI ──

function main() {
  const args = process.argv.slice(2);
  const positionals = args.filter((a, i) => {
    if (a.startsWith("--")) return false;
    const prev = args[i - 1];
    // skip values that immediately follow a value-bearing --flag
    return !(prev?.startsWith("--") && !VALUELESS_FLAGS.includes(prev));
  });
  const planDir = positionals[0];
  const slug = positionals[1];

  if (!planDir || !slug) {
    process.stderr.write(
      "usage: node scripts/emit-state-metrics.js <plan-dir> <slug> " +
        "[--start-ref <sha> --end-ref <sha>] " +
        "[--audit-passed N --audit-total N --audit-exit N] " +
        "[--guard-retries N] " +
        "[--input-tokens N --output-tokens N --tool-call-count N] " +
        "[--retrospective]\n",
    );
    process.exit(2);
  }
  if (!fs.existsSync(planDir) || !fs.statSync(planDir).isDirectory()) {
    process.stderr.write(`error: not a directory: ${planDir}\n`);
    process.exit(2);
  }

  const retrospective = hasFlag(args, "--retrospective");
  const startRef = retrospective ? null : argValue(args, "--start-ref");
  const endRef = retrospective ? null : argValue(args, "--end-ref");

  const auditPassed = argValue(args, "--audit-passed");
  const auditTotal = argValue(args, "--audit-total");
  const auditExit = argValue(args, "--audit-exit");

  const inputTokens = intOrNull(argValue(args, "--input-tokens"));
  const outputTokens = intOrNull(argValue(args, "--output-tokens"));
  const toolCallCount = intOrNull(argValue(args, "--tool-call-count"));

  const cwd = planDir;

  const dag = readJsonOrNull(path.join(planDir, "dag.json")) || {};
  const state = readJsonOrNull(path.join(planDir, "state.json")) || {};
  const nodes = (dag.nodes && typeof dag.nodes === "object" && dag.nodes) || {};
  const states = (state.states && typeof state.states === "object" && state.states) || {};
  const node = nodes[slug] || {};
  const stateEntry = states[slug] || {};
  const amendmentLog = Array.isArray(state.amendment_log) ? state.amendment_log : [];

  const planName = path.basename(path.resolve(planDir));

  // Guard retries: explicit flag wins; fall back to the scratch counter (unless
  // retrospective, where no scratch history exists → null).
  let guardRetries = intOrNull(argValue(args, "--guard-retries"));
  if (guardRetries === null && !retrospective) {
    guardRetries = readGuardRetries(planDir, slug);
  }

  const contextBytes = measureContextBytes(planDir, slug, startRef, { cwd });
  const audit = computeAudit(auditPassed, auditTotal, auditExit);
  const envLabel = process.env.PLAN_ENV_LABEL || null;
  const executor = currentActor(cwd);

  const record = buildMetricsRecord({
    planName,
    slug,
    node,
    stateEntry,
    amendmentLog,
    startRef,
    endRef,
    retrospective,
    contextBytes,
    audit,
    guardRetries,
    inputTokens,
    outputTokens,
    toolCallCount,
    envLabel,
    executor,
  });

  // ── Resolve the sink (config-driven) and write ──
  const root = repoRoot(planDir);
  const sink = resolveSink(planDir, root, { env: process.env });
  if (sink.warning) process.stderr.write(`${sink.warning}\n`);

  const written = [];
  if (sink.trainingDir) {
    const perStateDir = path.join(sink.trainingDir, "plan-executions");
    const line = `${JSON.stringify(record)}\n`;
    try {
      ensureDir(perStateDir);
      const perStatePath = path.join(perStateDir, `${planName}-${slug}-metrics.jsonl`);
      // Per-record file is idempotent: re-running --complete overwrites rather
      // than appending a duplicate (spec §4.2).
      fs.writeFileSync(perStatePath, line);
      written.push(perStatePath);

      const aggregatePath = path.join(sink.trainingDir, "metrics-aggregate.jsonl");
      fs.appendFileSync(aggregatePath, line);
      written.push(aggregatePath);
    } catch (e) {
      // Sink errors must never block the primary transition (spec §4.1) — log
      // and continue. emit-state-metrics is itself non-fatal to the caller.
      process.stderr.write(`[metrics] sink write degraded: ${e.message ?? e}\n`);
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      metrics_record_written: written.length > 0,
      degraded: record.degraded,
      sink_source: sink.source,
      written,
    })}\n`,
  );
  process.exit(0);
}

// Run as a CLI only when executed directly — importing this module (e.g. unit
// tests exercising the exported pure helpers) must not trigger main().
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
