#!/usr/bin/env node
/**
 * gap-check-instrumented.js — instrumented wrapper around gap-check.js (Layer 3a).
 *
 * Phase 1 of the plan-state-machine evolution plan
 * (docs/experiments/plan-state-machine-failure-capture-spec.md §3.1).
 *
 * Runs the unmodified gap-check.js as a subprocess, passes its stdout/exit code
 * through UNCHANGED (the existing contract is preserved), and emits authoring
 * events on the side: gap_check_run, one gap_check_fail per FAIL line,
 * gap_check_fix_iteration when re-run after a prior failure, and format_footgun
 * for known anti-patterns. The original gap-check.js keeps working for direct
 * callers — instrumentation is purely additive.
 *
 * Usage:
 *   node scripts/gap-check-instrumented.js <plan-dir> [--discover]
 *
 * Node stdlib only.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { emitEvent, readEvents } from "./lib/emit-event.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAP_CHECK = path.join(__dirname, "gap-check.js");

/** Map a FAIL line to a gap-check Check number + subtype, best-effort. */
function classifyFailure(message) {
  const m = message;
  const tests = [
    [/missing from state\.json|missing from dag\.json|slug-set/i, 1, "slug-set-mismatch"],
    [/not in .*mutates|artifacts has/i, 2, "artifacts-mutates-mismatch"],
    [/criterion \[.*\] has no matching check/i, 3, "criterion-audit-id-mismatch"],
    [/depends_on .* not a node|dependency cycle/i, 4, "dependency-integrity"],
    [/is null\/empty/i, 5, "null-gap"],
    [/wrapper key|FLAT slug-keyed|schema_version\/refs/i, 6, "references-wrapper"],
    [/has no audit_check|audit_check .* no matching/i, 7, "reference-no-audit-check"],
    [/Definition-of-Done|\[dod\.|## Definition of Done/i, 8, "dod-no-proving-check"],
    [/unchecked box|final-review/i, 9, "final-review-unticked"],
    [/discovery|caller location/i, 10, "discovery-incomplete"],
  ];
  for (const [re, num, subtype] of tests) {
    if (re.test(m)) return { check_number: num, check_subtype: subtype };
  }
  return { check_number: null, check_subtype: null };
}

/** Parse an affected slug from a FAIL line if present (e.g. contexts/<slug>.md, slug "x"). */
function parseAffectedSlug(message) {
  const ctx = message.match(/contexts\/([a-z0-9-]+)\.md/i);
  if (ctx) return ctx[1];
  const quoted = message.match(/slug "([a-z0-9-]+)"|"([a-z0-9-]+)"\s+which is not a node/i);
  if (quoted) return quoted[1] || quoted[2];
  return null;
}

function countContextFiles(planDir) {
  try {
    return fs.readdirSync(path.join(planDir, "contexts")).filter((f) => f.endsWith(".md") && f !== "_shared.md").length;
  } catch {
    return 0;
  }
}

function main() {
  const args = process.argv.slice(2);
  const planDir = args.find((a) => !a.startsWith("--"));
  const discover = args.includes("--discover");

  if (!planDir) {
    process.stderr.write("usage: gap-check-instrumented.js <plan-dir> [--discover]\n");
    process.exit(2);
  }

  // Prior runs (for fix-iteration + dod-preflight detection) — read BEFORE this run.
  const priorEvents = readEvents(planDir);
  const priorRuns = priorEvents.filter((e) => e.event_type === "gap_check_run");
  const priorRunCount = priorRuns.length;
  const priorFailureCount =
    priorRuns.length > 0 ? (priorRuns[priorRuns.length - 1].detail?.failure_count ?? 0) : 0;

  // Run the unmodified gap-check.js, passing args through.
  const gcArgs = [GAP_CHECK, planDir, ...(discover ? ["--discover"] : [])];
  const r = spawnSync("node", gcArgs, { encoding: "utf8" });
  const stdout = r.stdout || "";
  const exitCode = typeof r.status === "number" ? r.status : 1;

  // Pass output through unchanged.
  if (stdout) process.stdout.write(stdout);
  if (r.stderr) process.stderr.write(r.stderr);

  const lines = stdout.split("\n");
  const failLines = lines.filter((l) => l.startsWith("FAIL "));
  const warnLines = lines.filter((l) => l.trim().startsWith("WARN"));
  const failureCount = failLines.length;
  const warningCount = warnLines.length;
  const contextCount = countContextFiles(planDir);

  // gap_check_run summary event.
  emitEvent(planDir, {
    lifecycle: "authoring",
    event_type: "gap_check_run",
    outcome: failureCount > 0 ? "failure" : "info",
    detail: {
      plan_dir: planDir,
      exit_code: exitCode,
      failure_count: failureCount,
      warning_count: warningCount,
      discover,
      prior_run_count: priorRunCount,
      context_file_count_at_run: contextCount,
    },
  });

  // dod_preflight_skipped: first-ever run happened after several contexts authored.
  if (priorRunCount === 0 && contextCount >= 2) {
    emitEvent(planDir, {
      lifecycle: "authoring",
      event_type: "dod_preflight_skipped",
      outcome: "warning",
      detail: { context_file_count_at_run: contextCount, first_run: true },
    });
  }

  // One gap_check_fail per FAIL line.
  for (const line of failLines) {
    const message = line.slice(5).trim();
    const cls = classifyFailure(message);
    const fileMatch = message.match(/^([^:]+):/);
    emitEvent(planDir, {
      slug: parseAffectedSlug(message),
      lifecycle: "authoring",
      event_type: "gap_check_fail",
      outcome: "failure",
      detail: {
        check_number: cls.check_number,
        check_subtype: cls.check_subtype,
        file: fileMatch ? fileMatch[1].trim() : null,
        message,
        affected_slug: parseAffectedSlug(message),
      },
    });
  }

  // gap_check_fix_iteration when re-running after a prior failing run.
  if (priorRunCount >= 1 && priorFailureCount > 0) {
    emitEvent(planDir, {
      lifecycle: "authoring",
      event_type: "gap_check_fix_iteration",
      outcome: failureCount > 0 ? "rework" : "info",
      iteration: priorRunCount,
      detail: {
        iteration: priorRunCount,
        failures_resolved: priorFailureCount - failureCount,
        failures_remaining: failureCount,
      },
    });
  }

  process.exit(exitCode);
}

main();
