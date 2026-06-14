/**
 * metrics-sink.js — config-driven resolution of the metrics sink root.
 *
 * Phase 2 of the plan-state-machine evolution plan
 * (docs/experiments/plan-state-machine-metrics-extraction-spec.md §4.3).
 *
 * The plan repo and the agent-forge project are different filesystem locations,
 * so the sink path is NOT hardcoded. Resolution order:
 *
 *   1. AGENT_FORGE_SINK env var — absolute path to the agent-forge project folder
 *   2. <plan-dir>/.metrics-sink — a single line holding the absolute path
 *      (committed to the plan repo, not gitignored)
 *   3. Default fallback — <repo-root>/data/training (writes locally, no cross-repo
 *      sync). A warning is surfaced via the `warning` field.
 *
 * The returned `root` is the agent-forge PROJECT folder; callers append
 * `data/training/...` themselves. For the local fallback the `root` is the repo
 * root, so the same `data/training/...` join lands under the repo. Both the env
 * var and the .metrics-sink file point at the project folder (which contains
 * data/training); the fallback points at the repo root (which also contains
 * data/training). This keeps the join identical in every branch.
 *
 * Node stdlib only — no npm dependencies. Pure resolution + one fs read.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Resolve the sink root and the data/training directory beneath it.
 *
 * @param {string} planDir absolute path to the plan directory
 * @param {string|null} repoRoot repo root (from emit-event.js repoRoot()); used
 *   for the local fallback. May be null if the repo root could not be resolved.
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env] environment to read AGENT_FORGE_SINK from
 *   (defaults to process.env; injectable for tests)
 * @returns {{
 *   source: "env" | "file" | "fallback" | "none",
 *   root: string|null,
 *   trainingDir: string|null,
 *   warning: string|null
 * }}
 */
export function resolveSink(planDir, repoRoot, opts = {}) {
  const env = opts.env || process.env;

  // 1. AGENT_FORGE_SINK env var
  const fromEnv = env.AGENT_FORGE_SINK;
  if (fromEnv && String(fromEnv).trim()) {
    const root = String(fromEnv).trim();
    return {
      source: "env",
      root,
      trainingDir: path.join(root, "data", "training"),
      warning: null,
    };
  }

  // 2. <plan-dir>/.metrics-sink (single line, absolute path)
  const sinkFile = path.join(planDir, ".metrics-sink");
  const fromFile = readFirstLine(sinkFile);
  if (fromFile) {
    return {
      source: "file",
      root: fromFile,
      trainingDir: path.join(fromFile, "data", "training"),
      warning: null,
    };
  }

  // 3. Local fallback under the repo root.
  if (repoRoot) {
    return {
      source: "fallback",
      root: repoRoot,
      trainingDir: path.join(repoRoot, "data", "training"),
      warning: "[metrics] AGENT_FORGE_SINK not configured — writing to local fallback only",
    };
  }

  // No sink could be resolved at all.
  return {
    source: "none",
    root: null,
    trainingDir: null,
    warning:
      "[metrics] AGENT_FORGE_SINK not configured and repo root unresolved — no sink available",
  };
}

/** Read and trim the first non-empty line of a file; null if absent/unreadable. */
function readFirstLine(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (l) return l;
  }
  return null;
}
