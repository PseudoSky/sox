/**
 * Store integrity verification and self-repair — BL-352 (+ BL-330, BL-335,
 * BL-336, BL-337, BL-341, BL-347).
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 *
 * The adapter's schema path reconciles by **existence**, never by **integrity**.
 * `CREATE TABLE/INDEX IF NOT EXISTS` no-ops on a structure that is present but
 * EMPTY or UNPOPULATED, and the version gate is already satisfied, so the
 * migrator concludes the store is fully migrated. Observed in production, all
 * on generated data the adapter itself owns:
 *
 * - `idx_fts_node` present and well-formed in `sqlite_master` but not matching
 *   its own rows — keyword search returned zero rows for every query for over
 *   a day, silently (BL-347). (That item calls this "an empty Tantivy
 *   directory"; the description is wrong — see `probeFtsIndexes` — but the
 *   damage is real and was measured on the live store.)
 * - Nine secondary indexes on `node` unpopulated after a bulk insert; nothing
 *   detected or repaired it (BL-335).
 * - Duplicate `_adapter_meta` PRIMARY KEY rows, which are schema-impossible
 *   and permanently block `REINDEX` of that table (BL-336).
 * - A WAL unlinked underneath a live connection: a graceful `close()` silently
 *   discarded every write since open (BL-330).
 *
 * **No `IF NOT EXISTS` DDL can ever detect a present-but-empty derived
 * structure.** Verification therefore has to interrogate the artifact's
 * CONTENT, which is what the probes below do.
 *
 * ── Every probe carries a negative control ──────────────────────────────────
 *
 * A probe that passes in the damaged state is worse than no probe (BL-167).
 * Three concrete traps were measured on 2026-07-31 and are defended against
 * structurally, not by convention:
 *
 * 1. **Tantivy backing-table row count is not a health signal.**
 *    `SELECT COUNT(*) FROM __turso_internal_fts_dir_idx_fts_node` reads `0`
 *    both when FTS is dead AND when it works. {@link probeFtsIndexes} instead
 *    round-trips a token taken from a specific row and asserts THAT ROW comes
 *    back. Measured on the live store: rowid 1 (old) unmatchable, rowid 9424
 *    (recent) matchable — a "does FTS return anything at all" probe passes on
 *    the live damage.
 *
 * 2. **Turso silently ignores `INDEXED BY` on a PARTIAL index.**
 *    `SELECT COUNT(*) FROM t INDEXED BY ix_part` plans as a bare `SCAN t`
 *    (real SQLite raises "no query solution"), so the count matches the table
 *    trivially and the probe reports healthy for every partial index — 8 of
 *    the live store's 20. {@link probeBtreeIndexes} appends the index's own
 *    partial predicate AND requires `EXPLAIN QUERY PLAN` to name the index;
 *    when the plan does not name it the finding is `unknown`, never `ok`.
 *
 * 3. **`PRAGMA integrity_check` reports a PERMANENT false positive on Turso
 *    FTS stores.** `wrong # of entries in index __turso_internal_fts_dir_*_key`
 *    is emitted on a freshly created, fully working index (measured: 200/200
 *    `fts_match` hits alongside that message). Treating integrity_check as
 *    pass/fail on such a store yields "damaged" forever — see
 *    {@link isKnownFalsePositive}.
 *
 * ── Cost tiers (the tradeoff BL-352 asks to be made explicitly) ─────────────
 *
 * Measured on a COPY of the live 43 MB store (9 428 nodes, 47 038 edges,
 * 19 probeable indexes), 2026-07-31, median of three:
 *
 * | Probe                   | Cost     |
 * |-------------------------|----------|
 * | `adapter_meta_unique`   | < 0.5 ms |
 * | `fts_index_live`        | 9.3 ms   |
 * | `btree_index_populated` | 78.5 ms  |
 * | **`fast` total**        | **91 ms**|
 * | **`deep` total**        | **392 ms** (adds `PRAGMA integrity_check`) |
 *
 * `fast` runs on **every open**. 91 ms is a fraction of the store open it is
 * part of, and it detects every one of the four production defects above —
 * on that same live copy it found the dead FTS index and the duplicate
 * `_adapter_meta` rows and repaired both, taking the open to 462 ms once.
 * `deep` runs when the previous session did not shut down cleanly (the
 * crash-recovery flag, BL-338), on an explicit request, or on a cadence.
 * Deep is not the default because `integrity_check` is O(database) and grows
 * without bound, while every fast probe is O(indexes) with a constant-size
 * sample.
 *
 * @module
 */

import { statSync } from 'node:fs';
import { createFTSDialect } from './fts-dialect.js';
import type { StoreAdapter } from './types.js';

// ── Public result types ──────────────────────────────────────────────────────

/** Which probe produced a finding. Stable identifiers — safe to switch on. */
export type IntegrityProbe =
  | 'wal_identity'
  | 'adapter_meta_unique'
  | 'btree_index_populated'
  | 'fts_index_live'
  | 'pragma_integrity_check';

export type IntegrityStatus =
  /** The artifact was interrogated and is correct. */
  | 'ok'
  /** The artifact was interrogated and is damaged. */
  | 'damaged'
  /** The probe could not be run, or could not be shown to have exercised the
   *  artifact (e.g. the planner refused to use the index). NEVER treated as
   *  healthy — an unvalidated probe is a comment, not a check. */
  | 'unknown';

export interface IntegrityFinding {
  probe: IntegrityProbe;
  /** Index / table / file the finding is about. */
  object: string;
  status: IntegrityStatus;
  /** Human-readable evidence — always includes the observed numbers. */
  detail: string;
  /** Whether {@link repairStoreIntegrity} knows how to fix this finding. */
  repairable: boolean;
  /** Backlog item this probe exists for. */
  backlog: string;
  /** True when the probe demonstrably exercised the artifact (the negative
   *  control). `false` forces `status: 'unknown'`. */
  probeValidated: boolean;
}

export interface IntegrityReport {
  /** True when nothing was found damaged. Read {@link unknown} separately —
   *  a probe that could not be validated is an absence of evidence, not a
   *  clean bill of health. */
  ok: boolean;
  depth: VerifyDepth;
  durationMs: number;
  findings: IntegrityFinding[];
  /** Convenience view: `findings` filtered to `status === 'damaged'`. */
  damaged: IntegrityFinding[];
  /** Convenience view: probes that could not be validated. */
  unknown: IntegrityFinding[];
}

export interface RepairAction {
  probe: IntegrityProbe;
  object: string;
  /** The remediation performed, as a short verb phrase (not raw SQL). */
  action: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface RepairReport {
  /** True when every attempted action succeeded AND re-verification is clean. */
  ok: boolean;
  actions: RepairAction[];
  durationMs: number;
  /** Verification re-run after the repairs. Repair is not believed on its own. */
  verified: IntegrityReport | null;
}

export type VerifyDepth = 'fast' | 'deep';

export interface VerifyOptions {
  depth?: VerifyDepth;
  /** Restrict to these probes. Default: all probes for the depth. */
  only?: IntegrityProbe[];
  /** Rows sampled per FTS index for the sentinel round-trip. Default 3
   *  (first / median / last rowid — damage is usually a suffix or prefix). */
  ftsSampleSize?: number;
  /** Baseline WAL identity captured at open, for the unlink check (BL-330). */
  walBaseline?: WalIdentity | null;
}

export interface RepairOptions {
  /** Probes whose findings may be repaired. Default: all repairable ones. */
  only?: IntegrityProbe[];
  /** Re-verify after repairing. Default true — a repair that is not verified
   *  is exactly the failure mode BL-347 shipped. */
  verify?: boolean;
}

// ── WAL identity (BL-330) ────────────────────────────────────────────────────

export interface WalIdentity {
  path: string;
  /** `false` when the `-wal` file does not exist at capture time. */
  present: boolean;
  dev: number | null;
  ino: number | null;
}

/**
 * Snapshot the identity (device + inode) of the store's WAL file.
 *
 * Captured at open and re-checked later. A `-wal` path that has vanished or
 * that now resolves to a DIFFERENT inode means the WAL we are still writing
 * through has been unlinked out from under us.
 *
 * Reproduced 2026-07-31 with `@tursodatabase/database@0.7.1`: unlink the WAL
 * mid-session, keep writing, then `close()`. The close returned **with no
 * error** and the reopened store had lost not just rows but the table itself
 * (`no such table: t`) — total silent loss of everything since the last
 * checkpoint. The control run (WAL left in place) retained 140/140.
 */
export function captureWalIdentity(dbPath: string | undefined): WalIdentity | null {
  if (!dbPath) return null;
  const walPath = dbPath + '-wal';
  try {
    const st = statSync(walPath);
    return { path: walPath, present: true, dev: st.dev, ino: st.ino };
  } catch {
    return { path: walPath, present: false, dev: null, ino: null };
  }
}

function probeWalIdentity(baseline: WalIdentity | null): IntegrityFinding | null {
  if (!baseline || !baseline.present) return null; // nothing to compare against
  const current = captureWalIdentity(baseline.path.replace(/-wal$/, ''));
  if (!current) return null;

  if (!current.present) {
    return {
      probe: 'wal_identity',
      object: baseline.path,
      status: 'damaged',
      detail:
        `WAL was unlinked while this connection holds it open (baseline ino=${baseline.ino}, ` +
        `path no longer exists). A graceful close() in this state discards every write ` +
        `since the last checkpoint, silently and without error.`,
      repairable: true,
      backlog: 'BL-330',
      probeValidated: true,
    };
  }
  if (current.ino !== baseline.ino || current.dev !== baseline.dev) {
    return {
      probe: 'wal_identity',
      object: baseline.path,
      status: 'damaged',
      detail:
        `WAL at ${baseline.path} was replaced underneath this connection ` +
        `(baseline dev=${baseline.dev} ino=${baseline.ino}, now dev=${current.dev} ino=${current.ino}). ` +
        `Writes are going to the orphaned inode and will be lost on close.`,
      repairable: true,
      backlog: 'BL-330',
      probeValidated: true,
    };
  }
  return {
    probe: 'wal_identity',
    object: baseline.path,
    status: 'ok',
    detail: `WAL identity stable (dev=${current.dev} ino=${current.ino}).`,
    repairable: false,
    backlog: 'BL-330',
    probeValidated: true,
  };
}

// ── sqlite_master introspection ──────────────────────────────────────────────

interface IndexRow {
  name: string;
  tbl_name: string;
  sql: string | null;
}

/** Objects the adapter must never try to reindex or count through. */
function isInternalObject(name: string): boolean {
  return name.startsWith('sqlite_') || name.startsWith('__turso_internal_');
}

/**
 * True for an index created with a custom index method (`USING fts`,
 * `USING backing_btree`, …). These are NOT btree indexes: `REINDEX` on the
 * table carrying one fails outright with *"REINDEX is not supported for custom
 * index methods without a backing btree"* (BL-337), and they cannot be counted
 * through with `INDEXED BY`.
 */
function isCustomMethodIndex(sql: string | null): boolean {
  return sql !== null && /\bUSING\s+\w+/i.test(sql);
}

function isFtsIndex(sql: string | null): boolean {
  return sql !== null && /\bUSING\s+fts\b/i.test(sql);
}

/**
 * Extract an index's partial predicate (the `WHERE …` tail) from its DDL.
 *
 * Returns `null` for a full index. The predicate is required by
 * {@link probeBtreeIndexes} — without it Turso silently declines to use a
 * partial index for the count and the probe becomes a tautology.
 */
export function parsePartialPredicate(sql: string | null): string | null {
  if (!sql) return null;
  // Walk to the close of the column list, then look for a trailing WHERE.
  const open = sql.indexOf('(');
  if (open < 0) return null;
  let depth = 0;
  let close = -1;
  for (let i = open; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return null;
  const tail = sql.slice(close + 1);
  const m = /^\s*WHERE\s+([\s\S]+?)\s*;?\s*$/i.exec(tail);
  return m ? (m[1] as string) : null;
}

/**
 * First indexed column of a `CREATE INDEX … ON t (a, b DESC)` statement, with
 * sort direction and collation stripped.
 *
 * Needed because the population probe orders by it — see
 * {@link probeBtreeIndexes} for why an `INDEXED BY` hint alone is not enough.
 */
export function parseFirstIndexedColumn(sql: string | null): string | null {
  if (!sql) return null;
  const open = sql.indexOf('(');
  if (open < 0) return null;
  let depth = 0;
  let close = -1;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return null;
  const first = sql.slice(open + 1, close).split(',')[0];
  if (first === undefined) return null;
  const cleaned = first
    .trim()
    .replace(/\s+(ASC|DESC)\s*$/i, '')
    .replace(/\s+COLLATE\s+\w+\s*$/i, '')
    .trim()
    .replace(/^["'`[]|["'`\]]$/g, '');
  return cleaned.length > 0 ? cleaned : null;
}

/** Column list of a Turso `CREATE INDEX … USING fts ("a","b")` statement. */
export function parseFtsColumns(sql: string | null): string[] {
  if (!sql) return [];
  const m = /\bUSING\s+fts\s*\(([^)]*)\)/i.exec(sql);
  if (!m) return [];
  return (m[1] as string)
    .split(',')
    .map((c) => c.trim().replace(/^["'`\[]|["'`\]]$/g, ''))
    .filter((c) => c.length > 0);
}

async function listIndexes(adapter: StoreAdapter): Promise<IndexRow[]> {
  const res = await adapter.executeAll<IndexRow>(
    `SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index'`,
  );
  return res.rows;
}

/**
 * Count rows through the TABLE btree, never through a secondary index.
 *
 * A bare `SELECT COUNT(*) FROM t` is not safe here: SQLite optimises it by
 * scanning the smallest available index, so on a store with an unpopulated
 * index the baseline itself reads 0 and the probe compares 0 against 0 and
 * declares the index healthy. Measured — this exact trap made the first
 * version of the probe report `fully populated (0/0)` on a table holding 40
 * rows. `ORDER BY rowid` forces the table btree on both engines.
 */
async function tableCount(adapter: StoreAdapter, table: string, where?: string): Promise<number | null> {
  try {
    const sql =
      `SELECT COUNT(*) AS c FROM (SELECT rowid FROM "${table}"` +
      (where ? ` WHERE ${where}` : '') +
      ` ORDER BY rowid)`;
    const r = await adapter.executeGet<{ c: number }>(sql);
    return r ? Number(r.c) : null;
  } catch {
    return null;
  }
}

/**
 * True when `EXPLAIN QUERY PLAN` for `sql` actually names `indexName`.
 *
 * This is the negative control for {@link probeBtreeIndexes}. Turso accepts
 * `INDEXED BY` on a partial index and then plans a plain table scan anyway;
 * without this check the probe would compare a table scan against itself and
 * report healthy for every partial index on the store.
 */
async function planUsesIndex(adapter: StoreAdapter, sql: string, indexName: string): Promise<boolean> {
  try {
    const plan = await adapter.executeAll<Record<string, unknown>>(`EXPLAIN QUERY PLAN ${sql}`);
    return plan.rows.some((row) =>
      Object.values(row).some((v) => typeof v === 'string' && v.includes(indexName)),
    );
  } catch {
    return false;
  }
}

// ── Probe: btree index population (BL-335) ───────────────────────────────────

/**
 * For every btree index in the store, compare the row count reached THROUGH
 * the index against the row count of the base table under the same predicate.
 *
 * A bulk insert that skipped index maintenance leaves the rows physically
 * present and readable while making them invisible to any query the planner
 * routes through the index — measured live as `integrity_check` reporting
 * "row N missing from index" across nine `node` indexes (BL-335).
 */
export async function probeBtreeIndexes(adapter: StoreAdapter): Promise<IntegrityFinding[]> {
  const findings: IntegrityFinding[] = [];
  const indexes = await listIndexes(adapter);
  const baseCounts = new Map<string, number | null>();

  for (const ix of indexes) {
    if (isInternalObject(ix.name)) continue;
    if (isFtsIndex(ix.sql)) continue; // handled by probeFtsIndexes
    if (ix.sql === null) continue; // auto-index (PK/UNIQUE) — no name to REINDEX
    if (isCustomMethodIndex(ix.sql)) {
      // Any other custom index method: not a btree, cannot be counted through.
      findings.push({
        probe: 'btree_index_populated',
        object: ix.name,
        status: 'unknown',
        detail: `Custom index method — not countable through INDEXED BY, and REINDEX on its table is unsupported (BL-337).`,
        repairable: false,
        backlog: 'BL-337',
        probeValidated: false,
      });
      continue;
    }

    const predicate = parsePartialPredicate(ix.sql);
    const key = ix.tbl_name + ' ' + (predicate ?? '');
    if (!baseCounts.has(key)) {
      baseCounts.set(key, await tableCount(adapter, ix.tbl_name, predicate ?? undefined));
    }
    const base = baseCounts.get(key) ?? null;
    if (base === null) {
      findings.push({
        probe: 'btree_index_populated',
        object: ix.name,
        status: 'unknown',
        detail: `Base table "${ix.tbl_name}" could not be counted; index population is unverified.`,
        repairable: false,
        backlog: 'BL-335',
        probeValidated: false,
      });
      continue;
    }

    const firstCol = parseFirstIndexedColumn(ix.sql);
    if (firstCol === null) {
      findings.push({
        probe: 'btree_index_populated',
        object: ix.name,
        status: 'unknown',
        detail: `Could not parse the indexed columns of "${ix.name}"; population is unverified.`,
        repairable: false,
        backlog: 'BL-335',
        probeValidated: false,
      });
      continue;
    }

    // Two things are mandatory here, both measured 2026-07-31:
    //  - the partial predicate, because Turso silently ignores `INDEXED BY` on
    //    a partial index and plans a bare table scan instead;
    //  - the `ORDER BY` on the leading indexed column, because `INDEXED BY`
    //    alone does not force a full-table scan through the index on either
    //    engine (better-sqlite3 planned `SCAN node` and returned the table's
    //    own count against a demonstrably empty index). Ordering by the
    //    indexed column makes the index the only way to avoid a sort, and both
    //    engines then plan `SCAN … USING COVERING INDEX`.
    const probeSql =
      `SELECT COUNT(*) AS c FROM (SELECT "${firstCol}" FROM "${ix.tbl_name}" INDEXED BY "${ix.name}"` +
      (predicate ? ` WHERE ${predicate}` : '') +
      ` ORDER BY "${firstCol}")`;

    const validated = await planUsesIndex(adapter, probeSql, ix.name);
    if (!validated) {
      findings.push({
        probe: 'btree_index_populated',
        object: ix.name,
        status: 'unknown',
        detail:
          `Query planner declined to use "${ix.name}" for the population probe ` +
          `(EXPLAIN QUERY PLAN did not name it), so a matching count would prove nothing.`,
        repairable: false,
        backlog: 'BL-335',
        probeValidated: false,
      });
      continue;
    }

    let viaIndex: number | null = null;
    try {
      const r = await adapter.executeGet<{ c: number }>(probeSql);
      viaIndex = r ? Number(r.c) : null;
    } catch {
      viaIndex = null;
    }

    if (viaIndex === null) {
      findings.push({
        probe: 'btree_index_populated',
        object: ix.name,
        status: 'unknown',
        detail: `Population probe through "${ix.name}" failed to execute.`,
        repairable: false,
        backlog: 'BL-335',
        probeValidated: false,
      });
    } else if (viaIndex !== base) {
      findings.push({
        probe: 'btree_index_populated',
        object: ix.name,
        status: 'damaged',
        detail:
          `Index "${ix.name}" on "${ix.tbl_name}" holds ${viaIndex} entries but the table has ` +
          `${base} matching rows — ${base - viaIndex} row(s) are invisible to every query the ` +
          `planner routes through it.`,
        repairable: true,
        backlog: 'BL-335',
        probeValidated: true,
      });
    } else {
      findings.push({
        probe: 'btree_index_populated',
        object: ix.name,
        status: 'ok',
        detail: `Index "${ix.name}" fully populated (${viaIndex}/${base}).`,
        repairable: false,
        backlog: 'BL-335',
        probeValidated: true,
      });
    }
  }

  return findings;
}

// ── Probe: FTS index liveness (BL-347) ───────────────────────────────────────

interface FtsTarget {
  /** Index name (Turso) or shadow table name (SQLite FTS5). */
  object: string;
  table: string;
  columns: string[];
}

async function discoverFtsTargets(adapter: StoreAdapter): Promise<FtsTarget[]> {
  const targets: FtsTarget[] = [];
  if (adapter.config.type === 'turso') {
    for (const ix of await listIndexes(adapter)) {
      if (!isFtsIndex(ix.sql)) continue;
      targets.push({ object: ix.name, table: ix.tbl_name, columns: parseFtsColumns(ix.sql) });
    }
    return targets;
  }
  // SQLite FTS5: an external-content virtual table `USING fts5(..., content='node')`.
  const res = await adapter.executeAll<{ name: string; sql: string | null }>(
    `SELECT name, sql FROM sqlite_master WHERE type='table' AND sql LIKE '%USING fts5%'`,
  );
  for (const row of res.rows) {
    if (isInternalObject(row.name)) continue;
    const contentMatch = /content\s*=\s*'([^']+)'/i.exec(row.sql ?? '');
    const colMatch = /\bUSING\s+fts5\s*\(([^)]*)\)/i.exec(row.sql ?? '');
    const columns = colMatch
      ? (colMatch[1] as string)
          .split(',')
          .map((c) => c.trim().replace(/^["'`]|["'`]$/g, ''))
          .filter((c) => c.length > 0 && !c.includes('='))
      : [];
    targets.push({ object: row.name, table: contentMatch ? (contentMatch[1] as string) : row.name, columns });
  }
  return targets;
}

/** Pick a token from `text` that a tokenizer will index as one term. */
export function pickSentinelToken(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const words = text.match(/[A-Za-z][A-Za-z]{5,19}/g);
  if (!words) return null;
  // Longest word — least likely to be a stop word or to be truncated.
  return words.reduce((a, b) => (b.length > a.length ? b : a));
}

/**
 * Round-trip a token taken from a specific row back through the FTS index and
 * assert THAT ROW is returned.
 *
 * This is the only sound FTS probe. Two cheaper ones were measured and both
 * fail as detectors:
 * - Tantivy backing-table row count reads `0` in both the healthy and the dead
 *   state.
 * - "does any query match anything" passes on the live damage, because the
 *   handful of rows written after the index was orphaned ARE indexed
 *   (`fts_match('the')` → 3 hits, while `fts_match('memory')` → 0 against 1074
 *   `LIKE` hits).
 *
 * Rows are sampled at the extremes and the middle of the rowid range, because
 * this damage class is a prefix (crash repair skipped the backfill) or a suffix
 * (writes after the index was orphaned).
 */
export async function probeFtsIndexes(
  adapter: StoreAdapter,
  sampleSize = 3,
): Promise<IntegrityFinding[]> {
  const findings: IntegrityFinding[] = [];
  const dialect = createFTSDialect(adapter.config.type);
  const targets = await discoverFtsTargets(adapter);

  for (const target of targets) {
    if (target.columns.length === 0) {
      findings.push({
        probe: 'fts_index_live',
        object: target.object,
        status: 'unknown',
        detail: `Could not parse indexed columns for "${target.object}"; liveness is unverified.`,
        repairable: false,
        backlog: 'BL-347',
        probeValidated: false,
      });
      continue;
    }

    const total = await tableCount(adapter, target.table);
    if (total === null || total === 0) {
      findings.push({
        probe: 'fts_index_live',
        object: target.object,
        status: 'ok',
        detail: `Base table "${target.table}" is empty — nothing to index.`,
        repairable: false,
        backlog: 'BL-347',
        probeValidated: false,
      });
      continue;
    }

    const textCol = target.columns[0] as string;
    // Sample rowids at the extremes and interior of the range.
    const samples: { rowid: number; text: unknown }[] = [];
    const orders = ['ASC', 'DESC'];
    for (const order of orders) {
      const r = await adapter.executeAll<{ rowid: number; t: unknown }>(
        `SELECT rowid AS rowid, "${textCol}" AS t FROM "${target.table}"
          WHERE "${textCol}" IS NOT NULL AND length("${textCol}") > 24
          ORDER BY rowid ${order} LIMIT 1`,
      );
      for (const row of r.rows) samples.push({ rowid: Number(row.rowid), text: row.t });
    }
    const extra = Math.max(0, sampleSize - samples.length);
    if (extra > 0 && total > 2) {
      const r = await adapter.executeAll<{ rowid: number; t: unknown }>(
        `SELECT rowid AS rowid, "${textCol}" AS t FROM "${target.table}"
          WHERE "${textCol}" IS NOT NULL AND length("${textCol}") > 24
          ORDER BY rowid ASC LIMIT ${extra} OFFSET ${Math.floor(total / 2)}`,
      );
      for (const row of r.rows) samples.push({ rowid: Number(row.rowid), text: row.t });
    }

    const usable = samples
      .map((s) => ({ rowid: s.rowid, token: pickSentinelToken(s.text) }))
      .filter((s): s is { rowid: number; token: string } => s.token !== null);

    if (usable.length === 0) {
      findings.push({
        probe: 'fts_index_live',
        object: target.object,
        status: 'unknown',
        detail: `No row in "${target.table}" yielded a usable sentinel token; liveness is unverified.`,
        repairable: false,
        backlog: 'BL-347',
        probeValidated: false,
      });
      continue;
    }

    const misses: number[] = [];
    let probeErr: string | null = null;
    for (const { rowid, token } of usable) {
      const match = dialect.matchClause(target.columns, '?');
      const sql =
        dialect.supportsShadowTable
          ? `SELECT COUNT(*) AS c FROM "${target.table}"
               JOIN "${target.object}" ON "${target.object}".rowid = "${target.table}".rowid
              WHERE "${target.table}".rowid = ? AND ${match.sql}`
          : `SELECT COUNT(*) AS c FROM "${target.table}" WHERE rowid = ? AND ${match.sql}`;
      try {
        const r = await adapter.executeGet<{ c: number }>(sql, [rowid, token]);
        if (!r || Number(r.c) === 0) misses.push(rowid);
      } catch (err) {
        probeErr = err instanceof Error ? err.message : String(err);
        break;
      }
    }

    if (probeErr !== null) {
      findings.push({
        probe: 'fts_index_live',
        object: target.object,
        status: 'damaged',
        detail: `FTS query against "${target.object}" failed outright: ${probeErr}`,
        repairable: true,
        backlog: 'BL-347',
        probeValidated: true,
      });
    } else if (misses.length > 0) {
      findings.push({
        probe: 'fts_index_live',
        object: target.object,
        status: 'damaged',
        detail:
          `${misses.length}/${usable.length} sentinel rows (rowid ${misses.join(', ')}) are present in ` +
          `"${target.table}" but NOT matchable through "${target.object}" using a token taken from ` +
          `their own indexed text. Keyword search is silently returning incomplete results.`,
        repairable: true,
        backlog: 'BL-347',
        probeValidated: true,
      });
    } else {
      findings.push({
        probe: 'fts_index_live',
        object: target.object,
        status: 'ok',
        detail: `All ${usable.length} sentinel rows round-tripped through "${target.object}".`,
        repairable: false,
        backlog: 'BL-347',
        probeValidated: true,
      });
    }
  }

  return findings;
}

// ── Probe: _adapter_meta uniqueness (BL-336) ─────────────────────────────────

/**
 * `_adapter_meta` is `(key TEXT PRIMARY KEY, value TEXT NOT NULL)`, yet the
 * live store carries six rows under three keys: a second stamp landed while
 * the unique index was inconsistent, so the constraint was not enforced. The
 * duplicates then make `REINDEX _adapter_meta` fail permanently with
 * `UNIQUE constraint failed`, and `DELETE` fails too — measured:
 * `Corrupt database: IdxDelete: no matching index entry found` — because the
 * rows have no index entry to remove. Only a table rebuild clears it.
 */
export async function probeAdapterMetaUnique(adapter: StoreAdapter): Promise<IntegrityFinding[]> {
  try {
    // `GROUP BY key` is the obvious query and it is WRONG here: both engines
    // resolve it through `sqlite_autoindex__adapter_meta_1`, the very index
    // whose inconsistency let the duplicates in, so it reports one row per key
    // on a table that visibly holds six rows under three keys (measured
    // 2026-07-31). Ordering by rowid forces the table btree instead. The table
    // holds a handful of rows, so counting in JS costs nothing.
    const all = await adapter.executeAll<{ key: string }>(
      `SELECT key FROM _adapter_meta ORDER BY rowid`,
    );
    const counts = new Map<string, number>();
    for (const row of all.rows) counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
    const dupes = [...counts.entries()].filter(([, c]) => c > 1);
    const res = { rows: dupes.map(([key, c]) => ({ key, c })) };
    if (res.rows.length === 0) {
      return [
        {
          probe: 'adapter_meta_unique',
          object: '_adapter_meta',
          status: 'ok',
          detail: 'One row per key.',
          repairable: false,
          backlog: 'BL-336',
          probeValidated: true,
        },
      ];
    }
    return [
      {
        probe: 'adapter_meta_unique',
        object: '_adapter_meta',
        status: 'damaged',
        detail:
          `Duplicate PRIMARY KEY rows in _adapter_meta: ` +
          res.rows.map((r) => `${r.key}×${r.c}`).join(', ') +
          `. This is schema-impossible and blocks REINDEX of the table.`,
        repairable: true,
        backlog: 'BL-336',
        probeValidated: true,
      },
    ];
  } catch {
    // Table absent (fresh store) — nothing to verify.
    return [];
  }
}

// ── Probe: PRAGMA integrity_check (deep, BL-341) ─────────────────────────────

/**
 * `wrong # of entries in index __turso_internal_fts_dir_<idx>_key` is emitted
 * by Turso's `integrity_check` on a **freshly created, fully working** FTS
 * index — measured 2026-07-31 on a clean store whose `fts_match` returned
 * 200/200. It is an unconditional false positive: treating integrity_check as
 * pass/fail on any Turso store carrying an FTS index reports damage forever.
 * Filtering it here is why {@link probeFtsIndexes} has to exist as the real
 * FTS check.
 */
export function isKnownFalsePositive(message: string): boolean {
  return /wrong # of entries in index __turso_internal_fts_dir_.*_key/i.test(message);
}

/**
 * `PRAGMA integrity_check` truncates at 100 messages, so "100 issues" means
 * "at least 100" and a repair loop that trusts the count under-repairs and
 * reports success (BL-341). Re-run after each repair round until the result is
 * stable rather than reading the count as a total.
 */
export async function probeIntegrityCheck(adapter: StoreAdapter): Promise<IntegrityFinding[]> {
  let rows: Record<string, unknown>[];
  try {
    const res = await adapter.executeAll<Record<string, unknown>>('PRAGMA integrity_check');
    rows = res.rows;
  } catch (err) {
    return [
      {
        probe: 'pragma_integrity_check',
        object: 'main',
        status: 'unknown',
        detail: `integrity_check unavailable on this backend: ${err instanceof Error ? err.message : String(err)}`,
        repairable: false,
        backlog: 'BL-341',
        probeValidated: false,
      },
    ];
  }

  const messages = rows
    .flatMap((r) => Object.values(r))
    .filter((v): v is string => typeof v === 'string')
    .flatMap((v) => v.split('\n'))
    .map((v) => v.trim())
    .filter((v) => v.length > 0 && v !== 'ok' && !v.startsWith('*** in database'));

  const real = messages.filter((m) => !isKnownFalsePositive(m));
  const capped = messages.length >= 100;

  if (real.length === 0) {
    return [
      {
        probe: 'pragma_integrity_check',
        object: 'main',
        status: 'ok',
        detail:
          messages.length === 0
            ? 'integrity_check clean.'
            : `integrity_check clean after filtering ${messages.length} known Turso FTS false positive(s).`,
        repairable: false,
        backlog: 'BL-341',
        probeValidated: true,
      },
    ];
  }

  // Group by the index name each message blames, so repair is targeted.
  // Page-accounting messages (`Page N: never used`, `Page N referenced
  // multiple times`) name no index and are NOT index damage — orphaned pages
  // are what a `DROP INDEX` leaves behind, and the only remedy is a `VACUUM`,
  // which is far too expensive and too disruptive to run unprompted on an
  // open. They are reported under a dedicated object so nobody mistakes 45
  // leaked pages for 45 corrupt index entries, and so a repair loop cannot
  // spin on something it has no action for.
  const byObject = new Map<string, string[]>();
  for (const m of real) {
    const nameMatch = /index\s+"?([A-Za-z0-9_]+)"?/i.exec(m);
    const obj = nameMatch ? (nameMatch[1] as string) : /^Page\s+\d+/i.test(m) ? 'page_accounting' : 'main';
    const list = byObject.get(obj) ?? [];
    list.push(m);
    byObject.set(obj, list);
  }

  return [...byObject.entries()].map(([object, msgs]) => ({
    probe: 'pragma_integrity_check' as const,
    object,
    status: 'damaged' as const,
    detail:
      object === 'page_accounting'
        ? `${msgs.length} page(s) are allocated but unreachable — free-space leakage, ` +
          `typically left by a DROP. No data is at risk; reclaim with an offline VACUUM. ` +
          `${msgs.slice(0, 3).join('; ')}${msgs.length > 3 ? ' …' : ''}`
        : `integrity_check reported ${msgs.length} issue(s) against "${object}"` +
          (capped ? ' (output hit the 100-message cap — the true count is higher)' : '') +
          `: ${msgs.slice(0, 3).join('; ')}${msgs.length > 3 ? ' …' : ''}`,
    repairable: !isInternalObject(object) && object !== 'main' && object !== 'page_accounting',
    backlog: 'BL-341',
    probeValidated: true,
  }));
}

// ── verifyStoreIntegrity ─────────────────────────────────────────────────────

/**
 * Run the integrity probes and report what is actually true about the store's
 * generated artifacts. Never mutates the store.
 */
export async function verifyStoreIntegrity(
  adapter: StoreAdapter,
  opts?: VerifyOptions,
): Promise<IntegrityReport> {
  const started = performance.now();
  const depth: VerifyDepth = opts?.depth ?? 'fast';
  const wanted = (p: IntegrityProbe): boolean => !opts?.only || opts.only.includes(p);
  const findings: IntegrityFinding[] = [];

  if (wanted('wal_identity')) {
    const f = probeWalIdentity(opts?.walBaseline ?? null);
    if (f) findings.push(f);
  }
  if (wanted('adapter_meta_unique')) findings.push(...(await probeAdapterMetaUnique(adapter)));
  if (wanted('btree_index_populated')) findings.push(...(await probeBtreeIndexes(adapter)));
  if (wanted('fts_index_live')) findings.push(...(await probeFtsIndexes(adapter, opts?.ftsSampleSize ?? 3)));
  if (depth === 'deep' && wanted('pragma_integrity_check')) {
    findings.push(...(await probeIntegrityCheck(adapter)));
  }

  const damaged = findings.filter((f) => f.status === 'damaged');
  const unknown = findings.filter((f) => f.status === 'unknown');
  return {
    // `ok` means "nothing was found broken". `unknown` is reported separately
    // and deliberately does NOT clear: a probe that could not be validated is
    // an absence of evidence, and callers that care must read `unknown`.
    ok: damaged.length === 0,
    depth,
    durationMs: Math.round((performance.now() - started) * 10) / 10,
    findings,
    damaged,
    unknown,
  };
}

// ── Repairs ──────────────────────────────────────────────────────────────────

/**
 * Rebuild `_adapter_meta` from scratch, keeping the EARLIEST row per key.
 *
 * `DELETE` cannot be used: with the unique index missing the duplicate rows'
 * entries, Turso raises `Corrupt database: IdxDelete: no matching index entry
 * found` (measured). Rebuilding sidesteps the broken index entirely, and the
 * earliest `created_at` is the meaningful one (first stamp wins).
 */
async function repairAdapterMeta(adapter: StoreAdapter): Promise<void> {
  const res = await adapter.executeAll<{ key: string; value: string }>(
    `SELECT key, value FROM _adapter_meta ORDER BY rowid`,
  );
  const keep = new Map<string, string>();
  for (const row of res.rows) if (!keep.has(row.key)) keep.set(row.key, row.value);

  await adapter.exec(`DROP TABLE IF EXISTS _adapter_meta_repair`);
  await adapter.exec(
    `CREATE TABLE _adapter_meta_repair (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  );
  for (const [k, v] of keep) {
    await adapter.executeRun(`INSERT INTO _adapter_meta_repair (key, value) VALUES (?, ?)`, [k, v]);
  }
  await adapter.exec(`DROP TABLE _adapter_meta`);
  await adapter.exec(`ALTER TABLE _adapter_meta_repair RENAME TO _adapter_meta`);
}

/**
 * Rebuild one FTS artifact.
 *
 * Turso: `DROP INDEX` then re-issue the dialect's `CREATE INDEX … USING fts`,
 * which backfills the whole table. Verified against the damaged live store
 * copy: 297 ms for 9 428 rows, after which `fts_match` returned 1148/136/84
 * against `LIKE` 1074/137/83 and the previously-dead rowid 1 matched.
 *
 * **The drop is not optional and it is the step whose omission caused BL-347**
 * — `CREATE INDEX IF NOT EXISTS` no-ops on the orphaned index and the store
 * stays dead. Whole-table `REINDEX` is not an alternative: it is rejected on
 * any table carrying a custom index method (BL-337).
 *
 * SQLite FTS5: the virtual table's own `'rebuild'` command, which is the
 * supported way to re-derive an external-content index.
 */
async function repairFtsIndex(adapter: StoreAdapter, target: FtsTarget): Promise<void> {
  const dialect = createFTSDialect(adapter.config.type);
  if (dialect.supportsShadowTable) {
    await adapter.exec(`INSERT INTO "${target.object}"("${target.object}") VALUES('rebuild')`);
    return;
  }
  await adapter.exec(`DROP INDEX IF EXISTS "${target.object}"`);
  // Turso can silently no-op a DROP against objects it does not own; confirm.
  const still = await adapter.executeGet<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE name = ?`,
    [target.object],
  );
  if (still) {
    throw new Error(
      `DROP INDEX "${target.object}" reported success but the index is still in sqlite_master — ` +
        `the rebuild cannot proceed (CREATE INDEX IF NOT EXISTS would no-op on it).`,
    );
  }
  const weights: Record<string, number> = {};
  for (const c of target.columns) weights[c] = 1.0;
  for (const ddl of dialect.createIndexDDL(target.table, target.columns, weights)) {
    await adapter.exec(ddl);
  }
}

/**
 * Apply repairs for the damaged findings in `report`, then re-verify.
 *
 * Every action targets a single named object. In particular btree indexes are
 * reindexed **individually by name** — `REINDEX <table>` is impossible on any
 * table carrying a Tantivy index (BL-337), and `node` is exactly such a table.
 */
export async function repairStoreIntegrity(
  adapter: StoreAdapter,
  report: IntegrityReport,
  opts?: RepairOptions,
): Promise<RepairReport> {
  const started = performance.now();
  const actions: RepairAction[] = [];
  const wanted = (p: IntegrityProbe): boolean => !opts?.only || opts.only.includes(p);

  const ftsTargets = new Map<string, FtsTarget>();
  if (report.damaged.some((f) => f.probe === 'fts_index_live')) {
    for (const t of await discoverFtsTargets(adapter)) ftsTargets.set(t.object, t);
  }

  for (const finding of report.damaged) {
    if (!finding.repairable || !wanted(finding.probe)) continue;
    const t0 = performance.now();
    const push = (action: string, ok: boolean, error?: string): void => {
      const entry: RepairAction = {
        probe: finding.probe,
        object: finding.object,
        action,
        ok,
        durationMs: Math.round((performance.now() - t0) * 10) / 10,
      };
      if (error !== undefined) entry.error = error;
      actions.push(entry);
    };

    try {
      switch (finding.probe) {
        case 'wal_identity':
          // Checkpointing copies the orphaned WAL's pages into the still-linked
          // main database file through the fd we already hold. Measured: full
          // recovery (140/140) versus total loss without it.
          await adapter.executeAll('PRAGMA wal_checkpoint(PASSIVE)');
          push('checkpointed orphaned WAL into the main database file', true);
          break;
        case 'adapter_meta_unique':
          await repairAdapterMeta(adapter);
          push('rebuilt _adapter_meta keeping the earliest row per key', true);
          break;
        case 'btree_index_populated':
        case 'pragma_integrity_check': {
          await adapter.exec(`REINDEX "${finding.object}"`);
          push(`reindexed "${finding.object}" individually`, true);
          break;
        }
        case 'fts_index_live': {
          const target = ftsTargets.get(finding.object);
          if (!target) {
            push('rebuild FTS index', false, `FTS target "${finding.object}" could not be resolved`);
            break;
          }
          await repairFtsIndex(adapter, target);
          push(`dropped and rebuilt FTS index "${finding.object}"`, true);
          break;
        }
      }
    } catch (err) {
      push('repair', false, err instanceof Error ? err.message : String(err));
    }
  }

  const verified =
    opts?.verify === false
      ? null
      : await verifyStoreIntegrity(adapter, { depth: report.depth });

  return {
    ok: actions.every((a) => a.ok) && (verified === null || verified.damaged.length === 0),
    actions,
    durationMs: Math.round((performance.now() - started) * 10) / 10,
    verified,
  };
}

// ── verifyAndRepair — the one call an adapter open makes ─────────────────────

export interface VerifyAndRepairOptions extends VerifyOptions {
  /** Skip repair and report only. Default false. */
  verifyOnly?: boolean;
  /** Called with a one-line summary for every damaged finding and every repair
   *  action. Damage must never be silent — the adapter has no logger of its
   *  own, so the caller supplies one. */
  onReport?: (event: 'damaged' | 'repaired' | 'repair_failed', detail: string) => void;
}

export interface VerifyAndRepairResult {
  verify: IntegrityReport;
  repair: RepairReport | null;
}

/**
 * Verify, and repair whatever is both damaged and repairable.
 *
 * This is what an adapter open calls. It is deliberately fail-soft — a store
 * that cannot be verified is still returned to the caller — but never silent:
 * every damaged finding is reported through `onReport`.
 */
export async function verifyAndRepair(
  adapter: StoreAdapter,
  opts?: VerifyAndRepairOptions,
): Promise<VerifyAndRepairResult> {
  const verify = await verifyStoreIntegrity(adapter, opts);
  for (const f of verify.damaged) opts?.onReport?.('damaged', `[${f.backlog}] ${f.object}: ${f.detail}`);

  if (opts?.verifyOnly === true || verify.damaged.length === 0 || adapter.config.readonly === true) {
    return { verify, repair: null };
  }

  const repair = await repairStoreIntegrity(adapter, verify);
  for (const a of repair.actions) {
    opts?.onReport?.(
      a.ok ? 'repaired' : 'repair_failed',
      `${a.object}: ${a.action}${a.error ? ` — ${a.error}` : ''} (${a.durationMs}ms)`,
    );
  }
  return { verify, repair };
}

// ── Reporting sink ───────────────────────────────────────────────────────────

export type IntegrityReportEvent = 'damaged' | 'repaired' | 'repair_failed';
export type IntegrityReportSink = (
  event: IntegrityReportEvent,
  detail: string,
  ctx: { dbPath: string | undefined },
) => void;

let reportSink: IntegrityReportSink | null = null;

/**
 * Route integrity events to the host's structured logger.
 *
 * Callers with a real logger (memory-core's `log.*`) should install one at
 * startup so these land in the same JSONL stream as everything else. Until
 * then the default writes to **stderr** — never stdout, which on an MCP stdio
 * server is the protocol channel.
 */
export function setIntegrityReportSink(sink: IntegrityReportSink | null): void {
  reportSink = sink;
}

/** Emit an integrity event. Damage is never allowed to be silent. */
export function emitIntegrityReport(
  dbPath: string | undefined,
  event: IntegrityReportEvent,
  detail: string,
): void {
  if (reportSink) {
    reportSink(event, detail, { dbPath });
    return;
  }
  try {
    process.stderr.write(
      JSON.stringify({ evt: `store.integrity.${event}`, db_path: dbPath, detail }) + '\n',
    );
  } catch {
    // A logging failure must never take down an open.
  }
}

// ── Last-report registry (for the status surface, BL-334) ────────────────────

const lastReports = new WeakMap<object, VerifyAndRepairResult>();

/**
 * Path-keyed mirror of {@link lastReports} (BL-367).
 *
 * Object identity is NOT a usable key across package boundaries here. The
 * result is recorded by the adapter against `this`, but `memory-core`'s
 * `openDb()` hands consumers `instrumentAdapter(adapter)` — a `Proxy`
 * (`libs/memory-core/src/db.ts:305`). A `Proxy` is a distinct identity, so
 * `WeakMap.get(proxy)` misses an entry set with the target and
 * `getLastIntegrityResult` returns `null` **forever** for every caller that
 * went through `openDb` — i.e. every real consumer, including `memory_ping`.
 * Verified: lookup by target FOUND, lookup by proxy `null`.
 *
 * That failure is silent and reads as "no pass has run", which is precisely the
 * BL-319 shape — an instrument wired to one path and invisible from the path
 * that reads it. Keying by `config.dbPath` as well fixes it structurally,
 * because `config` reads through the proxy unchanged. Same keying strategy as
 * `WriteQueue.metricsForPath`.
 *
 * Unbounded growth is not a concern: entries are one-per-store-path, and a
 * process opens a handful of stores at most.
 */
const lastReportsByPath = new Map<string, VerifyAndRepairResult>();

/** Wall-clock of the last pass per store path. `VerifyAndRepairResult` carries
 *  only a duration, and "how stale is this verdict?" is a question the status
 *  surface must be able to answer — a clean report from six hours ago is not
 *  the same claim as a clean report from this open. */
const lastReportAtByPath = new Map<string, number>();

/** Record the result of an integrity pass so a status surface can report it. */
export function recordIntegrityResult(adapter: StoreAdapter, result: VerifyAndRepairResult): void {
  lastReports.set(adapter as unknown as object, result);
  const dbPath = adapter.config.dbPath;
  if (dbPath !== undefined && dbPath !== '') {
    lastReportsByPath.set(dbPath, result);
    lastReportAtByPath.set(dbPath, Date.now());
  }
}

/** Epoch ms of the last integrity pass for a store path, or `null`. */
export function getLastIntegrityRunAt(dbPath: string | undefined): number | null {
  if (dbPath === undefined || dbPath === '') return null;
  return lastReportAtByPath.get(dbPath) ?? null;
}

/**
 * The most recent integrity pass for this adapter, or `null` if none has run.
 * `memory_ping`/`memory_stats` read this instead of re-probing (BL-334).
 *
 * Falls back to the path-keyed registry so a **proxied** adapter (the normal
 * case — see {@link lastReportsByPath}) resolves correctly. Callers do not have
 * to know whether they hold the real instance or a wrapper.
 */
export function getLastIntegrityResult(adapter: StoreAdapter): VerifyAndRepairResult | null {
  const direct = lastReports.get(adapter as unknown as object);
  if (direct !== undefined) return direct;
  const dbPath = adapter.config.dbPath;
  if (dbPath !== undefined && dbPath !== '') return lastReportsByPath.get(dbPath) ?? null;
  return null;
}

// ── Durable integrity status (BL-334) ────────────────────────────────────────

/**
 * `_adapter_meta` key holding the last integrity pass, as JSON.
 *
 * **The registries above are process-local and are NOT a sound home for status
 * data.** Two independent mechanisms make them invisible to a reader, both
 * measured on 2026-07-31:
 *
 * 1. **Proxy identity.** `memory-core`'s `openDb()` returns
 *    `instrumentAdapter(adapter)` — a `Proxy` (`libs/memory-core/src/db.ts:305`).
 *    `WeakMap.get(proxy)` misses an entry set against the target. Path keying
 *    fixes this one.
 * 2. **Two module instances.** `memory-core` compiles to CommonJS and reaches
 *    this package through `require('@adhd/sox-store-adapter')`
 *    (`libs/memory-core/dist/db.js:319`, the transpilation of its dynamic
 *    `import`), while an ESM consumer gets it through the ESM loader. Those are
 *    **separate instantiations with separate module-level `Map`s** — so an
 *    adapter opened via `openDb` records into one copy and `memory_ping` reads
 *    an empty other copy. Verified: a record written through `openDb` was
 *    invisible to a reader that imported the package directly, for both the
 *    WeakMap and the path-keyed Map. Path keying does NOT fix this one.
 *
 * A status field that silently reads "never ran" forever is the BL-319 failure
 * shape — an instrument wired to a path nobody reads. So the verdict is
 * persisted **into the store it describes**, which is immune to both mechanisms
 * (it is plain SQL through whatever handle the caller holds), survives a
 * process restart, and lets an operator ask "when was this last checked?" and
 * get a real answer rather than "some time since this process started".
 */
export const INTEGRITY_META_KEY = 'last_integrity';

/** A finding, flattened for the status surface. */
export interface IntegrityStatusFinding {
  probe: IntegrityProbe;
  object: string;
  status: IntegrityStatus;
  detail: string;
  backlog: string;
}

export interface IntegrityStatusSummary {
  /**
   * `ok` — a pass ran and found nothing damaged.
   * `damaged` — a pass ran and found damage (or repair failed).
   * `unknown` — **no pass has ever run, or it could not be read.**
   *
   * `unknown` is NOT healthy and must never be rendered as such. A store that
   * has never been verified is exactly the state BL-347 shipped in: the service
   * reported fine for a day while keyword search was dead.
   */
  verified: IntegrityStatus;
  /** ISO timestamp of the pass, or `null` when none has run. */
  checked_at: string | null;
  depth: VerifyDepth | null;
  duration_ms: number | null;
  /** Damaged and unverifiable findings, in full. Healthy ones are counted only. */
  findings: IntegrityStatusFinding[];
  ok_count: number;
  damaged_count: number;
  unknown_count: number;
  /** Repairs attempted during that pass. Empty when nothing needed repairing. */
  repaired: { object: string; action: string; ok: boolean; error?: string }[];
  /** `true`/`false` when a repair ran, `null` when none was needed. */
  repair_ok: boolean | null;
}

/** The shape returned when nothing has ever verified this store. */
export function unknownIntegrityStatus(): IntegrityStatusSummary {
  return {
    verified: 'unknown',
    checked_at: null,
    depth: null,
    duration_ms: null,
    findings: [],
    ok_count: 0,
    damaged_count: 0,
    unknown_count: 0,
    repaired: [],
    repair_ok: null,
  };
}

const MAX_STATUS_FINDINGS = 12;
const MAX_STATUS_DETAIL = 240;

/** Flatten a pass into the compact, persistable status shape. */
export function summarizeIntegrityResult(
  result: VerifyAndRepairResult,
  checkedAt: Date = new Date(),
): IntegrityStatusSummary {
  const { verify, repair } = result;
  // Prefer the POST-repair verification when one ran: reporting the pre-repair
  // damage as current state would show a healed store as broken.
  const effective = repair?.verified ?? verify;
  const notable = [...effective.damaged, ...effective.unknown].slice(0, MAX_STATUS_FINDINGS);

  return {
    verified: effective.damaged.length > 0 ? 'damaged' : 'ok',
    checked_at: checkedAt.toISOString(),
    depth: effective.depth,
    duration_ms: effective.durationMs,
    findings: notable.map((f) => ({
      probe: f.probe,
      object: f.object,
      status: f.status,
      detail: f.detail.length > MAX_STATUS_DETAIL ? f.detail.slice(0, MAX_STATUS_DETAIL) + '…' : f.detail,
      backlog: f.backlog,
    })),
    ok_count: effective.findings.filter((f) => f.status === 'ok').length,
    damaged_count: effective.damaged.length,
    unknown_count: effective.unknown.length,
    repaired: (repair?.actions ?? []).map((a) => {
      const entry: { object: string; action: string; ok: boolean; error?: string } = {
        object: a.object,
        action: a.action,
        ok: a.ok,
      };
      if (a.error !== undefined) entry.error = a.error;
      return entry;
    }),
    repair_ok: repair === null || repair === undefined ? null : repair.ok,
  };
}

/**
 * Persist the pass into `_adapter_meta`. Best-effort: a status write must never
 * fail an open, and a read-only handle must never attempt it.
 */
export async function persistIntegrityStatus(
  adapter: StoreAdapter,
  summary: IntegrityStatusSummary,
): Promise<void> {
  if (adapter.config.readonly === true) return;
  try {
    await adapter.executeRun(
      `INSERT INTO _adapter_meta(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [INTEGRITY_META_KEY, JSON.stringify(summary)],
    );
  } catch {
    // Non-fatal — the in-memory registries still hold this process's view.
  }
}

/**
 * Read the durable integrity verdict for the store behind `adapter`.
 *
 * Returns {@link unknownIntegrityStatus} when no pass has ever been recorded,
 * when the row cannot be read, or when it cannot be parsed — never a healthy
 * verdict inferred from absence.
 */
export async function readIntegrityStatus(adapter: StoreAdapter): Promise<IntegrityStatusSummary> {
  try {
    const row = await adapter.executeGet<{ value: string }>(
      `SELECT value FROM _adapter_meta WHERE key = ?`,
      [INTEGRITY_META_KEY],
    );
    if (row === null) return unknownIntegrityStatus();
    const parsed = JSON.parse(row.value) as IntegrityStatusSummary;
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.verified !== 'string') {
      return unknownIntegrityStatus();
    }
    return parsed;
  } catch {
    return unknownIntegrityStatus();
  }
}

/** The most recent integrity pass for a store path, or `null`. For callers that
 *  hold a path but no adapter handle. */
export function getLastIntegrityResultForPath(dbPath: string): VerifyAndRepairResult | null {
  return lastReportsByPath.get(dbPath) ?? null;
}

/** Test-only: drop the path-keyed registry so cases start from "never ran". */
export function _resetIntegrityRegistryForTest(): void {
  lastReportsByPath.clear();
  lastReportAtByPath.clear();
}

// ── Open-time policy ─────────────────────────────────────────────────────────

/**
 * Resolve the verification depth for an adapter open.
 *
 * - `SOX_STORE_VERIFY=off|fast|deep` overrides everything (default `fast`).
 * - `uncleanShutdown` escalates `fast` → `deep`: a store that was not closed
 *   cleanly is the exact population BL-338 is about, and 300 ms of
 *   `integrity_check` is cheap against another silent outage.
 */
export function resolveVerifyDepth(uncleanShutdown: boolean): VerifyDepth | 'off' {
  const raw = (process.env.SOX_STORE_VERIFY ?? '').toLowerCase();
  if (raw === 'off' || raw === 'none' || raw === '0') return 'off';
  if (raw === 'deep') return 'deep';
  if (raw === 'fast') return uncleanShutdown ? 'deep' : 'fast';
  return uncleanShutdown ? 'deep' : 'fast';
}

/** `SOX_STORE_REPAIR=off` disables automatic repair while leaving detection on. */
export function repairEnabled(): boolean {
  const raw = (process.env.SOX_STORE_REPAIR ?? '').toLowerCase();
  return !(raw === 'off' || raw === 'none' || raw === '0');
}

/**
 * The integrity pass an adapter runs on open.
 *
 * Fail-soft by construction: any throw is swallowed and recorded, because a
 * store that cannot be verified must still open. It is never SILENT — damage
 * and repairs go to `onReport`, and the result is retained for the status
 * surface via {@link getLastIntegrityResult}.
 *
 * Returns `null` when verification is switched off.
 */
export async function runOpenTimeIntegrity(
  adapter: StoreAdapter,
  opts: {
    uncleanShutdown: boolean;
    walBaseline: WalIdentity | null;
    onReport?: VerifyAndRepairOptions['onReport'];
  },
): Promise<VerifyAndRepairResult | null> {
  const depth = resolveVerifyDepth(opts.uncleanShutdown);
  if (depth === 'off') return null;

  try {
    const verifyOpts: VerifyAndRepairOptions = {
      depth,
      walBaseline: opts.walBaseline,
      verifyOnly: !repairEnabled(),
    };
    if (opts.onReport) verifyOpts.onReport = opts.onReport;
    const result = await verifyAndRepair(adapter, verifyOpts);
    recordIntegrityResult(adapter, result);
    await persistIntegrityStatus(adapter, summarizeIntegrityResult(result));
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    opts.onReport?.('repair_failed', `integrity pass aborted: ${message}`);
    // An aborted pass is `unknown`, never `ok`. Recording it as a finding
    // rather than an empty report is what stops `summarizeIntegrityResult`
    // from flattening "we could not check" into "nothing was wrong" — which is
    // the exact inference that let a dead FTS index read as healthy for a day.
    const aborted: IntegrityFinding = {
      probe: 'pragma_integrity_check',
      object: 'main',
      status: 'unknown',
      detail: `Integrity pass aborted before completing: ${message}`,
      repairable: false,
      backlog: 'BL-352',
      probeValidated: false,
    };
    const failed: VerifyAndRepairResult = {
      verify: {
        ok: false,
        depth,
        durationMs: 0,
        findings: [aborted],
        damaged: [],
        unknown: [aborted],
      },
      repair: null,
    };
    recordIntegrityResult(adapter, failed);
    const summary = summarizeIntegrityResult(failed);
    summary.verified = 'unknown';
    await persistIntegrityStatus(adapter, summary);
    return failed;
  }
}
