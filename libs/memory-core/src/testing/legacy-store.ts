/**
 * Test fixture: open a store whose schema predates BL-430.
 *
 * BL-430 added `CHECK (col IS NULL OR json_valid(col))` to `node.tags`,
 * `node.meta` and `edge.meta`, so a store created today **cannot** hold the
 * BL-342 shape (`tags = ''`). Two suites nevertheless have to put that shape
 * into a store on purpose:
 *
 * - `stats-bl343-row-resilience.spec.ts` — `memory_stats` must stay up on a
 *   store that already contains it (BL-343).
 * - `bl342-json-column-repair.spec.ts` — the integrity pass must *repair* it
 *   (BL-342).
 *
 * Both are about the population that already exists. `CREATE TABLE IF NOT
 * EXISTS` no-ops against an existing table, so no existing store acquires the
 * constraint, and none can without the FTS-bearing table rebuild that BL-313
 * already turned into a CRITICAL data-loss incident on this very store.
 *
 * So this helper does not defeat the constraint — it **declines to create it**,
 * by exactly the mechanism a real legacy store keeps its unconstrained schema:
 * the tables are created first from `GRAPH_DDL_PRE_BL430`, and `openDb`'s own
 * DDL then no-ops over them. There is no raw-SQL escape hatch, no test-only
 * pragma, and nothing here can weaken a store that does have the constraint.
 *
 * Excluded from the built library (`tsconfig.lib.json`) — test-only.
 *
 * @module
 */
import { GRAPH_DDL_PRE_BL430 } from '@adhd/sox-graph-store';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from '../db.js';

/**
 * Create the pre-BL-430 `node`/`edge` tables at `dbPath`, then hand back the
 * ordinary `openDb` handle every caller uses.
 *
 * Fails loudly if the fixture did not survive the open: a silently-constrained
 * store would make the seeds below fail for a reason that has nothing to do
 * with the contract under test.
 */
export async function openLegacyDb(dbPath: string): Promise<StoreAdapter> {
  const { createStoreAdapter } = await import('@adhd/sox-store-adapter');
  const seedAdapter = await createStoreAdapter({ dbPath });
  try {
    for (const stmt of GRAPH_DDL_PRE_BL430.split(';')) {
      if (stmt.trim().length > 0) await seedAdapter.exec(stmt);
    }
  } finally {
    await seedAdapter.close();
  }

  const db = await openDb(dbPath);
  const schema = await db.executeGet<{ sql: string }>(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='node'`,
  );
  if (schema === null || /json_valid/i.test(schema.sql)) {
    await db.close();
    throw new Error(
      `legacy fixture did not survive openDb — node.sql = ${schema?.sql ?? '<missing>'}`,
    );
  }
  return db;
}
