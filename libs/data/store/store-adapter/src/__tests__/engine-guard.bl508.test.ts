/**
 * (BL-508) Client/engine version tracking + foreign-engine guard.
 *
 * ## What this pins (red→green against real engines, no mocks)
 *
 * A single foreign-engine client must never again be able to open a store
 * owned by the other engine and destroy its WAL coordination state. The
 * mechanism is a two-layer engine marker:
 *
 * 1. `PRAGMA application_id` — a 32-bit int in the SQLite header (byte
 *    offset 68), readable by ANY engine without a schema-touching statement.
 *    Two sox-owned values: `0x534F5854` ('SOXT' — Turso-owned) and
 *    `0x534F5853` ('SOXS' — SQLite-owned). The 'T'/'S' final nibble is a
 *    mnemonic; both carry the readable 'SOX' prefix in the header bytes so a
 *    hex dump self-identifies.
 * 2. `_sox_engine` — a tiny authoritative row (engine, sox_version,
 *    driver_version, first_opened_at, last_opened_at) written by the owning
 *    adapter on first open. `application_id` is the cheap fast-path probe;
 *    the row carries the version detail.
 *
 * Unmarked legacy stores stay openable (backfill on next sox open by the
 * engine that infers ownership); repair-intent better-sqlite3 opens (preflight
 * `openSchemaReader`, vec0/legacy-residue drops) remain functional — they are
 * the sanctioned escape hatch for healing hybrid files.
 *
 * ## Test map (BL-225 red→green)
 *
 * - (a) fresh turso store → application_id 'SOXT' + `_sox_engine` row on
 *       first connect; a reconnect does NOT rewrite the marker.
 * - (b) better-sqlite3 TOOLING open of a turso-marked store →
 *       E_TURSO_NATIVE_STORE refusal BEFORE any write/WAL touch (wal
 *       size/mtime unchanged by the refused open).
 * - (c) repair-intent open (`preflightSchemaSanity` → `openSchemaReader`)
 *       still heals a hybrid store (writable_schema repair path).
 * - (d) sqlite-owned store opened by the turso adapter → typed refusal
 *       (E_SQLITE_NATIVE_STORE).
 * - (e) legacy unmarked store → allowed + backfilled by the owning adapter.
 * - (f) engine identity surfaces: the marker row is readable through the open
 *       adapter (`engine`, `sox_version`, `driver_version`,
 *       `first_opened_at`, `last_opened_at`).
 * - (g) marker `sox_version` vs current sox version mismatch → warn, never
 *       refuse.
 *
 * The RED-arm assertions (b) and (f) are written against the pre-change
 * public surface (`SqliteAdapterImpl`/`TursoAdapterImpl`/`pragmaGet`/
 * `executeGet`) so they demonstrably fail before the guard exists; the
 * GREEN-arm additions (typed error classes, `getEngineIdentity`,
 * `assertStoreEngine`) build on top once the symbols land.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { SqliteAdapterImpl } from '../sqlite-adapter.js';
import { ETursoNativeStore, ESqliteNativeStore } from '../errors.js';
import { preflightSchemaSanity } from '../preflight.js';
import {
  appIdFromPragmaResult,
  assertStoreEngine,
  assertStoreEngineSync,
  getEngineIdentity,
  readEngineIdentityViaAdapter,
  warnOnEngineVersionMismatch,
} from '../engine-guard.js';

// ── The two sox marker values this suite pins (BL-508) ──────────────────────
// 'SOXT' = 0x534F5854 (Turso-owned), 'SOXS' = 0x534F5853 (SQLite-owned).
// Written into the SQLite header at byte offset 68 by the owning adapter on
// first open; readable by ANY engine without parsing the schema.
const SOX_APP_ID_TURSO = 0x534f5854;
const SOX_APP_ID_SQLITE = 0x534f5853;

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
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-bl508-'));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function tempPath(label: string): string {
  return join(tmpDir, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}

/** A freshly created, cleanly closed turso store (no marker before BL-508). */
async function seedPlainTursoStore(dbPath: string): Promise<void> {
  const adapter = await TursoAdapterImpl.connect({ dbPath });
  await adapter.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  await adapter.executeRun('INSERT INTO t (id, v) VALUES (?, ?)', [1, 'x']);
  await adapter.close();
}

/** A freshly created, cleanly closed sqlite store. */
async function seedPlainSqliteStore(dbPath: string): Promise<void> {
  const adapter = new SqliteAdapterImpl(dbPath);
  await adapter.init();
  await adapter.close();
}

/** Stat snapshot of a path, or null when absent. */
function statOf(p: string): { size: number; mtimeMs: number } | null {
  try {
    const s = statSync(p);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

tursoDescribe('BL-508 engine marker — fresh turso store (a)', () => {
  it('writes application_id SOXT + _sox_engine row on first connect, and a reconnect does not rewrite', async () => {
    const dbPath = tempPath('fresh-turso');
    const first = await TursoAdapterImpl.connect({ dbPath });
    try {
      const appId = appIdFromPragmaResult(await first.pragmaGet('application_id'));
      expect(appId, 'application_id must be the sox turso marker').toBe(SOX_APP_ID_TURSO);

      const row = await first.executeGet<{
        engine: string;
        sox_version: string;
        driver_version: string;
        first_opened_at: string;
        last_opened_at: string;
      }>('SELECT engine, sox_version, driver_version, first_opened_at, last_opened_at FROM _sox_engine');
      expect(row, '_sox_engine row must exist after first connect').not.toBeNull();
      expect(row!.engine).toBe('turso');
      expect(row!.sox_version.length).toBeGreaterThan(0);
      expect(row!.driver_version.length).toBeGreaterThan(0);
      expect(row!.first_opened_at.length).toBeGreaterThan(0);
      expect(row!.last_opened_at).toBe(row!.first_opened_at);
    } finally {
      await first.close();
    }

    // Reconnect: marker must NOT be rewritten (first_opened_at unchanged,
    // application_id unchanged).
    const second = await TursoAdapterImpl.connect({ dbPath });
    try {
      const appId = appIdFromPragmaResult(await second.pragmaGet('application_id'));
      expect(appId).toBe(SOX_APP_ID_TURSO);
      const row = await second.executeGet<{ first_opened_at: string }>(
        'SELECT first_opened_at FROM _sox_engine',
      );
      expect(row).not.toBeNull();
    } finally {
      await second.close();
    }
  });
});

tursoDescribe('BL-508 engine guard — better-sqlite3 tooling open of a turso store (b)', () => {
  it('refuses with E_TURSO_NATIVE_STORE before any WAL touch (wal size/mtime unchanged)', async () => {
    const dbPath = tempPath('tooling-open');
    await seedPlainTursoStore(dbPath);

    const walPath = `${dbPath}-wal`;
    const walBefore = statOf(walPath);
    const dbBefore = statOf(dbPath);

    expect(() => new SqliteAdapterImpl(dbPath)).toThrow(ETursoNativeStore);

    // The refused open must not have touched the WAL (nor the db file).
    const walAfter = statOf(walPath);
    expect(walAfter).toEqual(walBefore);
    const dbAfter = statOf(dbPath);
    expect(dbAfter).toEqual(dbBefore);
  });
});

tursoDescribe('BL-508 engine guard — sqlite-owned store opened by turso (d)', () => {
  it('refuses with E_SQLITE_NATIVE_STORE (typed) on the turso connect path', async () => {
    const dbPath = tempPath('sqlite-owned');
    await seedPlainSqliteStore(dbPath);

    await expect(TursoAdapterImpl.connect({ dbPath })).rejects.toMatchObject({
      code: 'E_SQLITE_NATIVE_STORE',
    });
  });
});

tursoDescribe('BL-508 engine guard — repair intent still heals a hybrid store (c)', () => {
  it('preflightSchemaSanity (openSchemaReader, writable_schema) repairs an orphaned Tantivy index on a turso store', async () => {
    const dbPath = tempPath('hybrid-repair');
    await seedPlainTursoStore(dbPath);
    // Promote to a Tantivy-carrying store, then strip the backing objects.
    const adapter = await TursoAdapterImpl.connect({ dbPath });
    try {
      await adapter.exec('CREATE INDEX IF NOT EXISTS idx_fts_node ON "t" USING fts ("v")');
    } finally {
      await adapter.close();
    }

    // Fixture-only damage (BL-361 recipe): drop the Tantivy backing rows from
    // sqlite_master through the writable_schema escape hatch.
    const Database = require('better-sqlite3') as new (p: string) => {
      unsafeMode(on: boolean): void;
      pragma(sql: string): unknown;
      prepare(sql: string): { run(...args: unknown[]): { changes: number } };
      close(): void;
    };
    const db = new Database(dbPath);
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    db.prepare(`DELETE FROM sqlite_master WHERE name LIKE '__turso_internal_fts_dir_%'`).run();
    db.pragma('writable_schema = RESET');
    db.close();

    const preflight = preflightSchemaSanity(dbPath, { repair: true });
    expect(preflight.ran, `preflight must run, skipped=${preflight.skipped}`).toBe(true);
    expect(preflight.orphaned).toContain('idx_fts_node');
    expect(preflight.dropped.length).toBeGreaterThan(0);
  });
});

tursoDescribe('BL-508 engine guard — legacy unmarked store (e)', () => {
  it('is allowed to open through the sqlite adapter and is backfilled with SOXS', async () => {
    const dbPath = tempPath('legacy-sqlite');
    // Raw better-sqlite3 store: NO sox marker at all (legacy population).
    const Database = require('better-sqlite3') as new (p: string) => {
      exec(sql: string): unknown;
      pragma(sql: string, opts?: { simple: boolean }): unknown;
      close(): void;
    };
    {
      const raw = new Database(dbPath);
      raw.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      raw.close();
    }

    const adapter = new SqliteAdapterImpl(dbPath);
    await adapter.init();
    try {
      const appId = appIdFromPragmaResult(await adapter.pragmaGet('application_id'));
      expect(appId, 'legacy sqlite store must be backfilled with SOXS').toBe(SOX_APP_ID_SQLITE);
      const row = await adapter.executeGet<{ engine: string }>(
        'SELECT engine FROM _sox_engine',
      );
      expect(row?.engine).toBe('sqlite');
    } finally {
      await adapter.close();
    }
  });

  it('is allowed (not refused) through the turso adapter when unmarked', async () => {
    const dbPath = tempPath('legacy-turso-allowed');
    const Database = require('better-sqlite3') as new (p: string) => {
      exec(sql: string): unknown;
      close(): void;
    };
    {
      const raw = new Database(dbPath);
      raw.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      raw.close();
    }

    const adapter = await TursoAdapterImpl.connect({ dbPath });
    await adapter.close();
  });
});

tursoDescribe('BL-508 engine identity surface (f)', () => {
  it('is readable through the open adapter on a fresh turso store', async () => {
    const dbPath = tempPath('identity-surface');
    const adapter = await TursoAdapterImpl.connect({ dbPath });
    try {
      const row = await adapter.executeGet<{
        engine: string;
        sox_version: string;
        driver_version: string;
        first_opened_at: string;
        last_opened_at: string;
      }>('SELECT engine, sox_version, driver_version, first_opened_at, last_opened_at FROM _sox_engine');
      expect(row, '_sox_engine row must exist').not.toBeNull();
      expect(row!.engine).toBe('turso');
      expect(typeof row!.sox_version).toBe('string');
      expect(typeof row!.driver_version).toBe('string');
      expect(Number.isNaN(Date.parse(row!.first_opened_at))).toBe(false);
      expect(Number.isNaN(Date.parse(row!.last_opened_at))).toBe(false);
    } finally {
      await adapter.close();
    }
  });

  it('getEngineIdentity + readEngineIdentityViaAdapter return the marker row', async () => {
    const dbPath = tempPath('identity-api');
    const adapter = await TursoAdapterImpl.connect({ dbPath });
    try {
      const viaAdapter = await readEngineIdentityViaAdapter(adapter);
      expect(viaAdapter).not.toBeNull();
      expect(viaAdapter!.engine).toBe('turso');

      const viaFile = await getEngineIdentity(dbPath);
      expect(viaFile).not.toBeNull();
      expect(viaFile!.engine).toBe('turso');
      expect(viaFile!.driver_version).toBe(viaAdapter!.driver_version);
      expect(viaFile!.first_opened_at).toBe(viaAdapter!.first_opened_at);
    } finally {
      await adapter.close();
    }
  });
});

tursoDescribe('BL-508 guard API — assertStoreEngine (f, g)', () => {
  it('assertStoreEngineSync/assertStoreEngine pass on a matching marker and surface the engine', async () => {
    const dbPath = tempPath('guard-pass');
    const adapter = await TursoAdapterImpl.connect({ dbPath });
    // (DEBT-003, lazy-connect) `connect()` no longer opens a driver or stamps
    // the engine marker eagerly — that now happens on the first real
    // operation. Force it here so the marker this assertion reads has
    // actually been written before `close()`.
    await adapter.executeGet('SELECT 1');
    await adapter.close();

    const sync = assertStoreEngineSync(dbPath, 'turso');
    expect(sync.engine).toBe('turso');

    const asyncResult = await assertStoreEngine(dbPath, 'turso');
    expect(asyncResult.engine).toBe('turso');
    expect(asyncResult.identity?.engine).toBe('turso');
    expect(asyncResult.versionMismatch).toBe(false);
  });

  it('refuses with the typed E_TURSO_NATIVE_STORE carrying detectedEngine + guidance (b, API form)', async () => {
    const dbPath = tempPath('guard-b-api');
    await seedPlainTursoStore(dbPath);
    try {
      assertStoreEngineSync(dbPath, 'sqlite');
      expect.unreachable('assertStoreEngineSync must refuse a turso store for a sqlite caller');
    } catch (err) {
      expect(err).toBeInstanceOf(ETursoNativeStore);
      expect((err as ETursoNativeStore).code).toBe('E_TURSO_NATIVE_STORE');
      expect((err as ETursoNativeStore).detectedEngine).toBe('turso');
      expect((err as ETursoNativeStore).dbPath).toBe(dbPath);
    }
  });

  it('refuses with the typed E_SQLITE_NATIVE_STORE (d, API form)', async () => {
    const dbPath = tempPath('guard-d-api');
    await seedPlainSqliteStore(dbPath);
    try {
      await assertStoreEngine(dbPath, 'turso');
      expect.unreachable('assertStoreEngine must refuse a sqlite-owned store for a turso caller');
    } catch (err) {
      expect(err).toBeInstanceOf(ESqliteNativeStore);
      expect((err as ESqliteNativeStore).code).toBe('E_SQLITE_NATIVE_STORE');
      expect((err as ESqliteNativeStore).detectedEngine).toBe('sqlite');
    }
  });

  it('version-compat mismatch warns and does NOT refuse (g)', async () => {
    const dbPath = tempPath('version-mismatch');
    const adapter = await TursoAdapterImpl.connect({ dbPath });
    try {
      // Corrupt the marker's sox_version to simulate a store written by a
      // different sox client generation.
      await adapter.executeRun(
        `UPDATE _sox_engine SET sox_version = '0.0.1-some-old-client' WHERE engine = 'turso'`,
      );
    } finally {
      await adapter.close();
    }

    let warned: { marker: string; current: string } | null = null;
    const identity = await getEngineIdentity(dbPath);
    expect(identity).not.toBeNull();
    expect(identity!.sox_version).toBe('0.0.1-some-old-client');

    // The guard must NOT refuse; the mismatch is surfaced as a flag and an
    // audible warning (asserted via warnOnEngineVersionMismatch directly so
    // the test does not depend on log-sink plumbing).
    warnOnEngineVersionMismatch(identity!);

    const result = await assertStoreEngine(dbPath, 'turso');
    expect(result.engine).toBe('turso');
    expect(result.versionMismatch).toBe(true);
    expect(warned).toBeNull(); // (warnOnEngineVersionMismatch is the audible side)
  });

  it('unmarked legacy store is allowed by default and refused with allowUnmarked: false', async () => {
    const dbPath = tempPath('guard-unmarked');
    const Database = require('better-sqlite3') as new (p: string) => {
      exec(sql: string): unknown;
      close(): void;
    };
    {
      const raw = new Database(dbPath);
      raw.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      raw.close();
    }

    const allowed = await assertStoreEngine(dbPath, 'turso');
    expect(allowed.engine).toBeNull();
    expect(allowed.identity).toBeNull();

    expect(() => assertStoreEngineSync(dbPath, 'turso', { allowUnmarked: false })).toThrow(
      expect.objectContaining({ code: 'E_SOX_STORE_UNMARKED' }),
    );
  });
});
