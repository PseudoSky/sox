/**
 * BL-362 — a committable Turso FTS damage fixture.
 *
 * Until now the `fts_index_live` probe (BL-347/BL-352) had a red→green negative
 * control on **SQLite FTS5 only**. On Turso it was verified against real damage
 * exactly once, by hand, on a copy of the live store that exists on one
 * machine. CI therefore proved the Turso probe passes on a healthy index and
 * never that it fails on a damaged one — the exact BL-167 shape: a test named
 * for an invariant that skips the case where the invariant breaks.
 *
 * ── Why the four recorded recipes all failed ────────────────────────────────
 *
 * `CREATE INDEX idx_fts_node ON node USING fts (content)` materialises three
 * `sqlite_master` rows, and the interesting one is not the obvious one:
 *
 * | row | kind | holds |
 * |---|---|---|
 * | `idx_fts_node` | index, `rootpage = 0` | nothing — no btree of its own |
 * | `__turso_internal_fts_dir_idx_fts_node` | table | **nothing, ever — 0 rows in every state** |
 * | `__turso_internal_fts_dir_idx_fts_node_key` | index `USING backing_btree` | **the Tantivy segments** |
 *
 * 1. Deleting the directory table's *rows* changed nothing, because there are
 *    never any rows.
 * 2. Repointing the directory *table*'s rootpage at an empty btree changed
 *    nothing **for the same reason** — that btree is already empty. The recipe
 *    was sound; it was aimed one object to the left.
 * 3. Inserting through a connection without `experimental: ['index_method']`
 *    throws at the INSERT, so it is not how the live damage happened.
 * 4. Removing the backing objects while leaving `idx_fts_node` behind is
 *    BL-361: the next `fts_match` PANICS and aborts the process. A fixture must
 *    never produce that state — it kills the test runner rather than failing a
 *    test.
 *
 * ── The recipe that works ───────────────────────────────────────────────────
 *
 * Repoint **`__turso_internal_fts_dir_idx_fts_node_key`** — the
 * `USING backing_btree` index, i.e. the object that actually stores the Tantivy
 * segments — at a freshly created, empty index btree. Every `sqlite_master` row
 * stays present, so nothing panics; the index is empty-but-present, which is
 * precisely the BL-347 live-damage shape: `CREATE INDEX IF NOT EXISTS` no-ops
 * on it, and keyword search silently returns nothing.
 *
 * This is the same mechanism as `seedUnpopulatedIndex` in
 * `integrity-selfheal.test.ts` — applied to the object Turso keeps its FTS
 * content in.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { TursoAdapterImpl } from '../turso-adapter.js';
import {
  verifyStoreIntegrity,
  repairStoreIntegrity,
  getLastIntegrityResult,
} from '../integrity.js';
import type { StoreAdapter } from '../types.js';

const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();
const tursoDescribe = hasTurso ? describe : describe.skip;

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-bl362-'));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const open: StoreAdapter[] = [];
afterEach(async () => {
  while (open.length > 0) {
    try {
      await open.pop()!.close();
    } catch {
      // already closed
    }
  }
});
function track<T extends StoreAdapter>(a: T): T {
  open.push(a);
  return a;
}

function tempPath(label: string): string {
  return join(tmpDir, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}

/** Text long enough that `pickSentinelTokens` has whole words to work with. */
const ROWS: [number, string][] = [
  [1, 'hello world of durable storage and reliable indexes'],
  [2, 'goodbye moon, and goodbye to every orphaned tantivy segment'],
  [3, 'persistence without verification is just optimism with a filesystem'],
  [4, 'keyword search silently returning nothing is the worst failure mode'],
  [5, 'sentinel tokens are taken from the row they are meant to find'],
];

async function seedHealthyFtsStore(dbPath: string): Promise<void> {
  const adapter = await TursoAdapterImpl.connect({ dbPath });
  await adapter.exec('CREATE TABLE node (id INTEGER PRIMARY KEY, content TEXT)');
  for (const [id, content] of ROWS) {
    await adapter.executeRun('INSERT INTO node (id, content) VALUES (?, ?)', [id, content]);
  }
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_fts_node ON "node" USING fts ("content")');
  await adapter.close();
}

/**
 * **The BL-362 fixture.** Make a Turso FTS index exist-but-be-empty by handing
 * its Tantivy backing btree an empty page.
 *
 * Every `sqlite_master` row survives — that is not incidental, it is the whole
 * safety property. Deleting one of them instead produces BL-361, which aborts
 * the process rather than failing an assertion.
 *
 * `unsafeMode(true)` must precede `writable_schema`: better-sqlite3 runs SQLite
 * in defensive mode by default, where the pragma is silently a no-op and every
 * schema-touching statement throws BL-329's `malformed database schema` on a
 * Turso-FTS store.
 */
function seedEmptyTursoFtsIndex(dbPath: string, indexName: string): void {
  const Database = require('better-sqlite3') as new (p: string) => BetterSqlite3Database;
  const db = new Database(dbPath);
  db.unsafeMode(true);
  db.pragma('writable_schema = ON');
  db.exec('CREATE TABLE IF NOT EXISTS _damage_scratch (z TEXT)');
  db.exec('DROP INDEX IF EXISTS _damage_scratch_ix');
  db.exec('CREATE INDEX _damage_scratch_ix ON _damage_scratch (z)');
  const scratch = db
    .prepare(`SELECT rootpage FROM sqlite_master WHERE name = '_damage_scratch_ix'`)
    .get() as { rootpage: number };
  const backingKey = `__turso_internal_fts_dir_${indexName}_key`;
  const moved = db
    .prepare('UPDATE sqlite_master SET rootpage = ? WHERE name = ?')
    .run(scratch.rootpage, backingKey);
  if (moved.changes !== 1) {
    db.close();
    throw new Error(
      `fixture precondition failed: expected exactly one ${backingKey} row, updated ${moved.changes}`,
    );
  }
  // Hand the empty page over exclusively, so the damaged index is its only
  // owner and the rebuild has no collateral.
  db.prepare(
    `DELETE FROM sqlite_master WHERE name IN ('_damage_scratch', '_damage_scratch_ix')`,
  ).run();
  db.pragma('writable_schema = RESET');
  db.close();
}

/**
 * Open without the open-time FTS probe repairing the damage, so the RED arms
 * can observe it before the adapter heals it. `SOX_STORE_VERIFY=off` was an
 * anti-feature and is gone (ADR-0013 — the store always validates); the
 * documented short-lived-caller lever `SOX_STORE_VERIFY_SKIP=fts_index_live`
 * (BL-431) is the faithful replacement: the open-time pass skips exactly the
 * probe under test, so the damage survives the open and the RED arms verify
 * it directly. The skipped probe's finding reports "skipped by the caller …
 * NOT verified against it" — visible, not silent.
 */
async function connectWithoutOpenTimeIntegrity(dbPath: string): Promise<TursoAdapterImpl> {
  const previous = process.env.SOX_STORE_VERIFY_SKIP;
  process.env.SOX_STORE_VERIFY_SKIP = 'fts_index_live';
  try {
    const adapter = await TursoAdapterImpl.connect({ dbPath });
    // (DEBT-003, lazy-connect) `connect()` no longer runs the open-time
    // integrity pass eagerly — it now runs on the first real operation, via
    // `_openReal()`. `SOX_STORE_VERIFY_SKIP` must still be set when THAT
    // actually happens, not merely when `connect()` returns, so force it
    // here, still inside this function's env-var scope.
    await adapter.executeGet('SELECT 1');
    return adapter;
  } finally {
    if (previous === undefined) delete process.env.SOX_STORE_VERIFY_SKIP;
    else process.env.SOX_STORE_VERIFY_SKIP = previous;
  }
}

/** Names in `sqlite_master`, read the only way a Turso-FTS store allows. */
function schemaObjects(dbPath: string): string[] {
  const Database = require('better-sqlite3') as new (
    p: string,
    o?: { readonly?: boolean },
  ) => BetterSqlite3Database;
  const db = new Database(dbPath, { readonly: true });
  db.unsafeMode(true);
  db.pragma('writable_schema = ON');
  const names = (db.prepare('SELECT name FROM sqlite_master').all() as { name: string }[]).map(
    (r) => r.name,
  );
  db.close();
  return names.sort();
}

tursoDescribe('BL-362 — committable Turso FTS damage fixture', () => {
  it('NEGATIVE CONTROL: the healthy store reports fts_index_live ok and keyword search works', async () => {
    const dbPath = tempPath('bl362-healthy');
    await seedHealthyFtsStore(dbPath);

    const adapter = track(await TursoAdapterImpl.connect({ dbPath }));
    const report = await verifyStoreIntegrity(adapter, { depth: 'deep' });
    const fts = report.findings.filter((f) => f.probe === 'fts_index_live');
    expect(fts.length).toBeGreaterThan(0);
    expect(fts.every((f) => f.status === 'ok')).toBe(true);

    const hits = await adapter.executeAll<{ id: number }>(
      'SELECT id FROM node WHERE fts_match(content, ?)',
      ['durable'],
    );
    expect(hits.rows.map((r) => Number(r.id))).toEqual([1]);
  }, 60_000);

  it('RED: repointing the Tantivy backing btree at an empty page makes fts_index_live report damaged — and every sqlite_master row survives, so nothing panics (BL-361)', async () => {
    const dbPath = tempPath('bl362-damaged');
    await seedHealthyFtsStore(dbPath);
    const before = schemaObjects(dbPath);

    seedEmptyTursoFtsIndex(dbPath, 'idx_fts_node');

    // The safety property of this fixture, asserted rather than assumed: the
    // schema is INTACT. Any missing row here is the BL-361 state, which aborts
    // the process instead of failing a test.
    expect(schemaObjects(dbPath)).toEqual(before);

    const adapter = track(await connectWithoutOpenTimeIntegrity(dbPath));
    const hits = await adapter.executeAll<{ id: number }>(
      'SELECT id FROM node WHERE fts_match(content, ?)',
      ['durable'],
    );
    expect(hits.rows).toEqual([]); // silently empty — the BL-347 symptom exactly

    const report = await verifyStoreIntegrity(adapter, { depth: 'deep' });
    const fts = report.findings.filter((f) => f.probe === 'fts_index_live');
    expect(fts.length).toBeGreaterThan(0);
    expect(fts.some((f) => f.status === 'damaged')).toBe(true);
    const damaged = fts.find((f) => f.status === 'damaged')!;
    expect(damaged.object).toBe('idx_fts_node');
    expect(damaged.repairable).toBe(true);
    expect(damaged.probeValidated).toBe(true);
  }, 60_000);

  it('and re-running the ordinary CREATE INDEX IF NOT EXISTS does NOT fix it — the no-op that is the whole mechanism of BL-347', async () => {
    const dbPath = tempPath('bl362-noop');
    await seedHealthyFtsStore(dbPath);
    seedEmptyTursoFtsIndex(dbPath, 'idx_fts_node');

    const adapter = track(await connectWithoutOpenTimeIntegrity(dbPath));
    await adapter.exec('CREATE INDEX IF NOT EXISTS idx_fts_node ON "node" USING fts ("content")');
    const hits = await adapter.executeAll<{ id: number }>(
      'SELECT id FROM node WHERE fts_match(content, ?)',
      ['durable'],
    );
    expect(hits.rows).toEqual([]);
  }, 60_000);

  it('GREEN: the adapter repair path rebuilds the index and fts_index_live goes ok — with no repair DDL in this test', async () => {
    const dbPath = tempPath('bl362-repair');
    await seedHealthyFtsStore(dbPath);
    seedEmptyTursoFtsIndex(dbPath, 'idx_fts_node');

    const adapter = track(await connectWithoutOpenTimeIntegrity(dbPath));
    const report = await verifyStoreIntegrity(adapter, { depth: 'deep' });
    expect(report.findings.some((f) => f.probe === 'fts_index_live' && f.status === 'damaged')).toBe(
      true,
    );

    const result = await repairStoreIntegrity(adapter, report);
    const ftsAction = result.actions.find((a) => a.probe === 'fts_index_live');
    expect(ftsAction, `no fts repair action in ${JSON.stringify(result.actions)}`).toBeDefined();
    expect(ftsAction?.ok).toBe(true);
    expect(ftsAction?.object).toBe('idx_fts_node');
    // Repair is not believed on its own — the re-verification is the evidence.
    expect(result.verified).not.toBeNull();
    expect(
      result.verified?.findings.some((f) => f.probe === 'fts_index_live' && f.status === 'damaged'),
    ).toBe(false);
    expect(
      result.verified?.findings.some((f) => f.probe === 'fts_index_live' && f.status === 'ok'),
    ).toBe(true);

    const hits = await adapter.executeAll<{ id: number }>(
      'SELECT id FROM node WHERE fts_match(content, ?)',
      ['durable'],
    );
    expect(hits.rows.map((r) => Number(r.id))).toEqual([1]);
  }, 60_000);

  it('END TO END: an ordinary reopen detects and self-heals the damage on its own (BL-352), with no verify/repair call in this test', async () => {
    const dbPath = tempPath('bl362-selfheal');
    await seedHealthyFtsStore(dbPath);
    seedEmptyTursoFtsIndex(dbPath, 'idx_fts_node');

    // Plain consumer open — open-time integrity does the rest.
    const adapter = track(await TursoAdapterImpl.connect({ dbPath }));
    // (DEBT-003, lazy-connect) The open-time integrity pass this test pins
    // now runs on the first real operation, not at `connect()` — force it.
    await adapter.executeGet('SELECT 1');

    // The open must have SEEN the damage, not merely ended up healthy: without
    // this assertion the case passes just as well on an undamaged store, which
    // is the BL-167 shape this whole file exists to close.
    const last = getLastIntegrityResult(adapter);
    expect(last, 'the open recorded no integrity result at all').not.toBeNull();
    expect(
      last?.verify.findings.some((f) => f.probe === 'fts_index_live' && f.status === 'damaged'),
    ).toBe(true);
    expect(last?.repair?.actions.some((a) => a.probe === 'fts_index_live' && a.ok)).toBe(true);

    const hits = await adapter.executeAll<{ id: number }>(
      'SELECT id FROM node WHERE fts_match(content, ?)',
      ['sentinel'],
    );
    expect(hits.rows.map((r) => Number(r.id))).toEqual([5]);
  }, 60_000);
});
