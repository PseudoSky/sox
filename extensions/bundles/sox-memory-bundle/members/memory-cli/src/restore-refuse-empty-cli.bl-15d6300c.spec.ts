/**
 * BL-15d6300c — `memory restore` surfaces the store-adapter's content
 * refusals (empty / schema-less / shrinking backup) and exits non-zero, dry
 * run included; `--allow-empty-backup` and `--allow-shrink` are the explicit
 * overrides.
 *
 * Isolation: HOME is a fresh temp dir for every test and every invocation
 * passes `--db`, so nothing here can resolve `~/.memory/memory.db`. Every store
 * is built through `openDb` (the real memory-core schema) except the torn
 * backup, which is the raw `@tursodatabase/database` driver's 4096-byte,
 * 1-page file — the adapter stamps its bookkeeping tables on first write and
 * cannot produce that shape.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { connect } from '@tursodatabase/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '@adhd/sox-memory-core';
import { TursoAdapterImpl } from '@adhd/sox-store-adapter';
import { runCli } from './index.js';

const T = 120_000;
const cleanups: Array<() => void | Promise<void>> = [];
let logs: string[];
let errs: string[];
let savedHome: string | undefined;

class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

beforeEach(() => {
  logs = [];
  errs = [];
  savedHome = process.env['HOME'];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl-15d6300c-home-'));
  process.env['HOME'] = home;
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errs.push(a.map(String).join(' '));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code);
  }) as never);
  cleanups.push(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
});

function tmpDir(): string {
  // realpath: the store reports its canonical path (macOS /var → /private/var).
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl-15d6300c-')));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A closed memory store with `rows` episode nodes. A backup is a single closed file: an empty `-wal` is dropped. */
async function seedMemoryStore(dbPath: string, rows: number): Promise<void> {
  const a = await openDb(dbPath);
  try {
    for (let i = 0; i < rows; i++) {
      await a.executeRun('INSERT INTO node (uid, kind, content, name, summary, t_created) VALUES (?, ?, ?, ?, ?, ?)', [
        `u${i}`,
        'episode',
        `alpha beta gamma ${i}`,
        `name ${i}`,
        'summary text',
        new Date().toISOString(),
      ]);
    }
  } finally {
    await a.close();
  }
  dropEmptyWal(dbPath);
}

async function seedTornBackup(dbPath: string): Promise<void> {
  const db = await connect(dbPath);
  try {
    await db.exec('PRAGMA user_version = 1');
    await db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    await db.close();
  }
  dropEmptyWal(dbPath);
  expect(fs.statSync(dbPath).size).toBe(4096);
}

function dropEmptyWal(dbPath: string): void {
  const wal = `${dbPath}-wal`;
  if (fs.existsSync(wal) && fs.statSync(wal).size === 0) fs.rmSync(wal);
}

async function nodeCount(dbPath: string): Promise<number> {
  const a = await TursoAdapterImpl.connect({ dbPath, readonly: true, allowFtsInReadonly: true, idleFlushMs: 3_600_000 });
  try {
    const row = await a.executeGet<{ n: number }>('SELECT COUNT(*) AS n FROM node');
    return Number(row?.n ?? 0);
  } finally {
    await a.close();
  }
}

function sha(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

describe('BL-15d6300c — memory restore refuses an empty or schema-less backup', () => {
  it('BL-15d6300c (e): a torn backup is REFUSED with exit 2 — dry run and real run — and the store is untouched', async () => {
    const dir = tmpDir();
    const db = path.join(dir, 'memory.db');
    await seedMemoryStore(db, 200);
    const backup = path.join(dir, 'torn.db');
    await seedTornBackup(backup);
    const preSha = sha(db);

    await expect(runCli(['restore', backup, '--db', db, '--dry-run'])).rejects.toMatchObject({ code: 2 });
    expect(errs.join('\n')).toContain('[restore] REFUSED (backup_no_schema)');
    errs.length = 0;
    await expect(runCli(['restore', backup, '--db', db])).rejects.toMatchObject({ code: 2 });
    expect(errs.join('\n')).toContain('[restore] REFUSED (backup_no_schema)');
    expect(errs.join('\n')).toContain('1 page(s)');
    expect(errs.join('\n')).not.toContain('soxe service disable'); // not a peers problem
    expect(logs.join('\n')).not.toContain('[restore] complete');
    // The torn file has no node/edge tables: the override for EMPTY stores does not make it a memory store.
    errs.length = 0;
    await expect(runCli(['restore', backup, '--db', db, '--allow-empty-backup'])).rejects.toMatchObject({ code: 2 });
    expect(errs.join('\n')).toContain('backup_no_schema');

    expect(sha(db)).toBe(preSha);
    expect(await nodeCount(db)).toBe(200);
    expect(fs.readdirSync(dir).filter((n) => n.includes('restore-'))).toEqual([]);
  }, T);

  it('BL-15d6300c (e): a zero-node memory store is REFUSED (backup_empty); --allow-empty-backup restores it', async () => {
    const dir = tmpDir();
    const db = path.join(dir, 'memory.db');
    await seedMemoryStore(db, 200);
    const backup = path.join(dir, 'empty.db');
    await seedMemoryStore(backup, 0);
    const preSha = sha(db);

    await expect(runCli(['restore', backup, '--db', db, '--dry-run'])).rejects.toMatchObject({ code: 2 });
    expect(errs.join('\n')).toContain('[restore] REFUSED (backup_empty)');
    expect(errs.join('\n')).toContain('--allow-empty-backup');
    expect(sha(db)).toBe(preSha);

    await runCli(['restore', backup, '--db', db, '--allow-empty-backup']);
    expect(logs.join('\n')).toContain('[restore] complete');
    expect(await nodeCount(db)).toBe(0);
    expect(fs.readdirSync(dir).some((n) => n.startsWith('memory.db.pre-restore-'))).toBe(true);
  }, T);

  it('BL-15d6300c (e): a backup with <10% of the live nodes is REFUSED (backup_shrinks_store); --allow-shrink restores it', async () => {
    const dir = tmpDir();
    const db = path.join(dir, 'memory.db');
    await seedMemoryStore(db, 200);
    const backup = path.join(dir, 'small.db');
    await seedMemoryStore(backup, 10);
    const preSha = sha(db);

    await expect(runCli(['restore', backup, '--db', db])).rejects.toMatchObject({ code: 2 });
    expect(errs.join('\n')).toContain('[restore] REFUSED (backup_shrinks_store)');
    expect(errs.join('\n')).toContain('node=10; live store node=200');
    expect(errs.join('\n')).toContain('--allow-shrink');
    expect(sha(db)).toBe(preSha);

    await runCli(['restore', backup, '--db', db, '--allow-shrink']);
    expect(logs.join('\n')).toContain('[restore] complete');
    expect(await nodeCount(db)).toBe(10);
  }, T);

  it('BL-15d6300c (c): a good backup restores through the CLI', async () => {
    const dir = tmpDir();
    const db = path.join(dir, 'memory.db');
    await seedMemoryStore(db, 20);
    const backup = path.join(dir, 'good.db');
    await seedMemoryStore(backup, 30);
    await runCli(['restore', backup, '--db', db]);
    expect(logs.join('\n')).toContain('[restore] complete');
    expect(await nodeCount(db)).toBe(30);
  }, T);
});
