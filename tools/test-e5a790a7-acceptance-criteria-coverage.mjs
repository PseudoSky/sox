#!/usr/bin/env node
/**
 * tools/test-e5a790a7-acceptance-criteria-coverage.mjs
 *
 * Red->green contract pin for backlog e5a790a7-ab24-4e1b-89fe-bef94d9511d5: acceptance criteria
 * were written only for EPICS (product) and plan STATES (plan-builder). Ordinary backlog items and
 * the work the dispatcher resolves carried nothing — the dispatcher's brief had only a per-task
 * "done-state", which is a verification target, not a criterion agreed BEFORE the work. Closure was
 * therefore checked against whatever shipped.
 *
 * The unfixed shape is authentic, not invented: the pre-fix Step 2.1 done-state line and Step 3
 * brief-assembly line are quoted verbatim below as the negative control (rejected by the same
 * predicate), so this guard is demonstrably able to fail.
 *
 * Arms (all matched against whitespace-normalised prose, so line wrapping is irrelevant):
 *   1. an acceptance-criteria block is required (rule 20)
 *   2. an explicit `none applicable` declaration is the alternative
 *   3. the criterion is written before the work
 *   4. an item with neither does not proceed silently
 *   5. Step 2 (decompose) wires the requirement in
 *   6. Step 3 (brief assembly) wires the requirement in
 *   7. Step 5 (closure) verifies the item against its acceptance criteria
 *   8. the Post-hoc acceptance failure mode is catalogued
 *   9. Step 8 wires the check in
 *  10. backlog-operator's `resolve` requires acceptance-criteria proof / `none applicable`
 *
 * Usage: node tools/test-e5a790a7-acceptance-criteria-coverage.mjs
 *          [--file <path-to-dispatcher.md>] [--operator-file <path-to-backlog-operator.md>]
 * Exit 0 iff every invariant is present AND the pre-fix negative controls are rejected.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? path.resolve(process.argv[i + 1]) : fallback;
};
const TARGET = arg('--file', path.join(REPO_ROOT, 'extensions/agents/dispatcher/dispatcher.md'));
const OPERATOR = arg(
  '--operator-file',
  path.join(REPO_ROOT, 'extensions/agents/backlog-operator/backlog-operator.md'),
);

// Authentic pre-fix text (HEAD before this change). Kept verbatim as the negative control.
const PRE_FIX_DISPATCHER = `1. For each leaf task, name the **observable done-state** (a test that passes, a diff in named files, a state field). If you cannot name one, the task is not dispatchable — split or ask.

For each leaf, assemble the brief from \`dispatch-contract\` (goal, done-state, files in scope, tools/model, budget, return contract, any check-and-confirm backlog items) and dispatch anonymously in the background.`;

const PRE_FIX_OPERATOR = `1. Parse the verb and arguments from the incoming request.
2. Check preconditions — if not met, return ESCALATE with the unmet precondition.
3. Load the backlog skill and follow its contract for the verb.
4. Execute the operation.
5. Read back the result (confirm the write matches what was intended).
6. Return the result or ESCALATE if the read-back does not match.`;

const DISPATCHER_INVARIANTS = [
  ['requires an acceptance-criteria block (rule 20)', /acceptance-criteria block/],
  ['requires a `none applicable` declaration as the alternative', /`none applicable` declaration/],
  ['the criterion is written before the work', /written before the work/],
  ['an item with neither does not proceed silently', /does not proceed silently/],
  ['criteria are binary and objectively checkable', /binary, objectively checkable/],
  ['Step 2 wires the requirement in', /acceptance-criteria block or a recorded `none applicable` declaration/],
  ['Step 3 brief assembly wires the requirement in', /acceptance criteria or a recorded `none applicable` declaration/],
  ['Step 5 closure verifies against the acceptance criteria', /verifies the item against its acceptance criteria/],
  ['Post-hoc acceptance failure mode catalogued', /Post-hoc acceptance/],
  ['Step 8 wires the acceptance-criteria check in', /Did every executed item carry acceptance criteria or a recorded `none applicable` declaration \(rule 20\)/],
];

const OPERATOR_INVARIANTS = [
  ['resolve requires acceptance-criteria proof', /acceptance-criteria proof/],
  ['resolve accepts a recorded `none applicable` declaration', /`none applicable` declaration/],
];

const normalise = (s) => s.replace(/\s+/g, ' ').trim();
const missingFrom = (text, inv) => {
  const n = normalise(text);
  return inv.filter(([, re]) => !re.test(n)).map(([name]) => name);
};

let failed = 0;
function report(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
}

// ---------------------------------------------------------------------------
// Arms 1..10 — dispatcher.md carries the acceptance-criteria requirement.
// ---------------------------------------------------------------------------
const dText = fs.readFileSync(TARGET, 'utf8');
const dMissing = missingFrom(dText, DISPATCHER_INVARIANTS);
report(
  `e5a790a7: dispatcher requires acceptance criteria on executed/resolved items (${DISPATCHER_INVARIANTS.length} invariants)`,
  dMissing.length === 0,
  dMissing.length === 0
    ? `all ${DISPATCHER_INVARIANTS.length} invariants present in ${path.relative(REPO_ROOT, TARGET)}`
    : `MISSING: ${dMissing.join('; ')}`,
);

// ---------------------------------------------------------------------------
// Arm 11 — backlog-operator's resolve requires the criterion.
// ---------------------------------------------------------------------------
const oText = fs.readFileSync(OPERATOR, 'utf8');
const oMissing = missingFrom(oText, OPERATOR_INVARIANTS);
report(
  `e5a790a7: backlog-operator resolve requires acceptance-criteria proof (${OPERATOR_INVARIANTS.length} invariants)`,
  oMissing.length === 0,
  oMissing.length === 0
    ? `all ${OPERATOR_INVARIANTS.length} invariants present in ${path.relative(REPO_ROOT, OPERATOR)}`
    : `MISSING: ${oMissing.join('; ')}`,
);

// ---------------------------------------------------------------------------
// Arm 12 — NEGATIVE CONTROL: the authentic pre-fix shapes are rejected.
// ---------------------------------------------------------------------------
const preD = missingFrom(PRE_FIX_DISPATCHER, DISPATCHER_INVARIANTS);
const preO = missingFrom(PRE_FIX_OPERATOR, OPERATOR_INVARIANTS);
report(
  'e5a790a7: the pre-fix done-state-only Step 2/3 text is REJECTED',
  preD.length > 0,
  preD.length > 0
    ? `negative control correctly rejected on ${preD.length}/${DISPATCHER_INVARIANTS.length} invariants`
    : 'PREDICATE IS VACUOUS — it accepts the unfixed shape',
);
report(
  'e5a790a7: the pre-fix backlog-operator preconditions shape is REJECTED',
  preO.length > 0,
  preO.length > 0
    ? `negative control correctly rejected on ${preO.length}/${OPERATOR_INVARIANTS.length} invariants`
    : 'PREDICATE IS VACUOUS — it accepts the unfixed shape',
);

console.log('');
console.log(failed === 0 ? 'ALL e5a790a7 ASSERTIONS PASS' : `${failed} e5a790a7 ASSERTION(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
