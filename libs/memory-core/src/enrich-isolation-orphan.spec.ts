/**
 * BL-465121ca — enrich child process leaks (orphaned holders of the store).
 *
 * Three defects, each pinned here:
 *   1. A timed-out child that ignores SIGTERM must be SIGKILLed. Before the
 *      fix, `settle()` cleared the SIGKILL timer, so the escalation never ran.
 *   2. A second enrich child must not be forked for a store while a previous
 *      child for that same store is still alive (one holder per store).
 *   3. The child must exit when its parent's IPC channel disconnects, so a dead
 *      backend cannot leave an orphan holding the store.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { runEnrichIsolated, _setEnrichHostForkResolverForTest } from './enrich-isolation.js';
import { armParentDisconnectExit } from './enrich-process-host.js';
import type { BatchEnrichOptions } from './enrich-batch.js';

const OPTS: BatchEnrichOptions = { incrementalCluster: true } as BatchEnrichOptions;

/** A child that installs a SIGTERM no-op, never answers IPC, and writes its pid
 *  only AFTER the handler is installed (so the test cannot race a default kill). */
function makeStubborn(dir: string): { modulePath: string; pidFile: string } {
  const modulePath = path.join(dir, 'stubborn-child.js');
  const pidFile = path.join(dir, 'child.pid');
  fs.writeFileSync(
    modulePath,
    [
      "const fs = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      "process.on('message', () => {});",
      "setInterval(() => {}, 1000);",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    ].join('\n'),
  );
  return { modulePath, pidFile };
}

async function waitForFile(file: string, timeoutMs = 5000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return Number(fs.readFileSync(file, 'utf8'));
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`fixture child never wrote ${file}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  _setEnrichHostForkResolverForTest(null);
  while (cleanups.length) cleanups.pop()?.();
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl465121ca-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('BL-465121ca: a timed-out enrich child is SIGKILLed when it ignores SIGTERM', () => {
  it('is dead within timeout + SIGKILL grace even though it ignores SIGTERM', async () => {
    const dir = tmpDir();
    const { modulePath, pidFile } = makeStubborn(dir);
    _setEnrichHostForkResolverForTest(() => ({ modulePath, execArgv: [] }));

    const pending = runEnrichIsolated(path.join(dir, 'x.db'), OPTS, 1000);
    const pid = await waitForFile(pidFile);
    const result = await pending;

    expect(result).toEqual({ ok: false, error: 'timeout' });
    // grace is 3000ms after the timeout fires; allow slack for scheduling.
    expect(await waitForDead(pid, 3000 + 3000)).toBe(true);
  }, 15_000);
});

describe('BL-465121ca: one enrich child per store', () => {
  it('refuses to fork a second child for a store while the first is still alive', async () => {
    const dir = tmpDir();
    const { modulePath, pidFile } = makeStubborn(dir);
    _setEnrichHostForkResolverForTest(() => ({ modulePath, execArgv: [] }));
    const dbPath = path.join(dir, 'shared.db');

    const first = runEnrichIsolated(dbPath, OPTS, 500);
    const firstPid = await waitForFile(pidFile);
    expect(await first).toEqual({ ok: false, error: 'timeout' });

    // The first child ignores SIGTERM and is still alive; a second tick must not add a holder.
    expect(isAlive(firstPid)).toBe(true);
    const second = await runEnrichIsolated(dbPath, OPTS, 500);
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.error).toMatch(/previous enrich child still running/);
  }, 15_000);
});

describe('BL-465121ca: the enrich child exits when its parent disconnects', () => {
  it('armParentDisconnectExit exits with code 1 on IPC disconnect', () => {
    const proc = new EventEmitter();
    const exits: number[] = [];
    armParentDisconnectExit(proc, (code) => exits.push(code));
    expect(exits).toEqual([]);
    proc.emit('disconnect');
    expect(exits).toEqual([1]);
  });
});
