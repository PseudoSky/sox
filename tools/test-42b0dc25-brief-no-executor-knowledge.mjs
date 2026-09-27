#!/usr/bin/env node
/**
 * tools/test-42b0dc25-brief-no-executor-knowledge.mjs
 *
 * Red->green contract pin for backlog 42b0dc25: agent-manager authored a dispatch brief that
 * carried knowledge belonging to the ROUTED executor — hardcoded artifact paths, the extension
 * release/install discipline ("the manifest version bumped, and the extension installed and
 * verified on its declared hosts"), and an item->file mapping — instead of letting the routed
 * executor derive its own discipline from the spec it owns. That masks the executor's real gaps:
 * a run looks correct when the injected knowledge, not the executor, supplied the discipline.
 *
 * The negative control is AUTHENTIC, not invented: the exact pre-fix brief text as dispatched
 * (opencode session part prt_0deddf315001ZebaxYwpdvPxXY, 2026-09-26T17:58:02Z). It is embedded
 * verbatim below and is REJECTED by the same predicate that accepts the fixed artifact, so this
 * guard is demonstrably able to fail.
 *
 * Arms (whitespace-normalised, so line wrapping is irrelevant):
 *   1. agent-manager.md carries the brief-independence mandate — a brief derives the change
 *      discipline and the verification standard from the spec the routed executor owns
 *   2. agent-manager.md forbids injecting executor-owned knowledge into a brief
 *   3. agent-manager.md enumerates what a brief may not carry (repo layout / artifact type /
 *      release-install procedure)
 *   4. agent-manager.md requires a claim to be decided by reading the artifact, never by a
 *      search hit or a rendered summary
 *   5. agent-manager.md routes backlog traffic through backlog-operator (no direct graph writes)
 *   6. NEGATIVE CONTROL: the authentic pre-fix brief is rejected (executor-owned knowledge found)
 *
 * Usage:
 *   node tools/test-42b0dc25-brief-no-executor-knowledge.mjs               # check the shipped spec
 *   node tools/test-42b0dc25-brief-no-executor-knowledge.mjs --fixture     # check the fixture (exit non-zero: rejected)
 *   node tools/test-42b0dc25-brief-no-executor-knowledge.mjs --file <path> # check an alternate spec
 *
 * Exit 0 iff the artifact carries every mandate invariant AND does not itself embed
 * executor-owned knowledge AND the pre-fix negative control is rejected.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TARGET = path.join(REPO_ROOT, 'extensions/agents/agent-manager/agent-manager.md');

const argv = process.argv.slice(2);
const FIXTURE_MODE = argv.includes('--fixture');
const fileArgIdx = argv.indexOf('--file');
const TARGET = fileArgIdx !== -1 ? path.resolve(argv[fileArgIdx + 1]) : DEFAULT_TARGET;

// -------------------------------------------------------------------------------------------
// The authentic pre-fix brief, verbatim as dispatched (prt_0deddf315001ZebaxYwpdvPxXY,
// 2026-09-26T17:58:02Z). Kept exactly as authored — the negative control is evidence, not a
// shape we invented.
// -------------------------------------------------------------------------------------------
const PRE_FIX_BRIEF = `Work these four ready backlog items to completion — all four, in this run.Project sox-ecosystem, component agents.


  4fc3704e-56b0-4363-a1fe-ec8a51826f8b  BUG      resolve accepts a commit ref as terminal
                                                 evidence — a merge can close a publishable
                                                 package or an unreleased service
  decda240-0954-4d99-bfc3-6c0e896cc274  DEBT     dispatcher has no project-level definition of done
  e5a790a7-ab24-4e1b-89fe-bef94d9511d5  DEBT     acceptance criteria are written only for epics
                                                 and plan states
  3ec44b8c-f6dd-4c67-8a38-eff7e0ba8e0e  FEATURE  product.md never mentions priority; no
                                                 reassignment path


Run your normal direct-dispatch playbook end to end — intake, decompose, route each item to
the executor that owns it, dispatch in the background, verify every outcome from state,
review-gate, merge, resolve. Do not do the work yourself.


Context you need to not get this wrong:


- All four are AGENT-SPEC changes. The artifacts are extension specs under
  sox-ecosystem/extensions/agents/{backlog-operator,dispatcher,product}/. Route them to the
  agent that owns authoring agent definitions. Such a change is not done at merge: the
  extension source must be edited, the manifest version bumped, and the extension installed
  and verified on its declared hosts. A merged diff alone is not a completed agent change —
  which is the same standard finding #1 is about, so apply it to yourselves here.


- Deliver GENERAL fixes, not one-off patches. Each item describes a CLASS of failure, so the
  fix must make the spec handle the class (e.g. closure requiring evidence for any
  publishable or released artifact; a project DoD for any run), not merely the cited example.


- Their fixes land in overlapping files. Handle the write-scope consequences however your
  playbook requires.


- Items 1–3 change your own spec and product's. Treat them like any other item — do not
  exempt your own definition from the audit.


Done when: all four items are closed with verification evidence attached, or BLOCKED with a
named blocker. Nothing left IN_PROGRESS, nothing in flight. Report each item's uid, what
changed, and the evidence you read directly.`;

// -------------------------------------------------------------------------------------------
// Violation class 1 — executor-owned knowledge injected into a brief. These are the authentic
// incident markers; a conformant brief carries none of them.
// -------------------------------------------------------------------------------------------
const HARDCODED_MARKERS = [
  ['hardcoded artifact-path list', /extensions\/agents\/\{[a-z0-9-]+(?:,[a-z0-9-]+)+\}/i],
  ['release/install discipline injected ("manifest version bumped")', /manifest version bumped/i],
  ['declared-hosts verification injected ("installed and verified on its declared hosts")',
    /installed and verified on its declared hosts/i],
  ['item->file mapping ("change your own spec and product\'s")', /change your own spec and product/i],
];

// Matched against whitespace-normalised text: the authentic brief wraps mid-phrase, and line
// wrapping is an artifact of transport, never of the defect.
const injectedKnowledgeIn = (text) => {
  const n = normalise(text);
  return HARDCODED_MARKERS.filter(([, re]) => re.test(n)).map(([name]) => name);
};

// -------------------------------------------------------------------------------------------
// Violation class 2 — a spec that fails to carry the brief-independence mandate it must state.
// -------------------------------------------------------------------------------------------
const MANDATE = [
  ['brief derives the discipline + verification standard from the routed executor\'s own spec',
    /derives the change discipline and the verification standard from the spec it owns/],
  ['forbids injecting executor-owned knowledge into a brief',
    /never inject knowledge that belongs to the routed executor/],
  ['enumerates what a brief may not carry (repo layout / artifact type / release-install procedure)',
    /no repo layout, no artifact type, no release\/install procedure/],
  ['requires a claim to be decided by reading the artifact, never by a rendered result',
    /a search hit is not a reading; a rendered result is not the artifact/i],
  ['routes backlog traffic through backlog-operator (no direct graph writes)',
    /No agent-manager-owned process writes the backlog graph directly/],
];

const normalise = (s) => s.replace(/\s+/g, ' ').trim();
const missingMandateFrom = (text) => {
  const n = normalise(text);
  return MANDATE.filter(([, re]) => !re.test(n)).map(([name]) => name);
};

let failed = 0;
function report(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
}

// -------------------------------------------------------------------------------------------
// Fixture mode — apply the conformance predicate to the authentic pre-fix brief. The guard's
// contract in this mode: the brief is REJECTED, and exit is non-zero.
// -------------------------------------------------------------------------------------------
if (FIXTURE_MODE) {
  const injected = injectedKnowledgeIn(PRE_FIX_BRIEF);
  report(
    '42b0dc25: authentic pre-fix brief is REJECTED (executor-owned knowledge found)',
    injected.length > 0,
    injected.length > 0
      ? `rejected on ${injected.length}/${HARDCODED_MARKERS.length}: ${injected.join('; ')}`
      : 'PREDICATE IS VACUOUS — it accepts the injected-knowledge brief',
  );
  console.log('');
  console.log(injected.length > 0
    ? 'FIXTURE REJECTED (exit non-zero, as required)'
    : 'FIXTURE ACCEPTED — predicate is vacuous');
  process.exit(injected.length > 0 ? 1 : 0);
}

// -------------------------------------------------------------------------------------------
// Default mode — the shipped artifact must carry every mandate invariant, must not itself
// embed executor-owned knowledge, and the negative control must still be rejected.
// -------------------------------------------------------------------------------------------
const text = fs.readFileSync(TARGET, 'utf8');

const missing = missingMandateFrom(text);
report(
  `42b0dc25: agent-manager.md carries the brief-independence mandate (${MANDATE.length} invariants)`,
  missing.length === 0,
  missing.length === 0
    ? `all ${MANDATE.length} invariants present in ${path.relative(REPO_ROOT, TARGET)}`
    : `MISSING: ${missing.join('; ')}`,
);

const selfInjected = injectedKnowledgeIn(text);
report(
  '42b0dc25: agent-manager.md does not itself embed executor-owned knowledge',
  selfInjected.length === 0,
  selfInjected.length === 0
    ? 'no incident marker present in the spec body'
    : `EMBEDDED: ${selfInjected.join('; ')}`,
);

const controlInjected = injectedKnowledgeIn(PRE_FIX_BRIEF);
report(
  '42b0dc25: NEGATIVE CONTROL — the authentic pre-fix brief is REJECTED',
  controlInjected.length > 0,
  controlInjected.length > 0
    ? `negative control correctly rejected on ${controlInjected.length}/${HARDCODED_MARKERS.length} markers`
    : 'PREDICATE IS VACUOUS — it accepts the pre-fix brief',
);

console.log('');
console.log(failed === 0 ? 'ALL 42b0dc25 ASSERTIONS PASS' : `${failed} 42b0dc25 ASSERTION(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
