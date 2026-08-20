/**
 * BUG-SOX-DRYRUN-CLAIMS-UNIT-UPDATED — a dry run must not write the unit file.
 *
 * WHY THIS TEST IS SHAPED THE WAY IT IS. The obvious version of this test —
 * "dry-run, then assert the file didn't change" — PASSES AGAINST THE BROKEN
 * CODE when the rendered content happens to match what is already on disk,
 * because there is then nothing to write and no mutation can occur regardless
 * of the bug. That vacuous form is exactly what was run first during the live
 * BL-593 probe and it returned a false all-clear. Every case below therefore
 * forces the rendered content to DIFFER from what is on disk, which is the only
 * configuration with any teeth.
 *
 * Live evidence this guards (2026-08-19, com.sox.user.memory-server):
 * `soxe service update ... --dry-run` rewrote ~/Library/LaunchAgents/<label>.plist,
 * repointing a supervised production unit at an nvm-managed node — a node the
 * LIVE path hard-refuses to pin. sha256 and mtime both changed across the call.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { enableOsUnit, updateOsUnit, type OsUnitSpec, type OsUnitPlatform } from './os-unit.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'os-unit-dryrun-'));
}

/** Platform stub: records every side effect so we can assert none occurred. */
function platformStub(calls: string[]): OsUnitPlatform {
  return {
    defaultUnitDir: () => tmpDir(),
    unitFileName: (label: string) => `${label}.plist`,
    render: (spec: OsUnitSpec) =>
      `<plist><key>Label</key><string>${spec.label}</string>` +
      `<key>Program</key><string>${(spec as unknown as { program: string }).program}</string></plist>\n`,
    load: (_p: string, label: string) => {
      calls.push(`load:${label}`);
      return { code: 0, stdout: '', stderr: '' };
    },
    unload: (_p: string, label: string) => {
      calls.push(`unload:${label}`);
      return { code: 0, stdout: '', stderr: '' };
    },
    isLoaded: () => false,
    kickstart: (label: string) => {
      calls.push(`kickstart:${label}`);
      return { code: 0, stdout: '', stderr: '' };
    },
  } as unknown as OsUnitPlatform;
}

const LOG_DIR = tmpDir();

function specFor(program: string): OsUnitSpec {
  return {
    label: 'com.test.dryrun',
    program,
    args: [],
    env: {},
    stdoutPath: path.join(LOG_DIR, 'out.log'),
    stderrPath: path.join(LOG_DIR, 'err.log'),
    workingDir: LOG_DIR,
  } as unknown as OsUnitSpec;
}

describe('BUG-SOX-DRYRUN-CLAIMS-UNIT-UPDATED — dry run never writes the unit file', () => {
  it('enableOsUnit({dryRun:true}) leaves DIFFERING on-disk content byte-identical', () => {
    const calls: string[] = [];
    const platform = platformStub(calls);
    const unitDir = tmpDir();
    const unitPath = path.join(unitDir, 'com.test.dryrun.plist');

    // Seed a real unit, then render something genuinely different.
    enableOsUnit(specFor('/usr/bin/node-A'), platform, { unitDir, load: false });
    const before = fs.readFileSync(unitPath);
    const mtimeBefore = fs.statSync(unitPath).mtimeMs;

    const res = enableOsUnit(specFor('/usr/bin/node-B'), platform, { unitDir, dryRun: true });

    // Precondition: the render really does differ, or this test proves nothing.
    expect(res.action).toBe('updated');
    expect(fs.readFileSync(unitPath).equals(before)).toBe(true);
    expect(fs.statSync(unitPath).mtimeMs).toBe(mtimeBefore);
    expect(calls).toEqual([]); // no load, no kickstart
    expect(res.loaded).toBe(false);
  });

  it('load:false ALONE still writes — the distinction the bug turned on', () => {
    const platform = platformStub([]);
    const unitDir = tmpDir();
    const unitPath = path.join(unitDir, 'com.test.dryrun.plist');

    enableOsUnit(specFor('/usr/bin/node-A'), platform, { unitDir, load: false });
    const before = fs.readFileSync(unitPath);

    enableOsUnit(specFor('/usr/bin/node-B'), platform, { unitDir, load: false });

    // Documents the real semantics of `load:false` so nobody mistakes it for a
    // dry run again: it DOES write. Only `dryRun` is write-free.
    expect(fs.readFileSync(unitPath).equals(before)).toBe(false);
  });

  it('updateOsUnit without load:true does not write the unit file', async () => {
    const calls: string[] = [];
    const platform = platformStub(calls);
    const unitDir = tmpDir();
    const unitPath = path.join(unitDir, 'com.test.dryrun.plist');

    enableOsUnit(specFor('/usr/bin/node-A'), platform, { unitDir, load: false });
    const before = fs.readFileSync(unitPath);
    const mtimeBefore = fs.statSync(unitPath).mtimeMs;

    let restartCalled = false;
    const res = await updateOsUnit(specFor('/usr/bin/node-B'), platform, {
      unitDir,
      token: 'tok',
      restartFn: async () => {
        restartCalled = true;
        return { ok: true } as never;
      },
    });

    expect(res.action).toBe('updated');
    expect(res.wouldRotate).toBe(true);
    expect(restartCalled).toBe(false); // no rotation forced on a preview
    expect(fs.readFileSync(unitPath).equals(before)).toBe(true);
    expect(fs.statSync(unitPath).mtimeMs).toBe(mtimeBefore);
    expect(calls).toEqual([]);
  });

  it('a live updateOsUnit (load:true) DOES write and rotate — preview is not a no-op verb', async () => {
    const calls: string[] = [];
    const platform = platformStub(calls);
    const unitDir = tmpDir();
    const unitPath = path.join(unitDir, 'com.test.dryrun.plist');

    enableOsUnit(specFor('/usr/bin/node-A'), platform, { unitDir, load: false });
    const before = fs.readFileSync(unitPath);

    let restartCalled = false;
    const res = await updateOsUnit(specFor('/usr/bin/node-B'), platform, {
      unitDir,
      load: true,
      token: 'tok',
      restartFn: async () => {
        restartCalled = true;
        return { ok: true } as never;
      },
    });

    expect(res.action).toBe('updated');
    expect(restartCalled).toBe(true);
    expect(fs.readFileSync(unitPath).equals(before)).toBe(false);
  });

  it('dry-run log text uses no past-tense mutation verb', () => {
    const lines: string[] = [];
    const platform = platformStub([]);
    const unitDir = tmpDir();

    enableOsUnit(specFor('/usr/bin/node-A'), platform, { unitDir, load: false });
    enableOsUnit(specFor('/usr/bin/node-B'), platform, {
      unitDir,
      dryRun: true,
      log: (m) => lines.push(m),
    });

    const joined = lines.join('\n');
    expect(joined).toMatch(/would (update|create)/);
    // The original defect printed "updated <live path>" for a write it had
    // performed during a --dry-run; an operator reads that as production having
    // been mutated.
    expect(joined).not.toMatch(/: updated /);
    expect(joined).not.toMatch(/: created /);
  });
});
