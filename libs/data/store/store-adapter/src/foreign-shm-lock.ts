/**
 * (BUG-026) FOREIGN `-shm` LOCK PROBE — "is a classic SQLite opener holding it?"
 *
 * ── The problem this solves ─────────────────────────────────────────────────
 *
 * A `-shm` sidecar beside a TURSO store was written by a better-sqlite3-family
 * opener (turso coordinates its shared WAL through `-tshm` and never creates
 * the classic `-shm`). It is NOT necessarily abandoned residue: this package's
 * own sanctioned schema hatches open better-sqlite3 on the store
 * (`preflightSchemaSanity`'s readonly `openSchemaReader` on the open path,
 * `deleteSchemaRowsViaBetterSqlite3` during FTS5 repair), and a raw
 * better-sqlite3 / stock-`sqlite3` open does too. Renaming a `-shm` out from
 * under a LIVE classic reader races its WAL coordination — the cross-engine
 * corruption class the reconcile gate exists to prevent (adhd ADR-0012).
 *
 * Presence alone cannot distinguish "abandoned residue" (safe to reconcile)
 * from "a live classic connection" (must never be touched), and the previous
 * gate used the turso lease (`storeQuiescence`): under ANY live turso peer it
 * declined — so a persistent `-shm` residue was refused forever while a turso
 * peer held the store, and the store could not be opened at all.
 *
 * ── The probe ───────────────────────────────────────────────────────────────
 *
 * A live classic opener holds a SHARED lock on the database file for the life
 * of its connection (measured: even an opener that has only run a
 * `sqlite_master` read blocks it). An ABANDONED `-shm` has no such holder, so
 * the store can be taken EXCLUSIVELY. The probe therefore attempts an
 * EXCLUSIVE better-sqlite3 open and reads it:
 *
 *   - open + read succeeds            → `unlocked`      (no live classic holder)
 *   - the read fails `SQLITE_BUSY`    → `locked`        (a live classic holder)
 *   - any other failure               → `indeterminate` (not provable either way)
 *
 * ── Why it runs in a CHILD PROCESS ──────────────────────────────────────────
 *
 * The exclusive acquisition needs a READ-WRITE open (a read-only fd cannot take
 * the exclusive lock — measured: `locking_mode=EXCLUSIVE` on a `{readonly:true}`
 * handle fails `SQLITE_IOERR_LOCK`). But better-sqlite3's close-time WAL path
 * CHECKPOINTS and DELETES the shared `-wal` when it believes it is the last
 * connection — which is exactly the "exp9 poisoner" (BUG-017): deleting the
 * WAL a live turso peer coordinates through `-tshm` is the corruption class this
 * whole gate protects against. So the probe is run in a short-lived child that
 * opens read-write, takes the exclusive lock, reports the verdict, and then
 * `process.exit(0)` WITHOUT ever calling `close()`. Measured: the shared `-wal`
 * is left byte-identical (a populated 4 MB WAL survived a probe intact), and a
 * live turso peer is unaffected (it holds no classic lock, so the exclusive
 * open still succeeds).
 *
 * Every failure mode degrades to `indeterminate`, which the caller MUST treat
 * as "not provably unlocked" (decline). The one thing the probe must never do
 * is wrongly report `unlocked`.
 *
 * @module
 */

import { statSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { log } from '@adhd/sox-telemetry';

// ── Typed tuning (ADR-0013 D3 — a clamped number, never a toggle) ────────────

/** Default bound on the child probe. The child uses `busy_timeout = 0`, so it
 *  returns within a few hundred ms on every normal path; this only bounds a
 *  pathological hang (a wedged child is killed and reported `indeterminate`). */
export const FOREIGN_SHM_LOCK_PROBE_DEFAULT_TIMEOUT_MS = 5_000;
export const FOREIGN_SHM_LOCK_PROBE_FLOOR_MS = 250;
export const FOREIGN_SHM_LOCK_PROBE_CEILING_MS = 30_000;

/** Clamp a caller-supplied probe timeout to the permitted range. Never a
 *  toggle — there is no value that disables the probe. */
export function clampForeignShmLockProbeTimeoutMs(ms: number): number {
  const rounded = Math.round(ms);
  return Math.min(
    Math.max(rounded, FOREIGN_SHM_LOCK_PROBE_FLOOR_MS),
    FOREIGN_SHM_LOCK_PROBE_CEILING_MS,
  );
}

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * The lock-probe verdict for a store's classic `-shm` sidecar.
 *
 * - `absent`        — there is no `-shm` to probe (nothing foreign to reconcile).
 * - `unlocked`      — NO live classic opener holds it; the exclusive open
 *                     succeeded. A `-shm` in this state is abandoned residue and
 *                     may be reconciled even while live TURSO peers hold the store.
 * - `locked`        — a LIVE classic SQLite connection holds a shared lock on the
 *                     store (`SQLITE_BUSY`); the `-shm` MUST NOT be touched.
 * - `indeterminate` — the probe could not prove either state (better-sqlite3
 *                     absent, the child failed/timed out, or an unexpected
 *                     error). Callers MUST treat this as "not provably unlocked"
 *                     and decline — the safe direction.
 */
export type ForeignShmLockState = 'absent' | 'unlocked' | 'locked' | 'indeterminate';

export interface ForeignShmLockProbe {
  state: ForeignShmLockState;
  /** `exclusive-better-sqlite3` when the child probe actually ran; `none` when
   *  there was no `-shm`, or better-sqlite3 could not be resolved. */
  method: 'exclusive-better-sqlite3' | 'none';
  /** Human-readable detail for logs / caller diagnostics on the non-happy paths. */
  detail?: string;
}

/** The classic sidecar this module probes. Kept as a single definition so the
 *  probe, the reconcile and the preflight cleanup can never disagree. */
export function foreignShmPath(dbPath: string): string {
  return `${dbPath}-shm`;
}

// ── Probe implementation ──────────────────────────────────────────────────────

/** Lazily resolve the installed better-sqlite3. `optionalDependencies` means
 *  it may legitimately be absent; a missing module is a clean `null`, never a
 *  throw. */
function resolveBetterSqlite3(): string | null {
  try {
    return createRequire(import.meta.url).resolve('better-sqlite3');
  } catch (err) {
    log.debug('store_adapter.foreign_shm.probe_better_sqlite3_unresolved', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * The child source. Mirrors `openSchemaReader`'s schema tolerance
 * (`unsafeMode(true)` + `PRAGMA writable_schema = ON`) so a Turso FTS store —
 * which a plain better-sqlite3 read rejects as a malformed schema (BL-329) —
 * can still be probed. It performs NO write: the two settings only let the
 * read succeed; then `process.exit(0)` aborts before the close-time
 * checkpoint/WAL-delete can run.
 */
function probeChildSource(dbPath: string, betterSqlite3Path: string): string {
  const db = JSON.stringify(dbPath);
  const b3 = JSON.stringify(betterSqlite3Path);
  return `
const Database = require(${b3});
let verdict;
try {
  const db = new Database(${db});
  db.unsafeMode(true);
  db.pragma('writable_schema = ON');
  db.pragma('busy_timeout = 0');
  db.pragma('locking_mode = EXCLUSIVE');
  try {
    db.prepare('SELECT count(*) AS n FROM sqlite_master').get();
    verdict = 'unlocked';
  } catch (err) {
    const code = err && err.code ? String(err.code) : '';
    const msg = err && err.message ? String(err.message) : '';
    verdict = code === 'SQLITE_BUSY' || /database is locked/i.test(msg) ? 'locked' : 'indeterminate';
  }
} catch (err) {
  const code = err && err.code ? String(err.code) : '';
  const msg = err && err.message ? String(err.message) : '';
  verdict = code === 'SQLITE_BUSY' || /database is locked/i.test(msg) ? 'locked' : 'indeterminate';
}
process.stdout.write(verdict);
process.exit(0);
`.trim();
}

/**
 * Probe whether a live classic SQLite connection holds `dbPath`'s `-shm`.
 *
 * Synchronous and never throws. `absent` (a single `statSync`) when there is no
 * `-shm` — the common case, so the hot open path pays nothing. Otherwise it
 * runs the child probe (see the module doc for why a child).
 */
export function probeForeignShmLock(
  dbPath: string,
  opts: { timeoutMs?: number } = {},
): ForeignShmLockProbe {
  try {
    statSync(foreignShmPath(dbPath));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return { state: 'absent', method: 'none' };
    }
    // Any other stat failure (e.g. EACCES) is not provably "no -shm" — log it
    // and decline via `indeterminate` rather than silently treating it as
    // absent, which could let a reconcile touch a sidecar we never actually
    // ruled out.
    const detail = err instanceof Error ? err.message : String(err);
    log.debug('store_adapter.foreign_shm.probe_stat_failed', {
      db_path: dbPath,
      code: code ?? null,
      detail,
    });
    return {
      state: 'indeterminate',
      method: 'none',
      detail: `stat of -shm sidecar failed: ${detail}`,
    };
  }

  const betterSqlite3Path = resolveBetterSqlite3();
  if (betterSqlite3Path === null) {
    return {
      state: 'indeterminate',
      method: 'none',
      detail: 'better-sqlite3 is not installed; cannot prove the -shm unlocked',
    };
  }

  const timeoutMs =
    opts.timeoutMs !== undefined
      ? clampForeignShmLockProbeTimeoutMs(opts.timeoutMs)
      : FOREIGN_SHM_LOCK_PROBE_DEFAULT_TIMEOUT_MS;

  let out: string;
  try {
    out = execFileSync(process.execPath, ['-e', probeChildSource(dbPath, betterSqlite3Path)], {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.debug('store_adapter.foreign_shm.probe_child_failed', {
      db_path: dbPath,
      detail,
    });
    return {
      state: 'indeterminate',
      method: 'exclusive-better-sqlite3',
      detail: `probe child failed or timed out: ${detail}`,
    };
  }

  if (out === 'unlocked') return { state: 'unlocked', method: 'exclusive-better-sqlite3' };
  if (out === 'locked') return { state: 'locked', method: 'exclusive-better-sqlite3' };
  return {
    state: 'indeterminate',
    method: 'exclusive-better-sqlite3',
    detail: `probe child reported ${JSON.stringify(out)}`,
  };
}

/**
 * Remove a `-shm` that is provably unlocked — used by the readonly preflight to
 * clean up the sidecar its OWN readonly open materialised (a read-only SQLite
 * connection cannot unlink it, so it would otherwise persist as residue that
 * starts the next open's reconcile/BUG-026 refusal). Never throws; declines on
 * `locked`/`indeterminate` so it can never yank a live reader's sidecar.
 */
export function removeForeignShmIfUnlocked(
  dbPath: string,
  opts: { timeoutMs?: number } = {},
): { removed: boolean; state: ForeignShmLockState } {
  const probe = probeForeignShmLock(dbPath, opts);
  if (probe.state !== 'unlocked') return { removed: false, state: probe.state };
  try {
    unlinkSync(foreignShmPath(dbPath));
    return { removed: true, state: 'unlocked' };
  } catch (err) {
    log.debug('store_adapter.foreign_shm.remove_failed', {
      db_path: dbPath,
      reason: err instanceof Error ? err.message : String(err),
    });
    return { removed: false, state: 'unlocked' };
  }
}
