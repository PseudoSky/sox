#!/usr/bin/env node
/**
 * cross-plan-check.js — corpus conflict + dependency derivation (Layer 0).
 *
 * docs/experiments/plan-state-machine-layer0-corpus-spec.md §2.2.
 *
 * Reads plan-index.json and derives, with pure set/graph ops (no gitnexus at
 * check time — refs were front-loaded by plan-index.js):
 *   - CONFLICT MATRIX (gap 1): plans whose mutate_set intersect (the cross-PLAN
 *     lift of the orchestrator's disjoint-reserved-file rule).
 *   - DEPENDENCY DAG (gaps 3,4): plan B depends on plan A when A is in B's
 *     assumed_baseline, or B reads a symbol/file A mutates (references ∩
 *     mutate_set). Topo-sorted; cycles reported.
 *
 * Usage:
 *   node scripts/cross-plan-check.js <plans-root> [--json] [--strict]
 *
 * Exit code: number of conflicts under --strict (0 otherwise). Node stdlib only.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readJsonOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function intersect(a, b) {
  const setB = new Set(b);
  return a.filter((x) => setB.has(x));
}

/** Conflict pairs: plans with overlapping mutate sets. */
export function conflicts(plans) {
  const out = [];
  for (let i = 0; i < plans.length; i++) {
    for (let j = i + 1; j < plans.length; j++) {
      const overlap = intersect(plans[i].mutate_set || [], plans[j].mutate_set || []);
      if (overlap.length) out.push({ a: plans[i].plan, b: plans[j].plan, files: overlap });
    }
  }
  return out;
}

/** Dependency edges B → A ("B depends on A"). */
export function dependencyEdges(plans) {
  const byName = new Map(plans.map((p) => [p.plan, p]));
  const edges = [];
  for (const b of plans) {
    const deps = new Set();
    for (const a of Array.isArray(b.assumed_baseline) ? b.assumed_baseline : []) {
      if (byName.has(a) && a !== b.plan) deps.add(a);
    }
    for (const a of plans) {
      if (a.plan === b.plan) continue;
      if (intersect(b.references || [], a.mutate_set || []).length) deps.add(a.plan);
    }
    for (const a of deps) edges.push({ from: b.plan, to: a });
  }
  return edges;
}

/** Topo-order plans by dependency edges; returns {order, cycle}. */
export function topoOrder(plans, edges) {
  const names = plans.map((p) => p.plan);
  const adj = new Map(names.map((n) => [n, []]));
  const indeg = new Map(names.map((n) => [n, 0]));
  for (const e of edges) {
    // edge from depends on to ⇒ "to" must come before "from"
    if (adj.has(e.to) && indeg.has(e.from)) {
      adj.get(e.to).push(e.from);
      indeg.set(e.from, indeg.get(e.from) + 1);
    }
  }
  const queue = names.filter((n) => indeg.get(n) === 0).sort();
  const order = [];
  while (queue.length) {
    const n = queue.shift();
    order.push(n);
    for (const m of adj.get(n)) {
      indeg.set(m, indeg.get(m) - 1);
      if (indeg.get(m) === 0) {
        queue.push(m);
        queue.sort();
      }
    }
  }
  const cycle = order.length !== names.length ? names.filter((n) => !order.includes(n)) : null;
  return { order, cycle };
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const strict = args.includes("--strict");
  const plansRoot = args.find((a) => !a.startsWith("--"));

  if (!plansRoot) {
    process.stderr.write("usage: cross-plan-check.js <plans-root> [--json] [--strict]\n");
    process.exit(2);
  }
  const index = readJsonOrNull(path.join(plansRoot, "plan-index.json"));
  if (!index || !Array.isArray(index.plans)) {
    process.stderr.write(`cross-plan-check: no plan-index.json at ${plansRoot} (run plan-index.js first)\n`);
    process.exit(2);
  }

  const cs = conflicts(index.plans);
  const edges = dependencyEdges(index.plans);
  const { order, cycle } = topoOrder(index.plans, edges);

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ conflicts: cs, dependency_edges: edges, topo_order: order, cycle }, null, 2)}\n`);
  } else {
    for (const c of cs) process.stdout.write(`CONFLICT ${c.a} ↔ ${c.b}: overlapping mutate set [${c.files.join(", ")}]\n`);
    for (const e of edges) process.stdout.write(`DEPENDS ${e.from} → ${e.to} (after)\n`);
    if (cycle) process.stdout.write(`CYCLE in cross-plan dependencies: ${cycle.join(", ")}\n`);
    else process.stdout.write(`topo-order: ${order.join(" → ") || "(none)"}\n`);
    if (cs.length === 0) process.stdout.write("no cross-plan conflicts.\n");
  }
  process.exit(strict ? cs.length : 0);
}

// Only run as a CLI when executed directly — importing the exported functions
// (conflicts/dependencyEdges/topoOrder) must not trigger main().
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
