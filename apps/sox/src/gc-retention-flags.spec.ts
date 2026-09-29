/**
 * gc-retention-flags.spec.ts — H2 + H4 through the REAL built CLI (`bin/soxe`).
 *
 * The unit specs prove the retention planner and the flag parser in isolation;
 * this drives `soxe gc` the way a consumer does and asserts the consumer-visible
 * outcome + the process EXIT CODE (never stdout-grep for pass/fail):
 *
 *   H4 — `--grace-ms=` (blank) must use the DEFAULT grace, so a just-trashed
 *        tree is NOT hard-deleted in the SAME command. Pre-fix `Number('') === 0`
 *        → grace 0 → swept immediately. A bare or invalid `--grace-ms`/
 *        `--max-age-ms` (the parser stores `'true'`/garbage → NaN) must exit 2
 *        rather than silently disabling the age gate.
 *   H2 — a second `gc --apply --confirm` over a dir whose trash already exists
 *        must succeed; pre-fix the in-tree `.trash` (default used to be
 *        `<dir>/.trash`) is a reclaim candidate and `applyRetention` renames it
 *        into its own descendant → EINVAL → non-zero exit.
 *
 * apps/sox's `test` target dependsOn `build`, so `bin/soxe` resolves the current
 * dist under Nx; this spec also runs standalone once `nx build sox` has run.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SOXE = path.join(REPO_ROOT, 'bin', 'soxe');
const PAST = new Date('2020-01-01T00:00:00Z');
const DEFAULT_GRACE_MS = 86_400_000;

let dir: string;
let siblingTrash: string;

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [SOXE, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function mkPast(name: string): string {
  const p = path.join(dir, name);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'c'), 'x');
  fs.utimesSync(p, PAST, PAST);
  return p;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-gc-e2e-'));
  siblingTrash = path.join(path.dirname(dir), `.trash-${path.basename(dir)}`);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(siblingTrash, { recursive: true, force: true });
});

describe('H4 (end-to-end) — gc grace/age flags never silently disable a gate', () => {
  it('`--grace-ms=` (blank) uses the default grace: a just-trashed tree survives the same command', () => {
    mkPast('gen-1');
    mkPast('snapshot-old');

    const r = run([
      'gc', '--dir', dir, '--live-generations', 'gen-1', '--apply', '--confirm', '--grace-ms=',
    ]);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('trashed 1');
    expect(r.stdout).toContain('swept 0'); // pre-fix: grace 0 → 'swept 1' (hard-deleted same command)

    // The moved tree is still on disk, recorded with a sweep instant ~1 day out.
    const manifestPath = path.join(siblingTrash, 'manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Array<{
      originalPath: string;
      trashedPath: string;
      sweepAfter: number;
    }>;
    expect(manifest).toHaveLength(1);
    expect(path.basename(manifest[0]!.originalPath)).toBe('snapshot-old');
    expect(manifest[0]!.sweepAfter).toBeGreaterThan(Date.now() + DEFAULT_GRACE_MS - 60_000);
    expect(fs.existsSync(manifest[0]!.trashedPath)).toBe(true);
  });

  it('a bare or invalid grace/age flag exits 2 (present-but-invalid is not silently defaulted)', () => {
    mkPast('gen-1');
    mkPast('snapshot-old');
    const badForms = [
      ['--grace-ms'],          // bare → parser stores 'true'
      ['--max-age-ms'],        // bare
      ['--grace-ms=abc'],      // non-numeric
      ['--max-age-ms=-5'],     // negative
      ['--grace-ms=Infinity'], // not finite
    ];
    for (const bad of badForms) {
      const r = run(['gc', '--dir', dir, '--live-generations', 'gen-1', '--apply', '--confirm', ...bad]);
      expect(r.status, `expected exit 2 for ${bad.join(' ')}`).toBe(2);
    }
    // Nothing was moved by any rejected invocation.
    expect(fs.existsSync(path.join(dir, 'snapshot-old'))).toBe(true);
  });
});

describe('H2 (end-to-end) — gc twice over the same dir succeeds (no self-nesting EINVAL)', () => {
  it('a re-run whose trash dir already exists inside the managed root does not reclaim it', () => {
    mkPast('gen-1');
    mkPast('snapshot-old');
    // Explicit in-tree trash (the old default): the shape that used to self-nest.
    const inTreeTrash = path.join(dir, '.trash');
    const base = ['gc', '--dir', dir, '--live-generations', 'gen-1', '--trash', inTreeTrash, '--apply', '--confirm'];

    const r1 = run([...base, '--grace-ms=0']); // grace 0 → first run sweeps its own move (valid, explicit)
    expect(r1.status).toBe(0);
    expect(r1.stdout).toContain('trashed 1');
    expect(fs.existsSync(inTreeTrash)).toBe(true);

    // A later run: the trash dir is now older than max-age, so pre-fix it is a
    // reclaim candidate → EINVAL. Post-fix planRetention excludes it.
    fs.utimesSync(inTreeTrash, PAST, PAST);
    const r2 = run(base);
    expect(r2.status).toBe(0);
    expect(r2.stdout).toContain('trashed 0');
    expect(fs.existsSync(path.join(dir, 'gen-1'))).toBe(true); // live root untouched
  });

  it('the default trash is a SIBLING of the managed root (never an in-tree reclaim candidate)', () => {
    mkPast('gen-1');
    mkPast('snapshot-old');
    const r = run(['gc', '--dir', dir, '--live-generations', 'gen-1', '--apply', '--confirm', '--grace-ms=']);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(dir, '.trash'))).toBe(false); // no in-tree trash created
    expect(fs.existsSync(siblingTrash)).toBe(true);              // sibling used instead
  });
});
