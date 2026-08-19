/**
 * BL-361 — a Turso store whose FTS index has no Tantivy backing objects PANICS
 * the driver and ABORTS the process inside `connect()`.
 *
 * ```
 * thread '<unnamed>' panicked at core/vdbe/execute.rs:13189:51:
 * internal error: entered unreachable code: invalid transaction state for
 * SetCookie: TransactionState::Read, should be write
 * ```
 *
 * ── Why every open here happens in a child process ──────────────────────────
 *
 * The failure is `SIGABRT`, not an exception. An in-process open would kill the
 * vitest worker, so the red arm could never be *watched* failing — and BL-225
 * is explicit that an unwatchable test proves nothing. The subject therefore
 * runs in `fixtures/bl361-open-child.ts` and this suite asserts on the child's
 * exit signal and stdout.
 *
 * ── The three arms ──────────────────────────────────────────────────────────
 *
 * 1. **RED, permanently.** The raw driver on a damaged store still aborts. This
 *    arm never goes green; it is the standing proof that the hazard is real and
 *    that the fixture reproduces it.
 * 2. **GREEN.** The same store, opened through `TursoAdapterImpl.connect()`
 *    with the out-of-band marker present: the pre-flight drops the orphaned
 *    schema rows out of process, the open succeeds, and the ordinary consumer
 *    `CREATE INDEX … USING fts` DDL brings full-text search back.
 * 3. **The gate's cost, stated.** Marker absent ⇒ no pre-flight ⇒ still aborts.
 *    That is the accepted trade-off of not paying for a native open on every
 *    connect, and it is asserted rather than left to a comment.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { leaseDirPath } from '../store-lease.js';
import {
  hasStoreOpenMarker,
  hasUncleanShutdown,
  markStoreOpen,
  clearStoreOpenMarker,
  preflightSchemaSanity,
  storeOpenMarkerPath,
} from '../preflight.js';

const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();
const tursoDescribe = hasTurso ? describe : describe.skip;

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = resolve(HERE, 'fixtures', 'bl361-open-child.ts');

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-bl361-'));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function tempPath(label: string): string {
  return join(tmpDir, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}

/** (BUG014.T5) The per-connection `.openmark` files currently in the lease dir. */
function openMarkers(dbPath: string): string[] {
  try {
    return readdirSync(leaseDirPath(dbPath))
      .filter((f) => f.endsWith('.openmark'))
      .sort();
  } catch {
    return [];
  }
}

/** Seed a healthy Turso store carrying a real Tantivy-backed FTS index. */
async function seedHealthyFtsStore(dbPath: string): Promise<void> {
  const adapter = await TursoAdapterImpl.connect({ dbPath });
  await adapter.exec('CREATE TABLE node (id INTEGER PRIMARY KEY, content TEXT)');
  await adapter.executeRun('INSERT INTO node (id, content) VALUES (?, ?)', [
    1,
    'hello world of durable storage',
  ]);
  await adapter.executeRun('INSERT INTO node (id, content) VALUES (?, ?)', [
    2,
    'goodbye moon and every orphaned index',
  ]);
  await adapter.exec('CREATE INDEX IF NOT EXISTS idx_fts_node ON "node" USING fts ("content")');
  await adapter.close();
}

/**
 * Fixture-only damage: strip the FTS index's Tantivy backing objects from
 * `sqlite_master`, leaving the `idx_fts_node` row behind. This is the exact
 * BL-361 state — the next Turso `connect()` on this file aborts the process.
 *
 * `unsafeMode(true)` is mandatory and must precede `writable_schema`:
 * better-sqlite3 runs SQLite in defensive mode by default, where the pragma is
 * silently a no-op and every schema-touching statement throws BL-329's
 * `malformed database schema` instead.
 */
function seedOrphanedTursoFtsIndex(dbPath: string): string[] {
  const Database = require('better-sqlite3') as new (p: string) => BetterSqlite3Database;
  const db = new Database(dbPath);
  db.unsafeMode(true);
  db.pragma('writable_schema = ON');
  const before = (db.prepare('SELECT name FROM sqlite_master').all() as { name: string }[]).map(
    (r) => r.name,
  );
  db.prepare(`DELETE FROM sqlite_master WHERE name LIKE '__turso_internal_fts_dir_%'`).run();
  db.pragma('writable_schema = RESET');
  db.close();
  return before;
}

interface ChildOutcome {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
}

function openInChild(dbPath: string, mode: 'raw' | 'adapter'): ChildOutcome {
  const run = spawnSync(process.execPath, ['--import', 'tsx', CHILD, dbPath, mode], {
    encoding: 'utf8',
    timeout: 60_000,
    cwd: resolve(HERE, '..', '..'),
  });
  let json: Record<string, unknown> | null = null;
  const line = (run.stdout ?? '')
    .split('\n')
    .reverse()
    .find((l) => l.trim().startsWith('{'));
  if (line) {
    try {
      json = JSON.parse(line) as Record<string, unknown>;
    } catch {
      json = null;
    }
  }
  return {
    status: run.status,
    signal: run.signal,
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? '',
    json,
  };
}

/** The driver aborted rather than throwing — SIGABRT, or status 134 when the
 *  shell/runtime reports the signal as an exit code. */
function aborted(outcome: ChildOutcome): boolean {
  return outcome.signal === 'SIGABRT' || outcome.status === 134 || outcome.status === null;
}

tursoDescribe('BL-361 — panic-on-open pre-flight', () => {
  it('RED ARM (permanent): the raw driver ABORTS the process on a store whose FTS index lost its Tantivy backing objects', async () => {
    const dbPath = tempPath('bl361-raw-panic');
    await seedHealthyFtsStore(dbPath);

    // Control first: the healthy store opens and searches through the raw driver.
    const healthy = openInChild(dbPath, 'raw');
    expect(healthy.status, `healthy raw open should succeed, stderr: ${healthy.stderr}`).toBe(0);
    expect(healthy.json).toMatchObject({ opened: true, ftsRowIds: [1] });

    const before = seedOrphanedTursoFtsIndex(dbPath);
    expect(before).toContain('__turso_internal_fts_dir_idx_fts_node');
    expect(before).toContain('__turso_internal_fts_dir_idx_fts_node_key');

    const damaged = openInChild(dbPath, 'raw');
    expect(aborted(damaged), `expected an abort, got status=${damaged.status} signal=${damaged.signal}`).toBe(
      true,
    );
    expect(damaged.stderr).toMatch(/panicked at/);
    expect(damaged.stderr).toMatch(/unreachable code/);
    // No catchable error was ever produced. The abort is NOT recoverable in
    // process: there is no exception to catch, no `finally`, no exit hook.
    expect(damaged.json).toMatchObject({ connected: true });
    expect(damaged.json?.opened).toBeUndefined();
    // (2026-08-05) And this is where BL-361's own account of the mechanism is
    // wrong, which matters because it changes what a fix has to intercept:
    // `connect()` SUCCEEDED — the child printed its post-connect line — and the
    // process died on the `fts_match` that followed. The conclusion is
    // unaffected: `TursoAdapterImpl.connect()` issues that query itself via
    // `runOpenTimeIntegrity` → `probeFtsIndexes`, which the marker-absent arm
    // below demonstrates.
  }, 120_000);

  it('GREEN ARM: TursoAdapterImpl.connect() pre-flights on the out-of-band marker, opens, and the ordinary DDL restores full-text search', async () => {
    const dbPath = tempPath('bl361-preflight-green');
    await seedHealthyFtsStore(dbPath);
    seedOrphanedTursoFtsIndex(dbPath);

    // A session that died leaves its marker behind — `close()` never ran.
    markStoreOpen(dbPath);
    expect(hasStoreOpenMarker(dbPath)).toBe(true);

    const out = openInChild(dbPath, 'adapter');
    expect(
      out.status,
      `expected a clean open; status=${out.status} signal=${out.signal} stderr=${out.stderr}`,
    ).toBe(0);
    expect(out.json).toMatchObject({ opened: true, mode: 'adapter' });
    // Full recovery: the row is matchable through the rebuilt index again.
    expect(out.json?.ftsRowIds).toEqual([1]);
    // The orphaned schema row is gone and a fully backed index took its place.
    expect(out.json?.schemaObjects).toEqual([
      '__turso_internal_fts_dir_idx_fts_node',
      '__turso_internal_fts_dir_idx_fts_node_key',
      'idx_fts_node',
    ]);
    // The pre-flight said so out loud, and said what it would mean.
    expect(out.stderr).toMatch(/\[BL-361\]/);
    expect(out.stderr).toMatch(/reclassifies to HIGH/);
    // An orderly close cleared the marker.
    expect(existsSync(storeOpenMarkerPath(dbPath))).toBe(false);
  }, 120_000);

  // (BL-461) This arm used to assert the gate's COST: with no marker the
  // out-of-band pre-flight does not run, so a store damaged inside a session
  // that afterwards closed cleanly still reached `fts_match` and aborted the
  // process. That hole is now closed from inside the connection by the
  // in-process guard (`fts-orphan-guard.ts`), which is unconditional and runs
  // above `runOpenTimeIntegrity`.
  //
  // The assertion is INVERTED rather than deleted, deliberately. Deleting it
  // would remove the only coverage of the marker-less path, and a later change
  // that reintroduced the gap would then pass silently — which is the failure
  // class BL-449/BL-394/BL-167 are all instances of. The gate's cost is now
  // asserted where it still exists: the two repair paths remain distinct and
  // non-interchangeable, pinned by `fts-orphan-guard.bl461.test.ts`.
  it('the marker-less path no longer aborts: the in-process guard closes what the gate does not cover (BL-461)', async () => {
    const dbPath = tempPath('bl361-no-marker');
    await seedHealthyFtsStore(dbPath);
    seedOrphanedTursoFtsIndex(dbPath);
    clearStoreOpenMarker(dbPath);
    expect(hasStoreOpenMarker(dbPath)).toBe(false);

    const out = openInChild(dbPath, 'adapter');
    expect(
      aborted(out),
      `expected a clean open via the in-process guard; status=${out.status} signal=${out.signal} stderr=${out.stderr}`,
    ).toBe(false);
    expect(out.stderr).not.toMatch(/panicked at/);
  }, 120_000);

  it('marker lifecycle: connect() writes ONE per-connection marker, close() removes only its own, and a read-only open touches neither (BUG014.T5)', async () => {
    const dbPath = tempPath('bl361-marker-lifecycle');
    const adapter = await TursoAdapterImpl.connect({ dbPath });
    // (DEBT-003, lazy-connect) `connect()` no longer writes the marker
    // eagerly — force the real open before checking for it.
    await adapter.executeGet('SELECT 1');
    // The session's OWN marker exists in the lease dir — carrying a LIVE pid,
    // so it is a concurrent session, never an unclean signal. (The old shared
    // marker could not make that distinction: `hasStoreOpenMarker` answered
    // true for a live session too — the false-positive BUG014.T5 removes.)
    expect(openMarkers(dbPath)).toHaveLength(1);
    expect(hasUncleanShutdown(dbPath)).toBe(false);
    await adapter.exec('CREATE TABLE node (id INTEGER PRIMARY KEY, content TEXT)');
    await adapter.close();
    expect(openMarkers(dbPath)).toHaveLength(0);
    expect(hasUncleanShutdown(dbPath)).toBe(false);

    const ro = await TursoAdapterImpl.connect({ dbPath, readonly: true });
    expect(openMarkers(dbPath)).toHaveLength(0);
    expect(hasUncleanShutdown(dbPath)).toBe(false);
    await ro.close();
    expect(openMarkers(dbPath)).toHaveLength(0);
  }, 60_000);

  it('NEGATIVE CONTROL: the pre-flight reports a healthy Turso FTS store as clean, and reports nothing at all on a store it cannot read', async () => {
    const dbPath = tempPath('bl361-negative-control');
    await seedHealthyFtsStore(dbPath);

    const healthy = preflightSchemaSanity(dbPath, { repair: true });
    expect(healthy.ran).toBe(true);
    expect(healthy.orphaned).toEqual([]);
    expect(healthy.dropped).toEqual([]);
    expect(healthy.failed).toBeNull();

    const missing = preflightSchemaSanity(join(tmpDir, 'does-not-exist.db'), { repair: true });
    expect(missing.ran).toBe(false);
    expect(missing.skipped).toMatch(/no database file/);

    // Damage it, then assert detect-only mode changes nothing on disk.
    seedOrphanedTursoFtsIndex(dbPath);
    const detectOnly = preflightSchemaSanity(dbPath);
    expect(detectOnly.orphaned).toEqual(['idx_fts_node']);
    expect(detectOnly.dropped).toEqual([]);

    const repaired = preflightSchemaSanity(dbPath, { repair: true });
    expect(repaired.orphaned).toEqual(['idx_fts_node']);
    expect(repaired.dropped).toEqual(['idx_fts_node']);
    expect(repaired.failed).toBeNull();

    // Idempotent: a second run finds nothing left to do.
    expect(preflightSchemaSanity(dbPath, { repair: true }).orphaned).toEqual([]);
  }, 60_000);

  it('a garbage file where the store should be degrades to "did not run" — a pre-flight must never be able to break an open', () => {
    const bogus = join(tmpDir, 'not-a-database.db');
    writeFileSync(bogus, 'this is not a sqlite file at all');
    const out = preflightSchemaSanity(bogus, { repair: true });
    expect(out.ran).toBe(false);
    expect(out.skipped).toMatch(/could not read sqlite_master/);
    expect(out.orphaned).toEqual([]);
  });
});
