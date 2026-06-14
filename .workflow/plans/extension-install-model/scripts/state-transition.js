#!/usr/bin/env node
/**
 * state-transition.js — atomic state transitions + ref capture (Layer 3).
 *
 * Phase 3 of the plan-state-machine evolution plan
 * (docs/experiments/plan-state-machine-transition-spec.md). The executor calls
 * this instead of hand-editing state.json. It makes transitions atomic, records
 * git refs (start_ref/end_ref — the gap that made training extraction
 * impossible), auto-runs the audit, and hooks the failure-event stream (Phase 1),
 * the metrics record (Phase 2), and the training extractor.
 *
 * Interface:
 *   node scripts/state-transition.js <plan-dir> <slug> --start
 *   node scripts/state-transition.js <plan-dir> <slug> --complete --note "<summary>"
 *   node scripts/state-transition.js <plan-dir> <slug> --amend --class executor \
 *        --type <type> --reason "<why>" --files "a.ts,b.ts"
 *
 * Exit codes (the orchestrator signal):
 *   0 complete (guard+audit pass) / start ok / amend ok
 *   1 guard failed (executor fixes + retries --complete)
 *   2 planner-class escalation (state set blocked)
 *   3 depends_on not satisfied (out-of-order)
 *   4 audit failed (state complete but criteria unmet)
 *
 * Guards run from the repo root (where ./node_modules/.bin lives — the Phase-0
 * env-pin convention). The audit script is resolved inside the plan dir and run
 * from there. Node stdlib only.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { emitEvent, readEvents, repoRoot, currentActor } from "./lib/emit-event.js";
import { normalizeStateEntry } from "./lib/normalize-state.js";
import { currentIdentity, stampOf } from "./lib/skill-version.js";

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);

function nowIso() {
  return new Date().toISOString();
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
function gitHead(cwd) {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
function gitCommitBookkeeping(cwd, planDir, message) {
  try {
    execFileSync("git", ["-C", cwd, "add", path.join(planDir, "state.json")], { stdio: "ignore" });
    execFileSync("git", ["-C", cwd, "commit", "-m", message, "--no-verify"], { stdio: "ignore" });
    return true;
  } catch {
    return false; // best-effort; state.json on disk is the source of truth
  }
}
function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

/** Parse [slug.N] PASS/FAIL lines from audit stdout. */
function parseAuditCriteria(stdout) {
  const re = /\[([a-z0-9-]+\.[A-Za-z0-9_-]+)\]\s+(PASS|FAIL)\b/g;
  const results = [];
  let m;
  while ((m = re.exec(stdout)) !== null) results.push({ id: m[1], pass: m[2] === "PASS", line: m[0] });
  return results;
}

/** Resolve and run the phase audit script inside the plan dir. Returns null if none. */
function runAudit(planDir, phase) {
  const scriptsDir = path.join(planDir, "scripts");
  let script = null;
  try {
    script = fs.readdirSync(scriptsDir).find((f) => /^audit.*\.py$/.test(f));
  } catch {
    return null;
  }
  if (!script) return null;
  const r = spawnSync("python3", [path.join("scripts", script), "--phase", String(phase ?? "")], {
    cwd: planDir,
    encoding: "utf8",
  });
  const stdout = (r.stdout || "") + (r.stderr || "");
  return { script, exit: typeof r.status === "number" ? r.status : 1, stdout };
}

function loadPlan(planDir) {
  const dag = readJson(path.join(planDir, "dag.json"));
  const state = readJson(path.join(planDir, "state.json"));
  return { dag, state, nodes: dag.nodes || {}, states: state.states || {} };
}

function commonFields(node, slug) {
  return { slug, phase: node?.phase ?? null, kind: node?.kind ?? null };
}

// ── --start ──────────────────────────────────────────────────────────────────

function cmdStart(planDir, slug) {
  const { state, nodes, states } = loadPlan(planDir);
  const node = nodes[slug];
  const root = repoRoot(planDir) || planDir;
  if (!node) {
    process.stderr.write(`error: slug "${slug}" not in dag.json\n`);
    process.exit(2);
  }

  // Resume idempotency.
  const entry = normalizeStateEntry(states[slug] || {});
  if (entry.status === "in_progress") {
    emitEvent(planDir, { ...commonFields(node, slug), lifecycle: "execution", event_type: "state_start_resume", outcome: "info", start_ref: entry.start_ref ?? null, detail: { resumed_from: entry.start_ref ?? null } });
    process.stdout.write(`Resuming ${slug} from existing start_ref ${entry.start_ref ?? "(none)"}\n`);
    process.exit(0);
  }

  // depends_on must all be complete.
  const deps = Array.isArray(node.depends_on) ? node.depends_on : [];
  const unmet = deps.filter((d) => normalizeStateEntry(states[d] || {}).status !== "complete");
  if (unmet.length) {
    emitEvent(planDir, { ...commonFields(node, slug), lifecycle: "execution", event_type: "state_start_blocked", outcome: "failure", detail: { unmet_dependencies: unmet } });
    process.stderr.write(`error: depends_on not satisfied for "${slug}": ${unmet.join(", ")}\n`);
    process.exit(3);
  }

  // Stale in_progress scan → context_interrupted (other slugs).
  const threshold = Number.parseInt(process.env.PLAN_INTERRUPT_THRESHOLD_S || "7200", 10);
  for (const [s, raw] of Object.entries(states)) {
    if (s === slug) continue;
    const e = normalizeStateEntry(raw);
    if (e.status === "in_progress" && e.started_at) {
      const elapsed = Math.round((Date.now() - Date.parse(e.started_at)) / 1000);
      if (!Number.isNaN(elapsed) && elapsed > threshold) {
        emitEvent(planDir, { ...commonFields(nodes[s], s), lifecycle: "execution", event_type: "context_interrupted", outcome: "warning", start_ref: e.start_ref ?? null, detail: { started_at: e.started_at, elapsed_seconds: elapsed, threshold_seconds: threshold, last_commit_sha: e.start_ref ?? null } });
      }
    }
  }

  const startRef = gitHead(root);
  states[slug] = { ...states[slug], status: "in_progress", started_at: nowIso(), start_ref: startRef };
  state.states = states;
  state.current_state = slug;
  // Stamp the skill identity this plan is being executed against (provenance + drift signal).
  state.authored_with = stampOf(currentIdentity(SCRIPT_DIR));
  writeJsonAtomic(path.join(planDir, "state.json"), state);
  gitCommitBookkeeping(root, planDir, `chore(plan): start state ${slug} [state-transition:${slug}:start]`);

  emitEvent(planDir, { ...commonFields(node, slug), lifecycle: "execution", event_type: "state_start", outcome: "info", start_ref: startRef, detail: { started_at: states[slug].started_at } });
  process.stdout.write(`${JSON.stringify({ status: "started", slug, start_ref: startRef })}\n`);
  process.exit(0);
}

// ── --complete ─────────────────────────────────────────────────────────────

function cmdComplete(planDir, slug, args) {
  const note = argValue(args, "--note") || "";
  const { state, nodes, states } = loadPlan(planDir);
  const node = nodes[slug];
  const root = repoRoot(planDir) || planDir;
  if (!node) {
    process.stderr.write(`error: slug "${slug}" not in dag.json\n`);
    process.exit(2);
  }
  const entry = normalizeStateEntry(states[slug] || {});
  const startRef = entry.start_ref ?? null;

  // Run the guard from the repo root.
  const guard = node.guard || "true";
  const g = spawnSync(guard, { shell: true, cwd: root, encoding: "utf8" });
  const guardExit = typeof g.status === "number" ? g.status : 1;
  if (guardExit !== 0) {
    const priorFails = readEvents(planDir).filter((e) => e.slug === slug && (e.event_type === "guard_fail" || e.event_type === "guard_retry"));
    const retryNumber = priorFails.length;
    emitEvent(planDir, {
      ...commonFields(node, slug),
      lifecycle: "execution",
      event_type: retryNumber > 0 ? "guard_retry" : "guard_fail",
      outcome: "failure",
      start_ref: startRef,
      iteration: retryNumber + 1,
      detail: {
        guard_command: guard,
        exit_code: guardExit,
        stdout_tail: (g.stdout || "").slice(-500),
        stderr_tail: (g.stderr || "").slice(-500),
        retry_number: retryNumber,
        env_snapshot: { PATH_has_node_modules_bin: (process.env.PATH || "").includes("node_modules/.bin"), shell: process.env.SHELL || null },
      },
    });
    process.stderr.write(`guard failed (exit ${guardExit}) for "${slug}". Fix and re-run --complete.\n${g.stdout || ""}${g.stderr || ""}`);
    process.exit(1);
  }

  const endRef = gitHead(root);
  emitEvent(planDir, { ...commonFields(node, slug), lifecycle: "execution", event_type: "guard_pass", outcome: "info", start_ref: startRef, end_ref: endRef, detail: { guard_command: guard } });

  // Audit run (per-criterion).
  const audit = runAudit(planDir, node.phase);
  const criteria = audit ? parseAuditCriteria(audit.stdout) : [];
  const passed = criteria.filter((c) => c.pass).length;
  const total = criteria.length;
  const auditExit = audit ? audit.exit : 0;
  if (audit) {
    emitEvent(planDir, { ...commonFields(node, slug), lifecycle: "execution", event_type: "audit_run_complete", outcome: auditExit === 0 ? "info" : "failure", start_ref: startRef, end_ref: endRef, detail: { audit_script: audit.script, phase: node.phase ?? null, exit_code: auditExit, criteria_passed: passed, criteria_failed: total - passed, criteria_total: total, audit_ref: endRef, ran_at_end_ref: true } });
    for (const c of criteria.filter((x) => !x.pass)) {
      emitEvent(planDir, { ...commonFields(node, slug), lifecycle: "execution", event_type: "audit_criterion_fail", outcome: "failure", start_ref: startRef, end_ref: endRef, detail: { criterion_id: c.id, phase: node.phase ?? null, failure_message: c.line, audit_script: audit.script, audit_ref: endRef } });
    }
  }

  // Training record extraction (transition-spec §2), best-effort. The extractor
  // is spec-authored (12-point capture); a sink-write failure must never fail
  // the transition.
  let trainingWritten = false;
  try {
    const extractor = path.join(SCRIPT_DIR, "extract-training-record.js");
    const ex = spawnSync("node", [extractor, planDir, slug, "--start-ref", startRef || "", "--end-ref", endRef || "", "--audit-output", audit ? audit.stdout : "", "--audit-exit", String(auditExit), "--audit-passed", String(passed), "--audit-total", String(total), "--note", note], { encoding: "utf8" });
    trainingWritten = ex.status === 0 && /"training_record_written":true/.test(ex.stdout || "");
  } catch {}

  // Write state.json complete + advance current_state.
  const prev = state.current_state || null;
  const auditPass = auditExit === 0;
  states[slug] = { ...states[slug], status: "complete", done_at: nowIso(), end_ref: endRef };
  state.states = states;
  state.transition_log = Array.isArray(state.transition_log) ? state.transition_log : [];
  state.transition_log.push({ ts: nowIso(), from: prev, to: slug, start_ref: startRef, end_ref: endRef, audit_exit: auditExit, audit_criteria_passed: passed, audit_criteria_total: total, by: currentActor(root), note });
  // next pending whose deps are all complete
  const nextState = Object.keys(nodes).find((s) => {
    const st = normalizeStateEntry(states[s] || {});
    if (st.status !== "pending" && st.status !== undefined && st.status) return false;
    if (st.status === "complete" || st.status === "in_progress" || st.status === "blocked") return false;
    const deps = Array.isArray(nodes[s].depends_on) ? nodes[s].depends_on : [];
    return deps.every((d) => normalizeStateEntry(states[d] || {}).status === "complete");
  });
  state.current_state = nextState || "done";
  writeJsonAtomic(path.join(planDir, "state.json"), state);
  gitCommitBookkeeping(root, planDir, `chore(plan): complete state ${slug} [state-transition:${slug}:complete]`);

  // Metrics (Phase 2, best-effort).
  try {
    const metrics = path.join(SCRIPT_DIR, "emit-state-metrics.js");
    spawnSync("node", [metrics, planDir, slug, "--start-ref", startRef || "", "--end-ref", endRef || "", "--audit-passed", String(passed), "--audit-total", String(total), "--audit-exit", String(auditExit)], { encoding: "utf8" });
  } catch {}

  emitEvent(planDir, { ...commonFields(node, slug), lifecycle: "execution", event_type: auditPass ? "state_complete" : "state_complete_audit_fail", outcome: auditPass ? "info" : "failure", start_ref: startRef, end_ref: endRef, detail: { audit_exit: auditExit, criteria_passed: passed, criteria_total: total } });

  const out = { status: auditPass ? "complete" : "audit_failed", slug, end_ref: endRef, audit_pass: auditPass, audit_criteria_passed: passed, audit_criteria_total: total, next_state: state.current_state, training_record_written: trainingWritten, note };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(auditPass ? 0 : 4);
}

// ── --amend ──────────────────────────────────────────────────────────────────

function cmdAmend(planDir, slug, args) {
  const klass = argValue(args, "--class");
  const type = argValue(args, "--type");
  const reason = argValue(args, "--reason");
  const filesArg = argValue(args, "--files");
  if (!klass || !type || !reason) {
    process.stderr.write("error: --amend requires --class, --type, --reason (and --files for executor)\n");
    process.exit(2);
  }
  const { state, nodes, states } = loadPlan(planDir);
  const node = nodes[slug] || {};
  const root = repoRoot(planDir) || planDir;
  const files = filesArg ? filesArg.split(",").map((s) => s.trim()).filter(Boolean) : [];

  state.amendment_log = Array.isArray(state.amendment_log) ? state.amendment_log : [];
  state.amendment_log.push({ ts: nowIso(), state: slug, class: klass, type, reason, files_synced: files, by: currentActor(root) });

  const isPlanner = klass === "planner";
  if (isPlanner) states[slug] = { ...states[slug], status: "blocked" };
  state.states = states;
  writeJsonAtomic(path.join(planDir, "state.json"), state);
  gitCommitBookkeeping(root, planDir, `chore(plan): amend state ${slug} [state-transition:${slug}:amend]`);

  emitEvent(planDir, { ...commonFields(node, slug), lifecycle: "execution", event_type: isPlanner ? "amendment_planner" : "amendment_executor", outcome: isPlanner ? "rework" : "warning", detail: { amendment_type: type, reason, files_synced: files, prior_ref: null } });

  if (isPlanner) {
    process.stderr.write(`planner-class escalation on "${slug}" — state set to blocked.\n`);
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify({ status: "amended", slug, class: klass, type })}\n`);
  process.exit(0);
}

function main() {
  const args = process.argv.slice(2);
  const positionals = args.filter((a) => !a.startsWith("--"));
  const planDir = positionals[0];
  const slug = positionals[1];
  if (!planDir || !slug) {
    process.stderr.write("usage: state-transition.js <plan-dir> <slug> --start|--complete|--amend [...]\n");
    process.exit(2);
  }
  if (args.includes("--start")) return cmdStart(planDir, slug);
  if (args.includes("--complete")) return cmdComplete(planDir, slug, args);
  if (args.includes("--amend")) return cmdAmend(planDir, slug, args);
  process.stderr.write("error: one of --start | --complete | --amend is required\n");
  process.exit(2);
}

main();
