#!/usr/bin/env node
/**
 * split-lint.js — split / minimal-project guidance (Layer 0, gap 2).
 *
 * docs/experiments/plan-state-machine-layer0-corpus-spec.md §2.3.
 *
 * Mechanical signals only — the author decides. Two checks:
 *   PLAN FLOOR (hard): a plan needs >=1 DoD clause + >=1 work state + >=1 audit
 *     check. Below the floor it is a ticket, not a plan (exit non-zero).
 *   SPLIT WARNINGS (soft): states > N (default 12), distinct top-level packages
 *     in the mutate set > M (default 4), or a disconnected DAG (independent
 *     sub-goals). Each warns; the call stays judgment.
 *
 * Usage:
 *   node scripts/split-lint.js <plan-dir> [--json] [--max-states N] [--max-packages M]
 *
 * Exit code: 0 if at/above the plan floor (warnings allowed), 1 if below floor.
 * Node stdlib only.
 */

import fs from "node:fs";
import path from "node:path";

function readJsonOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function readFileOrNull(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

/** Connected components over the undirected depends_on graph. */
function componentCount(nodes) {
  const names = Object.keys(nodes);
  if (names.length === 0) return 0;
  const adj = new Map(names.map((n) => [n, new Set()]));
  for (const [n, node] of Object.entries(nodes)) {
    for (const d of Array.isArray(node?.depends_on) ? node.depends_on : []) {
      if (adj.has(d)) {
        adj.get(n).add(d);
        adj.get(d).add(n);
      }
    }
  }
  const seen = new Set();
  let comps = 0;
  for (const start of names) {
    if (seen.has(start)) continue;
    comps++;
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const nb of adj.get(cur)) if (!seen.has(nb)) stack.push(nb);
    }
  }
  return comps;
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const maxStates = Number.parseInt(argValue(args, "--max-states") ?? "12", 10);
  const maxPackages = Number.parseInt(argValue(args, "--max-packages") ?? "4", 10);
  const planDir = args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a));

  if (!planDir) {
    process.stderr.write("usage: split-lint.js <plan-dir> [--json] [--max-states N] [--max-packages M]\n");
    process.exit(2);
  }

  const dag = readJsonOrNull(path.join(planDir, "dag.json")) || {};
  const nodes = dag.nodes && typeof dag.nodes === "object" ? dag.nodes : {};
  const readme = readFileOrNull(path.join(planDir, "README.md")) || "";

  // Plan-floor signals.
  const dodCount = [...readme.matchAll(/\[dod\.[A-Za-z0-9_-]+\]/g)].length;
  const workStates = Object.values(nodes).filter((n) => n?.kind === "work").length;
  const auditStates = Object.values(nodes).filter((n) => n?.kind === "audit").length;
  let auditChecks = auditStates;
  try {
    for (const f of fs.readdirSync(path.join(planDir, "scripts"))) {
      if (/^audit.*\.py$/.test(f)) {
        const txt = readFileOrNull(path.join(planDir, "scripts", f)) || "";
        if (/check\(\s*["']/.test(txt)) auditChecks++;
      }
    }
  } catch {}

  const floor = { dod: dodCount >= 1, work_state: workStates >= 1, audit: auditChecks >= 1 };
  const belowFloor = !(floor.dod && floor.work_state && floor.audit);

  // Split-warning signals.
  const stateCount = Object.keys(nodes).length;
  const packages = new Set();
  for (const node of Object.values(nodes)) {
    for (const a of Array.isArray(node?.artifacts) ? node.artifacts : []) {
      packages.add(String(a).split("/")[0]);
    }
  }
  const comps = componentCount(nodes);
  const warnings = [];
  if (stateCount > maxStates) warnings.push(`states=${stateCount} > ${maxStates} — consider splitting`);
  if (packages.size > maxPackages) warnings.push(`mutate set spans ${packages.size} top-level packages > ${maxPackages} — consider splitting by package`);
  if (comps > 1) warnings.push(`DAG has ${comps} disconnected components — likely ${comps} independent sub-goals`);

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ plan: path.basename(path.resolve(planDir)), below_floor: belowFloor, floor, warnings }, null, 2)}\n`);
  } else {
    if (belowFloor) {
      process.stdout.write(`BELOW FLOOR: dod=${floor.dod} work_state=${floor.work_state} audit=${floor.audit} — this is a ticket, not a plan.\n`);
    }
    for (const w of warnings) process.stdout.write(`SPLIT-WARN: ${w}\n`);
    if (!belowFloor && warnings.length === 0) process.stdout.write("split-lint: at/above floor, no split signals.\n");
  }
  process.exit(belowFloor ? 1 : 0);
}

main();
