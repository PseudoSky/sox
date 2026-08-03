/**
 * BL-391 — federated recall's BM25 arm is dead on Turso under a read-only
 * connection, and the failure is swallowed.
 *
 * Root cause (measured empirically 2026-08-03, NOT the missing index_method
 * flag — that experiment is unconditionally on for every Turso connection
 * regardless of readonly, see turso-adapter.ts's `connect()`):
 *
 *   readonly: false  -> fts_match: 1 hit
 *   readonly: true   -> fts_match: step failed: Error: Resource is read-only
 *
 * A plain `COUNT(*)` works identically under both. Independently, setting
 * `PRAGMA query_only=ON` on an otherwise-writable connection produces the
 * SAME class of failure via a different message:
 *   "Parse error: Cannot execute write statement in query_only mode"
 * i.e. Turso's query planner treats `fts_match` as a write-shaped statement
 * — a genuine engine limitation on THIS specific function, not a
 * configuration gap on our side.
 *
 * The fix: `TursoAdapterImpl.connect({ readonly: true, allowFtsInReadonly:
 * true })` opens the native driver connection WITHOUT its readonly option
 * (so fts_match keeps working) and instead enforces read-only at the
 * application layer — `executeRun`/`exec`/`transaction` all throw
 * immediately. This test proves:
 *   1. RED: hard readonly (`readonly: true` alone) fails fts_match with
 *      "Resource is read-only" — the exact BL-391 symptom.
 *   2. GREEN: soft readonly (`readonly: true, allowFtsInReadonly: true`)
 *      makes fts_match succeed.
 *   3. Soft readonly still refuses writes — it is not a bypass of
 *      read-only semantics, just a different enforcement layer.
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
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-turso-bl391-'));
});

function tempPath(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpDir, `${label}-${suffix}.db`);
}

const openAdapters: TursoAdapterImpl[] = [];

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

async function seedFtsStore(dbPath: string): Promise<void> {
  const w = await TursoAdapterImpl.connect({ dbPath });
  await w.exec('CREATE TABLE node (id INTEGER PRIMARY KEY, content TEXT)');
  await w.executeRun('INSERT INTO node (id, content) VALUES (?, ?)', [1, 'hello world']);
  await w.executeRun('INSERT INTO node (id, content) VALUES (?, ?)', [2, 'goodbye moon']);
  await w.exec('CREATE INDEX IF NOT EXISTS idx_fts_node ON "node" USING fts ("content")');
  await w.close();
}

tursoDescribe('BL-391 — TursoAdapter readonly connections and fts_match', () => {
  it('RED: hard readonly (readonly:true alone) fails fts_match with "Resource is read-only", while COUNT(*) works identically', async () => {
    const dbPath = tempPath('hard-readonly');
    await seedFtsStore(dbPath);

    const ro = await TursoAdapterImpl.connect({ dbPath, readonly: true });
    openAdapters.push(ro);

    // Plain reads are fine under hard readonly — proves this is NOT a
    // generic "reads are broken" problem.
    const count = await ro.executeGet<{ c: number }>('SELECT COUNT(*) as c FROM node');
    expect(count?.c).toBe(2);

    // fts_match specifically fails.
    await expect(
      ro.executeAll('SELECT id FROM node WHERE fts_match(content, ?)', ['hello']),
    ).rejects.toThrow(/read-only/i);
  });

  it('GREEN: soft readonly (allowFtsInReadonly:true) makes fts_match succeed', async () => {
    const dbPath = tempPath('soft-readonly-green');
    await seedFtsStore(dbPath);

    const soft = await TursoAdapterImpl.connect({ dbPath, readonly: true, allowFtsInReadonly: true });
    openAdapters.push(soft);

    const count = await soft.executeGet<{ c: number }>('SELECT COUNT(*) as c FROM node');
    expect(count?.c).toBe(2);

    const rows = await soft.executeAll<{ id: number }>(
      'SELECT id FROM node WHERE fts_match(content, ?)',
      ['hello'],
    );
    expect(rows.rows.map((r) => r.id)).toEqual([1]);

    const moonRows = await soft.executeAll<{ id: number }>(
      'SELECT id FROM node WHERE fts_match(content, ?)',
      ['moon'],
    );
    expect(moonRows.rows.map((r) => r.id)).toEqual([2]);
  });

  it('soft readonly still refuses writes — executeRun, exec, and transaction all throw', async () => {
    const dbPath = tempPath('soft-readonly-writeguard');
    await seedFtsStore(dbPath);

    const soft = await TursoAdapterImpl.connect({ dbPath, readonly: true, allowFtsInReadonly: true });
    openAdapters.push(soft);

    await expect(
      soft.executeRun('INSERT INTO node (id, content) VALUES (?, ?)', [99, 'should not land']),
    ).rejects.toThrow(/read-only/i);

    await expect(soft.exec('DELETE FROM node')).rejects.toThrow(/read-only/i);

    await expect(
      soft.transaction(async (tx) => {
        await tx.executeRun('DELETE FROM node');
      }),
    ).rejects.toThrow(/read-only/i);

    // Prove none of the blocked attempts actually mutated the store.
    const count = await soft.executeGet<{ c: number }>('SELECT COUNT(*) as c FROM node');
    expect(count?.c).toBe(2);
  });

  it('capabilities.fts is still advertised true for a soft-readonly connection (it genuinely works)', async () => {
    const dbPath = tempPath('soft-readonly-caps');
    await seedFtsStore(dbPath);

    const soft = await TursoAdapterImpl.connect({ dbPath, readonly: true, allowFtsInReadonly: true });
    openAdapters.push(soft);
    expect(soft.capabilities.fts).toBe(true);
  });
});
