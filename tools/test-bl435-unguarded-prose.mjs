#!/usr/bin/env node
/**
 * tools/test-bl435-unguarded-prose.mjs
 *
 * Red->green regression pin for BL-435: every rewrite and every `--check` in `tools/plan-status.mjs`
 * was bounded by the `PLAN-STATUS:BEGIN`/`END` markers, so a hand-written section sat outside the
 * guard entirely and could confidently point at finished work while `--check` printed
 * "OK — derived blocks match BACKLOG.md".
 *
 * Two recorded incidents, both in documents every routing doc sends agents to first:
 *   - `STATE.md` §"What to do next" led with **PKT-41 (BL-391)** and **PKT-19 (BL-329)**, both DONE
 *     and neither id present in `BACKLOG.md`. A session acted on that entry before catching it.
 *   - `PLAN.md` §"Wave summary" read "Total: 56 packets" against a derived ledger of 72, with two
 *     whole waves missing, and a tier distribution contradicted by the recount snippet printed
 *     three lines below it.
 *
 * WHY THE SCAN IS NARROW, and why that is not a dodge. Scanning all prose for closed ids was
 * measured before being rejected: STATE.md's prose names 58 BL ids of which 46 are closed, nearly
 * all legitimate history. A guard that fires 46 times gets deleted. So an audited region is opted in
 * with `<!-- PLAN-STATUS:AUDIT -->`, and within it only ACTIONABLE claims are checked: not
 * blockquotes (editorial/historical narrative), not fenced code, and only ids named inside a **bold**
 * span — a to-do item's declared target, as opposed to a citation in its prose tail.
 *
 * Assertions below cover both directions, because a guard that never fires and a guard that always
 * fires are the same useless artifact:
 *   MUST FIRE  — a DONE packet named as an actionable target (the literal 2026-08-04 incident);
 *                a closed BL id; a wrong "Total: N packets"; a wrong tier count; a required section
 *                that has lost its marker.
 *   MUST NOT   — the same DONE ids recounted inside a `>` blockquote warning; a closed id cited in
 *                an unbolded prose tail; ids inside a fenced verification snippet; prose outside any
 *                audited region.
 *   REAL FILES — the live `PLAN.md` and `STATE.md` produce zero violations and both required
 *                sections carry the marker.
 *
 * To see it RED, point it at a pre-fix copy of the module (which exports no `auditProse` at all):
 *   PLAN_STATUS_MODULE=/tmp/plan-status-prefix.mjs node tools/test-bl435-unguarded-prose.mjs
 *
 * Usage: node tools/test-bl435-unguarded-prose.mjs
 * Exit 0 iff every assertion holds.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLAN = resolve(ROOT, 'docs/reporting/memory/PLAN.md');
const STATE = resolve(ROOT, 'docs/reporting/memory/STATE.md');

const modulePath = process.env.PLAN_STATUS_MODULE
  ? resolve(process.env.PLAN_STATUS_MODULE)
  : resolve(ROOT, 'tools/plan-status.mjs');
const mod = await import(pathToFileURL(modulePath).href);

let failed = 0;
const report = (name, ok, detail) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

// Against the pre-fix module there is no prose audit at all. Say so once, fail every arm, and stop
// rather than throwing an unrelated TypeError that obscures what is being demonstrated.
if (typeof mod.auditProse !== 'function') {
  for (const arm of [
    'BL-435: a DONE packet named as an actionable target fails --check',
    'BL-435: a closed BL id named as an actionable target fails --check',
    'BL-435: a hand-restated "Total: N packets" that disagrees with the ledger fails --check',
    'BL-435: a hand-restated tier count that disagrees with the packets fails --check',
    'BL-435: a required hand-written section without the AUDIT marker fails --check',
    'BL-435: the corrected section passes',
    'BL-435: historical ids inside a blockquote do NOT fire',
    'BL-435: a closed id cited outside a bold span does NOT fire',
    'BL-435: ids inside a fenced code block do NOT fire',
    'BL-435: prose outside any audited region does NOT fire',
    'BL-435: the real PLAN.md and STATE.md produce zero violations',
    'BL-435: both required sections carry the AUDIT marker',
  ]) {
    report(arm, false, 'plan-status.mjs exports no auditProse — hand-written prose is unguarded');
  }
  console.log(`\ntest-bl435: ${failed} failure(s).`);
  process.exit(1);
}

const { auditProse } = mod;

/** A model shaped like build()'s output, with no dependency on the real documents. */
const model = {
  statuses: new Map([
    [391, 'RESOLVED'], // closed -> DONE packet PKT-41
    [329, 'CLOSED'], // closed -> DONE packet PKT-19
    [328, 'OPEN'],
    [367, 'RESOLVED'], // closed, but only ever cited, never a target
    [401, 'OPEN'],
  ]),
  packets: [
    { id: 'PKT-41', num: 41, targets: [391], open: [], status: 'DONE', tier: 'sonnet' },
    { id: 'PKT-19', num: 19, targets: [329], open: [], status: 'DONE', tier: 'sonnet' },
    { id: 'PKT-30', num: 30, targets: [328], open: [328], status: 'OPEN', tier: 'haiku' },
  ],
};

const wrap = (body) => ['# Doc', '', '<!-- PLAN-STATUS:AUDIT -->', '## What to do next', '', body, '', '## History', ''].join('\n');

// --- MUST FIRE -------------------------------------------------------------
// The literal 2026-08-04 incident: the list led with two DONE packets.
const incident = auditProse(
  wrap('1. **PKT-41 (BL-391)** — finish the stage substrate.\n2. **PKT-19 (BL-329)** — the recluster.'),
  'STATE.md',
  model,
);
report(
  'BL-435: a DONE packet named as an actionable target fails --check',
  incident.some((v) => v.includes('PKT-41')) && incident.some((v) => v.includes('PKT-19')),
  `${incident.length} violation(s): ${incident.join(' | ') || 'none'}`,
);
report(
  'BL-435: a closed BL id named as an actionable target fails --check',
  auditProse(wrap('1. **Deploy to close BL-391.**'), 'STATE.md', model).some((v) => v.includes('BL-391')),
  'a closed id in a bold to-do title must fire',
);
report(
  'BL-435: a hand-restated "Total: N packets" that disagrees with the ledger fails --check',
  auditProse(wrap('**Total: 56 packets.**'), 'STATE.md', model).some((v) => v.includes('Total: 56')),
  'the ledger has 3 packets in this model',
);
report(
  'BL-435: a hand-restated tier count that disagrees with the packets fails --check',
  auditProse(wrap('Tier distribution: **sonnet 45**, **haiku 4**.'), 'STATE.md', model).some((v) =>
    v.includes('sonnet 45'),
  ),
  'the model has sonnet 2 / haiku 1',
);
report(
  'BL-435: a required hand-written section without the AUDIT marker fails --check',
  auditProse('# Doc\n\n## What to do next\n\n1. **PKT-30 (BL-328)** — go.\n', 'STATE.md', model).some((v) =>
    v.includes('must carry'),
  ),
  'removing the marker must not silence the guard — that is the recurrence hole',
);

// --- MUST NOT FIRE ---------------------------------------------------------
report(
  'BL-435: the corrected section passes',
  auditProse(wrap('1. **PKT-30 (BL-328)** — target-degree threshold calibration.'), 'STATE.md', model).length === 0,
  'an open target is the whole point of the section',
);
// The ⚠️ warning in the real file recounts the incident BY NAMING ITS DONE IDS. If the scan fired on
// that, the fix would delete the institutional memory of why the fix exists.
report(
  'BL-435: historical ids inside a blockquote do NOT fire',
  auditProse(
    wrap(
      '> ⚠️ As of 2026-08-04 this list led with **PKT-41 (BL-391)** + **PKT-19 (BL-329)**, both\n' +
        '> already **DONE**. A session acted on that entry before catching it.\n' +
        '\n1. **PKT-30 (BL-328)** — go.',
    ),
    'STATE.md',
    model,
  ).length === 0,
  'editorial narrative must survive the guard',
);
report(
  'BL-435: a closed id cited outside a bold span does NOT fire',
  auditProse(wrap('5. **12 dead tests in `analysis:test`** — dead tests read as coverage (BL-367’s lesson).'), 'STATE.md', model)
    .length === 0,
  'a citation in the prose tail is not a declared target',
);
report(
  'BL-435: ids inside a fenced code block do NOT fire',
  auditProse(wrap('```\ngrep "### PKT-41" PLAN.md   # **PKT-41 (BL-391)**\n```'), 'STATE.md', model).length === 0,
  'the wave summary embeds a verification snippet',
);
report(
  'BL-435: prose outside any audited region does NOT fire',
  auditProse('# Doc\n\n## History\n\n**PKT-41 (BL-391)** shipped 2026-08-01.\n', 'PLAN.md', {
    ...model,
    // "## Wave summary" is required in PLAN.md; drop that requirement for this arm by asserting on
    // the id-scan only.
  }).every((v) => v.includes('must carry')),
  'only opted-in sections are scanned',
);

// --- REAL FILES ------------------------------------------------------------
const planSrc = readFileSync(PLAN, 'utf8');
const stateSrc = readFileSync(STATE, 'utf8');
report(
  'BL-435: both required sections carry the AUDIT marker',
  /<!-- PLAN-STATUS:AUDIT -->\s*\n## Wave summary/.test(planSrc) &&
    /<!-- PLAN-STATUS:AUDIT -->\s*\n## What to do next/.test(stateSrc),
  'PLAN.md § Wave summary and STATE.md § What to do next',
);

// End-to-end: the real tool, the real documents, the real model built from BACKLOG.md. This is the
// arm that proves the guard is wired into `--check` rather than merely exported.
//
// It asserts on STALE PROSE lines specifically, NOT on the exit code. In a shared checkout another
// agent's uncommitted BACKLOG.md edit makes the derived blocks legitimately stale, and `--check`
// exits 1 for that reason alone — which says nothing about BL-435 and would make this arm report a
// failure it did not find (BL-456: a suite result belongs to the tree state it ran against). Derived
// -block staleness is BL-224's guard and is covered by its own path.
const check = spawnSync(process.execPath, [resolve(ROOT, 'tools/plan-status.mjs'), '--check'], {
  cwd: ROOT,
  encoding: 'utf8',
});
const proseViolations = (check.stderr || '')
  .split('\n')
  .filter((l) => l.includes('STALE PROSE'));
report(
  'BL-435: the real PLAN.md and STATE.md carry no stale hand-written claims',
  proseViolations.length === 0,
  proseViolations.join(' | ') ||
    (check.status === 0
      ? 'audited prose names only open work'
      : 'audited prose clean (derived blocks stale for an unrelated reason — not this item)'),
);

console.log(`\ntest-bl435: ${failed} failure(s).`);
process.exit(failed === 0 ? 0 : 1);
