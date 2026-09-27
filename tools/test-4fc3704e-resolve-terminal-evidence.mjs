#!/usr/bin/env node
/**
 * tools/test-4fc3704e-resolve-terminal-evidence.mjs
 *
 * Red->green contract pin for backlog 4fc3704e-56b0-4363-a1fe-ec8a51826f8b: `resolve` was "mark
 * as resolved with citations" with no precondition about what actually shipped, so the dispatcher's
 * closure gate sent `resolve` "with the commit ref" the moment a merge landed. A merge is terminal
 * evidence for neither a publishable package (merging to main is not publishing) nor a
 * released/deployed service (a merge + restart is not a verified release). Step 7 ("Post-deploy
 * verification") existed but was CONDITIONAL on "If any dispatch deployed", so the gate was absent
 * exactly when work merged without a deploy step.
 *
 * The unfixed shape is authentic, not invented: the pre-fix Step 5 resolve tail and Step 7 trigger
 * are quoted verbatim below as the negative control (rejected by the same predicate), so this guard
 * is demonstrably able to fail.
 *
 * Arms (all matched against whitespace-normalised prose, so line wrapping is irrelevant):
 *   1. terminal resolution keyed on the artifact class (rule 18)
 *   2. acceptance-criteria proof for every item
 *   3. published-artifact proof for a publishable package
 *   4. live-system / deploy proof for a released/deployed service or artifact
 *   5. a commit/merge ref alone is insufficient
 *   6. requirement derived from what the artifact REQUIRES
 *   7. Step 7 no longer conditional on a deploy having occurred
 *   8. Step 5 resolve gate carries rule 18's evidence
 *   9. the Merge-as-terminal-evidence failure mode is catalogued
 *  10. backlog-operator's `resolve` refuses without the evidence class (ESCALATE)
 *
 * Usage: node tools/test-4fc3704e-resolve-terminal-evidence.mjs
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
const PRE_FIX_DISPATCHER = `Verify the merge landed from \`git log\`; send the \`merged\` transition with the run line, then \`backlog-operator: resolve\` with the commit ref only when rule 15's BL-225 gate is met — otherwise the item stays \`IN_PROGRESS\` and the report says why.

### Step 7 — Post-deploy verification

If any dispatch deployed (published a package, synced a plugin, restarted a service): dispatch a verification executor against the live system and the named upstream consumers; the evidence goes in the report.`;

const PRE_FIX_OPERATOR = `8. **resolve** — mark as resolved with citations`;

const DISPATCHER_INVARIANTS = [
  ['terminal resolution keyed on the artifact class', /Terminal resolution requires evidence of the artifact class/],
  ['acceptance-criteria proof for every item', /Acceptance-criteria proof/],
  ['published-artifact proof for a publishable package', /Published-artifact proof/],
  ['merging to main is not publishing', /Merging to main is not publishing/],
  ['live-system \/ deploy proof for a released\/deployed artifact', /Live-system \/ deploy proof/],
  ['a merge plus a restart is not a verified release', /A merge plus a restart is not a verified release/],
  ['a commit\/merge ref alone is insufficient', /commit\/merge ref alone is insufficient/],
  ['requirement derived from what the artifact REQUIRES', /derived from what the artifact REQUIRES/],
  ['Step 7 not conditional on a deploy having occurred', /independent of whether this run performed the deploy/],
  ['Step 5 resolve gate carries rule 18 evidence', /rule 18's artifact-class evidence/],
  ['Merge-as-terminal-evidence failure mode catalogued', /Merge-as-terminal-evidence/],
];

const OPERATOR_INVARIANTS = [
  ['resolve carries an evidence precondition', /resolve — the evidence precondition/],
  ['refuses without the evidence class, via ESCALATE', /return \*\*ESCALATE\*\* naming the missing evidence class/],
  ['publishable package requires published-artifact proof', /Publishable package — published-artifact proof/],
  ['released\/deployed requires live-system proof', /Released\/deployed service or artifact — live-system \/ deploy proof/],
  ['class is not inferred from what the run happened to do', /do not infer the class from what the run happened to do/],
];

// The pre-fix trigger that must be gone: the gate must not derive from whether a deploy happened.
const DISPATCHER_FORBIDDEN = [['Step 7 still conditional on a deploy', /If any dispatch deployed/]];

const normalise = (s) => s.replace(/\s+/g, ' ').trim();
const missingFrom = (text, inv) => {
  const n = normalise(text);
  return inv.filter(([, re]) => !re.test(n)).map(([name]) => name);
};
const presentFrom = (text, inv) => {
  const n = normalise(text);
  return inv.filter(([, re]) => re.test(n)).map(([name]) => name);
};

let failed = 0;
function report(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
}

// ---------------------------------------------------------------------------
// Arms 1..9 — dispatcher.md carries the artifact-class resolution rule.
// ---------------------------------------------------------------------------
const dText = fs.readFileSync(TARGET, 'utf8');
const dMissing = missingFrom(dText, DISPATCHER_INVARIANTS);
report(
  `4fc3704e: dispatcher requires artifact-class terminal-resolution evidence (${DISPATCHER_INVARIANTS.length} invariants)`,
  dMissing.length === 0,
  dMissing.length === 0
    ? `all ${DISPATCHER_INVARIANTS.length} invariants present in ${path.relative(REPO_ROOT, TARGET)}`
    : `MISSING: ${dMissing.join('; ')}`,
);

const dForbidden = presentFrom(dText, DISPATCHER_FORBIDDEN);
report(
  '4fc3704e: Step 7 is no longer conditional on whether a deploy occurred',
  dForbidden.length === 0,
  dForbidden.length === 0
    ? 'the pre-fix "If any dispatch deployed" trigger is absent'
    : `STILL PRESENT: ${dForbidden.join('; ')}`,
);

// ---------------------------------------------------------------------------
// Arm 10 — backlog-operator's `resolve` refuses without the evidence class.
// ---------------------------------------------------------------------------
const oText = fs.readFileSync(OPERATOR, 'utf8');
const oMissing = missingFrom(oText, OPERATOR_INVARIANTS);
report(
  `4fc3704e: backlog-operator resolve refuses without the artifact-class evidence (${OPERATOR_INVARIANTS.length} invariants)`,
  oMissing.length === 0,
  oMissing.length === 0
    ? `all ${OPERATOR_INVARIANTS.length} invariants present in ${path.relative(REPO_ROOT, OPERATOR)}`
    : `MISSING: ${oMissing.join('; ')}`,
);

// ---------------------------------------------------------------------------
// Arm 11 — NEGATIVE CONTROL: the authentic pre-fix shapes are rejected.
// ---------------------------------------------------------------------------
const preD = missingFrom(PRE_FIX_DISPATCHER, DISPATCHER_INVARIANTS);
const preDOperator = missingFrom(PRE_FIX_OPERATOR, OPERATOR_INVARIANTS);
const preForbidden = presentFrom(PRE_FIX_DISPATCHER, DISPATCHER_FORBIDDEN);
report(
  '4fc3704e: the pre-fix dispatcher resolve tail + Step 7 trigger is REJECTED',
  preD.length > 0 || preForbidden.length > 0,
  preD.length > 0 || preForbidden.length > 0
    ? `negative control rejected (${preD.length}/${DISPATCHER_INVARIANTS.length} missing, ${preForbidden.length} forbidden present)`
    : 'PREDICATE IS VACUOUS — it accepts the unfixed shape',
);
report(
  '4fc3704e: the pre-fix backlog-operator resolve verb is REJECTED',
  preDOperator.length > 0,
  preDOperator.length > 0
    ? `negative control correctly rejected on ${preDOperator.length}/${OPERATOR_INVARIANTS.length} invariants`
    : 'PREDICATE IS VACUOUS — it accepts the unfixed shape',
);

console.log('');
console.log(failed === 0 ? 'ALL 4fc3704e ASSERTIONS PASS' : `${failed} 4fc3704e ASSERTION(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
