/**
 * emit-event.js — append-only failure/rework event emitter (Layer 3a).
 *
 * Phase 1 of the plan-state-machine evolution plan
 * (docs/experiments/plan-state-machine-failure-capture-spec.md).
 *
 * THE KEYSTONE of failure capture: every instrumented tool
 * (gap-check-instrumented.js, state-transition.js, integrity-check.js,
 * consistency-check.js) emits through emitEvent — never via LLM self-report
 * (self-reported failures get rationalized away; S1 "pre-existing red").
 *
 * Writes one ndjson record per call to BOTH:
 *   <plan-dir>/events.ndjson                 (per-plan, authoritative)
 *   <repo-root>/data/training/failure-events.ndjson  (cross-plan aggregate)
 *
 * Both are append-only. emitEvent MUST NOT throw on write failure — it degrades
 * silently and logs to stderr (spec §3.2), so instrumentation can never crash
 * the transition it wraps.
 *
 * Node stdlib only — no npm dependencies (the skill must run in an isolated
 * agent context). The event grammar is validated by a hand-rolled checker that
 * mirrors failure-event.schema.json; the schema file remains the external
 * contract for downstream validators.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const LIFECYCLES = ["authoring", "execution"];
export const OUTCOMES = ["failure", "rework", "warning", "info"];
export const KINDS = ["work", "audit", "review", null];
export const EVENT_TYPES = [
  // authoring
  "gap_check_run",
  "gap_check_fail",
  "gap_check_fix_iteration",
  "format_footgun",
  "dod_preflight_skipped",
  "planner_no_bash",
  "consistency_check_fail",
  // execution
  "state_start",
  "state_start_resume",
  "state_start_blocked",
  "guard_fail",
  "guard_retry",
  "guard_pass",
  "audit_criterion_fail",
  "audit_criterion_pass",
  "audit_run_complete",
  "amendment_executor",
  "amendment_planner",
  "state_complete",
  "state_complete_audit_fail",
  "guard_bypass_suspected",
  "env_gate_flip",
  "context_interrupted",
  "audit_at_wrong_ref",
  "out_of_order_attempt",
];

const REQUIRED = [
  "ts",
  "plan",
  "slug",
  "phase",
  "kind",
  "by",
  "lifecycle",
  "event_type",
  "outcome",
  "iteration",
  "start_ref",
  "end_ref",
  "detail",
  "complete",
];

/** Current ISO-8601 timestamp with milliseconds. */
export function nowIso() {
  return new Date().toISOString();
}

/** Best-effort actor identity: SOX_AGENT_NAME, then git user.name, else "unknown". */
export function currentActor(cwd) {
  if (process.env.SOX_AGENT_NAME) return process.env.SOX_AGENT_NAME;
  try {
    const name = execFileSync("git", ["config", "user.name"], {
      cwd: cwd || process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (name) return name;
  } catch {}
  return "unknown";
}

/** Resolve the repo root that contains <plan-dir>; falls back to walking up for package.json. */
export function repoRoot(planDir) {
  try {
    return execFileSync("git", ["-C", planDir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {}
  let d = path.resolve(planDir);
  while (d !== path.dirname(d)) {
    if (fs.existsSync(path.join(d, "package.json"))) return d;
    d = path.dirname(d);
  }
  return null;
}

/**
 * Validate an event against the failure-event grammar.
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateEvent(event) {
  const errors = [];
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return { valid: false, errors: ["event is not an object"] };
  }
  for (const k of REQUIRED) {
    if (!(k in event)) errors.push(`missing required field: ${k}`);
  }
  for (const k of Object.keys(event)) {
    if (!REQUIRED.includes(k)) errors.push(`unknown field: ${k}`);
  }
  const str = (k) => typeof event[k] === "string";
  const strOrNull = (k) => event[k] === null || typeof event[k] === "string";
  if ("ts" in event && !str("ts")) errors.push("ts must be a string");
  if ("plan" in event && !str("plan")) errors.push("plan must be a string");
  if ("slug" in event && !strOrNull("slug")) errors.push("slug must be string|null");
  if ("phase" in event && !strOrNull("phase")) errors.push("phase must be string|null");
  if ("kind" in event && !KINDS.includes(event.kind)) errors.push(`kind must be one of ${KINDS}`);
  if ("by" in event && !str("by")) errors.push("by must be a string");
  if ("lifecycle" in event && !LIFECYCLES.includes(event.lifecycle))
    errors.push(`lifecycle must be one of ${LIFECYCLES}`);
  if ("event_type" in event && !EVENT_TYPES.includes(event.event_type))
    errors.push(`event_type not in enum: ${event.event_type}`);
  if ("outcome" in event && !OUTCOMES.includes(event.outcome))
    errors.push(`outcome must be one of ${OUTCOMES}`);
  if ("iteration" in event && (!Number.isInteger(event.iteration) || event.iteration < 1))
    errors.push("iteration must be an integer >= 1");
  if ("start_ref" in event && !strOrNull("start_ref")) errors.push("start_ref must be string|null");
  if ("end_ref" in event && !strOrNull("end_ref")) errors.push("end_ref must be string|null");
  if ("detail" in event && (typeof event.detail !== "object" || event.detail === null || Array.isArray(event.detail)))
    errors.push("detail must be an object");
  if ("complete" in event && typeof event.complete !== "boolean")
    errors.push("complete must be a boolean");
  return { valid: errors.length === 0, errors };
}

/**
 * Fill envelope defaults onto a partial event. Caller supplies at least
 * `event_type`, `lifecycle`, `outcome`, and a `detail` object; everything else
 * is defaulted. `plan` is derived from planDir if absent.
 */
export function buildEvent(planDir, partial = {}) {
  const planName = partial.plan || path.basename(path.resolve(planDir));
  return {
    ts: partial.ts || nowIso(),
    plan: planName,
    slug: partial.slug ?? null,
    phase: partial.phase ?? null,
    kind: partial.kind ?? null,
    by: partial.by || currentActor(planDir),
    lifecycle: partial.lifecycle,
    event_type: partial.event_type,
    outcome: partial.outcome,
    iteration: Number.isInteger(partial.iteration) ? partial.iteration : 1,
    start_ref: partial.start_ref ?? null,
    end_ref: partial.end_ref ?? null,
    detail: partial.detail && typeof partial.detail === "object" ? partial.detail : {},
    complete: typeof partial.complete === "boolean" ? partial.complete : true,
  };
}

function appendLine(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${line}\n`);
}

/**
 * Emit one event. Builds the envelope, validates, and appends to the per-plan
 * log and the cross-plan aggregate. Never throws — returns a result object and
 * logs problems to stderr.
 *
 * @returns {{ok: boolean, written: string[], errors: string[]}}
 */
export function emitEvent(planDir, partial) {
  const event = buildEvent(planDir, partial);
  const { valid, errors } = validateEvent(event);
  if (!valid) {
    process.stderr.write(`[emit-event] invalid event (${event.event_type}); not written: ${errors.join("; ")}\n`);
    return { ok: false, written: [], errors };
  }

  const line = JSON.stringify(event);
  const written = [];
  const writeErrors = [];

  const perPlan = path.join(planDir, "events.ndjson");
  try {
    appendLine(perPlan, line);
    written.push(perPlan);
  } catch (e) {
    writeErrors.push(`per-plan: ${e.message ?? e}`);
  }

  const root = repoRoot(planDir);
  if (root) {
    const aggregate = path.join(root, "data", "training", "failure-events.ndjson");
    try {
      appendLine(aggregate, line);
      written.push(aggregate);
    } catch (e) {
      writeErrors.push(`aggregate: ${e.message ?? e}`);
    }
  }

  if (writeErrors.length) {
    process.stderr.write(`[emit-event] write degraded (${event.event_type}): ${writeErrors.join("; ")}\n`);
  }
  return { ok: written.length > 0, written, errors: writeErrors };
}

/** Read and parse a plan's per-plan event log; returns [] if absent/unreadable. */
export function readEvents(planDir) {
  const file = path.join(planDir, "events.ndjson");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {}
  }
  return out;
}
