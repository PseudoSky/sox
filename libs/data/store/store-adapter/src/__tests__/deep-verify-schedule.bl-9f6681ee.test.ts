/**
 * BL-9f6681ee — an owed deep verify can no longer be starved by short-lived
 * openers.
 *
 * The starvation: every writable open of a store owing a deep pass took the
 * single-flight lock and forked a verifier. One-shot openers (CLI, hooks) then
 * closed (`cancelled`) or exited (their exit hook SIGKILLs the child, leaving
 * `running`), while the long-lived memory-server that opened meanwhile saw
 * `peer_running`, returned null and never retried. The pass never completed.
 *
 * (a) A default (`schedule: 'never'`) opener records the obligation but forks
 *     nothing. RED (default flipped to 'owner'): a verifier runs.
 * (b) An owner that finds the lock held by a live peer re-attempts on a
 *     bounded backoff and runs once the lock frees. RED (no re-arm): the
 *     obligation is never cleared.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TursoAdapterImpl } from '../turso-adapter.js';
import {
  _activeDeepVerifyForTest,
  deepVerifyLockPath,
  readDeepVerifyObligation,
  readDeepVerifyState,
} from '../deep-verify.js';
import { canonicalDbPath } from '../path-identity.js';
import { hasUncleanShutdown } from '../preflight.js';

const require = createRequire(import.meta.url);
const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch (err) {
    process.stderr.write(`[bl-9f6681ee test] turso driver unavailable: ${String(err)}\n`);
    return false;
  }
})();

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..', '..');
const HOLDER = resolve(HERE, 'fixtures', 'bug019-open-child.ts');
const FAKE_OK = resolve(HERE, 'fixtures', 'deep-verify-fake-ok.mjs');

let tmpDir: string;
const children: ChildProcess[] = [];
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bl-9f6681ee-'));
});
afterEach(() => {
  delete process.env['DEEP_VERIFY_FAKE_TOUCH'];
  for (const c of children.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  }
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function exited(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((r) => proc.once('exit', () => r()));
}

/** Leave `dbPath` as a crashed session leaves it (open, then SIGKILL). */
async function crashStore(dbPath: string): Promise<void> {
  const proc = spawn(process.execPath, ['--import', 'tsx', HOLDER, dbPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: PKG_ROOT,
  });
  await new Promise<void>((ready, fail) => {
    let buf = '';
    proc.stdout?.on('data', (d: Buffer) => {
      buf += String(d);
      if (/READY=\d+/.test(buf)) ready();
    });
    proc.on('exit', (code, signal) => {
      if (!/READY=/.test(buf)) fail(new Error(`holder exited early code=${code} signal=${signal}`));
    });
  });
  proc.kill('SIGKILL');
  await exited(proc);
  expect(hasUncleanShutdown(dbPath)).toBe(true);
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

(hasTurso ? describe : describe.skip)('BL-9f6681ee — an owed deep verify is not starved', () => {
  it('(a) a short-lived (default schedule) opener records the obligation but forks no verifier', async () => {
    const dbPath = join(tmpDir, 'oneshot.db');
    await crashStore(dbPath);
    const touch = join(tmpDir, 'oneshot.touch');
    process.env['DEEP_VERIFY_FAKE_TOUCH'] = touch;

    const adapter = await TursoAdapterImpl.connect({ dbPath, deepVerify: { verifier: { path: FAKE_OK } } });
    try {
      await adapter.executeGet('SELECT 1 AS x'); // first use = real open
      // Give a (buggy) background fork ample time to start and finish.
      await new Promise((r) => setTimeout(r, 1_500));
      expect(_activeDeepVerifyForTest(dbPath)).toBeNull();
      expect(existsSync(touch)).toBe(false);
      expect(existsSync(deepVerifyLockPath(canonicalDbPath(dbPath)))).toBe(false);
      expect(await readDeepVerifyState(adapter)).toBeNull();
      // The obligation is still recorded for the owner to serve.
      expect((await readDeepVerifyObligation(adapter))?.reason).toBe('unclean_shutdown');
    } finally {
      await adapter.close();
    }
  }, 60_000);

  it('(b) an owner blocked by a live peer lock runs the pass once the lock frees', async () => {
    const dbPath = join(tmpDir, 'owner.db');
    await crashStore(dbPath);
    const touch = join(tmpDir, 'owner.touch');
    process.env['DEEP_VERIFY_FAKE_TOUCH'] = touch;

    // A live foreign process holds the single-flight lock (never our own pid:
    // tryAcquire treats that as our leaked lock and steals it).
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
    children.push(holder);
    expect(holder.pid).toBeDefined();
    const lockPath = deepVerifyLockPath(canonicalDbPath(dbPath));
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `${String(holder.pid)}\n${new Date().toISOString()}\n`);

    const adapter = await TursoAdapterImpl.connect({
      dbPath,
      deepVerify: {
        schedule: 'owner',
        timeoutMs: 10_000,
        verifier: { path: FAKE_OK },
        peerRetry: { initialMs: 100, maxMs: 400 },
      },
    });
    try {
      await adapter.executeGet('SELECT 1 AS x'); // first use = real open → peer_running
      // While the peer holds the lock: nothing runs here, still owed.
      await new Promise((r) => setTimeout(r, 1_000));
      expect(existsSync(touch)).toBe(false);
      expect(await readDeepVerifyObligation(adapter)).not.toBeNull();

      // The peer dies without releasing (the one-shot SIGKILL shape).
      holder.kill('SIGKILL');
      await exited(holder);

      await waitFor(
        async () => (await readDeepVerifyObligation(adapter)) === null,
        15_000,
        'owner re-attempts after the peer lock frees and clears the obligation',
      );
      expect((await readDeepVerifyState(adapter))?.status).toBe('ok');
      expect(existsSync(touch)).toBe(true);
    } finally {
      await adapter.close();
    }
  }, 60_000);
});
