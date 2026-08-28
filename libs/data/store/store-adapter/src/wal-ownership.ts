/**
 * (BUG-026) LIFETIME WAL-ownership protocol.
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 *
 * The turso 0.7.1 engine deleted the shared `-wal` under a long-lived
 * connection during a concurrent CLI close burst; the connection then kept
 * writing to the ORPHANED inode for ~11.5h because `wal_identity` was captured
 * ONLY at open (`turso-adapter.ts`, `captureWalIdentity`) and compared ONLY at
 * close. Every one of those writes was silently lost on the next graceful
 * close — the exact BL-330 class, but stretched over hours instead of a single
 * close.
 *
 * The poisoner that made the store reachable by a foreign engine in the first
 * place was graph-store's `engineIdentity` getter, whose
 * `getEngineIdentitySync` performed a better-sqlite3 readonly open on the
 * turso store on EVERY construction — creating the classic `-shm` sidecar that
 * turso's `-tshm`-coordinated engine has no concept of (the 'exp9 poisoner'
 * cross-engine class, `engine-guard.ts`).
 *
 * This module is the LIFETIME half of the fix: the WAL identity is now checked
 * on EVERY write and on a periodic heartbeat — not just at close — so a
 * replaced WAL is detected within one heartbeat (default 10s, clamped 1s..60s)
 * rather than after hours. On detection the orphaned frames are folded into
 * the main database file through the fd the connection already holds
 * (`PRAGMA wal_checkpoint(PASSIVE)`), and the connection is recycled so a
 * fresh open re-captures the baseline. The close-time check (BL-330, already
 * correct in `TursoAdapterImpl`) remains the last-resort backstop.
 *
 * ── Typed tuning, never a toggle (ADR-0013 D3) ──────────────────────────────
 *
 * The heartbeat interval is a typed, clamped number — there is no
 * "disable the heartbeat" value and no boolean switch. `SOX_WAL_OWNERSHIP_HEARTBEAT_MS`
 * is clamped to [`WAL_OWNERSHIP_HEARTBEAT_FLOOR_MS`,
 * `WAL_OWNERSHIP_HEARTBEAT_CEILING_MS`]; an unset or unparsable value falls
 * back to {@link WAL_OWNERSHIP_HEARTBEAT_DEFAULT_MS}. A caller may also pass an
 * explicit per-connection value through `AdapterConfig.walOwnershipHeartbeatMs`
 * (clamped identically — tests use this to exercise the heartbeat without a
 * real 10s wait).
 *
 * @module
 */

import { renameSync, statSync } from 'node:fs';
import { log } from '@adhd/sox-telemetry';
import { probeWalIdentity } from './integrity.js';
import type { IntegrityFinding, WalIdentity } from './integrity.js';

// ── Heartbeat tuning (typed, clamped — ADR-0013 D3) ─────────────────────────

export const WAL_OWNERSHIP_HEARTBEAT_DEFAULT_MS = 10_000;
export const WAL_OWNERSHIP_HEARTBEAT_FLOOR_MS = 1_000;
export const WAL_OWNERSHIP_HEARTBEAT_CEILING_MS = 60_000;

/** Clamp a caller-supplied heartbeat to the permitted range. Never a toggle —
 *  an out-of-range value is clamped, not rejected, so a pathological operator
 *  value cannot disable the heartbeat (the floor) nor defer it forever (the
 *  ceiling). */
export function clampWalOwnershipHeartbeatMs(ms: number): number {
  const rounded = Math.round(ms);
  return Math.min(Math.max(rounded, WAL_OWNERSHIP_HEARTBEAT_FLOOR_MS), WAL_OWNERSHIP_HEARTBEAT_CEILING_MS);
}

/**
 * The heartbeat interval from `SOX_WAL_OWNERSHIP_HEARTBEAT_MS`, clamped to
 * [floor, ceiling]. Unset/empty/non-finite → the default. This is the ONE env
 * knob for the lifetime ownership protocol — typed tuning, never a toggle.
 */
export function walOwnershipHeartbeatMs(): number {
  const raw = process.env.SOX_WAL_OWNERSHIP_HEARTBEAT_MS;
  if (raw === undefined || raw.trim() === '') return WAL_OWNERSHIP_HEARTBEAT_DEFAULT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return WAL_OWNERSHIP_HEARTBEAT_DEFAULT_MS;
  return clampWalOwnershipHeartbeatMs(n);
}

/**
 * Resolve the heartbeat interval for one connection: an explicit
 * per-connection value wins (clamped), else the env knob.
 */
export function resolveWalOwnershipHeartbeatMs(explicitMs?: number): number {
  if (explicitMs !== undefined) return clampWalOwnershipHeartbeatMs(explicitMs);
  return walOwnershipHeartbeatMs();
}

// ── WAL identity now (thin wrapper over the integrity probe) ────────────────

export type WalIdentityNowStatus = 'intact' | 'replaced' | 'no-baseline';

export interface WalIdentityNowResult {
  status: WalIdentityNowStatus;
  /** The underlying `wal_identity` finding when the probe ran (status
   *  `intact`/`replaced`); `null` for `no-baseline`. */
  finding: IntegrityFinding | null;
}

/**
 * Thin wrapper over {@link probeWalIdentity} with a lifetime-friendly verdict:
 * `intact` (identity stable), `replaced` (unlinked or a different inode —
 * writes are going to an orphaned fd), or `no-baseline` (nothing captured at
 * open to compare against — never a health claim, just "not yet armed").
 */
export function verifyWalIdentityNow(baseline: WalIdentity | null): WalIdentityNowResult {
  const finding = probeWalIdentity(baseline);
  if (finding === null) return { status: 'no-baseline', finding: null };
  if (finding.status === 'damaged') return { status: 'replaced', finding };
  return { status: 'intact', finding };
}

// ── Error taxonomy ──────────────────────────────────────────────────────────

/**
 * (BUG-026) Thrown by `SqliteAdapterImpl` on EVERY writable operation after
 * the WAL identity was observed replaced — fail-loud, so a caller can never
 * silently keep writing into an orphaned WAL inode. Reads keep working: the
 * frames already folded are durable in the main db file. Recovering means
 * closing and reopening the store (a fresh open re-captures the baseline).
 */
export class EStoreWalReplaced extends Error {
  public readonly code = 'E_STORE_WAL_REPLACED';

  constructor(public readonly dbPath: string | undefined) {
    super(
      `[BUG-026] the WAL of "${dbPath ?? '<unknown>'}" was replaced while this connection held it ` +
        `open — writes are no longer safe and are now failed-loud (reads continue). Close and ` +
        `reopen the store to re-capture the WAL identity and resume writing.`,
    );
    this.name = 'EStoreWalReplaced';
  }
}

/**
 * (BUG-026) Thrown by `TursoAdapterImpl._openReal` when a foreign
 * better-sqlite3 `-shm` sidecar sits beside a turso store WHILE live turso
 * peers hold the store — reconciling it under a live peer is the exact
 * cross-engine hazard this module exists to prevent, so the open refuses
 * instead. Once the store is quiescent the same sidecar is reconciled (renamed
 * to `.stale-*`) rather than refused.
 */
export class EForeignSqliteSidecar extends Error {
  public readonly code = 'E_FOREIGN_SQLITE_SIDECAR';

  constructor(
    public readonly dbPath: string,
    /** Live peer entries at the moment of the refusal (token + pid). */
    public readonly livePeers: { token: string; pid: number }[],
  ) {
    const pids = livePeers.map((p) => p.pid).join(', ') || 'none';
    super(
      `[BUG-026] a foreign better-sqlite3 -shm sidecar sits beside "${dbPath}" while ` +
        `${livePeers.length} live peer(s) hold the store (live peer pids: ${pids}) — refusing to ` +
        `open until the store is quiescent, so a reconcile cannot race a live peer's WAL coordination.`,
    );
    this.name = 'EForeignSqliteSidecar';
  }
}

// ── Foreign -shm reconciliation ─────────────────────────────────────────────

export interface ReconcileForeignSqliteShmResult {
  reconciled: boolean;
  /** The rename target when reconciled (preserved for forensics). */
  renamedTo?: string;
  /** Why nothing was moved, when the reconcile was declined (live peers, or a
   *  rename failure). Absent when there was simply no `-shm` to reconcile. */
  declined?: string;
}

/**
 * Reconcile a foreign `-shm` sidecar beside a TURSO store.
 *
 * A `-shm` beside a turso store is FOREIGN by construction: turso coordinates
 * its shared WAL through the `-tshm` sidecar and never creates or reads the
 * classic `-shm`. A `-shm` therefore means a better-sqlite3 opener touched the
 * store (the 'exp9 poisoner' class — graph-store's former `engineIdentity`
 * getter, or any raw better-sqlite3 open). Reconcile it so the turso open
 * never contends with a stale classic-sidecar:
 *
 * - **Quiescent** (`storeInUse !== true`): rename `<db>-shm` to
 *   `<db>-shm.stale-<stamp>` (never delete — the forensic record).
 * - **Live peers** (`storeInUse === true`): decline — under a live peer the
 *   `-shm` may still be in use by a concurrent classic opener, and renaming it
 *   is the cross-engine corruption risk this module refuses to take. The
 *   caller decides what to do with the decline (turso-adapter throws
 *   {@link EForeignSqliteSidecar}).
 *
 * Deterministic fs-only; never throws. A `-shm` that is absent is not a
 * decline — it is "nothing foreign to reconcile" (`reconciled: false`, no
 * `declined`).
 */
export function reconcileForeignSqliteShm(
  dbPath: string,
  opts: { storeInUse?: boolean },
): ReconcileForeignSqliteShmResult {
  const shmPath = dbPath + '-shm';
  let present = false;
  try {
    statSync(shmPath);
    present = true;
  } catch {
    present = false;
  }
  if (!present) {
    return { reconciled: false }; // nothing foreign to reconcile
  }
  if (opts.storeInUse === true) {
    return {
      reconciled: false,
      declined:
        'store is in use by another connection — refusing to reconcile the foreign -shm sidecar ' +
        '(live WAL coordination state may still be in use)',
    };
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const to = `${shmPath}.stale-${stamp}`;
  try {
    renameSync(shmPath, to);
    return { reconciled: true, renamedTo: to };
  } catch (err) {
    return {
      reconciled: false,
      declined: `could not move ${shmPath} aside: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Shared recovery detail (used by both adapters) ──────────────────────────

/**
 * (BUG-026) The "WAL was replaced" damage detail, emitted through
 * `emitIntegrityReport` when a lifetime check observes a replaced identity.
 * Shared so the turso and sqlite adapters carry one wording.
 */
export function describeWalReplaced(finding: IntegrityFinding | null): string {
  if (finding !== null) return finding.detail;
  return 'the WAL identity was replaced while this connection held it open';
}

/** Trace a replaced-WAL observation — never silent, distinct from the fatal-
 *  connection poison key so operators can tell the two recycle causes apart. */
export function logWalReplacedObserved(
  scope: 'store_adapter.turso' | 'store_adapter.sqlite',
  dbPath: string | undefined,
  trigger: 'write' | 'heartbeat',
): void {
  log.error(`${scope}.wal_replaced_observed`, {
    db_path: dbPath ?? null,
    trigger,
  });
}
