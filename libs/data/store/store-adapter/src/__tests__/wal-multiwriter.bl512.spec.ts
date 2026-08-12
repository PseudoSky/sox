/**
 * BL-512 — concurrent multiprocess-wal writers must not lose writes, and the
 * connect-path engine probe must never open the store with a legacy engine.
 *
 * The DISCRIMINATING proof for the connect-loss defect is the standalone
 * forked-children repro (6 processes × 3 connects; RED on the old code:
 * "Database is already open without experimental multiprocess WAL in another
 * process", 9/18 writes persisted — reproduced live 2026-08-12). The turso
 * engine only refuses CROSS-process legacy openers, so an in-process spec
 * cannot reproduce the race; what this file pins in-process instead:
 *
 *  1. The connect ceremony never loads or constructs better-sqlite3 on a
 *     header-identifiable store — the lock-free probe is primary (BL-512).
 *     The old code constructed it on EVERY writable connect (pragma-first) —
 *     exactly the legacy opener that made concurrent turso multiprocess opens
 *     refuse and drop writes. Verified in a FRESH child process
 *     (`fixtures/bl512-probe-child.ts`, cold module cache, `Module._load`
 *     interception) so the engine-guard constructor cache cannot mask the
 *     regression. This is the RED→GREEN discriminator this suite can run in
 *     CI: on the old ordering the child reports BSQL3_LOADS≥1 /
 *     BSQL3_CONSTRUCTIONS≥1 and this test fails; on the fix it reports 0/0.
 *  2. 6×3 concurrent writable connects + inserts against ONE store, all
 *     durably persisted (18/18) — the adapter's in-process concurrency
 *     contract (the standalone forked-children script covers the
 *     cross-process half).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
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

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const CHILD = resolve(HERE, 'fixtures', 'bl512-probe-child.ts');

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-bl512-multiwriter-'));
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

tursoDescribe('BL-512 — multiprocess-wal concurrent writers', () => {
  it('the writable connect ceremony never loads/constructs better-sqlite3 (header-first probe)', () => {
    const dbPath = tempPath('bl512-no-legacy-probe');

    // Pre-seed through the REAL adapter so the child's connect runs against an
    // existing store (production shape) — seeding itself must not touch
    // better-sqlite3 either, but the child is the discriminated measurement.
    const seedRun = spawnSync(process.execPath, ['--import', 'tsx', CHILD, dbPath], {
      encoding: 'utf8',
      cwd: process.cwd(),
    });
    expect(seedRun.status, `seed child failed: ${seedRun.stderr}`).toBe(0);
    expect(seedRun.stdout).toContain('CONNECT_OK=1');

    // The measured run. On the pre-fix ordering readApplicationId ran
    // pragma-first → better-sqlite3 required AND constructed during connect.
    const run = spawnSync(process.execPath, ['--import', 'tsx', CHILD, dbPath], {
      encoding: 'utf8',
      cwd: process.cwd(),
    });
    expect(run.status, `probe child failed: ${run.stderr}`).toBe(0);
    const loads = Number(/BSQL3_LOADS=(\d+)/.exec(run.stdout)?.[1] ?? -1);
    const constructions = Number(/BSQL3_CONSTRUCTIONS=(\d+)/.exec(run.stdout)?.[1] ?? -1);
    expect(
      loads,
      'BL-512: connect must not load better-sqlite3 on a header-identifiable store',
    ).toBe(0);
    expect(
      constructions,
      'BL-512: connect must not construct better-sqlite3 — the legacy opener that lost concurrent writes',
    ).toBe(0);
    expect(run.stdout).toContain('CONNECT_OK=1');
  });

  it('6×3 concurrent writable connects against one store: all 18 writes durably persist, zero connect failures', async () => {
    const dbPath = tempPath('bl512-multiwriter');
    const seed = await connect(dbPath);
    await seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
    await seed.close();
    openAdapters.pop();

    const failures: string[] = [];
    await Promise.all(
      Array.from({ length: 18 }, async (_, i) => {
        try {
          const a = await TursoAdapterImpl.connect({ dbPath });
          await a.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, val TEXT)');
          await a.executeRun('INSERT INTO t (val) VALUES (?)', [`v${i}`]);
          await a.close();
        } catch (err) {
          failures.push(`${i}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );

    expect(failures, `connect/write failures: ${failures.join(' | ')}`).toEqual([]);

    const v = await connect(dbPath);
    const row = await v.executeGet<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM t');
    expect(row!.cnt).toBe(18);
    for (let i = 0; i < 18; i++) {
      const found = await v.executeGet<{ val: string }>('SELECT val FROM t WHERE val = ?', [`v${i}`]);
      expect(found, `row v${i} must be durably present`).not.toBeNull();
    }
  });
});
