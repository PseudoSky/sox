/**
 * lease-crash-safety.spec.ts — regression pins for two lease-registry hazards
 * investigated for BUG-STOREADAPTER-EPERM-READ-AS-DEAD-PEER-001 and
 * BUG-BACKLOG-PANIC-LEAKS-LEASE-001.
 *
 * FINDING (see the implementer's report): both properties these tests pin were
 * ALREADY CORRECT in `store-lease.ts` before this file was added.
 *
 *   1. EPERM discipline: `entryLiveness` (store-lease.ts:80-88) already
 *      classifies `kill(pid,0)` errno as EPERM ⇒ live, ESRCH/EINVAL ⇒ dead,
 *      anything else ⇒ undeterminable (fail closed / live-while-fresh). This
 *      was fixed in commit cf90c229 ("address BUG-019 review findings —
 *      live-pid liveness first, errno-aware marker catches", 2026-08-12) and
 *      has not regressed since.
 *
 *   2. Crash-safe liveness-on-read: `storeQuiescence`/`entryLiveness` decide
 *      liveness by PROBING THE PID on every call (`process.kill(pid, 0)`,
 *      store-lease.ts:82) — never by trusting an `unlink()` that ran on an
 *      orderly-exit/unwind path. A SIGKILLed process (or a native Rust panic
 *      that never runs JS cleanup) leaves its lease entry on disk, but the
 *      VERY NEXT read of that entry — no prior sweep pass required — probes
 *      the now-dead pid, gets ESRCH, and reports it dead (and sweeps it as a
 *      side effect). This has been true since the lease registry's original
 *      commit (b01c137a) — `acquireStoreLease`'s `release()` unlink is a
 *      best-effort optimization, never a correctness precondition.
 *
 * These tests exist to make both properties regression-proof going forward.
 * Each test's "RED" half is produced by mutating `entryLiveness` in-memory
 * (via `vi.doMock`-free direct monkeypatch is not possible for a named
 * function export used internally by `storeQuiescence`, so RED evidence for
 * these two properties was instead captured by hand: temporarily reverting
 * store-lease.ts to the pre-cf90c229 body and to a hypothetical
 * unlink-dependent design, running this file, observing failures, then
 * restoring — see the implementer's report for the exact failed/passed
 * counts). The committed test body below always runs against the CURRENT
 * (correct) implementation.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { entryLiveness, storeQuiescence, leaseDirPath, acquireStoreLease } from '../store-lease.js';

function tempDbPath(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `store-lease-crash-${label}-`));
  return join(dir, 'store.db');
}

/** Spawn a real child, SIGKILL it, and resolve once the OS has reaped it
 *  (the 'exit' event fires only after the process has actually terminated —
 *  this is what makes the pid provably dead for the liveness probe, the same
 *  guarantee a native panic or an external SIGKILL gives in production). */
function spawnAndSigkill(): Promise<number> {
  return new Promise((resolve, reject) => {
    // A long-lived child (sleeps) so the kill is what ends it, not a natural
    // exit racing the SIGKILL — this is the crash shape: no JS cleanup, no
    // unwind, no `release()` ever called.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    const pid = child.pid;
    if (pid === undefined) {
      reject(new Error('spawn returned no pid'));
      return;
    }
    child.once('exit', () => resolve(pid));
    child.once('error', reject);
    // Give the child a moment to actually start before killing it.
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (err) {
        reject(err as Error);
      }
    }, 50);
  });
}

describe('store-lease crash safety — BUG-BACKLOG-PANIC-LEAKS-LEASE-001', () => {
  it(
    'a SIGKILLed peer (no unwind, release() never ran) reads as dead on the ' +
      'FIRST storeQuiescence() call — no destructive sweep pass required first',
    async () => {
      const dbPath = tempDbPath('sigkill');
      const own = await acquireStoreLease(dbPath);

      const deadPid = await spawnAndSigkill();

      // Simulate the orphaned lease a panic/SIGKILL leaves behind: written
      // exactly as acquireStoreLease would have, but with no matching
      // release() ever executed (the crash scenario — cleanup that only
      // exists on an unwind path structurally cannot run).
      const orphanToken = 'crash-orphan';
      const orphanPath = join(leaseDirPath(dbPath), orphanToken);
      writeFileSync(orphanPath, `${deadPid}\n${new Date().toISOString()}\n`, { flag: 'wx' });

      // A SINGLE call. If liveness were decided any way other than "probe on
      // read", this is exactly the call that would wrongly report BUSY
      // forever (the bug's premise) or require a prior sweep pass to clear.
      const q = storeQuiescence(dbPath, own.token);

      expect(q.quiescent, 'the crashed peer must not block quiescence').toBe(true);
      expect(q.livePeers).toEqual([]);
      expect(existsSync(orphanPath), 'the orphaned entry must be swept as a read side effect').toBe(
        false,
      );

      await own.release();
    },
  );

  it('entryLiveness alone (no storeQuiescence wrapper) reports a SIGKILLed pid dead on first read', async () => {
    const deadPid = await spawnAndSigkill();
    const content = `${deadPid}\n${new Date().toISOString()}\n`;
    const info = entryLiveness(content);
    expect(info).not.toBeNull();
    expect(info?.live).toBe(false);
  });
});

describe('store-lease EPERM discipline — BUG-STOREADAPTER-EPERM-READ-AS-DEAD-PEER-001', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('EPERM (process exists, different uid) is classified LIVE, never dead', () => {
    const fakePid = 999999; // arbitrary — the kill call is mocked, never actually sent
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });

    const content = `${fakePid}\n${new Date().toISOString()}\n`;
    const info = entryLiveness(content);

    expect(info).not.toBeNull();
    expect(info?.live, 'EPERM means the process EXISTS (kill(2)) — must read as live').toBe(true);
  });

  it('ESRCH (no such process) is classified DEAD', () => {
    const fakePid = 999998;
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('ESRCH: no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });

    const content = `${fakePid}\n${new Date().toISOString()}\n`;
    const info = entryLiveness(content);

    expect(info).not.toBeNull();
    expect(info?.live).toBe(false);
  });

  it('an EPERM peer entry counts as a live peer in storeQuiescence — never swept, never a false quiescent', async () => {
    const dbPath = tempDbPath('eperm-quiescence');
    const own = await acquireStoreLease(dbPath);

    const fakePid = 999997;
    const peerToken = 'cross-uid-peer';
    const peerPath = join(leaseDirPath(dbPath), peerToken);
    writeFileSync(peerPath, `${fakePid}\n${new Date().toISOString()}\n`, { flag: 'wx' });

    const realKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      if (pid === fakePid) {
        const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return realKill(pid, signal as never);
    });

    const q = storeQuiescence(dbPath, own.token);

    expect(
      q.quiescent,
      'a live cross-uid peer must decline quiescence — this is exactly what ' +
        'authorizes destructive quiescence-gated work (reconcile/TRUNCATE/writable-open) if wrong',
    ).toBe(false);
    expect(q.livePeers).toEqual([{ token: peerToken, pid: fakePid }]);
    expect(existsSync(peerPath), 'a live (EPERM) peer must never be swept').toBe(true);

    // Cleanup: unmock before touching real fs/pid state further.
    vi.restoreAllMocks();
    readdirSync(leaseDirPath(dbPath)); // sanity: dir still readable after mock teardown
    await own.release();
  });

  it('an unrecognized errno (undeterminable) is treated live while fresh, per the documented fail-closed contract', () => {
    const fakePid = 999996;
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('EIO: some other errno') as NodeJS.ErrnoException;
      err.code = 'EIO';
      throw err;
    });

    const content = `${fakePid}\n${new Date().toISOString()}\n`;
    const info = entryLiveness(content, Date.now()); // fresh — well within the 24h age-out
    expect(info).not.toBeNull();
    expect(info?.live, 'undeterminable + fresh must fail closed (live), never dead').toBe(true);
  });
});
