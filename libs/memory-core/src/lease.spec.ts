/**
 * lease.spec.ts — SA-8 writer lease tests (BL-128 / BL-145).
 *
 * Covers:
 *   1. Acquire and release lease — lock file created and removed.
 *   2. Acquire twice on same path fails with EWriterBusy (same process).
 *   3. Acquire on different paths succeeds independently.
 *   4. closeDbWithLease calls checkpoint + close + release.
 *   5. Stale lock recovery: stale lock file with dead PID cleaned up.
 *   6. _resetAllLeasesForTest closes all and clears.
 *   7. Negative control: acquire on one path does not conflict with another.
 *   8. getAllActiveLeases returns all held leases.
 *   9. isLeaseHeld returns correct boolean.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  acquireWriteLease,
  releaseWriteLease,
  closeDbWithLease,
  EWriterBusy,
  getAllActiveLeases,
  isLeaseHeld,
  _resetAllLeasesForTest,
  setLeaseInstanceId,
  getLeaseInstanceId,
} from './lease.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-'));
const INSTANCE_ID = 'test-instance-001';
const ARTIFACT = 'memory-core-test';

beforeEach(() => {
  setLeaseInstanceId(INSTANCE_ID);
});

afterEach(() => {
  _resetAllLeasesForTest();
});

afterAll(() => {
  // Best-effort cleanup of our temp dir
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ok */ }
});

function tmpDbPath(name: string): string {
  return path.join(TMP, name);
}

// ── 1. Acquire and release ─────────────────────────────────────────────────────

describe('acquire / release', () => {
  it('acquireWriteLease creates a lock file and returns LeaseInfo', () => {
    const dbPath = tmpDbPath('test1.db');
    const info = acquireWriteLease(dbPath, INSTANCE_ID, ARTIFACT);

    expect(info.pid).toBe(process.pid);
    expect(info.instance_id).toBe(INSTANCE_ID);
    expect(info.artifact).toBe(ARTIFACT);
    expect(typeof info.acquired_at).toBe('string');

    // Lock file exists
    const lockPath = `${dbPath}.writer.lock`;
    expect(fs.existsSync(lockPath)).toBe(true);

    // Lock file content is valid JSON
    const content = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
    expect(content.pid).toBe(process.pid);
    expect(content.instance_id).toBe(INSTANCE_ID);

    releaseWriteLease(dbPath);
  });

  it('releaseWriteLease removes the lock file', () => {
    const dbPath = tmpDbPath('test2.db');
    acquireWriteLease(dbPath, INSTANCE_ID, ARTIFACT);
    releaseWriteLease(dbPath);

    const lockPath = `${dbPath}.writer.lock`;
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('releaseWriteLease is idempotent when no lease held', () => {
    expect(() => releaseWriteLease(tmpDbPath('nonexistent.db'))).not.toThrow();
  });
});

// ── 2. Acquire twice on same path ──────────────────────────────────────────────

describe('double acquire', () => {
  it('acquireWriteLease twice on same path throws EWriterBusy', () => {
    const dbPath = tmpDbPath('double.db');
    acquireWriteLease(dbPath, INSTANCE_ID, ARTIFACT);

    try {
      acquireWriteLease(dbPath, INSTANCE_ID, ARTIFACT);
      expect.unreachable('Should have thrown EWriterBusy');
    } catch (e) {
      expect(e).toBeInstanceOf(EWriterBusy);
      const busy = e as EWriterBusy;
      expect(busy.code).toBe('E_BUSY');
      expect(busy.holder.pid).toBe(process.pid);
      expect(busy.holder.instance_id).toBe(INSTANCE_ID);
    }

    releaseWriteLease(dbPath);
  });
});

// ── 3. Different paths succeed independently ───────────────────────────────────

describe('independent paths', () => {
  it('acquireWriteLease on different paths succeeds independently', () => {
    const dbPathA = tmpDbPath('indep_a.db');
    const dbPathB = tmpDbPath('indep_b.db');

    const infoA = acquireWriteLease(dbPathA, INSTANCE_ID, ARTIFACT);
    const infoB = acquireWriteLease(dbPathB, INSTANCE_ID, ARTIFACT);

    expect(infoA.pid).toBe(process.pid);
    expect(infoB.pid).toBe(process.pid);

    releaseWriteLease(dbPathA);
    releaseWriteLease(dbPathB);

    expect(fs.existsSync(`${dbPathA}.writer.lock`)).toBe(false);
    expect(fs.existsSync(`${dbPathB}.writer.lock`)).toBe(false);
  });
});

// ── 4. closeDbWithLease ────────────────────────────────────────────────────────

describe('closeDbWithLease', () => {
  it('creates a real DB, checkpoints, closes, and releases lease', async () => {
    const dbPath = tmpDbPath('closelease.db');
    // Build the adapter from a path (not a caller-owned handle) so closeDbWithLease's
    // close() actually owns and closes the underlying connection — an adapter built
    // from a caller-supplied Database instance deliberately leaves it open (it doesn't
    // own it), so this test's "really closed" assertion needs the owning constructor.
    const { createSqliteAdapter } = await import('@adhd/sox-store-adapter');
    const adapter = createSqliteAdapter({ dbPath });
    const db = adapter.unwrap();
    db.exec('CREATE TABLE IF NOT EXISTS t (x INTEGER)');
    db.exec('INSERT INTO t VALUES (42)');

    await closeDbWithLease(adapter, dbPath);

    // DB should be closed
    expect(() => db.exec('SELECT 1')).toThrow();

    // Lock file should be gone
    expect(fs.existsSync(`${dbPath}.writer.lock`)).toBe(false);

    // Lease should not be held
    expect(isLeaseHeld(dbPath)).toBe(false);
  });
});

// ── 4b. BL-573: no ungated double-checkpoint on the close path ────────────────

describe('closeDbWithLease — BL-573 no ungated double-checkpoint', () => {
  it('never issues a raw PRAGMA wal_checkpoint before adapter.close()', async () => {
    const dbPath = tmpDbPath('bl573.db');
    const calls: string[] = [];
    // Minimal fake StoreAdapter — only exec()/close() are exercised by
    // closeDbWithLease. Any call to exec() proves this function is issuing
    // its OWN raw SQL again, which is exactly the regression BL-573 covers
    // (the adapter's real close() ceremony is the ONLY sanctioned place a
    // checkpoint may run from here on).
    const fakeAdapter = {
      exec: async (sql: string) => {
        calls.push(`exec:${sql}`);
      },
      close: async () => {
        calls.push('close');
      },
    } as unknown as import('@adhd/sox-store-adapter').StoreAdapter;

    await closeDbWithLease(fakeAdapter, dbPath);

    // The regression: with the bug, `calls` would be
    // ['exec:PRAGMA wal_checkpoint(TRUNCATE)', 'close'] — an ungated raw
    // checkpoint issued directly against the adapter, immediately before
    // adapter.close() ran its OWN full gated checkpoint ceremony (double
    // checkpoint, first half ungated).
    const rawTruncateCalls = calls.filter((c) => c.includes('wal_checkpoint'));
    expect(rawTruncateCalls).toEqual([]);
    expect(calls).toEqual(['close']);
  });
});

// ── 5. Stale lock recovery ────────────────────────────────────────────────────

describe('stale lock recovery', () => {
  it('acquireWriteLease cleans up a stale lock file with dead PID', () => {
    const dbPath = tmpDbPath('stale.db');
    const lockPath = `${dbPath}.writer.lock`;

    // Create a stale lock file with a PID that does not exist
    const staleInfo = {
      pid: 999_999_999,
      instance_id: 'dead-instance',
      acquired_at: new Date(Date.now() - 3600_000).toISOString(),
      artifact: 'old-process',
    };
    fs.writeFileSync(lockPath, JSON.stringify(staleInfo, null, 2) + '\n');

    // Acquire should clean up the stale lock and succeed
    const info = acquireWriteLease(dbPath, INSTANCE_ID, ARTIFACT);
    expect(info.pid).toBe(process.pid);
    expect(info.instance_id).toBe(INSTANCE_ID);

    // Old stale lock should be replaced
    const content = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
    expect(content.pid).toBe(process.pid);

    releaseWriteLease(dbPath);
  });

  it('acquireWriteLease recovers from a corrupt lock file', () => {
    const dbPath = tmpDbPath('corrupt.db');
    const lockPath = `${dbPath}.writer.lock`;

    // Create a garbage lock file
    fs.writeFileSync(lockPath, 'not-valid-json\n');

    // Acquire should clean up and succeed
    const info = acquireWriteLease(dbPath, INSTANCE_ID, ARTIFACT);
    expect(info.pid).toBe(process.pid);

    releaseWriteLease(dbPath);
  });
});

// ── 6. _resetAllLeasesForTest ──────────────────────────────────────────────────

describe('_resetAllLeasesForTest', () => {
  it('closes all fds and clears the map', () => {
    const dbPathA = tmpDbPath('reset_a.db');
    const dbPathB = tmpDbPath('reset_b.db');

    acquireWriteLease(dbPathA, INSTANCE_ID, ARTIFACT);
    acquireWriteLease(dbPathB, INSTANCE_ID, ARTIFACT);

    expect(getAllActiveLeases()).toHaveLength(2);

    _resetAllLeasesForTest();

    expect(getAllActiveLeases()).toHaveLength(0);
    expect(isLeaseHeld(dbPathA)).toBe(false);
    expect(isLeaseHeld(dbPathB)).toBe(false);
  });
});

// ── 7. Negative control ───────────────────────────────────────────────────────

describe('negative control (no cross-contamination)', () => {
  it('acquiring on one path does not affect another path', () => {
    const dbPathA = tmpDbPath('neg_a.db');
    const dbPathB = tmpDbPath('neg_b.db');

    acquireWriteLease(dbPathA, INSTANCE_ID, ARTIFACT);

    // b should be free
    expect(isLeaseHeld(dbPathB)).toBe(false);
    acquireWriteLease(dbPathB, INSTANCE_ID, ARTIFACT);

    // release b
    releaseWriteLease(dbPathB);
    expect(isLeaseHeld(dbPathB)).toBe(false);
    // a should still be held
    expect(isLeaseHeld(dbPathA)).toBe(true);

    releaseWriteLease(dbPathA);
  });
});

// ── 8. getAllActiveLeases ─────────────────────────────────────────────────────

describe('getAllActiveLeases', () => {
  it('returns all held leases', () => {
    const dbPathA = tmpDbPath('all_a.db');
    const dbPathB = tmpDbPath('all_b.db');

    expect(getAllActiveLeases()).toHaveLength(0);

    acquireWriteLease(dbPathA, INSTANCE_ID, ARTIFACT);
    expect(getAllActiveLeases()).toHaveLength(1);

    acquireWriteLease(dbPathB, INSTANCE_ID, ARTIFACT);
    expect(getAllActiveLeases()).toHaveLength(2);

    const infos = getAllActiveLeases();
    const pids = infos.map((i) => i.pid);
    expect(pids).toEqual([process.pid, process.pid]);

    releaseWriteLease(dbPathA);
    releaseWriteLease(dbPathB);
  });
});

// ── 9. isLeaseHeld ────────────────────────────────────────────────────────────

describe('isLeaseHeld', () => {
  it('returns correct boolean', () => {
    const dbPath = tmpDbPath('held.db');

    expect(isLeaseHeld(dbPath)).toBe(false);
    acquireWriteLease(dbPath, INSTANCE_ID, ARTIFACT);
    expect(isLeaseHeld(dbPath)).toBe(true);
    releaseWriteLease(dbPath);
    expect(isLeaseHeld(dbPath)).toBe(false);
  });
});

// ── 10. getLeaseInstanceId ─────────────────────────────────────────────────────

describe('getLeaseInstanceId', () => {
  it('returns the set instance id', () => {
    setLeaseInstanceId('my-custom-id');
    expect(getLeaseInstanceId()).toBe('my-custom-id');
  });

  it('returns a fallback when unset', () => {
    setLeaseInstanceId('');
    const fallback = getLeaseInstanceId();
    expect(fallback).toContain('unknown:');
  });
});
