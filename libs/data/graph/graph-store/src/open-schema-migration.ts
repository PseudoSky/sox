/**
 * PKT-61 (BL-442) — the operator-invoked migration that removes the closed
 * `CHECK (kind IN (...))` / `CHECK (rel IN (...))` constraints from an EXISTING
 * store's `node`/`edge` tables.
 *
 * Read SPEC-PKT-61.md before touching this file — every step below is load-bearing and
 * traceable to a numbered step in that spec's §3. In short:
 *
 * `applySchema()` (index.ts) never removes the closed CHECK from a store that already has
 * it — `CREATE TABLE IF NOT EXISTS` no-ops, and `ensureCheckConstraints()`'s own rebuild
 * trigger only fires for a genuinely pre-BL-447 store, by design (BL-447). This module is
 * the explicit, operator-invoked, offline, verified-and-reversible alternative that ADR-0010
 * D3 requires instead of ever doing this automatically.
 *
 * Reuses the exact BL-313 `skipDrop`-interleaved rebuild sequencing already proven safe
 * against the live store by `ensureCheckConstraints()` (index.ts) — never re-invented here.
 *
 * D-6: this file imports FROM `./index.js`. `index.ts` never imports from this file — see
 * SPEC-PKT-61.md Decision D-6 for why (circular-import risk BL-231, and not silently
 * widening `@adhd/sox-graph-store`'s public entrypoint mid-release-train).
 *
 * D-7: `migrateToOpenSchema` owns its own `dbPath` and opens/closes its own adapter(s)
 * internally — it never accepts a caller-supplied, already-open `StoreAdapter`. This is what
 * makes AC-4 (unreachable from `applySchema()`) true by construction: `SqliteGraphBackend`
 * only ever has an open connection in scope, never a raw path.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createSqliteAdapter, ETursoNativeStore } from '@adhd/sox-store-adapter';
import type { SqliteAdapter, AdapterBackupResult } from '@adhd/sox-store-adapter';
import {
  rebuildTable,
  NODE_TABLE_DDL_OPEN,
  EDGE_TABLE_DDL_OPEN,
  NODE_COLUMNS,
  EDGE_COLUMNS,
  NODE_INDEX_DDLS,
  EDGE_INDEX_DDLS,
  FTS_TRIGGERS,
} from './index.js';

// ── Public option / result types (SPEC-PKT-61.md §2.3) ──────────────────────

export interface MigrateOpenSchemaOptions {
  /** TEST-ONLY. Never set this from production code or the CLI (`tools/graph-store-migrate-open-schema.mjs`
   *  has no flag that can reach this option). When true, the post-commit re-verification step (§3 step 8)
   *  is told the just-recomputed edge count is wrong regardless of what it actually is, forcing the
   *  restore-from-backup path to execute for real. This is the only way to prove AC-3 (rollback) without
   *  engineering a genuine torn write. */
  __test_forcePostCommitMismatch?: boolean;
  /**
   * (Task #16, finding 4) Every run of this migration leaves a
   * `<dbPath>.pre-open-schema-migration-<ts>.bak` sibling on disk — pre-fix,
   * NOTHING ever deleted it, on success or on a handled rollback alike
   * (verified: neither the success return path nor `MigrationRolledBackError`'s
   * throw path touched `backupPath` after using it). Since this is an
   * operator-invoked, rarely-run migration (not a scheduled job), unbounded
   * growth is slow but real over repeated re-runs against the same store
   * (retries, re-tests, multiple environments sharing a `dbPath` basename
   * pattern). Bounds it to the `keepBackups` most recent backups for this
   * `dbPath`, pruned AFTER the run's own outcome is fully resolved so a
   * prune can never race the very backup a rollback/error path is reporting
   * as evidence. Default 3, matching this repo's other retention idiom
   * (ADR-0014 D2.2's count floor). Set to `Infinity` to disable pruning
   * entirely (never negative or zero-and-below without explicit intent —
   * `pruneOldMigrationBackups` treats non-finite/negative as "keep all").
   */
  keepBackups?: number;
}

export interface StoreSnapshot {
  nodeCount: number;
  edgeCount: number;
  /** rel -> count, live edges only. */
  perRelation: Record<string, number>;
  /** sha256 over an ordered, stable projection of `node` — see `captureSnapshot`. */
  nodeChecksum: string;
  /** sha256 over an ordered, stable projection of `edge` — see `captureSnapshot`. */
  edgeChecksum: string;
}

export type MigrateOpenSchemaResult = {
  status: 'migrated';
  backupPath: string;
  before: StoreSnapshot;
  after: StoreSnapshot;
};
// The function never *returns* a failure — every failure mode throws one of the typed errors
// below, so a caller cannot mistake "rejected" for "succeeded".

// ── Typed errors ──────────────────────────────────────────────────────────────

export class MigrationPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationPreflightError';
  }
}

/** Turso-formatted file — refuse. See SPEC-PKT-61.md Decision D-3. */
export class UnsupportedBackendError extends Error {
  constructor(dbPath: string, cause?: unknown) {
    super(
      `Cannot migrate "${dbPath}": this store is Turso-formatted (it carries a Tantivy-backed ` +
        `FTS index). This migration does not support Turso-backed stores — see BL-337 (orphan-FTS ` +
        `repair) / BL-361 (fts_match PANIC), both owned by PKT-69/PKT-70, not this packet.`,
      cause !== undefined ? { cause } : undefined,
    );
    this.name = 'UnsupportedBackendError';
  }
}

/** Exclusive lock unobtainable — another connection currently holds the store open. */
export class StoreOpenElsewhereError extends Error {
  constructor(dbPath: string, opts?: { cause?: unknown }) {
    super(
      `Cannot migrate "${dbPath}": another connection currently holds the store open ` +
        `(BEGIN EXCLUSIVE could not be acquired immediately). This migration requires exclusive, ` +
        `offline access — close every other connection to this store and retry.`,
      opts,
    );
    this.name = 'StoreOpenElsewhereError';
  }
}

/** `backupTo()`'s `integrityReport` wasn't `'verified'`. Nothing was mutated. */
export class BackupNotVerifiedError extends Error {
  constructor(public readonly backupResult: AdapterBackupResult) {
    super(
      `Backup verification did not return 'verified' (got: ` +
        `${backupResult.integrityReport?.status ?? 'unknown'}). Nothing on the source store has been ` +
        `mutated — this is a safe abort. Backup copy (do not trust it): ${backupResult.destPath}`,
    );
    this.name = 'BackupNotVerifiedError';
  }
}

/** In-transaction pre-commit mismatch — SQL ROLLBACK already ran; the working file is untouched. */
export class MigrationVerificationError extends Error {
  constructor(message: string, public readonly detail?: unknown) {
    super(message);
    this.name = 'MigrationVerificationError';
  }
}

/** Post-commit mismatch; the file-level restore ran and was itself verified. */
export class MigrationRolledBackError extends Error {
  constructor(
    public readonly detail: {
      mismatch: unknown;
      backupPath: string;
      restoredSnapshot: StoreSnapshot;
    },
  ) {
    super(
      `The migration committed, but post-commit re-verification found a mismatch against the ` +
        `pre-migration backup. The store has been restored from the verified backup at ` +
        `"${detail.backupPath}" and is confirmed byte-for-byte content-equivalent to it. The ` +
        `migration did NOT take effect.`,
    );
    this.name = 'MigrationRolledBackError';
  }
}

/** The restore itself didn't reproduce the backup's counts — unrecoverable, never silently swallowed. */
export class MigrationRestoreFailedError extends Error {
  constructor(
    public readonly detail: { backupPath: string; restoredSnapshot: StoreSnapshot },
  ) {
    super(
      `UNRECOVERABLE: a post-commit mismatch was detected and a restore from the verified backup ` +
        `at "${detail.backupPath}" was attempted, but the restored store still does not match the ` +
        `backup's own snapshot. Do not trust the store at this path. Manual intervention required — ` +
        `the untouched backup file itself is still on disk at the path above.`,
    );
    this.name = 'MigrationRestoreFailedError';
  }
}

// ── Turso-detection conversion (SPEC-PKT-61.md Decision D-2 / AC-6) ─────────

/**
 * Converts a raw `ETursoNativeStore` (thrown synchronously by `SqliteAdapterImpl`'s
 * constructor, per BL-329) into the typed `UnsupportedBackendError` this module surfaces to
 * callers. Returns `null` for anything else, so the caller can fall through to re-throwing
 * the original error unconverted.
 *
 * Exported and independently testable (AC-6) without needing a live Turso engine — pass a
 * real `ETursoNativeStore` instance directly.
 */
export function toUnsupportedBackendRefusal(err: unknown): UnsupportedBackendError | null {
  if (err instanceof ETursoNativeStore) {
    return new UnsupportedBackendError(err.dbPath, err);
  }
  return null;
}

// ── Snapshot capture (SPEC-PKT-61.md §3 step 6 / Decision D-5) ──────────────

/** Structural subset of `SqliteAdapter`/`AdapterTransaction` sufficient to capture a snapshot. */
interface SnapshotQueryClient {
  executeGet<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<T | null>;
  executeAll<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<{ rows: T[] }>;
}

async function captureSnapshot(client: SnapshotQueryClient): Promise<StoreSnapshot> {
  const nodeCountRow = await client.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM node');
  const edgeCountRow = await client.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM edge');

  const relRows = await client.executeAll<{ rel: string; c: number }>(
    'SELECT rel, COUNT(*) AS c FROM edge GROUP BY rel ORDER BY rel',
  );
  const perRelation: Record<string, number> = {};
  for (const row of relRows.rows) perRelation[row.rel] = row.c;

  const nodeRows = await client.executeAll<{
    rowid: number;
    uid: string;
    kind: string;
    content_hash: string | null;
  }>('SELECT rowid, uid, kind, content_hash FROM node ORDER BY rowid');
  const nodeHash = crypto.createHash('sha256');
  for (const row of nodeRows.rows) {
    nodeHash.update(`${row.rowid}\0${row.uid}\0${row.kind}\0${row.content_hash ?? ''}\n`);
  }

  const edgeRows = await client.executeAll<{
    rowid: number;
    src: number;
    dst: number;
    rel: string;
  }>('SELECT rowid, src, dst, rel FROM edge ORDER BY rowid');
  const edgeHash = crypto.createHash('sha256');
  for (const row of edgeRows.rows) {
    edgeHash.update(`${row.rowid}\0${row.src}\0${row.dst}\0${row.rel}\n`);
  }

  return {
    nodeCount: nodeCountRow?.c ?? 0,
    edgeCount: edgeCountRow?.c ?? 0,
    perRelation,
    nodeChecksum: nodeHash.digest('hex'),
    edgeChecksum: edgeHash.digest('hex'),
  };
}

function snapshotsEqual(a: StoreSnapshot, b: StoreSnapshot): boolean {
  return (
    a.nodeCount === b.nodeCount &&
    a.edgeCount === b.edgeCount &&
    a.nodeChecksum === b.nodeChecksum &&
    a.edgeChecksum === b.edgeChecksum &&
    JSON.stringify(a.perRelation) === JSON.stringify(b.perRelation)
  );
}

// ── Rollback-backup retention (task #16, finding 4) ──────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Anchored on the exact `<basename>.pre-open-schema-migration-<ms>.bak` shape
 * this module writes (`backupPath` above) — captures the millisecond
 * timestamp so retention can sort chronologically without relying on
 * filesystem mtime (which a `cp`/restore step could otherwise disturb).
 */
function migrationBackupPattern(dbPath: string): RegExp {
  return new RegExp(`^${escapeRegExp(path.basename(dbPath))}\\.pre-open-schema-migration-(\\d+)\\.bak$`);
}

/**
 * Enforce a bounded retention policy on `<dbPath>.pre-open-schema-migration-*.bak`
 * siblings: keep the `keepBackups` most recent, delete the rest.
 *
 * Pre-fix, NOTHING ever called this — every invocation of `migrateToOpenSchema`
 * left its backup on disk permanently, on both the success path and the
 * `MigrationRolledBackError` path (both used `backupPath` and then simply
 * returned/threw without cleanup). This is an operator-invoked, rarely-run
 * migration, so the accumulation is slow, but it is exactly the "no
 * reclamation path" class the rest of this task addresses — a `--confirm`
 * CLI run against a shared fixture/dev store, repeated across retries or CI
 * runs, silently grows an unbounded set of full-store `.bak` copies.
 *
 * Deliberately never called from the `MigrationRestoreFailedError` path
 * (`migrateToOpenSchema` step 8's unrecoverable branch): that error's whole
 * point is "do not trust anything here, a human must look," and its own
 * message explicitly promises the backup is "still on disk at the path
 * above" — pruning there would break that promise on the one path where it
 * matters most.
 *
 * Exported and independently testable without running a real migration —
 * seed matching filenames directly.
 */
export function pruneOldMigrationBackups(
  dbPath: string,
  keepBackups = 3,
  log: (...args: unknown[]) => void = () => undefined,
): string[] {
  const deleted: string[] = [];
  if (!Number.isFinite(keepBackups) || keepBackups < 0) return deleted;
  const dir = path.dirname(dbPath);
  const re = migrationBackupPattern(dbPath);

  let entries: { name: string; ts: number }[];
  try {
    entries = fs
      .readdirSync(dir)
      .map((name) => {
        const m = re.exec(name);
        return m ? { name, ts: Number(m[1]) } : null;
      })
      .filter((e): e is { name: string; ts: number } => e !== null)
      .sort((a, b) => a.ts - b.ts); // oldest first — embedded ms timestamp, not mtime
  } catch (err) {
    log(`[open-schema-migration] prune: cannot read ${dir}: ${err}`);
    return deleted;
  }

  while (entries.length > keepBackups) {
    const oldest = entries.shift();
    if (!oldest) break;
    const fullPath = path.join(dir, oldest.name);
    try {
      fs.rmSync(fullPath, { force: true });
      deleted.push(fullPath);
    } catch (err) {
      // Best-effort: never let a prune failure turn a successful/handled
      // migration outcome into a reported failure.
      log(`[open-schema-migration] prune: failed to delete ${fullPath}: ${err}`);
    }
  }
  return deleted;
}

// ── The migration ─────────────────────────────────────────────────────────────

export async function migrateToOpenSchema(
  dbPath: string,
  opts?: MigrateOpenSchemaOptions,
): Promise<MigrateOpenSchemaResult> {
  // 1. Existence check.
  if (!fs.existsSync(dbPath)) {
    throw new MigrationPreflightError(`Cannot migrate "${dbPath}": file does not exist.`);
  }

  // 2. Open + Turso-format detection, for free (SqliteAdapterImpl's constructor probes
  //    `sqlite_master` synchronously and throws a typed `ETursoNativeStore`).
  let adapter: SqliteAdapter;
  try {
    adapter = createSqliteAdapter({ dbPath });
  } catch (err) {
    const refusal = toUnsupportedBackendRefusal(err);
    if (refusal) throw refusal;
    throw err;
  }

  // 2b. better-sqlite3 defaults `busy_timeout` to 5000ms — its OWN internal busy-handler sleep
  //     loop, independent of the adapter's `maxRetries` option. Left at the default, a single
  //     `BEGIN EXCLUSIVE` against a held lock blocks for up to 5s before even reporting
  //     SQLITE_BUSY, silently defeating `maxRetries: 0`'s "refuse immediately" contract (AC-5).
  //     Zero it for this adapter's whole lifetime — this migration's own precondition is
  //     exclusive, offline access, so there is never a legitimate reason for it to wait out a
  //     contending writer at any step, not just the explicit lock probe.
  await adapter.pragmaSet('busy_timeout', 0);

  // 3. `adapter.init()` — runs the adapter's own BL-352 stamp/self-heal.
  try {
    await adapter.init();
  } catch (err) {
    await adapter.close();
    throw err;
  }

  // 4. Lock probe — proves no other connection currently holds so much as a read transaction.
  //    `maxRetries: 0` is required: the default (3, exponential backoff) would silently retry
  //    past a momentary lock instead of refusing (SPEC-PKT-61.md Decision D-4).
  try {
    await adapter.transaction(async () => {}, { mode: 'exclusive', maxRetries: 0 });
  } catch (err) {
    await adapter.close();
    throw new StoreOpenElsewhereError(dbPath, { cause: err });
  }

  // 5. Verified backup. `backupTo()` already runs `VACUUM INTO` plus a full
  //    `verifyStoreIntegrity({ depth: 'deep' })` pass — never pass `skipIntegrityCheck: true`.
  if (!adapter.backupTo) {
    await adapter.close();
    throw new MigrationPreflightError(
      `Cannot migrate "${dbPath}": the opened adapter does not implement backupTo().`,
    );
  }
  const backupPath = `${dbPath}.pre-open-schema-migration-${Date.now()}.bak`;
  const backupResult = await adapter.backupTo(backupPath);
  if (backupResult.integrityReport?.status !== 'verified') {
    await adapter.close();
    throw new BackupNotVerifiedError(backupResult);
  }

  // 6. Baseline snapshot from the backup, not the live file — a second, read-only adapter.
  const backupReader = createSqliteAdapter({ dbPath: backupPath, readonly: true });
  let baseline: StoreSnapshot;
  try {
    baseline = await captureSnapshot(backupReader);
  } finally {
    await backupReader.close();
  }

  // 7. The migration transaction — one transaction, both tables, exact BL-313 sequencing.
  try {
    await adapter.transaction(
      async (tx) => {
        // 7.1 TOCTOU guard — re-compare against the backup baseline before touching anything.
        const live = await captureSnapshot(tx);
        if (!snapshotsEqual(live, baseline)) {
          throw new MigrationVerificationError(
            'backup baseline and live store disagree before any rebuild ran — another writer ' +
              'touched the store between backup and migration',
            { baseline, live },
          );
        }

        // 7.2 / 7.3 — both rebuilds run BEFORE either `_old` table is dropped. This ordering is
        // the entire BL-313 fix; do not drop either `_old` earlier, and do not reorder relative
        // to the drops below.
        await rebuildTable(adapter, 'node', NODE_TABLE_DDL_OPEN, NODE_COLUMNS, { skipDrop: true, tx });
        await rebuildTable(adapter, 'edge', EDGE_TABLE_DDL_OPEN, EDGE_COLUMNS, { skipDrop: true, tx });

        // 7.4 — both drops only after both new tables are fully populated.
        await tx.exec('DROP TABLE node_old');
        await tx.exec('DROP TABLE edge_old');

        // 7.5 — indexes + FTS re-sync, mirroring `ensureCheckConstraints()` exactly.
        for (const ddl of NODE_INDEX_DDLS) await tx.exec(ddl);
        await tx.exec(FTS_TRIGGERS);
        await tx.exec(
          `INSERT INTO fts_node(rowid, content, name, summary)
           SELECT rowid, content, name, summary FROM node`,
        );
        for (const ddl of EDGE_INDEX_DDLS) await tx.exec(ddl);

        // 7.6 — Layer 1 verification: any disagreement rolls back the whole transaction.
        const after = await captureSnapshot(tx);
        if (!snapshotsEqual(after, baseline)) {
          throw new MigrationVerificationError(
            'post-rebuild snapshot does not match the pre-migration baseline — rolled back before ' +
              'commit; the working file is unmodified',
            { baseline, after },
          );
        }
      },
      { mode: 'exclusive', maxRetries: 0 },
    );
  } catch (err) {
    await adapter.close();
    throw err;
  }

  await adapter.close();

  // 8. Post-commit paranoia re-verification (Layer 2). Fresh adapter, fresh read.
  const freshAdapter = createSqliteAdapter({ dbPath });
  let after: StoreSnapshot;
  try {
    after = await captureSnapshot(freshAdapter);
  } finally {
    await freshAdapter.close();
  }

  if (opts?.__test_forcePostCommitMismatch === true) {
    after = { ...after, edgeCount: -1 };
  }

  if (snapshotsEqual(after, baseline)) {
    // (finding 4) Bounded retention: `backupPath` is always the newest
    // matching sibling by construction (embedded `Date.now()`), so it is
    // never itself a prune candidate here — no separate protect/exclude
    // logic is needed for the just-created backup to survive.
    pruneOldMigrationBackups(dbPath, opts?.keepBackups ?? 3);
    return { status: 'migrated', backupPath, before: baseline, after };
  }

  // Mismatch — the rollback path. Delete the working file + WAL sidecars, restore from backup.
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  }
  fs.copyFileSync(backupPath, dbPath);

  const restoredAdapter = createSqliteAdapter({ dbPath });
  let restoredSnapshot: StoreSnapshot;
  try {
    restoredSnapshot = await captureSnapshot(restoredAdapter);
  } finally {
    await restoredAdapter.close();
  }

  if (snapshotsEqual(restoredSnapshot, baseline)) {
    // (finding 4) Same reasoning as the success path: `backupPath` is the
    // newest matching sibling by construction, so pruning older ones here
    // can never delete the copy this error's own message points at.
    // Deliberately NOT applied to the `MigrationRestoreFailedError` branch
    // below — that path is unrecoverable and must not touch anything.
    pruneOldMigrationBackups(dbPath, opts?.keepBackups ?? 3);
    throw new MigrationRolledBackError({
      mismatch: { baseline, after },
      backupPath,
      restoredSnapshot,
    });
  }
  throw new MigrationRestoreFailedError({ backupPath, restoredSnapshot });
}
