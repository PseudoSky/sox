#!/usr/bin/env node
/**
 * tools/test-decda240-run-definition-of-done.mjs
 *
 * Red->green contract pin for backlog decda240-0954-4d99-bfc3-6c0e896cc274: the dispatcher
 * verified per-LEAF done-state only. Nothing defined done for the RUN or the PROJECT as a whole —
 * no acceptance criteria for the aggregate outcome, no gate on the objective's own success. A run
 * could verify every leaf, resolve every item, and never ask whether the project outcome was
 * achieved. The Step 8 self-critique (quoted verbatim below as the negative control) checked leaf
 * done-state and nothing above it.
 *
 * Arms (all matched against whitespace-normalised prose, so line wrapping is irrelevant):
 *   1. the run has its own definition of done (rule 19)
 *   2. the DoD is derived from observable assertions (binary pass/fail clauses)
 *   3. each of the four clauses is present (Outcome / Acceptance / Terminal evidence / Disclosure)
 *   4. the close report states whether the run DoD is MET, and which clause is unmet
 *   5. the derivation follows `plan-builder`'s method
 *   6. Step 8 wires the check in
 *   7. the Bucket-complete, outcome-unverified failure mode is catalogued
 *
 * Usage: node tools/test-decda240-run-definition-of-done.mjs [--file <path-to-dispatcher.md>]
 * Exit 0 iff the artifact carries the run DoD AND the pre-fix negative control is rejected.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fileArgIdx = process.argv.indexOf('--file');
const TARGET = fileArgIdx !== -1 ? path.resolve(process.argv[fileArgIdx + 1]) : path.join(REPO_ROOT, 'extensions/agents/dispatcher/dispatcher.md');

// Authentic pre-fix text (HEAD before this change). Kept verbatim as the negative control.
const PRE_FIX = `### Step 8 — Self-critique pass

- [ ] Did I execute nothing myself (no Edit/Write; Bash only for read-only verification)?
- [ ] Does every subtask have a named done-state that I read directly — and did I *stop* when it was met?

### Step 9 — Return

Return the final report. Close every task (done or blocked with reason). Nothing stays in flight.`;

const INVARIANTS = [
  ['a run has its own definition of done (rule 19)', /A run has its own definition of done/],
  ['derived from observable assertions', /observable assertions/],
  ['each clause is a binary pass\/fail check', /binary pass\/fail check/],
  ['Outcome clause', /Outcome\*\* — the user's objective is achieved/],
  ['Acceptance clause', /Acceptance\*\* — every executed or resolved item's acceptance criteria/],
  ['Terminal evidence clause', /Terminal evidence\*\* — every resolution carries its artifact-class evidence/],
  ['Disclosure clause', /Disclosure\*\* — newly discovered bugs\/deferrals are filed/],
  ['close report states whether the run DoD is MET', /states whether the run DoD is \*\*MET\*\*/],
  ['close report names the unmet clause', /which clause is unmet/],
  ['derivation follows plan-builder', /the way `plan-builder` derives/],
  ['Step 8 wires the run-DoD check in', /Did I check the run's own definition of done \(rule 19\) and state whether it is MET/],
  ['Bucket-complete, outcome-unverified failure mode catalogued', /Bucket-complete, outcome-unverified/],
];

const normalise = (s) => s.replace(/\s+/g, ' ').trim();
const missingFrom = (text) => {
  const n = normalise(text);
  return INVARIANTS.filter(([, re]) => !re.test(n)).map(([name]) => name);
};

let failed = 0;
function report(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
}

// ---------------------------------------------------------------------------
// Arms 1..12 — the shipped artifact carries every invariant.
// ---------------------------------------------------------------------------
const text = fs.readFileSync(TARGET, 'utf8');
const missing = missingFrom(text);
report(
  `decda240: dispatcher carries a run\/project definition of done (${INVARIANTS.length} invariants)`,
  missing.length === 0,
  missing.length === 0
    ? `all ${INVARIANTS.length} invariants present in ${path.relative(REPO_ROOT, TARGET)}`
    : `MISSING: ${missing.join('; ')}`,
);

// ---------------------------------------------------------------------------
// Arm 13 — NEGATIVE CONTROL: the pre-fix leaf-only Step 8/9 shape is rejected.
// ---------------------------------------------------------------------------
const preFixMissing = missingFrom(PRE_FIX);
report(
  'decda240: the pre-fix leaf-only self-critique (Step 8/9) is REJECTED',
  preFixMissing.length > 0,
  preFixMissing.length > 0
    ? `negative control correctly rejected on ${preFixMissing.length}/${INVARIANTS.length} invariants`
    : 'PREDICATE IS VACUOUS — it accepts the unfixed shape',
);

console.log('');
console.log(failed === 0 ? 'ALL decda240 ASSERTIONS PASS' : `${failed} decda240 ASSERTION(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
