/**
 * lease.ts — Writer lease (SA-8, BL-128 / BL-145).
 *
 * Ensures exactly one writer per SQLite store via an OS-level advisory lock file
 * (`<dbPath>.writer.lock`) created atomically with O_EXCL. The lock file contains
 * JSON LeaseInfo so a stale lock can be identified by PID + instance_id.
 *
 * [inv:no-side-effects-on-denial]: on denial (EWriterBusy), NO files are created
 * and NO partial state is left on disk. The lock file is only written after the
 * O_EXCL open succeeds, and on EEXIST with a live holder we throw without touching
 * anything.
 *
 * [inv:stale-recovery]: if the lock file's PID is dead (process.kill(pid, 0) throws
 * ESRCH), the stale lock is unlinked and acquisition is retried transparently.
 */

import * as fs from 'node:fs';
import type { StoreAdapter } from '@adhd/sox-store-adapter';

const { O_WRONLY, O_CREAT, O_EXCL } = fs.constants;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface LeaseInfo {
  pid: number;
  instance_id: string;
  acquired_at: string;
  artifact: string;
}

export class EWriterBusy extends Error {
  public readonly code = 'E_BUSY';
  constructor(message: string, public readonly holder: LeaseInfo) {
    super(message);
    this.name = 'EWriterBusy';
  }
}

// ── Module-level state ─────────────────────────────────────────────────────────

const activeLeases = new Map<string, { fd: number; leaseInfo: LeaseInfo }>();
let _instanceId = '';

export function setLeaseInstanceId(id: string): void {
  _instanceId = id;
}

export function getLeaseInstanceId(): string {
  return _instanceId || `unknown:${process.pid}`;
}

// ── Acquire ────────────────────────────────────────────────────────────────────

/**
 * Acquire an exclusive write lease for the store at `dbPath`.
 *
 * Creates `<dbPath>.writer.lock` atomically via `fs.openSync` with
 * O_WRONLY | O_CREAT | O_EXCL. On EEXIST:
 *   1. Read the holder info from the lock file.
 *   2. If the holder PID is alive → throw EWriterBusy (no side effects).
 *   3. If the holder PID is dead → unlink stale lock, retry.
 *
 * Returns the LeaseInfo that was written (and is now this process's lease).
 */
export function acquireWriteLease(
  dbPath: string,
  instanceId: string,
  artifact: string,
): LeaseInfo {
  const lockPath = `${dbPath}.writer.lock`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(lockPath, O_WRONLY | O_CREAT | O_EXCL);
      const leaseInfo: LeaseInfo = {
        pid: process.pid,
        instance_id: instanceId,
        acquired_at: new Date().toISOString(),
        artifact,
      };
      fs.writeFileSync(fd, JSON.stringify(leaseInfo, null, 2) + '\n');
      activeLeases.set(dbPath, { fd, leaseInfo });
      return leaseInfo;
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code !== 'EEXIST') throw err; // unexpected error

      // Lock file exists — read holder info
      let holder: LeaseInfo;
      try {
        const content = fs.readFileSync(lockPath, 'utf8');
        holder = JSON.parse(content) as LeaseInfo;
      } catch {
        // Corrupt lock file — remove and retry
        try { fs.unlinkSync(lockPath); } catch { /* best effort */ }
        continue;
      }

      // Check liveness of holder PID
      try {
        process.kill(holder.pid, 0);
        // Alive — denial, no side effects
        throw new EWriterBusy(
          `Store at ${dbPath} is locked by pid ${holder.pid} ` +
            `(instance: ${holder.instance_id}, artifact: ${holder.artifact})`,
          holder,
        );
      } catch (e) {
        if (e instanceof EWriterBusy) throw e;
        // Dead process — stale lock, clean it up and retry
        try { fs.unlinkSync(lockPath); } catch { /* best effort */ }
        // fall through to retry
      }
    }
  }

  // Should not reach here (max 3 retries for stale recovery)
  throw new Error(
    `Failed to acquire write lease for ${dbPath} after 3 attempts (stale lock could not be removed)`,
  );
}

// ── Release ────────────────────────────────────────────────────────────────────

/**
 * Release the write lease for the store at `dbPath`.
 *
 * fsync + close the lock file descriptor, then unlink the lock file,
 * then remove from the active leases map. Best-effort for each step.
 */
export function releaseWriteLease(dbPath: string): void {
  const entry = activeLeases.get(dbPath);
  if (!entry) return;

  const lockPath = `${dbPath}.writer.lock`;
  try {
    fs.fsyncSync(entry.fd);
  } catch { /* best effort */ }
  try {
    fs.closeSync(entry.fd);
  } catch { /* best effort */ }
  try {
    fs.unlinkSync(lockPath);
  } catch { /* lock file may already be gone */ }

  activeLeases.delete(dbPath);
}

// ── Close with lease ───────────────────────────────────────────────────────────

/**
 * Safely close a StoreAdapter and release its write lease:
 *   1. PRAGMA wal_checkpoint(TRUNCATE) to flush WAL
 *   2. adapter.close()
 *   3. releaseWriteLease()
 */
export async function closeDbWithLease(adapter: StoreAdapter, dbPath: string): Promise<void> {
  try {
    await adapter.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // best effort — adapter may already be closing
  }
  try {
    await adapter.close();
  } catch {
    // best effort — adapter may already be closed
  }
  releaseWriteLease(dbPath);
}

// ── Query active leases ────────────────────────────────────────────────────────

/** Return the LeaseInfo for a held lease, or undefined if none. */
export function getActiveLease(dbPath: string): LeaseInfo | undefined {
  return activeLeases.get(dbPath)?.leaseInfo;
}

/** Return all currently held leases (for diagnostics / memory_ping). */
export function getAllActiveLeases(): LeaseInfo[] {
  return Array.from(activeLeases.values()).map((e) => e.leaseInfo);
}

/** Boolean check whether a lease is held for the given path. */
export function isLeaseHeld(dbPath: string): boolean {
  return activeLeases.has(dbPath);
}

/**
 * Testing hook: close all lock file descriptors and clear the map.
 * NOT for production use — calling this while DBs are open will leak
 * connections.
 */
export function _resetAllLeasesForTest(): void {
  for (const [dbPath, entry] of activeLeases) {
    try { fs.fsyncSync(entry.fd); } catch { /* best effort */ }
    try { fs.closeSync(entry.fd); } catch { /* best effort */ }
    try { fs.unlinkSync(`${dbPath}.writer.lock`); } catch { /* best effort */ }
  }
  activeLeases.clear();
}
