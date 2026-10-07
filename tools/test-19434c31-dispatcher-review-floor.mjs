#!/usr/bin/env node
/**
 * tools/test-19434c31-dispatcher-review-floor.mjs
 *
 * Red->green contract pin for backlog 19434c31 (a review loop that never converges), re-pinned to
 * dispatcher 2.0.0. History: a severity floor kept review on the delivery path and still looped;
 * merge-first moved review after the merge and re-opened work after it landed. 2.0.0 removes the
 * loop's cause: static-analysis reviews run inside the cycle, QA runs the tests, and exactly ONE
 * blind review runs immediately before the merge to `main` — never in a later cycle.
 *
 * Arms (matched against whitespace-normalised prose, so line wrapping is irrelevant):
 *   1. the 2.0.0 lifecycle invariants are PRESENT in dispatcher.md.
 *   2. the superseded severity-floor and merge-first shapes are ABSENT (not resurrected).
 *   3. NEGATIVE CONTROL: the authentic 1.14.0 rule-5 shape (commit a713f684) is rejected by the
 *      same predicate that accepts the shipped artifact.
 *
 * Usage: node tools/test-19434c31-dispatcher-review-floor.mjs [--file <path-to-dispatcher.md>]
 * Exit 0 iff the artifact carries the merge-first doctrine AND the severity-floor shape is absent
 * AND the pre-fix negative control is rejected.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TARGET = path.join(REPO_ROOT, 'extensions/agents/dispatcher/dispatcher.md');

const fileArgIdx = process.argv.indexOf('--file');
const TARGET = fileArgIdx !== -1 ? path.resolve(process.argv[fileArgIdx + 1]) : DEFAULT_TARGET;

// Authentic pre-fix rule 5 (dispatcher 1.14.0, commit a713f684): merge on own gates, review FROM `main`
// afterwards. Kept verbatim as the negative control of the 2.0.0 doctrine.
const PRE_FIX = `5. **Code merges on its own gates; review follows the merge.** The merge trigger is
   the change's **own gates** — \`pnpm test\` 0 failures, \`tsc --noEmit\` exit 0, the
   bundle under budget — **not** a review. Then review FROM \`main\`, per ticket, pinned to the merged sha.`;

// The 2.0.0 delivery lifecycle: review never sits on the delivery path as a looping blind gate.
// Static reviews run inside the cycle, ONE blind review runs pre-merge — every invariant PRESENT.
const INVARIANTS = [
  ['rule 5 is the one lifecycle', /One lifecycle carries every plan to `main`/],
  ['review is static first, blind once', /Review is static first, blind once/],
  ['exactly ONE blind review per plan, pre-merge, HARD', /Exactly ONE blind review per plan, immediately before the merge to `main` — HARD rule/],
  ['no correction / reopen / re-dispatch is blind-reviewed', /No correction, reopen cycle or re-dispatch, before or after it, is blind-reviewed/],
  ['a second blind review is never dispatched', /a second blind review is never dispatched/],
  ['static reviewer does not run the suite (QA does)', /does not run the suite \(QA does\)/],
  ['`main` receives only a green plan branch the dispatcher ran', /`main` receives only a plan branch whose final test run you read green/],
  ['a red merged state is an immediate fix', /A red merged state is an immediate fix, never a follow-up/],
  ['write-scope overlaps declared in briefs up front', /Write-scope overlaps are declared in briefs up front/],
  ['Step 5 is the delivery lifecycle', /Step 5 — The delivery lifecycle/],
  ['stage 9 is the one blind review', /The one blind review \(rule 5, HARD\)/],
  ['failure mode Repeated blind review', /Repeated blind review/],
];

// The superseded pre-merge severity-floor shape (19434c31 v1.5..v1.7) — every invariant must be ABSENT.
const SUPERSEDED = [
  ['pre-merge severity floor (only >= HIGH re-opens the review)', /no finding at or above \*\*HIGH\*\*/],
  ['sub-HIGH findings recorded once as non-blocking', /recorded once as non-blocking/],
  ['sub-HIGH findings never re-reviewed', /MUST NOT\*\* trigger a fix round or a further review/],
  ['discretion may clear, never elevate', /NEVER\*\* elevate a sub-HIGH finding/],
  ['hard round cap (at most 2 rounds)', /at most 2 blind-review rounds/],
  ['the cap forbids a third round', /Never a third round/],
  ['Review-loop divergence failure mode', /Review-loop divergence/],
  ['Step 5 merge gate reiterates the floor', /Only blocking items \(≥ HIGH — rule 5\) go back to the executor/],
  ['merge-first: review follows the merge', /review follows the merge/],
  ['merge-first: review FROM `main`', /review FROM `main`/],
  ['merge-first: post-merge finding re-opens', /post-merge finding/],
  ['superseded failure mode name', /Review-gate deadlock/],
];

const normalise = (s) => s.replace(/\s+/g, ' ').trim();
const missing = (text, list) => {
  const n = normalise(text);
  return list.filter(([, re]) => !re.test(n)).map(([name]) => name);
};
const present = (text, list) => {
  const n = normalise(text);
  return list.filter(([, re]) => re.test(n)).map(([name]) => name);
};

let failed = 0;
function report(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
}

// ---------------------------------------------------------------------------
// Arm 1..12 — the shipped artifact carries every merge-first invariant.
// ---------------------------------------------------------------------------
const text = fs.readFileSync(TARGET, 'utf8');
const missingPositive = missing(text, INVARIANTS);
report(
  `19434c31: dispatcher carries the one-blind-review delivery lifecycle (${INVARIANTS.length} invariants)`,
  missingPositive.length === 0,
  missingPositive.length === 0
    ? `all ${INVARIANTS.length} invariants present in ${path.relative(REPO_ROOT, TARGET)}`
    : `MISSING: ${missingPositive.join('; ')}`,
);

// ---------------------------------------------------------------------------
// Arm 13 — SUPERSESSION: the old severity-floor shape is absent, not resurrected.
// ---------------------------------------------------------------------------
const resurrected = present(text, SUPERSEDED);
report(
  `19434c31: the severity-floor and merge-first shapes are SUPERSEDED (${SUPERSEDED.length} old invariants absent)`,
  resurrected.length === 0,
  resurrected.length === 0
    ? `all ${SUPERSEDED.length} severity-floor invariants absent from ${path.relative(REPO_ROOT, TARGET)}`
    : `RESURRECTED: ${resurrected.join('; ')}`,
);

// ---------------------------------------------------------------------------
// Arm 14 — NEGATIVE CONTROL: the pre-fix rule-5 shape is rejected. This is the
// proof the predicate can fail (BL-225: seen red with the fix disabled).
// ---------------------------------------------------------------------------
const preFixMissing = missing(PRE_FIX, INVARIANTS);
report(
  '19434c31: the pre-fix rule-5 shape (1.14.0 merge-first, review from `main`) is REJECTED',
  preFixMissing.length > 0,
  preFixMissing.length > 0
    ? `negative control correctly rejected on ${preFixMissing.length}/${INVARIANTS.length} invariants`
    : 'PREDICATE IS VACUOUS — it accepts the unfixed shape',
);

console.log('');
console.log(failed === 0 ? 'ALL 19434c31 ASSERTIONS PASS' : `${failed} 19434c31 ASSERTION(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
