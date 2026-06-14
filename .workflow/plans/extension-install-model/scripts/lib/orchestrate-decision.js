/**
 * orchestrate-decision.js — orchestrator decision function (Phase 6).
 *
 * docs/experiments/plan-state-machine-orchestrator-protocol-spec.md §3, §6, §7.
 *
 * The contract boundary between orchestrator and executor is state-transition.js's
 * stdout JSON + exit code. This pure function maps (exit code, parsed stdout,
 * retry state) → the orchestrator's next action. It is identical for Mode A
 * (SOX-agent dispatch) and Mode B (agent-forge forge.assemble) — only executor
 * instantiation differs, never the decision.
 *
 * The retry budget is ORCHESTRATOR-owned (the script never retries itself). On
 * exit 1 the orchestrator retries up to the budget, then converts to a
 * planner-class escalation. exit 2/3/4 (and exit 0 with audit_pass=false, and
 * malformed output) are MANDATORY HALTS — "automate bookkeeping, not the gate."
 *
 * Node stdlib only; no I/O — pure decision logic.
 */

export const DEFAULT_RETRY_BUDGET = 2;

export const ACTIONS = Object.freeze({
  ADVANCE: "advance", // dispatch the next state's executor
  RETRY: "retry", // re-dispatch the same slug (guard failed, budget remains)
  ESCALATE: "escalate", // orchestrator files planner amendment, then halts
  HALT: "halt", // stop for human/architect decision
  DONE: "done", // plan complete
});

/**
 * @param {object} p
 * @param {number} p.exitCode       state-transition.js exit code
 * @param {object|null} p.stdout     parsed completion JSON (null if missing/malformed)
 * @param {number} [p.retriesUsed]   retries already spent on this slug (default 0)
 * @param {number} [p.retryBudget]   orchestrator retry budget (default 2, min 1)
 * @returns {{action: string, reason: string, next: (string|null), treat_as?: number, escalate_amend?: object}}
 */
export function decide({ exitCode, stdout, retriesUsed = 0, retryBudget = DEFAULT_RETRY_BUDGET }) {
  const budget = Math.max(1, Number.isInteger(retryBudget) ? retryBudget : DEFAULT_RETRY_BUDGET);

  // Malformed / missing completion signal: script crash or executor bypass.
  // Treat as exit 4 and flag bypass (spec §3.1 last row).
  if (exitCode === 0 && (!stdout || typeof stdout !== "object")) {
    return { action: ACTIONS.HALT, reason: "bypass_suspected", next: null, treat_as: 4 };
  }

  switch (exitCode) {
    case 0: {
      // exit 0 but audit didn't pass → MANDATORY HALT on the exit-4 path.
      if (stdout && stdout.audit_pass === false) {
        return { action: ACTIONS.HALT, reason: "audit_fail", next: null, treat_as: 4 };
      }
      const next = stdout ? stdout.next_state : null;
      if (next === "done" || next === null || next === undefined) {
        return { action: ACTIONS.DONE, reason: "plan_complete", next: "done" };
      }
      return { action: ACTIONS.ADVANCE, reason: "state_complete", next };
    }
    case 1: {
      if (retriesUsed < budget) {
        return { action: ACTIONS.RETRY, reason: `guard_fail_retry_${retriesUsed + 1}_of_${budget}`, next: stdout?.slug ?? null };
      }
      // Budget exhausted → convert to planner escalation (spec §6.3).
      return {
        action: ACTIONS.ESCALATE,
        reason: "retry_budget_exhausted",
        next: stdout?.slug ?? null,
        escalate_amend: { class: "planner", type: "fix-guard", reason: `guard failed ${retriesUsed} time(s); exceeded retry budget ${budget}` },
      };
    }
    case 2:
      return { action: ACTIONS.HALT, reason: "planner_escalation", next: null };
    case 3:
      return { action: ACTIONS.HALT, reason: "deps_unmet", next: null };
    case 4:
      return { action: ACTIONS.HALT, reason: "audit_fail", next: null };
    default:
      return { action: ACTIONS.HALT, reason: `unknown_exit_${exitCode}`, next: null, treat_as: 4 };
  }
}
