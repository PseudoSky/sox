/**
 * update-command.spec.ts — `soxe update` / `soxe upgrade` CLI contract.
 *
 * Drives the REAL built `dist/apps/sox/main.js` as a subprocess against a
 * sandboxed PROJECT scope (`--scope=project --root=<tmp>`), never user scope.
 *
 * Proves:
 *   - `update --help` and `upgrade --help` print usage and perform NO update
 *     (RED before the fix: `update --help` ran a real update; `upgrade --help`
 *     failed with the `--all` error).
 *   - `update` re-places a declarative file-drop agent from the current repo
 *     source when the placed copy has drifted (RED before the fix: update walked
 *     only the lockfile, printed "nothing to install" and "done", and left the
 *     drifted file in place). Governed by docs/decisions/0004 §D6.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI_MAIN = path.resolve(__dirname, '../../../dist/apps/sox/main.js');
const REPO_ROOT = path.resolve(__dirname, '../../..');

let sandboxHome = '';
beforeEach(() => {
  sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-update-home-'));
});
afterEach(() => {
  fs.rmSync(sandboxHome, { recursive: true, force: true });
});

/** Every call runs with HOME and the ecosystem home sandboxed: a no-root update is user scope. */
function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI_MAIN, ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    timeout: 120_000,
    env: { ...process.env, HOME: sandboxHome, SOX_ECOSYSTEM_HOME: sandboxHome },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('BL update-command: help is read-only', () => {
  it('`update --help` prints usage and performs no update', () => {
    const r = run(['update', '--help']);
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/Usage/);
    expect(r.stdout).not.toMatch(/update: done/);
    expect(r.stdout + r.stderr).not.toMatch(/nothing to install|no config found/);
  });

  it('`upgrade --help` prints usage and does not demand --all', () => {
    const r = run(['upgrade', '--help']);
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/Usage/);
    expect(r.stderr).not.toMatch(/--all flag required/);
  });
});

describe('BL update-command: declarative re-placement (ADR-0004 D6)', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-update-cmd-'));
    fs.mkdirSync(path.join(root, '.git'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('restores a drifted file-drop agent placement from the current source', () => {
    const inst = run(['install', 'dispatcher', '--host=claude', '--scope=project', `--root=${root}`, '--no-restart']);
    expect(inst.status).toBe(0);
    const placed = path.join(root, '.claude', 'agents', 'dispatcher.md');
    const good = fs.readFileSync(placed, 'utf8');
    fs.writeFileSync(placed, 'DRIFTED\n');

    const upd = run(['update', '--scope=project', `--root=${root}`]);
    expect(upd.status).toBe(0);
    expect(fs.readFileSync(placed, 'utf8')).toBe(good);
  });
});
