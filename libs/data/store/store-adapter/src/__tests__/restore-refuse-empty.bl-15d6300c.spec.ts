/**
 * BL-15d6300c — `restoreStoreOffline` must refuse an empty or schema-less
 * backup, so a restore can never swap an empty store over live data.
 *
 * Before the fix, every "verified" fact came from the backup itself
 * (`captureFacts(backup)` → `verifyReplacement(clone, facts)`): a torn 4096-byte,
 * 1-page, schema-less backup verified `ok:true` against itself and a real run
 * swapped it over a populated store.
 *
 * Fixtures:
 * - the torn backup is built with the raw `@tursodatabase/database` driver
 *   (`PRAGMA user_version` + TRUNCATE checkpoint): the adapter stamps
 *   `_sox_engine`/`_adapter_meta` on its first write, so it cannot produce the
 *   1-page, no-schema file the triage observed. Every other store is built
 *   through `TursoAdapterImpl`.
 * - every path lives under a fresh `os.tmpdir()` dir; nothing resolves `~/.memory`.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { connect } from '@tursodatabase/database';
import { afterEach, describe, expect, it } from 'vitest';
import { restoreStoreOffline, type StoreRestoreReport } from '../store-rebuild.js';
import { TursoAdapterImpl } from '../turso-adapter.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmpDir(): string {
  // realpath: the store reports its canonical path (macOS /var → /private/var).
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl-15d6300c-')));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A closed, checkpointed adapter store holding `node(id, content)` with `rows` rows. */
async function seedNodeStore(dbPath: string, rows: number): Promise<void> {
  const a = await TursoAdapterImpl.connect({ dbPath });
  try {
    await a.executeRun('CREATE TABLE node (id INTEGER PRIMARY KEY, content TEXT NOT NULL)');
    await a.executeRun('CREATE TABLE edge (id INTEGER PRIMARY KEY, src INTEGER, dst INTEGER)');
    for (let i = 0; i < rows; i++) await a.executeRun('INSERT INTO node (content) VALUES (?)', [`row-${i}`]);
  } finally {
    await a.close();
  }
  dropEmptySidecars(dbPath);
}

/** An adapter store with the adapter's own bookkeeping tables and no user schema. */
async function seedSchemaLessStore(dbPath: string): Promise<void> {
  const a = await TursoAdapterImpl.connect({ dbPath });
  try {
    await a.exec('PRAGMA user_version = 1');
  } finally {
    await a.close();
  }
  dropEmptySidecars(dbPath);
}

/** The torn shape from the triage: a 4096-byte, 1-page file with no schema. */
async function seedTornBackup(dbPath: string): Promise<void> {
  const db = await connect(dbPath);
  try {
    await db.exec('PRAGMA user_version = 1');
    await db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    await db.close();
  }
  dropEmptySidecars(dbPath);
  expect(fs.statSync(dbPath).size).toBe(4096);
}

/** A backup is a single closed file: an empty `-wal` beside it is noise. */
function dropEmptySidecars(dbPath: string): void {
  const wal = `${dbPath}-wal`;
  if (fs.existsSync(wal) && fs.statSync(wal).size === 0) fs.rmSync(wal);
}

async function nodeCount(dbPath: string): Promise<number> {
  const a = await TursoAdapterImpl.connect({ dbPath, readonly: true, idleFlushMs: 3_600_000 });
  try {
    const row = await a.executeGet<{ n: number }>('SELECT COUNT(*) AS n FROM node');
    return Number(row?.n ?? 0);
  } finally {
    await a.close();
  }
}

function sha(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function restoreLeftovers(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => n.includes('.restore-') || n.includes('.pre-restore-'));
}

const why = (r: StoreRestoreReport): string =>
  JSON.stringify({ status: r.status, reason: r.reason, error: r.error, restored: r.restored, content: r.content });

/** Target with live data; the scenario the bug destroys. */
async function liveTarget(dir: string, rows = 500): Promise<string> {
  const db = path.join(dir, 'store.db');
  await seedNodeStore(db, rows);
  return db;
}

const MEMORY_OPTS = { requiredTables: ['node', 'edge'], contentTable: 'node' } as const;

describe('BL-15d6300c — restore refuses an empty or schema-less backup', () => {
  it('BL-15d6300c (a): a torn 4096-byte .db-only backup is refused — dry run AND real run; the target is untouched', async () => {
    const dir = tmpDir();
    const db = await liveTarget(dir);
    const backup = path.join(dir, 'torn.db');
    await seedTornBackup(backup);
    const preSha = sha(db);

    const dry = await restoreStoreOffline(backup, db, { dryRun: true });
    expect(dry.status, why(dry)).toBe('refused');
    expect(dry.reason).toBe('backup_empty');

    const real = await restoreStoreOffline(backup, db);
    expect(real.status, why(real)).toBe('refused');
    expect(real.reason).toBe('backup_empty');
    expect(real.content?.backup_page_count).toBe(1);

    expect(sha(db)).toBe(preSha);
    expect(await nodeCount(db)).toBe(500);
    expect(restoreLeftovers(dir)).toEqual([]);
  }, 120_000);

  it('BL-15d6300c (b): a schema-less adapter store (only _sox_engine/_adapter_meta) is refused as backup_no_schema', async () => {
    const dir = tmpDir();
    const db = await liveTarget(dir);
    const backup = path.join(dir, 'schemaless.db');
    await seedSchemaLessStore(backup);
    const preSha = sha(db);

    for (const dryRun of [true, false]) {
      const r = await restoreStoreOffline(backup, db, { dryRun });
      expect(r.status, why(r)).toBe('refused');
      expect(r.reason).toBe('backup_no_schema');
    }
    expect(sha(db)).toBe(preSha);
    expect(restoreLeftovers(dir)).toEqual([]);
  }, 120_000);

  it('BL-15d6300c (b2): a backup missing a required table is refused as backup_no_schema', async () => {
    const dir = tmpDir();
    const db = await liveTarget(dir);
    const backup = path.join(dir, 'other.db');
    const a = await TursoAdapterImpl.connect({ dbPath: backup });
    try {
      await a.executeRun('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      await a.executeRun("INSERT INTO t (v) VALUES ('x')");
    } finally {
      await a.close();
    }
    dropEmptySidecars(backup);
    const r = await restoreStoreOffline(backup, db, { dryRun: true, ...MEMORY_OPTS });
    expect(r.status, why(r)).toBe('refused');
    expect(r.reason).toBe('backup_no_schema');
    expect(r.error).toContain('node');
  }, 120_000);

  it('BL-15d6300c (b3): a backup with the schema but zero nodes is refused as backup_empty', async () => {
    const dir = tmpDir();
    const db = await liveTarget(dir);
    const backup = path.join(dir, 'zero.db');
    await seedNodeStore(backup, 0);
    for (const dryRun of [true, false]) {
      const r = await restoreStoreOffline(backup, db, { dryRun, ...MEMORY_OPTS });
      expect(r.status, why(r)).toBe('refused');
      expect(r.reason).toBe('backup_empty');
      expect(r.content?.backup_count).toBe(0);
    }
    expect(await nodeCount(db)).toBe(500);
  }, 120_000);

  it('BL-15d6300c (c): a good backup restores', async () => {
    const dir = tmpDir();
    const db = await liveTarget(dir, 50);
    const backup = path.join(dir, 'good.db');
    await seedNodeStore(backup, 45);
    const backupSha = sha(backup);
    const dry = await restoreStoreOffline(backup, db, { dryRun: true, ...MEMORY_OPTS });
    expect(dry.status, why(dry)).toBe('dry_run');
    const r = await restoreStoreOffline(backup, db, MEMORY_OPTS);
    expect(r.status, why(r)).toBe('restored');
    expect(r.content).toMatchObject({ table: 'node', backup_count: 45, target_count: 50 });
    expect(sha(db)).toBe(backupSha);
    expect(await nodeCount(db)).toBe(45);
  }, 120_000);

  it('BL-15d6300c (d): allowEmptyBackup lets a deliberately empty backup through (torn and zero-row)', async () => {
    const dir = tmpDir();
    const db = await liveTarget(dir);
    const zero = path.join(dir, 'zero.db');
    await seedNodeStore(zero, 0);
    const dry = await restoreStoreOffline(zero, db, { dryRun: true, allowEmptyBackup: true, ...MEMORY_OPTS });
    expect(dry.status, why(dry)).toBe('dry_run');
    const r = await restoreStoreOffline(zero, db, { allowEmptyBackup: true, ...MEMORY_OPTS });
    expect(r.status, why(r)).toBe('restored');
    expect(await nodeCount(db)).toBe(0);
    expect(r.replaced_path).toBeDefined();

    const torn = path.join(dir, 'torn.db');
    await seedTornBackup(torn);
    const t = await restoreStoreOffline(torn, db, { dryRun: true, allowEmptyBackup: true });
    expect(t.status, why(t)).toBe('dry_run');
  }, 120_000);

  it('BL-15d6300c: a backup with >90% fewer nodes than the live target is refused as backup_shrinks_store; the override and the threshold are honoured', async () => {
    const dir = tmpDir();
    const db = await liveTarget(dir, 500);
    const backup = path.join(dir, 'small.db');
    await seedNodeStore(backup, 20); // a 96% drop
    const preSha = sha(db);

    const r = await restoreStoreOffline(backup, db, MEMORY_OPTS);
    expect(r.status, why(r)).toBe('refused');
    expect(r.reason).toBe('backup_shrinks_store');
    expect(r.content).toMatchObject({ table: 'node', backup_count: 20, target_count: 500 });
    expect(sha(db)).toBe(preSha);
    expect(restoreLeftovers(dir)).toEqual([]);

    const loose = await restoreStoreOffline(backup, db, { dryRun: true, maxContentDrop: 0.99, ...MEMORY_OPTS });
    expect(loose.status, why(loose)).toBe('dry_run');
    const forced = await restoreStoreOffline(backup, db, { dryRun: true, allowContentDrop: true, ...MEMORY_OPTS });
    expect(forced.status, why(forced)).toBe('dry_run');
    // The target's read-only open for the count left nothing a swap would trip on.
    const ok = await restoreStoreOffline(backup, db, { allowContentDrop: true, ...MEMORY_OPTS });
    expect(ok.status, why(ok)).toBe('restored');
    expect(await nodeCount(db)).toBe(20);
  }, 120_000);

  it('BL-15d6300c: an absent target is not a shrink — a first restore onto a missing store proceeds', async () => {
    const dir = tmpDir();
    const db = path.join(dir, 'fresh.db');
    const backup = path.join(dir, 'good.db');
    await seedNodeStore(backup, 5);
    const r = await restoreStoreOffline(backup, db, { dryRun: true, ...MEMORY_OPTS });
    expect(r.status, why(r)).toBe('dry_run');
    expect(r.content?.target_count ?? null).toBeNull();
  }, 120_000);
});
