#!/usr/bin/env node
/**
 * tools/test-adr0011-bl-id-counter.mjs
 *
 * Red->green contract pin for ADR-0011 Stage 1 (R3 watermark guard, R5 id-counter,
 * §4 Stage 1 items 1-4). Arms:
 *
 *   1. Seeding is idempotent-refusing: `--seed` on an existing counter file fails without
 *      `--reseed`; `--reseed` refuses to move the watermark backward.
 *   2. Sequential reservation: repeated `bl-id-counter.mjs` calls issue BL-<watermark+1>,
 *      BL-<watermark+2>, ... in order, and each is recorded in `issued`.
 *   3. Race safety: N concurrent reservations against the same counter file produce N unique
 *      ids (the mkdir-based lock serializes them) — mirrors the BL-416/BL-359 race this counter
 *      is deliberately built the same way to avoid.
 *   4. `check-bl-id-integrity.mjs` REJECTS a newly-staged `### BL-<n>` heading whose id is ABOVE
 *      the counter's seeded watermark (ADR-0011 §3 R3 / §4 Stage 1 item 3) — the mechanically
 *      enforced boundary that makes "please use the tool" more than a convention.
 *   5. `check-bl-id-integrity.mjs` REJECTS a staged `### BL-<n>` heading whose id is already in
 *      the counter's `issued` list (ADR-0011 §4 Stage 1 item 4) — a human hand-filing an id the
 *      tool already issued is exactly the split-brain collision this migration exists to end.
 *   6. `check-bl-id-integrity.mjs` still PASSES a commit that stages neither a markdown heading
 *      above the watermark nor one colliding with `issued` — proving Stage 1 does not regress
 *      the pre-existing checks (arms 1-3 of the original script) for ordinary commits.
 *
 * Arms 4 and 5 were watched RED against the pre-patch `check-bl-id-integrity.mjs` during
 * authoring (it exited 0 — silently allowed the violation through) and GREEN after the ADR-0011
 * Stage 1 patch (BL-225: watched fail-then-pass, not asserted).
 *
 * Usage: node tools/test-adr0011-bl-id-counter.mjs
 * Exit 0 iff every assertion holds.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COUNTER = path.join(HERE, 'bl-id-counter.mjs');
const INTEGRITY = path.join(HERE, 'check-bl-id-integrity.mjs');
const MARKERS = path.join(HERE, 'check-backlog-markers.mjs');

let failures = 0;
function assertTrue(cond, msg) {
  if (!cond) {
    failures++;
    console.error(`  FAIL  ${msg}`);
  } else {
    console.log(`  ok    ${msg}`);
  }
}

function run(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', ...opts });
    return { code: 0, stdout: out, stderr: '' };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : String(err.message || err),
    };
  }
}

function mkScratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adr0011-bl-id-counter-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'ADR-0011 test'], { cwd: dir });
  // check-bl-id-integrity.mjs delegates to <REPO_ROOT>/tools/check-backlog-markers.mjs — the
  // scratch repo IS its own git-common-dir root, so it needs its own copy of that script.
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.copyFileSync(MARKERS, path.join(dir, 'tools', 'check-backlog-markers.mjs'));
  return dir;
}

// `extraHeadingBlock`, when present, adds exactly one more OPEN heading, so `totalOpen` must be
// incremented by the caller to keep check-backlog-markers.mjs's Rule 4 (header count == derived
// count) satisfied — otherwise every arm would fail on an unrelated Rule 4 mismatch, not the
// watermark/issued-id guard under test.
function writeBacklog(dir, { extraHeadingBlock = '', totalOpen = 2 } = {}) {
  const content =
    `# BACKLOG.md\n\n**Total open: ${totalOpen}.**\n\n` +
    `### BL-100 — First item — **Open** (2026-01-01)\n\nBody.\n\n---\n\n` +
    `### BL-101 — Second item — **Open** (2026-01-01)\n\nBody.\n\n---\n` +
    extraHeadingBlock;
  fs.writeFileSync(path.join(dir, 'BACKLOG.md'), content);
}

function writeChangelog(dir) {
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# CHANGELOG.md\n\nNothing yet.\n');
}

function writeCounter(dir, { watermark, next, issued = [] }) {
  fs.writeFileSync(
    path.join(dir, '.bl-id-counter.json'),
    JSON.stringify(
      {
        watermark,
        next,
        seededAt: new Date().toISOString(),
        seededFrom: { backlogMax: watermark, changelogMax: watermark, graphMax: watermark },
        issued,
      },
      null,
      2,
    ) + '\n',
  );
}

function commitBaseline(dir) {
  execFileSync('git', ['add', 'BACKLOG.md', 'CHANGELOG.md', '.bl-id-counter.json', 'tools/check-backlog-markers.mjs'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir });
}

function stageAndCheck(dir, integrityScript, { headingId }) {
  writeBacklog(dir, {
    totalOpen: 3,
    extraHeadingBlock: `\n### ${headingId} — New item — **Open** (2026-08-06)\n\nBody.\n\n---\n`,
  });
  execFileSync('git', ['add', 'BACKLOG.md'], { cwd: dir });
  const result = run(process.execPath, [integrityScript], { cwd: dir });
  return result;
}

// ── Arm 1: seed idempotent-refusing ──────────────────────────────────────────
{
  const scratch = mkScratchRepo();
  const first = run(process.execPath, [COUNTER, '--seed', '478'], { cwd: scratch });
  assertTrue(first.code === 0, `arm1: first --seed 478 succeeds (stderr: ${first.stderr.split('\n')[0]})`);

  const secondNoForce = run(process.execPath, [COUNTER, '--seed', '480'], { cwd: scratch });
  assertTrue(secondNoForce.code !== 0, 'arm1: second --seed without --reseed is refused');

  const reseedLower = run(process.execPath, [COUNTER, '--reseed', '400'], { cwd: scratch });
  assertTrue(reseedLower.code !== 0, 'arm1: --reseed to a LOWER watermark is refused');

  const reseedHigher = run(process.execPath, [COUNTER, '--reseed', '500'], { cwd: scratch });
  assertTrue(reseedHigher.code === 0, 'arm1: --reseed to a higher watermark succeeds');
  const wm = run(process.execPath, [COUNTER, '--watermark'], { cwd: scratch });
  assertTrue(wm.stdout.trim() === '500', `arm1: watermark now reads 500 (got '${wm.stdout.trim()}')`);
}

// ── Arm 2: sequential reservation ────────────────────────────────────────────
{
  const scratch = mkScratchRepo();
  run(process.execPath, [COUNTER, '--seed', '478'], { cwd: scratch });
  const r1 = run(process.execPath, [COUNTER], { cwd: scratch });
  const r2 = run(process.execPath, [COUNTER], { cwd: scratch });
  const r3 = run(process.execPath, [COUNTER], { cwd: scratch });
  assertTrue(
    r1.stdout.trim() === 'BL-479' && r2.stdout.trim() === 'BL-480' && r3.stdout.trim() === 'BL-481',
    `arm2: sequential reservations are BL-479/480/481 (got '${r1.stdout.trim()}','${r2.stdout.trim()}','${r3.stdout.trim()}')`,
  );
  const issued = JSON.parse(run(process.execPath, [COUNTER, '--issued'], { cwd: scratch }).stdout);
  assertTrue(
    JSON.stringify(issued) === JSON.stringify(['BL-479', 'BL-480', 'BL-481']),
    `arm2: --issued lists all three in order (got ${JSON.stringify(issued)})`,
  );
}

// ── Arm 3: race safety — N concurrent reservations produce N unique ids ─────
{
  const scratch = mkScratchRepo();
  run(process.execPath, [COUNTER, '--seed', '478'], { cwd: scratch });
  const N = 8;
  const results = execFileSync(
    'sh',
    [
      '-c',
      Array.from({ length: N }, () => `node "${COUNTER}"`).join(' & ') + ' & wait',
    ],
    { cwd: scratch, encoding: 'utf8' },
  );
  const ids = results.split('\n').map((l) => l.trim()).filter((l) => /^BL-\d+$/.test(l));
  const uniq = new Set(ids);
  assertTrue(
    ids.length === N && uniq.size === N,
    `arm3: ${N} concurrent reservations -> ${ids.length} ids, ${uniq.size} unique (lock-serialized)`,
  );
}

// ── Arm 4: watermark guard rejects a heading above the watermark ────────────
{
  const scratch = mkScratchRepo();
  writeBacklog(scratch);
  writeChangelog(scratch);
  writeCounter(scratch, { watermark: 478, next: 479, issued: [] });
  commitBaseline(scratch);

  const result = stageAndCheck(scratch, INTEGRITY, { headingId: 'BL-999' });
  assertTrue(
    result.code !== 0 && /watermark/i.test(result.stderr),
    `arm4: staging BL-999 (above watermark 478) is REJECTED with a watermark-referencing message ` +
      `(exit ${result.code}; stderr tail: ${result.stderr.slice(-300)})`,
  );
}

// ── Arm 5: issued-id collision guard rejects a heading matching a tool-issued id ─
{
  const scratch = mkScratchRepo();
  writeBacklog(scratch);
  writeChangelog(scratch);
  writeCounter(scratch, { watermark: 478, next: 480, issued: [{ id: 'BL-479', at: new Date().toISOString(), note: null }] });
  commitBaseline(scratch);

  // BL-479 is below the watermark? No — watermark is 478, so 479 is ABOVE it too, which would
  // also trip arm 4's guard. To isolate arm 5 specifically, raise the watermark above 479 so ONLY
  // the issued-id collision guard can catch it, not the watermark guard.
  writeCounter(scratch, { watermark: 490, next: 491, issued: [{ id: 'BL-479', at: new Date().toISOString(), note: null }] });
  execFileSync('git', ['add', '.bl-id-counter.json'], { cwd: scratch });
  execFileSync('git', ['commit', '-q', '-m', 'raise watermark above the issued id'], { cwd: scratch });

  const result = stageAndCheck(scratch, INTEGRITY, { headingId: 'BL-479' });
  assertTrue(
    result.code !== 0 && /issued|tool[- ]?filed|BL-479/i.test(result.stderr),
    `arm5: staging BL-479 (below watermark, but already tool-issued) is REJECTED ` +
      `(exit ${result.code}; stderr tail: ${result.stderr.slice(-300)})`,
  );
}

// ── Arm 6: an ordinary commit (no watermark violation, no issued collision) still passes ─
{
  const scratch = mkScratchRepo();
  writeBacklog(scratch);
  writeChangelog(scratch);
  writeCounter(scratch, { watermark: 478, next: 479, issued: [] });
  commitBaseline(scratch);

  const result = stageAndCheck(scratch, INTEGRITY, { headingId: 'BL-102' });
  assertTrue(
    result.code === 0,
    `arm6: staging BL-102 (below watermark, never issued) PASSES (exit ${result.code}; stderr tail: ${result.stderr.slice(-300)})`,
  );
}

if (failures > 0) {
  console.error(`\ntest-adr0011-bl-id-counter: ${failures} failure(s).`);
  process.exit(1);
}
console.log('\ntest-adr0011-bl-id-counter: OK — all arms passed.');
