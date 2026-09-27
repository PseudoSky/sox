/**
 * store-rebuild — OFFLINE compaction (`memory fts-rebuild`) and its restore
 * path (`memory restore`). BL-c5249cdd.
 *
 * WHY: measured on `@tursodatabase/database` 0.7.1 and 0.7.2, every interleaved
 * insert + `OPTIMIZE INDEX` round leaves the merged-away FTS segments behind as
 * orphaned pages. `page_count` grows with the number of in-service optimize
 * passes; `freelist_count` stays ~0, so nothing ever reuses them. On a copy of
 * production: 436.1 MB, of which the FTS directory btree was 292.8 MB with
 * 7,273 orphan segments (216.9 MB).
 *
 * WHAT RECLAIMS IT: `VACUUM INTO` — and only that. `DROP INDEX` on the FTS
 * index ORPHANS its directory btree (page_count unchanged, 1 page freed), so
 * this module never drops anything. Plain in-place `VACUUM` is refused under
 * multiprocess WAL. `VACUUM INTO` alone compacted the production copy to
 * 160.3 MB in 5.8 s with identical node/edge/vec_node counts, identical
 * `fts_match` hit counts, and an `integrity_check` carrying only the known
 * Tantivy false positive.
 *
 * SEQUENCE (`rebuildStoreOffline`):
 *   1. Exclusivity: `TursoAdapterImpl.openOfflineExclusive` — the SAME gate as
 *      `memory fts-optimize` (lease peers, then the `.openers` registry that
 *      sees an idle-released service, re-checked after open). The source is
 *      opened `readonly + allowFtsInReadonly`, so its bytes are never written:
 *      no engine stamp, no clean-shutdown marker, no open-time repair.
 *   2. Capture the source's facts: per-table row counts, FTS sentinel tokens
 *      taken from real rows and their hit counts, page stats.
 *   3. `VACUUM INTO <db>.rebuild-<ts>` (the adapter's own `backupTo`).
 *   4. Reset the growth counter IN THE COPY (`fts_optimize_passes_since_rebuild
 *      = 0`, `last_rebuild_at`) through a raw driver handle — a writable
 *      adapter open would run open-time verify+repair, and that repair's
 *      `DROP INDEX` is exactly the operation that orphans pages. The copy is
 *      checkpointed (TRUNCATE) before its handle closes.
 *   5. Verify the copy read-only — the bytes verified are the bytes swapped in:
 *      table set and row counts equal, every sentinel's hit count equal,
 *      `integrity_check` with no damage (the documented false positive and
 *      page-accounting noise classified, never ignored), counter reads 0.
 *   6. `--dry-run` stops here and deletes the copy.
 *   7. Swap: source `-wal` must be empty; the source is HARD-LINKED to
 *      `<db>.pre-rebuild-<ts>` (the byte-exact backup — same inode, zero copy
 *      cost); the cold-open lock is taken (refuse if it cannot be); openers are
 *      re-checked; the copy is `rename(2)`d over `<db>` — one atomic step, so
 *      there is never an instant with no file at `<db>` for a cold open to
 *      mint an empty store into. `<db>.sox-lease.d/` is never touched.
 *
 * WHY THE BACKUP IS A HARD LINK, NOT `backupStore`: `backupStore` is itself a
 * `VACUUM INTO`, so its output is already compacted — it cannot give back the
 * pre-rebuild bytes. The hard link of the checkpointed source is the exact
 * pre-swap file, and after the rename it is the only name the old inode has.
 *
 * `restoreStoreOffline` is the same move in reverse: clone the backup to a
 * temp file, verify the clone against the backup read-only, hard-link the
 * current store to `<db>.pre-restore-<ts>`, rename the clone over `<db>`.
 */
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  linkSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { log } from '@adhd/sox-telemetry';
import {
  ADAPTER_META_CREATE_SQL,
  readStoreGrowthMeta,
  STORE_GROWTH_META_KEYS,
  STORE_GROWTH_META_UPSERT_SQL,
} from './adapter-meta.js';
import { acquireColdOpenLock } from './cold-open-lock.js';
import { classifyIntegrityMessages, parseFtsColumns, pickSentinelTokens } from './integrity.js';
import { canonicalDbPath } from './path-identity.js';
import { storeOpeners, storeQuiescence } from './store-lease.js';
import { TursoAdapterImpl } from './turso-adapter.js';
import type { StoreAdapter } from './types.js';

/**
 * The `@tursodatabase/database` version the FTS segment leak — and therefore
 * this module and `memory_ping`'s growth gauge — was measured against (also
 * reproduced on 0.7.2, 2026-09-27). Not a dependency pin: the upgrade-gate test
 * (`fts-optimize-leak-gate.bl-c5249cdd.spec.ts`) reads the INSTALLED driver and
 * fails when it moves off this version, forcing a re-measurement.
 */
export const FTS_OPTIMIZE_LEAK_MEASURED_ON = '0.7.1';

// ── Page stats ────────────────────────────────────────────────────────────────

/** Physical size of a store. `page_count × page_size === file_bytes` holds
 *  while the WAL is empty (a checkpointed, closed store). */
export interface StorePageStats {
  file_bytes: number;
  wal_bytes: number;
  page_count: number;
  page_size: number;
  freelist_count: number;
}

/** Size of `path` in bytes, `null` when it does not exist. Any other stat
 *  failure is logged and also reads as `null`. */
export function fileSizeOrNull(path: string): number | null {
  try {
    return statSync(path).size;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOENT') {
      log.warn('store_adapter.rebuild.stat_failed', {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }
}

async function pragmaNumber(adapter: StoreAdapter, pragma: string): Promise<number> {
  const row = await adapter.executeGet<Record<string, unknown>>(`PRAGMA ${pragma}`);
  const v = row ? Object.values(row)[0] : null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`PRAGMA ${pragma} returned a non-numeric value: ${String(v)}`);
  return n;
}

/** Read the page stats of an open store (`dbPath` is the file it has open). */
export async function readStorePageStats(adapter: StoreAdapter, dbPath: string): Promise<StorePageStats> {
  return {
    file_bytes: fileSizeOrNull(dbPath) ?? 0,
    wal_bytes: fileSizeOrNull(`${dbPath}-wal`) ?? 0,
    page_count: await pragmaNumber(adapter, 'page_count'),
    page_size: await pragmaNumber(adapter, 'page_size'),
    freelist_count: await pragmaNumber(adapter, 'freelist_count'),
  };
}

// ── Store facts (what a replacement must preserve) ───────────────────────────

/** One FTS round-trip probe: a whole-word token taken from a real row. */
export interface FtsSentinel {
  index: string;
  table: string;
  columns: string[];
  token: string;
  hits: number;
}

interface StoreFacts {
  tableCounts: Map<string, number>;
  sentinels: FtsSentinel[];
}

const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;

/** User tables: the Turso-internal FTS backing tables are exactly what a
 *  rebuild is meant to shrink, and `sqlite_*` are engine bookkeeping. */
async function listUserTables(adapter: StoreAdapter): Promise<string[]> {
  const { rows } = await adapter.executeAll<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  return rows.map((r) => r.name).filter((n) => !n.startsWith('sqlite_') && !n.startsWith('__turso_internal'));
}

async function countRows(adapter: StoreAdapter, table: string): Promise<number> {
  const row = await adapter.executeGet<{ n: number }>(`SELECT COUNT(*) AS n FROM ${q(table)}`);
  return Number(row?.n ?? 0);
}

async function countFtsHits(adapter: StoreAdapter, s: Pick<FtsSentinel, 'table' | 'columns' | 'token'>): Promise<number> {
  const cols = s.columns.map(q).join(', ');
  const row = await adapter.executeGet<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${q(s.table)} WHERE fts_match(${cols}, ?)`,
    [s.token],
  );
  return Number(row?.n ?? 0);
}

/**
 * Sentinel tokens for every `USING fts` index: one whole-word token from each
 * of the first, middle and last rows (the prefix/suffix damage classes the
 * integrity probe samples for the same reason), deduplicated, with the hit
 * count each returns on THIS store. The replacement must return the same
 * counts.
 */
async function captureFtsSentinels(adapter: StoreAdapter): Promise<FtsSentinel[]> {
  const { rows: indexes } = await adapter.executeAll<{ name: string; tbl_name: string; sql: string | null }>(
    "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql LIKE '%USING fts%' ORDER BY name",
  );
  const out: FtsSentinel[] = [];
  for (const ix of indexes) {
    const columns = parseFtsColumns(ix.sql);
    if (columns.length === 0) continue;
    const table = ix.tbl_name;
    const total = await countRows(adapter, table);
    if (total === 0) continue;
    const select = `SELECT ${columns.map(q).join(', ')} FROM ${q(table)} ORDER BY rowid`;
    const offsets = [...new Set([0, Math.floor(total / 2), total - 1])];
    const seen = new Set<string>();
    for (const offset of offsets) {
      const row = await adapter.executeGet<Record<string, unknown>>(`${select} LIMIT 1 OFFSET ?`, [offset]);
      if (!row) continue;
      const text = columns.map((c) => (typeof row[c] === 'string' ? (row[c] as string) : '')).join(' ');
      const token = pickSentinelTokens(text, 1)[0];
      if (token === undefined || seen.has(token.toLowerCase())) continue;
      seen.add(token.toLowerCase());
      const probe = { index: ix.name, table, columns, token };
      out.push({ ...probe, hits: await countFtsHits(adapter, probe) });
    }
  }
  return out;
}

async function captureFacts(adapter: StoreAdapter): Promise<StoreFacts> {
  const tableCounts = new Map<string, number>();
  for (const t of await listUserTables(adapter)) tableCounts.set(t, await countRows(adapter, t));
  return { tableCounts, sentinels: await captureFtsSentinels(adapter) };
}

// ── Verification ─────────────────────────────────────────────────────────────

export interface StoreReplacementVerification {
  /** True only when every check below passed. */
  ok: boolean;
  table_counts: Array<{ table: string; source: number | null; replacement: number | null; ok: boolean }>;
  fts_round_trip: Array<{ index: string; token: string; source_hits: number; replacement_hits: number; ok: boolean }>;
  integrity: {
    ok: boolean;
    damage: string[];
    /** Documented Turso false positives (`isKnownFalsePositive`) — reported, not damage. */
    known_false_positives: number;
    /** `Page N: …` reclaimable-space noise — reported, not damage. */
    page_accounting: number;
    truncated: boolean;
  };
  /** Rebuild only: the copy's growth counter reads 0 and `last_rebuild_at` is set. */
  growth_meta_reset: boolean | null;
  failures: string[];
}

/** Tables whose content a rebuild is allowed to change (the growth keys it
 *  stamps). Every other table must match row-for-row. */
const REBUILD_MUTABLE_TABLES = new Set(['_adapter_meta']);

async function verifyReplacement(
  replacementPath: string,
  facts: StoreFacts,
  opts: { expectGrowthReset: boolean },
): Promise<{ verification: StoreReplacementVerification; stats: StorePageStats }> {
  const failures: string[] = [];
  const adapter = await TursoAdapterImpl.connect({
    dbPath: replacementPath,
    readonly: true,
    allowFtsInReadonly: true,
    idleFlushMs: 3_600_000,
  });
  try {
    const stats = await readStorePageStats(adapter, replacementPath);

    const replacementTables = await listUserTables(adapter);
    const names = [...new Set([...facts.tableCounts.keys(), ...replacementTables])].sort();
    const table_counts: StoreReplacementVerification['table_counts'] = [];
    for (const table of names) {
      const source = facts.tableCounts.get(table) ?? null;
      const replacement = replacementTables.includes(table) ? await countRows(adapter, table) : null;
      const mutable = opts.expectGrowthReset && REBUILD_MUTABLE_TABLES.has(table);
      const ok = source !== null && replacement !== null && (mutable || source === replacement);
      if (!ok) failures.push(`table ${table}: source=${source ?? 'absent'} replacement=${replacement ?? 'absent'}`);
      table_counts.push({ table, source, replacement, ok });
    }

    const fts_round_trip: StoreReplacementVerification['fts_round_trip'] = [];
    for (const s of facts.sentinels) {
      const replacement_hits = await countFtsHits(adapter, s);
      const ok = replacement_hits === s.hits;
      if (!ok) failures.push(`fts ${s.index} '${s.token}': source=${s.hits} replacement=${replacement_hits}`);
      fts_round_trip.push({ index: s.index, token: s.token, source_hits: s.hits, replacement_hits, ok });
    }

    const raw = await adapter.executeAll<Record<string, unknown>>('PRAGMA integrity_check');
    const messages = raw.rows
      .flatMap((r) => Object.values(r))
      .filter((v): v is string => typeof v === 'string' && v.trim().toLowerCase() !== 'ok');
    const cls = classifyIntegrityMessages(messages);
    const integrityOk = cls.damage.length === 0 && !cls.truncated;
    if (!integrityOk) {
      failures.push(
        `integrity_check: ${cls.damage.length} damage message(s)${cls.truncated ? ', output truncated at the cap' : ''}` +
          (cls.damage.length > 0 ? ` — ${cls.damage.slice(0, 3).join(' | ')}` : ''),
      );
    }

    let growth_meta_reset: boolean | null = null;
    if (opts.expectGrowthReset) {
      const meta = await readStoreGrowthMeta(adapter);
      growth_meta_reset = meta.ftsOptimizePassesSinceRebuild === 0 && meta.lastRebuildAt !== null;
      if (!growth_meta_reset) {
        failures.push(
          `growth meta not reset: passes=${String(meta.ftsOptimizePassesSinceRebuild)} last_rebuild_at=${String(meta.lastRebuildAt)}`,
        );
      }
    }

    return {
      stats,
      verification: {
        ok: failures.length === 0,
        table_counts,
        fts_round_trip,
        integrity: {
          ok: integrityOk,
          damage: cls.damage,
          known_false_positives: cls.knownFalsePositives.length,
          page_accounting: cls.pageAccounting.length,
          truncated: cls.truncated,
        },
        growth_meta_reset,
        failures,
      },
    };
  } finally {
    await adapter.close();
  }
}

// ── Raw-handle growth reset (never a writable adapter open — see header) ─────

interface RawStatement {
  run(...args: unknown[]): unknown;
}
interface RawDb {
  exec(sql: string): Promise<unknown>;
  prepare(sql: string): RawStatement | Promise<RawStatement>;
  close(): Promise<unknown> | unknown;
}

async function stampRebuildMeta(path: string, rebuiltAt: string): Promise<void> {
  const mod = (await import('@tursodatabase/database')) as unknown as {
    connect(p: string, o: Record<string, unknown>): Promise<RawDb>;
  };
  // Same experiments every adapter open uses (index_method for the FTS index
  // the copy carries, multiprocess_wal for the WAL format the store runs under).
  const db = await mod.connect(path, { timeout: 5000, experimental: ['index_method', 'multiprocess_wal'] });
  try {
    await db.exec(ADAPTER_META_CREATE_SQL);
    const upsert = await db.prepare(STORE_GROWTH_META_UPSERT_SQL);
    await upsert.run(STORE_GROWTH_META_KEYS.FTS_OPTIMIZE_PASSES_SINCE_REBUILD, '0');
    await upsert.run(STORE_GROWTH_META_KEYS.LAST_REBUILD_AT, rebuiltAt);
    // Everything committed must be IN the file that gets renamed — a copy
    // whose data sits in its own -wal would swap in without it.
    await db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    await db.close();
  }
  // The raw handle leaves its `-tshm` behind. Beside an empty WAL it indexes
  // nothing, and this file is private to the rebuild — remove it rather than
  // let the verification open "reconcile" it and emit a repair event for a
  // store nobody else has ever seen.
  const wal = fileSizeOrNull(`${path}-wal`);
  if (wal === null || wal === 0) {
    rmSync(`${path}-tshm`, { force: true });
  } else {
    throw new Error(`${path}-wal still holds ${wal} bytes after wal_checkpoint(TRUNCATE)`);
  }
}

// ── Filesystem helpers ───────────────────────────────────────────────────────

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:.]/g, '');
}

/**
 * Remove the orphaned sidecars a (now renamed-away or deleted) file left:
 * `-wal` (only when empty — a non-empty one is data and is left, loudly),
 * `-tshm`, `-tshm.stale-*`, `.sidecar-sweep-marker`, and its `.sox-lease.d/`.
 * Never called for the live store path — its lease dir is never deleted.
 */
function removeFileArtifacts(path: string, event: string): void {
  const rm = (p: string, recursive = false): void => {
    try {
      rmSync(p, { force: true, recursive });
    } catch (err) {
      log.warn(event, { path: p, error: err instanceof Error ? err.message : String(err) });
    }
  };
  const wal = fileSizeOrNull(`${path}-wal`);
  if (wal !== null) {
    if (wal === 0) rm(`${path}-wal`);
    else log.warn(event, { path: `${path}-wal`, reason: `non-empty WAL (${wal} bytes) left in place` });
  }
  rm(`${path}-tshm`);
  rm(`${path}.sidecar-sweep-marker`);
  rm(`${path}.sox-lease.d`, true);
  const dir = dirname(path);
  const prefix = `${basename(path)}-tshm.stale-`;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch (err) {
    log.warn(event, { path: dir, error: err instanceof Error ? err.message : String(err) });
  }
  for (const n of names) if (n.startsWith(prefix)) rm(join(dir, n));
}

function removeFileAndArtifacts(path: string, event: string): void {
  try {
    rmSync(path, { force: true });
  } catch (err) {
    log.warn(event, { path, error: err instanceof Error ? err.message : String(err) });
  }
  removeFileArtifacts(path, event);
}

type SwapResult =
  | { ok: true; backup_path: string | null }
  | { ok: false; reason: 'sidecars_dirty' | 'cold_open_lock' | 'peers' | 'openers'; pids: number[]; detail: string };

/**
 * Atomically replace `canonical` with `replacement`. The current file (if any)
 * is hard-linked to `backupPath` first; on any refusal the link is removed and
 * `canonical` is untouched.
 */
async function swapIntoPlace(canonical: string, replacement: string, backupPath: string, event: string): Promise<SwapResult> {
  const refuse = (reason: 'sidecars_dirty' | 'cold_open_lock' | 'peers' | 'openers', pids: number[], detail: string): SwapResult => {
    log.warn(`${event}.swap_refused`, { db_path: canonical, reason, pids: pids.join(','), detail });
    return { ok: false, reason, pids, detail };
  };
  const srcWal = fileSizeOrNull(`${canonical}-wal`);
  if (srcWal !== null && srcWal > 0) {
    return refuse('sidecars_dirty', [], `${canonical}-wal holds ${srcWal} bytes — the store was not checkpointed; its frames would be replayed onto the replacement`);
  }
  const repWal = fileSizeOrNull(`${replacement}-wal`);
  if (repWal !== null && repWal > 0) {
    return refuse('sidecars_dirty', [], `${replacement}-wal holds ${repWal} bytes — committed data not in the file being swapped in`);
  }
  // A -tshm beside an EMPTY -wal indexes nothing; move it aside exactly as the
  // adapter's own close()-TRUNCATE does (renamed, never deleted).
  if (existsSync(`${canonical}-tshm`)) {
    const to = `${canonical}-tshm.stale-${stamp(new Date())}`;
    renameSync(`${canonical}-tshm`, to);
    log.info(`${event}.tshm_moved_aside`, { db_path: canonical, to });
  }

  const hadCurrent = existsSync(canonical);
  if (hadCurrent) linkSync(canonical, backupPath);
  const unlinkBackup = (): void => {
    if (!hadCurrent) return;
    try {
      unlinkSync(backupPath);
    } catch (err) {
      log.warn(`${event}.backup_unlink_failed`, { path: backupPath, error: err instanceof Error ? err.message : String(err) });
    }
  };

  // The cold-open lock serialises every cross-process open of this store. A
  // normal open proceeds WITHOUT it on timeout; a destructive swap must not.
  const lock = await acquireColdOpenLock(canonical, { maxWaitMs: 10_000 });
  if (!lock.acquired) {
    unlinkBackup();
    return refuse('cold_open_lock', [], 'could not take the cold-open lock — another process is opening the store');
  }
  try {
    const qn = storeQuiescence(canonical);
    if (!qn.quiescent) {
      unlinkBackup();
      return refuse('peers', qn.livePeers.map((p) => p.pid), 'a store peer appeared after the rebuild began');
    }
    const op = storeOpeners(canonical);
    if (op.livePids.length > 0 || op.unknown) {
      unlinkBackup();
      return refuse('openers', op.livePids, 'a process opened the store after the rebuild began');
    }
    renameSync(replacement, canonical);
  } finally {
    lock.release();
  }
  return { ok: true, backup_path: hadCurrent ? backupPath : null };
}

// ── Rebuild ──────────────────────────────────────────────────────────────────

export interface StoreRebuildOptions {
  /** Stop after the verified copy exists; delete it; never swap. */
  dryRun?: boolean;
  /** Clock seam for tests (backup/rebuild names, `last_rebuild_at`). */
  now?: () => Date;
}

export interface StoreRebuildReport {
  status: 'rebuilt' | 'dry_run' | 'refused' | 'failed';
  reason?:
    | 'not_found'
    | 'peers'
    | 'openers'
    | 'no_lease'
    | 'open_failed'
    | 'cold_open_lock'
    | 'sidecars_dirty'
    | 'verification_failed'
    | 'error';
  db_path: string;
  peer_pids?: number[];
  /** The verified copy. Deleted on dry-run; kept on verification failure for forensics. */
  rebuild_path?: string;
  /** The byte-exact pre-swap store (hard link). Present only when `rebuilt`. */
  backup_path?: string;
  before?: StorePageStats;
  after?: StorePageStats;
  verification?: StoreReplacementVerification;
  duration_ms: number;
  error?: string;
}

/**
 * OFFLINE rebuild of a Turso store by `VACUUM INTO` + verified atomic swap.
 * Never throws for an expected outcome — refusals and failures are reported.
 */
export async function rebuildStoreOffline(dbPath: string, opts: StoreRebuildOptions = {}): Promise<StoreRebuildReport> {
  const started = Date.now();
  const now = opts.now ?? (() => new Date());
  const done = (r: Omit<StoreRebuildReport, 'duration_ms'>): StoreRebuildReport => {
    const report = { ...r, duration_ms: Date.now() - started };
    const level = report.status === 'failed' ? 'error' : report.status === 'refused' ? 'warn' : 'info';
    log[level]('store.rebuild.finish', {
      db_path: report.db_path,
      status: report.status,
      reason: report.reason ?? null,
      before_bytes: report.before?.file_bytes ?? null,
      after_bytes: report.after?.file_bytes ?? null,
      before_pages: report.before?.page_count ?? null,
      after_pages: report.after?.page_count ?? null,
      duration_ms: report.duration_ms,
      error: report.error ?? null,
    });
    return report;
  };
  if (!existsSync(dbPath)) {
    return done({ status: 'failed', reason: 'not_found', db_path: dbPath, error: `db not found: ${dbPath}` });
  }

  const gate = await TursoAdapterImpl.openOfflineExclusive(dbPath, { event: 'store.rebuild', readonly: true });
  const canonical = gate.canonical;
  if (!gate.ok) {
    if (gate.reason === 'open_failed') {
      return done({ status: 'failed', reason: 'open_failed', db_path: canonical, error: gate.error });
    }
    return done({ status: 'refused', reason: gate.reason, db_path: canonical, peer_pids: gate.pids });
  }

  const ts = now();
  const rebuildPath = `${canonical}.rebuild-${stamp(ts)}`;
  const backupPath = `${canonical}.pre-rebuild-${stamp(ts)}`;
  let before: StorePageStats;
  let facts: StoreFacts;
  try {
    if (existsSync(rebuildPath) || existsSync(backupPath)) {
      return done({ status: 'failed', reason: 'error', db_path: canonical, error: `${rebuildPath} or ${backupPath} already exists` });
    }
    log.info('store.rebuild.start', { db_path: canonical, rebuild_path: rebuildPath, dry_run: opts.dryRun === true });
    before = await readStorePageStats(gate.adapter, canonical);
    facts = await captureFacts(gate.adapter);
    await gate.adapter.backupTo(rebuildPath, { skipIntegrityCheck: true });
  } catch (err) {
    removeFileAndArtifacts(rebuildPath, 'store.rebuild.cleanup_failed');
    return done({ status: 'failed', reason: 'error', db_path: canonical, error: err instanceof Error ? err.message : String(err) });
  } finally {
    try {
      await gate.adapter.close();
    } catch (err) {
      log.error('store.rebuild.close_failed', { db_path: canonical, error: err instanceof Error ? err.message : String(err) });
    }
  }

  let after: StorePageStats;
  let verification: StoreReplacementVerification;
  try {
    await stampRebuildMeta(rebuildPath, ts.toISOString());
    ({ stats: after, verification } = await verifyReplacement(rebuildPath, facts, { expectGrowthReset: true }));
  } catch (err) {
    removeFileAndArtifacts(rebuildPath, 'store.rebuild.cleanup_failed');
    return done({ status: 'failed', reason: 'error', db_path: canonical, before, error: err instanceof Error ? err.message : String(err) });
  }
  removeFileArtifacts(rebuildPath, 'store.rebuild.cleanup_failed');
  if (!verification.ok) {
    return done({
      status: 'failed',
      reason: 'verification_failed',
      db_path: canonical,
      rebuild_path: rebuildPath,
      before,
      after,
      verification,
      error: verification.failures.join('; '),
    });
  }
  if (opts.dryRun === true) {
    removeFileAndArtifacts(rebuildPath, 'store.rebuild.cleanup_failed');
    return done({ status: 'dry_run', db_path: canonical, rebuild_path: rebuildPath, before, after, verification });
  }

  let swap: SwapResult;
  try {
    swap = await swapIntoPlace(canonical, rebuildPath, backupPath, 'store.rebuild');
  } catch (err) {
    return done({
      status: 'failed',
      reason: 'error',
      db_path: canonical,
      rebuild_path: rebuildPath,
      before,
      after,
      verification,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (!swap.ok) {
    removeFileAndArtifacts(rebuildPath, 'store.rebuild.cleanup_failed');
    const refused = swap.reason === 'peers' || swap.reason === 'openers' || swap.reason === 'cold_open_lock';
    return done({
      status: refused ? 'refused' : 'failed',
      reason: swap.reason,
      db_path: canonical,
      peer_pids: swap.pids,
      before,
      after,
      verification,
      error: swap.detail,
    });
  }
  return done({
    status: 'rebuilt',
    db_path: canonical,
    rebuild_path: rebuildPath,
    ...(swap.backup_path !== null ? { backup_path: swap.backup_path } : {}),
    before,
    after: { ...after, file_bytes: fileSizeOrNull(canonical) ?? after.file_bytes, wal_bytes: fileSizeOrNull(`${canonical}-wal`) ?? 0 },
    verification,
  });
}

// ── Restore ──────────────────────────────────────────────────────────────────

export interface StoreRestoreOptions {
  /** Verify the clone, delete it, never swap. */
  dryRun?: boolean;
  now?: () => Date;
}

export interface StoreRestoreReport {
  status: 'restored' | 'dry_run' | 'refused' | 'failed';
  reason?: 'not_found' | 'backup_wal_not_empty' | 'peers' | 'openers' | 'cold_open_lock' | 'sidecars_dirty' | 'verification_failed' | 'error';
  db_path: string;
  backup_path: string;
  peer_pids?: number[];
  /** Where the store that was replaced now lives (hard link). Absent when there was none. */
  replaced_path?: string;
  restored?: StorePageStats;
  verification?: StoreReplacementVerification;
  duration_ms: number;
  error?: string;
}

/**
 * OFFLINE restore of a single-file backup (a `memory fts-rebuild`
 * `.pre-rebuild-*` file, or any closed, checkpointed Turso store file) over
 * `dbPath`. Refuses while the target has live peers or openers. The backup
 * itself is never modified or consumed — it is cloned.
 */
export async function restoreStoreOffline(
  backupPath: string,
  dbPath: string,
  opts: StoreRestoreOptions = {},
): Promise<StoreRestoreReport> {
  const started = Date.now();
  const now = opts.now ?? (() => new Date());
  const canonical = canonicalDbPath(dbPath);
  const backup = canonicalDbPath(backupPath);
  const done = (r: Omit<StoreRestoreReport, 'duration_ms' | 'db_path' | 'backup_path'>): StoreRestoreReport => {
    const report = { ...r, db_path: canonical, backup_path: backup, duration_ms: Date.now() - started };
    const level = report.status === 'failed' ? 'error' : report.status === 'refused' ? 'warn' : 'info';
    log[level]('store.restore.finish', {
      db_path: canonical,
      backup_path: backup,
      status: report.status,
      reason: report.reason ?? null,
      duration_ms: report.duration_ms,
      error: report.error ?? null,
    });
    return report;
  };
  if (!existsSync(backup)) return done({ status: 'failed', reason: 'not_found', error: `backup not found: ${backup}` });
  const backupWal = fileSizeOrNull(`${backup}-wal`);
  if (backupWal !== null && backupWal > 0) {
    return done({
      status: 'refused',
      reason: 'backup_wal_not_empty',
      error: `${backup}-wal holds ${backupWal} bytes — the backup is not a closed, checkpointed store file`,
    });
  }
  const pre = storeQuiescence(canonical);
  if (!pre.quiescent) return done({ status: 'refused', reason: 'peers', peer_pids: pre.livePeers.map((p) => p.pid) });
  const preOpeners = storeOpeners(canonical);
  if (preOpeners.livePids.length > 0 || preOpeners.unknown) {
    return done({ status: 'refused', reason: 'openers', peer_pids: preOpeners.livePids });
  }

  const ts = now();
  const clone = `${canonical}.restore-${stamp(ts)}`;
  const replacedPath = `${canonical}.pre-restore-${stamp(ts)}`;
  let restored: StorePageStats;
  let verification: StoreReplacementVerification;
  try {
    if (existsSync(clone) || existsSync(replacedPath)) throw new Error(`${clone} or ${replacedPath} already exists`);
    // Facts from the backup itself, read-only (measured: a soft-readonly open
    // leaves the file's bytes unchanged), so the clone is checked against it.
    const src = await TursoAdapterImpl.connect({ dbPath: backup, readonly: true, allowFtsInReadonly: true, idleFlushMs: 3_600_000 });
    let facts: StoreFacts;
    try {
      facts = await captureFacts(src);
    } finally {
      await src.close();
      // The read-only open left a lease dir / sweep marker beside the backup.
      removeFileArtifacts(backup, 'store.restore.cleanup_failed');
    }
    copyFileSync(backup, clone, fsConstants.COPYFILE_FICLONE);
    ({ stats: restored, verification } = await verifyReplacement(clone, facts, { expectGrowthReset: false }));
  } catch (err) {
    removeFileAndArtifacts(clone, 'store.restore.cleanup_failed');
    return done({ status: 'failed', reason: 'error', error: err instanceof Error ? err.message : String(err) });
  }
  removeFileArtifacts(clone, 'store.restore.cleanup_failed');
  if (!verification.ok) {
    removeFileAndArtifacts(clone, 'store.restore.cleanup_failed');
    return done({ status: 'failed', reason: 'verification_failed', restored, verification, error: verification.failures.join('; ') });
  }
  if (opts.dryRun === true) {
    removeFileAndArtifacts(clone, 'store.restore.cleanup_failed');
    return done({ status: 'dry_run', restored, verification });
  }
  let swap: SwapResult;
  try {
    swap = await swapIntoPlace(canonical, clone, replacedPath, 'store.restore');
  } catch (err) {
    removeFileAndArtifacts(clone, 'store.restore.cleanup_failed');
    return done({ status: 'failed', reason: 'error', restored, verification, error: err instanceof Error ? err.message : String(err) });
  }
  if (!swap.ok) {
    removeFileAndArtifacts(clone, 'store.restore.cleanup_failed');
    const refused = swap.reason === 'peers' || swap.reason === 'openers' || swap.reason === 'cold_open_lock';
    return done({ status: refused ? 'refused' : 'failed', reason: swap.reason, peer_pids: swap.pids, restored, verification, error: swap.detail });
  }
  return done({
    status: 'restored',
    ...(swap.backup_path !== null ? { replaced_path: swap.backup_path } : {}),
    restored,
    verification,
  });
}
