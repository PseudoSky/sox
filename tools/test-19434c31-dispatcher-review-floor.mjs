#!/usr/bin/env node
/**
 * tools/test-19434c31-dispatcher-review-floor.mjs
 *
 * Red->green contract pin for backlog 19434c31: the dispatcher's blind-review gate had NO
 * minimum-severity floor, so any finding at any severity re-opened the loop and the review never
 * converged. A blind review deliberately carries zero prior context, so every fresh round surfaces
 * new sub-threshold observations — treating them as blocking is a loop with no fixed point.
 *
 * The unfixed shape is authentic, not invented: v1.4.0 (commit 9ab825e3) rule 5 read
 * "Every merge waits for a `code-reviewer` pass with zero open items." — no floor, no cap.
 * That exact sentence is the negative control below (fails the predicate), so this guard is
 * demonstrably able to fail: it is rejected by the same predicate that accepts the fixed artifact.
 *
 * Arms (all matched against whitespace-normalised prose, so line wrapping is irrelevant):
 *   1. the minimum-severity floor: only a finding at or above HIGH re-opens the review
 *   2. sub-HIGH findings are recorded once, non-blocking, and never re-reviewed
 *   3. discretion may clear a sub-HIGH finding, never elevate one
 *   4. a hard round cap (2 rounds; never a third)
 *   5. the "Review-loop divergence" failure mode is catalogued
 *   6. the Step 5 merge gate reiterates the same floor
 *
 * Usage: node tools/test-19434c31-dispatcher-review-floor.mjs [--file <path-to-dispatcher.md>]
 * Exit 0 iff the artifact carries the floor AND the pre-fix negative control is rejected.
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

const INVARIANTS = [
  ['minimum-severity floor (only >= HIGH re-opens the review)', /no finding at or above \*\*HIGH\*\*/],
  ['sub-HIGH findings recorded once as non-blocking', /recorded once as non-blocking/],
  ['sub-HIGH findings never re-reviewed', /MUST NOT\*\* trigger a fix round or a further review/],
  ['discretion may clear, never elevate', /NEVER\*\* elevate a sub-HIGH finding/],
  ['hard round cap (at most 2 rounds)', /at most 2 blind-review rounds/],
  ['the cap forbids a third round', /Never a third round/],
  ['Review-loop divergence failure mode catalogued', /Review-loop divergence/],
  ['Step 5 merge gate reiterates the floor', /Only blocking items \(≥ HIGH — rule 5\) go back to the executor/],
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
// Arm 1..8 — the shipped artifact carries every invariant.
// ---------------------------------------------------------------------------
const text = fs.readFileSync(TARGET, 'utf8');
const missing = missingFrom(text);
report(
  `19434c31: dispatcher review gate carries the severity floor + cap (${INVARIANTS.length} invariants)`,
  missing.length === 0,
  missing.length === 0
    ? `all ${INVARIANTS.length} invariants present in ${path.relative(REPO_ROOT, TARGET)}`
    : `MISSING: ${missing.join('; ')}`,
);

// ---------------------------------------------------------------------------
// Arm 9 — NEGATIVE CONTROL: the pre-fix rule-5 shape is rejected. This is the
// proof the predicate can fail (BL-225: seen red with the fix disabled).
// ---------------------------------------------------------------------------
const preFixMissing = missingFrom(PRE_FIX);
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
