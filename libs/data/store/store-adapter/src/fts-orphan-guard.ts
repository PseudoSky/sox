/**
 * (BL-461) In-process guard against the FTS orphan that aborts the host process.
 *
 * ## What this closes that `preflight.ts` cannot
 *
 * BL-361 shipped an out-of-band pre-flight (`preflight.ts`) that reads
 * `sqlite_master` through `better-sqlite3` before the Turso driver ever opens
 * the file. It is gated on a marker file written on open and cleared on an
 * orderly close, so it runs **only when the previous session did not close
 * cleanly** — a deliberate trade to keep a second native open off the hot MCP
 * open path. The hole that gate leaves is not theoretical: a store damaged
 * *during* a session that afterwards closed cleanly gets no pre-flight, and the
 * next open reaches `runOpenTimeIntegrity` → `probeFtsIndexes` → `fts_match`,
 * which does not throw — it panics in Rust and kills the host process with
 * SIGABRT.
 *
 * This module closes that hole from **inside** the already-open adapter. That
 * is possible because of a measurement BL-361 did not have (2026-08-05):
 * `connect()` does **not** panic, and neither does a `sqlite_master` read, an
 * `INSERT`, `CREATE INDEX … USING fts`, or `DROP INDEX`. **Exactly one
 * statement aborts the process: `fts_match` against the orphaned index.** So a
 * single `SELECT type, name, tbl_name, sql FROM sqlite_master` on the open
 * connection — issued before anything reaches `fts_match` — is a complete and
 * unconditional detector, at the cost of one already-cached schema read.
 *
 * The out-of-band pre-flight stays. It is the only defence left if a future
 * driver really does panic inside `connect()`, which is what BL-361 originally
 * believed.
 *
 * ## Repair order: BUILD the replacement, THEN destroy the orphan
 *
 * Measured on a copy of the live 108 MB / 10 272-node store:
 *
 * | step | cost |
 * |---|---|
 * | `DROP INDEX` | 3 ms |
 * | `CREATE INDEX … USING fts` (full rebuild + backfill) | 288 ms |
 * | a **second** FTS index built beside the live one, same column | 283 ms |
 *
 * A second FTS index on the same column is legal and coexists. `ALTER INDEX …
 * RENAME` **does not exist** in Turso (syntax error), so there is no rename
 * primitive and the replacement can never take the old index's name in place.
 *
 * The sequence is therefore: build a shadow index → verify its Tantivy backing
 * objects materialised → drop the orphan. The store is never without a usable
 * index, and a failed build costs nothing. Drop-first is the BL-235 pattern
 * transplanted into the database — destroying the only copy before knowing the
 * replacement builds — and is rejected here for the same reason.
 *
 * **The one exception, stated rather than hidden.** If the build fails, the
 * orphan is dropped anyway. An orphaned FTS index holds *nothing* — its Tantivy
 * segments are exactly the `sqlite_master` rows that went missing — so there is
 * no copy to preserve, and the alternative to dropping it is leaving a
 * statement in the schema that aborts this process on the next `fts_match`.
 * That fallback is reported as `repair_failed`, never as a repair.
 *
 * ## Why the index name has to be a lookup
 *
 * Because there is no rename, the replacement lives under a new name
 * (`idx_fts_node__r1`). Any consumer that hardcodes `idx_fts_node` would then
 * issue `CREATE INDEX IF NOT EXISTS idx_fts_node …` against a table that
 * already has a healthy FTS index under a different name, and get a **second**
 * full index — permanently doubled write cost, measured to coexist happily and
 * therefore silently. `resolveExistingFtsIndexName()` in `fts-dialect.ts` is
 * the fix: creation is conditioned on whether the *table* has an FTS index, not
 * on whether one particular *name* is taken. With that in place the swap is
 * genuinely gapless — one build, no window in which the store has no index.
 *
 * ## Scope — this repairs, it does not migrate
 *
 * The store already repairs itself at open (ADR-0007 / BL-352; the live deploy
 * on 2026-08-05 normalised 86 `json_empty_array_null` rows unprompted). This is
 * that same class of work: restoring a declared index to the state the DDL
 * already declares. It extends no schema and adds no vocabulary — those move
 * only by an opt-in operator command (D3), and nothing here may be generalised
 * into a migration path.
 *
 * @module
 */

import type { StoreAdapter } from './types.js';
import { parseFtsColumns } from './integrity.js';

/** One `sqlite_master` row, as this guard reads it. */
interface MasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

/** `CREATE INDEX … USING fts (…)` — the Tantivy-backed index form. */
function isTursoFtsIndexSql(sql: string | null): boolean {
  return sql !== null && /\busing\s+fts\s*\(/i.test(sql);
}

/**
 * The two backing objects Turso materialises for FTS index `name`.
 *
 * Identical to `preflight.ts`'s private helper. Kept as a second, deliberately
 * duplicated four-line function rather than a shared import: `preflight.ts`
 * must stay loadable with no adapter and no Turso driver present (it runs
 * *before* the driver opens), and this module must stay loadable where
 * `better-sqlite3` is not built. Coupling them would drag one module's native
 * requirements into the other's.
 */
function backingObjectNames(indexName: string): { table: string; key: string } {
  const table = `__turso_internal_fts_dir_${indexName}`;
  return { table, key: `${table}_key` };
}

/** An FTS index row whose Tantivy backing objects are missing. */
export interface OrphanedFtsIndex {
  /** The `sqlite_master` index name, e.g. `idx_fts_node`. */
  index: string;
  /** The table it is declared on. */
  table: string;
  /** Indexed columns, parsed from the DDL. Empty when unparseable. */
  columns: string[];
  /** Which backing objects are absent — the `_key` index is the one that panics. */
  missing: string[];
}

/**
 * Orphaned FTS indexes among a set of `sqlite_master` rows.
 *
 * Pure: no I/O, so the predicate is testable without a store. The condition is
 * "an FTS index row exists and **either** backing object is absent" — the
 * directory table's absence is merely a catchable corruption error, but both
 * shapes are repaired identically and both are collected.
 */
export function findOrphanedFtsIndexes(rows: readonly MasterRow[]): OrphanedFtsIndex[] {
  const present = new Set(rows.map((r) => r.name));
  const orphans: OrphanedFtsIndex[] = [];
  for (const row of rows) {
    if (row.type !== 'index' || !isTursoFtsIndexSql(row.sql)) continue;
    const backing = backingObjectNames(row.name);
    const missing = [backing.table, backing.key].filter((n) => !present.has(n));
    if (missing.length === 0) continue;
    orphans.push({
      index: row.name,
      table: row.tbl_name,
      columns: parseFtsColumns(row.sql),
      missing,
    });
  }
  return orphans;
}

/**
 * A free index name to build the replacement under.
 *
 * `idx_fts_node` → `idx_fts_node__r1`, and a second damage event on the already
 * renamed index gives `idx_fts_node__r2` rather than `…__r1__r1` — the suffix
 * is stripped before it is re-applied, so the name cannot grow without bound.
 */
export function nextShadowIndexName(orphan: string, taken: ReadonlySet<string>): string {
  const base = orphan.replace(/__r\d+$/, '');
  for (let n = 1; n < 1000; n++) {
    const candidate = `${base}__r${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}__r${Date.now()}`;
}

/** What one orphan's repair did. */
export interface FtsOrphanRepair {
  /** The orphaned index that was removed. */
  orphan: string;
  /** The replacement built before it was removed, or `null` if the build failed. */
  built: string | null;
  /** Was the orphan actually gone from `sqlite_master` afterwards? */
  dropped: boolean;
  /** Set when the replacement could not be built (the orphan is still dropped — see the module docs). */
  buildError: string | null;
  /** Set when the orphan itself could not be dropped: the store is STILL a panic bomb. */
  dropError: string | null;
  /** Milliseconds spent building the replacement. */
  buildMs: number;
}

/** Outcome of {@link guardOrphanedFtsIndexes}. */
export interface FtsOrphanGuardResult {
  /** Did the `sqlite_master` scan run? `false` ⇒ see {@link skipped}. */
  ran: boolean;
  /** Why the scan did not run. */
  skipped: string | null;
  /** Orphans found. Non-empty ⇒ this store would have aborted the process. */
  orphaned: OrphanedFtsIndex[];
  /** Repairs attempted, in order. Empty when `repair` was not requested. */
  repairs: FtsOrphanRepair[];
}

/** True when every orphan found was repaired without error. */
export function guardSucceeded(result: FtsOrphanGuardResult): boolean {
  return (
    result.orphaned.length > 0 &&
    result.repairs.length === result.orphaned.length &&
    result.repairs.every((r) => r.dropped && r.dropError === null && r.buildError === null)
  );
}

/**
 * Detect — and, when writable, repair — orphaned FTS indexes on an open adapter,
 * before anything issues the `fts_match` that would abort the process (BL-461).
 *
 * Never throws. A guard that can itself break an open is worse than no guard;
 * every failure degrades to a reported outcome. Callers decide what to log.
 *
 * @param adapter an already-open adapter. Only `sqlite_master` is read until an
 *   orphan is actually found, so the cost on a healthy store is one schema read.
 * @param opts.repair build-and-swap when true; detect only when false.
 */
export async function guardOrphanedFtsIndexes(
  adapter: StoreAdapter,
  opts: { repair?: boolean } = {},
): Promise<FtsOrphanGuardResult> {
  const result: FtsOrphanGuardResult = { ran: false, skipped: null, orphaned: [], repairs: [] };

  let rows: MasterRow[];
  try {
    const res = await adapter.executeAll<MasterRow>(
      `SELECT type, name, tbl_name, sql FROM sqlite_master`,
    );
    rows = res.rows;
  } catch (err) {
    result.skipped = `could not read sqlite_master: ${
      err instanceof Error ? err.message : String(err)
    }`;
    return result;
  }

  result.ran = true;
  result.orphaned = findOrphanedFtsIndexes(rows);
  if (result.orphaned.length === 0 || opts.repair !== true) return result;

  const taken = new Set(rows.map((r) => r.name));

  for (const orphan of result.orphaned) {
    const repair: FtsOrphanRepair = {
      orphan: orphan.index,
      built: null,
      dropped: false,
      buildError: null,
      dropError: null,
      buildMs: 0,
    };

    // ── 1. BUILD the replacement first. A failure here costs nothing. ────────
    if (orphan.columns.length === 0) {
      repair.buildError =
        `could not parse indexed columns from the DDL of "${orphan.index}", so no equivalent ` +
        `index can be built`;
    } else {
      const shadow = nextShadowIndexName(orphan.index, taken);
      const cols = orphan.columns.map((c) => `"${c}"`).join(', ');
      const weights = orphan.columns.map((c) => `${c}=1`).join(',');
      const t0 = performance.now();
      try {
        await adapter.exec(
          `CREATE INDEX "${shadow}" ON "${orphan.table}" USING fts (${cols}) ` +
            `WITH (weights = '${weights}')`,
        );
        // Turso can report a DDL success it did not perform. "Built" means the
        // index row AND both Tantivy backing objects are in `sqlite_master`  —
        // exactly the condition whose absence defines the orphan we are here to
        // replace, so accepting anything weaker would build another one.
        const backing = backingObjectNames(shadow);
        const check = await adapter.executeAll<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE name IN (?, ?, ?)`,
          [shadow, backing.table, backing.key],
        );
        const got = new Set(check.rows.map((r) => r.name));
        const absent = [shadow, backing.table, backing.key].filter((n) => !got.has(n));
        if (absent.length > 0) {
          repair.buildError = `CREATE INDEX "${shadow}" reported success but ${absent.join(
            ', ',
          )} is not in sqlite_master`;
        } else {
          repair.built = shadow;
          taken.add(shadow);
          taken.add(backing.table);
          taken.add(backing.key);
        }
      } catch (err) {
        repair.buildError = err instanceof Error ? err.message : String(err);
      }
      repair.buildMs = Math.round((performance.now() - t0) * 10) / 10;
    }

    // ── 2. Destroy the orphan. Unconditional, and the module docs say why: an
    //       orphan holds no data, and leaving it in the schema aborts this
    //       process on the next `fts_match`. ─────────────────────────────────
    try {
      await adapter.exec(`DROP INDEX IF EXISTS "${orphan.index}"`);
      const still = await adapter.executeGet<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE name = ?`,
        [orphan.index],
      );
      if (still) {
        repair.dropError =
          `DROP INDEX "${orphan.index}" reported success but the row is still in sqlite_master — ` +
          `the next fts_match on this store will still abort the process`;
      } else {
        repair.dropped = true;
        taken.delete(orphan.index);
      }
    } catch (err) {
      repair.dropError = err instanceof Error ? err.message : String(err);
    }

    result.repairs.push(repair);
  }

  return result;
}

/**
 * One human-readable line for a guard run that found something.
 *
 * The reclassification clause is inherited from `preflight.ts` and is not
 * decoration: BL-361's load-bearing question — whether a crash can produce this
 * state *naturally* — is still open. It has only ever been produced
 * deliberately. If this line is emitted by a store nobody damaged by hand, that
 * question is answered and the item is HIGH.
 */
export function describeFtsOrphanGuard(result: FtsOrphanGuardResult): string {
  const names = result.orphaned.map((o) => o.index).join(', ');
  const head =
    `[BL-461] FTS index(es) ${names} have no Tantivy backing objects; the next fts_match on this ` +
    `store would have PANICKED the driver and aborted this process`;

  if (result.repairs.length === 0) {
    return (
      `${head}. Detected in process on the open connection; NOT repaired (read-only). ` +
      `If nobody damaged this store by hand, BL-361 is reachable naturally and reclassifies to HIGH.`
    );
  }

  const parts = result.repairs.map((r) => {
    if (r.dropError !== null) return `"${r.orphan}": DROP FAILED — ${r.dropError}`;
    if (r.built === null) {
      return (
        `"${r.orphan}": replacement could NOT be built (${r.buildError}); dropped the orphan ` +
        `anyway because it holds no data and leaving it aborts this process — full-text search ` +
        `is DOWN on "${r.orphan}" until the schema DDL rebuilds it`
      );
    }
    return `"${r.orphan}" → rebuilt as "${r.built}" in ${r.buildMs} ms, then dropped`;
  });

  return (
    `${head}. Repaired in process, replacement built BEFORE the orphan was destroyed: ` +
    `${parts.join('; ')}. If nobody damaged this store by hand, BL-361 is reachable naturally ` +
    `and reclassifies to HIGH — say so on the item.`
  );
}
