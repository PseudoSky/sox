#!/usr/bin/env node
/**
 * integrity-check.js — structural silent-failure detection (Layer 3a).
 *
 * Phase 1 of the plan-state-machine evolution plan
 * (docs/experiments/plan-state-machine-failure-capture-spec.md §3.3–3.4).
 *
 * "Absence is an event." Relying on the executor to self-report a bypassed
 * guard is structurally insufficient — rationalization happens at the human
 * seam (S1). So this watchdog detects bypass from STATE, not from self-report:
 *
 *   1. For every `status: complete` slug in state.json that has NO matching
 *      `state_complete` / `state_complete_audit_fail` event in events.ndjson,
 *      emit `guard_bypass_suspected` — the missing expected event is itself an
 *      event, making the silent failure impossible to omit from the record.
 *   2. For every `in_progress` slug whose start timestamp is older than the
 *      threshold, emit `context_interrupted`.
 *
 * Usage:
 *   node scripts/integrity-check.js <plan-dir> [--threshold-seconds N] [--json]
 *
 * Exit code = number of guard_bypass_suspected events emitted (0 = clean), so
 * it can gate CI / pre-flight. Node stdlib only.
 */

import fs from "node:fs";
import path from "node:path";

import { emitEvent, readEvents } from "./lib/emit-event.js";
import { normalizeStateEntry } from "./lib/normalize-state.js";

const DEFAULT_THRESHOLD_SECONDS = 7200; // 2h

function readJsonOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const ti = args.indexOf("--threshold-seconds");
  const thresholdArg = ti >= 0 ? args[ti + 1] : null;
  const thresholdSeconds = thresholdArg ? Number.parseInt(thresholdArg, 10) : DEFAULT_THRESHOLD_SECONDS;
  const planDir = args.find((a) => !a.startsWith("--") && a !== thresholdArg);

  if (!planDir) {
    process.stderr.write("usage: integrity-check.js <plan-dir> [--threshold-seconds N] [--json]\n");
    process.exit(2);
  }

  const state = readJsonOrNull(path.join(planDir, "state.json"));
  if (!state || typeof state.states !== "object") {
    process.stderr.write(`integrity-check: no readable state.json at ${planDir}\n`);
    process.exit(2);
  }

  const dag = readJsonOrNull(path.join(planDir, "dag.json")) || {};
  const nodes = (dag.nodes && typeof dag.nodes === "object" && dag.nodes) || {};
  const events = readEvents(planDir);

  // Slugs that have a completion event recorded.
  const completedInLog = new Set(
    events
      .filter((e) => e.event_type === "state_complete" || e.event_type === "state_complete_audit_fail")
      .map((e) => e.slug),
  );

  const bypasses = [];
  const interruptions = [];
  const nowMs = Date.now();

  for (const [slug, rawEntry] of Object.entries(state.states)) {
    const entry = normalizeStateEntry(rawEntry);
    const node = nodes[slug] || {};
    const common = { slug, phase: node.phase ?? null, kind: node.kind ?? null };

    if (entry.status === "complete" && !completedInLog.has(slug)) {
      bypasses.push(slug);
      emitEvent(planDir, {
        ...common,
        lifecycle: "execution",
        event_type: "guard_bypass_suspected",
        outcome: "failure",
        end_ref: entry.end_ref ?? null,
        detail: {
          detection_method: "no-guard-pass-event-before-complete",
          state_complete_ts: entry.done_at ?? null,
          last_event_ts: events.length ? events[events.length - 1].ts : null,
        },
      });
    }

    if (entry.status === "in_progress" && entry.started_at) {
      const startedMs = Date.parse(entry.started_at);
      if (!Number.isNaN(startedMs)) {
        const elapsed = Math.round((nowMs - startedMs) / 1000);
        if (elapsed > thresholdSeconds) {
          interruptions.push(slug);
          emitEvent(planDir, {
            ...common,
            lifecycle: "execution",
            event_type: "context_interrupted",
            outcome: "warning",
            start_ref: entry.start_ref ?? null,
            detail: {
              started_at: entry.started_at,
              elapsed_seconds: elapsed,
              threshold_seconds: thresholdSeconds,
              last_commit_sha: entry.start_ref ?? null,
            },
          });
        }
      }
    }
  }

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify({ plan: path.basename(path.resolve(planDir)), guard_bypass_suspected: bypasses, context_interrupted: interruptions }, null, 2)}\n`,
    );
  } else {
    if (bypasses.length === 0 && interruptions.length === 0) {
      process.stdout.write("integrity-check: clean — every complete slug has a completion event.\n");
    } else {
      for (const s of bypasses) process.stdout.write(`BYPASS_SUSPECTED ${s}: complete in state.json, no completion event\n`);
      for (const s of interruptions) process.stdout.write(`INTERRUPTED ${s}: in_progress past threshold\n`);
    }
  }

  process.exit(bypasses.length);
}

main();
