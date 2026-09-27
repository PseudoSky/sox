#!/usr/bin/env node
/**
 * tools/test-0abc01ed-unconfirmed-sha-refused.mjs
 *
 * Red->green contract pin for backlog 0abc01ed: "deny a resolution that asserts a main-branch sha
 * without a confirmed sha in main" — a resolution naming a commit that is not actually reachable in
 * `main` must be refused, not recorded. An unconfirmed ref is not terminal evidence for any class,
 * so recording one lets a resolution assert work shipped on a ref that never landed.
 *
 * The rule was already operator prose (backlog-operator — the `resolve` evidence precondition, plus
 * a failure-mode line) but carried no guard. This pins it. The prose is NOT weakened here: the
 * authentic pre-fix text — the same `resolve` section WITHOUT the "Confirm every named ref is in
 * `main`" rule, and the failure-modes list WITHOUT its unconfirmed-sha line — is quoted verbatim
 * below as the negative control, so this guard is demonstrably able to fail.
 *
 * Arms (all matched against whitespace-normalised prose, so line wrapping is irrelevant):
 *   1. every named ref must be confirmed in `main`
 *   2. the confirmation is reachable-in-`main` with read-only git
 *   3. it names the concrete read-only git commands (`merge-base --is-ancestor` / `branch --contains`)
 *   4. a sha not confirmed in `main` is refused, not recorded
 *   5. an unconfirmed ref is not terminal evidence for any class
 *   6. the failure mode is catalogued in the ESCALATE list
 *
 * Usage: node tools/test-0abc01ed-unconfirmed-sha-refused.mjs [--file <path-to-backlog-operator.md>]
 * Exit 0 iff every invariant is present AND the pre-fix negative control is rejected.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? path.resolve(process.argv[i + 1]) : fallback;
};
const TARGET = arg(
  '--file',
  path.join(REPO_ROOT, 'extensions/agents/backlog-operator/backlog-operator.md'),
);

// Authentic pre-fix text (the resolve section + failure-modes list, both WITHOUT the unconfirmed-sha
// rule this change pins). Kept verbatim as the negative control.
const PRE_FIX_RESOLVE = `## resolve — the evidence precondition (refuse without it)

\`resolve\` is the only verb that asserts work is *done*, so it carries a precondition keyed on the
**artifact class**. A commit/merge ref is **never** sufficient on its own:

- Every item — acceptance-criteria proof: the acceptance criteria the item carries are met (or a
  recorded \`none applicable\` declaration), verified against state.
- Publishable package — published-artifact proof: the released version actually resolves (the
  registry version / the package registry answers for it). Merging to main is not publishing.
- Released/deployed service or artifact — live-system / deploy proof: a verification dispatch
  exercised the live system and its named upstream consumers. A merge plus a restart is not a
  verified release.

If the caller sends \`resolve\` with only a commit ref, or with no evidence matching the item's
artifact class, **refuse**: return **ESCALATE** naming the missing evidence class and the artifact
that requires it. Do not resolve on a merge ref alone, and do not infer the class from what the run
happened to do — the requirement is derived from what the artifact requires.`;

const PRE_FIX_FAILURE_MODES = `- Verb not in the list of eleven.
- Precondition unmet (e.g., trying to resolve an already-resolved item).
- \`resolve\` without the item's artifact-class evidence — a commit/merge ref alone is insufficient.
- Write succeeded but read-back does not match (e.g., status changed but citations did not attach).
- Backlog skill error or timeout.
- Caller request is ambiguous or contradictory.`;

const OPERATOR_INVARIANTS = [
  ['every named ref must be confirmed in `main`', /Confirm every named ref is in `main`/],
  ['confirmation is reachable-in-main via read-only git', /reachable in `main` with read-only git/],
  ['names the merge-base --is-ancestor command', /git merge-base --is-ancestor/],
  ['names the branch --contains command', /git branch --contains/],
  ['an unconfirmed sha is refused, not recorded', /refused, not recorded/],
  ['an unconfirmed ref is not terminal evidence for any class', /not terminal evidence for any class/],
  [
    'the unconfirmed-sha failure mode is catalogued',
    /`resolve` asserting a commit\/merge sha that is not confirmed reachable in `main`/,
  ],
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
// Arms 1..7 — backlog-operator refuses a resolution whose sha is not in `main`.
// ---------------------------------------------------------------------------
const oText = fs.readFileSync(TARGET, 'utf8');
const oMissing = missingFrom(oText, OPERATOR_INVARIANTS);
report(
  `0abc01ed: backlog-operator refuses an unconfirmed-in-main resolution (${OPERATOR_INVARIANTS.length} invariants)`,
  oMissing.length === 0,
  oMissing.length === 0
    ? `all ${OPERATOR_INVARIANTS.length} invariants present in ${path.relative(REPO_ROOT, TARGET)}`
    : `MISSING: ${oMissing.join('; ')}`,
);

// ---------------------------------------------------------------------------
// Arm 8 — NEGATIVE CONTROL: the pre-fix rule-less text is rejected.
// ---------------------------------------------------------------------------
const preMissing = missingFrom(`${PRE_FIX_RESOLVE}\n\n${PRE_FIX_FAILURE_MODES}`, OPERATOR_INVARIANTS);
report(
  '0abc01ed: the pre-fix resolve text without the `main`-confirmation rule is REJECTED',
  preMissing.length > 0,
  preMissing.length > 0
    ? `negative control correctly rejected on ${preMissing.length}/${OPERATOR_INVARIANTS.length} invariants`
    : 'PREDICATE IS VACUOUS — it accepts the unfixed shape',
);

console.log('');
console.log(failed === 0 ? 'ALL 0abc01ed ASSERTIONS PASS' : `${failed} 0abc01ed ASSERTION(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
