/**
 * PKT-61 (BL-442) — the operator open-schema migration.
 *
 * See SPEC-PKT-61.md §5 for the full acceptance criteria this file proves, each with its RED
 * arm. Every fixture that inserts rows asserts `PRAGMA foreign_keys = ON` explicitly — that is
 * what makes the fixture prove the BL-313 cascade mechanism rather than a defanged variant of
 * it (a store with FK enforcement off would never exhibit the cascade at all).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { SqliteAdapterImpl, TursoAdapterImpl, ETursoNativeStore } from '@adhd/sox-store-adapter';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import {
  PRAGMAS,
  NODE_TABLE_DDL,
  EDGE_TABLE_DDL,
  NODE_TABLE_DDL_OPEN,
  EDGE_TABLE_DDL_OPEN,
  NODE_COLUMNS,
  EDGE_COLUMNS,
  FTS_DDL,
  FTS_TRIGGERS,
  rebuildTable,
} from './index.js';
import {
  migrateToOpenSchema,
  toUnsupportedBackendRefusal,
  UnsupportedBackendError,
  MigrationPreflightError,
  MigrationRolledBackError,
  StoreOpenElsewhereError,
} from './open-schema-migration.js';
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Temp directory ───────────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'graph-store-pkt61-'));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function tempPath(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpDir, `${label}-${suffix}.db`);
}

const openAdapters: Array<{ close: () => Promise<void> | void }> = [];
afterEach(async () => {
  while (openAdapters.length > 0) {
    const a = openAdapters.pop()!;
    try {
      await a.close();
    } catch {
      // already closed
    }
  }
});

function track<T extends { close: () => Promise<void> | void }>(adapter: T): T {
  openAdapters.push(adapter);
  return adapter;
}

// ── Fixture: 10 nodes, 90 all-pairs RELATES_TO edges, CLOSED CHECK ──────────
//
// Same shape and row counts as graph-store.spec.ts:533-546's 'BL-313 cascade-delete' test —
// a retargeting of an already-proven fixture, not a new invention (SPEC-PKT-61.md §5, AC-1).

async function seedClosedSchemaStore(adapter: StoreAdapter): Promise<{ nodeCount: number; edgeCount: number }> {
  for (const p of PRAGMAS) await adapter.exec(p);
  await adapter.exec(NODE_TABLE_DDL);
  await adapter.exec(EDGE_TABLE_DDL);
  await adapter.exec(FTS_DDL);
  await adapter.exec(FTS_TRIGGERS);

  expect(await adapter.pragmaGet<number>('foreign_keys')).toBe(1);

  const now = new Date().toISOString();
  for (let i = 1; i <= 10; i++) {
    // Content is deliberately >24 chars — `probeFtsIndexes` (store-adapter's backup-integrity
    // verification, which `backupTo()` runs) only samples rows whose indexed text exceeds 24
    // chars; a shorter fixture yields zero usable sentinel rows and reports `status: 'unknown'`,
    // which forces `backupTo()`'s `integrityReport.status` to `'unverified'` and makes every
    // migration in this suite abort at the backup-verification gate before ever reaching the
    // rebuild.
    await adapter.executeRun(
      `INSERT INTO node (rowid, uid, kind, content, t_created) VALUES (?, ?, 'episode', ?, ?)`,
      [i, `uid-${i}`, `sentinel content for fts probe row ${i}`, now],
    );
  }
  let edgeCount = 0;
  for (let i = 1; i <= 10; i++) {
    for (let j = 1; j <= 10; j++) {
      if (i !== j) {
        await adapter.executeRun(
          `INSERT INTO edge (src, dst, rel, t_created) VALUES (?, ?, 'RELATES_TO', ?)`,
          [i, j, now],
        );
        edgeCount++;
      }
    }
  }
  return { nodeCount: 10, edgeCount };
}

// ── AC-1 — BL-442 core: skipDrop-interleaved sequencing preserves edges; naive sequential does not ──

describe('AC-1 — rebuildTable sequencing (BL-442, BL-313 mechanism)', () => {
  it('RED — naive sequential (skipDrop: false) cascade-deletes every edge, the exact BL-313 failure', async () => {
    const adapter = track(new SqliteAdapterImpl(':memory:'));
    const { edgeCount: seeded } = await seedClosedSchemaStore(adapter);
    expect(seeded).toBe(90);

    // Each call's own default `skipDrop: false` drops its `_old` table before the other
    // rebuild has even started — the naive-sequential shape BL-313's incident had.
    await rebuildTable(adapter, 'node', NODE_TABLE_DDL_OPEN, NODE_COLUMNS, { skipDrop: false });
    await rebuildTable(adapter, 'edge', EDGE_TABLE_DDL_OPEN, EDGE_COLUMNS, { skipDrop: false });

    const row = await adapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM edge');
    // Observed and recorded per BL-225: this reports 0, reproducing BL-313's exact incident.
    expect(row!.c).toBe(0);
  });

  it('GREEN — skipDrop-interleaved sequencing (both rebuilds before either drop) preserves every edge', async () => {
    const adapter = track(new SqliteAdapterImpl(':memory:'));
    const { nodeCount: seededNodes, edgeCount: seededEdges } = await seedClosedSchemaStore(adapter);
    expect(seededNodes).toBe(10);
    expect(seededEdges).toBe(90);

    await adapter.transaction(async (tx) => {
      await rebuildTable(adapter, 'node', NODE_TABLE_DDL_OPEN, NODE_COLUMNS, { skipDrop: true, tx });
      await rebuildTable(adapter, 'edge', EDGE_TABLE_DDL_OPEN, EDGE_COLUMNS, { skipDrop: true, tx });
      await tx.exec('DROP TABLE node_old');
      await tx.exec('DROP TABLE edge_old');
    });

    const nodeRow = await adapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM node');
    const edgeRow = await adapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM edge');
    const relRows = await adapter.executeAll<{ rel: string; c: number }>(
      'SELECT rel, COUNT(*) AS c FROM edge GROUP BY rel',
    );
    expect(nodeRow!.c).toBe(10);
    expect(edgeRow!.c).toBe(90);
    expect(relRows.rows).toEqual([{ rel: 'RELATES_TO', c: 90 }]);
  });
});

// ── AC-2 — BL-442 end-to-end ─────────────────────────────────────────────────

describe('AC-2 — migrateToOpenSchema() end-to-end (BL-442)', () => {
  it('succeeds against the 90-edge fixture: matched before/after snapshots, CHECK actually gone', async () => {
    const dbPath = tempPath('ac2');
    const seeder = new SqliteAdapterImpl(dbPath);
    await seedClosedSchemaStore(seeder);
    await seeder.close();

    const result = await migrateToOpenSchema(dbPath);

    expect(result.status).toBe('migrated');
    expect(result.before).toEqual(result.after);
    expect(result.before.nodeCount).toBe(10);
    expect(result.before.edgeCount).toBe(90);
    expect(result.before.perRelation).toEqual({ RELATES_TO: 90 });

    const adapter = track(new SqliteAdapterImpl(dbPath));

    // Positive proof the CHECK is gone at the SQLite engine level, not just that the DDL text
    // changed — mirrors ensure-check-constraints.bl447.spec.ts:391-412's pattern.
    const now = new Date().toISOString();
    await expect(
      adapter.executeRun(
        `INSERT INTO node (uid, kind, content, t_created) VALUES (?, 'a-brand-new-consumer-kind', ?, ?)`,
        ['consumer-kind-uid', 'x', now],
      ),
    ).resolves.toBeDefined();
    await expect(
      adapter.executeRun(
        `INSERT INTO edge (src, dst, rel, t_created) VALUES (1, 2, 'A_BRAND_NEW_REL', ?)`,
        [now],
      ),
    ).resolves.toBeDefined();

    const nodeSql = await adapter.executeGet<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='node'`,
    );
    const edgeSql = await adapter.executeGet<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='edge'`,
    );
    expect(nodeSql!.sql).not.toContain('CHECK (kind IN (');
    expect(edgeSql!.sql).not.toContain('CHECK (rel IN (');

    expect(await adapter.pragmaGet<number>('foreign_keys')).toBe(1);
  });

  it('RED — before open-schema-migration.ts exists / is wired, this file fails to import', () => {
    // Standard TDD RED: this test file's own top-level import of `./open-schema-migration.js`
    // is the RED arm — written and run before that file existed, watched fail to even load,
    // then the implementation file was added and this suite began passing. Recorded as a
    // static assertion here so the requirement stays checked going forward.
    expect(typeof migrateToOpenSchema).toBe('function');
  });
});

// ── AC-3 — BL-442 rollback: forced post-commit mismatch triggers a real, verified restore ──────

describe('AC-3 — forced post-commit mismatch rollback (BL-442)', () => {
  it('rejects with MigrationRolledBackError and provably restores the pre-migration store', async () => {
    const dbPath = tempPath('ac3');
    const seeder = new SqliteAdapterImpl(dbPath);
    await seedClosedSchemaStore(seeder);
    await seeder.close();

    let caught: unknown;
    try {
      await migrateToOpenSchema(dbPath, { __test_forcePostCommitMismatch: true });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MigrationRolledBackError);
    const typed = caught as MigrationRolledBackError;
    const backupPath = typed.detail.backupPath;
    expect(existsSync(backupPath)).toBe(true);

    // Prove the two files now agree — not just that no exception was thrown.
    const restoredAdapter = track(new SqliteAdapterImpl(dbPath));
    const backupAdapter = track(new SqliteAdapterImpl(backupPath, { readonly: true }));

    const restoredNode = await restoredAdapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM node');
    const restoredEdge = await restoredAdapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM edge');
    const backupNode = await backupAdapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM node');
    const backupEdge = await backupAdapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM edge');
    expect(restoredNode).toEqual(backupNode);
    expect(restoredEdge).toEqual(backupEdge);
    expect(restoredNode!.c).toBe(10);
    expect(restoredEdge!.c).toBe(90);

    // The migration's own point is CHECK removal — restore must revert that too, proving a
    // real file-level reversion happened, not a no-op (the fixture's CHECK was closed to begin
    // with, so "restored" must mean "closed again", not "still open from a committed migrate").
    const restoredNodeSql = await restoredAdapter.executeGet<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='node'`,
    );
    expect(restoredNodeSql!.sql).toContain('CHECK (kind IN (');
  });
});

// ── AC-4 — BL-442 static unreachability from applySchema() ──────────────────

describe('AC-4 — static unreachability from applySchema() (BL-442)', () => {
  it('index.ts source text never mentions the migration module or function', () => {
    const indexPath = join(__dirname, 'index.ts');
    const source = readFileSync(indexPath, 'utf8');
    expect(source).not.toContain('open-schema-migration');
    expect(source).not.toContain('migrateToOpenSchema');
  });
});

// ── AC-5 — BL-442 refuses when the store is open elsewhere ──────────────────

describe('AC-5 — refuses while another connection holds the store open (BL-442)', () => {
  it('rejects quickly with StoreOpenElsewhereError while a second connection holds BEGIN IMMEDIATE; succeeds once released', async () => {
    const dbPath = tempPath('ac5');
    const seeder = new SqliteAdapterImpl(dbPath);
    await seedClosedSchemaStore(seeder);
    await seeder.close();

    const holder = track(new SqliteAdapterImpl(dbPath));
    await holder.exec('BEGIN IMMEDIATE');
    await holder.exec(`INSERT INTO node (uid, kind, content, t_created) VALUES ('holder-uid', 'episode', 'held', '${new Date().toISOString()}')`);

    const started = Date.now();
    let caught: unknown;
    try {
      await migrateToOpenSchema(dbPath);
    } catch (err) {
      caught = err;
    }
    const durationMs = Date.now() - started;

    expect(caught).toBeInstanceOf(StoreOpenElsewhereError);
    expect(durationMs).toBeLessThan(200);

    const nodeSql = await holder.executeGet<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='node'`,
    );
    expect(nodeSql!.sql).toContain('CHECK (kind IN (');

    await holder.exec('COMMIT');

    // Now that the second connection released its lock, the same call succeeds.
    const result = await migrateToOpenSchema(dbPath);
    expect(result.status).toBe('migrated');
  });
});

// ── AC-6 — BL-442 refuses on a Turso-formatted store ─────────────────────────

const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();
const tursoDescribe = hasTurso ? describe : describe.skip;

describe('AC-6 — refuses on a Turso-formatted store (BL-442)', () => {
  it('unit: toUnsupportedBackendRefusal() converts a real ETursoNativeStore without leaking the raw internal object name', () => {
    const raw = new ETursoNativeStore('/tmp/some-turso.db', new Error(
      'SqliteError: malformed database schema (__turso_internal_fts_dir_idx_fts_node_key) - near "USING": syntax error',
    ));

    const converted = toUnsupportedBackendRefusal(raw);
    expect(converted).toBeInstanceOf(UnsupportedBackendError);
    expect(converted!.message).toMatch(/BL-337/);
    expect(converted!.message).toMatch(/BL-361/);
    expect(converted!.message).not.toContain('__turso_internal_');

    expect(toUnsupportedBackendRefusal(new Error('some other error'))).toBeNull();
  });

  tursoDescribe('integration: a genuine Turso-native store is refused, untouched', () => {
    it('migrateToOpenSchema() rejects with UnsupportedBackendError; the file is untouched', async () => {
      const dbPath = tempPath('ac6-turso');

      const w = await TursoAdapterImpl.connect({ dbPath });
      await w.exec('CREATE TABLE node (id INTEGER PRIMARY KEY, content TEXT)');
      await w.executeRun('INSERT INTO node (id, content) VALUES (?, ?)', [1, 'hello world']);
      await w.exec('CREATE INDEX IF NOT EXISTS idx_fts_node ON "node" USING fts ("content")');
      await w.close();

      let caught: unknown;
      try {
        await migrateToOpenSchema(dbPath);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(UnsupportedBackendError);

      // Still opens/reads the same content via Turso — untouched.
      const verify = await TursoAdapterImpl.connect({ dbPath });
      const row = await verify.executeGet<{ content: string }>('SELECT content FROM node WHERE id = 1');
      expect(row!.content).toBe('hello world');
      await verify.close();
    });
  });
});

// ── Preflight / backup-abort typed-error surface sanity ─────────────────────

describe('typed-error surface sanity (BL-442)', () => {
  it('MigrationPreflightError on a non-existent path', async () => {
    await expect(migrateToOpenSchema(join(tmpDir, 'does-not-exist.db'))).rejects.toBeInstanceOf(
      MigrationPreflightError,
    );
  });
});
