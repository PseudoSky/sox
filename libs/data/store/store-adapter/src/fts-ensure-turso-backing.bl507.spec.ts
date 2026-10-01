/**
 * BL-507 — `ensureFtsIndex`'s Turso branch must never report `ensured: true`
 * while the Tantivy backing is incompletely materialised.
 *
 * ## Background (root-caused in .worktrees/c-fix-fts, 2026-08-11)
 *
 * A healthy Tantivy FTS index is THREE `sqlite_master` rows: the index row
 * (`idx_fts_node`), Turso's internal directory table
 * (`__turso_internal_fts_dir_idx_fts_node`) and the `_key` backing_btree
 * index (`__turso_internal_fts_dir_idx_fts_node_key`) that holds the actual
 * segments. The `_key` row is the object the sqlite3 CLI reports as
 * `malformed database schema (...) - near "USING": syntax error` — that is
 * healthy Tantivy backing, unparseable by stock SQLite (BL-329 documents the
 * same; the object must exist or the index is broken).
 *
 * The defect: `ensureFtsIndex` ran `CREATE INDEX … USING fts` and returned
 * `ensured: true` without verifying the three rows landed. Turso can report a
 * DDL success it did not perform (the orphan guard's own doc comment,
 * fts-orphan-guard.ts:264-284, says so). A half-materialised index is the
 * exact state that PANICS the process on the next `fts_match` (BL-361) —
 * before any open-time guard can run. The fix verifies the materialisation
 * after create and repairs it in-session, throwing a typed error if the retry
 * still lands incomplete.
 *
 * ## RED→GREEN (BL-225)
 *
 * The repair now routes through the shared `destroyOrphanedFtsIndex`
 * (`fts-repair.ts`): with a repair context it drops the index **out of band**
 * via the better-sqlite3 hatch (`deleteSchemaRowsViaBetterSqlite3`) while the
 * connection is closed — the ONLY route the 0.8.1 driver honours — then
 * re-CREATEs it. Three arms pin it:
 *
 * - **Unit (red→green):** a fake adapter whose backing names are absent on the
 *   first read and present after repair, plus a spy repair context recording
 *   its invocation and delegating to a spy `deleteSchemaRowsViaBetterSqlite3`.
 *   Asserts `ensured === true`, the context used EXACTLY once, and
 *   `adapter.exec(DROP INDEX …)` NEVER recorded.
 * - **Negative:** the same fake WITHOUT a context ⇒ throws the typed
 *   `[BL-507]` error carrying `in-place-route-unavailable` (the in-place DROP
 *   the 0.8.1 driver refuses).
 * - **Real-store:** damage out-of-band → open WRITABLE (the connect-time orphan
 *   guard repairs via the real out-of-band hatch) → `ensureFtsIndex` adopts
 *   the rebuilt index ⇒ `ensured === true`, no throw.
 *
 * **Honest limitation:** the *isolated* in-session repair — damaging a store
 * and repairing it through `ensureFtsIndex` on the SAME open connection — is
 * only unit-testable, because the connect-time orphan guard (BL-461) always
 * repairs the damage first on a real store. There is deliberately no
 * test-only guard-bypass hook (ADR-0013 D4 forbids adding one), so the
 * real-store arm proves the NET state the design specifies (guard repairs,
 * `ensureFtsIndex` adopts) rather than re-running the guard's work in place.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { TursoAdapterImpl } from './turso-adapter.js';
import { ensureFtsIndex } from './fts-ops.js';
import type { FtsRepairContext } from './fts-repair.js';
import type { StoreAdapter, AllResult, RunResult } from './types.js';

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

const FTS_COLUMNS = ['content', 'name', 'summary'];

// ── Spy the out-of-band hatch ────────────────────────────────────────────────
//
// `destroyOrphanedFtsIndex` imports `deleteSchemaRowsViaBetterSqlite3` directly
// and calls it inside the repair context's close-and-reopen, so the unit arm
// needs to observe and control it. The default implementation delegates to the
// REAL function (wired at mock-factory time via `importOriginal`) so the
// real-store arm exercises the real hatch — the spy is transparent unless a
// test overrides it.
const { state, deleteSchemaRowsSpy } = vi.hoisted(() => {
  const state: {
    real: null | ((
      dbPath: string,
      names: readonly string[],
      opts?: { ownLeaseToken?: string },
    ) => { dropped: string[]; failed: string | null });
  } = { real: null };
  const deleteSchemaRowsSpy = vi.fn(
    (dbPath: string, names: readonly string[], opts?: { ownLeaseToken?: string }) => {
      if (state.real) return state.real(dbPath, names, opts);
      throw new Error('mock: real deleteSchemaRowsViaBetterSqlite3 not wired');
    },
  );
  return { state, deleteSchemaRowsSpy };
});

vi.mock('./preflight.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./preflight.js')>();
  state.real = actual.deleteSchemaRowsViaBetterSqlite3;
  return { ...actual, deleteSchemaRowsViaBetterSqlite3: deleteSchemaRowsSpy };
});

afterEach(() => {
  deleteSchemaRowsSpy.mockImplementation((dbPath, names, opts) => {
    if (!state.real) throw new Error('mock: real deleteSchemaRowsViaBetterSqlite3 not wired');
    return state.real(dbPath, names, opts);
  });
  deleteSchemaRowsSpy.mockClear();
});

/** Delete sqlite_master rows out-of-band (better-sqlite3 + writable_schema —
 *  the documented escape hatch from preflight.ts:189-200). */
function deleteMasterRowsOutOfBand(dbPath: string, names: string[]): void {
  const Database = require('better-sqlite3') as new (p: string) => {
    unsafeMode(v: boolean): void;
    pragma(v: string): void;
    prepare(sql: string): { run(...args: unknown[]): { changes: number } };
    close(): void;
  };
  const db = new Database(dbPath);
  db.unsafeMode(true);
  db.pragma('writable_schema = ON');
  const del = db.prepare('DELETE FROM sqlite_master WHERE name = ?');
  for (const n of names) del.run(n);
  db.pragma('writable_schema = RESET');
  db.close();
}

interface MasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

/**
 * A narrow turso `StoreAdapter` whose `sqlite_master` state is an in-memory
 * array. It reproduces the 0.8.1 behaviour under test: `CREATE INDEX IF NOT
 * EXISTS` on an ALREADY-PRESENT index row is a reported-success NO-OP (the
 * backing is not re-materialised), and a `DROP INDEX` throws the
 * backing-absent `Internal error`. Only after the index row is actually gone
 * does a fresh CREATE materialise all three rows.
 */
function fakeTursoAdapter(master: MasterRow[]): { adapter: StoreAdapter; execSql: string[] } {
  const execSql: string[] = [];
  const adapter = {
    config: { type: 'turso' as const },
    capabilities: { fts: true, fts5: false },
    async executeAll<T>(q: string, params?: unknown[]): Promise<AllResult<T>> {
      if (/FROM sqlite_master WHERE name IN/.test(q)) {
        const wanted = new Set((params ?? []) as string[]);
        return { columns: [], rows: master.filter((r) => wanted.has(r.name)) as unknown as T[] };
      }
      if (/FROM sqlite_master/.test(q)) return { columns: [], rows: master as unknown as T[] };
      return { columns: [], rows: [] };
    },
    async executeGet<T>(_q: string, params?: unknown[]): Promise<T | null> {
      const name = (params ?? [])[0] as string;
      return (master.find((r) => r.name === name) as unknown as T) ?? null;
    },
    async exec(q: string): Promise<void> {
      execSql.push(q.replace(/\s+/g, ' ').trim());
      if (/DROP INDEX/i.test(q)) {
        throw new Error(
          'Internal error: FTS backing store __turso_internal_fts_dir_idx_fts_node_key not found',
        );
      }
      const create = /CREATE INDEX IF NOT EXISTS ([^\s]+)/.exec(q);
      if (create) {
        const n = create[1] as string;
        // The 0.8.1 no-op: an already-present index row is NOT re-materialised.
        if (master.some((r) => r.name === n)) return;
        master.push({ type: 'index', name: n, tbl_name: 'node', sql: q });
        master.push({
          type: 'table',
          name: `__turso_internal_fts_dir_${n}`,
          tbl_name: `__turso_internal_fts_dir_${n}`,
          sql: 'CREATE TABLE x (y)',
        });
        master.push({
          type: 'index',
          name: `__turso_internal_fts_dir_${n}_key`,
          tbl_name: 'node',
          sql: 'CREATE INDEX k ON node USING backing_btree (y)',
        });
      }
    },
    async executeRun(): Promise<RunResult> {
      return { rowsAffected: 0, lastInsertRowid: 0 };
    },
  } as unknown as StoreAdapter;
  return { adapter, execSql };
}

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-bl507-'));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

tursoDescribe('BL-507 — Turso FTS backing verification in ensureFtsIndex', () => {
  it('reports ensured only with a complete Tantivy materialisation (3/3 rows)', async () => {
    const dbPath = join(tmpDir, `healthy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    const adapter = await TursoAdapterImpl.connect({ dbPath });
    try {
      await adapter.exec(
        'CREATE TABLE node (rowid INTEGER PRIMARY KEY, content TEXT, name TEXT, summary TEXT)',
      );
      const res = await ensureFtsIndex(adapter, 'node', FTS_COLUMNS, {
        weights: { content: 1.0, name: 1.0, summary: 1.0 },
      });
      expect(res.ensured).toBe(true);
      const { rows } = await adapter.executeAll<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE name IN (?, ?, ?)`,
        ['idx_fts_node', '__turso_internal_fts_dir_idx_fts_node', '__turso_internal_fts_dir_idx_fts_node_key'],
      );
      const got = rows.map((r) => r.name).sort();
      expect(got).toEqual(
        ['__turso_internal_fts_dir_idx_fts_node', '__turso_internal_fts_dir_idx_fts_node_key', 'idx_fts_node'].sort(),
      );
      // And the index actually searches (healthy, not a zombie).
      const hits = await adapter.ftsSearch('node', FTS_COLUMNS, 'probe');
      expect(hits).toEqual([]);
    } finally {
      await adapter.close();
    }
  }, 20000);

  it('RED→GREEN (unit): a repair context drops the damaged index OUT OF BAND — never an in-place DROP INDEX', async () => {
    const master: MasterRow[] = [
      {
        type: 'index',
        name: 'idx_fts_node',
        tbl_name: 'node',
        sql: 'CREATE INDEX idx_fts_node ON "node" USING fts ("content", "name", "summary")',
      },
    ];
    const { adapter, execSql } = fakeTursoAdapter(master);
    let contextUsed = 0;
    const ctx: FtsRepairContext = {
      dbPath: '/tmp/fake-bl507.db',
      withConnectionClosedForRepair: async <T>(fn: () => Promise<T>): Promise<T> => {
        contextUsed++;
        return await fn();
      },
    };
    deleteSchemaRowsSpy.mockImplementation((_dbPath, names) => {
      // The real hatch DELETEs the named rows; mirror that so the re-CREATE
      // below actually re-materialises the backing.
      for (const n of names) {
        const i = master.findIndex((r) => r.name === n);
        if (i >= 0) master.splice(i, 1);
      }
      return { dropped: [...names], failed: null };
    });

    const res = await ensureFtsIndex(adapter, 'node', FTS_COLUMNS, {
      weights: { content: 1.0, name: 1.0, summary: 1.0 },
      repairContext: ctx,
    });

    expect(res.ensured).toBe(true);
    expect(contextUsed, 'the repair context must be used exactly once').toBe(1);
    expect(deleteSchemaRowsSpy, 'the out-of-band hatch must run').toHaveBeenCalledTimes(1);
    expect(
      execSql.some((s) => s.startsWith('DROP INDEX')),
      'the in-place DROP INDEX must never be issued when a repair context is supplied',
    ).toBe(false);
    // And the backing is now complete (the index row was re-materialised).
    const got = master.map((r) => r.name).sort();
    expect(got).toEqual(
      ['__turso_internal_fts_dir_idx_fts_node', '__turso_internal_fts_dir_idx_fts_node_key', 'idx_fts_node'].sort(),
    );
  });

  it('RED→GREEN (negative): WITHOUT a repair context, the in-place route is unavailable and the typed [BL-507] error surfaces', async () => {
    const master: MasterRow[] = [
      {
        type: 'index',
        name: 'idx_fts_node',
        tbl_name: 'node',
        sql: 'CREATE INDEX idx_fts_node ON "node" USING fts ("content", "name", "summary")',
      },
    ];
    const { adapter } = fakeTursoAdapter(master);

    await expect(
      ensureFtsIndex(adapter, 'node', FTS_COLUMNS, {
        weights: { content: 1.0, name: 1.0, summary: 1.0 },
      }),
    ).rejects.toThrow(/\[BL-507\]/);
    await expect(
      ensureFtsIndex(adapter, 'node', FTS_COLUMNS, {
        weights: { content: 1.0, name: 1.0, summary: 1.0 },
      }),
    ).rejects.toThrow(/in-place-route-unavailable/);
  });

  it('RED→GREEN (real-store): a writable open repairs the damage via the guard, and ensureFtsIndex then adopts the rebuilt index', async () => {
    const dbPath = join(tmpDir, `realstore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);

    // 1. Build a healthy index through a normal (guarded) connect.
    let adapter = await TursoAdapterImpl.connect({ dbPath });
    try {
      await adapter.exec(
        'CREATE TABLE node (rowid INTEGER PRIMARY KEY, content TEXT, name TEXT, summary TEXT)',
      );
      const res = await ensureFtsIndex(adapter, 'node', FTS_COLUMNS, {
        weights: { content: 1.0, name: 1.0, summary: 1.0 },
      });
      expect(res.ensured).toBe(true);
    } finally {
      await adapter.close();
    }

    // 2. Damage: delete the `_key` backing index out-of-band — the index row
    //    survives, the segments row does not (the BL-361 panic shape).
    deleteMasterRowsOutOfBand(dbPath, ['__turso_internal_fts_dir_idx_fts_node_key']);

    // 3. Open WRITABLE: the connect-time orphan guard repairs the damage (out
    //    of band), then ensureFtsIndex resolves the rebuilt index and adopts
    //    it — no throw, no duplicate.
    adapter = await TursoAdapterImpl.connect({ dbPath });
    try {
      const res = await ensureFtsIndex(adapter, 'node', FTS_COLUMNS, {
        weights: { content: 1.0, name: 1.0, summary: 1.0 },
      });
      expect(res.ensured).toBe(true);
      // The repaired index was adopted under its rebuild name — never a second
      // full index under the canonical name.
      expect(res.indexName).toBe('idx_fts_node__r1');
    } finally {
      await adapter.close();
    }
  }, 30000);
});
