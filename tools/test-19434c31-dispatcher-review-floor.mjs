#!/usr/bin/env node
/**
 * tools/test-19434c31-dispatcher-review-floor.mjs
 *
 * Red->green contract pin for backlog 19434c31, superseded by dispatcher 1.8.0. The original fix
 * put a minimum-severity floor + round cap on the blind review — but it KEPT review on the delivery
 * path, so a pre-merge gate that re-opened on every finding still never converged. The 1.8.0
 * doctrine ("merge-first delivery loop") moves the review gate OFF the delivery path entirely:
 * code merges on its OWN gates, review runs AFTER the merge from `main` against the pinned sha, and
 * a HIGH finding is bucketed + dispatched as immediate follow-up implementation rather than blocking
 * the merge.
 *
 * This guard now pins that merge-first doctrine (the positive arms) AND proves the supersession —
 * the pre-merge severity-floor shape (v1.5..v1.7) must be ABSENT, and the authentic no-floor pre-fix
 * v1.4.0 shape (commit 9ab825e3) is the negative control. The v1.4.0 rule 5 read "You never merge
 * unreviewed code. Every merge waits for a `code-reviewer` pass with zero open items." — that exact
 * sentence is rejected by the same predicate that accepts the shipped artifact, so this guard is
 * demonstrably able to fail.
 *
 * Arms (all matched against whitespace-normalised prose, so line wrapping is irrelevant):
 *   1..12. the merge-first delivery loop is present: merge-on-own-gates, review-from-`main`,
 *          reviewer-runs-the-suite, HIGH-never-blocks, filed-AND-scheduled, hard-rail-`main`,
 *          write-scope-overlaps-declared, supersedes-severity-floor, Step 5 rename, and the
 *          "Review-gate deadlock" failure mode.
 *   13. the superseded severity-floor shape (8 old invariants) is ABSENT — not resurrected.
 *   14. NEGATIVE CONTROL: the v1.4.0 pre-fix rule-5 shape is rejected.
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

// Authentic pre-fix rule 5 (v1.4.0, commit 9ab825e3). Kept verbatim as the negative control.
const PRE_FIX = `5. **You never merge unreviewed code.** Every merge waits for a \`code-reviewer\`
   pass with zero open items.`;

// The merge-first delivery loop (dispatcher 1.8.0) — every invariant must be PRESENT.
const INVARIANTS = [
  ['merge trigger is the change\'s own gates, not a review', /Code merges on its own gates; review follows the merge/],
  ['review runs FROM `main`, per ticket, pinned to the merged sha', /review FROM `main`, per ticket, pinned to the merged sha/],
  ['the reviewer RUNS the suite, does not judge from reading', /RUNS the suite\*\*, it does not judge from reading/],
  ['a HIGH is never a blocker — bucketed and dispatched', /A HIGH is never a blocker — it is bucketed and dispatched/],
  ['a HIGH is dispatched as immediate follow-up implementation', /dispatched as \*\*immediate follow-up implementation\*\*/],
  ['every post-merge finding is filed AND scheduled', /Every post-merge finding is \*\*filed AND scheduled\*\*/],
  ['`main` gates are a hard rail: red merged state is an immediate fix', /a red merged state is an \*\*immediate fix, not a follow-up\*\*/],
  ['branch write-scope overlaps declared in briefs up front', /write-scope overlaps are \*\*declared in briefs up front\*\*/],
  ['supersedes the severity-floor gate 19434c31', /Supersedes the severity-floor gate/],
  ['review no longer sits on the delivery path', /review no longer sits on the delivery path/],
  ['Step 5 renamed to "Merge on gates, then review from main"', /Step 5 — Merge on gates, then review from main/],
  ['failure mode renamed to "Review-gate deadlock"', /Review-gate deadlock/],
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
  `19434c31: dispatcher carries the merge-first delivery loop (${INVARIANTS.length} invariants)`,
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
  `19434c31: the pre-merge severity-floor shape is SUPERSEDED (${SUPERSEDED.length} old invariants absent)`,
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
  '19434c31: the pre-fix rule-5 shape (v1.4.0 "pass with zero open items") is REJECTED',
  preFixMissing.length > 0,
  preFixMissing.length > 0
    ? `negative control correctly rejected on ${preFixMissing.length}/${INVARIANTS.length} invariants`
    : 'PREDICATE IS VACUOUS — it accepts the unfixed shape',
);

console.log('');
console.log(failed === 0 ? 'ALL 19434c31 ASSERTIONS PASS' : `${failed} 19434c31 ASSERTION(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
