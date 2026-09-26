/**
 * cold-open-lock — serialize the Turso driver open + shared-WAL coordination
 * init of ONE store path across processes (6fd60658).
 *
 * THE DEFECT: `@tursodatabase/database` 0.7.x panics in Rust
 * (`core/storage/shared_wal_coordination.rs:1644`) when several processes
 * cold-open the SAME store at the same instant. A panic crossing the napi
 * boundary aborts the process — it is not catchable, so the adapter's bounded
 * open retry (`isTshmCoordinationInitRace`) can never absorb it. Measured on
 * this tree with 16–24 simultaneous cold opens of one path: 4/1920 and
 * 2/960 processes died with that panic. 0.7.2 does not touch the coordination
 * code (its 14 commits are sync/mvcc/bindings only), and 0.8.0 is prerelease.
 *
 * THE FIX: the adapter's real open (`TursoAdapterImpl._openReal`) holds this
 * advisory lock from just after the lease is acquired until the open-time
 * probes and the multiprocess-WAL sidecar verification finish — the window in
 * which the `-tshm` coordination file is created and initialised. It is never
 * held across a caller's query: `_openReal` releases it before returning the
 * instance.
 *
 * LOCATION: `<dbPath>.sox-lease.d/.coldopen.lock`. The lease dir already
 * exists for every local open (`acquireStoreLease` mkdirs it), and its two
 * readers skip this entry by construction: `storeQuiescence` ignores
 * dot-prefixed names and the preflight marker scan reads only `*.openmark`.
 *
 * STALE-SAFETY: the file carries the same `pid\nisoTime\n` shape as a lease
 * entry (plus a per-acquire nonce), so liveness is judged by the shared
 * `entryLiveness` probe. A holder that died mid-open — the exact case this
 * lock exists for, since the defect is an abort — is swept and the waiter
 * proceeds. A live holder older than `COLD_OPEN_LOCK_STALE_MS` is also swept
 * (an open never legitimately takes that long; a recycled pid must not wedge
 * the store). A waiter that still cannot acquire within its bounded wait logs
 * and proceeds UNLOCKED: this lock narrows a race, it must never turn a slow
 * peer into an unopenable store.
 *
 * Pure `node:fs` — synchronous fs calls, no top-level await (CJS-safe,
 * libs/data/CLAUDE.md rule 7). Remote URLs have no local path and never lock.
 */
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { log } from '@adhd/sox-telemetry';
import { entryLiveness, isEexist, leaseDirPath } from './store-lease.js';

/** Entry name inside the lease dir. Dot-prefixed so `storeQuiescence` never
 *  counts it as a peer connection. */
export const COLD_OPEN_LOCK_NAME = '.coldopen.lock';

/** A lock (or an unparseable, half-written lock file) older than this is
 *  swept regardless of the holder pid's liveness. */
export const COLD_OPEN_LOCK_STALE_MS = 30_000;

/** Default bound on how long an opener waits for a live holder. */
export const COLD_OPEN_LOCK_MAX_WAIT_MS = 15_000;

const POLL_MIN_MS = 5;
const POLL_MAX_MS = 50;

export interface ColdOpenLock {
  /** False when the bounded wait expired and the open proceeds unlocked. */
  acquired: boolean;
  /** Milliseconds spent waiting for a peer before acquiring (or giving up). */
  waitedMs: number;
  /** Idempotent. Removes the lock file only if it still holds THIS acquire's
   *  content — never a successor's lock. */
  release(): void;
}

export function coldOpenLockPath(dbPath: string): string {
  return join(leaseDirPath(dbPath), COLD_OPEN_LOCK_NAME);
}

function readLock(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    log.debug('store_adapter.cold_open_lock.read_failed', {
      path,
      code: (err as NodeJS.ErrnoException | null)?.code ?? 'unknown',
      reason: 'lock released concurrently (ENOENT) or unreadable; re-attempting acquire',
    });
    return null;
  }
}

function lockAgeMs(path: string, now: number): number | null {
  try {
    return now - statSync(path).mtimeMs;
  } catch (err) {
    log.debug('store_adapter.cold_open_lock.stat_failed', {
      path,
      code: (err as NodeJS.ErrnoException | null)?.code ?? 'unknown',
      reason: 'lock released concurrently; re-attempting acquire',
    });
    return null;
  }
}

/** Unlink `path` only if it still holds `expected`. The read→unlink pair has
 *  a residual window in which a peer could replace the file; the consequence
 *  is two overlapping opens (today's behaviour), never a wedge or data loss. */
function unlinkIfUnchanged(path: string, expected: string, event: string): void {
  const current = readLock(path);
  if (current !== expected) return;
  try {
    unlinkSync(path);
  } catch (err) {
    log.debug(event, {
      path,
      code: (err as NodeJS.ErrnoException | null)?.code ?? 'unknown',
      reason: 'already removed by a peer; removal is idempotent',
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire the cold-open lock for `dbPath` (a CANONICAL path — callers pass
 * `canonicalDbPath(...)`, the same key the lease uses). Always resolves; never
 * throws for contention. An unexpected fs error (not EEXIST) is logged and the
 * open proceeds unlocked, matching the timeout policy.
 */
export async function acquireColdOpenLock(
  dbPath: string,
  opts: { maxWaitMs?: number } = {},
): Promise<ColdOpenLock> {
  const maxWaitMs = opts.maxWaitMs ?? COLD_OPEN_LOCK_MAX_WAIT_MS;
  const path = coldOpenLockPath(dbPath);
  const content = `${process.pid}\n${new Date().toISOString()}\n${randomUUID()}\n`;
  const started = Date.now();
  const unlocked = (): ColdOpenLock => ({
    acquired: false,
    waitedMs: Date.now() - started,
    release: () => undefined,
  });

  try {
    mkdirSync(leaseDirPath(dbPath), { recursive: true });
  } catch (err) {
    log.warn('store_adapter.cold_open_lock.mkdir_failed', {
      db_path: dbPath,
      error: err instanceof Error ? err.message : String(err),
      reason: 'cannot create lease dir; opening without the cold-open lock',
    });
    return unlocked();
  }

  // Every path through the loop is bounded by the deadline check at its TOP:
  // a sweep that cannot take effect (read-only lease dir → unlink EACCES while
  // `wx` keeps reporting EEXIST) or an unreadable lock must never spin the
  // main thread. Only FAST_RETRIES immediate re-attempts are allowed after a
  // sweep or a vanished file; after that every iteration sleeps.
  const FAST_RETRIES = 3;
  let fastRetries = 0;
  let attempted = false;
  for (;;) {
    if (attempted && Date.now() - started >= maxWaitMs) {
      log.warn('store_adapter.cold_open_lock.wait_timeout', {
        db_path: dbPath,
        waited_ms: Date.now() - started,
        reason: 'holder did not release (or could not be swept) within the bound; opening without the lock',
      });
      return unlocked();
    }
    attempted = true;
    try {
      writeFileSync(path, content, { flag: 'wx' });
      let released = false;
      return {
        acquired: true,
        waitedMs: Date.now() - started,
        release: () => {
          if (released) return;
          released = true;
          unlinkIfUnchanged(path, content, 'store_adapter.cold_open_lock.release_unlink_failed');
        },
      };
    } catch (err) {
      if (!isEexist(err)) {
        log.warn('store_adapter.cold_open_lock.create_failed', {
          db_path: dbPath,
          error: err instanceof Error ? err.message : String(err),
          reason: 'unexpected fs error creating the lock; opening without it',
        });
        return unlocked();
      }
    }

    // EEXIST — judge the current holder.
    const now = Date.now();
    const held = readLock(path);
    let retryNow = held === null; // released between our create and read
    if (held !== null) {
      const age = lockAgeMs(path, now);
      const info = entryLiveness(held, now);
      const agedOut = age !== null && age > COLD_OPEN_LOCK_STALE_MS;
      // `info === null` is a half-written file (wx creates, then writes):
      // only an aged-out one is stale, a fresh one is a holder mid-acquire.
      const dead = info !== null && !info.live;
      if (dead || agedOut) {
        log.warn('store_adapter.cold_open_lock.stale_swept', {
          db_path: dbPath,
          holder_pid: info?.pid ?? null,
          holder_live: info?.live ?? null,
          age_ms: age,
        });
        unlinkIfUnchanged(path, held, 'store_adapter.cold_open_lock.sweep_unlink_failed');
        retryNow = true;
      }
    }
    if (retryNow && fastRetries < FAST_RETRIES) {
      fastRetries++;
      continue;
    }
    await sleep(POLL_MIN_MS + Math.floor(Math.random() * (POLL_MAX_MS - POLL_MIN_MS)));
  }
}
