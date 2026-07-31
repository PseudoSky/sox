import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAndClaimFastembedLock, isPidAlive } from './fastembedProcessHost.js';

/**
 * BL-331 regression test — advisory cross-process CoreML/ANE contention lock.
 *
 * Root cause of BL-331: two orphaned one-shot debug scripts each forked their
 * own `fastembedProcessHost.js` and never exited, each holding a live ~900MB
 * CoreML `InferenceSession` for hours alongside the real memory-server's own
 * fastembed process. Concurrent onnxruntime-node CoreML execution across
 * SEPARATE OS processes contends for the Apple Neural Engine hardware queue:
 * measured production embed latency was 8-20s per call (at only ~34% CPU —
 * i.e. waiting, not computing) vs. ~0.4s in a clean-room single-process
 * harness on the identical machine/model/execution-provider. This was
 * invisible for hours because nothing logged the existence of sibling
 * fastembed hosts.
 *
 * `checkAndClaimFastembedLock()` is advisory-only (never blocks/refuses to
 * load) but makes a FUTURE occurrence of this exact contention class an
 * immediately greppable `[fastembed] WARNING (BL-331)` stderr line naming
 * the conflicting pid, instead of a silent 25-50x slowdown.
 */
describe('BL-331 — fastembed host cross-process contention lock', () => {
  let lockPath: string;
  let prevEnv: string | undefined;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    lockPath = join(tmpdir(), `sox-fastembed-host-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.lock`);
    prevEnv = process.env['SOX_FASTEMBED_LOCK_PATH'];
    process.env['SOX_FASTEMBED_LOCK_PATH'] = lockPath;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    if (prevEnv === undefined) delete process.env['SOX_FASTEMBED_LOCK_PATH'];
    else process.env['SOX_FASTEMBED_LOCK_PATH'] = prevEnv;
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // already gone / never created — fine
    }
  });

  it('isPidAlive returns true for our own live pid', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('isPidAlive returns false for a pid that cannot exist (a very large invalid pid)', () => {
    // pid 2**31-1 essentially never corresponds to a live process on any
    // POSIX system's pid range, and is used here rather than reaping a real
    // child specifically to avoid any test flake from pid-reuse timing.
    expect(isPidAlive(2 ** 31 - 1)).toBe(false);
  });

  it('RED (pre-fix behavior, reproduced directly): no lock file exists yet — first claim logs nothing, just writes the lock', () => {
    expect(fs.existsSync(lockPath)).toBe(false);
    checkAndClaimFastembedLock();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number; startedAt: string };
    expect(written.pid).toBe(process.pid);
    expect(typeof written.startedAt).toBe('string');
  });

  it('does NOT warn when the lock is already held by OUR OWN pid (re-init in the same process)', () => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    checkAndClaimFastembedLock();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('does NOT warn when the lock names a DEAD pid (stale lock from a prior crashed/killed host)', () => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 31 - 1, startedAt: new Date().toISOString() }));
    checkAndClaimFastembedLock();
    expect(errorSpy).not.toHaveBeenCalled();
    // Still claims the lock for ourselves afterward.
    const written = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number };
    expect(written.pid).toBe(process.pid);
  });

  it('GREEN — this is the exact BL-331 scenario: warns loudly, naming the conflicting pid, when another LIVE process already holds the lock', () => {
    // process.ppid (the process that spawned this vitest worker) is always
    // alive, always owned by us (no EPERM signaling a pid we don't own —
    // unlike pid 1/launchd), and is never this test's own pid — a stable
    // stand-in for "a real sibling fastembed host process" without needing
    // to actually fork one.
    const conflictingPid = process.ppid;
    expect(isPidAlive(conflictingPid)).toBe(true);
    expect(conflictingPid).not.toBe(process.pid);

    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: conflictingPid, startedAt: '2026-07-30T12:37:05.000Z' }),
    );

    checkAndClaimFastembedLock();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message] = errorSpy.mock.calls[0] as [string];
    expect(message).toContain('BL-331');
    expect(message).toContain(String(conflictingPid));
    expect(message).toContain('CoreML');

    // Still claims the lock for ourselves after warning (advisory, not
    // exclusive — a legitimate second store on the same machine must not be
    // blocked from loading its own model).
    const written = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number };
    expect(written.pid).toBe(process.pid);
  });

  it('a malformed lock file does not throw and does not block re-claiming the lock', () => {
    fs.writeFileSync(lockPath, 'not-json{{{');
    expect(() => checkAndClaimFastembedLock()).not.toThrow();
    // Logs the non-fatal parse-failure warning, not the contention warning.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect((errorSpy.mock.calls[0] as [string])[0]).toContain('lock check failed');
    // Recovers: the lock file is now valid JSON naming our own pid.
    const written = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number };
    expect(written.pid).toBe(process.pid);
  });
});
