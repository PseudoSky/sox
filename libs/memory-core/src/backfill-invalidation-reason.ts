/**
 * backfill-invalidation-reason.ts — `memory_curate` op
 * `backfill_invalidation_reason` (backlog 503cdc2b).
 *
 * 9171d5cb (f7461993) made every episode invalidation record its cause in
 * `node.meta` through the one shared writer, `invalidateEpisodeInTx`
 * (invalidation-meta.ts). Episodes invalidated BEFORE that commit carry no
 * recorded cause at all. This op gives exactly those rows an explicit,
 * honest "unknown" reason so a later audit can tell "cause never recorded"
 * apart from "cause lost by a new regression".
 *
 * SCOPE PREDICATE (evaluated at scan time AND re-evaluated per row inside the
 * apply transaction, so a second run touches 0 rows):
 *   - kind = 'episode' and the row is invalidated (t_invalid IS NOT NULL);
 *   - no SAME_AS or SUPERSEDES edge touches the row, in EITHER direction,
 *     live or not — an edge of either kind is recorded evidence of its own
 *     (near-dup triage / human supersession) and such rows are left alone;
 *   - `node.meta` carries no top-level key starting with `invalidated`.
 *   Rows whose meta is valid JSON but not an object (the schema's
 *   `json_valid` CHECK rules out malformed JSON) are skipped and counted —
 *   there is nowhere to put a key without inventing a shape.
 *
 * VALUES WRITTEN (top-level `node.meta` keys; every other key preserved):
 *   invalidatedReason              "unknown-legacy: invalidated before 9171d5cb; cause not recorded"
 *   invalidatedVia                 "backfill_503cdc2b"
 *   invalidatedAt                  the row's EXISTING t_invalid (not now)
 *   invalidatedReasonBackfilledAt  now
 * No reason is ever inferred from timing or telemetry. A derived reason would
 * be permitted only from direct evidence in the row's own meta; the one such
 * signal in this store (`meta.restoredFrom`, a pre-9171d5cb restore_neardup
 * reversal) belongs to rows that are members of SAME_AS components by
 * construction, which the edge predicate already excludes — so every in-scope
 * row receives the unknown-legacy reason.
 *
 * WHAT THIS OP NEVER DOES: write the `t_invalid` column. It deliberately does
 * NOT route through `invalidateEpisodeInTx` — that helper rewrites the column
 * and stamps `invalidatedAt` with the current time, which would destroy the
 * one piece of evidence these rows still carry. The only statement this file
 * issues against `node` writes the `meta` column, keyed by uid, and is guarded
 * by `AND t_invalid IS NOT NULL`. `invalidation-always-has-reason.spec.ts`
 * scans this file like every other memory-core source; it is not allowlisted
 * and must not need to be.
 *
 * SAFETY (mirrors restore_neardup):
 *   - `dry_run` DEFAULTS TO TRUE; a caller must pass `dry_run: false`.
 *   - Before any mutation: `checkIntegrity` (the shared classifier — benign
 *     turso#7611 FTS noise is suppressed, real damage aborts), then a verified
 *     `backupStore` VACUUM INTO snapshot. Either failing aborts with zero
 *     mutation. No integrity override and no env toggle (ADR-0013).
 *   - `reverse: true` strips exactly the four keys, and only from rows whose
 *     `invalidatedVia` is still "backfill_503cdc2b". A row whose meta was
 *     NULL before the backfill (so is empty after stripping) is written back
 *     as NULL; a row whose meta was literally `{}` also comes back as NULL.
 */

import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { backupStore, isBackupStoreError } from './backup.js';
import type { BackupStoreError, BackupStoreResult } from './backup.js';
import { resolveBackupConfig } from './config.js';
import { checkIntegrity } from './restore-neardup.js';
import type { IntegrityVerdict } from './restore-neardup.js';
import { log } from './telemetry.js';

// ── Constants ─────────────────────────────────────────────────────────────────

export const BACKFILL_503CDC2B_OP = 'backfill_invalidation_reason' as const;
export const BACKFILL_503CDC2B_VIA = 'backfill_503cdc2b' as const;
export const BACKFILL_503CDC2B_REASON =
  'unknown-legacy: invalidated before 9171d5cb; cause not recorded' as const;

/** The exact keys the apply path adds and the reverse path strips. */
export const BACKFILL_503CDC2B_KEYS = [
  'invalidatedReason',
  'invalidatedVia',
  'invalidatedAt',
  'invalidatedReasonBackfilledAt',
] as const;

const SAMPLE_LIMIT = 20;

// ── Types ─────────────────────────────────────────────────────────────────────

export type BackupFn = (
  srcPath: string,
  destPath: string,
) => Promise<BackupStoreResult | BackupStoreError>;

/**
 * Runtime context the dispatcher threads through. `dbPath` is the store file
 * the adapter was opened on (required to APPLY — the backup snapshots it).
 * `backup` is a dependency-injection seam; production uses `backupStore`.
 */
export interface CurateContext {
  dbPath?: string | null;
  backup?: BackupFn;
}

export interface CurateBackfillInvalidationReasonResult {
  op: typeof BACKFILL_503CDC2B_OP;
  mode: 'apply';
  dry_run: boolean;
  integrity: IntegrityVerdict | null;
  /** In-scope rows found by the scan. */
  candidates: number;
  /** First {@link SAMPLE_LIMIT} candidate uids, sorted. */
  sample_uids: string[];
  /** Invalidated, edge-free episodes whose meta is JSON but not an object. */
  skipped_non_object_meta: number;
  /** Rows actually written (0 on dry run). */
  rows_updated: number;
  /** Candidates that no longer matched the predicate inside the transaction. */
  rows_skipped_on_recheck: number;
  /** Verified VACUUM INTO snapshot taken before mutating; null on dry run. */
  backup_path: string | null;
  note: string;
}

export interface CurateBackfillInvalidationReasonReverseResult {
  op: typeof BACKFILL_503CDC2B_OP;
  mode: 'reverse';
  dry_run: boolean;
  integrity: IntegrityVerdict | null;
  /** Rows currently carrying invalidatedVia == "backfill_503cdc2b". */
  rows_matched: number;
  sample_uids: string[];
  rows_reverted: number;
  backup_path: string | null;
  note: string;
}

export interface BackfillInvalidationReasonError {
  code: string;
  op: typeof BACKFILL_503CDC2B_OP;
  message: string;
}

// ── Predicate helpers ─────────────────────────────────────────────────────────

type MetaParse =
  | { kind: 'object'; value: Record<string, unknown> }
  | { kind: 'empty' }
  | { kind: 'non-object' };

function parseMeta(uid: string, raw: string | null): MetaParse {
  if (raw === null || raw === '') return { kind: 'empty' };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { kind: 'object', value: parsed as Record<string, unknown> };
    }
    return { kind: 'non-object' };
  } catch (err) {
    log.warn('backfill_503cdc2b.meta_parse_failed', {
      uid,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'non-object' };
  }
}

function hasInvalidatedKey(meta: Record<string, unknown>): boolean {
  return Object.keys(meta).some((k) => k.startsWith('invalidated'));
}

/** Invalidated episodes with no SAME_AS / SUPERSEDES edge in either direction. */
const EDGE_FREE_INVALIDATED_EPISODES_SQL = `
  SELECT n.uid AS uid, n.meta AS meta
    FROM node n
   WHERE n.kind = 'episode'
     AND n.t_invalid IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM edge e
        WHERE e.rel IN ('SAME_AS', 'SUPERSEDES')
          AND (e.src = n.rowid OR e.dst = n.rowid)
     )
   ORDER BY n.uid`;

/** The same predicate for ONE uid, used for the in-transaction re-check. */
const ONE_ROW_RECHECK_SQL = `
  SELECT n.t_invalid AS t_invalid, n.meta AS meta
    FROM node n
   WHERE n.uid = ?
     AND n.kind = 'episode'
     AND n.t_invalid IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM edge e
        WHERE e.rel IN ('SAME_AS', 'SUPERSEDES')
          AND (e.src = n.rowid OR e.dst = n.rowid)
     )`;

/** Writes the meta column only. Never the invalidation column. */
const WRITE_META_SQL = `UPDATE node SET meta = ? WHERE uid = ? AND t_invalid IS NOT NULL`;

interface ScanResult {
  candidates: string[];
  skippedNonObject: number;
}

async function scanCandidates(adapter: StoreAdapter): Promise<ScanResult> {
  const { rows } = await adapter.executeAll<{ uid: string; meta: string | null }>(
    EDGE_FREE_INVALIDATED_EPISODES_SQL,
  );
  const candidates: string[] = [];
  let skippedNonObject = 0;
  for (const r of rows) {
    const m = parseMeta(r.uid, r.meta);
    if (m.kind === 'non-object') {
      skippedNonObject += 1;
      continue;
    }
    if (m.kind === 'object' && hasInvalidatedKey(m.value)) continue;
    candidates.push(r.uid);
  }
  return { candidates, skippedNonObject };
}

/** Rows whose meta currently records this backfill as its invalidation writer. */
async function scanBackfilled(adapter: StoreAdapter): Promise<string[]> {
  // LIKE prefilter + JS parse rather than json_extract: a single unexpected
  // meta value must not be able to fail the whole scan.
  const { rows } = await adapter.executeAll<{ uid: string; meta: string | null }>(
    `SELECT uid, meta FROM node WHERE meta LIKE ? ORDER BY uid`,
    [`%${BACKFILL_503CDC2B_VIA}%`],
  );
  const out: string[] = [];
  for (const r of rows) {
    const m = parseMeta(r.uid, r.meta);
    if (m.kind === 'object' && m.value['invalidatedVia'] === BACKFILL_503CDC2B_VIA) out.push(r.uid);
  }
  return out;
}

// ── Safety gates ──────────────────────────────────────────────────────────────

function backupDestFor(mode: 'apply' | 'reverse'): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rnd = Math.random().toString(36).slice(2, 8);
  return path.join(resolveBackupConfig().dir, `backfill-503cdc2b-${mode}-${stamp}-${rnd}.db`);
}

/**
 * Integrity gate, then verified backup. Returns the backup path, or an error
 * that the caller returns verbatim — before any row is touched.
 */
async function gateBeforeMutation(
  adapter: StoreAdapter,
  ctx: CurateContext,
  mode: 'apply' | 'reverse',
): Promise<{ integrity: IntegrityVerdict; backupPath: string } | BackfillInvalidationReasonError> {
  const dbPath = ctx.dbPath ?? null;
  if (dbPath === null || dbPath === '') {
    return {
      code: 'E_BACKUP_UNAVAILABLE',
      op: BACKFILL_503CDC2B_OP,
      message:
        `${mode} requires the store's db path so a verified backup can be taken first; none was ` +
        'supplied by the caller. Refusing to mutate without a backup. dry_run remains available.',
    };
  }

  const integrity = await checkIntegrity(adapter);
  if (!integrity.ok) {
    return {
      code: 'E_INTEGRITY_NOT_OK',
      op: BACKFILL_503CDC2B_OP,
      message:
        `integrity_check reported REAL damage (${integrity.detail ?? 'unknown'}). Documented-benign ` +
        'driver artifacts are already suppressed. Repair the store before running this op; ' +
        'dry_run remains available.',
    };
  }

  const backup = ctx.backup ?? ((src: string, dst: string) => backupStore(src, dst));
  const dest = backupDestFor(mode);
  const result = await backup(dbPath, dest);
  if (isBackupStoreError(result)) {
    return {
      code: 'E_BACKUP_FAILED',
      op: BACKFILL_503CDC2B_OP,
      message: `pre-${mode} backup failed (${result.code}): ${result.message}. No rows were changed.`,
    };
  }
  return { integrity, backupPath: result.destPath };
}

// ── Apply ─────────────────────────────────────────────────────────────────────

const APPLY_NOTE =
  'Writes only node.meta (invalidatedReason / invalidatedVia / invalidatedAt = the row\'s existing ' +
  't_invalid / invalidatedReasonBackfilledAt); the t_invalid column is never written. Scope: ' +
  'invalidated episodes with no SAME_AS or SUPERSEDES edge in either direction (live or not) and ' +
  'no meta key starting "invalidated". dry_run defaults to TRUE; reverse:true strips exactly ' +
  'these keys where invalidatedVia == "backfill_503cdc2b".';

async function applyBackfill(
  adapter: StoreAdapter,
  args: Record<string, unknown>,
  ctx: CurateContext,
): Promise<CurateBackfillInvalidationReasonResult | BackfillInvalidationReasonError> {
  const dryRun = args['dry_run'] !== false;
  const scan = await scanCandidates(adapter);

  if (dryRun) {
    return {
      op: BACKFILL_503CDC2B_OP,
      mode: 'apply',
      dry_run: true,
      integrity: null,
      candidates: scan.candidates.length,
      sample_uids: scan.candidates.slice(0, SAMPLE_LIMIT),
      skipped_non_object_meta: scan.skippedNonObject,
      rows_updated: 0,
      rows_skipped_on_recheck: 0,
      backup_path: null,
      note: APPLY_NOTE,
    };
  }

  if (scan.candidates.length === 0) {
    return {
      op: BACKFILL_503CDC2B_OP,
      mode: 'apply',
      dry_run: false,
      integrity: null,
      candidates: 0,
      sample_uids: [],
      skipped_non_object_meta: scan.skippedNonObject,
      rows_updated: 0,
      rows_skipped_on_recheck: 0,
      backup_path: null,
      note: `${APPLY_NOTE} Nothing in scope — no backup taken, nothing written.`,
    };
  }

  const gate = await gateBeforeMutation(adapter, ctx, 'apply');
  if ('code' in gate) return gate;

  const backfilledAt = new Date().toISOString();
  let updated = 0;
  let skippedOnRecheck = 0;
  await adapter.transaction(async (tx) => {
    for (const uid of scan.candidates) {
      const row = await tx.executeGet<{ t_invalid: string | null; meta: string | null }>(
        ONE_ROW_RECHECK_SQL,
        [uid],
      );
      if (!row || typeof row.t_invalid !== 'string') {
        skippedOnRecheck += 1;
        continue;
      }
      const parsed = parseMeta(uid, row.meta);
      if (parsed.kind === 'non-object') {
        skippedOnRecheck += 1;
        continue;
      }
      const base = parsed.kind === 'object' ? parsed.value : {};
      if (hasInvalidatedKey(base)) {
        skippedOnRecheck += 1;
        continue;
      }
      const next = {
        ...base,
        invalidatedReason: BACKFILL_503CDC2B_REASON,
        invalidatedVia: BACKFILL_503CDC2B_VIA,
        invalidatedAt: row.t_invalid,
        invalidatedReasonBackfilledAt: backfilledAt,
      };
      const res = await tx.executeRun(WRITE_META_SQL, [JSON.stringify(next), uid]);
      if (res.rowsAffected === 1) updated += 1;
      else skippedOnRecheck += 1;
    }
  }, { mode: 'immediate' });

  log.info('backfill_503cdc2b.applied', {
    candidates: scan.candidates.length,
    rows_updated: updated,
    rows_skipped_on_recheck: skippedOnRecheck,
    backup_path: gate.backupPath,
  });

  return {
    op: BACKFILL_503CDC2B_OP,
    mode: 'apply',
    dry_run: false,
    integrity: gate.integrity,
    candidates: scan.candidates.length,
    sample_uids: scan.candidates.slice(0, SAMPLE_LIMIT),
    skipped_non_object_meta: scan.skippedNonObject,
    rows_updated: updated,
    rows_skipped_on_recheck: skippedOnRecheck,
    backup_path: gate.backupPath,
    note: APPLY_NOTE,
  };
}

// ── Reverse ───────────────────────────────────────────────────────────────────

const REVERSE_NOTE =
  'Reverse strips exactly invalidatedReason / invalidatedVia / invalidatedAt / ' +
  'invalidatedReasonBackfilledAt, and only from rows whose invalidatedVia is still ' +
  '"backfill_503cdc2b". A row left with an empty meta object is written back as NULL (the ' +
  'legacy rows this op targets had NULL or object meta). t_invalid is never written.';

async function reverseBackfill(
  adapter: StoreAdapter,
  args: Record<string, unknown>,
  ctx: CurateContext,
): Promise<CurateBackfillInvalidationReasonReverseResult | BackfillInvalidationReasonError> {
  const dryRun = args['dry_run'] !== false;
  const matched = await scanBackfilled(adapter);

  if (dryRun || matched.length === 0) {
    return {
      op: BACKFILL_503CDC2B_OP,
      mode: 'reverse',
      dry_run: dryRun,
      integrity: null,
      rows_matched: matched.length,
      sample_uids: matched.slice(0, SAMPLE_LIMIT),
      rows_reverted: 0,
      backup_path: null,
      note: matched.length === 0 && !dryRun
        ? `${REVERSE_NOTE} Nothing to reverse — no backup taken, nothing written.`
        : REVERSE_NOTE,
    };
  }

  const gate = await gateBeforeMutation(adapter, ctx, 'reverse');
  if ('code' in gate) return gate;

  let reverted = 0;
  await adapter.transaction(async (tx) => {
    for (const uid of matched) {
      const row = await tx.executeGet<{ meta: string | null }>(
        `SELECT meta FROM node WHERE uid = ?`,
        [uid],
      );
      if (!row) continue;
      const parsed = parseMeta(uid, row.meta);
      if (parsed.kind !== 'object' || parsed.value['invalidatedVia'] !== BACKFILL_503CDC2B_VIA) continue;
      const next: Record<string, unknown> = { ...parsed.value };
      for (const k of BACKFILL_503CDC2B_KEYS) delete next[k];
      const nextMeta = Object.keys(next).length === 0 ? null : JSON.stringify(next);
      const res = await tx.executeRun(WRITE_META_SQL, [nextMeta, uid]);
      if (res.rowsAffected === 1) reverted += 1;
    }
  }, { mode: 'immediate' });

  log.info('backfill_503cdc2b.reversed', {
    rows_matched: matched.length,
    rows_reverted: reverted,
    backup_path: gate.backupPath,
  });

  return {
    op: BACKFILL_503CDC2B_OP,
    mode: 'reverse',
    dry_run: false,
    integrity: gate.integrity,
    rows_matched: matched.length,
    sample_uids: matched.slice(0, SAMPLE_LIMIT),
    rows_reverted: reverted,
    backup_path: gate.backupPath,
    note: REVERSE_NOTE,
  };
}

// ── The op ────────────────────────────────────────────────────────────────────

export async function curateBackfillInvalidationReason(
  adapter: StoreAdapter,
  args: Record<string, unknown>,
  ctx: CurateContext = {},
): Promise<
  | CurateBackfillInvalidationReasonResult
  | CurateBackfillInvalidationReasonReverseResult
  | BackfillInvalidationReasonError
> {
  if (args['reverse'] === true) return await reverseBackfill(adapter, args, ctx);
  return await applyBackfill(adapter, args, ctx);
}
