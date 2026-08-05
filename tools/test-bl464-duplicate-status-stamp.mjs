#!/usr/bin/env node
/**
 * tools/test-bl464-duplicate-status-stamp.mjs
 *
 * Red->green regression pin for BL-464: `tools/plan-status.mjs`'s `stampPackets` replaced the
 * machine-owned status stamp POSITIONALLY — it inspected only the line immediately after the packet
 * heading (optionally past one blank line). A second stamp deeper in a packet body was therefore
 * never rewritten, never validated, and never reported stale by `--check`, because a duplicate is
 * *stable* rather than drifting: `replaceBlock` + `stampPackets` reproduced the file byte-identically
 * on every run, so the duplicate survived regeneration indefinitely.
 *
 * Measured 2026-08-05, six packets in `docs/reporting/memory/PLAN.md` carried two stamps and four of
 * them contradicted reality — PKT-20/21/23/43 read `OPEN` for shipped work while the authoritative
 * stamp above read `DONE`. Those stale lines carry the verbatim
 * `derived by tools/plan-status.mjs, do not hand-edit` suffix, which is the strongest signal the
 * project has that a line is machine-owned and current.
 *
 * Assertions:
 *   1. FIXTURE — a packet carrying a stamp after its heading AND a second stamp deeper in its body
 *      reduces to exactly ONE stamp, matching the derived status. Against the pre-fix code the
 *      fixture keeps BOTH, and the surviving stale one still says OPEN.
 *   2. FIXTURE — a stamp belonging to the NEXT packet is not eaten by the previous packet's block,
 *      i.e. the block boundary is respected.
 *   3. FIXTURE — stamping is idempotent: a second pass over stamped output is a fixed point.
 *   4. REAL FILE — every packet block in the real `PLAN.md` contains exactly one stamp. This is the
 *      companion assertion BL-464's acceptance requires; it is red today on six packets.
 *
 * To see it RED, point it at a pre-fix copy of the module:
 *   PLAN_STATUS_MODULE=/tmp/plan-status-prefix.mjs node tools/test-bl464-duplicate-status-stamp.mjs
 *
 * Usage: node tools/test-bl464-duplicate-status-stamp.mjs
 * Exit 0 iff every assertion holds.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLAN = resolve(ROOT, 'docs/reporting/memory/PLAN.md');

const modulePath = process.env.PLAN_STATUS_MODULE
  ? resolve(process.env.PLAN_STATUS_MODULE)
  : resolve(ROOT, 'tools/plan-status.mjs');
const { stampPackets } = await import(pathToFileURL(modulePath).href);

let failed = 0;
const report = (name, ok, detail) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const STAMP_RE = /^> \*\*status:/;

/** Count `> **status:` lines per `### PKT-` block — BL-464's own measurement method. */
const stampsPerPacket = (src) => {
  const counts = new Map();
  let current = null;
  for (const line of src.split('\n')) {
    const heading = line.match(/^### (PKT-\d+) — /);
    if (heading) {
      current = heading[1];
      counts.set(current, 0);
      continue;
    }
    if (/^#{1,4} /.test(line)) current = null;
    if (current && STAMP_RE.test(line)) counts.set(current, counts.get(current) + 1);
  }
  return counts;
};

// ---------------------------------------------------------------------------
// 1 + 2 + 3. Fixture: a second stamp deeper in the body, and a block boundary.
// ---------------------------------------------------------------------------
const STALE = '> **status: OPEN** — still open: BL-360 · derived by `tools/plan-status.mjs`, do not hand-edit';

const fixture = [
  '# Task packets', // 0
  '', // 1
  '### PKT-20 — a packet whose work shipped', // 2
  '', // 3
  STALE, // 4  <- adjacent stamp, stale; the old code rewrites only this one
  '', // 5
  '**Goal:** something that shipped.', // 6
  '', // 7
  '**2026-08-04 narrowing note.** An agent pasted surrounding context, and with it:', // 8
  '', // 9
  STALE, // 10 <- the BL-464 defect: a SECOND stamp, invisible to the positional replacement
  '', // 11
  '**Closes:** BL-360', // 12
  '', // 13
  '### PKT-21 — a second packet', // 14
  '', // 15
  '**Closes:** BL-361', // 16
  '', // 17
].join('\n');

const model = {
  packets: [
    { id: 'PKT-20', num: 20, headingLine: 2, targets: [360], open: [], status: 'DONE' },
    { id: 'PKT-21', num: 21, headingLine: 14, targets: [361], open: [361], status: 'OPEN' },
  ],
};

const stamped = stampPackets(fixture, model);
const counts = stampsPerPacket(stamped);

report(
  'BL-464: a second stamp deeper in the packet body is removed — exactly one survives',
  counts.get('PKT-20') === 1,
  `PKT-20 carries ${counts.get('PKT-20')} stamp(s), expected 1`,
);

const survivingPkt20 = stamped
  .split('\n')
  .slice(stamped.split('\n').findIndex((l) => l.startsWith('### PKT-20')))
  .filter((l) => STAMP_RE.test(l));
report(
  'BL-464: the surviving PKT-20 stamp reports the DERIVED status (DONE), not the pasted OPEN',
  survivingPkt20[0]?.includes('**status: DONE**') === true,
  `got: ${survivingPkt20[0] ?? '<none>'}`,
);

report(
  'BL-464: the next packet block is not consumed — PKT-21 keeps exactly its own stamp',
  counts.get('PKT-21') === 1,
  `PKT-21 carries ${counts.get('PKT-21')} stamp(s), expected 1`,
);

report(
  'BL-464: body content survives stamp removal',
  stamped.includes('**Goal:** something that shipped.') &&
    stamped.includes('**2026-08-04 narrowing note.**') &&
    stamped.includes('**Closes:** BL-360'),
  'packet prose must not be collateral damage',
);

// Idempotency must be measured the way the tool actually runs: it re-reads the file and rebuilds
// the model (and therefore the heading line numbers) on every invocation. Re-using the first pass's
// model would point at pre-removal line numbers and test nothing real.
const remodel = (src) => ({
  packets: model.packets.map((p) => ({
    ...p,
    headingLine: src.split('\n').findIndex((l) => l.startsWith(`### ${p.id} — `)),
  })),
});
report(
  'BL-464: stamping is idempotent — a second pass is a fixed point',
  stampPackets(stamped, remodel(stamped)) === stamped,
  're-running the tool must not churn the file',
);

// ---------------------------------------------------------------------------
// 4. The real PLAN.md — BL-464's companion assertion. Red today on six packets.
// ---------------------------------------------------------------------------
const realCounts = stampsPerPacket(readFileSync(PLAN, 'utf8'));
const dupes = [...realCounts].filter(([, n]) => n !== 1);
report(
  'BL-464: every packet block in the real PLAN.md contains exactly one status stamp',
  dupes.length === 0,
  dupes.length ? dupes.map(([p, n]) => `${p}=${n}`).join(', ') : `${realCounts.size} packets, all single-stamped`,
);

console.log(`\ntest-bl464: ${failed} failure(s).`);
process.exit(failed === 0 ? 0 : 1);
