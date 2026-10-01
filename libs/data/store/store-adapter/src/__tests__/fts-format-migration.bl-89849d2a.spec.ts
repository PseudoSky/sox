/**
 * BL-89849d2a — the Turso FTS on-disk FORMAT migration (v1 → v2) as an
 * offline, spec-conformant, reversible operation.
 *
 * Turso 0.8.x replaced the FTS on-disk format (v1 whole-index Tantivy manifest
 * vs v2 per-segment registry). A 0.8 driver opens a 0.7 store but REFUSES FTS
 * read/write with: `FTS index <name> was created by an older version of
 * Turso ... rebuild it with DROP INDEX <name> followed by CREATE INDEX ...
 * USING fts`. The sanctioned migration is, per index whose sqlite_master.sql
 * matches `USING fts`: `DROP INDEX` then `CREATE INDEX ... USING fts`, followed
 * by a SAME-VERSION `VACUUM INTO`, a growth-counter reset, `verifyReplacement`,
 * and an atomic `swapIntoPlace` (DESIGN §2).
 *
 * The ONLY rollback path is the pre-migration image (`<db>.pre-migration-<ts>`)
 * captured as a reflink while the store is still v1: a 0.7 driver opening a
 * migrated v2 store is CORRUPTING, not merely unsupported (DESIGN §6a). That
 * image is restored through `restoreStoreOffline`, and this file EXERCISES the
 * rollback (the plan's sole previously-unverified escape hatch).
 *
 * DRIVER SEAM. The installed `@tursodatabase/database` is 0.7.1, which cannot
 * emit the v2 format. The `_tursoVersion` test seam only bypasses the
 * `driverIsV2Aware` GATE — it does NOT change the driver's FTS engine. So under
 * the 0.7.1 binary the DROP+CREATE transform re-emits a v1 index (still leaked),
 * and `verifyReplacement` correctly refuses the v1-on-v1 sentinel mismatch:
 * the end-to-end chain through `swapIntoPlace` is UNREACHABLE under 0.7.1, which
 * is exactly the plan's stated boundary — "if the v2 DDL genuinely cannot be
 * emitted under 0.7.1, say so explicitly and stop — do not bump." The full
 * chain completes only under a real 0.8 pin (a separate, later step; the live
 * service must not see 0.8 bytes yet).
 *
 * What IS verifiable under the pin, and is asserted here:
 *   1. DRIVER-GATE refusal — the engine refuses (reason `driver_not_v2_aware`)
 *      without opening or modifying the store.
 *   2. RED→GREEN transform mechanic (BL-225, names `89849d2a`) — with the
 *      transform disabled the migration never rebuilds an FTS index (empty
 *      `transform`); enabled, it records the exact DROP+CREATE for each index.
 *   3. ROLLBACK — the captured pre-migration image restores through
 *      `restoreStoreOffline` and FTS recovery is proven.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { migrateStoreFormatOffline } from '../store-rebuild.js';
import { restoreStoreOffline } from '../store-rebuild.js';
import { TursoAdapterImpl } from '../turso-adapter.js';

const UID = '89849d2a';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmpDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sox-fts-migrate-89849d2a-')));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sha(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

const WORDS = 'alpha beta gamma delta epsilon zeta theta kappa lambda omicron sigma upsilon'.split(' ');
function doc(i: number): string {
  let s = '';
  for (let j = 0; j < 60; j++) s += `${WORDS[(i * 7 + j * 13) % WORDS.length]} `;
  return `${s} tok${i}`;
}

interface RawDb {
  exec(sql: string): Promise<unknown>;
  prepare(sql: string): Promise<{ run(...a: unknown[]): Promise<unknown>; get(...a: unknown[]): Promise<Record<string, unknown>> }>;
  close(): Promise<unknown>;
}

const ROUNDS = 10;
const PER_ROUND = 100;

/**
 * Seed a LEAKED store with the raw Turso driver (no adapter, no open-time
 * ceremony): a `node` table carrying one `USING fts` index, populated with an
 * interleaved insert + `OPTIMIZE INDEX` loop so the FTS directory btree grows
 * orphaned segments — the same corpus shape `captureFacts`/`verifyReplacement`
 * round-trips, and the leak that `VACUUM INTO` reclaims.
 */
async function seedLeakedStore(dbPath: string): Promise<void> {
  const { connect } = (await import('@tursodatabase/database')) as unknown as {
    connect(p: string, o: Record<string, unknown>): Promise<RawDb>;
  };
  const d = await connect(dbPath, { timeout: 5000, experimental: ['index_method', 'multiprocess_wal'] });
  try {
    await d.exec('CREATE TABLE node (rowid INTEGER PRIMARY KEY, content TEXT)');
    await d.exec('CREATE INDEX idx_fts_node ON node USING fts (content)');
    const ins = await d.prepare('INSERT INTO node (content) VALUES (?)');
    for (let r = 0; r < ROUNDS; r++) {
      for (let j = 0; j < PER_ROUND; j++) await ins.run(doc(r * PER_ROUND + j));
      await d.exec('OPTIMIZE INDEX idx_fts_node');
    }
  } finally {
    await d.close();
  }
}

/** Read the store through a real Turso adapter and round-trip a precise FTS hit. */
async function ftsHits(dbPath: string, token: string): Promise<number> {
  const a = await TursoAdapterImpl.connect({
    dbPath,
    readonly: true,
    allowFtsInReadonly: true,
    idleFlushMs: 3_600_000,
  });
  try {
    const r = await a.executeAll<{ n: number }>(
      `SELECT COUNT(*) AS n FROM node WHERE fts_match(content, ?)`,
      [token],
    );
    return Number(r.rows[0]?.n ?? 0);
  } finally {
    await a.close();
  }
}

describe(`${UID} — Turso FTS v1→v2 format migration (offline, reversible)`, () => {
  it(`${UID}: DRIVER-GATE — refuses under the installed non-v2 driver without opening or modifying the store`, async () => {
    const db = path.join(tmpDir(), 'leaked.db');
    await seedLeakedStore(db);
    const before = sha(db);

    // No `_tursoVersion` seam → the engine reads the INSTALLED driver (0.7.1)
    // and refuses before opening, before any pre-migration image, before any DROP.
    const report = await migrateStoreFormatOffline(db, {});

    expect(report.status).toBe('refused');
    expect(report.reason).toBe('driver_not_v2_aware');
    expect(report.transform).toBeUndefined();
    expect(report.pre_migration_image).toBeUndefined();
    // The store was never opened, let alone modified.
    expect(sha(db)).toBe(before);
  }, 120_000);

  it(`${UID}: RED→GREEN — the transform is the ONLY thing that rebuilds FTS indexes (BL-225, names ${UID})`, async () => {
    // RED: transform disabled (`_skipTransform`) → the migration performs the
    // VACUUM machinery but never rebuilds an FTS index. This is the failure the
    // GREEN assertion would see if the fix were disabled.
    const redDb = path.join(tmpDir(), 'red.db');
    await seedLeakedStore(redDb);
    const red = await migrateStoreFormatOffline(redDb, { _tursoVersion: '0.8.0', _skipTransform: true });
    expect(red.transform).toEqual([]);

    // GREEN: transform enabled → exactly one DROP+CREATE for the single FTS
    // index, with the exact index/table/columns.
    const greenDb = path.join(tmpDir(), 'green.db');
    await seedLeakedStore(greenDb);
    const green = await migrateStoreFormatOffline(greenDb, { _tursoVersion: '0.8.0' });
    expect(green.transform).toHaveLength(1);
    expect(green.transform?.[0]).toMatchObject({
      index: 'idx_fts_node',
      table: 'node',
      columns: ['content'],
    });
  }, 120_000);

  it(`${UID}: ROLLBACK — the pre-migration image restores through restoreStoreOffline and FTS recovery is proven`, async () => {
    const db = path.join(tmpDir(), 'leaked.db');
    await seedLeakedStore(db);

    // Under the 0.7.1 pin the migration runs the transform but `verifyReplacement`
    // correctly refuses the v1-on-v1 leak, so the report is `failed` — yet the
    // pre-migration v1 image was captured FIRST and is carried on the failed
    // report precisely so rollback stays reachable.
    const migrated = await migrateStoreFormatOffline(db, { _tursoVersion: '0.8.0' });
    const image = migrated.pre_migration_image;
    expect(image).toBeDefined();
    expect(fs.existsSync(image!)).toBe(true);

    // Take the store back through the engine's restore path (the plan's sole
    // unverified escape hatch) from the v1 pre-migration image.
    const restored = await restoreStoreOffline(image!, db, { dryRun: false });

    expect(
      restored.status,
      JSON.stringify({ status: restored.status, reason: restored.reason, error: restored.error }),
    ).toBe('restored');

    // Recovery: the store reads back coherently and FTS still round-trips.
    expect(await ftsHits(db, 'tok0')).toBe(1);
  }, 120_000);
});
