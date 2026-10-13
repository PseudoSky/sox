/**
 * diff-status.spec.ts — `soxe diff` content view and `soxe status` placement sync.
 *
 * Drives the built `dist/apps/sox/main.js` against a sandboxed project root (HOME and the
 * ecosystem home are temp dirs too). The source repo is this worktree (cwd), as install requires.
 *
 * Proves:
 *   - a freshly installed placement is reported in sync by `status`;
 *   - an edit on disk is shown by `diff` as a content line (`-<edited>`), reported as
 *     `drifted` with no `missing` (backlog 5d94f88d: relative project paths resolved to the
 *     data root and reported every project placement as missing);
 *   - `status` reports the drifted placement OUT OF SYNC;
 *   - `update` restores the placement from source and both views return to clean.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI_MAIN = path.resolve(__dirname, '../../../dist/apps/sox/main.js');
const REPO_ROOT = path.resolve(__dirname, '../../..');

let home = '';
let root = '';

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI_MAIN, ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    timeout: 120_000,
    env: { ...process.env, HOME: home, SOX_ECOSYSTEM_HOME: home },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('soxe diff / status placement sync', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-ds-home-'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-ds-root-'));
    fs.mkdirSync(path.join(root, '.git'));
    const inst = run(['install', 'dispatcher', '--host=claude', '--scope=project', `--root=${root}`, '--no-restart']);
    expect(inst.status).toBe(0);
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('status reports a fresh placement in sync', () => {
    const st = run(['status', `--root=${root}`]);
    expect(st.stdout).toMatch(/placements: 1 in sync, 0 out of sync/);
  });

  it('diff shows the edited line as a content diff, not as missing', () => {
    const placed = path.join(root, '.claude', 'agents', 'dispatcher.md');
    fs.appendFileSync(placed, 'EDITED LINE\n');
    const d = run(['diff', 'dispatcher', '--scope=project', `--root=${root}`]);
    expect(d.stdout).toMatch(/drifted/);
    expect(d.stdout).not.toMatch(/missing/);
    expect(d.stdout).toMatch(/^\s+-EDITED LINE$/m);
  });

  it('status reports a drifted placement OUT OF SYNC; update restores it and both views go clean', () => {
    const placed = path.join(root, '.claude', 'agents', 'dispatcher.md');
    fs.appendFileSync(placed, 'EDITED LINE\n');
    const st = run(['status', `--root=${root}`]);
    expect(st.stdout).toMatch(/placements: 0 in sync, 1 out of sync/);
    expect(st.stdout).toMatch(/OUT OF SYNC/);

    const upd = run(['update', '--scope=project', `--root=${root}`]);
    expect(upd.status).toBe(0);
    expect(fs.readFileSync(placed, 'utf8')).not.toMatch(/EDITED LINE/);
    expect(run(['status', `--root=${root}`]).stdout).toMatch(/placements: 1 in sync, 0 out of sync/);
    expect(run(['diff', 'dispatcher', '--scope=project', `--root=${root}`]).stdout).toMatch(/up to date/);
  });
});
