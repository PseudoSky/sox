#!/usr/bin/env node
/**
 * orchestrate-plan.js — plan orchestrator driver (Phase 6).
 *
 * docs/experiments/plan-state-machine-orchestrator-protocol-spec.md.
 *
 * Drives the dispatch loop over state-transition.js's stdout+exit-code contract.
 * Two sub-commands:
 *
 *   --dispatch <plan-dir>
 *       Read current_state and print the Mode-A (SOX-agent) dispatch message for
 *       it: the one-liner an executor agent runs (--start → work → --complete).
 *       Mode B (agent-forge) replaces this step with compile-task.js --format json
 *       → forge.assemble(packet); the rest of the loop (below) is identical.
 *
 *   --decide <plan-dir> --exit <N> [--stdout-json '<json>'] [--retries-used N] [--retry-budget N]
 *       Apply the orchestrator decision function to a transition result and print
 *       the next action (advance|retry|escalate|halt|done) as JSON. exit 1/2/4
 *       are mandatory halts; exit 1 retries up to the orchestrator-owned budget
 *       then escalates. Pure policy — the orchestrator agent reads the action.
 *
 * Node stdlib only.
 */

import fs from "node:fs";
import path from "node:path";

import { decide, DEFAULT_RETRY_BUDGET } from "./lib/orchestrate-decision.js";

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

function cmdDispatch(planDir) {
  const state = readJsonOrNull(path.join(planDir, "state.json"));
  if (!state) {
    process.stderr.write(`orchestrate: no readable state.json at ${planDir}\n`);
    process.exit(2);
  }
  const slug = state.current_state;
  if (!slug || slug === "done") {
    process.stdout.write(`${JSON.stringify({ action: "done", reason: "no current_state", plan: path.basename(path.resolve(planDir)) })}\n`);
    process.exit(0);
  }
  const message = [
    `Run: node scripts/state-transition.js ${planDir} ${slug} --start`,
    `Do the work described in contexts/${slug}.md and contexts/_shared.md, within the declared file reservations.`,
    `Run the guard until it passes, then:`,
    `Run: node scripts/state-transition.js ${planDir} ${slug} --complete --note '<what you did and verified>'`,
  ].join("\n");
  process.stdout.write(`${JSON.stringify({ mode: "A", slug, plan_dir: planDir, dispatch_message: message }, null, 2)}\n`);
  process.exit(0);
}

function cmdDecide(planDir, args) {
  const exitCode = Number.parseInt(argValue(args, "--exit") ?? "", 10);
  if (Number.isNaN(exitCode)) {
    process.stderr.write("orchestrate --decide requires --exit <N>\n");
    process.exit(2);
  }
  const stdoutJson = argValue(args, "--stdout-json");
  let stdout = null;
  if (stdoutJson) {
    try {
      stdout = JSON.parse(stdoutJson);
    } catch {
      stdout = null; // malformed → decide() treats as bypass
    }
  }
  const retriesUsed = Number.parseInt(argValue(args, "--retries-used") ?? "0", 10) || 0;
  const retryBudget = Number.parseInt(argValue(args, "--retry-budget") ?? "", 10);
  const decision = decide({
    exitCode,
    stdout,
    retriesUsed,
    retryBudget: Number.isNaN(retryBudget) ? DEFAULT_RETRY_BUDGET : retryBudget,
  });
  process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
  process.exit(0);
}

function main() {
  const args = process.argv.slice(2);
  const planDir = args.find((a) => !a.startsWith("--"));
  if (!planDir) {
    process.stderr.write("usage: orchestrate-plan.js <plan-dir> --dispatch | --decide --exit <N> [...]\n");
    process.exit(2);
  }
  if (args.includes("--dispatch")) return cmdDispatch(planDir);
  if (args.includes("--decide")) return cmdDecide(planDir, args);
  process.stderr.write("error: one of --dispatch | --decide is required\n");
  process.exit(2);
}

main();
