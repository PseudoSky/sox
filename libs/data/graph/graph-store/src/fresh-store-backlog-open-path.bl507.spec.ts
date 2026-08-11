/**
 * BL-507 — the fresh-store FTS contract, pinned on BOTH real engines.
 *
 * A fresh store opened through the exact `openGraphBacklogStore` sequence
 * (createStoreAdapter-equivalent → pragmaSet → createGraphBackend →
 * applySchema) must be fully writable, and the FTS materialisation must be
 * exactly the healthy set for its engine — never a torn/partial one, and
 * never a leftover from the OTHER engine.
 *
 * ## Why this pins "the malformed object" as EXPECTED (not a regression)
 *
 * The triage symptom `malformed database schema
 * (__turso_internal_fts_dir_idx_fts_node_key) - near "USING": syntax error`
 * comes from opening a Turso store with STOCK SQLite (sqlite3 CLI,
 * better-sqlite3). Root-caused 2026-08-11: the `_key` row is the HEALTHY
 * backing_btree index holding the Tantivy segments — stock SQLite cannot
 * parse `USING backing_btree`, so every schema-touching statement dies. The
 * object must exist (a Tantivy index without it is a panic-bomb, BL-361).
 * The sqlite adapter converts this into the typed `ETursoNativeStore` error
 * (BL-329); the preflight reads through `writable_schema` (BL-362). This
 * test pins: (a) writes+search work through the native engine, (b) the
 * internal object set is exactly the healthy 3-row materialisation with the
 * exact healthy SQL forms, (c) the stock-SQLite failure on a copy is the
 * documented one — so a future regression that creates a GENUINELY different
 * (broken) object shape is caught, while the healthy shape is codified.
 *
 * Real adapters only (better-sqlite3 + @tursodatabase/database); no mocks,
 * no env gates.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { SqliteAdapterImpl, TursoAdapterImpl } from '@adhd/sox-store-adapter';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { createGraphBackend } from './index.js';

const require = createRequire(import.meta.url);

const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();
const tursoDescribe = hasTurso ? describe : describe.skip;

/** The exact openGraphBacklogStore sequence, minus the env-driven factory. */
async function openBacklogStyleStore(
  makeAdapter: (dbPath: string) => Promise<StoreAdapter>,
  dbPath: string,
): Promise<StoreAdapter> {
  const adapter = await makeAdapter(dbPath);
  await adapter.pragmaSet('busy_timeout', 5000);
  const graph = createGraphBackend(adapter);
  await graph.applySchema();
  return adapter;
}

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'graph-store-bl507-fresh-'));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** The exact healthy Tantivy backing SQL forms (verified against the real
 *  driver). Stock SQLite chokes on the `_key` row's `USING backing_btree` —
 *  that is the documented healthy shape. */
const HEALTHY_TANTIVY_KEY_SQL =
  'CREATE INDEX IF NOT EXISTS __turso_internal_fts_dir_idx_fts_node_key ON ' +
  '__turso_internal_fts_dir_idx_fts_node USING backing_btree (path, chunk_no, bytes)';

tursoDescribe('BL-507 — fresh-store contract via the backlog open path (turso)', () => {
  it('writes+search work; the only internal objects are the healthy Tantivy materialisation; stock-SQLite failure on a copy is the documented one', async () => {
    const dbPath = join(tmpDir, `fresh-turso-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    const adapter = await openBacklogStyleStore((p) => TursoAdapterImpl.connect({ dbPath: p }), dbPath);
    try {
      const graph = createGraphBackend(adapter);

      // (a) Writes + search through the native engine.
      const id1 = await graph.writeNode('apple banana smoothie recipe', {});
      const id2 = await graph.writeNode('dog cat mouse', {});
      await graph.writeEdge(id1, id2, 'RELATES_TO', {});
      const hits = await graph.searchNodes('apple');
      expect(hits.length).toBeGreaterThan(0);

      // (b) The internal object set is exactly the healthy 3-row
      //     materialisation, with the exact healthy SQL forms.
      const { rows } = await adapter.executeAll<{ type: string; name: string; sql: string | null }>(
        `SELECT type, name, sql FROM sqlite_master WHERE name LIKE '%turso_internal%' OR name = 'idx_fts_node' ORDER BY name`,
        [],
      );
      expect(rows).toHaveLength(3);
      const byName = new Map(rows.map((r) => [r.name, r]));
      expect(byName.has('idx_fts_node')).toBe(true);
      expect(byName.has('__turso_internal_fts_dir_idx_fts_node')).toBe(true);
      expect(byName.get('__turso_internal_fts_dir_idx_fts_node_key')?.sql).toBe(HEALTHY_TANTIVY_KEY_SQL);

      // (c) Stock SQLite over a COPY fails with the documented BL-329 error —
      //     the triage symptom, pinned as EXPECTED for a healthy turso store.
      //     The copy is made via the adapter's own VACUUM INTO path (BL-385)
      //     so the WAL is fully checkpointed into the standalone file.
      const copy = join(tmpDir, `copy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
      // backupTo is optional on the StoreAdapter interface; both real
      // adapters implement it (BL-385), which is all this test exercises.
      await adapter.backupTo!(copy, { skipIntegrityCheck: true });
      const Database = require('better-sqlite3') as new (p: string) => {
        prepare(sql: string): { get(): unknown };
      };
      expect(() => {
        const db = new Database(copy);
        db.prepare('SELECT COUNT(*) FROM node').get();
      }).toThrow(/malformed database schema \(__turso_internal_fts_dir_idx_fts_node_key\)/);
    } finally {
      await adapter.close();
    }
  }, 30000);
});

describe('BL-507 — fresh-store contract via the backlog open path (sqlite FTS5)', () => {
  it('writes+search work; the FTS5 stack exists; NO turso-internal objects', async () => {
    const dbPath = join(tmpDir, `fresh-sqlite-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    const adapter = await openBacklogStyleStore(async (p) => new SqliteAdapterImpl(p), dbPath);
    try {
      const graph = createGraphBackend(adapter);
      const id1 = await graph.writeNode('apple banana smoothie recipe', {});
      const id2 = await graph.writeNode('dog cat mouse', {});
      await graph.writeEdge(id1, id2, 'RELATES_TO', {});
      const hits = await graph.searchNodes('apple');
      expect(hits.length).toBeGreaterThan(0);

      const fts5 = await adapter.executeAll<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE name = 'fts_node' OR name LIKE 'fts_node_%'`,
        [],
      );
      expect(fts5.rows.length).toBeGreaterThan(0);
      const tursoInternal = await adapter.executeAll<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE name LIKE '%turso_internal%'`,
        [],
      );
      expect(tursoInternal.rows).toHaveLength(0);
    } finally {
      await adapter.close();
    }
  }, 30000);
});
