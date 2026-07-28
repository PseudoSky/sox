/**
 * Integration tests for migrateStore — cross-adapter data migration.
 *
 * Uses SqliteAdapterImpl with temporary files to exercise the full
 * migrateStore pipeline (sqlite_master enumeration, PRAGMA introspection,
 * batch INSERT, vec_node special handling).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAdapterImpl } from '../sqlite-adapter.js';
import { migrateStore } from '../migration.js';

// ── sqlite-vec availability ───────────────────────────────────────────────────

const hasVec = (() => {
  try {
    require.resolve('sqlite-vec');
    return true;
  } catch {
    return false;
  }
})();

const vecDescribe = hasVec ? describe : describe.skip;

// ── Temp directory setup ────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-migration-'));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helper ──────────────────────────────────────────────────────────────────

function tempPath(name: string): string {
  return join(tmpDir, name);
}

// ============================================================================
// 1. Basic migration — single table
// ============================================================================

describe('migrateStore — basic', () => {
  it('copies a single table with rows from source to target', async () => {
    const srcPath = tempPath('basic-src.db');
    const tgtPath = tempPath('basic-tgt.db');

    const source = new SqliteAdapterImpl(srcPath);
    const target = new SqliteAdapterImpl(tgtPath);

    try {
      await source.exec(
        'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)',
      );
      await source.executeRun('INSERT INTO users (name) VALUES (?)', ['Alice']);
      await source.executeRun('INSERT INTO users (name) VALUES (?)', ['Bob']);

      const result = await migrateStore(source, target);

      expect(result.tables['users']).toBeDefined();
      expect(result.totalRows).toBe(2);

      const targetRows = await target.executeAll(
        'SELECT * FROM users ORDER BY id',
      );
      expect(targetRows.rows).toHaveLength(2);
      expect(targetRows.rows[0]).toMatchObject({ name: 'Alice' });
      expect(targetRows.rows[1]).toMatchObject({ name: 'Bob' });
    } finally {
      await source.close();
      await target.close();
    }
  });

  it('handles an empty source table', async () => {
    const srcPath = tempPath('empty-src.db');
    const tgtPath = tempPath('empty-tgt.db');

    const source = new SqliteAdapterImpl(srcPath);
    const target = new SqliteAdapterImpl(tgtPath);

    try {
      await source.exec(
        'CREATE TABLE empty_table (col1 TEXT)',
      );

      const result = await migrateStore(source, target);

      expect(result.tables['empty_table']).toBeDefined();
      expect(result.tables['empty_table']!.rows).toBe(0);
    } finally {
      await source.close();
      await target.close();
    }
  });

  it('handles source with no user tables at all', async () => {
    const srcPath = tempPath('no-tables-src.db');
    const tgtPath = tempPath('no-tables-tgt.db');

    const source = new SqliteAdapterImpl(srcPath);
    const target = new SqliteAdapterImpl(tgtPath);

    try {
      await migrateStore(source, target);

      // No user tables — migration completes without error
    } finally {
      await source.close();
      await target.close();
    }
  });
});

// ============================================================================
// 2. Multiple tables
// ============================================================================

describe('migrateStore — multiple tables', () => {
  it('copies two tables with independent data', async () => {
    const srcPath = tempPath('multi-src.db');
    const tgtPath = tempPath('multi-tgt.db');

    const source = new SqliteAdapterImpl(srcPath);
    const target = new SqliteAdapterImpl(tgtPath);

    try {
      await source.exec('CREATE TABLE t1 (a INTEGER)');
      await source.exec('CREATE TABLE t2 (b TEXT)');
      await source.executeRun('INSERT INTO t1 (a) VALUES (?)', [10]);
      await source.executeRun('INSERT INTO t2 (b) VALUES (?)', ['hello']);

      const result = await migrateStore(source, target);

      expect(result.totalRows).toBe(2);
      expect(result.tables['t1']).toBeDefined();
      expect(result.tables['t2']).toBeDefined();

      const r1 = await target.executeAll('SELECT * FROM t1');
      expect(r1.rows).toEqual([{ a: 10 }]);

      const r2 = await target.executeAll('SELECT * FROM t2');
      expect(r2.rows).toEqual([{ b: 'hello' }]);
    } finally {
      await source.close();
      await target.close();
    }
  });
});

// ============================================================================
// 3. Internal tables are excluded
// ============================================================================

describe('migrateStore — internal table exclusion', () => {
  it('does not migrate _adapter_meta', async () => {
    const srcPath = tempPath('meta-src.db');
    const tgtPath = tempPath('meta-tgt.db');

    const source = new SqliteAdapterImpl(srcPath);
    const target = new SqliteAdapterImpl(tgtPath);

    try {
      // Create _adapter_meta table and stamp it
      await source.exec(
        'CREATE TABLE _adapter_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      );
      await source.executeRun(
        'INSERT INTO _adapter_meta (key, value) VALUES (?, ?)',
        ['adapter_type', 'sqlite'],
      );

      // Create a real user table
      await source.exec('CREATE TABLE real_data (id INTEGER)');
      await source.executeRun('INSERT INTO real_data (id) VALUES (?)', [1]);

      await migrateStore(source, target);

      // real_data should be in target
      const rd = await target.executeAll('SELECT * FROM real_data');
      expect(rd.rows).toHaveLength(1);

      // _adapter_meta has migration provenance stamped by migrateStore()
      // (migrated_from, migrated_at keys). The source's adapter_type row is NOT
      // copied — the stamp records the migration itself.
      const meta = await target.executeAll('SELECT * FROM _adapter_meta');
      const keys = meta.rows.map((r) => (r as Record<string, unknown>).key);
      expect(keys).toContain('migrated_from');
      expect(keys).toContain('migrated_at');
      expect(keys).not.toContain('adapter_type');
    } finally {
      await source.close();
      await target.close();
    }
  });
});

// ============================================================================
// 4. Migration result metadata
// ============================================================================

describe('migrateStore — result metadata', () => {
  it('reports source and target adapter types', async () => {
    const srcPath = tempPath('meta-report-src.db');
    const tgtPath = tempPath('meta-report-tgt.db');

    const source = new SqliteAdapterImpl(srcPath);
    const target = new SqliteAdapterImpl(tgtPath);

    try {
      await source.exec('CREATE TABLE t (x INTEGER)');
      await source.executeRun('INSERT INTO t (x) VALUES (?)', [1]);

      const result = await migrateStore(source, target);

      expect(result.sourceType).toBe('sqlite');
      expect(result.targetType).toBe('sqlite');
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    } finally {
      await source.close();
      await target.close();
    }
  });
});

// ============================================================================
// 5. Batch size option
// ============================================================================

describe('migrateStore — batch options', () => {
  it('respects batchSize option', async () => {
    const srcPath = tempPath('batch-src.db');
    const tgtPath = tempPath('batch-tgt.db');

    const source = new SqliteAdapterImpl(srcPath);
    const target = new SqliteAdapterImpl(tgtPath);

    try {
      await source.exec('CREATE TABLE t (x INTEGER)');
      for (let i = 0; i < 100; i++) {
        await source.executeRun('INSERT INTO t (x) VALUES (?)', [i]);
      }

      const progressMsgs: string[] = [];
      const result = await migrateStore(source, target, {
        batchSize: 20,
        onProgress: (msg) => progressMsgs.push(msg),
      });

      expect(result.totalRows).toBe(100);
      expect(result.tables['t']!.rows).toBe(100);
      // Should have at least 5 progress calls for 100 rows at batchSize=20
      expect(progressMsgs.length).toBeGreaterThanOrEqual(5);
    } finally {
      await source.close();
      await target.close();
    }
  });
});

// ============================================================================
// 6. vec_node migration (SqliteAdapter vec0 → SqliteAdapter vec0)
// ============================================================================

vecDescribe('migrateStore — vec_node', () => {
  it('copies vec_node virtual table from source to target via raw better-sqlite3', async () => {
    const srcPath = tempPath('vec-src');
    const tgtPath = tempPath('vec-tgt');

    const source = new SqliteAdapterImpl(srcPath);
    const target = new SqliteAdapterImpl(tgtPath);

    try {
      // Load sqlite-vec into the source's raw handle to create vec0 table
      const raw = source.unwrap() as import('better-sqlite3').Database;
      const sqliteVec = require('sqlite-vec');
      sqliteVec.load(raw);

      raw.exec(
        'CREATE VIRTUAL TABLE vec_node USING vec0(node_id INTEGER PRIMARY KEY, embedding FLOAT[4])',
      );

      // Insert vectors (vec0 auto-assigns node_id)
      const insert = raw.prepare('INSERT INTO vec_node(embedding) VALUES (?)');
      insert.run('[0.1,0.2,0.3,0.4]');
      insert.run('[0.5,0.6,0.7,0.8]');
      insert.run('[0.9,1.0,1.1,1.2]');

      // Also create a regular node table (vec_node references node rowids)
      raw.exec('CREATE TABLE node (rowid INTEGER PRIMARY KEY, uid TEXT)');
      raw.prepare('INSERT INTO node (rowid, uid) VALUES (?, ?)').run(1, 'uid-1');
      raw.prepare('INSERT INTO node (rowid, uid) VALUES (?, ?)').run(2, 'uid-2');
      raw.prepare('INSERT INTO node (rowid, uid) VALUES (?, ?)').run(3, 'uid-3');

      const srcCount = raw.prepare('SELECT COUNT(*) AS cnt FROM vec_node').get() as { cnt: number };
      expect(srcCount.cnt).toBe(3);

      const result = await migrateStore(source, target, {
        onProgress: () => {}, // suppress output
      });

      // vec_node must be in the result and have 3 rows
      expect(result.tables['vec_node']).toBeDefined();
      expect(result.tables['vec_node']!.rows).toBe(3);
      expect(result.tables['vec_node']!.errored).toBeFalsy();

      // vec_node shadow tables must NOT appear in result
      expect(result.tables['vec_node_info']).toBeUndefined();
      expect(result.tables['vec_node_chunks']).toBeUndefined();
      expect(result.tables['vec_node_rowids']).toBeUndefined();
      expect(result.tables['vec_node_vector_chunks00']).toBeUndefined();

      // Verify target has vec_node with correct data
      const targetRaw = target.unwrap() as import('better-sqlite3').Database;
      sqliteVec.load(targetRaw);

      const tgtCount = targetRaw.prepare('SELECT COUNT(*) AS cnt FROM vec_node').get() as { cnt: number };
      expect(tgtCount.cnt).toBe(3);

      const tgtData = targetRaw
        .prepare('SELECT node_id, embedding FROM vec_node ORDER BY node_id')
        .all() as Array<{ node_id: number; embedding: Buffer }>;

      expect(tgtData).toHaveLength(3);
      expect(tgtData[0]!.node_id).toBe(1);
      expect(tgtData[0]!.embedding.byteLength).toBe(16); // 4 floats × 4 bytes
      expect(tgtData[1]!.node_id).toBe(2);
      expect(tgtData[2]!.node_id).toBe(3);

      // Verify shadow tables were NOT in the migration RESULT (they are
      // auto-regenerated by sqlite-vec on the target vec0 DDL, so they WILL
      // exist on target -- the key is that migrateStore did not copy them as
      // regular tables, which is verified above by checking result.tables).
      // Also verify node and edge tables are present.
      const allTargetTables = targetRaw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      expect(allTargetTables.some(t => t.name === "node")).toBe(true);
      expect(allTargetTables.some(t => t.name === "vec_node")).toBe(true);
    } finally {
      await source.close();
      await target.close();
    }
  });

  it('handles source with vec_node table but zero vectors', async () => {
    const srcPath = tempPath('vec-empty-src');
    const tgtPath = tempPath('vec-empty-tgt');

    const source = new SqliteAdapterImpl(srcPath);
    const target = new SqliteAdapterImpl(tgtPath);

    try {
      const raw = source.unwrap() as import('better-sqlite3').Database;
      const sqliteVec = require('sqlite-vec');
      sqliteVec.load(raw);

      raw.exec(
        'CREATE VIRTUAL TABLE vec_node USING vec0(node_id INTEGER PRIMARY KEY, embedding FLOAT[4])',
      );

      const result = await migrateStore(source, target, {
        onProgress: () => {},
      });

      // vec_node should be in result with 0 rows (no error)
      expect(result.tables['vec_node']).toBeDefined();
      expect(result.tables['vec_node']!.rows).toBe(0);
      expect(result.tables['vec_node']!.errored).toBeFalsy();
    } finally {
      await source.close();
      await target.close();
    }
  });

  it('does not skip vec_node when SKIP_TABLES incorrectly contains vec_node (regression guard)', async () => {
    const srcPath = tempPath('vec-regression-src');
    const tgtPath = tempPath('vec-regression-tgt');

    const source = new SqliteAdapterImpl(srcPath);
    const target = new SqliteAdapterImpl(tgtPath);

    try {
      const raw = source.unwrap() as import('better-sqlite3').Database;
      const sqliteVec = require('sqlite-vec');
      sqliteVec.load(raw);

      raw.exec(
        'CREATE VIRTUAL TABLE vec_node USING vec0(node_id INTEGER PRIMARY KEY, embedding FLOAT[4])',
      );
      raw.prepare('INSERT INTO vec_node(embedding) VALUES (?)').run('[0.1,0.2,0.3,0.4]');

      const result = await migrateStore(source, target);

      // Must have vec_node in result (was previously silently skipped because
      // SKIP_TABLES contained 'vec_node', which fired before the name check)
      expect(result.tables['vec_node']).toBeDefined();
      expect(result.tables['vec_node']!.rows).toBe(1);
    } finally {
      await source.close();
      await target.close();
    }
  });
});
