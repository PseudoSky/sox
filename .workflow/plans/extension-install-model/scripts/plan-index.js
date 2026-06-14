#!/usr/bin/env node
/**
 * plan-index.js — corpus registry (Layer 0).
 *
 * docs/experiments/plan-state-machine-layer0-corpus-spec.md §2.1, §4.
 *
 * Maintains <plans-root>/plan-index.json: one row per plan (status, mutate_set,
 * references, assumed_baseline, derived depends_on). The substrate for
 * cross-plan-check.js. Auto-updated per plan via --update (the gap-5 hook).
 *
 * Usage:
 *   node scripts/plan-index.js <plans-root> [--update <plan-dir>] [--json]
 *
 * Project-index propagation (minimal, §4): if PROJECT_INDEX_SINK env or a
 * <plans-root>/.project-index-sink file names a path, the index delta is also
 * appended there (the cross-project registry) — same sink pattern as the
 * metrics extractor's AGENT_FORGE_SINK. Node stdlib only.
 */

import fs from "node:fs";
import path from "node:path";

import { findPlanDirs, scanPlan } from "./lib/plan-scan.js";

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

function resolveProjectSink(plansRoot) {
  if (process.env.PROJECT_INDEX_SINK) return process.env.PROJECT_INDEX_SINK;
  const f = path.join(plansRoot, ".project-index-sink");
  try {
    const v = fs.readFileSync(f, "utf8").trim();
    if (v) return v;
  } catch {}
  return null;
}

function propagate(plansRoot, index) {
  const sink = resolveProjectSink(plansRoot);
  if (!sink) return null;
  try {
    fs.mkdirSync(path.dirname(sink), { recursive: true });
    const delta = { ts: new Date().toISOString(), plans_root: plansRoot, plan_count: index.plans.length, plan_index: path.join(plansRoot, "plan-index.json") };
    fs.appendFileSync(sink, `${JSON.stringify(delta)}\n`);
    return sink;
  } catch (e) {
    process.stderr.write(`[plan-index] project-index propagation failed: ${e.message ?? e}\n`);
    return null;
  }
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const updateDir = argValue(args, "--update");
  const plansRoot = args.find((a) => !a.startsWith("--") && a !== updateDir);

  if (!plansRoot) {
    process.stderr.write("usage: plan-index.js <plans-root> [--update <plan-dir>] [--json]\n");
    process.exit(2);
  }

  const indexPath = path.join(plansRoot, "plan-index.json");
  let index = readJsonOrNull(indexPath) || { schema_version: 1, plans_root: plansRoot, plans: [] };
  if (!Array.isArray(index.plans)) index.plans = [];

  if (updateDir) {
    const row = scanPlan(updateDir, { plansRoot });
    const i = index.plans.findIndex((p) => p.plan === row.plan);
    if (i >= 0) {
      row.depends_on = index.plans[i].depends_on || []; // preserve derived edges
      index.plans[i] = row;
    } else {
      index.plans.push(row);
    }
  } else {
    index.plans = findPlanDirs(plansRoot).map((d) => scanPlan(d, { plansRoot }));
  }
  index.plans.sort((a, b) => a.plan.localeCompare(b.plan));
  index.updated_at = new Date().toISOString();

  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  const propagatedTo = propagate(plansRoot, index);

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ index_path: indexPath, plan_count: index.plans.length, propagated_to: propagatedTo }, null, 2)}\n`);
  } else {
    process.stdout.write(`plan-index: ${index.plans.length} plan(s) → ${indexPath}${propagatedTo ? ` (propagated to ${propagatedTo})` : ""}\n`);
  }
  process.exit(0);
}

main();
