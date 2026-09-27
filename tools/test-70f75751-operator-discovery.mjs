#!/usr/bin/env node
/**
 * tools/test-70f75751-operator-discovery.mjs
 *
 * Red->green contract pin for backlog 70f75751-8a84-47d2-99ed-83fb3bd71b3f: backlog-operator's
 * protocol had no discovery step — `When called` was parse → preconditions → skill → execute →
 * read-back → return, so similar-item discovery happened only if the caller already thought to
 * ask. The repo's disclosure rule ("Search by symbol name, file path, and error string — never by
 * title alone, the same bug is routinely filed under a different name") says why that must not be
 * caller-dependent: a caller who does not know a sibling exists cannot ask for it, and an operator
 * that does not search cannot answer. Missing a sibling leaves a fixed defect filed as open and
 * leaves work unburned.
 *
 * The unfixed shape is authentic, not invented: the pre-fix six-step `When called` protocol (the
 * discovery-less text this change replaced) is quoted verbatim below as the negative control, so
 * this guard is demonstrably able to fail.
 *
 * Arms (all matched against whitespace-normalised prose, so line wrapping is irrelevant):
 *   1. both discovery duties are required, not optional
 *   2. discovery is operator-initiated and unconditional (never gated on the caller requesting it)
 *   3. both surface candidates only — neither acts on them, neither resolves automatically
 *   4. similar-item discovery runs on every invocation
 *   5. sibling cascade-scan runs on every closure
 *   6. closure discovery is keyed on evidence, never on title similarity alone
 *   7. both report what they searched by (an empty result is distinguishable from an unsearched one)
 *   8. `When called` wires both duties in as a mandatory step
 *
 * Usage: node tools/test-70f75751-operator-discovery.mjs [--file <path-to-backlog-operator.md>]
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

// Authentic pre-fix text (the discovery-less `When called` protocol, replaced by this change).
// Kept verbatim as the negative control.
const PRE_FIX_PROTOCOL = `1. Parse the verb and arguments from the incoming request.
2. Check preconditions — if not met, return ESCALATE with the unmet precondition.
3. Load the backlog skill and follow its contract for the verb.
4. Execute the operation.
5. Read back the result (confirm the write matches what was intended).
6. Return the result or ESCALATE if the read-back does not match.`;

const OPERATOR_INVARIANTS = [
  ['both discovery duties are required, not optional', /Two discovery duties are required, not optional/],
  ['discovery is operator-initiated and unconditional', /operator-initiated and unconditional/],
  ['never gated on the caller requesting it', /never gated on the caller requesting them/],
  ['both surface candidates only', /surface candidates only/],
  ['neither resolves anything automatically', /neither resolves anything automatically/],
  ['similar-item discovery runs on every invocation', /Similar-item discovery .{0,4}on every invocation/],
  ['similar-item matches are candidates for potential execution', /candidates for potential execution/],
  ['sibling cascade-scan runs on every closure', /Sibling cascade-scan .{0,4}on every closure/],
  ['cascade matches are cascade-close candidates with evidence', /cascade-close candidates with evidence/],
  ['closure discovery is keyed on evidence, never on title similarity alone', /never on title similarity alone/],
  ['both state what they searched by', /state what they searched by/],
  ['an empty result is distinguishable from an unsearched one', /an empty result from an unsearched one/],
  ['When called wires similar-item discovery in on every invocation', /on every invocation run similar-item discovery/],
  ['When called wires the cascade-scan in on every closure', /on every closure also run the/],
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
// Arms 1..14 — backlog-operator runs operator-initiated discovery unconditionally.
// ---------------------------------------------------------------------------
const oText = fs.readFileSync(TARGET, 'utf8');
const oMissing = missingFrom(oText, OPERATOR_INVARIANTS);
report(
  `70f75751: backlog-operator runs discovery on every invocation and every closure (${OPERATOR_INVARIANTS.length} invariants)`,
  oMissing.length === 0,
  oMissing.length === 0
    ? `all ${OPERATOR_INVARIANTS.length} invariants present in ${path.relative(REPO_ROOT, TARGET)}`
    : `MISSING: ${oMissing.join('; ')}`,
);

// ---------------------------------------------------------------------------
// Arm 15 — NEGATIVE CONTROL: the pre-fix discovery-less protocol is rejected.
// ---------------------------------------------------------------------------
const preMissing = missingFrom(PRE_FIX_PROTOCOL, OPERATOR_INVARIANTS);
report(
  '70f75751: the pre-fix `When called` protocol with no discovery step is REJECTED',
  preMissing.length > 0,
  preMissing.length > 0
    ? `negative control correctly rejected on ${preMissing.length}/${OPERATOR_INVARIANTS.length} invariants`
    : 'PREDICATE IS VACUOUS — it accepts the unfixed shape',
);

console.log('');
console.log(failed === 0 ? 'ALL 70f75751 ASSERTIONS PASS' : `${failed} 70f75751 ASSERTION(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
