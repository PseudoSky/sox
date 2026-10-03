/**
 * BL-00296157 — defend the FTS-format-migration ROLLBACK image and the RESTORE
 * contract for a previous-format (v1) store.
 *
 * Two defects, each proven red→green here:
 *
 *  (a) IMAGE GUARD. `migrateStoreFormatOffline` advertises `<db>.pre-migration-<ts>`
 *      as the byte-exact rollback image, but the image is a MAIN-FILE-ONLY reflink
 *      (`copyFileSync(..., COPYFILE_FICLONE)`). If the source `-wal` still holds
 *      committed-but-uncheckpointed frames at that instant, the image silently
 *      omits them and advertises an incomplete recovery point. The fix refuses a
 *      non-empty source `-wal` BEFORE the gate's writable open (whose own
 *      open-time self-heal would otherwise write v2 pages into the WAL and make
 *      even a clean previous-format source read as dirty), throwing the typed
 *      operator-action error `E_ROLLBACK_IMAGE_WAL_NOT_EMPTY` — no image written,
 *      no swap, source untouched. No checkpoint is introduced (ADR-0012); the
 *      refusal is a typed operator action surfaced by the CLI (ADR-0013 D4).
 *
 *  (b) RESTORE CONTRACT. `restoreStoreOffline` runs `captureFacts`, whose FTS
 *      sentinel round-trip calls `fts_match`. Under the installed 0.8.x driver a
 *      genuine v1 index raises `FTS index ... was created by an older version of
 *      Turso ...`, which was caught and turned the restore into `status:'failed'`
 *      — so the advertised rollback image could not be restored at all. The fix
 *      detects the driver's previous-format refusal, skips the sentinel round-trip,
 *      records `fts_verified:false` / `reason:'previous_format_unreadable_by_driver'`,
 *      STILL runs `PRAGMA integrity_check` + base-table counts + `maxContentDrop`,
 *      and returns `status:'restored'` carrying `restored_format:'v1'`. A genuine
 *      current-format (v2) corruption still fails closed (the refusal is matched
 *      narrowly: only `/created by an older version of Turso/` is tolerated).
 *
 * The v1 fixture is seeded with the 0.7.2 driver that lives beside the spike
 * scripts; the installed driver is 0.8.1. Fixtures are deliberately SMALL: the
 * open-time heal's v2 pages stay in the `-wal` and are never checkpointed into
 * the main file during the heal, so the main-file-only image is a genuine v1
 * store at any corpus size.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { migrateStoreFormatOffline } from '../store-rebuild.js';
import { restoreStoreOffline } from '../store-rebuild.js';
import { RollbackImageWalNotEmptyError } from '../errors.js';

const UID = '00296157';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmpDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sox-store-rebuild-rollback-')));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sha(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

const WORDS = 'alpha beta gamma delta epsilon zeta theta kappa lambda omicron sigma upsilon'.split(' ');
/** Small corpus: enough rows to exercise the mid/last sentinel offsets, no more. */
const V1_ROWS = 40;
function docV1(i: number): string {
  let s = '';
  for (let j = 0; j < 12; j++) s += `${WORDS[(i * 5 + j * 7) % WORDS.length]} `;
  return `${s} tok${i}`;
}

interface RawDb {
  exec(sql: string): Promise<unknown>;
  prepare(sql: string): Promise<{ run(...a: unknown[]): Promise<unknown>; get(...a: unknown[]): Promise<Record<string, unknown>> }>;
  close(): Promise<unknown>;
}

/** Raw 0.7.2 driver co-located with the spike probes (the installed package is 0.8.1). */
const V1_DRIVER_URL = new URL(
  '../../scripts/turso-driver-probes/researcher-exp/node_modules/@tursodatabase/database/dist/promise.js',
  import.meta.url,
);

async function loadV1Driver(): Promise<{ connect(p: string, o: Record<string, unknown>): Promise<RawDb> }> {
  return (await import(V1_DRIVER_URL.href)) as unknown as {
    connect(p: string, o: Record<string, unknown>): Promise<RawDb>;
  };
}

/**
 * Seed a genuine PREVIOUS-FORMAT (v1) store with the 0.7.2 driver: a `node`
 * table + one `USING fts` index over a small corpus, checkpointed (TRUNCATE) and
 * closed so the source `-wal` is empty — the clean operator state the migration
 * image guard requires.
 */
async function seedV1Store(dbPath: string): Promise<void> {
  const { connect } = await loadV1Driver();
  const d = await connect(dbPath, { timeout: 5000, experimental: ['index_method', 'multiprocess_wal'] });
  try {
    await d.exec('CREATE TABLE node (rowid INTEGER PRIMARY KEY, content TEXT)');
    await d.exec('CREATE INDEX idx_fts_node ON node USING fts (content)');
    const ins = await d.prepare('INSERT INTO node (content) VALUES (?)');
    for (let i = 0; i < V1_ROWS; i++) await ins.run(docV1(i));
    await d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    await d.close();
  }
}

/**
 * A raw writable 0.8.1 open + `fts_match`. The installed driver refuses a v1
 * index ("...older version of Turso..."), so this REJECTS for a genuine v1 store
 * and resolves for a v2 store — the format oracle the restore contract needs.
 */
async function probeFtsWith08(dbPath: string): Promise<void> {
  const { connect } = (await import('@tursodatabase/database')) as unknown as {
    connect(p: string, o: Record<string, unknown>): Promise<RawDb>;
  };
  const d = await connect(dbPath, { timeout: 5000, experimental: ['index_method', 'multiprocess_wal'] });
  try {
    const stmt = await d.prepare('SELECT COUNT(*) AS n FROM node WHERE fts_match(content, ?)');
    await stmt.get('tok0');
  } finally {
    await d.close();
  }
}

/** Read a genuine v1 store with the 0.7.2 driver — proof it is a complete, recoverable rollback. */
async function v1FtsHits(dbPath: string, token: string): Promise<number> {
  const { connect } = await loadV1Driver();
  const d = await connect(dbPath, { timeout: 5000, experimental: ['index_method', 'multiprocess_wal'] });
  try {
    const stmt = await d.prepare('SELECT COUNT(*) AS n FROM node WHERE fts_match(content, ?)');
    const row = await stmt.get(token);
    return Number(row?.n ?? 0);
  } finally {
    await d.close();
  }
}

describe(`${UID} — FTS migration rollback image + previous-format restore contract`, () => {
  it(`${UID} (a): a non-empty source -wal refuses the migration with E_ROLLBACK_IMAGE_WAL_NOT_EMPTY, writes no image, and leaves the source untouched`, async () => {
    const dir = tmpDir();
    const db = path.join(dir, 'v1.db');
    await seedV1Store(db);

    // Make the source `-wal` non-empty. The guard reads its SIZE only, so a
    // synthetic sidecar is sufficient — and it proves the guard fires on the
    // operator-visible condition (uncheckpointed committed frames) before any
    // store is opened or any image is written.
    fs.writeFileSync(`${db}-wal`, Buffer.alloc(4096, 7));
    const sourceBefore = sha(db);
    const walBefore = sha(`${db}-wal`);

    let caught: unknown;
    try {
      await migrateStoreFormatOffline(db, {});
    } catch (err) {
      caught = err;
    }

    expect(caught, 'migrateStoreFormatOffline must REFUSE a non-empty source -wal').toBeInstanceOf(
      RollbackImageWalNotEmptyError,
    );
    expect((caught as RollbackImageWalNotEmptyError).code).toBe('E_ROLLBACK_IMAGE_WAL_NOT_EMPTY');
    expect((caught as RollbackImageWalNotEmptyError).walBytes).toBe(4096);

    // No image was written (there is no `.pre-migration-*` file), and the source
    // store's bytes — main file and `-wal` — are untouched.
    const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.pre-migration-'));
    expect(leftovers, `no rollback image may be written, found: ${leftovers.join(', ')}`).toEqual([]);
    expect(sha(db)).toBe(sourceBefore);
    expect(sha(`${db}-wal`)).toBe(walBefore);
  }, 120_000);

  it(`${UID} (b): a clean v1 source migrates, and its previous-format image restores to a readable v1 store`, async () => {
    const dir = tmpDir();
    const db = path.join(dir, 'v1.db');
    await seedV1Store(db);
    const sourceBefore = sha(db);

    // Clean source (empty `-wal` after the seed's TRUNCATE checkpoint) → migrates.
    const report = await migrateStoreFormatOffline(db, {});
    expect(
      report.status,
      JSON.stringify({ status: report.status, reason: report.reason, error: report.error }),
    ).toBe('migrated');
    const image = report.pre_migration_image;
    expect(image).toBeTruthy();
    expect(fs.existsSync(image as string)).toBe(true);

    // The rollback image is the pristine v1 source, byte-for-byte.
    expect(sha(image as string)).toBe(sourceBefore);

    // Restore it under the installed 0.8.1 driver. Pre-fix this returned
    // `status:'failed'` because captureFacts' fts_match sentinel probe raised the
    // driver's previous-format refusal; post-fix it succeeds, skipping ONLY the
    // FTS sentinel round-trip and still checking integrity + base-table counts.
    const r2 = await restoreStoreOffline(image as string, db, {});
    expect(
      r2.status,
      JSON.stringify({ status: r2.status, reason: r2.reason, error: r2.error, verification: r2.verification }),
    ).toBe('restored');
    expect(r2.restored_format).toBe('v1');
    expect(r2.verification?.fts_verified).toBe(false);
    expect(r2.verification?.fts_skip_reason).toBe('previous_format_unreadable_by_driver');
    expect(r2.verification?.integrity.ok).toBe(true);
    expect(r2.verification?.ok).toBe(true);

    const nodeCounts = r2.verification?.table_counts.find((t) => t.table === 'node');
    expect(nodeCounts?.source).toBe(V1_ROWS);
    expect(nodeCounts?.replacement).toBe(V1_ROWS);
    expect(nodeCounts?.ok).toBe(true);

    // The restored store is GENUINELY v1: the installed 0.8.1 driver refuses its
    // FTS index with the old-format message...
    const probe08 = path.join(dir, 'restored-0.8.db');
    fs.copyFileSync(db, probe08);
    await expect(probeFtsWith08(probe08)).rejects.toThrow(/older version of Turso/);

    // ...and the 0.7.2 driver reads it perfectly (a complete, recoverable rollback).
    const probe07 = path.join(dir, 'restored-0.7.db');
    fs.copyFileSync(db, probe07);
    expect(await v1FtsHits(probe07, 'tok0')).toBe(1);
  }, 120_000);
});
