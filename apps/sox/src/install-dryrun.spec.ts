/**
 * apps/sox/src/install-dryrun.spec.ts
 *
 * CLI-level regression for `soxe install --dry-run` (declarative host path).
 *
 * Background: CONTRIBUTING §2.15/§3 documented `--dry-run` for install, but
 * cmdInstall silently IGNORED the flag and performed a REAL install — a user
 * asking for a preview got files written. This spec drives the REAL built CLI
 * (`dist/apps/sox/main.js`) as a subprocess against a sandboxed workspace and
 * asserts:
 *   1. `--dry-run` reports "would place" and writes NOTHING (no placement dir,
 *      no ledger, no ownership index).
 *   2. The SAME command without `--dry-run` DOES place the skill — proving the
 *      flag is what gates the write (red→green contrast).
 *
 * Sandboxing: cwd = temp workspace root (local extension discovery), --root =
 * same workspace (placement root), SOX_ECOSYSTEM_HOME = temp data root
 * (ledger/ownership never touch ~/.adhd).
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI_MAIN = path.resolve(__dirname, '../../../dist/apps/sox/main.js');

let workspace: string;
let dataHome: string;

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI_MAIN, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SOX_ECOSYSTEM_HOME: dataHome,
    },
    cwd: workspace,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function makeSkillExtension(root: string, id: string): string {
  const extDir = path.join(root, 'extensions', 'skills', id);
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(
    path.join(extDir, 'extension.json'),
    JSON.stringify({
      $schema: 'https://your-registry/schemas/extension/v2.json',
      id,
      version: '0.1.0',
      type: 'skill',
      title: `${id} title`,
      description: `${id} description`,
      compatibility: { host: '>=1.0.0 <2.0.0' },
      license: 'MIT',
      runtime: 'declarative',
      entrypoint: 'SKILL.md',
      install: { type: 'skill', hosts: ['opencode'] },
    }, null, 2),
  );
  fs.writeFileSync(
    path.join(extDir, 'package.json'),
    JSON.stringify({ name: `@adhd/sox-extension-${id}`, version: '0.1.0', private: true }),
  );
  fs.writeFileSync(path.join(extDir, 'SKILL.md'), `# ${id}\n`);
  return extDir;
}

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-install-dryrun-'));
  workspace = path.join(base, 'workspace');
  dataHome = path.join(base, 'data');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(dataHome, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(path.dirname(workspace), { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('soxe install --dry-run (declarative path)', () => {
  it('reports would-place and writes NOTHING', () => {
    makeSkillExtension(workspace, 'dryrun-skill');

    const r = runCli(['install', 'dryrun-skill', '--host=opencode', '--scope=project', '--root=' + workspace, '--dry-run']);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('would place');
    expect(r.stdout).toContain(path.join(workspace, '.opencode', 'skills', 'dryrun-skill'));
    expect(r.stdout).toContain('no files written');

    // Nothing INSTALL-related was created: no placement, no data-root
    // ledger/ownership index. `sox/` is the one expected exception — BL-511's
    // telemetry composition root durably logs every `soxe` invocation
    // (including this dry-run) under `<dataHome>/sox/logs/`, unconditionally,
    // before cmdInstall's dry-run gate is even reached. That is deliberate,
    // structural behaviour (a composition root that can be silently skipped
    // by a code path is exactly the BL-404 failure this fix closes) — it is
    // not a ledger/ownership write and does not indicate `--dry-run` failed
    // to gate the install itself.
    expect(fs.existsSync(path.join(workspace, '.opencode'))).toBe(false);
    expect(fs.readdirSync(dataHome)).toEqual(['sox']);
    expect(fs.readdirSync(path.join(dataHome, 'sox'))).toEqual(['logs']);
  });

  it('the SAME command without --dry-run DOES place the skill (flag is the gate)', () => {
    makeSkillExtension(workspace, 'dryrun-skill');

    const r = runCli(['install', 'dryrun-skill', '--host=opencode', '--scope=project', '--root=' + workspace]);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('placed');
    expect(fs.existsSync(path.join(workspace, '.opencode', 'skills', 'dryrun-skill', 'SKILL.md'))).toBe(true);
  });
});
