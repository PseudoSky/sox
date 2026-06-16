#!/usr/bin/env node
/**
 * env-pin-check.js — lint a plan's guards for environment-pinning.
 *
 * Phase 0 of the plan-state-machine evolution plan. Inspects every node's guard
 * command in <plan-dir>/dag.json and reports whether tool resolution looks
 * pinned (per scripts/lib/env-pin.js / metrics-extraction-spec §3.2).
 *
 * Usage:
 *   node scripts/env-pin-check.js <plan-dir> [--strict] [--json]
 *
 *   default   warn-only — prints findings, exits 0 (backward-compatible: old
 *             plans with bare guards still pass so the skill keeps working).
 *   --strict  exit code = number of unpinned guards (publish/CI gate).
 *   --json    machine-readable output for the smoke suite / metrics pipeline.
 *
 * Respects PLAN_ENV_LABEL: a plan that declares an explicit environment gets
 * credit even with otherwise-bare commands.
 *
 * Node stdlib only — no npm dependencies.
 */

import fs from "node:fs";
import path from "node:path";
import { explainPin } from "./lib/env-pin.js";

function readJsonOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function main() {
  const args = process.argv.slice(2);
  const strict = args.includes("--strict");
  const asJson = args.includes("--json");
  const planDir = args.find((a) => !a.startsWith("--"));

  if (!planDir) {
    process.stderr.write("usage: env-pin-check.js <plan-dir> [--strict] [--json]\n");
    process.exit(2);
  }

  const dagPath = path.join(planDir, "dag.json");
  const dag = readJsonOrNull(dagPath);
  if (!dag || typeof dag.nodes !== "object") {
    process.stderr.write(`env-pin-check: no readable dag.json at ${dagPath}\n`);
    process.exit(2);
  }

  const envLabel = process.env.PLAN_ENV_LABEL || "";
  const findings = [];
  for (const [slug, node] of Object.entries(dag.nodes)) {
    const guard = node && typeof node === "object" ? node.guard : null;
    if (guard === undefined || guard === null || guard === "") {
      // A node without a guard is gap-check's concern, not ours; skip silently.
      continue;
    }
    const { pinned, reason } = explainPin(guard, { envLabel });
    findings.push({ slug, guard, pinned, reason });
  }

  const unpinned = findings.filter((f) => !f.pinned);

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify({ plan: path.basename(path.resolve(planDir)), env_label: envLabel || null, findings, unpinned_count: unpinned.length }, null, 2)}\n`,
    );
  } else {
    for (const f of findings) {
      const tag = f.pinned ? "PINNED" : "UNPINNED";
      process.stdout.write(`${tag.padEnd(8)} ${f.slug}: ${f.reason}\n`);
    }
    if (unpinned.length === 0) {
      process.stdout.write(`\nAll ${findings.length} guard(s) environment-pinned.\n`);
    } else {
      process.stdout.write(
        `\n${unpinned.length} of ${findings.length} guard(s) NOT environment-pinned.\n`,
      );
      if (!strict) {
        process.stdout.write("(warn-only; re-run with --strict to fail the gate)\n");
      }
    }
  }

  process.exit(strict ? unpinned.length : 0);
}

main();
