/**
 * Regression: SqliteGraphBackend.applySchema() must NEVER unconditionally run
 * fts5 DDL.
 *
 * The reported failure ("graph import is failing because fts5 is missing") is
 * applySchema() executing `CREATE VIRTUAL TABLE … USING fts5` + FTS_TRIGGERS +
 * a backfill INSERT against a Turso adapter, which rejects the DDL outright
 * (`Parse error: no such module: fts5`). FTS creation is dialect-driven via
 * store-adapter's FTSDialect: fts5 virtual table + triggers on SQLite
 * (capabilities.fts5), a Tantivy `CREATE INDEX … USING fts` on Turso
 * (capabilities.fts), nothing on a store with no FTS capability. The backfill
 * only applies to the fts5 shadow table.
 *
 * RED→GREEN: both tests fail against the unconditional-DDL code — the first
 * throws `Parse error: no such module: fts5` at applySchema(); the second
 * aborts at `CREATE UNIQUE INDEX IF NOT EXISTS node_uid_unique` on the second
 * open (Turso rejects IF NOT EXISTS on an existing index). Both pass with the
 * dialect-driven fix.
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

describe('applySchema on a Turso adapter (fts5-free open path)', () => {
  it('never executes fts5 DDL; creates the Tantivy index; store fully usable', async () => {
    if (!hasTursoDriver()) return; // Turso driver not installed — nothing to run against

    const dir = mkdtempSync(join(tmpdir(), 'graph-store-turso-'));
    const adapter = await createTursoAdapter({ dbPath: join(dir, 'graph.db') });
    try {
      const graph = createGraphBackend(adapter);
      // RED: this used to throw `Parse error: no such module: fts5`
      await graph.applySchema();

      // fts5 DDL must NOT have run — no fts_node virtual table, no fts triggers
      const ftsNode = await adapter.executeGet<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='fts_node'`,
      );
      expect(ftsNode).toBeNull();
      const ftsTriggers = await adapter.executeAll<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'fts_node_%'`,
      );
      expect(ftsTriggers.rows).toHaveLength(0);

      // The dialect must have created the Tantivy index instead
      const idx = await adapter.executeGet<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_fts_node'`,
      );
      expect(idx).toBeTruthy();

      // The store is fully usable on Turso: writes + FTS search
      await graph.writeNode('apple banana smoothie', {});
      await graph.writeNode('dog cat', {});
      const hits = await graph.searchNodes('apple');
      expect(hits.length).toBeGreaterThan(0);
      expect(typeof hits[0]!.score).toBe('number');
      expect(await graph.countNodesFts('apple')).toBeGreaterThan(0);
    } finally {
      await adapter.close();
    }
  }, 20000);

  it('re-opening an existing Turso store (second applySchema) is idempotent', async () => {
    if (!hasTursoDriver()) return;

    const dir = mkdtempSync(join(tmpdir(), 'graph-store-turso-'));
    const dbPath = join(dir, 'graph.db');

    let adapter = await createTursoAdapter({ dbPath });
    try {
      await createGraphBackend(adapter).applySchema();
    } finally {
      await adapter.close();
    }

    // Re-open: a fresh adapter + fresh backend over the SAME file. RED: the
    // second open used to abort at `CREATE UNIQUE INDEX IF NOT EXISTS
    // node_uid_unique` (Turso rejects IF NOT EXISTS on an existing index) —
    // the exact failure the installed backlog CLI hit live.
    adapter = await createTursoAdapter({ dbPath });
    try {
      const graph = createGraphBackend(adapter);
      await graph.applySchema();
      // No duplicate FTS index was built by the re-open
      const idxRows = await adapter.executeAll<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_fts%'`,
      );
      expect(idxRows.rows).toHaveLength(1);
    } finally {
      await adapter.close();
    }
  }, 20000);
});
