/**
 * BL-deepverify — `deep` integrity verification never blocks a store open.
 *
 * Incident: a 417 MB Turso store ran `PRAGMA integrity_check` on the Node main
 * thread for 21+ minutes after an unclean shutdown; the in-thread watchdog
 * could not fire; the kill that ended it was itself an unclean shutdown, so
 * the next open did it again.
 *
 * Every case below drives the REAL `TursoAdapterImpl.connect()` → first-use
 * open → `runOpenTimeIntegrity`, against a store whose previous session was
 * genuinely SIGKILLed (a child process holding the store, killed -9, leaving
 * its dead-pid open marker). Verifiers are injected through the typed
 * `deepVerify.verifier` seam: a fake that parks its main thread in
 * `Atomics.wait` (the shape of a native step that no JS timer can interrupt),
 * a fake that completes `ok`, and — once — the real `deep-verify-child.ts`.
 *
 *  (a) open returns and serves while a deep verifier is artificially slow;
 *  (b) timeout → child SIGKILLed, probe `unknown`, degraded state persisted,
 *      and the kill does not re-arm the crash signal;
 *  (c) the obligation survives crash → open → timeout → clean shutdown →
 *      reopen, and a completed `ok` pass clears it (negative control: the
 *      NEXT clean open spawns nothing);
 *  (e) BL-deepverify-marker: a clean close whose `_adapter_meta` write would
 *      fail under a peer's write lock is NOT read as a crash on reopen, and
 *      the close does not stall on busy_timeout;
 *  (f) the verifier child's off-thread self-reaper kills its host on parent
 *      death and on its hard deadline while the host's main thread is blocked.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { SqliteAdapterImpl } from '../sqlite-adapter.js';
import {
  DEEP_VERIFY_DEGRADED_STATUSES,
  EInvalidDeepVerifyConfig,
  _activeDeepVerifyForTest,
  readDeepVerifyObligation,
  readDeepVerifyState,
  type DeepVerifyConfig,
} from '../deep-verify.js';
import { readIntegrityResult } from '../integrity.js';
import { summarizeIntegrityForStatus } from '../integrity-status.js';
import { hasUncleanShutdown } from '../preflight.js';
import { leaseDirPath } from '../store-lease.js';

const require = createRequire(import.meta.url);
const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch (err) {
    process.stderr.write(`[bl-deepverify test] turso driver unavailable: ${String(err)}\n`);
    return false;
  }
})();
const tursoDescribe = hasTurso ? describe : describe.skip;

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..', '..');
const HOLDER = resolve(HERE, 'fixtures', 'bug019-open-child.ts');
const FAKE_SLEEP = resolve(HERE, 'fixtures', 'deep-verify-fake-sleep.mjs');
const FAKE_OK = resolve(HERE, 'fixtures', 'deep-verify-fake-ok.mjs');
const REAPER_HOST = resolve(HERE, 'fixtures', 'deep-verify-reaper-host.ts');

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bl-deepverify-'));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function tempDb(label: string): string {
  return join(tmpDir, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function waitExit(proc: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
  return new Promise((resolveExit) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolveExit({ code: proc.exitCode, signal: proc.signalCode });
      return;
    }
    const t = setTimeout(() => resolveExit(null), timeoutMs);
    proc.once('exit', (code, signal) => {
      clearTimeout(t);
      resolveExit({ code, signal });
    });
  });
}

/**
 * Leave `dbPath` exactly as a crashed session leaves it: a child process opens
 * the store through the real adapter (writing its per-connection open marker),
 * then is SIGKILLed so no close code runs.
 */
async function crashStore(dbPath: string): Promise<void> {
  const proc = spawn(process.execPath, ['--import', 'tsx', HOLDER, dbPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: PKG_ROOT,
  });
  await new Promise<void>((resolveReady, rejectReady) => {
    let buf = '';
    let errBuf = '';
    proc.stdout?.on('data', (d: Buffer) => {
      buf += String(d);
      if (/READY=\d+/.test(buf)) resolveReady();
    });
    proc.stderr?.on('data', (d: Buffer) => {
      errBuf += String(d);
    });
    proc.on('exit', (code, signal) => {
      if (!/READY=/.test(buf)) rejectReady(new Error(`holder exited early code=${code} signal=${signal}: ${errBuf.slice(-800)}`));
    });
  });
  proc.kill('SIGKILL');
  await waitExit(proc, 10_000);
  expect(hasUncleanShutdown(dbPath)).toBe(true);
}

function connect(dbPath: string, deepVerify: DeepVerifyConfig): Promise<TursoAdapterImpl> {
  return TursoAdapterImpl.connect({ dbPath, deepVerify });
}

/** Wait for the background verifier the open scheduled, if any. */
async function awaitActive(dbPath: string, timeoutMs: number): Promise<ReturnType<typeof _activeDeepVerifyForTest>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = _activeDeepVerifyForTest(dbPath);
    if (run !== null && run.pid !== null) return run;
    if (Date.now() > deadline) return run;
    await new Promise((r) => setTimeout(r, 20));
  }
}

tursoDescribe('BL-deepverify — deep verification runs off-thread, out of process', () => {
  it('(a) the open returns and serves queries while a deep verifier is blocked', async () => {
    const dbPath = tempDb('a');
    await crashStore(dbPath);

    const adapter = await connect(dbPath, { timeoutMs: 20_000, verifier: { path: FAKE_SLEEP } });
    let verifierPid: number | null = null;
    try {
      const t0 = Date.now();
      const row = await adapter.executeGet<{ x: number }>('SELECT 1 AS x'); // first use = real open
      const openMs = Date.now() - t0;
      expect(row?.x).toBe(1);
      // The fake verifier never finishes. An open that waited for it would take
      // the whole 20 s bound; the open must return on the fast tier alone.
      expect(openMs).toBeLessThan(8_000);

      const run = await awaitActive(dbPath, 5_000);
      expect(run).not.toBeNull();
      verifierPid = run!.pid;
      expect(verifierPid).not.toBeNull();
      expect(verifierPid).not.toBe(process.pid);
      expect(pidAlive(verifierPid!)).toBe(true);

      // Serving continues — reads AND writes — while the verifier is blocked.
      await adapter.exec('CREATE TABLE IF NOT EXISTS served (id INTEGER PRIMARY KEY, v TEXT)');
      await adapter.executeRun('INSERT INTO served (v) VALUES (?)', ['while-deep-runs']);
      const n = await adapter.executeGet<{ n: number }>('SELECT COUNT(*) AS n FROM served');
      expect(n?.n).toBe(1);
      expect(pidAlive(verifierPid!)).toBe(true);
      expect((await readDeepVerifyState(adapter))?.status).toBe('running');
    } finally {
      await adapter.close();
    }
    // close() SIGKILLs the verifier it owns.
    expect(verifierPid).not.toBeNull();
    await waitFor(() => !pidAlive(verifierPid!), 5_000, 'verifier gone after close');
  }, 60_000);

  it('(b) a timed-out verifier is SIGKILLed and recorded unknown/degraded, never ok', async () => {
    const dbPath = tempDb('b');
    await crashStore(dbPath);

    const adapter = await connect(dbPath, { timeoutMs: 1_500, verifier: { path: FAKE_SLEEP } });
    try {
      await adapter.executeGet('SELECT 1');
      const run = await awaitActive(dbPath, 5_000);
      expect(run).not.toBeNull();
      const pid = run!.pid!;
      const settled = await Promise.race([
        run!.done,
        new Promise<'still-running'>((r) => setTimeout(() => r('still-running'), 12_000)),
      ]);
      expect(settled).not.toBe('still-running');
      const state = settled as Exclude<typeof settled, 'still-running'>;
      expect(state?.status).toBe('timed_out');
      expect(pidAlive(pid)).toBe(false);

      // Durable: what memory_ping reads.
      const persistedState = await readDeepVerifyState(adapter);
      expect(persistedState?.status).toBe('timed_out');
      expect(DEEP_VERIFY_DEGRADED_STATUSES).toContain(persistedState!.status);
      expect(persistedState?.detail).toMatch(/1500ms wall-clock bound/);

      const persisted = await readIntegrityResult(adapter);
      const deep = persisted!.result.verify.findings.filter(
        (f) => f.probe === 'pragma_integrity_check' && f.backlog === 'BL-deepverify',
      );
      expect(deep).toHaveLength(1);
      expect(deep[0]!.status).toBe('unknown');
      expect(deep[0]!.probeValidated).toBe(false);
      const view = summarizeIntegrityForStatus(persisted!.result, persisted!.runAtMs);
      expect(view.overall).toBe('unknown');
      expect(view.healthy).toBe(false);

      // The obligation stays; and the kill did not manufacture a crash signal.
      expect(await readDeepVerifyObligation(adapter)).not.toBeNull();
      expect(hasUncleanShutdown(dbPath)).toBe(false);
    } finally {
      await adapter.close();
    }
  }, 60_000);

  it('(c) the obligation survives crash → open → timeout → clean shutdown → reopen; ok clears it', async () => {
    const dbPath = tempDb('c');
    const touch = join(tmpDir, `c-runs-${Date.now()}.log`);
    await crashStore(dbPath);

    // 1. Open after the crash; its deep pass times out.
    const a = await connect(dbPath, { timeoutMs: 1_000, verifier: { path: FAKE_SLEEP } });
    await a.executeGet('SELECT 1');
    const runA = await awaitActive(dbPath, 5_000);
    expect((await runA!.done)?.status).toBe('timed_out');
    // 2. Clean shutdown.
    await a.close();
    expect(hasUncleanShutdown(dbPath)).toBe(false);

    // 3. Reopen: NOT a crash — but deep is still owed, so it runs.
    process.env.DEEP_VERIFY_FAKE_TOUCH = touch;
    try {
      const b = await connect(dbPath, { timeoutMs: 10_000, verifier: { path: FAKE_OK } });
      try {
        await b.executeGet('SELECT 1');
        const runB = await awaitActive(dbPath, 5_000);
        expect(runB).not.toBeNull();
        expect((await runB!.done)?.status).toBe('ok');
        expect(await readDeepVerifyObligation(b)).toBeNull();
        expect((await readDeepVerifyState(b))?.status).toBe('ok');
      } finally {
        await b.close();
      }
      expect(readFileSync(touch, 'utf8').trim().split('\n')).toHaveLength(1);

      // 4. Negative control: with the obligation cleared, a clean reopen spawns nothing.
      const c = await connect(dbPath, { timeoutMs: 10_000, verifier: { path: FAKE_OK } });
      try {
        await c.executeGet('SELECT 1');
        await new Promise((r) => setTimeout(r, 500));
        expect(_activeDeepVerifyForTest(dbPath)).toBeNull();
      } finally {
        await c.close();
      }
      expect(readFileSync(touch, 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      delete process.env.DEEP_VERIFY_FAKE_TOUCH;
    }
  }, 90_000);

  it('the REAL verifier child runs integrity_check read-only and clears the obligation', async () => {
    const dbPath = tempDb('real');
    await crashStore(dbPath);
    const adapter = await TursoAdapterImpl.connect({ dbPath, deepVerify: { timeoutMs: 60_000 } });
    try {
      await adapter.executeGet('SELECT 1');
      const run = await awaitActive(dbPath, 10_000);
      expect(run).not.toBeNull();
      const state = await run!.done;
      expect(state?.status, JSON.stringify(state)).toBe('ok');
      expect(await readDeepVerifyObligation(adapter)).toBeNull();
      const persisted = await readIntegrityResult(adapter);
      expect(persisted?.result.verify.depth).toBe('deep');
      const pic = persisted!.result.verify.findings.filter((f) => f.probe === 'pragma_integrity_check');
      expect(pic.length).toBeGreaterThan(0);
      expect(pic.every((f) => f.status === 'ok' && f.probeValidated)).toBe(true);
    } finally {
      await adapter.close();
    }
  }, 90_000);

  it('rejects a bad deepVerify config loudly at connect()', async () => {
    const dbPath = tempDb('cfg');
    for (const bad of [0, -1, 1.5, Number.NaN, 999, 7 * 60 * 60_000, '5000' as unknown as number]) {
      await expect(connect(dbPath, { timeoutMs: bad })).rejects.toBeInstanceOf(EInvalidDeepVerifyConfig);
    }
    expect(existsSync(dbPath)).toBe(false);
  });
});

tursoDescribe('BL-deepverify-marker — a failed clean-shutdown write is not a crash', () => {
  it('(e) a close under a peer write lock neither stalls nor makes the reopen owe deep', async () => {
    const dbPath = tempDb('marker');
    const seed = await TursoAdapterImpl.connect({ dbPath });
    await seed.exec('CREATE TABLE t (x INTEGER)');
    await seed.close();

    const touch = join(tmpDir, `marker-runs-${Date.now()}.log`);
    process.env.DEEP_VERIFY_FAKE_TOUCH = touch;
    try {
      const cfg: DeepVerifyConfig = { timeoutMs: 10_000, verifier: { path: FAKE_OK } };
      const a = await connect(dbPath, cfg);
      await a.executeRun('INSERT INTO t VALUES (1)');
      const peer = await connect(dbPath, cfg);
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let holding!: () => void;
      const nowHolding = new Promise<void>((r) => (holding = r));
      const tx = peer.transaction(
        async (t) => {
          await t.executeRun('INSERT INTO t VALUES (2)');
          holding();
          await held;
        },
        { mode: 'immediate' },
      );
      await nowHolding;

      // The peer holds the write lock. Before the fix, close() wrote
      // `_adapter_meta.clean_shutdown` here: a synchronous ~5 s busy_timeout
      // wait, then `database is locked`, leaving the flag at '0'.
      const t0 = Date.now();
      await a.close();
      const closeMs = Date.now() - t0;
      release();
      await tx;
      await peer.close();
      expect(closeMs).toBeLessThan(4_000);

      // Reopen: an orderly close is not a crash — nothing is owed, nothing runs.
      const b = await connect(dbPath, cfg);
      try {
        await b.executeGet('SELECT 1');
        await new Promise((r) => setTimeout(r, 500));
        expect(await readDeepVerifyObligation(b)).toBeNull();
        expect(_activeDeepVerifyForTest(dbPath)).toBeNull();
      } finally {
        await b.close();
      }
      expect(existsSync(touch)).toBe(false);
    } finally {
      delete process.env.DEEP_VERIFY_FAKE_TOUCH;
    }
  }, 60_000);
});

describe('BL-deepverify-marker — SQLite: a live peer connection is not a crash', () => {
  const hasSqlite = (() => {
    try {
      require.resolve('better-sqlite3');
      return true;
    } catch (err) {
      process.stderr.write(`[bl-deepverify test] better-sqlite3 unavailable: ${String(err)}\n`);
      return false;
    }
  })();
  const sqliteIt = hasSqlite ? it : it.skip;

  sqliteIt('(e2) a second open while the first is live owes nothing; a real crash still does', async () => {
    const dbPath = tempDb('sqlite-peer');
    const cfg: DeepVerifyConfig = { timeoutMs: 10_000, verifier: { path: FAKE_OK } };
    const a = new SqliteAdapterImpl(dbPath, { deepVerify: cfg });
    await a.init();
    await a.exec('CREATE TABLE t (x INTEGER)');
    // Before the fix, A's open wrote `_adapter_meta.clean_shutdown = '0'` and
    // B's open read that as "the previous session crashed".
    const b = new SqliteAdapterImpl(dbPath, { deepVerify: cfg });
    try {
      await b.init();
      expect(await readDeepVerifyObligation(b)).toBeNull();
      expect(_activeDeepVerifyForTest(dbPath)).toBeNull();
    } finally {
      await b.close();
      await a.close();
    }
    expect(hasUncleanShutdown(dbPath)).toBe(false);

    // A real crash signal — a marker left by a pid that no longer exists —
    // still makes the next open owe deep (and run it).
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await waitExit(dead, 10_000);
    mkdirSync(leaseDirPath(dbPath), { recursive: true });
    writeFileSync(join(leaseDirPath(dbPath), 'crashed.openmark'), `${dead.pid}\n${new Date().toISOString()}\n`);
    expect(hasUncleanShutdown(dbPath)).toBe(true);
    const c = new SqliteAdapterImpl(dbPath, { deepVerify: cfg });
    try {
      await c.init();
      const run = await awaitActive(dbPath, 5_000);
      expect(run).not.toBeNull();
      expect((await run!.done)?.status).toBe('ok');
      expect(await readDeepVerifyObligation(c)).toBeNull();
    } finally {
      await c.close();
    }
  }, 30_000);
});

describe('BL-deepverify — the verifier self-reaper runs off the blocked main thread', () => {
  function startHost(parentPid: number, hardDeadlineMs: number): { proc: ChildProcess; ready: Promise<number> } {
    const proc = spawn(process.execPath, ['--import', 'tsx', REAPER_HOST, String(parentPid), String(hardDeadlineMs)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: PKG_ROOT,
    });
    const ready = new Promise<number>((resolveReady, rejectReady) => {
      let buf = '';
      proc.stdout?.on('data', (d: Buffer) => {
        buf += String(d);
        const m = buf.match(/READY=(\d+)/);
        if (m) resolveReady(Number(m[1]));
      });
      proc.on('exit', (code, signal) => {
        if (!/READY=/.test(buf)) rejectReady(new Error(`reaper host exited early code=${code} signal=${signal}`));
      });
    });
    return { proc, ready };
  }

  it('(f1) kills its host when the parent pid dies', async () => {
    const fakeParent = spawn('sleep', ['60'], { stdio: 'ignore' });
    const host = startHost(fakeParent.pid!, 600_000);
    try {
      await host.ready;
      fakeParent.kill('SIGKILL');
      const exit = await waitExit(host.proc, 5_000);
      expect(exit?.signal).toBe('SIGKILL');
    } finally {
      if (host.proc.exitCode === null && host.proc.signalCode === null) host.proc.kill('SIGKILL');
      if (fakeParent.exitCode === null && fakeParent.signalCode === null) fakeParent.kill('SIGKILL');
    }
  }, 30_000);

  it('(f2) kills its host at the hard deadline even with a live parent', async () => {
    const host = startHost(process.pid, 800);
    try {
      await host.ready;
      const exit = await waitExit(host.proc, 6_000);
      expect(exit?.signal).toBe('SIGKILL');
    } finally {
      if (host.proc.exitCode === null && host.proc.signalCode === null) host.proc.kill('SIGKILL');
    }
  }, 30_000);
});
