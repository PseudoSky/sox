/**
 * DEBT-003 — `TursoAdapterImpl` is lazy-connected FROM BIRTH.
 *
 * Owner directive (verbatim): "Consumers of store adapter should not have to
 * think about connect / disconnect, that should be automatic under the
 * hood." The auto-RELEASE half already shipped (`releaseIdleConnection()`,
 * see release-idle-connection.spec.ts). This is the auto-CONNECT half: never
 * opening a driver connection, acquiring a lease, or running any open-time
 * ceremony (BL-361 preflight, BL-373 sidecar reconcile, BL-508 engine-marker
 * stamp, BL-461 FTS orphan guard, BL-352 open-time integrity repair,
 * idle-flush/wal-cap arming) until the FIRST real operation an instance
 * performs.
 *
 * Design: `connect()` constructs a `_neverOpened` shell — no driver open, no
 * lease. The first real operation runs `_ensureHealthy()` →
 * `_reconnect()` → `_openReal()` — the SAME recovery path `_poisoned`/
 * `_released` already use, not a second reopen branch. See turso-adapter.ts,
 * `_neverOpened`'s doc comment and `connect()`'s doc comment for the full
 * design writeup, including exactly which checks stayed eager (the BL-508
 * foreign-engine marker refusal — a pure filesystem header read) vs moved to
 * first-op (everything that genuinely needs a live connection or the lease
 * it requires).
 *
 * BL-225: every arm below is a RED→GREEN regression test naming DEBT-003 —
 * verified failing with the lazy-connect change reverted (documented in the
 * PR/report this test ships with) and passing with it restored.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { SqliteAdapterImpl } from '../sqlite-adapter.js';
import { ESqliteNativeStore } from '../errors.js';
import { leaseDirPath } from '../store-lease.js';
import { getLastIntegrityResult } from '../integrity.js';
import { canonicalDbPath } from '../path-identity.js';

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
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-lazy-connect-'));
});

function tempPath(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpDir, `${label}-${suffix}.db`);
}

const open: TursoAdapterImpl[] = [];
afterEach(async () => {
  while (open.length > 0) {
    try {
      await open.pop()!.close();
    } catch {
      // already closed
    }
  }
});

/**
 * The BL-362 damage fixture (copied from turso-fts-damage-fixture.bl362.test.ts —
 * see that file for the full recipe writeup). Make a Turso FTS index
 * exist-but-be-empty by handing its Tantivy backing btree an empty page.
 * Every `sqlite_master` row survives — deleting one instead produces the
 * BL-361 panic-on-open shape, which aborts the process rather than failing
 * an assertion.
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
  db.prepare(
    `DELETE FROM sqlite_master WHERE name IN ('_damage_scratch', '_damage_scratch_ix')`,
  ).run();
  db.pragma('writable_schema = RESET');
  db.close();
}

/** Every lease-registry entry (excludes the `.openmark` per-connection files). */
function liveLeaseEntries(dbPath: string): string[] {
  const dir = leaseDirPath(dbPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => !n.endsWith('.openmark') && !n.startsWith('.'));
}

tursoDescribe('DEBT-003 — TursoAdapterImpl lazy-connected from birth', () => {
  it('(a) connect() performs ZERO driver opens: no db file, no -wal, no lease entry, no open marker', async () => {
    const dbPath = tempPath('zero-open');
    const adapter = await TursoAdapterImpl.connect({ dbPath });
    open.push(adapter);

    // No driver open happened at all — the store file itself does not exist.
    // A real `@tursodatabase/database` connect() creates the file on open;
    // its absence is direct, unambiguous evidence no open occurred.
    expect(existsSync(dbPath), 'connect() must not create the db file').toBe(false);
    expect(existsSync(dbPath + '-wal'), 'connect() must not create a -wal file').toBe(false);

    // No lease acquired — an unopened instance holding a lease is exactly
    // the orphaned-lease class this codebase already fights.
    expect(liveLeaseEntries(dbPath), 'connect() must not acquire a lease').toEqual([]);

    // Metadata reads still work correctly before any operation. `config.dbPath`
    // is always the CANONICAL path (BUG014.T4), which on macOS resolves
    // `/tmp` -> `/private/tmp` — compare through the same canonicalizer.
    expect(adapter.config.type).toBe('turso');
    expect(adapter.config.dbPath).toBe(canonicalDbPath(dbPath));
    expect(typeof adapter.capabilities.multiprocessWrite).toBe('boolean');
    expect(typeof adapter.capabilities.recursiveCte).toBe('boolean');

    // unwrap() is the one surface that cannot "work" pre-open (it is
    // synchronous and returns the live driver handle) — it must fail LOUD,
    // not return a dead/fake handle.
    expect(() => adapter.unwrap()).toThrow(/never-opened|before any operation/i);
  });

  it('(b) the first real operation transparently opens the connection and succeeds', async () => {
    const dbPath = tempPath('first-op-opens');
    const adapter = await TursoAdapterImpl.connect({ dbPath });
    open.push(adapter);

    expect(existsSync(dbPath)).toBe(false); // still unopened

    const row = await adapter.executeGet<{ x: number }>('SELECT 1 AS x');

    expect(row).toEqual({ x: 1 });
    expect(existsSync(dbPath), 'the first operation must have opened the store').toBe(true);
    expect(liveLeaseEntries(dbPath).length, 'the first operation must have acquired a lease').toBe(1);
    expect(adapter.connectionHealth).toBe('healthy');
    // unwrap() now works — the connection is genuinely live.
    expect(adapter.unwrap()).toBeDefined();
  });

  it('(c) open-time integrity repair (BL-352) and the FTS orphan guard (BL-461) still run — exactly once, on the first real operation', async () => {
    const dbPath = tempPath('integrity-on-first-op');

    // 1. Seed a healthy store with an FTS index through a normal (real) open.
    {
      const seed = await TursoAdapterImpl.connect({ dbPath });
      await seed.exec('CREATE TABLE node (id INTEGER PRIMARY KEY, content TEXT)');
      // Content must exceed 24 chars (probeFtsIndexes' sampling floor,
      // integrity.ts) and contain a 6-20 char word (pickSentinelTokens).
      await seed.executeRun('INSERT INTO node (id, content) VALUES (1, ?)', [
        'hello world of durable storage and a sentinel token',
      ]);
      await seed.exec('CREATE INDEX IF NOT EXISTS idx_fts_node ON "node" USING fts ("content")');
      await seed.close();
    }
    // At this point `lastReportsByPath` (integrity.ts) holds the SEED's
    // clean 'ok' result for this path — the registry that backs
    // `getLastIntegrityResult`'s path-keyed fallback is process-global, not
    // per-instance, so it is not usable to prove "nothing has run on THIS
    // instance yet". Instead: damage the store OUT-OF-BAND (after the seed
    // closed, so the registry still describes the now-stale clean state),
    // lazily connect, and prove the damage is invisible to the registry
    // until this instance's own first operation runs — then visible after.

    // 2. Damage the Tantivy backing btree (BL-362 recipe): every
    //    sqlite_master row survives (so nothing panics — deleting one
    //    produces the BL-361 abort instead), but the index reports empty —
    //    the exact live-incident shape `fts_index_live` exists to catch.
    seedEmptyTursoFtsIndex(dbPath, 'idx_fts_node');

    // 3. Lazily connect — no operation yet.
    const adapter = await TursoAdapterImpl.connect({ dbPath });
    open.push(adapter);

    // The registry still describes the SEED's stale clean state (written
    // before the damage) — proof this instance's own open has not run yet.
    const beforeOp = getLastIntegrityResult(adapter);
    expect(
      beforeOp?.verify.findings.some((f) => f.probe === 'fts_index_live' && f.status === 'damaged'),
      'connect() alone must not have observed the damage — it must not have opened yet',
    ).not.toBe(true);

    // 4. The first real operation triggers the deferred open, which runs
    // the full ceremony: BL-352 verify-and-repair AND the BL-461 FTS
    // orphan guard both execute inside it.
    await adapter.executeGet('SELECT 1');

    const afterOp = getLastIntegrityResult(adapter);
    expect(afterOp, 'the first operation must have run open-time integrity').not.toBeNull();
    expect(
      afterOp!.verify.findings.some((f) => f.probe === 'fts_index_live' && f.status === 'damaged'),
      'the first operation must have SEEN the damage (BL-352 verify)',
    ).toBe(true);
    expect(
      afterOp!.repair?.actions.some((a) => a.probe === 'fts_index_live' && a.ok),
      'the first operation must have REPAIRED the damage (BL-352 repair)',
    ).toBe(true);

    // 5. The repair actually worked — fts_match against the rebuilt index
    // finds the row, proving the BL-461 rebuild (not just detection) ran.
    const hits = await adapter.executeAll<{ id: number }>(
      'SELECT id FROM node WHERE fts_match(content, ?)',
      ['sentinel'],
    );
    expect(hits.rows.map((r) => Number(r.id))).toEqual([1]);
  });

  it('(d) an unopenable store (BL-508 foreign-engine marker) still surfaces its error EAGERLY, at connect() itself', async () => {
    const dbPath = tempPath('foreign-engine');

    // Seed a store owned by the OTHER engine (plain SQLite) — the BL-508
    // fail-closed case. This is a pure filesystem header read
    // (`readApplicationId`), never a connection, so it stays eager per
    // constraint 1(a): an unopenable store must not silently defer its
    // failure to whatever random first query happens to run later.
    const sqlite = new SqliteAdapterImpl(dbPath);
    await sqlite.init();
    await sqlite.close();

    let thrown: unknown = null;
    try {
      // Deliberately NOT awaiting any follow-up operation — the whole point
      // is that connect() ITSELF rejects, before an instance is even
      // returned to the caller.
      await TursoAdapterImpl.connect({ dbPath });
    } catch (err) {
      thrown = err;
    }

    expect(thrown, 'connect() must reject eagerly for a foreign-engine store').toBeInstanceOf(
      ESqliteNativeStore,
    );
    expect((thrown as ESqliteNativeStore).code).toBe('E_SQLITE_NATIVE_STORE');

    // No lease was acquired for the rejected attempt — connect() failing
    // eagerly must not leak an orphaned lease entry either.
    expect(liveLeaseEntries(dbPath)).toEqual([]);
  });
});
