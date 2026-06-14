#!/usr/bin/env node
/**
 * skill-version-check.js — plan ⇄ skill drift check.
 *
 * Compares a plan's recorded `state.json` `authored_with` identity against the
 * current skill identity (plugin@version+hash). If they differ — or the plan
 * predates stamping (`authored_with` absent) — the plan may need migration /
 * re-validation. This replaces brittle field-shape sniffing with a clean
 * identity comparison.
 *
 * Usage:
 *   node scripts/skill-version-check.js <plan-dir> [--json] [--strict]
 *
 * Exit: 0 in sync; 1 drift / unstamped (only fails the gate under --strict).
 * Node stdlib only.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { currentIdentity, formatId } from "./lib/skill-version.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const strict = args.includes("--strict");
  const planDir = args.find((a) => !a.startsWith("--"));

  if (!planDir) {
    process.stderr.write("usage: skill-version-check.js <plan-dir> [--json] [--strict]\n");
    process.exit(2);
  }
  let state;
  try {
    state = JSON.parse(fs.readFileSync(path.join(planDir, "state.json"), "utf8"));
  } catch {
    process.stderr.write(`skill-version-check: no readable state.json at ${planDir}\n`);
    process.exit(2);
  }

  const current = currentIdentity(SCRIPT_DIR);
  const stamped = state.authored_with || null;
  const planId = stamped ? formatId(stamped) : null;
  const inSync = Boolean(stamped) && stamped.hash === current.hash;
  const status = !stamped ? "unstamped" : inSync ? "in-sync" : "drift";

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ plan: path.basename(path.resolve(planDir)), status, plan_identity: planId, current_identity: current.id }, null, 2)}\n`);
  } else if (status === "in-sync") {
    process.stdout.write(`skill-version-check: in sync (${current.id}).\n`);
  } else if (status === "unstamped") {
    process.stdout.write(`UNSTAMPED: plan has no authored_with — run migrate-plan.js to stamp it (current: ${current.id}).\n`);
  } else {
    process.stdout.write(`DRIFT: plan authored_with ${planId} != current ${current.id} — consider re-validating/migrating.\n`);
  }

  process.exit(strict && status !== "in-sync" ? 1 : 0);
}

main();
