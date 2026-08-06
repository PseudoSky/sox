#!/usr/bin/env node
/**
 * tools/test-bl454-annotation-dedupe.mjs
 *
 * Red->green contract pin for BL-454: `check-backlog-markers.mjs`'s Rule 4 fails when the
 * `**Total open: N.**` integer disagrees with the derived count, but never touched — let alone
 * deduplicated — the hand-authored parenthetical prose trailing it, which every agent that
 * resolves or files an item appends to by hand. Nothing prevented exact-repeat clauses from
 * accumulating without bound (live evidence, read directly at BACKLOG.md:9 in the main checkout:
 * the line has grown well past the 21,736 bytes measured when BL-454 was filed, and visibly
 * repeats whole clauses verbatim).
 *
 * The fix: a new Rule 5, warn-only by default (advisory — never changes the exit code, per D6 /
 * Risk R1: the live file already carries duplicates, and a hard fail would break every
 * worktree's pre-commit hook the instant this ships), with a `--fix` mode that rewrites the
 * annotation to drop exact-duplicate clauses (first occurrence wins) while dropping no unique
 * clause — gated behind Rules 1-3 passing clean first.
 *
 * Arms:
 *   1. Default mode — Rules 1-4 still pass (exit 0); stderr names a duplicate count; the fixture
 *      file is byte-identical before/after (advisory must never write).
 *   2. `--fix` mode — exit 0; the duplicate clause appears exactly once in the rewritten line;
 *      BL-101/BL-102 (unique clauses) are each still present verbatim; the leading count still
 *      reads 2; a second run (no flags) against the fixed file reports zero duplicates.
 *   3. Rules 1-3 gate `--fix` — a fixture with both an annotation duplicate AND a genuine
 *      duplicate `### BL-100` heading (Rule 3 violation): `--fix` exits 1, prints the Rule 3
 *      failure, and leaves the file byte-identical (refuses to write on top of broken grammar).
 *
 * Usage: node tools/test-bl454-annotation-dedupe.mjs [--target <path-to-check-backlog-markers.mjs>]
 * Exit 0 iff every assertion holds.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const targetIdx = argv.indexOf('--target');
const CHECK_MARKERS = targetIdx === -1
  ? path.join(HERE, 'check-backlog-markers.mjs')
  : path.resolve(argv[targetIdx + 1]);

let failed = 0;
function report(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
}

const sh = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function scratchRepo(label, backlogContent) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `bl454-${label}-`)));
  sh(['init', '-q'], dir);
  sh(['config', 'user.email', 'test@test.com'], dir);
  sh(['config', 'user.name', 'test'], dir);
  fs.writeFileSync(path.join(dir, 'BACKLOG.md'), backlogContent);
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# CHANGELOG\n');
  sh(['add', 'BACKLOG.md', 'CHANGELOG.md'], dir);
  sh(['commit', '-q', '-m', 'chore: seed'], dir);
  return dir;
}

function run(args, cwd) {
  const r = spawnSync(process.execPath, [CHECK_MARKERS, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status ?? -1, out: r.out ?? r.stdout ?? '', stdout: r.stdout ?? '', err: r.stderr ?? '' };
}

const TOTAL_LINE =
  '**Total open: 2.** (BL-100 resolved 2026-01-01 from PKT-1 — did a thing, see CHANGELOG.md. ' +
  'BL-101 filed 2026-01-02 — a distinct thing. ' +
  'BL-100 resolved 2026-01-01 from PKT-1 — did a thing, see CHANGELOG.md. ' +
  'BL-102 resolved 2026-01-03 from PKT-2 — a third, unrelated thing, see CHANGELOG.md.)';

// Exactly TWO `### BL-<n>` headings, matching §4's fixture spec verbatim ("exactly two ###
// BL-<n> headings below it whose status markers derive Total open: 2 as correct, so Rules 1-4
// pass clean and the fixture isolates Rule 5"). BL-100 has no heading here — it was already
// resolved and moved to CHANGELOG.md per the repo's own lifecycle convention, and lives on only
// in the annotation's hand-authored prose, which is exactly the shape that produces exact-repeat
// clauses in the real corpus. BL-101 and BL-102 are both currently Open, deriving Total open: 2.
function fixtureClean() {
  return [
    '# BACKLOG',
    '',
    TOTAL_LINE,
    '',
    '---',
    '',
    '### BL-101 — **Open** (2026-01-02)',
    '',
    'Body text for BL-101.',
    '',
    '### BL-102 — **Open** (2026-01-03)',
    '',
    'Body text for BL-102.',
    '',
    '---',
    '',
  ].join('\n');
}

function fixtureWithHeadingDup() {
  // Same annotation duplicate, PLUS a genuine duplicate `### BL-101` heading (Rule 3 violation).
  return [
    '# BACKLOG',
    '',
    TOTAL_LINE,
    '',
    '---',
    '',
    '### BL-101 — **Open** (2026-01-02)',
    '',
    'Body text for BL-101.',
    '',
    '### BL-101 — **Open (restated)** (2026-01-02)',
    '',
    'Duplicate BL-101 heading — a Rule 3 violation.',
    '',
    '### BL-102 — **Open** (2026-01-03)',
    '',
    'Body text for BL-102.',
    '',
    '---',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Arm 1 — Default mode: advisory, never writes, never changes exit code.
// RED (today): no notion of clause duplication exists at all — the substring assertion
// ("stderr mentions a duplicate count") fails because it is simply absent.
// ---------------------------------------------------------------------------
{
  const dir = scratchRepo('default', fixtureClean());
  const before = fs.readFileSync(path.join(dir, 'BACKLOG.md'), 'utf8');

  const r = run([], dir);

  report('BL-454 arm1: exit code 0 (Rules 1-4 still pass)', r.code === 0, `code=${r.code} stderr=${r.err}`);
  report(
    'BL-454 arm1: stderr names a duplicate count (1 duplicate of 4 clauses, or equivalent)',
    /duplicate/i.test(r.err) && /\b1\b/.test(r.err) && /\b4\b/.test(r.err),
    `stderr=${JSON.stringify(r.err)}`,
  );
  const after = fs.readFileSync(path.join(dir, 'BACKLOG.md'), 'utf8');
  report(
    'BL-454 arm1: the fixture file is byte-identical before/after (advisory must never write)',
    after === before,
    `before.length=${before.length} after.length=${after.length}`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Arm 2 — --fix mode: rewrite, drop the exact duplicate, keep every unique clause.
// RED (today): --fix is not a recognized flag — no code path writes the file, so the duplicate
// clause still appears twice post-run; the "exactly once" assertion fails (finds it twice).
// ---------------------------------------------------------------------------
{
  const dir = scratchRepo('fix', fixtureClean());
  const backlogPath = path.join(dir, 'BACKLOG.md');

  const r = run(['--fix'], dir);
  report('BL-454 arm2: --fix exits 0', r.code === 0, `code=${r.code} stdout=${r.stdout} stderr=${r.err}`);

  const rewritten = fs.readFileSync(backlogPath, 'utf8');
  const totalLineMatch = rewritten.match(/\*\*Total open: (\d+)\.\*\*[^\n]*/);
  const line = totalLineMatch ? totalLineMatch[0] : '';

  const did100Occurrences =
    (line.match(/BL-100 resolved 2026-01-01 from PKT-1 — did a thing, see CHANGELOG\.md\./g) || []).length;
  report(
    'BL-454 arm2: the duplicate BL-100 clause appears EXACTLY ONCE in the rewritten line',
    did100Occurrences === 1,
    `occurrences=${did100Occurrences} line=${JSON.stringify(line)}`,
  );
  report(
    'BL-454 arm2: the BL-101 clause is still present verbatim',
    line.includes('BL-101 filed 2026-01-02 — a distinct thing.'),
    `line=${JSON.stringify(line)}`,
  );
  report(
    'BL-454 arm2: the BL-102 clause is still present verbatim',
    line.includes('BL-102 resolved 2026-01-03 from PKT-2 — a third, unrelated thing, see CHANGELOG.md.'),
    `line=${JSON.stringify(line)}`,
  );
  report(
    'BL-454 arm2: the leading count still reads 2',
    /^\*\*Total open: 2\.\*\*/.test(line),
    `line=${JSON.stringify(line)}`,
  );

  const rSecond = run([], dir);
  report(
    'BL-454 arm2: re-running (no flags) against the fixed file reports ZERO duplicate clauses',
    !/duplicate/i.test(rSecond.err),
    `stderr=${JSON.stringify(rSecond.err)}`,
  );
  report('BL-454 arm2: the re-run still exits 0', rSecond.code === 0, `code=${rSecond.code}`);

  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Arm 3 — Rules 1-3 gate --fix: a broken heading grammar must not be papered over.
// Not a red/green discriminator against TODAY's code (today has no --fix at all) — a
// forward-looking safety assertion.
// ---------------------------------------------------------------------------
{
  const dir = scratchRepo('gated', fixtureWithHeadingDup());
  const backlogPath = path.join(dir, 'BACKLOG.md');
  const before = fs.readFileSync(backlogPath, 'utf8');

  const r = run(['--fix'], dir);

  report('BL-454 arm3: --fix exits 1 when Rule 3 is violated', r.code === 1, `code=${r.code} stderr=${r.err}`);
  report(
    'BL-454 arm3: the normal Rule 3 duplicate-heading failure message is printed',
    /duplicate/i.test(r.err) && /BL-101/.test(r.err),
    `stderr=${JSON.stringify(r.err)}`,
  );
  const after = fs.readFileSync(backlogPath, 'utf8');
  report(
    'BL-454 arm3: the file is byte-identical before/after — --fix refuses to write on broken grammar',
    after === before,
    `before.length=${before.length} after.length=${after.length}`,
  );

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failed === 0 ? '\nAll BL-454 assertions passed.' : `\n${failed} BL-454 assertion(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
