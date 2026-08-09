/**
 * BL-461 (BL-498 review, CAVEAT 1): graph-store's applyFtsSchema must not
 * build a SECOND Turso FTS index on a store whose node table already carries
 * a healthy index under a non-canonical name.
 *
 * Why this can happen: Turso has no `ALTER INDEX … RENAME`, so when
 * store-adapter's fts-orphan-guard repairs a damaged Tantivy index it must
 * build the replacement under a *different* name (`idx_fts_node__r1`) — the
 * repaired index can never be moved back onto `idx_fts_node`. A creation path
 * that asks `CREATE INDEX IF NOT EXISTS idx_fts_node` is asking whether one
 * particular NAME is taken, and after such a repair the answer is "no" while
 * the table already carries a perfectly healthy FTS index. The result is a
 * second full-text index over the same columns: measured to coexist and
 * answer queries correctly, so the only symptom is permanently doubled write
 * and storage cost — silent. memory-core's openDb() already guards against
 * this (db.ts:603-622); the BL-498 dialect-gated applyFtsSchema did not.
 *
 * RED→GREEN: with the guard removed from applyFtsSchema this test fails —
 * the re-open issues `CREATE INDEX IF NOT EXISTS idx_fts_node` (canonical
 * name free after the repair) and sqlite_master shows TWO FTS indexes.
 * With the guard (resolveExistingFtsIndexName + canonicalFtsIndexName, the
 * same lookup memory-core uses) the existing `idx_fts_node__r1` is adopted
 * and creation is skipped: exactly one index remains.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTursoAdapter } from '@adhd/sox-store-adapter';
import { createGraphBackend } from './index.js';

function hasTursoDriver(): boolean {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
}

describe('applyFtsSchema on a Turso adapter whose FTS index is non-canonical (BL-461 duplicate-index guard)', () => {
  it('adopts the existing idx_fts_node__r1 index — never builds a second idx_fts_node', async () => {
    if (!hasTursoDriver()) return;

    const dir = mkdtempSync(join(tmpdir(), 'graph-store-fts-adoption-'));
    const dbPath = join(dir, 'graph.db');

    // Build a store whose node table's FTS index lives under the name the
    // orphan guard's rebuild actually leaves behind (`idx_fts_node__r1`,
    // store-adapter fts-orphan-guard.ts). This is the end state of a
    // memory-core open that repaired a damaged store, before graph-store
    // ever gets opened against it.
    let adapter = await createTursoAdapter({ dbPath });
    try {
      const graph = createGraphBackend(adapter);
      await graph.applySchema();
      await graph.writeNode('zebra meadow', {});
      // Simulate the orphan guard's repair: canonical index gone, healthy
      // replacement under the guard's own name.
      await adapter.exec('DROP INDEX IF EXISTS idx_fts_node');
      await adapter.exec(
        `CREATE INDEX IF NOT EXISTS idx_fts_node__r1 ON "node" USING fts ("content", "name", "summary") ` +
          `WITH (weights = 'content=1.0,name=1.0,summary=1.0')`,
      );
    } finally {
      await adapter.close();
    }

    // Re-open through graph-store. RED: applyFtsSchema used to issue
    // `CREATE INDEX IF NOT EXISTS idx_fts_node` after this repair — the
    // canonical name is free, so it built a SECOND full-text index over the
    // same columns. GREEN: it resolves the existing index name from
    // sqlite_master and adopts it — creation skipped, one index remains.
    adapter = await createTursoAdapter({ dbPath });
    try {
      const graph = createGraphBackend(adapter);
      await graph.applySchema();
      const ftsIndexes = await adapter.executeAll<{ name: string; sql: string | null }>(
        `SELECT name, sql FROM sqlite_master WHERE type='index' AND name LIKE 'idx_fts%'`,
      );
      expect(ftsIndexes.rows).toHaveLength(1);
      expect(ftsIndexes.rows[0]!.name).toBe('idx_fts_node__r1');
      // The adopted index is the live one — full-text search still works.
      expect(await graph.countNodesFts('zebra')).toBe(1);
      expect((await graph.searchNodes('zebra')).length).toBe(1);
    } finally {
      await adapter.close();
    }
  }, 20000);
});
