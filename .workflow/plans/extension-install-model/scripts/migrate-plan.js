#!/usr/bin/env node
/**
 * migrate-plan.js — upgrade an OLD plan-state-machine plan to the current format.
 *
 * The skill is backward-compatible (old plans still run), so this migration is
 * OPT-IN — it brings an old plan up to the format that unlocks the full Layer-3
 * benefits (canonical timestamps, ref capture, the transition engine, comparable
 * metrics). It does ONLY the deterministic, idempotent parts and never fabricates
 * data; the one judgment step (pinning each guard) is reported, not guessed.
 *
 * Usage:
 *   node scripts/migrate-plan.js <plan-dir> [--dry-run] [--copy-scripts] [--json]
 *
 * What it does:
 *   1. state.json — normalize legacy timestamp keys (started_ts/done_ts/
 *      completed_at) to canonical started_at/done_at, and add start_ref/end_ref
 *      (null) to every state entry and transition_log entry that lacks them.
 *      Historical refs are NOT backfilled — they stay null (degraded), never faked.
 *   2. --copy-scripts — copy the current skill scripts (+ lib/ + schemas) into
 *      <plan-dir>/scripts/ so executors use the new state-transition.js etc.
 *   3. Report unpinned guards (env-pin) — the manual judgment step.
 *
 * Idempotent: re-running on an already-migrated plan changes nothing.
 * RUN IN A CLEAN GIT TREE so the rewrite is reviewable/revertible.
 * Node stdlib only.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeStateEntry } from "./lib/normalize-state.js";
import { explainPin } from "./lib/env-pin.js";
import { currentIdentity, stampOf } from "./lib/skill-version.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TARGET_SCHEMA_VERSION = 3;

function readJsonOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Normalize one state entry: canonical keys, ref fields, and status vocab. */
function migrateStateEntry(raw) {
  const e = normalizeStateEntry(raw); // canonical started_at/done_at, legacy keys dropped
  if (!("start_ref" in e)) e.start_ref = null;
  if (!("end_ref" in e)) e.end_ref = null;
  // Status-vocab normalization: older plans use "done" for a finished state;
  // the skill's runtime (integrity-check, rollups, transitions) keys off
  // "complete". Map it so that logic actually recognizes finished states.
  if (e.status === "done") e.status = "complete";
  return e;
}

function migrateState(state, identity) {
  const changes = [];
  if (state.schema_version !== TARGET_SCHEMA_VERSION) {
    state.schema_version = TARGET_SCHEMA_VERSION;
    changes.push(`schema_version → ${TARGET_SCHEMA_VERSION}`);
  }
  // Stamp the skill identity this plan was migrated to (provenance + drift signal).
  const stamp = stampOf(identity);
  if (JSON.stringify(state.authored_with) !== JSON.stringify(stamp)) {
    state.authored_with = stamp;
    changes.push(`authored_with → ${identity.id}`);
  }
  if (state.states && typeof state.states === "object") {
    for (const [slug, raw] of Object.entries(state.states)) {
      const before = JSON.stringify(raw);
      const after = migrateStateEntry(raw);
      if (JSON.stringify(after) !== before) changes.push(`state ${slug}: normalized`);
      state.states[slug] = after;
    }
  }
  if (Array.isArray(state.transition_log)) {
    for (const entry of state.transition_log) {
      if (entry && typeof entry === "object") {
        if (!("start_ref" in entry)) {
          entry.start_ref = null;
          changes.push("transition_log: added start_ref");
        }
        if (!("end_ref" in entry)) {
          entry.end_ref = null;
          changes.push("transition_log: added end_ref");
        }
      }
    }
  }
  return changes;
}

/** Copy current skill scripts (+lib +schemas) into the plan, excluding this migrator. */
function copyScripts(planDir) {
  const dest = path.join(planDir, "scripts");
  fs.mkdirSync(path.join(dest, "lib"), { recursive: true });
  const copied = [];
  for (const f of fs.readdirSync(SCRIPT_DIR)) {
    if (f === "migrate-plan.js") continue;
    const src = path.join(SCRIPT_DIR, f);
    if (fs.statSync(src).isFile() && /\.(js|json)$/.test(f)) {
      fs.copyFileSync(src, path.join(dest, f));
      copied.push(f);
    }
  }
  const libDir = path.join(SCRIPT_DIR, "lib");
  if (fs.existsSync(libDir)) {
    for (const f of fs.readdirSync(libDir)) {
      if (/\.js$/.test(f)) {
        fs.copyFileSync(path.join(libDir, f), path.join(dest, "lib", f));
        copied.push(`lib/${f}`);
      }
    }
  }
  return copied;
}

/** Report unpinned guards (the manual judgment step). */
function unpinnedGuards(planDir) {
  const dag = readJsonOrNull(path.join(planDir, "dag.json")) || {};
  const nodes = dag.nodes && typeof dag.nodes === "object" ? dag.nodes : {};
  const out = [];
  for (const [slug, node] of Object.entries(nodes)) {
    const guard = node && node.guard;
    if (!guard) continue;
    const { pinned, reason } = explainPin(guard, { envLabel: process.env.PLAN_ENV_LABEL });
    if (!pinned) out.push({ slug, guard, reason });
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const doCopy = args.includes("--copy-scripts");
  const asJson = args.includes("--json");
  const planDir = args.find((a) => !a.startsWith("--"));

  if (!planDir) {
    process.stderr.write("usage: migrate-plan.js <plan-dir> [--dry-run] [--copy-scripts] [--json]\n");
    process.exit(2);
  }
  const statePath = path.join(planDir, "state.json");
  const state = readJsonOrNull(statePath);
  if (!state) {
    process.stderr.write(`migrate-plan: no readable state.json at ${statePath}\n`);
    process.exit(2);
  }

  const identity = currentIdentity(SCRIPT_DIR);
  const changes = migrateState(state, identity);
  let scriptsCopied = [];
  if (!dryRun) {
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    if (doCopy) scriptsCopied = copyScripts(planDir);
  } else if (doCopy) {
    scriptsCopied = ["(dry-run: scripts NOT copied)"];
  }

  const guards = unpinnedGuards(planDir);
  const result = {
    plan: path.basename(path.resolve(planDir)),
    dry_run: dryRun,
    migrated_to: identity.id,
    state_changes: changes,
    scripts_copied: scriptsCopied,
    unpinned_guards: guards,
    next_steps: [
      "Pin each unpinned guard (./node_modules/.bin/<tool> or npx --yes <tool>).",
      "Run: node scripts/gap-check.js <plan-dir> --discover",
      "Run: node scripts/consistency-check.js <plan-dir> --no-emit",
      "Run: node scripts/integrity-check.js <plan-dir>",
    ],
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`migrate-plan: ${result.plan}${dryRun ? " (dry-run)" : ""}\n`);
    process.stdout.write(`  state.json changes: ${changes.length ? changes.join("; ") : "none (already current)"}\n`);
    if (doCopy) process.stdout.write(`  scripts copied: ${scriptsCopied.length}\n`);
    if (guards.length) {
      process.stdout.write(`  UNPINNED GUARDS (pin these manually):\n`);
      for (const g of guards) process.stdout.write(`    - ${g.slug}: ${g.reason}\n`);
    } else {
      process.stdout.write("  all guards env-pinned.\n");
    }
  }
  process.exit(0);
}

main();
