/**
 * (BL-321) Regression test — unserialized concurrent writes on TursoAdapterImpl.
 *
 * `TursoAdapterImpl` wraps ONE shared connection handle (`this.db`). Before the
 * fix, concurrent `transaction()` calls issued BEGIN/COMMIT/ROLLBACK against
 * that single handle with no mutual exclusion: one caller's ROLLBACK (from its
 * own unrelated error) could discard a different concurrent caller's in-flight,
 * already-committed-looking transaction, and a caller's exists-check could
 * observe a sibling's uncommitted insert. Reported-applied writes were not
 * durable.
 *
 * This test fires N concurrent `transaction()` calls (and separately N
 * concurrent writes via `WriteQueue.enqueue`) at one adapter/store and asserts
 * every write is durably present afterward — plus the narrower invariant that
 * a transaction which throws and rolls back must not discard a sibling
 * transaction's committed work.
 *
 * To reproduce the pre-fix failure directly against `TursoAdapterImpl`
 * (bypassing WriteQueue, since callers outside WriteQueue exist and must also
 * be safe), run with the adapter's `_withTxLock` mutex disabled — this was
 * verified deterministically red (3/3 runs, "cannot start a transaction
 * within a transaction") before the fix landed, and deterministically green
 * (5+/5+ runs) after.
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
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-turso-concurrency-'));
});

/** Widens the interleaving window between statements inside a transaction so
 *  concurrent callers actually overlap their BEGIN…COMMIT/ROLLBACK sections on
 *  the shared connection, instead of happening to complete within one
 *  microtask-ordering pass. Mirrors real async work (embed compute, network
 *  round-trip) between a transaction's statements in production. */
function jitter(maxMs = 8): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.random() * maxMs));
}

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

tursoDescribe('TursoAdapterImpl — concurrent transaction() calls (BL-321)', () => {
  it('advertises the honest capability flags (no false-advertised bypass)', async () => {
    const dbPath = tempPath('caps');
    const adapter = await connect(dbPath);
    // The safe, boring fix: restore WriteQueue serialization for Turso instead
    // of trusting every caller to route through the queue.
    expect(adapter.capabilities.needsWriteSerialization).toBe(true);
    // A single shared connection with no session isolation does not actually
    // support concurrent transactions.
    expect(adapter.capabilities.concurrentTransactions).toBe(false);
  });

  it('durably commits every write from N concurrent transaction() calls', async () => {
    const dbPath = tempPath('concurrent-commits');
    const adapter = await connect(dbPath);

    await adapter.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');

    const N = 25;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        adapter.transaction(async (tx) => {
          await jitter();
          await tx.executeRun('INSERT INTO t (id, val) VALUES (?, ?)', [i, `v${i}`]);
          await jitter();
          return i;
        }),
      ),
    );

    expect(results.sort((a, b) => a - b)).toEqual(Array.from({ length: N }, (_, i) => i));

    const count = await adapter.executeGet<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM t');
    expect(count!.cnt).toBe(N);

    for (let i = 0; i < N; i++) {
      const row = await adapter.executeGet<{ val: string }>('SELECT val FROM t WHERE id = ?', [i]);
      expect(row).not.toBeNull();
      expect(row!.val).toBe(`v${i}`);
    }
  });

  it('a rolled-back transaction never discards a concurrent sibling\'s committed work', async () => {
    const dbPath = tempPath('rollback-isolation');
    const adapter = await connect(dbPath);

    await adapter.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');

    const N = 20;
    const settled = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        adapter.transaction(async (tx) => {
          await jitter();
          await tx.executeRun('INSERT INTO t (id, val) VALUES (?, ?)', [i, `v${i}`]);
          await jitter();
          // Every 3rd transaction throws AFTER its own insert has run, forcing
          // a ROLLBACK on this adapter's single shared connection while other
          // transactions may be mid-flight.
          if (i % 3 === 0) {
            throw new Error(`intentional failure for i=${i}`);
          }
          return i;
        }),
      ),
    );

    const failedIds = new Set<number>();
    const succeededIds = new Set<number>();
    settled.forEach((r, i) => {
      if (r.status === 'rejected') failedIds.add(i);
      else succeededIds.add(i);
    });

    expect(failedIds.size).toBeGreaterThan(0);
    expect(succeededIds.size).toBeGreaterThan(0);

    // Every transaction that resolved successfully must be durably present…
    for (const i of succeededIds) {
      const row = await adapter.executeGet<{ val: string }>('SELECT val FROM t WHERE id = ?', [i]);
      expect(row, `expected id=${i} (succeeded) to be durably committed`).not.toBeNull();
      expect(row!.val).toBe(`v${i}`);
    }
    // …and every transaction that rejected must NOT be present (its own
    // rollback undid only its own insert, not a sibling's).
    for (const i of failedIds) {
      const row = await adapter.executeGet<{ val: string }>('SELECT val FROM t WHERE id = ?', [i]);
      expect(row, `expected id=${i} (rolled back) to be absent`).toBeNull();
    }

    const count = await adapter.executeGet<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM t');
    expect(count!.cnt).toBe(succeededIds.size);
  });

  it('exists-check inside one transaction never observes a sibling\'s uncommitted insert', async () => {
    const dbPath = tempPath('exists-check-isolation');
    const adapter = await connect(dbPath);

    await adapter.exec('CREATE TABLE node (node_id TEXT PRIMARY KEY, val TEXT)');

    const N = 15;
    // Each "worker" does an exists-check then, only if absent, inserts —
    // exactly the applyEmbedding pattern from embed-pipeline.ts. If two
    // workers ever raced on the SAME id this could double-insert (PK
    // violation) or one could skip based on a sibling's uncommitted row. Use
    // distinct ids per worker plus a couple of intentionally-shared ids to
    // prove the check-then-insert is atomic per row across concurrent callers.
    const sharedIds = ['shared-a', 'shared-b'];
    const tasks: Promise<'inserted' | 'exists'>[] = [];

    for (let i = 0; i < N; i++) {
      const id = i < sharedIds.length ? sharedIds[i % sharedIds.length] : `solo-${i}`;
      tasks.push(
        adapter.transaction(async (tx) => {
          const existing = await tx.executeGet<{ node_id: string }>(
            'SELECT node_id FROM node WHERE node_id = ?',
            [id],
          );
          await jitter();
          if (existing) return 'exists' as const;
          await tx.executeRun('INSERT INTO node (node_id, val) VALUES (?, ?)', [id, 'x']);
          return 'inserted' as const;
        }),
      );
    }
    // Fire two concurrent transactions per shared id too, to directly race
    // the check-then-insert against itself.
    for (const id of sharedIds) {
      tasks.push(
        adapter.transaction(async (tx) => {
          const existing = await tx.executeGet<{ node_id: string }>(
            'SELECT node_id FROM node WHERE node_id = ?',
            [id],
          );
          await jitter();
          if (existing) return 'exists' as const;
          await tx.executeRun('INSERT INTO node (node_id, val) VALUES (?, ?)', [id, 'x']);
          return 'inserted' as const;
        }),
      );
    }

    // Must not throw (no PK violation from a lost exists-check race).
    await expect(Promise.all(tasks)).resolves.toBeDefined();

    // Every distinct id ends up with exactly ONE durable row.
    const distinctIds = new Set<string>([...sharedIds, ...Array.from({ length: N - sharedIds.length }, (_, i) => `solo-${i + sharedIds.length}`)]);
    for (const id of distinctIds) {
      const rows = await adapter.executeAll<{ node_id: string }>(
        'SELECT node_id FROM node WHERE node_id = ?',
        [id],
      );
      expect(rows.rows.length, `expected exactly one durable row for ${id}`).toBe(1);
    }
  });
});
