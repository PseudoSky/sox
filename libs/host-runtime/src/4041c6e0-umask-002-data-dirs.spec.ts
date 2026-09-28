/**
 * 4041c6e0-umask-002-data-dirs.spec.ts — sox creates its data dirs private even
 * under umask 002 (BL-4041c6e0, BL-6233c1c2).
 *
 * On Linux user-private-group hosts the default umask is 002, so a bare
 * `mkdirSync(p, {recursive:true})` yields 0775. The service-proxy socket-dir trust
 * check refuses a group-writable dir, so every proxy-mode bind/dial under `run/`
 * would fail. Every data-root mkdir now goes through `mkdirDataDir` (mode 0700);
 * this spec pins that for the data root, `runDir()` and `socketDir()` as created
 * by the real call sites: the start lock, the supervisors registry, and the
 * runtime's exec-socket dir.
 *
 * Each test sets umask 002 for its own duration only and restores it in `finally`.
 * Fresh scratch `SOX_ECOSYSTEM_HOME` per test; the real data root is never touched.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { acquireStartLock } from './lock.js';
import { writeSupervisorsFile } from './registry.js';
import { startRuntime, stopRuntime } from './runtime.js';
import { runDir, socketDir, supervisorsPath, userDataRoot } from './data-paths.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** Point SOX_ECOSYSTEM_HOME at a not-yet-existing dir inside a scratch parent. */
function freshDataRoot(): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 's4-'));
  const root = path.join(parent, 'r'); // short: the exec socket must fit sun_path
  const prev = process.env['SOX_ECOSYSTEM_HOME'];
  process.env['SOX_ECOSYSTEM_HOME'] = root;
  cleanups.push(() => {
    if (prev === undefined) delete process.env['SOX_ECOSYSTEM_HOME'];
    else process.env['SOX_ECOSYSTEM_HOME'] = prev;
    fs.rmSync(parent, { recursive: true, force: true });
  });
  return root;
}

/** Run `fn` with umask 002, restoring the previous umask afterwards. */
async function underUmask002<T>(fn: () => T | Promise<T>): Promise<T> {
  expect(() => process.umask()).not.toThrow(); // precondition: umask is settable here
  const prev = process.umask(0o002);
  try {
    return await fn();
  } finally {
    process.umask(prev);
  }
}

function groupOtherWriteBits(p: string): number {
  return fs.statSync(p).mode & 0o022;
}

describe('BL-4041c6e0 / 6233c1c2: data dirs are private under umask 002', () => {
  it('4041c6e0 6233c1c2: acquireStartLock creates root and runDir() without group/other write', async () => {
    const root = freshDataRoot();
    await underUmask002(() => {
      const lock = acquireStartLock('umask-002-lock');
      lock.release();
    });
    expect(userDataRoot()).toBe(root);
    expect(groupOtherWriteBits(root)).toBe(0);
    expect(groupOtherWriteBits(runDir())).toBe(0);
    expect(groupOtherWriteBits(path.join(runDir(), 'locks'))).toBe(0);
  });

  it('4041c6e0 6233c1c2: writeSupervisorsFile creates its dir chain without group/other write', async () => {
    const root = freshDataRoot();
    await underUmask002(() => {
      writeSupervisorsFile({ version: 1, supervisors: [] });
    });
    expect(fs.existsSync(supervisorsPath())).toBe(true);
    expect(groupOtherWriteBits(root)).toBe(0);
    for (let d = path.dirname(supervisorsPath()); d.startsWith(root); d = path.dirname(d)) {
      expect({ d, bits: groupOtherWriteBits(d) }).toEqual({ d, bits: 0 });
    }
  });

  it('4041c6e0 6233c1c2: the runtime exec-socket dir (socketDir()) is created without group/other write', async () => {
    const root = freshDataRoot();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-4041-umask-proj-'));
    const runtimeFilePath = path.join(projectDir, 'runtime.json');
    cleanups.push(() => fs.rmSync(projectDir, { recursive: true, force: true }));

    await underUmask002(async () => {
      await startRuntime({
        scope: 'project',
        lockfilePath: path.join(projectDir, 'extensions.lock'),
        configPath: path.join(projectDir, 'config.json'),
        runtimeFilePath,
        root: projectDir,
      });
    });
    cleanups.push(() => stopRuntime({ scope: 'project', runtimeFilePath }));

    expect(groupOtherWriteBits(root)).toBe(0);
    expect(groupOtherWriteBits(runDir())).toBe(0);
    expect(groupOtherWriteBits(socketDir())).toBe(0);
  });
});
