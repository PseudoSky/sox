#!/usr/bin/env node
/**
 * tools/test-adr0011-stage2-write-off.mjs
 *
 * Red->green acceptance harness for ADR-0011 "Stage 2" (SPEC-ADR-0011-S2.md) — closing the three
 * enforcement holes Stage 1 left open: Hole 1 (the watermark/issued-id guard is inert wherever
 * `.bl-id-counter.json` is absent), Hole 2 (`allocate-bl-id.mjs` still wrote a RESERVED stub
 * straight into the shared BACKLOG.md), Hole 3 (only new, above-watermark headings were guarded —
 * edits, deletions, and CHANGELOG.md additions were not).
 *
 * Same shape as tools/test-adr0011-bl-id-counter.mjs: scratch git repo per arm, execFileSync,
 * assertTrue/ok/FAIL reporting, non-zero exit on any failure. All ten arms always execute — no
 * SKIP state exists in this harness (BL-469): only PASS/FAIL.
 *
 * Ten arms (see SPEC-ADR-0011-S2.md §4 for the full RED/GREEN spec each arm proves):
 *   AC-G1a           — Hole 1 closed: G1 (new heading) fires with NO counter file present.
 *   AC-G1b           — the below-watermark loophole is closed (new BL-102, watermark 478).
 *   AC-G1c           — legitimate status-transition edit to an EXISTING heading still passes.
 *   AC-allocate-write — allocate-bl-id.mjs makes zero BACKLOG.md changes, exits 1, RETIRED.
 *   AC-allocate-dryrun — --dry-run retired identically.
 *   AC-allocate-help  — --help unbroken (BL-446 non-regression), zero git I/O.
 *   AC-G3            — title-lock WARNs (not FAILs) on a content-swap edit.
 *   AC-G2            — a brand-new CHANGELOG.md heading for a never-seen id is rejected.
 *   AC-G2-legit      — resolve-and-archive (BACKLOG.md removal + CHANGELOG.md addition, same
 *                       commit) passes cleanly, no WARN either.
 *   AC-G4            — deleting a heading with no CHANGELOG record anywhere WARNs.
 *
 * Per BL-225: RED arms (AC-G1a, AC-G1b, AC-allocate-write, AC-allocate-dryrun, AC-G3, AC-G2,
 * AC-G4) must be watched failing against the pre-fix scripts before the fix lands, and passing
 * after — see SPEC-ADR-0011-S2.md §6 step 5 for the checkpoint-commit procedure used to observe
 * that. This file only asserts the GREEN (post-fix) behavior; the RED observation is a one-time
 * manual gate step, not something this script re-proves on every run (the pre-fix source no
 * longer exists in the working tree after the fix lands).
 *
 * Usage: node tools/test-adr0011-stage2-write-off.mjs
 * Exit 0 iff every assertion holds.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INTEGRITY = path.join(HERE, 'check-bl-id-integrity.mjs');
const ALLOCATE = path.join(HERE, 'allocate-bl-id.mjs');
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

// Deliberately spawnSync, not execFileSync: execFileSync only returns stderr via the thrown
// error object on a non-zero exit, so a WARN-but-exit-0 run (G3/G4's whole point — D3) would
// silently lose its stderr entirely, and an assertion reading it would false-pass on emptiness.
// spawnSync always returns {stdout, stderr, status} regardless of exit code.
function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return {
    code: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function mkScratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adr0011-stage2-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'ADR-0011 Stage 2 test'], { cwd: dir });
  // check-bl-id-integrity.mjs delegates to <REPO_ROOT>/tools/check-backlog-markers.mjs — the
  // scratch repo IS its own git-common-dir root, so it needs its own copy of that script.
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.copyFileSync(MARKERS, path.join(dir, 'tools', 'check-backlog-markers.mjs'));
  return dir;
}

function writeBacklog(dir, { extraHeadingBlock = '', totalOpen = 2 } = {}) {
  const content =
    `# BACKLOG.md\n\n**Total open: ${totalOpen}.**\n\n` +
    `### BL-100 — First item — **Open** (2026-01-01)\n\nBody.\n\n---\n\n` +
    `### BL-101 — Second item — **Open** (2026-01-01)\n\nBody.\n\n---\n` +
    extraHeadingBlock;
  fs.writeFileSync(path.join(dir, 'BACKLOG.md'), content);
}

function writeChangelog(dir, extra = '') {
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), `# CHANGELOG.md\n\nNothing yet.\n${extra}`);
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

function commitBaseline(dir, { withCounter = true } = {}) {
  const files = ['BACKLOG.md', 'CHANGELOG.md', 'tools/check-backlog-markers.mjs'];
  if (withCounter && fs.existsSync(path.join(dir, '.bl-id-counter.json'))) {
    files.push('.bl-id-counter.json');
  }
  execFileSync('git', ['add', ...files], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir });
}

function integrityCheck(dir) {
  return run(process.execPath, [INTEGRITY], { cwd: dir });
}

// ── AC-G1a — Hole 1 is closed: G1 fires with NO counter file present ────────────────────────
{
  const scratch = mkScratchRepo();
  writeBacklog(scratch);
  writeChangelog(scratch);
  // Deliberately do NOT write .bl-id-counter.json at all.
  commitBaseline(scratch, { withCounter: false });
  assertTrue(
    !fs.existsSync(path.join(scratch, '.bl-id-counter.json')),
    'AC-G1a: precondition — no .bl-id-counter.json exists in this scratch repo',
  );

  writeBacklog(scratch, {
    totalOpen: 3,
    extraHeadingBlock: `\n### BL-999 — Fabricated item — **Open** (2026-08-06)\n\nBody.\n\n---\n`,
  });
  execFileSync('git', ['add', 'BACKLOG.md'], { cwd: scratch });
  const result = integrityCheck(scratch);
  assertTrue(
    result.code !== 0 && /brand-new|new heading/i.test(result.stderr) && /BL-999/.test(result.stderr),
    `AC-G1a: staging a new BL-999 heading with NO counter file present is REJECTED, naming BL-999 ` +
      `(exit ${result.code}; stderr tail: ${result.stderr.slice(-300)})`,
  );
  assertTrue(
    !/watermark/i.test(result.stderr.match(/FAIL[^\n]*BL-999[^\n]*/)?.[0] ?? result.stderr),
    'AC-G1a: the failing message for BL-999 does not cite "watermark" — proves G1 fired ' +
      'independently of counter-gated checks 4/5',
  );
}

// ── AC-G1b — the below-watermark loophole is closed ──────────────────────────────────────────
{
  const scratch = mkScratchRepo();
  writeBacklog(scratch);
  writeChangelog(scratch);
  writeCounter(scratch, { watermark: 478, next: 479, issued: [] });
  commitBaseline(scratch);

  writeBacklog(scratch, {
    totalOpen: 3,
    extraHeadingBlock: `\n### BL-102 — New below-watermark item — **Open** (2026-08-06)\n\nBody.\n\n---\n`,
  });
  execFileSync('git', ['add', 'BACKLOG.md'], { cwd: scratch });
  const result = integrityCheck(scratch);
  assertTrue(
    result.code !== 0 && /BL-102/.test(result.stderr),
    `AC-G1b: staging a NEW BL-102 heading (below watermark 478, never issued) is REJECTED ` +
      `(exit ${result.code}; stderr tail: ${result.stderr.slice(-300)})`,
  );
}

// ── AC-G1c — legitimate status-transition edit to an EXISTING heading still passes ──────────
{
  const scratch = mkScratchRepo();
  writeBacklog(scratch);
  writeChangelog(scratch);
  // No counter file — proves this positive-path case needs no counter either.
  commitBaseline(scratch, { withCounter: false });

  const content = fs.readFileSync(path.join(scratch, 'BACKLOG.md'), 'utf8');
  const edited = content
    .replace(
      '### BL-100 — First item — **Open** (2026-01-01)',
      '### BL-100 — First item — **Resolved** (2026-08-06)',
    )
    .replace('**Total open: 2.**', '**Total open: 1.**');
  fs.writeFileSync(path.join(scratch, 'BACKLOG.md'), edited);
  execFileSync('git', ['add', 'BACKLOG.md'], { cwd: scratch });
  const result = integrityCheck(scratch);
  assertTrue(
    result.code === 0 && !/FAIL/.test(result.stderr),
    `AC-G1c: status-only edit to an existing heading (no new heading, title unchanged) still ` +
      `PASSES, no FAIL lines (exit ${result.code}; stderr tail: ${result.stderr.slice(-300)})`,
  );
}

// ── AC-allocate-write — allocate-bl-id.mjs makes zero BACKLOG.md changes on default invocation ─
{
  // Plain fs.mkdtempSync directory, NOT git-inited — proves the retired tool needs no git repo
  // at all, since it no longer resolves REPO_ROOT.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adr0011-allocate-write-'));
  fs.writeFileSync(path.join(dir, 'BACKLOG.md'), '# BACKLOG.md\n\nnothing here\n');
  const before = fs.readFileSync(path.join(dir, 'BACKLOG.md'));

  const result = run(process.execPath, [ALLOCATE], { cwd: dir });
  const after = fs.readFileSync(path.join(dir, 'BACKLOG.md'));
  assertTrue(
    Buffer.compare(before, after) === 0,
    'AC-allocate-write: BACKLOG.md bytes are byte-identical before/after a default invocation',
  );
  assertTrue(
    result.code === 1 && /RETIRED/.test(result.stderr),
    `AC-allocate-write: default invocation exits 1 with a RETIRED message (exit ${result.code}; ` +
      `stderr tail: ${result.stderr.slice(-200)})`,
  );
}

// ── AC-allocate-dryrun — --dry-run is retired identically ───────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adr0011-allocate-dryrun-'));
  fs.writeFileSync(path.join(dir, 'BACKLOG.md'), '# BACKLOG.md\n\nnothing here\n');
  const before = fs.readFileSync(path.join(dir, 'BACKLOG.md'));

  const result = run(process.execPath, [ALLOCATE, '--dry-run'], { cwd: dir });
  const after = fs.readFileSync(path.join(dir, 'BACKLOG.md'));
  assertTrue(
    Buffer.compare(before, after) === 0,
    'AC-allocate-dryrun: BACKLOG.md bytes are byte-identical before/after --dry-run',
  );
  assertTrue(
    result.code === 1 && /RETIRED/.test(result.stderr),
    `AC-allocate-dryrun: --dry-run exits 1 with a RETIRED message (exit ${result.code}; stderr ` +
      `tail: ${result.stderr.slice(-200)})`,
  );
  assertTrue(
    !/^BL-\d+\s*$/m.test(result.stdout),
    `AC-allocate-dryrun: stdout contains no bare 'BL-<n>' line (the old preview-id behavior is ` +
      `gone) (stdout: ${JSON.stringify(result.stdout)})`,
  );
}

// ── AC-allocate-help — --help is unbroken (BL-446 non-regression) ───────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adr0011-allocate-help-'));
  // Deliberately NOT a git repo — proves --help performs zero git I/O.
  const result = run(process.execPath, [ALLOCATE, '--help'], { cwd: dir });
  assertTrue(
    result.code === 0 && /Usage:/.test(result.stdout),
    `AC-allocate-help: --help exits 0 with a 'Usage:' banner, from a non-git cwd (exit ` +
      `${result.code}; stdout: ${JSON.stringify(result.stdout.slice(0, 120))})`,
  );
}

// ── AC-G3 — title-lock WARNs, does not block, on a content-swap edit ────────────────────────
{
  const scratch = mkScratchRepo();
  writeBacklog(scratch);
  writeChangelog(scratch);
  // Counter absent — proves G3's independence from the counter file too.
  commitBaseline(scratch, { withCounter: false });

  const content = fs.readFileSync(path.join(scratch, 'BACKLOG.md'), 'utf8');
  const edited = content.replace(
    '### BL-100 — First item — **Open** (2026-01-01)',
    '### BL-100 — Completely different defect — **Open** (2026-01-01)',
  );
  fs.writeFileSync(path.join(scratch, 'BACKLOG.md'), edited);
  execFileSync('git', ['add', 'BACKLOG.md'], { cwd: scratch });
  const result = integrityCheck(scratch);
  assertTrue(
    result.code === 0,
    `AC-G3: a title/content-swap edit to an existing heading does NOT block the commit — WARN, ` +
      `not FAIL (exit ${result.code}; stderr tail: ${result.stderr.slice(-300)})`,
  );
  assertTrue(
    /WARN[^\n]*(title|content)[^\n]*BL-100/i.test(result.stderr) ||
      (/WARN/.test(result.stderr) && /BL-100/.test(result.stderr) && /title|content/i.test(result.stderr)),
    `AC-G3: stderr contains a WARN line naming BL-100 and referencing title/content — an exit 0 ` +
      `alone is not sufficient proof (BL-469: a WARN must not report as silence) (stderr tail: ` +
      `${result.stderr.slice(-400)})`,
  );
}

// ── AC-G2 — a brand-new CHANGELOG.md heading for a never-seen id is rejected ─────────────────
{
  const scratch = mkScratchRepo();
  writeBacklog(scratch); // BL-100/101 only
  writeChangelog(scratch); // no BL references at all
  commitBaseline(scratch, { withCounter: false });

  const changelog = fs.readFileSync(path.join(scratch, 'CHANGELOG.md'), 'utf8');
  fs.writeFileSync(
    path.join(scratch, 'CHANGELOG.md'),
    changelog + '\n## [Unreleased] — BL-999: fabricated fix\n\nNever existed anywhere.\n',
  );
  execFileSync('git', ['add', 'CHANGELOG.md'], { cwd: scratch });
  const result = integrityCheck(scratch);
  assertTrue(
    result.code !== 0 && /BL-999/.test(result.stderr) && /CHANGELOG/i.test(result.stderr),
    `AC-G2: a brand-new CHANGELOG.md entry claiming BL-999 (never seen anywhere) is REJECTED, ` +
      `referencing CHANGELOG (exit ${result.code}; stderr tail: ${result.stderr.slice(-300)})`,
  );
}

// ── AC-G2-legit — resolve-and-archive (BACKLOG.md removal + CHANGELOG.md add, SAME commit) ──
{
  const scratch = mkScratchRepo();
  writeBacklog(scratch); // seeds BL-100 and BL-101
  writeChangelog(scratch);
  commitBaseline(scratch, { withCounter: false });

  // Remove BL-100's heading block from BACKLOG.md.
  const backlog = fs.readFileSync(path.join(scratch, 'BACKLOG.md'), 'utf8');
  const withoutBl100 = backlog
    .replace(/### BL-100 — First item — \*\*Open\*\* \(2026-01-01\)\n\nBody\.\n\n---\n\n/, '')
    .replace('**Total open: 2.**', '**Total open: 1.**');
  fs.writeFileSync(path.join(scratch, 'BACKLOG.md'), withoutBl100);

  // Add BL-100's CHANGELOG.md record, same commit.
  const changelog = fs.readFileSync(path.join(scratch, 'CHANGELOG.md'), 'utf8');
  fs.writeFileSync(
    path.join(scratch, 'CHANGELOG.md'),
    changelog + '\n## [Unreleased] — BL-100: shipped\n\nResolved and archived.\n',
  );

  execFileSync('git', ['add', 'BACKLOG.md', 'CHANGELOG.md'], { cwd: scratch });
  const result = integrityCheck(scratch);
  assertTrue(
    result.code === 0 && !/FAIL/.test(result.stderr),
    `AC-G2-legit: resolve-and-archive (BACKLOG.md heading removed, CHANGELOG.md entry added, ` +
      `same commit) PASSES cleanly, no FAIL lines (exit ${result.code}; stderr tail: ` +
      `${result.stderr.slice(-300)})`,
  );
  assertTrue(
    !/WARN[^\n]*BL-100/.test(result.stderr),
    `AC-G2-legit: no WARN names BL-100 either — G1/G2/G3/G4 all recognize this as the intended ` +
      `flow (stderr tail: ${result.stderr.slice(-300)})`,
  );
}

// ── AC-G4 — deleting a heading with no CHANGELOG record anywhere WARNs ──────────────────────
{
  const scratch = mkScratchRepo();
  writeBacklog(scratch);
  writeChangelog(scratch); // empty, no BL references
  commitBaseline(scratch, { withCounter: false });

  const backlog = fs.readFileSync(path.join(scratch, 'BACKLOG.md'), 'utf8');
  const withoutBl100 = backlog
    .replace(/### BL-100 — First item — \*\*Open\*\* \(2026-01-01\)\n\nBody\.\n\n---\n\n/, '')
    .replace('**Total open: 2.**', '**Total open: 1.**');
  fs.writeFileSync(path.join(scratch, 'BACKLOG.md'), withoutBl100);
  execFileSync('git', ['add', 'BACKLOG.md'], { cwd: scratch });

  const result = integrityCheck(scratch);
  assertTrue(
    result.code === 0,
    `AC-G4: deleting BL-100's heading with no CHANGELOG.md record anywhere does NOT block the ` +
      `commit — WARN, not FAIL (exit ${result.code}; stderr tail: ${result.stderr.slice(-300)})`,
  );
  assertTrue(
    /WARN[^\n]*BL-100/.test(result.stderr) && /delet|archiv/i.test(result.stderr),
    `AC-G4: stderr contains a WARN line naming BL-100 and referencing deletion/archival (stderr ` +
      `tail: ${result.stderr.slice(-400)})`,
  );
}

if (failures > 0) {
  console.error(`\ntest-adr0011-stage2-write-off: ${failures} failure(s).`);
  process.exit(1);
}
console.log('\ntest-adr0011-stage2-write-off: OK — all ten arms passed.');
