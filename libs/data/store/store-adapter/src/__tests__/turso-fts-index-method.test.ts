/**
 * (BL-321 follow-up, fts-unify blocker) Regression test — Turso FTS requires
 * `experimental: ['index_method']` on EVERY connection that runs
 * `CREATE INDEX ... USING fts (...)` DDL or `fts_match`/`fts_score` queries
 * against it, not just the connection that created the index.
 *
 * Before the fix, `TursoAdapterImpl.connect()` hardcoded
 * `experiments = ['multiprocess_wal']` and never requested `index_method`.
 * `CREATE INDEX ... USING fts` therefore threw
 * `Parse error: index method is an experimental feature. Enable with
 * --experimental-index-method flag` on every real Turso store — swallowed by
 * a surrounding try/catch at log.debug in db.ts, so `idx_fts_node` silently
 * never existed and full-text search was dead in production. There is no
 * PRAGMA workaround (Turso silently no-ops unknown PRAGMA names).
 *
 * The critical subtlety this test exists to pin: even if the index WERE
 * created (e.g. by a connection that happened to carry the flag), a
 * connection reopened WITHOUT the flag still fails `fts_match` with the same
 * parse error — the index existing in `sqlite_master` is not sufficient.
 * `index_method` must be unconditionally on for every `connect()` call, not
 * a migration-time-only concern. That is why the fix makes it always-on in
 * `TursoAdapterImpl.connect()` rather than conditional/opt-in like
 * `multiprocess_wal`.
 *
 * Verified red→green directly against the real driver AND through this
 * suite: with the flag absent, `CREATE INDEX ... USING fts` throws; with the
 * fix (index_method always in the adapter's default experiments), the index
 * is created AND `fts_match` returns correct results on a freshly reopened
 * `TursoAdapterImpl.connect()` — proving the flag round-trips through a
 * close/reopen cycle without any caller having to ask for it explicitly.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TursoAdapterImpl } from '../turso-adapter.js';

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
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-turso-fts-'));
});

function tempPath(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpDir, `${label}-${suffix}.db`);
}

const openAdapters: TursoAdapterImpl[] = [];

async function connect(dbPath: string): Promise<TursoAdapterImpl> {
  const adapter = await TursoAdapterImpl.connect({ dbPath });
  openAdapters.push(adapter);
  return adapter;
}

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

tursoDescribe('TursoAdapterImpl — FTS index_method always-on (BL-321 follow-up)', () => {
  it('creates the FTS index via TursoAdapterImpl.connect() defaults (no caller opt-in required)', async () => {
    const dbPath = tempPath('create-index');
    const adapter = await connect(dbPath);

    await adapter.exec('CREATE TABLE node (id INTEGER PRIMARY KEY, content TEXT)');
    // Would throw "Parse error: index method is an experimental feature…"
    // pre-fix. Must not throw now that index_method is a default experiment.
    await expect(
      adapter.exec('CREATE INDEX IF NOT EXISTS idx_fts_node ON "node" USING fts ("content")'),
    ).resolves.toBeUndefined();
  });

  it('fts_match returns correct results, INCLUDING on a freshly reopened connection (the reopen assertion that would silently regress if the flag became conditional)', async () => {
    const dbPath = tempPath('reopen-fts-match');

    // 1. Create the store, the index, and seed rows on one connection.
    {
      const adapter = await connect(dbPath);
      await adapter.exec('CREATE TABLE node (id INTEGER PRIMARY KEY, content TEXT)');
      await adapter.executeRun('INSERT INTO node (id, content) VALUES (?, ?)', [1, 'hello world']);
      await adapter.executeRun('INSERT INTO node (id, content) VALUES (?, ?)', [2, 'goodbye moon']);
      await adapter.exec('CREATE INDEX IF NOT EXISTS idx_fts_node ON "node" USING fts ("content")');
      const rows = await adapter.executeAll<{ id: number }>(
        'SELECT id FROM node WHERE fts_match(content, ?)',
        ['hello'],
      );
      expect(rows.rows.map((r) => r.id)).toEqual([1]);
      await adapter.close();
      // Remove from the tracked-open list — already closed above.
      const idx = openAdapters.indexOf(adapter);
      if (idx >= 0) openAdapters.splice(idx, 1);
    }

    // 2. Reopen a BRAND NEW TursoAdapterImpl against the SAME file — this is
    //    the connection that never explicitly asked for index_method; it must
    //    get it from the adapter's own defaults, not from caller opt-in.
    const reopened = await connect(dbPath);
    const rows = await reopened.executeAll<{ id: number }>(
      'SELECT id FROM node WHERE fts_match(content, ?)',
      ['hello'],
    );
    expect(rows.rows.map((r) => r.id)).toEqual([1]);

    const moonRows = await reopened.executeAll<{ id: number }>(
      'SELECT id FROM node WHERE fts_match(content, ?)',
      ['moon'],
    );
    expect(moonRows.rows.map((r) => r.id)).toEqual([2]);
  });

  it('does not disturb multiprocess_wal — opt-in, and independently toggle-able either way', async () => {
    // multiprocess_wal is opt-in (FEAT-SOX-001; see
    // turso-multiprocess-wal-optin.test.ts, which owns that assertion).
    // What THIS test owns is that index_method is unaffected by whichever
    // branch the caller lands in.
    const onPath = tempPath('mpwal-on');
    const onAdapter = await TursoAdapterImpl.connect({
      dbPath: onPath,
      experimental: { multiprocessWal: true },
    });
    openAdapters.push(onAdapter);
    expect(onAdapter.capabilities.multiprocessWrite).toBe(true);

    const offPath = tempPath('mpwal-off');
    const offAdapter = await TursoAdapterImpl.connect({ dbPath: offPath });
    openAdapters.push(offAdapter);
    expect(offAdapter.capabilities.multiprocessWrite).toBe(false);

    // FTS must still work with multiprocess_wal off — index_method is
    // independent and must not be clobbered by either branch.
    await offAdapter.exec('CREATE TABLE node (id INTEGER PRIMARY KEY, content TEXT)');
    await expect(
      offAdapter.exec('CREATE INDEX IF NOT EXISTS idx_fts_node ON "node" USING fts ("content")'),
    ).resolves.toBeUndefined();
  });
});
