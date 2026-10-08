/**
 * file-lock.spec.ts — ownership-lock AC3..AC9 (ACs are stable ids of the
 * ownership.save lost-update fix; AC1/AC2 live in db-artifact-concurrency.spec.ts
 * because they need the two-real-process ownership harness).
 *
 * Contention (AC6) is proven with REAL OS processes spawned through tsx and keyed
 * on a critical-section trace file, never on stdout or sleeps.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withFileLockSync, OwnershipLockTimeoutError } from './file-lock.js';
import { OwnershipIndex } from './ownership.js';

function findRepoRoot(start: string): string {
  let d = start;
  for (;;) {
    if (fs.existsSync(path.join(d, 'nx.json'))) return d;
    const parent = path.dirname(d);
    if (parent === d) throw new Error(`repo root (nx.json) not found above ${start}`);
    d = parent;
  }
}
const repoRoot = findRepoRoot(process.cwd());
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const fileLockSrc = path.join(repoRoot, 'libs', 'install-engine', 'src', 'file-lock.ts');

let root: string;
let lock: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-file-lock-'));
  lock = path.join(root, 'ownership.json.lock');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A pid that provably belonged to a process that has exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '']);
  if (r.pid === undefined) throw new Error('spawnSync produced no pid');
  return r.pid;
}

function writeLock(payload: { pid: number; token: string; startedAtMs: number }): void {
  fs.writeFileSync(lock, JSON.stringify(payload));
}

function leftovers(): string[] {
  return fs.readdirSync(root).filter((f) => f.includes('.lock'));
}

describe('ownership-lock AC3 — a lock naming a dead pid is reclaimed immediately', () => {
  it('reclaims without waiting for the timeout and leaves no lock or .stale file', () => {
    writeLock({ pid: deadPid(), token: 'dead-holder', startedAtMs: Date.now() });
    const t0 = Date.now();
    // timeoutMs 150 would throw if the dead holder were waited on.
    const out = withFileLockSync(lock, () => 'ran', { timeoutMs: 150 });
    expect(out).toBe('ran');
    expect(Date.now() - t0).toBeLessThan(150);
    expect(leftovers()).toEqual([]);
  });
});

describe('ownership-lock AC4 — empty / unparseable lock: stale by mtime, waited on when fresh', () => {
  it.each([['empty', ''], ['garbage', '{not json']])(
    '%s content with mtime > 2s old is reclaimed',
    (_label, content) => {
      fs.writeFileSync(lock, content);
      const old = new Date(Date.now() - 5000);
      fs.utimesSync(lock, old, old);
      expect(withFileLockSync(lock, () => 'ran', { timeoutMs: 150 })).toBe('ran');
      expect(leftovers()).toEqual([]);
    },
  );

  it.each([['empty', ''], ['garbage', '{not json']])(
    '%s content with a fresh mtime is waited on (times out, lock untouched)',
    (_label, content) => {
      fs.writeFileSync(lock, content);
      expect(() => withFileLockSync(lock, () => 'ran', { timeoutMs: 120 })).toThrow(OwnershipLockTimeoutError);
      expect(fs.readFileSync(lock, 'utf8')).toBe(content);
    },
  );
});

describe('ownership-lock AC5 — a lock held by a live pid raises OwnershipLockTimeoutError', () => {
  it('throws within a small timeoutMs, carrying lockPath and holderPid, and leaves the lock', () => {
    writeLock({ pid: process.pid, token: 'live-holder', startedAtMs: Date.now() });
    const t0 = Date.now();
    let caught: unknown;
    try {
      withFileLockSync(lock, () => 'ran', { timeoutMs: 100 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OwnershipLockTimeoutError);
    const err = caught as OwnershipLockTimeoutError;
    expect(err.name).toBe('OwnershipLockTimeoutError');
    expect(err.name).not.toBe('OwnershipConflictError'); // withReconciledRetry must not retry it
    expect(err.lockPath).toBe(lock);
    expect(err.holderPid).toBe(process.pid);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(JSON.parse(fs.readFileSync(lock, 'utf8')).token).toBe('live-holder');
  });

  it('a live pid past the 30s hard ceiling is reclaimed (pid reuse / wedged holder)', () => {
    writeLock({ pid: process.pid, token: 'ancient', startedAtMs: Date.now() - 60_000 });
    expect(withFileLockSync(lock, () => 'ran', { timeoutMs: 150 })).toBe('ran');
    expect(leftovers()).toEqual([]);
  });

  it('OwnershipIndex.save surfaces the timeout (not a retry loop) when the lock is held', () => {
    const own = path.join(root, 'ownership.json');
    writeLock({ pid: process.pid, token: 'live-holder', startedAtMs: Date.now() });
    const idx = OwnershipIndex.loadFromFile(own, {
      strict: true,
      lockRunner: (p, fn) => withFileLockSync(p, fn, { timeoutMs: 100 }),
    });
    idx.addEntries('ext-a', 'project', [{ kind: 'file-drop', path: path.join(root, 'a.md') }]);
    expect(() => idx.save()).toThrow(OwnershipLockTimeoutError);
    expect(fs.existsSync(own)).toBe(false);
  });
});

describe('ownership-lock AC6 — N processes contending on one stale lock: strict mutual exclusion', () => {
  it('exactly one proceeds at a time, no increment is lost, no live lock is deleted', async () => {
    const N = 5;
    const ITER = 8;
    const counter = path.join(root, 'counter');
    const inside = path.join(root, 'inside');
    const trace = path.join(root, 'trace');
    const go = path.join(root, 'go');
    fs.writeFileSync(counter, '0');
    fs.writeFileSync(trace, '');
    writeLock({ pid: deadPid(), token: 'dead-holder', startedAtMs: Date.now() });

    const script = path.join(root, 'contender.cjs');
    fs.writeFileSync(
      script,
      `
const fs = require('node:fs');
const { withFileLockSync } = require(${JSON.stringify(fileLockSrc)});
const [lockPath, counter, inside, trace, go, id, iters] = process.argv.slice(2);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
fs.writeFileSync(go + '.ready.' + id, '1');
while (!fs.existsSync(go)) sleep(1);
for (let i = 0; i < Number(iters); i++) {
  withFileLockSync(lockPath, () => {
    // O_EXCL marker: if a second process is ever inside, this throws -> VIOLATION.
    let fd;
    try { fd = fs.openSync(inside, 'wx'); }
    catch (e) { fs.appendFileSync(trace, 'VIOLATION ' + id + '\\n'); throw e; }
    fs.closeSync(fd);
    const n = Number(fs.readFileSync(counter, 'utf8'));
    sleep(2);
    fs.writeFileSync(counter, String(n + 1));
    fs.unlinkSync(inside);
    fs.appendFileSync(trace, 'ok ' + id + '\\n');
  }, { timeoutMs: 30000 });
}
`,
    );

    const exits: Array<Promise<{ code: number; stderr: string }>> = [];
    for (let k = 0; k < N; k++) {
      const cp = spawn(tsxBin, [script, lock, counter, inside, trace, go, String(k), String(ITER)], {
        cwd: repoRoot,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let err = '';
      cp.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
      exits.push(new Promise((resolve) => cp.on('exit', (c) => resolve({ code: c ?? -1, stderr: err }))));
    }
    const deadline = Date.now() + 60_000;
    while (fs.readdirSync(root).filter((f) => f.startsWith('go.ready.')).length < N) {
      if (Date.now() > deadline) throw new Error('contenders never became ready');
      await new Promise((r) => setImmediate(r));
    }
    fs.writeFileSync(go, 'go');
    const results = await Promise.all(exits);

    for (const r of results) expect(r.code, r.stderr).toBe(0);
    const lines = fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean);
    expect(lines.filter((l) => l.startsWith('VIOLATION'))).toEqual([]);
    expect(lines.length).toBe(N * ITER);
    expect(Number(fs.readFileSync(counter, 'utf8'))).toBe(N * ITER); // no lost increment
    expect(leftovers()).toEqual([]); // dead lock gone, every .stale.* cleaned, nothing orphaned
  }, 90_000);
});

describe('ownership-lock AC7 — a holder whose lock was taken over never unlinks the new holder', () => {
  it('leaves the successor lock in place on release', () => {
    const successor = { pid: process.pid, token: 'successor-token', startedAtMs: Date.now() };
    withFileLockSync(lock, () => {
      // Simulate a takeover while we are still inside the critical section.
      fs.unlinkSync(lock);
      writeLock(successor);
    });
    expect(fs.existsSync(lock)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lock, 'utf8'))).toEqual(successor);
  });

  it('releases its own lock normally and when fn throws', () => {
    withFileLockSync(lock, () => undefined);
    expect(fs.existsSync(lock)).toBe(false);
    expect(() => withFileLockSync(lock, () => { throw new Error('boom'); })).toThrow('boom');
    expect(fs.existsSync(lock)).toBe(false);
  });
});

describe('ownership-lock AC7 — release has no check-then-act window (rename-aside + re-verify)', () => {
  const successor = (): { pid: number; token: string; startedAtMs: number } =>
    ({ pid: process.pid, token: 'successor-token', startedAtMs: Date.now() });

  it('a successor that replaced our lock before release is restored byte-for-byte, no aside file left', () => {
    const next = successor();
    withFileLockSync(lock, () => undefined, {
      releaseHook: (step) => {
        if (step === 'before-rename') {
          fs.unlinkSync(lock);
          writeLock(next);
        }
      },
    });
    expect(JSON.parse(fs.readFileSync(lock, 'utf8'))).toEqual(next);
    expect(leftovers()).toEqual(['ownership.json.lock']);
  });

  it('a successor created in the slot between verify and unlink is never deleted', () => {
    const next = successor();
    withFileLockSync(lock, () => undefined, {
      releaseHook: (step) => {
        // Our lock is already renamed aside and verified; the slot is free, so a
        // contender legitimately acquires it right now.
        if (step === 'after-verify') writeLock(next);
      },
    });
    expect(JSON.parse(fs.readFileSync(lock, 'utf8'))).toEqual(next);
    expect(leftovers()).toEqual(['ownership.json.lock']);
  });

  it('restoring a displaced foreign lock never clobbers a lock that took the slot meanwhile', () => {
    const displaced = { pid: process.pid, token: 'displaced-token', startedAtMs: Date.now() };
    const third = { pid: process.pid, token: 'third-token', startedAtMs: Date.now() };
    withFileLockSync(lock, () => undefined, {
      releaseHook: (step) => {
        if (step === 'before-rename') {
          fs.unlinkSync(lock);
          writeLock(displaced);
        } else {
          writeLock(third);
        }
      },
    });
    expect(JSON.parse(fs.readFileSync(lock, 'utf8'))).toEqual(third);
    expect(leftovers()).toEqual(['ownership.json.lock']);
  });
});

describe('ownership-lock — reap-guard thresholds are options', () => {
  /** A dead-pid lock plus an empty reap guard whose mtime is 300ms old. */
  function seedStaleLockAndOldGuard(): void {
    writeLock({ pid: deadPid(), token: 'dead', startedAtMs: Date.now() - 60_000 });
    const guard = `${lock}.reap`;
    fs.writeFileSync(guard, '');
    const old = new Date(Date.now() - 300);
    fs.utimesSync(guard, old, old);
  }

  it('guardEmptyStaleMs lets a tight deployment reclaim an abandoned guard quickly', () => {
    seedStaleLockAndOldGuard();
    expect(withFileLockSync(lock, () => 'ok', { timeoutMs: 1_000, guardEmptyStaleMs: 20 })).toBe('ok');
  });

  it('the default 1s guard threshold still treats a 300ms-old empty guard as live (times out)', () => {
    seedStaleLockAndOldGuard();
    expect(() => withFileLockSync(lock, () => 'ok', { timeoutMs: 100 })).toThrow(OwnershipLockTimeoutError);
  });
});

describe('ownership-lock AC8 — a no-op save() creates neither ownership.json nor a lock', () => {
  it('load + save with nothing dirty touches nothing', () => {
    const own = path.join(root, 'sub', 'ownership.json');
    const idx = OwnershipIndex.loadFromFile(own, { strict: true });
    idx.save();
    expect(fs.existsSync(own)).toBe(false);
    expect(fs.existsSync(`${own}.lock`)).toBe(false);
    expect(fs.existsSync(path.dirname(own))).toBe(false);
  });

  it('a real save leaves the file and NO lock behind', () => {
    const own = path.join(root, 'ownership.json');
    const idx = OwnershipIndex.loadFromFile(own, { strict: true });
    idx.addEntries('ext-a', 'project', [{ kind: 'file-drop', path: path.join(root, 'a.md') }]);
    idx.save();
    expect(fs.existsSync(own)).toBe(true);
    expect(fs.existsSync(`${own}.lock`)).toBe(false);
    // second no-op save on the now-existing file: still no lock.
    idx.save();
    expect(fs.existsSync(`${own}.lock`)).toBe(false);
  });
});

describe('ownership-lock AC9 — OwnershipRecord stays version 1, file shape unchanged', () => {
  it('writes { version: 1, owned: [record] } with the pre-lock record keys', () => {
    const own = path.join(root, 'ownership.json');
    const idx = OwnershipIndex.loadFromFile(own, { strict: true });
    idx.addEntries('ext-a', 'project', [{ kind: 'file-drop', path: path.join(root, 'a.md') }], { host: 'claude' });
    idx.save();
    const parsed = JSON.parse(fs.readFileSync(own, 'utf8')) as { version: number; owned: Array<Record<string, unknown>> };
    expect(Object.keys(parsed).sort()).toEqual(['owned', 'version']);
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.owned[0]!).sort()).toEqual(
      ['entries', 'extId', 'host', 'installedAt', 'scope', 'updatedAt'],
    );
  });
});
