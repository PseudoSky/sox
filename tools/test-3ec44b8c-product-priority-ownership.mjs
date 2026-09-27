#!/usr/bin/env node
/**
 * tools/test-3ec44b8c-product-priority-ownership.mjs
 *
 * Red->green contract pin for backlog 3ec44b8c-f6dd-4c67-8a38-eff7e0ba8e0e: the dispatcher asserted
 * the division of labour twice ("product-manager sets the priority"), but product.md itself NEVER
 * mentioned priority — its BLOCKING ownership contract covered acceptance criteria (epics),
 * verification enforcement, a validated-product inventory, the roadmap queue, and the epic feedback
 * loop, with no prioritisation duty and no reassignment path. Responsibility was assigned to product
 * by ANOTHER agent's spec while product's own spec was silent, so priority could go stale with no
 * owner. The authentic pre-fix ownership contract (duties 1-5, quoted verbatim below) is the
 * negative control — rejected by the same predicate, so this guard is demonstrably able to fail.
 *
 * Arms (all matched against whitespace-normalised prose, so line wrapping is irrelevant):
 *   1. priority assessment/assignment is an explicit duty ("You own priority")
 *   2. a re-ranking path exists ("re-ranking it when the evidence changes")
 *   3. the duty is part of the BLOCKING contract, not optional
 *   4. re-ranking is an explicit verb, and no other agent owns it
 *   5. the write is routed through `backlog-operator` (product carries no backlog tool)
 *   6. the rationale is recorded on the item
 *   7. the product checklist carries the duty
 *   8. the integration section names backlog-operator as the writer
 *
 * Usage: node tools/test-3ec44b8c-product-priority-ownership.mjs [--file <path-to-product.md>]
 * Exit 0 iff the artifact carries the priority duty AND the pre-fix negative control is rejected.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fileArgIdx = process.argv.indexOf('--file');
const TARGET = fileArgIdx !== -1 ? path.resolve(process.argv[fileArgIdx + 1]) : path.join(REPO_ROOT, 'extensions/agents/product/product.md');

// Authentic pre-fix ownership contract (duties 1-5, HEAD before this change). Kept verbatim.
const PRE_FIX = [
  '1. **You must create epics with concrete acceptance criteria.** No vague "improve X" epics. Every epic ticket you draft includes an `acceptance_criteria` section that a verifier can check objectively. If you cannot articulate the criteria, the epic is not ready — do research first, then write the epic.',
  '2. **You must enforce verification on every feature ticket.** Before a feature ticket reaches DONE, it must reference a verification run (pass/fail + evidence) from `test` or `review`. Reject any feature ticket that lands without one.',
  '3. **You must maintain a validated-product inventory.** Every shipped feature lands in a tracked inventory with: ticket id, verification run id, ship date, still-working flag. This is evidence the product works end-to-end, not just that code shipped.',
  '4. **You must keep the roadmap loaded with a rolling queue of validated, scoped-down next epics.** Refilling the queue is not optional.',
  "5. **You may not ship an epic without closing its feedback loop.** Before marking an epic DONE, write a `learnings.md` section: was the feature adopted? did acceptance criteria match user behavior? what do we know now that we didn't when the epic was drafted?",
].join('\n');

const INVARIANTS = [
  ['priority is an explicit owned duty', /You own priority/],
  ['a re-ranking path exists', /re-ranking it when the evidence changes/],
  ['the duty is part of the BLOCKING contract', /part of this contract, not an optional extra/],
  ['re-ranking is an explicit verb', /\*\*re-rank\*\* it/],
  ['no other agent owns re-ranking', /no other agent owns re-ranking it/],
  ['the write is routed through backlog-operator via task', /write it through `backlog-operator` via a `task` dispatch/],
  ['the rationale is recorded on the item', /rationale recorded on the item/],
  ['product carries no backlog tool', /carry no backlog tool yourself/],
  ['the checklist carries the duty', /Priority assigned and re-ranked as evidence changes/],
  ['the integration section names backlog-operator as the writer', /backlog-operator\*\* — the only writer of priority/],
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
// Arms 1..10 — the shipped artifact carries every invariant.
// ---------------------------------------------------------------------------
const text = fs.readFileSync(TARGET, 'utf8');
const missing = missingFrom(text);
report(
  `3ec44b8c: product owns priority and can re-rank it (${INVARIANTS.length} invariants)`,
  missing.length === 0,
  missing.length === 0
    ? `all ${INVARIANTS.length} invariants present in ${path.relative(REPO_ROOT, TARGET)}`
    : `MISSING: ${missing.join('; ')}`,
);

// ---------------------------------------------------------------------------
// Arm 11 — NEGATIVE CONTROL: the pre-fix duty-1..5 ownership contract is rejected.
// ---------------------------------------------------------------------------
const preFixMissing = missingFrom(PRE_FIX);
report(
  '3ec44b8c: the pre-fix duty-1..5 ownership contract (no priority duty) is REJECTED',
  preFixMissing.length > 0,
  preFixMissing.length > 0
    ? `negative control correctly rejected on ${preFixMissing.length}/${INVARIANTS.length} invariants`
    : 'PREDICATE IS VACUOUS — it accepts the unfixed shape',
);

console.log('');
console.log(failed === 0 ? 'ALL 3ec44b8c ASSERTIONS PASS' : `${failed} 3ec44b8c ASSERTION(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
