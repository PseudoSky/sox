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
 *      no engine stamp, no clean-shutdown marker, no open-time repair. That
 *      soft-readonly open is a native-WRITABLE handle (BL-391 — the price of
 *      `fts_match`), so it creates and its close leaves a `-tshm` sidecar
 *      (BL-1010e417 skips the reconcile when nothing was truncated); every
 *      run — `--dry-run` included — removes exactly the artifacts this open
 *      created (BUG-2e232ee9), so a store the run must not touch is left
 *      exactly as it was found.
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
 *   7. Swap (`swapIntoPlace`): the cold-open lock is taken (refuse if it
 *      cannot be); peers and openers are re-checked; only THEN are the
 *      sidecars inspected (source `-wal` must be empty) and a stale `-tshm`
 *      moved aside (BL-2c65c6a5); the source's file identity (dev, ino, size,
 *      mtime ns — recorded under the gate before step 2) must be unchanged,
 *      else `refused`/`source_changed` with the verified copy kept
 *      (BL-e92196e2); the source is HARD-LINKED to `<db>.pre-rebuild-<ts>`
 *      (the byte-exact backup — same inode, zero copy cost); the copy is
 *      `rename(2)`d over `<db>` — one atomic step, so there is never an instant
 *      with no file at `<db>` for a cold open to mint an empty store into.
 *      `<db>.sox-lease.d/` is never touched.
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
import { SOX_ENGINE_TABLE } from './engine-guard.js';
import { classifyIntegrityMessages, parseFtsColumns, pickSentinelTokens } from './integrity.js';
import { canonicalDbPath } from './path-identity.js';
import { storeOpeners, storeQuiescence } from './store-lease.js';
import { staleSidecarPath } from './sidecar-retention.js';
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
      // A mutable table is one the rebuild itself writes (it CREATEs
      // `_adapter_meta` when the source has none), so only its presence in the
      // replacement is required. BL-94bcd318.
      const ok = mutable ? replacement !== null : source !== null && replacement !== null && source === replacement;
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

/** The artifact paths that exist beside `path` right now (the set
 *  {@link removeFileArtifacts} would consider). */
function listFileArtifacts(path: string, event: string): Set<string> {
  const out = new Set<string>();
  for (const p of [`${path}-wal`, `${path}-tshm`, `${path}.sidecar-sweep-marker`, `${path}.sox-lease.d`]) {
    if (existsSync(p)) out.add(p);
  }
  const dir = dirname(path);
  const prefix = `${basename(path)}-tshm.stale-`;
  try {
    for (const n of readdirSync(dir)) if (n.startsWith(prefix)) out.add(join(dir, n));
  } catch (err) {
    log.warn(event, { path: dir, error: err instanceof Error ? err.message : String(err) });
  }
  return out;
}

/**
 * Remove only the artifacts beside `path` that were NOT in `before` — the ones
 * an open this module performed created. A `-wal` is removed only when empty.
 * Everything that pre-existed (another scope's lease dir, a live peer's
 * `-tshm`, someone's sweep marker) is left exactly as it was. BL-74253544.
 */
function removeCreatedArtifacts(path: string, before: Set<string>, event: string): void {
  for (const p of listFileArtifacts(path, event)) {
    if (before.has(p)) continue;
    if (p === `${path}-wal`) {
      const size = fileSizeOrNull(p);
      if (size !== null && size > 0) {
        log.warn(event, { path: p, reason: `non-empty WAL (${size} bytes) left in place` });
        continue;
      }
    }
    try {
      rmSync(p, { force: true, recursive: p === `${path}.sox-lease.d` });
    } catch (err) {
      log.warn(event, { path: p, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

function removeFileAndArtifacts(path: string, event: string): void {
  try {
    rmSync(path, { force: true });
  } catch (err) {
    log.warn(event, { path, error: err instanceof Error ? err.message : String(err) });
  }
  removeFileArtifacts(path, event);
}

/**
 * Identity of a store file as recorded before the snapshot. BL-e92196e2.
 *
 * `dev`+`ino` catch a replaced file; `size`+`mtimeNs` catch any write to it —
 * a committed-and-checkpointed transaction writes the main file, and a write
 * still sitting in the `-wal` is refused separately (`sidecars_dirty`).
 * `ctime`/`nlink` are deliberately excluded: the swap's own hard link changes
 * both. Read with `stat(2)` only — never a reopen, which under the cold-open
 * lock this module holds at comparison time would wait on itself.
 */
export interface StoreFileIdentity {
  dev: string;
  ino: string;
  size: string;
  mtime_ns: string;
}

function readFileIdentity(path: string): StoreFileIdentity | null {
  try {
    const st = statSync(path, { bigint: true });
    return { dev: String(st.dev), ino: String(st.ino), size: String(st.size), mtime_ns: String(st.mtimeNs) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOENT') {
      log.warn('store_adapter.rebuild.stat_failed', { path, error: err instanceof Error ? err.message : String(err) });
    }
    return null;
  }
}

function sameIdentity(a: StoreFileIdentity | null, b: StoreFileIdentity | null): boolean {
  return a !== null && b !== null && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtime_ns === b.mtime_ns;
}

type SwapRefusal = 'sidecars_dirty' | 'cold_open_lock' | 'peers' | 'openers' | 'source_changed';
type SwapResult = { ok: true; backup_path: string | null } | { ok: false; reason: SwapRefusal; pids: number[]; detail: string };

/**
 * Atomically replace `canonical` with `replacement`, under the cold-open lock.
 *
 * ORDER (BL-2c65c6a5): nothing beside `canonical` is inspected or moved until
 * the lock is held AND the peers/openers re-check has passed — before that
 * point any `-tshm`/`-wal` may belong to a live process. Then the sidecars are
 * checked, the stale `-tshm` is moved aside, the source identity is compared
 * with `expectedSource` (BL-e92196e2), and only then is the current file
 * hard-linked to `backupPath` and the replacement renamed over it. The link is
 * the last step before the rename, so no refusal ever has a link to undo.
 *
 * WHY THE IDENTITY CHECK IS RACE-FREE: every open of the store takes the
 * cold-open lock we hold, so no process can open between the comparison and
 * the rename; a process that opened BEFORE we took the lock and is still alive
 * is caught by the peers/openers re-check; one that opened, wrote and exited
 * before we took the lock left a different mtime/size (checkpointed) or a
 * non-empty `-wal` (not checkpointed) — both refused. The one residual case is
 * an opener whose bounded cold-open wait expires and proceeds unlocked; that
 * process is alive for the duration of its open and so is a registered opener
 * the re-check sees.
 */
async function swapIntoPlace(
  canonical: string,
  replacement: string,
  backupPath: string,
  event: string,
  expectedSource: StoreFileIdentity | null = null,
): Promise<SwapResult> {
  const refuse = (reason: SwapRefusal, pids: number[], detail: string): SwapResult => {
    log.warn(`${event}.swap_refused`, { db_path: canonical, reason, pids: pids.join(','), detail });
    return { ok: false, reason, pids, detail };
  };

  // The cold-open lock serialises every cross-process open of this store. A
  // normal open proceeds WITHOUT it on timeout; a destructive swap must not.
  const lock = await acquireColdOpenLock(canonical, { maxWaitMs: 10_000 });
  if (!lock.acquired) {
    return refuse('cold_open_lock', [], 'could not take the cold-open lock — another process is opening the store');
  }
  try {
    const qn = storeQuiescence(canonical);
    if (!qn.quiescent) {
      return refuse('peers', qn.livePeers.map((p) => p.pid), 'a store peer appeared after the rebuild began');
    }
    const op = storeOpeners(canonical);
    if (op.livePids.length > 0 || op.unknown) {
      return refuse('openers', op.livePids, 'a process opened the store after the rebuild began');
    }

    // No live process holds the store: its sidecars are now ours to inspect.
    const srcWal = fileSizeOrNull(`${canonical}-wal`);
    if (srcWal !== null && srcWal > 0) {
      return refuse('sidecars_dirty', [], `${canonical}-wal holds ${srcWal} bytes — the store was not checkpointed; its frames would be replayed onto the replacement`);
    }
    const repWal = fileSizeOrNull(`${replacement}-wal`);
    if (repWal !== null && repWal > 0) {
      return refuse('sidecars_dirty', [], `${replacement}-wal holds ${repWal} bytes — committed data not in the file being swapped in`);
    }
    if (expectedSource !== null) {
      const current = readFileIdentity(canonical);
      if (!sameIdentity(expectedSource, current)) {
        return refuse(
          'source_changed',
          [],
          `${canonical} changed after the snapshot (recorded ${JSON.stringify(expectedSource)}, now ${JSON.stringify(current)}) — ` +
            'a process wrote to the store between the snapshot and the swap; the copy does not carry that write',
        );
      }
    }
    // A -tshm beside an EMPTY -wal indexes nothing; move it aside exactly as
    // the adapter's own close()-TRUNCATE does (renamed, never deleted).
    if (existsSync(`${canonical}-tshm`)) {
      // (BL-1010e417) Same collision-free name the adapter uses, so the
      // sidecar-retention sweep recognises (and bounds) this artefact too.
      const to = staleSidecarPath(`${canonical}-tshm`);
      renameSync(`${canonical}-tshm`, to);
      log.info(`${event}.tshm_moved_aside`, { db_path: canonical, to });
    }

    const hadCurrent = existsSync(canonical);
    if (hadCurrent) linkSync(canonical, backupPath);
    try {
      renameSync(replacement, canonical);
    } catch (err) {
      if (hadCurrent) {
        try {
          unlinkSync(backupPath);
        } catch (unlinkErr) {
          log.warn(`${event}.backup_unlink_failed`, {
            path: backupPath,
            error: unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr),
          });
        }
      }
      throw err;
    }
    return { ok: true, backup_path: hadCurrent ? backupPath : null };
  } finally {
    lock.release();
  }
}

// ── Rebuild ──────────────────────────────────────────────────────────────────

export interface StoreRebuildOptions {
  /** Stop after the verified copy exists; delete it; never swap. */
  dryRun?: boolean;
  /** Clock seam for tests (backup/rebuild names, `last_rebuild_at`). */
  now?: () => Date;
  /**
   * Test seam: awaited after the copy is verified and immediately before the
   * swap — the snapshot→swap window. Production callers never pass it.
   */
  _beforeSwap?: () => Promise<void>;
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
    | 'source_changed'
    | 'verification_failed'
    | 'error';
  db_path: string;
  peer_pids?: number[];
  /** The verified copy. Deleted on dry-run; kept on verification failure for
   *  forensics, and on `source_changed` (it is a verified copy of the snapshot). */
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

  // (BUG-2e232ee9) The exclusive source open below is SOFT-readonly
  // (`readonly + allowFtsInReadonly`, BL-391), which is a native-WRITABLE
  // handle — the price of `fts_match` on a hard-readonly connection — so it
  // creates the source's `-tshm` WAL-index coordination sidecar. A close that
  // truncated nothing deliberately leaves that `-tshm` in place (BL-1010e417)
  // and the swap path moves it aside, but a `--dry-run` (and every
  // failure/refusal return, which also stops before the swap) left it behind:
  // residue on a store the run promises not to touch. Snapshot the source's
  // artifacts BEFORE the open and remove exactly what this open created after
  // it closes — the same BL-74253544 cleanup the restore path applies to its
  // own soft-readonly opening of a path it must not litter.
  const canonical = canonicalDbPath(dbPath);
  const sourceArtifactsBefore = listFileArtifacts(canonical, 'store.rebuild.cleanup_failed');
  const cleanupSourceArtifacts = (): void =>
    removeCreatedArtifacts(canonical, sourceArtifactsBefore, 'store.rebuild.cleanup_failed');

  const gate = await TursoAdapterImpl.openOfflineExclusive(dbPath, { event: 'store.rebuild', readonly: true });
  if (!gate.ok) {
    // A post-open refusal (`peers`/`openers` found after the connect) may have
    // created the `-tshm`; a pre-open refusal created nothing.
    cleanupSourceArtifacts();
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
  let sourceIdentity: StoreFileIdentity | null = null;
  try {
    if (existsSync(rebuildPath) || existsSync(backupPath)) {
      return done({ status: 'failed', reason: 'error', db_path: canonical, error: `${rebuildPath} or ${backupPath} already exists` });
    }
    log.info('store.rebuild.start', { db_path: canonical, rebuild_path: rebuildPath, dry_run: opts.dryRun === true });
    // BL-e92196e2: the identity the swap must still find. Recorded under the
    // gate (no live peer/opener) and before any fact is read, so every write
    // that could be missing from the copy lands after it.
    sourceIdentity = readFileIdentity(canonical);
    if (sourceIdentity === null) throw new Error(`could not stat ${canonical} before the snapshot`);
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
    // (BUG-2e232ee9) Remove the `-tshm` (and any lease dir/marker) THIS source
    // open created, on every path — the swap's own `-tshm` move then only
    // concerns a `-tshm` that pre-existed this run (a foreign/peer artifact it
    // is right to rename aside, never delete).
    cleanupSourceArtifacts();
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
    if (opts._beforeSwap) await opts._beforeSwap();
    swap = await swapIntoPlace(canonical, rebuildPath, backupPath, 'store.rebuild', sourceIdentity);
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
    // source_changed: the copy is a verified image of the snapshot — keep it
    // and report where it is; every other refusal discards it.
    const keepCopy = swap.reason === 'source_changed';
    if (!keepCopy) removeFileAndArtifacts(rebuildPath, 'store.rebuild.cleanup_failed');
    const refused = swap.reason !== 'sidecars_dirty';
    return done({
      status: refused ? 'refused' : 'failed',
      reason: swap.reason,
      db_path: canonical,
      peer_pids: swap.pids,
      ...(keepCopy ? { rebuild_path: rebuildPath } : {}),
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
  /** Verify the clone, delete it, never swap. Every content refusal below applies to a dry run too. */
  dryRun?: boolean;
  now?: () => Date;
  /**
   * BL-15d6300c: tables the backup MUST contain, else `refused`/`backup_no_schema`.
   * The store-adapter is schema-agnostic, so the default is empty; a caller that
   * owns a schema (memory-cli passes memory-core's `REQUIRED_STORE_TABLES`)
   * names it here. Never bypassed by `allowEmptyBackup` — a store without the
   * caller's schema is the wrong file, not an empty store.
   */
  requiredTables?: readonly string[];
  /**
   * BL-15d6300c: the table whose row count measures how much a store holds
   * (memory-cli: `node`). Absent: the sum of every user table's rows (the
   * adapter's own bookkeeping tables excluded).
   */
  contentTable?: string;
  /**
   * BL-15d6300c: explicit consent to restore an EMPTY backup — lifts the
   * `page_count <= 1`, no-user-schema and zero-content refusals (all reported
   * as `backup_empty`/`backup_no_schema`), and the shrink check when the
   * backup's content count is 0. Deliberately a typed option, never an env var
   * (ADR-0013). CLI: `memory restore --allow-empty-backup`.
   */
  allowEmptyBackup?: boolean;
  /**
   * BL-15d6300c: largest fraction of the live target's content a restore may
   * drop before it is refused as `backup_shrinks_store`. POLICY, not a
   * measurement: default {@link DEFAULT_RESTORE_MAX_CONTENT_DROP} (0.9 — refuse
   * when the backup holds < 10% of the target's rows). Must be in [0, 1].
   * Skipped when the target is absent, unreadable, or has no content.
   */
  maxContentDrop?: number;
  /** BL-15d6300c: lift the `backup_shrinks_store` refusal. CLI: `memory restore --allow-shrink`. */
  allowContentDrop?: boolean;
}

/** BL-15d6300c: default for {@link StoreRestoreOptions.maxContentDrop}. */
export const DEFAULT_RESTORE_MAX_CONTENT_DROP = 0.9;

/** BL-15d6300c: what the restore measured about the backup's (and target's) content. */
export interface StoreRestoreContentCheck {
  /** The counted table, or `null` when the count is the sum over user tables. */
  table: string | null;
  backup_page_count: number;
  /** User tables in the backup (adapter bookkeeping excluded). */
  backup_tables: string[];
  /** `null` when `table` is absent from the backup. */
  backup_count: number | null;
  /** `null` when the target is absent, unreadable, or lacks `table`. */
  target_count: number | null;
  /** The threshold applied, or `null` when the shrink check was lifted or skipped. */
  max_content_drop: number | null;
}

export interface StoreRestoreReport {
  status: 'restored' | 'dry_run' | 'refused' | 'failed';
  reason?:
    | 'not_found'
    | 'backup_wal_not_empty'
    /** BL-15d6300c: the backup is 1 page or holds zero content rows. */
    | 'backup_empty'
    /** BL-15d6300c: the backup has no user schema, or lacks a `requiredTables` entry. */
    | 'backup_no_schema'
    /** BL-15d6300c: the backup would drop more than `maxContentDrop` of the live target's content. */
    | 'backup_shrinks_store'
    /** BL-15d6300c: `maxContentDrop` is outside [0, 1]. */
    | 'invalid_option'
    /** The backup resolves to the target file itself (same path, or a hard-link alias). */
    | 'backup_is_target'
    /** The backup is itself a live store (lease peers or registered openers). */
    | 'backup_in_use'
    | 'peers'
    | 'openers'
    | 'cold_open_lock'
    | 'sidecars_dirty'
    /** Shared swap vocabulary; restore does not pass a source identity today. */
    | 'source_changed'
    | 'verification_failed'
    | 'error';
  db_path: string;
  backup_path: string;
  peer_pids?: number[];
  /** Where the store that was replaced now lives (hard link). Absent when there was none. */
  replaced_path?: string;
  restored?: StorePageStats;
  verification?: StoreReplacementVerification;
  /** BL-15d6300c: the content measurement every restore makes before cloning. */
  content?: StoreRestoreContentCheck;
  duration_ms: number;
  error?: string;
}

/** Tables the adapter itself writes into ANY store it opens writable — never user schema. */
const ADAPTER_BOOKKEEPING_TABLES = new Set<string>([SOX_ENGINE_TABLE, '_adapter_meta']);

/** Rows in `table` of an open store, or the sum over user tables when `table` is null; null when `table` is absent. */
async function contentCount(adapter: StoreAdapter, tables: string[], table: string | null): Promise<number | null> {
  if (table !== null) return tables.includes(table) ? countRows(adapter, table) : null;
  let n = 0;
  for (const t of tables) n += await countRows(adapter, t);
  return n;
}

async function listContentTables(adapter: StoreAdapter): Promise<string[]> {
  return (await listUserTables(adapter)).filter((t) => !ADAPTER_BOOKKEEPING_TABLES.has(t));
}

/**
 * BL-15d6300c: content count of the restore TARGET, read-only, leaving no
 * artifact behind it did not find (a stray sidecar would trip the swap's
 * `sidecars_dirty` gate). Restoring over a damaged store is the main reason
 * restore exists, so an unreadable target is logged and reads as `null` —
 * never a refusal.
 */
async function readTargetContentCount(dbPath: string, table: string | null): Promise<number | null> {
  if (!existsSync(dbPath)) return null;
  const preexisting = listFileArtifacts(dbPath, 'store.restore.cleanup_failed');
  try {
    const t = await TursoAdapterImpl.connect({ dbPath, readonly: true, allowFtsInReadonly: true, idleFlushMs: 3_600_000 });
    try {
      return await contentCount(t, await listContentTables(t), table);
    } finally {
      await t.close();
    }
  } catch (err) {
    log.warn('store.restore.target_count_unreadable', {
      db_path: dbPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    removeCreatedArtifacts(dbPath, preexisting, 'store.restore.cleanup_failed');
  }
}

type ContentRefusal = { reason: 'backup_empty' | 'backup_no_schema' | 'backup_shrinks_store'; error: string };

/** BL-15d6300c: the content gate. Pure over the measurement, so every branch is spelled out once. */
function judgeRestoreContent(
  c: StoreRestoreContentCheck,
  opts: Pick<StoreRestoreOptions, 'requiredTables' | 'allowEmptyBackup' | 'allowContentDrop'>,
  backup: string,
): ContentRefusal | null {
  const missing = (opts.requiredTables ?? []).filter((t) => !c.backup_tables.includes(t));
  if (missing.length > 0) {
    return { reason: 'backup_no_schema', error: `${backup} lacks required table(s) ${missing.join(', ')} — not a store of this schema` };
  }
  const allowEmpty = opts.allowEmptyBackup === true;
  if (!allowEmpty) {
    if (c.backup_page_count <= 1) {
      return { reason: 'backup_empty', error: `${backup} is ${c.backup_page_count} page(s) — an empty or torn store file (pass allowEmptyBackup to restore it anyway)` };
    }
    if (c.backup_tables.length === 0) {
      return { reason: 'backup_no_schema', error: `${backup} has no user tables — an empty or torn store file (pass allowEmptyBackup to restore it anyway)` };
    }
    if (c.table !== null && c.backup_count === null) {
      return { reason: 'backup_no_schema', error: `${backup} has no ${c.table} table` };
    }
    if (c.backup_count === 0) {
      return { reason: 'backup_empty', error: `${backup} holds 0 ${c.table ?? 'user'} rows (pass allowEmptyBackup to restore it anyway)` };
    }
  }
  if (allowEmpty && c.backup_count === 0) return null; // explicit consent to replace with nothing
  if (c.max_content_drop !== null && c.backup_count !== null && c.target_count !== null && c.target_count > 0) {
    const floor = c.target_count * (1 - c.max_content_drop);
    if (c.backup_count < floor) {
      const drop = (1 - c.backup_count / c.target_count) * 100;
      return {
        reason: 'backup_shrinks_store',
        error:
          `${backup} holds ${c.backup_count} ${c.table ?? 'user'} rows against ${c.target_count} in the live store ` +
          `(a ${drop.toFixed(1)}% drop, over the ${(c.max_content_drop * 100).toFixed(1)}% limit; pass allowContentDrop to restore it anyway)`,
      };
    }
  }
  return null;
}

/**
 * OFFLINE restore of a single-file backup (a `memory fts-rebuild`
 * `.pre-rebuild-*` file, or any closed, checkpointed Turso store file) over
 * `dbPath`. Refuses while the target has live peers or openers. The backup
 * itself is never modified or consumed — it is cloned.
 *
 * BL-15d6300c: before anything is cloned — dry run included — the backup's
 * content is measured and the restore refused when the backup is 1 page
 * (`backup_empty`), has no user schema or lacks a `requiredTables` entry
 * (`backup_no_schema`), holds zero content rows (`backup_empty`), or would drop
 * more than `maxContentDrop` of the live target's content
 * (`backup_shrinks_store`). The clone-vs-backup verification cannot catch any
 * of these: it proves the clone equals the backup, and an empty backup equals
 * itself. `allowEmptyBackup` / `allowContentDrop` are the explicit overrides.
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
  // BL-74253544: a backup that IS the target (same path, or a hard link to the
  // same inode) would have the target's own sidecars treated as the backup's.
  const backupId = readFileIdentity(backup);
  const targetId = readFileIdentity(canonical);
  if (
    backup === canonical ||
    (backupId !== null && targetId !== null && backupId.dev === targetId.dev && backupId.ino === targetId.ino)
  ) {
    return done({ status: 'refused', reason: 'backup_is_target', error: `${backup} is the same file as ${canonical}` });
  }
  // BL-74253544: the backup is opened (read-only) below, and that open's
  // artifacts are cleaned up afterwards — never while another process is using
  // the backup as its store.
  const backupPeers = storeQuiescence(backup);
  if (!backupPeers.quiescent) {
    const pids = backupPeers.livePeers.map((p) => p.pid);
    return done({ status: 'refused', reason: 'backup_in_use', peer_pids: pids, error: `${backup} has live store peers (pids ${pids.join(',')})` });
  }
  const backupOpeners = storeOpeners(backup);
  if (backupOpeners.livePids.length > 0 || backupOpeners.unknown) {
    return done({
      status: 'refused',
      reason: 'backup_in_use',
      peer_pids: backupOpeners.livePids,
      error: `${backup} is open in live process(es) (pids ${backupOpeners.livePids.join(',') || 'unknown'})`,
    });
  }
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

  const maxDrop = opts.maxContentDrop ?? DEFAULT_RESTORE_MAX_CONTENT_DROP;
  if (!(maxDrop >= 0 && maxDrop <= 1)) {
    return done({ status: 'refused', reason: 'invalid_option', error: `maxContentDrop must be in [0, 1], got ${String(opts.maxContentDrop)}` });
  }

  const ts = now();
  const clone = `${canonical}.restore-${stamp(ts)}`;
  const replacedPath = `${canonical}.pre-restore-${stamp(ts)}`;
  // Facts from the backup itself, read-only (measured: a soft-readonly open
  // leaves the file's bytes unchanged), so the clone is checked against it.
  // Those facts only prove the clone equals the backup — they say nothing
  // about whether the backup is worth restoring (a torn 1-page file verifies
  // against itself). BL-15d6300c measures that separately, before any clone.
  let facts: StoreFacts;
  let content: StoreRestoreContentCheck;
  const contentTable = opts.contentTable ?? null;
  try {
    const preexisting = listFileArtifacts(backup, 'store.restore.cleanup_failed');
    try {
      const src = await TursoAdapterImpl.connect({ dbPath: backup, readonly: true, allowFtsInReadonly: true, idleFlushMs: 3_600_000 });
      try {
        facts = await captureFacts(src);
        const tables = await listContentTables(src);
        content = {
          table: contentTable,
          backup_page_count: await pragmaNumber(src, 'page_count'),
          backup_tables: tables,
          backup_count: await contentCount(src, tables, contentTable),
          target_count: null,
          max_content_drop: opts.allowContentDrop === true ? null : maxDrop,
        };
      } finally {
        await src.close();
      }
    } finally {
      // The read-only open may leave a lease dir / sweep marker beside the
      // backup — remove exactly those, never what was already there.
      removeCreatedArtifacts(backup, preexisting, 'store.restore.cleanup_failed');
    }
    if (content.max_content_drop !== null) content.target_count = await readTargetContentCount(canonical, contentTable);
  } catch (err) {
    return done({ status: 'failed', reason: 'error', error: err instanceof Error ? err.message : String(err) });
  }
  const refusal = judgeRestoreContent(content, opts, backup);
  if (refusal !== null) return done({ status: 'refused', ...refusal, content });

  let restored: StorePageStats;
  let verification: StoreReplacementVerification;
  try {
    if (existsSync(clone) || existsSync(replacedPath)) throw new Error(`${clone} or ${replacedPath} already exists`);
    copyFileSync(backup, clone, fsConstants.COPYFILE_FICLONE);
    ({ stats: restored, verification } = await verifyReplacement(clone, facts, { expectGrowthReset: false }));
  } catch (err) {
    removeFileAndArtifacts(clone, 'store.restore.cleanup_failed');
    return done({ status: 'failed', reason: 'error', error: err instanceof Error ? err.message : String(err) });
  }
  removeFileArtifacts(clone, 'store.restore.cleanup_failed');
  if (!verification.ok) {
    removeFileAndArtifacts(clone, 'store.restore.cleanup_failed');
    return done({ status: 'failed', reason: 'verification_failed', restored, verification, content, error: verification.failures.join('; ') });
  }
  if (opts.dryRun === true) {
    removeFileAndArtifacts(clone, 'store.restore.cleanup_failed');
    return done({ status: 'dry_run', restored, verification, content });
  }
  let swap: SwapResult;
  try {
    swap = await swapIntoPlace(canonical, clone, replacedPath, 'store.restore');
  } catch (err) {
    removeFileAndArtifacts(clone, 'store.restore.cleanup_failed');
    return done({ status: 'failed', reason: 'error', restored, verification, content, error: err instanceof Error ? err.message : String(err) });
  }
  if (!swap.ok) {
    removeFileAndArtifacts(clone, 'store.restore.cleanup_failed');
    const refused = swap.reason !== 'sidecars_dirty';
    return done({ status: refused ? 'refused' : 'failed', reason: swap.reason, peer_pids: swap.pids, restored, verification, content, error: swap.detail });
  }
  return done({
    status: 'restored',
    ...(swap.backup_path !== null ? { replaced_path: swap.backup_path } : {}),
    restored,
    content,
    verification,
  });
}
