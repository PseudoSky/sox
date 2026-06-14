/**
 * plan-scan.js — derive one plan's corpus row (Layer 0).
 *
 * docs/experiments/plan-state-machine-layer0-corpus-spec.md §6 step 1.
 *
 * Reads a single plan dir and returns the registry row plan-index.js stores:
 * status rollup, mutate set (union of node artifacts), front-loaded references
 * (gitnexus best-effort, [] when unavailable), and the declared assumed_baseline.
 * Node stdlib only.
 */

import fs from "node:fs";
import path from "node:path";

import { normalizeStateEntry } from "./normalize-state.js";

function readJsonOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Roll a plan's per-state statuses up to one plan-level status. */
export function rollupStatus(states) {
  const entries = Object.values(states || {}).map((e) => normalizeStateEntry(e).status);
  if (entries.length === 0) return "authoring";
  if (entries.every((s) => s === "complete")) return "complete";
  if (entries.some((s) => s === "in_progress")) return "in-progress";
  if (entries.some((s) => s === "complete" || s === "blocked")) return "in-progress";
  return "published"; // all pending → authored & published, not yet started
}

/** Union of every node's declared artifacts (the plan's mutate set). */
export function mutateSet(nodes) {
  const set = new Set();
  for (const node of Object.values(nodes || {})) {
    for (const a of Array.isArray(node?.artifacts) ? node.artifacts : []) set.add(a);
  }
  return [...set].sort();
}

/**
 * Scan one plan dir → corpus row. `references` is gitnexus-front-loaded when a
 * resolver is provided; otherwise [] (degraded, never fabricated).
 * @param {string} planDir
 * @param {{plansRoot?: string, resolveRefs?: (nodes:object)=>string[]}} [opts]
 */
export function scanPlan(planDir, opts = {}) {
  const dag = readJsonOrNull(path.join(planDir, "dag.json")) || {};
  const state = readJsonOrNull(path.join(planDir, "state.json")) || {};
  const nodes = dag.nodes && typeof dag.nodes === "object" ? dag.nodes : {};
  const states = state.states && typeof state.states === "object" ? state.states : {};

  const references = typeof opts.resolveRefs === "function" ? opts.resolveRefs(nodes) || [] : [];
  const assumedBaseline = Array.isArray(dag.assumed_baseline) ? dag.assumed_baseline : [];

  const dirRel = opts.plansRoot ? path.relative(opts.plansRoot, planDir) : planDir;

  return {
    plan: path.basename(path.resolve(planDir)),
    dir: dirRel,
    status: rollupStatus(states),
    mutate_set: mutateSet(nodes),
    references,
    assumed_baseline: assumedBaseline,
    depends_on: [], // derived by cross-plan-check; cached here on write
    updated_at: new Date().toISOString(),
  };
}

/** Find plan dirs under a root (dirs containing both dag.json and state.json). */
export function findPlanDirs(plansRoot) {
  const out = [];
  function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const hasDag = entries.some((e) => e.isFile() && e.name === "dag.json");
    const hasState = entries.some((e) => e.isFile() && e.name === "state.json");
    if (hasDag && hasState) {
      out.push(dir);
      return; // a plan dir is a leaf for this purpose
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") {
        walk(path.join(dir, e.name), depth + 1);
      }
    }
  }
  walk(plansRoot, 0);
  return out;
}
