/**
 * quota.ts — Per-store size quotas (HF-4, BL-133).
 *
 * Soft threshold → structured warning (non-blocking).
 * Hard threshold → E_IO-class structured refusal (write is NEVER attempted).
 *
 * The hard quota guard must hook the write path BEFORE any write touches the DB.
 * Call `checkStoreQuota(db, config)` at the top of the write handler — on E_IO the
 * caller must return the structured error immediately without proceeding to writes.
 *
 * CONTRACTS §B error shape (never a raw throw):
 *   { code: 'E_IO', message, retryable: false, details: { quota_bytes, current_bytes } }
 *
 * NEGATIVE CONTROL (NC — HF-4):
 *   quota.spec.ts contains a documented, skipped `it` that removes the hard-quota
 *   guard (by setting threshold to Infinity) and verifies the over-quota write
 *   succeeds — proving that the guard is what makes it fail, not something else.
 */

import type Database from 'better-sqlite3';
import * as fs from 'node:fs';
import type { StorageError } from './errors.js';

// ── Public types ──────────────────────────────────────────────────────────────

export interface QuotaConfig {
  /**
   * Soft threshold in bytes. When the DB file is larger than this, a warning is
   * emitted via the `warn` callback (or console.warn). The write is NOT blocked.
   * Default: 512 MiB.
   */
  softBytes?: number;
  /**
   * Hard threshold in bytes. When the DB file is larger than this, writes are
   * refused with an E_IO structured error. No write is attempted.
   * Default: 1 GiB.
   */
  hardBytes?: number;
  /**
   * Warning callback. Called when current_bytes > softBytes.
   * Default: console.warn.
   */
  warn?: (msg: string, details: QuotaWarningDetails) => void;
}

export interface QuotaWarningDetails {
  /** Absolute path to the DB file. */
  dbPath: string;
  /** Current DB file size in bytes. */
  current_bytes: number;
  /** Configured soft threshold in bytes. */
  soft_bytes: number;
  /** Configured hard threshold in bytes. */
  hard_bytes: number;
}

export interface QuotaOk {
  ok: true;
  current_bytes: number;
  soft_exceeded: boolean;
}

export type QuotaRefusal = StorageError & { code: 'E_IO' };

export type QuotaCheckResult = QuotaOk | QuotaRefusal;

// ── Defaults ──────────────────────────────────────────────────────────────────

/** Default soft quota: 512 MiB */
export const DEFAULT_SOFT_BYTES = 512 * 1024 * 1024;

/** Default hard quota: 1 GiB */
export const DEFAULT_HARD_BYTES = 1024 * 1024 * 1024;

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Check the current store size against soft and hard quotas.
 *
 * - If current > hard → returns E_IO structured refusal (caller must not write).
 * - If current > soft → emits warning via config.warn (or console.warn), returns ok.
 * - Otherwise          → returns ok.
 *
 * Uses the filesystem stat of the DB file (the main `.db` file; WAL/shm are tracked
 * separately by WriteQueue). The stat is a point-in-time snapshot — it does not
 * account for in-progress WAL frames. That is acceptable: the goal is to bound the
 * DB's total disk footprint, not to be bit-precise.
 *
 * NOTE: Pass `SOX_DISABLE_QUOTA_HARD=1` env to disable the hard check at runtime
 * (for debug/test scenarios where you intentionally want to exceed hard quota).
 * The NC spec uses this toggle; production code should never set it.
 */
export function checkStoreQuota(
  db: Database.Database,
  config: QuotaConfig = {},
): QuotaCheckResult {
  const softBytes = config.softBytes ?? DEFAULT_SOFT_BYTES;
  const hardBytes = config.hardBytes ?? DEFAULT_HARD_BYTES;
  const warnFn = config.warn ?? ((msg: string, _d: QuotaWarningDetails) => console.warn(msg));

  // Stat the DB file (db.name is the resolved absolute path from better-sqlite3).
  let currentBytes = 0;
  try {
    const st = fs.statSync(db.name, { throwIfNoEntry: false });
    currentBytes = st?.size ?? 0;
  } catch {
    // If we can't stat, treat as 0 — don't block writes due to a stat failure.
    currentBytes = 0;
  }

  // Hard quota check — blocked by SOX_DISABLE_QUOTA_HARD env flag (NC toggle).
  const hardDisabled = process.env['SOX_DISABLE_QUOTA_HARD'] === '1';
  if (!hardDisabled && currentBytes > hardBytes) {
    const refusal: QuotaRefusal = {
      code: 'E_IO',
      message:
        `Store quota exceeded: ${db.name} is ${currentBytes} bytes, ` +
        `hard limit is ${hardBytes} bytes. ` +
        `Free space or increase quota via QuotaConfig.hardBytes.`,
      retryable: false,
      details: {
        quota_bytes: hardBytes,
        current_bytes: currentBytes,
        soft_bytes: softBytes,
      },
    };
    return refusal;
  }

  // Soft quota check — warn but allow the write.
  const softExceeded = currentBytes > softBytes;
  if (softExceeded) {
    const details: QuotaWarningDetails = {
      dbPath: db.name,
      current_bytes: currentBytes,
      soft_bytes: softBytes,
      hard_bytes: hardBytes,
    };
    warnFn(
      `[sox-memory] WARNING: store ${db.name} is ${currentBytes} bytes ` +
        `(soft quota: ${softBytes} bytes). Consider compaction or increasing quotas.`,
      details,
    );
  }

  return { ok: true, current_bytes: currentBytes, soft_exceeded: softExceeded };
}

/**
 * True when the quota check result is a refusal (E_IO).
 */
export function isQuotaRefusal(result: QuotaCheckResult): result is QuotaRefusal {
  return !('ok' in result);
}
