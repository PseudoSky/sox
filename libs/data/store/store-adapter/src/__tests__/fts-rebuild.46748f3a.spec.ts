/**
 * Segment B — wiring `sanitizeAdapterMetaOffline` into `rebuildStoreOffline`
 * (owning uid `46748f3a-18a8-4d55-80df-843da6a2ceab`).
 *
 * Segment A shipped the transactional, key-class-aware `_adapter_meta` rebuild
 * primitive and its offline wrapper, but nothing called the offline wrapper:
 * `memory fts-rebuild` on a store whose `_adapter_meta` is corrupt (duplicate
 * PRIMARY KEY rows — BL-336 — and/or a torn NULL value — BL-341) aborted at the
 * `VACUUM INTO` step with `UNIQUE constraint failed: _adapter_meta.key`. Segment
 * B wires the offline sanitiser into the rebuild, behind a damage gate, an
 * exclusive gate, and a byte-exact pre-image.
 *
 * RED (the un-wired behaviour, via the test-only `skipAdapterMetaSanitize`
 * seam) and GREEN (the wired behaviour) are proven against the SAME seeded
 * corruption in this file.
 *
 * ENGINE COVERAGE (segment A's gap): segment A's tests bound better-sqlite3
 * only, while the live corrupt store is Turso. The corruption itself can only
 * be FABRICATED with better-sqlite3 (its `writable_schema` trick — Turso
 * enforces the PRIMARY KEY on insert and refuses `writable_schema`), but every
 * REBUILD here runs on the real Turso engine, through the same raw writable
 * handle `sanitizeAdapterMetaOffline` uses — so `ALTER TABLE … RENAME` and
 * `json_valid` are exercised on the engine that carries the corruption.
 *
 * Every test names `46748f3a-18a8-4d55-80df-843da6a2ceab`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { rebuildStoreOffline } from '../store-rebuild.js';
import { sanitizeAdapterMetaOffline } from '../integrity.js';
import { TursoAdapterImpl } from '../turso-adapter.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as new (p: string) => BetterSqlite3Database;

const UID = '46748f3a-18a8-4d55-80df-843da6a2ceab';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmpDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sox-fts-rebuild-46748f3a-')));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Mirror of `store-rebuild.ts`'s `stamp` — the deterministic clock seam makes
 *  the pre-image name predictable. */
function stamp(d: Date): string {
  return d.toISOString().replace(/[-:.]/g, '');
}

/**
 * Fabricate the production `_adapter_meta` corruption on a real store file:
 *
 *  - duplicate PRIMARY KEY rows (BL-336) — impossible under a live, consistent
 *    autoindex, so the fixture detaches `sqlite_autoindex__adapter_meta_1`
 *    exactly as `integrity-selfheal.test.ts` does (the ONLY way to fabricate
 *    this shape; Turso enforces the PK on insert and refuses `writable_schema`);
 *  - a torn NULL value on a JSON-class key (BL-341) — lands only because the
 *    column is momentarily declared nullable, then the production `NOT NULL`
 *    declaration is restored with the row still present;
 *  - an unknown key and a non-JSON value on a JSON-class key, so the sanitiser's
 *    quarantine path is exercised too.
 *
 * The store is then opened by TURSO for every rebuild in this file.
 */
function seedCorruptAdapterMeta(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec('CREATE TABLE _adapter_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.exec(
    `INSERT INTO _adapter_meta (key, value) VALUES ` +
      `('adapter_type', 'turso'), ('adapter_version', '0.1.0'), ('created_at', '2026-09-01T00:00:00.000Z')`,
  );
  db.unsafeMode(true);

  // ── Session 1: detach the PK's autoindex so duplicates can land (BL-336). ──
  // One `writable_schema` session, then RESET (force a schema reload). The
  // index row stays in sqlite_master; only its rootpage is repointed at a
  // scratch index's (empty) btree. This must be its own session: a later
  // rewrite of the table's own SQL row resets the schema and would undo it.
  db.pragma('writable_schema = ON');
  db.exec('CREATE TABLE IF NOT EXISTS _meta_scratch (z TEXT)');
  db.exec('DROP INDEX IF EXISTS _meta_scratch_ix');
  db.exec('CREATE INDEX _meta_scratch_ix ON _meta_scratch (z)');
  const scratch = db
    .prepare(`SELECT rootpage FROM sqlite_master WHERE name = '_meta_scratch_ix'`)
    .get() as { rootpage: number };
  db.prepare(
    `UPDATE sqlite_master SET rootpage = ? WHERE name = 'sqlite_autoindex__adapter_meta_1'`,
  ).run(scratch.rootpage);
  db.prepare(`DELETE FROM sqlite_master WHERE name IN ('_meta_scratch', '_meta_scratch_ix')`).run();
  db.pragma('writable_schema = RESET');

  // Duplicate the two originally-indexed keys — each in its OWN statement. The
  // repointed index btree starts empty, so the FIRST insert of any given key
  // lands; a second insert of the SAME key in a later statement would see the
  // entry the first one just wrote and fail. Hence one duplicate per key.
  db.exec(`INSERT INTO _adapter_meta (key, value) VALUES ('adapter_type', 'turso')`);
  db.exec(`INSERT INTO _adapter_meta (key, value) VALUES ('adapter_version', '0.2.0')`);
  // Brand-new keys are never in the repointed btree, so they can share a row.
  db.exec(
    `INSERT INTO _adapter_meta (key, value) VALUES ` +
      `('graph_node', 'first'), ` + // unknown key → quarantined
      `('last_integrity', 'not-json')`, // JSON-class, invalid → quarantined
  );

  // ── Session 2: land the torn NULL value (BL-341) on a JSON-class key. ──────
  db.pragma('writable_schema = ON');
  db.prepare(
    `UPDATE sqlite_master SET sql = 'CREATE TABLE _adapter_meta (key TEXT PRIMARY KEY, value TEXT)' ` +
      `WHERE name = '_adapter_meta'`,
  ).run();
  db.pragma('writable_schema = RESET');
  db.exec(`INSERT INTO _adapter_meta (key, value) VALUES ('deep_verify_state', NULL)`);

  // Restore the production NOT NULL declaration; the NULL row remains (BL-341).
  db.pragma('writable_schema = ON');
  db.prepare(
    `UPDATE sqlite_master SET sql = 'CREATE TABLE _adapter_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)' ` +
      `WHERE name = '_adapter_meta'`,
  ).run();
  db.pragma('writable_schema = RESET');
  db.close();
}

const BREAKER_MARKER = 'adapter-meta-repair.json';

/**
 * Bring the store to its engine-normal form before the byte-exactness checks:
 * the FIRST Turso open flips the SQLite header's write-version byte
 * (`offset 18`, journal→WAL), after which further exclusive opens are
 * byte-idempotent. Comparing a fresh better-sqlite3 file against a post-Turso
 * one would measure THAT header flip, not the sanitise. A real store reaching
 * `fts-rebuild` has always been engine-opened, so this is the honest baseline.
 */
async function normalizeStore(dbPath: string): Promise<void> {
  const a = await TursoAdapterImpl.connect({
    dbPath,
    readonly: true,
    allowFtsInReadonly: true,
    idleFlushMs: 3_600_000,
  });
  try {
    await a.executeAll('SELECT COUNT(*) AS n FROM _adapter_meta');
  } finally {
    await a.close();
  }
}

/** Simulate a tripped open-path circuit breaker: the durable marker a prior
 *  process leaves when it has exhausted its rebuild attempts. */
function seedBreakerMarker(dbPath: string): string {
  const dir = `${dbPath}.sox-lease.d`;
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, BREAKER_MARKER);
  fs.writeFileSync(
    marker,
    JSON.stringify({
      failedAt: new Date().toISOString(),
      attempts: 5,
      error: 'prior open-path rebuild exhaustion',
      storeIdentity: 'stale-identity',
    }),
  );
  return marker;
}

/** Read `_adapter_meta` back through a real Turso adapter — proof the rebuild's
 *  DDL produced a store Turso can read coherently. */
async function readMetaViaTurso(dbPath: string): Promise<{
  rows: { key: string; value: string | null }[];
  quarantine: { key: string; reason: string }[];
}> {
  const a = await TursoAdapterImpl.connect({
    dbPath,
    readonly: true,
    allowFtsInReadonly: true,
    idleFlushMs: 3_600_000,
  });
  try {
    const rows = (await a.executeAll<{ key: string; value: string | null }>(
      `SELECT key, value FROM _adapter_meta ORDER BY key`,
    )).rows;
    const q = (await a.executeAll<{ key: string; reason: string }>(
      `SELECT key, reason FROM _adapter_meta_quarantine ORDER BY key, value`,
    )).rows;
    return { rows, quarantine: q };
  } finally {
    await a.close();
  }
}

describe(`${UID} — fts-rebuild repairs a corrupt _adapter_meta (RED→GREEN)`, () => {
  it(`${UID}: RED — with the sanitise disabled the rebuild aborts on the corrupt _adapter_meta (verbatim)`, async () => {
    const db = path.join(tmpDir(), 'corrupt.db');
    seedCorruptAdapterMeta(db);
    await normalizeStore(db);
    const before = fs.readFileSync(db);

    const report = await rebuildStoreOffline(db, { skipAdapterMetaSanitize: true });

    // Capture the verbatim failure text (the un-wired behaviour).
    console.log(
      `[${UID}] RED verbatim: status=${report.status} reason=${report.reason} error=${JSON.stringify(report.error)}`,
    );
    expect(report.status).toBe('failed');
    expect(report.error).toContain('UNIQUE constraint failed: _adapter_meta.key');

    // Nothing was probed and nothing was written: no pre-image, no sanitise.
    expect(report.adapter_meta_repair).toBeUndefined();
    expect(report.adapter_meta_pre_image).toBeUndefined();
    const stray = fs.readdirSync(path.dirname(db)).filter((n) => n.includes('.pre-repair-'));
    expect(stray).toEqual([]);
    // The source is byte-unchanged — the failure is non-destructive.
    expect(fs.readFileSync(db).equals(before)).toBe(true);
  }, 120_000);

  it(`${UID}: GREEN — the rebuild sanitises the corruption, keeps a byte-exact pre-image, and clears the breaker`, async () => {
    const db = path.join(tmpDir(), 'corrupt.db');
    seedCorruptAdapterMeta(db);
    await normalizeStore(db);
    const before = fs.readFileSync(db);
    const breaker = seedBreakerMarker(db);
    expect(fs.existsSync(breaker)).toBe(true);

    const fixed = new Date('2026-09-30T12:34:56.789Z');
    const report = await rebuildStoreOffline(db, { now: () => fixed });

    expect(
      report.status,
      JSON.stringify({ status: report.status, reason: report.reason, error: report.error }),
    ).toBe('rebuilt');

    // The sanitiser ran on the SOURCE (Turso raw handle) and reports the shape.
    expect(report.adapter_meta_repair).toMatchObject({
      kept: 3, // adapter_type, adapter_version, created_at
      quarantined: 2, // graph_node (unknown), last_integrity (invalid JSON)
      dropped: 1, // deep_verify_state (NULL)
      changed: true,
    });
    expect(report.adapter_meta_repair?.quarantinedKeys.sort()).toEqual([
      'graph_node',
      'last_integrity',
    ]);

    // The byte-exact pre-image exists and equals the pre-sanitise source.
    const preImage = `${db}.pre-repair-${stamp(fixed)}`;
    expect(report.adapter_meta_pre_image).toBe(preImage);
    expect(fs.existsSync(preImage)).toBe(true);
    expect(fs.readFileSync(preImage).equals(before), `pre-image ${preImage} must be byte-exact`).toBe(
      true,
    );

    // The rebuilt store is coherent ON TURSO: one row per key, no NULLs, the
    // repaired values correct, and the quarantine table carrying the two
    // quarantined rows. (`stampRebuildMeta` then adds the two growth keys.)
    const meta = await readMetaViaTurso(db);
    const keys = meta.rows.map((r) => r.key);
    expect(new Set(keys).size, `duplicate keys in ${JSON.stringify(keys)}`).toBe(keys.length);
    expect(keys).toEqual(
      expect.arrayContaining(['adapter_type', 'adapter_version', 'created_at']),
    );
    expect(meta.rows.every((r) => r.value !== null)).toBe(true);
    expect(meta.rows.find((r) => r.key === 'adapter_version')?.value).toBe('0.2.0'); // latest wins
    expect(meta.quarantine.map((r) => r.key).sort()).toEqual(['graph_node', 'last_integrity']);
    expect(meta.quarantine.every((r) => r.reason !== '')).toBe(true);

    // (4) The durable breaker marker the open path consults is CLEARED.
    expect(fs.existsSync(breaker)).toBe(false);
  }, 120_000);

  it(`${UID}: the offline sanitiser runs ALTER … RENAME / json_valid on real Turso (segment A's engine gap)`, async () => {
    const db = path.join(tmpDir(), 'corrupt.db');
    seedCorruptAdapterMeta(db);

    // Drive the primitive exactly as store-rebuild.ts does — the raw writable
    // handle over @tursodatabase/database, not better-sqlite3.
    const report = await sanitizeAdapterMetaOffline(db);
    expect(report).toMatchObject({ kept: 3, quarantined: 2, dropped: 1, changed: true });

    // Turso can read the result: the table was rebuilt and renamed, and the
    // json_valid filter quarantined only the genuinely non-JSON JSON-class value.
    const meta = await readMetaViaTurso(db);
    expect(meta.rows.map((r) => r.key)).toEqual(['adapter_type', 'adapter_version', 'created_at']);
    expect(meta.quarantine.map((r) => r.key).sort()).toEqual(['graph_node', 'last_integrity']);
    const integrity = meta.quarantine.find((r) => r.key === 'last_integrity');
    expect(integrity?.reason).toBe('invalid_json');
    expect(meta.quarantine.find((r) => r.key === 'graph_node')?.reason).toBe('unknown_key');

    // A second run over the now-healthy table is a no-op (`changed: false`).
    const second = await sanitizeAdapterMetaOffline(db);
    expect(second.changed).toBe(false);
  }, 120_000);

  it(`${UID}: a healthy store is not sanitised and takes no pre-image`, async () => {
    const dir = tmpDir();
    const db = path.join(dir, 'healthy.db');
    const a = await TursoAdapterImpl.connect({ dbPath: db, idleFlushMs: 3_600_000 });
    try {
      await a.executeRun('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      await a.executeRun(`INSERT INTO t (v) VALUES ('x')`);
    } finally {
      await a.close();
    }

    const report = await rebuildStoreOffline(db);
    expect(
      report.status,
      JSON.stringify({ status: report.status, reason: report.reason, error: report.error }),
    ).toBe('rebuilt');
    expect(report.adapter_meta_repair).toBeUndefined();
    expect(report.adapter_meta_pre_image).toBeUndefined();
    expect(fs.readdirSync(dir).filter((n) => n.includes('.pre-repair-'))).toEqual([]);
  }, 120_000);
});
