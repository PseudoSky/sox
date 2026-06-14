#!/usr/bin/env node
/**
 * extract-training-record.js — 12-point training capture (Layer 3 / Phase 3).
 *
 * docs/experiments/plan-state-machine-transition-spec.md §2. Called by
 * state-transition.js --complete. Captures everything available at transition
 * time into one structured JSONL record for downstream ML training, then
 * appends to the cross-plan aggregate.
 *
 * Authored to the spec from scratch (reusing the Phase-4 context-parse lib so
 * the extractor agrees with compile-task.js and gap-check.js on how it reads
 * Reservations / acceptance criteria / [ref:X] citations).
 *
 * Usage:
 *   node scripts/extract-training-record.js <plan-dir> <slug> \
 *     --start-ref <sha> --end-ref <sha> --audit-output <escaped-stdout> \
 *     [--audit-exit <n>] [--audit-passed <n>] [--audit-total <n>] [--note <s>]
 *
 * Degraded mode (transition-spec §2): when --start-ref is absent (retrospective
 * extraction of plans predating ref capture), input_context_complete=false,
 * fields 7 & 8 are omitted, and execution.diff is null. Fields 1–6, 10–12 and
 * the outcome are still captured. Node stdlib only.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { repoRoot, currentActor } from "./lib/emit-event.js";
import { normalizeStateEntry } from "./lib/normalize-state.js";
import {
  parseAcceptanceCriteria,
  parseRefCitations,
  parseReservationKey,
} from "./lib/context-parse.js";

function readFileOrNull(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
function readJsonOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function gitShow(cwd, ref, file) {
  if (!ref) return null;
  try {
    return execFileSync("git", ["-C", cwd, "show", `${ref}:${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}
function gitDiff(cwd, a, b, paths) {
  if (!a || !b) return null;
  try {
    const args = ["-C", cwd, "diff", a, b];
    if (Array.isArray(paths) && paths.length) args.push("--", ...paths);
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function main() {
  const args = process.argv.slice(2);
  const positionals = args.filter((a) => !a.startsWith("--"));
  const planDir = positionals[0];
  const slug = positionals[1];
  if (!planDir || !slug) {
    process.stderr.write(
      "usage: extract-training-record.js <plan-dir> <slug> --start-ref <sha> --end-ref <sha> --audit-output <s> [--audit-exit n] [--audit-passed n] [--audit-total n] [--note s]\n",
    );
    process.exit(2);
  }

  const startRef = argValue(args, "--start-ref") || null; // null/"" → degraded
  const endRef = argValue(args, "--end-ref") || null;
  const auditOutput = argValue(args, "--audit-output");
  const auditExit = argValue(args, "--audit-exit");
  const auditPassed = argValue(args, "--audit-passed");
  const auditTotal = argValue(args, "--audit-total");
  const note = argValue(args, "--note");

  const cwd = repoRoot(planDir) || planDir;
  const dag = readJsonOrNull(path.join(planDir, "dag.json")) || {};
  const state = readJsonOrNull(path.join(planDir, "state.json")) || {};
  const nodes = dag.nodes && typeof dag.nodes === "object" ? dag.nodes : {};
  const states = state.states && typeof state.states === "object" ? state.states : {};
  const node = nodes[slug] || {};
  const stateEntry = normalizeStateEntry(states[slug] || {});

  const planName = path.basename(path.resolve(planDir));
  const contextMd = readFileOrNull(path.join(planDir, "contexts", `${slug}.md`));
  const sharedMd = readFileOrNull(path.join(planDir, "contexts", "_shared.md"));
  const degraded = !startRef;

  // Fields 1–6: task inputs (always captured).
  const refsJson = readJsonOrNull(path.join(planDir, "references.json")) || {};
  const citedRefs = parseRefCitations(contextMd || "");
  const task = {
    context_file: contextMd, // 1
    shared_md: sharedMd, // 2
    executor_notes: node.notes ?? null, // 3
    guard_command: node.guard ?? null, // 4
    ac_criteria: parseAcceptanceCriteria(contextMd || ""), // 5 — full per-criterion list, NOT the guard
    references: citedRefs.map((r) => ({ ref: r, entry: refsJson[r] ?? null })), // 6 — only [ref:X]-cited entries
  };

  // Fields 7–8: input context (omitted in degraded mode).
  const input_context = {};
  if (!degraded) {
    const roFiles = parseReservationKey(contextMd || "", "read_only") || [];
    const snapshots = {};
    for (const f of roFiles) snapshots[f] = gitShow(cwd, startRef, f); // 7
    input_context.read_only_snapshots = snapshots;

    const deps = Array.isArray(node.depends_on) ? node.depends_on : [];
    input_context.prior_state_diffs = deps.map((dep) => {
      const d = normalizeStateEntry(states[dep] || {});
      return { slug: dep, start_ref: d.start_ref ?? null, end_ref: d.end_ref ?? null, diff: gitDiff(cwd, d.start_ref, d.end_ref) }; // 8
    });
  }

  // Field 9: execution diff (artifact-scoped + full), null in degraded mode.
  const artifacts = Array.isArray(node.artifacts) ? node.artifacts : [];
  const execution = {
    diff: degraded ? null : { artifact_scoped: gitDiff(cwd, startRef, endRef, artifacts), full: gitDiff(cwd, startRef, endRef) }, // 9
    amendment_log: Array.isArray(state.amendment_log) ? state.amendment_log.filter((e) => e && e.state === slug) : [], // 10
    transition_summary: note ?? null, // 11
  };

  // Field 12: outcome.
  const outcome = {
    audit_output: auditOutput ?? null, // 12 — per-criterion, IDs preserved
    audit_exit: auditExit !== null ? Number.parseInt(auditExit, 10) : null,
    audit_criteria_passed: auditPassed !== null ? Number.parseInt(auditPassed, 10) : null,
    audit_criteria_total: auditTotal !== null ? Number.parseInt(auditTotal, 10) : null,
  };

  // Evidence files (additional): <slug>-evidence.md / acceptance-evidence.md.
  const evidence = {};
  for (const name of [`${slug}-evidence.md`, "acceptance-evidence.md"]) {
    const c = readFileOrNull(path.join(planDir, name));
    if (c !== null) evidence[name] = c;
  }

  const record = {
    schema_version: 1,
    plan: planName,
    slug,
    kind: node.kind ?? null,
    phase: node.phase ?? null,
    executor: stateEntry.executor || currentActor(cwd),
    is_self_referential: node.kind === "audit", // reviewer finding: audit records check the plan itself
    input_context_complete: !degraded,
    task,
    input_context,
    execution,
    outcome,
    evidence_files: evidence,
  };

  // Output: per-state file (one record, overwrite) + aggregate (append).
  const root = repoRoot(planDir);
  const trainingDir = path.join(root || planDir, "data", "training");
  const perStateDir = path.join(trainingDir, "plan-executions");
  let perStateFile = null;
  let aggregateFile = null;
  try {
    fs.mkdirSync(perStateDir, { recursive: true });
    perStateFile = path.join(perStateDir, `${planName}-${slug}.jsonl`);
    fs.writeFileSync(perStateFile, `${JSON.stringify(record)}\n`);
    aggregateFile = path.join(trainingDir, "aggregate.jsonl");
    fs.appendFileSync(aggregateFile, `${JSON.stringify(record)}\n`);
  } catch (e) {
    process.stderr.write(`[extract-training-record] write failed: ${e.message ?? e}\n`);
    process.stdout.write(`${JSON.stringify({ training_record_written: false, input_context_complete: !degraded })}\n`);
    process.exit(0); // never fail the transition over a training-sink write
  }

  process.stdout.write(`${JSON.stringify({ training_record_written: true, input_context_complete: !degraded, per_state_file: perStateFile, aggregate_file: aggregateFile })}\n`);
  process.exit(0);
}

main();
