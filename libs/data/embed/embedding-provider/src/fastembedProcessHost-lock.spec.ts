import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAndClaimFastembedLock, isPidAlive } from './fastembedProcessHost.js';

/**
 * BL-331 regression test — advisory cross-process CoreML/ANE contention lock.
 *
 * Context of BL-331: two orphaned one-shot debug scripts each forked their
 * own `fastembedProcessHost.js` and never exited, each holding a live CoreML
 * `InferenceSession` for hours alongside the real memory-server's own
 * fastembed process. (Measured at kill time: ~32-46MB RSS each, NOT the ~900MB
 * an earlier revision of this story claimed.) Production embed latency was
 * 8-20s per call (at only ~34% CPU — i.e. waiting, not computing) vs. ~0.4s in
 * a clean-room single-process harness on the identical machine/model/EP — but
 * the clean-room number was taken on a quiet box and the production number
 * under load average 18-25, so that gap is partly load-confounded. That the
 * extra hosts CAUSED the slowdown via Neural Engine/hardware-queue contention
 * is an UNPROVEN hypothesis (the measured cause was scheduling QoS); reaping
 * both freed memory and did NOT change embed latency. What WAS real: nothing
 * logged the existence of sibling fastembed hosts, so the correlate was
 * invisible.
 *
 * `checkAndClaimFastembedLock()` is advisory-only (never blocks/refuses to
 * load) but makes a FUTURE second host an immediately greppable
 * `[fastembed] WARNING (BL-331)` stderr line naming the conflicting pid — an
 * observability aid, not a causal claim.
 */
describe('BL-331 — fastembed host cross-process contention lock', () => {
  let lockPath: string;
  let prevEnv: string | undefined;
  let prevService: string | undefined;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    lockPath = join(tmpdir(), `sox-fastembed-host-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.lock`);
    prevEnv = process.env['SOX_FASTEMBED_LOCK_PATH'];
    process.env['SOX_FASTEMBED_LOCK_PATH'] = lockPath;
    // BL-432: save + clear the service label so every pre-existing test in this
    // file keeps its original "no service identity" behaviour, and only the
    // BL-432 cases below opt in by setting it.
    prevService = process.env['SOX_FASTEMBED_SERVICE'];
    delete process.env['SOX_FASTEMBED_SERVICE'];
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    if (prevEnv === undefined) delete process.env['SOX_FASTEMBED_LOCK_PATH'];
    else process.env['SOX_FASTEMBED_LOCK_PATH'] = prevEnv;
    if (prevService === undefined) delete process.env['SOX_FASTEMBED_SERVICE'];
    else process.env['SOX_FASTEMBED_SERVICE'] = prevService;
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

  // ── BL-432: service identity + same-service suppression ──────────────────

  it('BL-432: writes the OWNING service label (from SOX_FASTEMBED_SERVICE) into the lock', () => {
    process.env['SOX_FASTEMBED_SERVICE'] = 'memory-server';
    checkAndClaimFastembedLock();
    const written = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { service?: string };
    expect(written.service).toBe('memory-server');
  });

  it('BL-432: omits the service field entirely when no service identity is threaded (back-compat with pre-BL-432 locks)', () => {
    checkAndClaimFastembedLock();
    const written = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
    expect(written).not.toHaveProperty('service');
  });

  it('BL-432 GREEN→ the sequential-CLI false positive: a SAME-service live host is NOT warned about', () => {
    const conflictingPid = process.ppid;
    expect(isPidAlive(conflictingPid)).toBe(true);
    process.env['SOX_FASTEMBED_SERVICE'] = 'backlog';
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: conflictingPid, startedAt: '2026-09-22T00:00:00.000Z', service: 'backlog' }),
    );

    checkAndClaimFastembedLock();

    // Same service -> suppressed, exactly like a pool sibling.
    expect(errorSpy).not.toHaveBeenCalled();
    // Still claims the lock for ourselves (advisory, never exclusive).
    const written = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number };
    expect(written.pid).toBe(process.pid);
  });

  it('BL-432: CROSS-service contention still warns — and now NAMES the competing service', () => {
    const conflictingPid = process.ppid;
    process.env['SOX_FASTEMBED_SERVICE'] = 'backlog';
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: conflictingPid, startedAt: '2026-09-22T00:00:00.000Z', service: 'memory-server' }),
    );

    checkAndClaimFastembedLock();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message] = errorSpy.mock.calls[0] as [string];
    expect(message).toContain('BL-331');
    expect(message).toContain(String(conflictingPid));
    expect(message).toContain('service memory-server');
    expect(message).toContain('CoreML');
  });

  it('BL-432: an UNLABELLED competing lock (no service) still warns when WE have a service — no false suppression', () => {
    const conflictingPid = process.ppid;
    process.env['SOX_FASTEMBED_SERVICE'] = 'backlog';
    fs.writeFileSync(lockPath, JSON.stringify({ pid: conflictingPid, startedAt: '2026-09-22T00:00:00.000Z' }));

    checkAndClaimFastembedLock();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect((errorSpy.mock.calls[0] as [string])[0]).toContain('service unknown');
  });

  it('BL-432: an uninitialised owner (no service) does NOT suppress a labelled same-owner lock — identity is required on BOTH sides', () => {
    const conflictingPid = process.ppid;
    // No SOX_FASTEMBED_SERVICE set (own service is undefined).
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: conflictingPid, startedAt: '2026-09-22T00:00:00.000Z', service: 'backlog' }),
    );

    checkAndClaimFastembedLock();

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
