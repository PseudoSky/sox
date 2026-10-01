/**
 * (BL-507, BL-461) The shared in-session destroy path for an orphaned Turso
 * FTS index — the one route that works on every driver version.
 *
 * ## Why this module exists
 *
 * On `@tursodatabase/database` >= 0.8.1, every in-process route to remove an
 * FTS index whose `_key` sqlite_master backing row is already missing is
 * REFUSED outright:
 *
 * - `DROP INDEX` throws `Internal error: FTS backing store
 *   __turso_internal_fts_dir_<idx>_key not found` — and leaves BOTH the index
 *   row and the directory table in `sqlite_master`.
 * - `DROP TABLE` on the system table is a parse error.
 * - `DELETE FROM sqlite_master` is refused even under
 *   `PRAGMA writable_schema = ON`.
 *
 * The ONLY working route is the existing better-sqlite3 out-of-band hatch,
 * {@link preflight.deleteSchemaRowsViaBetterSqlite3} — a classic-engine open
 * that can `DELETE FROM sqlite_master` while NO turso connection holds the
 * file. Both `verifyTursoFtsMaterialization` (`fts-ops.ts`, BL-507) and the
 * orphan guard (`fts-orphan-guard.ts`, BL-461) route their destroy through
 * {@link destroyOrphanedFtsIndex}, which prefers that hatch when the caller
 * supplies a {@link FtsRepairContext} and otherwise makes an honest in-place
 * attempt whose failure is surfaced — never swallowed.
 *
 * Do not abstract further: the guard's build-BEFORE-destroy ordering and
 * `ensureFtsIndex`'s re-CREATE stay local to their callers; only the destroy
 * is shared.
 *
 * @module
 */
import { deleteSchemaRowsViaBetterSqlite3 } from './preflight.js';
import type { StoreAdapter } from './types.js';

/**
 * The connection-closing seam a caller supplies so the out-of-band hatch can
 * run while NO turso connection holds the store file open. Production turso
 * always supplies one (its own `withConnectionClosedForRepair`); an absent
 * context means the caller has no way to safely close/reopen and must make do
 * with an in-place attempt.
 */
export interface FtsRepairContext {
  dbPath: string;
  withConnectionClosedForRepair<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * The three `sqlite_master` rows a Turso Tantivy FTS index materialises:
 * the index row itself, Turso's internal directory table, and the `_key`
 * backing_btree index that holds the segments. `names[0]` is always the index
 * name the in-place `DROP INDEX` targets.
 */
export function tursoFtsMaterializationNames(indexName: string): string[] {
  const dir = `__turso_internal_fts_dir_${indexName}`;
  return [indexName, dir, `${dir}_key`];
}

/**
 * The in-place route is UNAVAILABLE — not "nothing to remove". The index row
 * is still present; only the out-of-band hatch can remove it.
 */
export function isOrphanBackingAbsentError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /FTS backing store .* not found/i.test(msg) ||
    /index .*_key for table .* not found/i.test(msg)
  );
}

/**
 * Genuinely nothing to remove — the index row has already been consumed.
 */
export function isAlreadyConsumedResidueError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /sqlite_schema contains index for missing table/i.test(msg);
}

/**
 * A failed out-of-band repair. Thrown from inside the `withConnectionClosedForRepair`
 * callback so the reopen is skipped and the open fails loudly, rather than
 * reopening into the `fts_match` at open-time integrity that would panic on a
 * still-orphaned index.
 */
export class FtsRepairFailedError extends Error {
  constructor(readonly failure: string) {
    super(`[BL-507] out-of-band FTS schema repair failed: ${failure}`);
    this.name = 'FtsRepairFailedError';
  }
}

export type OrphanDestroyOutcome =
  | { ok: true; via: 'nothing-to-remove' }
  | { ok: true; via: 'out-of-band'; dropped: string[] }
  | { ok: false; reason: 'in-place-route-unavailable' | 'failed'; error: string };

/**
 * Destroy an orphaned Turso FTS index (and, out-of-band, its two backing rows).
 *
 * - With a {@link FtsRepairContext}, the hatch runs while the connection is
 *   closed; a hatch failure throws {@link FtsRepairFailedError} (the reopen is
 *   skipped), an empty drop is `nothing-to-remove`, and a real drop is
 *   `out-of-band`.
 * - Without one, an in-place `DROP INDEX` is attempted: a backing-absent error
 *   reports `in-place-route-unavailable` (NOT a success), an already-consumed
 *   residue reports `nothing-to-remove`, and anything else reports `failed`
 *   raw. A drop that reports success but leaves the row is `failed`.
 */
export async function destroyOrphanedFtsIndex(
  adapter: StoreAdapter,
  names: readonly string[],
  ctx: FtsRepairContext | undefined,
): Promise<OrphanDestroyOutcome> {
  const indexName = names[0] as string;
  if (ctx !== undefined) {
    return ctx.withConnectionClosedForRepair(async () => {
      const result = deleteSchemaRowsViaBetterSqlite3(ctx.dbPath, names);
      if (result.failed !== null) {
        throw new FtsRepairFailedError(result.failed);
      }
      if (result.dropped.length === 0) {
        return { ok: true as const, via: 'nothing-to-remove' as const };
      }
      return { ok: true as const, via: 'out-of-band' as const, dropped: result.dropped };
    });
  }
  try {
    await adapter.exec(`DROP INDEX IF EXISTS "${indexName}"`);
  } catch (err) {
    if (isOrphanBackingAbsentError(err)) {
      return {
        ok: false,
        reason: 'in-place-route-unavailable',
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (isAlreadyConsumedResidueError(err)) {
      return { ok: true, via: 'nothing-to-remove' };
    }
    return {
      ok: false,
      reason: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const still = await adapter.executeGet<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE name = ?`,
    [indexName],
  );
  if (still) {
    return {
      ok: false,
      reason: 'failed',
      error: `DROP INDEX "${indexName}" reported success but the index row is still present in sqlite_master`,
    };
  }
  // In-place success — only reachable on an adapter whose engine honours a
  // plain DROP (never production turso 0.8.1). Folded under 'out-of-band' so
  // the caller's `dropped` flag reads true; the two-valued `via` vocabulary is
  // deliberate.
  return { ok: true, via: 'out-of-band', dropped: [indexName] };
}
