/**
 * env-pin.js — guard environment-pinning heuristic.
 *
 * Phase 0 of the plan-state-machine evolution plan
 * (docs/experiments/plan-state-machine-evolution-plan.md).
 *
 * PROBLEM (FEEDBACK-SYNTHESIS.md S1 failure cluster #2): environment-dependent
 * gate execution — a bare `nx` resolves green in the executor's shell (tool on
 * PATH) but exits 127 in a clean subprocess. Guard `retry_count` and audit
 * `pass_rate` are not comparable between a plan whose guard pins tool
 * resolution and one that relies on ambient PATH: the latter may retry because
 * of the environment, not the code. Comparable gate metrics (goal 4) therefore
 * require knowing whether a guard is environment-pinned.
 *
 * This module implements the metrics-extraction-spec §3.2 heuristic. It is a
 * HEURISTIC, not a guarantee — it inspects the guard command STRING and reports
 * whether tool resolution looks pinned. Pure, Node-stdlib-free, ESM.
 */

/**
 * A guard is considered environment-pinned when ANY of:
 *   - it invokes a local binary via `./node_modules/.bin/...`
 *   - it uses `npx --yes` / `npx -y` (pins resolution + auto-installs)
 *   - it is a python script invocation (`python`/`python3 ... .py`) — these run
 *     against the repo's interpreter and import-time deps, not ambient CLIs
 *   - the plan declares an explicit environment via PLAN_ENV_LABEL (intentional
 *     environment control gets credit even with otherwise-bare commands)
 *
 * @param {string} guardCommand the literal guard command from dag.json
 * @param {{envLabel?: string}} [opts] envLabel from PLAN_ENV_LABEL
 * @returns {boolean}
 */
export function isEnvPinned(guardCommand, opts = {}) {
  if (opts.envLabel && String(opts.envLabel).trim()) return true;
  if (typeof guardCommand !== "string" || !guardCommand.trim()) return false;
  const g = guardCommand;
  if (g.includes("./node_modules/.bin/")) return true;
  if (/\bnpx\s+(?:--yes|-y)\b/.test(g)) return true;
  if (/\bpython3?\b[^|&;]*\.py\b/.test(g)) return true;
  return false;
}

/**
 * Human-readable reason for the pin verdict — used by the lint CLI so an
 * author can see WHY a guard is flagged.
 * @returns {{pinned: boolean, reason: string}}
 */
export function explainPin(guardCommand, opts = {}) {
  if (opts.envLabel && String(opts.envLabel).trim()) {
    return { pinned: true, reason: `PLAN_ENV_LABEL=${opts.envLabel} (declared environment)` };
  }
  if (typeof guardCommand !== "string" || !guardCommand.trim()) {
    return { pinned: false, reason: "empty or non-string guard command" };
  }
  const g = guardCommand;
  if (g.includes("./node_modules/.bin/")) {
    return { pinned: true, reason: "uses ./node_modules/.bin/ (local binary)" };
  }
  if (/\bnpx\s+(?:--yes|-y)\b/.test(g)) {
    return { pinned: true, reason: "uses npx --yes (pinned resolution)" };
  }
  if (/\bpython3?\b[^|&;]*\.py\b/.test(g)) {
    return { pinned: true, reason: "python script (repo interpreter + import-time deps)" };
  }
  const bare = detectBareTool(g);
  if (bare) {
    return {
      pinned: false,
      reason: `bare \`${bare}\` relies on ambient PATH — pin via ./node_modules/.bin/${bare} or npx --yes ${bare}`,
    };
  }
  return { pinned: false, reason: "no pinned tool-resolution marker found" };
}

/**
 * Best-effort identification of the first bare tool invocation in a guard, for
 * a more actionable lint message. Returns the tool name or null. Recognizes the
 * common JS toolchain CLIs that PATH-resolve differently across shells.
 */
export function detectBareTool(guardCommand) {
  if (typeof guardCommand !== "string") return null;
  const KNOWN = ["nx", "tsc", "eslint", "biome", "jest", "vitest", "prettier", "tsx", "webpack", "vite"];
  // Strip the ./node_modules/.bin/ prefixed forms first so we only catch bare uses.
  const stripped = guardCommand.replace(/\.\/node_modules\/\.bin\/\S+/g, "");
  for (const tool of KNOWN) {
    const re = new RegExp(`(^|[\\s;&|(])${tool}(\\s|$)`);
    if (re.test(stripped)) return tool;
  }
  return null;
}
