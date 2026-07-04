/**
 * outbox-queue.spec.ts — Tests for outbox queue schema migration, concrete queue,
 * and memory flush (RS-4/RS-5, BL-126/BL-127).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from './db.js';
import {
  migrateOutboxQueueSchema,
  createMemoryOutboxQueue,
  memoryFlush,
} from './outbox-queue.js';

beforeAll(() => { process.env['SOX_EMBED_BACKEND'] = 'hash'; });
afterAll(() => { delete process.env['SOX_EMBED_BACKEND']; });

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Seed the organizer_queue table with test items.
 */
function seedQueue(
  db: Database.Database,
  items: Array<{
    op: string;
    payload: string;
    priority?: number;
    attempts?: number;
    enqueued?: string;
    done_at?: string | null;
    dead?: number;
    last_error?: string | null;
  }>,
): void {
  const insert = db.prepare(
    `INSERT INTO organizer_queue (op, payload, priority, attempts, enqueued, done_at, dead, last_error)
     VALUES (@op, @payload, @priority, @attempts, @enqueued, @done_at, @dead, @last_error)`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      insert.run({
        op: item.op,
        payload: item.payload,
        priority: item.priority ?? 0,
        attempts: item.attempts ?? 0,
        enqueued: item.enqueued ?? new Date().toISOString(),
        done_at: item.done_at ?? null,
        dead: item.dead ?? 0,
        last_error: item.last_error ?? null,
      });
    }
  });
  tx();
}

// ── migration ────────────────────────────────────────────────────────────────

describe('migrateOutboxQueueSchema', () => {
  it('adds last_error and dead columns to organizer_queue', () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = openDb(path.join(dir, 't.db'));
      // openDb creates the full schema including organizer_queue.
      // Drop the auto-created table to simulate a pre-migration schema.
      db.exec(`DROP TABLE IF EXISTS organizer_queue`);
      // Create a legacy organizer_queue (without last_error, dead)
      db.exec(
        `CREATE TABLE organizer_queue (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          op TEXT NOT NULL,
          payload TEXT NOT NULL DEFAULT '{}',
          priority INTEGER NOT NULL DEFAULT 0,
          attempts INTEGER NOT NULL DEFAULT 0,
          enqueued TEXT NOT NULL DEFAULT (datetime('now')),
          claimed_at TEXT,
          done_at TEXT
        )`,
      );

      migrateOutboxQueueSchema(db);

      const cols = db
        .prepare<[], { name: string }>(`PRAGMA table_info(organizer_queue)`)
        .all()
        .map((c) => c.name);
      expect(cols).toContain('last_error');
      expect(cols).toContain('dead');

      // Idempotent: second call does not throw
      expect(() => migrateOutboxQueueSchema(db)).not.toThrow();
      db.close();
    } finally {
      cleanup();
    }
  });

  it('is a no-op when organizer_queue does not exist', () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = openDb(path.join(dir, 't.db'));
      db.exec(`DROP TABLE IF EXISTS organizer_queue`);
      // Should not throw when table is absent
      expect(() => migrateOutboxQueueSchema(db)).not.toThrow();
      db.close();
    } finally {
      cleanup();
    }
  });
});

// ── Concrete OutboxQueue ─────────────────────────────────────────────────────

describe('createMemoryOutboxQueue', () => {
  it('dequeues items ordered by priority ASC, seq ASC', () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = openDb(path.join(dir, 't.db'));
      migrateOutboxQueueSchema(db);

      seedQueue(db, [
        { op: 'enrich', payload: '{"id":"c"}', priority: 2 },
        { op: 'enrich', payload: '{"id":"a"}', priority: 1 },
        { op: 'enrich', payload: '{"id":"b"}', priority: 1 },
      ]);

      const queue = createMemoryOutboxQueue({ db });
      const items = queue.dequeue(10);

      expect(items).toHaveLength(3);
      // Priority 1 items come first, then priority 2
      expect(JSON.parse(items[0].payload).id).toBe('a');
      expect(JSON.parse(items[1].payload).id).toBe('b');
      expect(JSON.parse(items[2].payload).id).toBe('c');
      db.close();
    } finally {
      cleanup();
    }
  });

  it('does not dequeue done or dead items', () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = openDb(path.join(dir, 't.db'));
      migrateOutboxQueueSchema(db);

      seedQueue(db, [
        { op: 'enrich', payload: '{"id":"done"}', done_at: '2026-01-01T00:00:00Z' },
        { op: 'enrich', payload: '{"id":"dead"}', dead: 1 },
        { op: 'enrich', payload: '{"id":"live"}', priority: 1 },
      ]);

      const queue = createMemoryOutboxQueue({ db });
      const items = queue.dequeue(10);

      expect(items).toHaveLength(1);
      expect(JSON.parse(items[0].payload).id).toBe('live');
      db.close();
    } finally {
      cleanup();
    }
  });

  it('markDone sets done_at for given seqs', () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = openDb(path.join(dir, 't.db'));
      migrateOutboxQueueSchema(db);

      seedQueue(db, [
        { op: 'enrich', payload: '{"id":"a"}', priority: 1 },
        { op: 'enrich', payload: '{"id":"b"}', priority: 2 },
      ]);

      const queue = createMemoryOutboxQueue({ db });
      const items = queue.dequeue(10);
      expect(items).toHaveLength(2);

      queue.markDone([items[0].seq]);

      const doneRow = db
        .prepare<[number], { done_at: string | null }>('SELECT done_at FROM organizer_queue WHERE seq = ?')
        .get(items[0].seq)!;
      expect(doneRow.done_at).not.toBeNull();

      const notDoneRow = db
        .prepare<[number], { done_at: string | null }>('SELECT done_at FROM organizer_queue WHERE seq = ?')
        .get(items[1].seq)!;
      expect(notDoneRow.done_at).toBeNull();
      db.close();
    } finally {
      cleanup();
    }
  });

  it('markFailed increments attempts and sets last_error', () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = openDb(path.join(dir, 't.db'));
      migrateOutboxQueueSchema(db);

      seedQueue(db, [
        { op: 'enrich', payload: '{}', priority: 1 },
      ]);

      const queue = createMemoryOutboxQueue({ db });
      const items = queue.dequeue(10);
      expect(items).toHaveLength(1);

      const deadLettered = queue.markFailed(items[0].seq, 'test error');

      const row = db
        .prepare<[number], { attempts: number; last_error: string | null; dead: number }>(
          'SELECT attempts, last_error, dead FROM organizer_queue WHERE seq = ?',
        )
        .get(items[0].seq)!;
      expect(row.attempts).toBe(1);
      expect(row.last_error).toBe('test error');
      expect(row.dead).toBe(0);
      expect(deadLettered).toBe(false);
      db.close();
    } finally {
      cleanup();
    }
  });

  it('getWatermark returns highest seq with done_at set', () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = openDb(path.join(dir, 't.db'));
      migrateOutboxQueueSchema(db);

      seedQueue(db, [
        { op: 'enrich', payload: '{}', priority: 1, done_at: '2026-01-01T00:00:00Z' },
        { op: 'enrich', payload: '{}', priority: 2 },
        { op: 'enrich', payload: '{}', priority: 3, done_at: '2026-01-02T00:00:00Z' },
      ]);

      const queue = createMemoryOutboxQueue({ db });
      expect(queue.getWatermark()).toBe(3);
      db.close();
    } finally {
      cleanup();
    }
  });

  it('getWatermark returns 0 when no items are done', () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = openDb(path.join(dir, 't.db'));
      migrateOutboxQueueSchema(db);
      const queue = createMemoryOutboxQueue({ db });
      expect(queue.getWatermark()).toBe(0);
      db.close();
    } finally {
      cleanup();
    }
  });
});

// ── Poison / dead-letter ─────────────────────────────────────────────────────

describe('poison item dead-letter (RS-4, BL-126)', () => {
  it('poison item becomes dead after 5 markFailed calls, pass continues', () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = openDb(path.join(dir, 't.db'));
      migrateOutboxQueueSchema(db);

      seedQueue(db, [
        { op: 'enrich', payload: '{"id":"poison"}', priority: 1 },
        { op: 'enrich', payload: '{"id":"good"}', priority: 2 },
      ]);

      const queue = createMemoryOutboxQueue({ db });

      // Dequeue — poison item comes first (lower priority)
      let items = queue.dequeue(10);
      expect(items).toHaveLength(2);

      // Mark the poison item failed 5 times
      for (let i = 0; i < 5; i++) {
        const deadLettered = queue.markFailed(items[0].seq, `attempt ${i + 1}`);
        if (i < 4) {
          expect(deadLettered).toBe(false);
        } else {
          expect(deadLettered).toBe(true);
        }
      }

      // Poison item should now be dead
      const poisonRow = db
        .prepare<[number], { dead: number; attempts: number }>(
          'SELECT dead, attempts FROM organizer_queue WHERE seq = ?',
        )
        .get(items[0].seq)!;
      expect(poisonRow.dead).toBe(1);
      expect(poisonRow.attempts).toBe(5);

      // The good item is still live — dequeue again should return only the good item
      items = queue.dequeue(10);
      expect(items).toHaveLength(1);
      expect(JSON.parse(items[0].payload).id).toBe('good');
      db.close();
    } finally {
      cleanup();
    }
  });
});

// ── memoryFlush ──────────────────────────────────────────────────────────────

describe('memoryFlush (RS-5, BL-127)', () => {
  it('returns immediately when awaitSeq is 0 (no wait)', () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = openDb(path.join(dir, 't.db'));
      migrateOutboxQueueSchema(db);

      const result = memoryFlush(db, { awaitSeq: 0 });
      expect(result).toHaveProperty('watermark');
      expect(result.caught_up).toBe(true);
      db.close();
    } finally {
      cleanup();
    }
  });

  it('returns immediately when awaitSeq is negative (no wait)', () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = openDb(path.join(dir, 't.db'));
      migrateOutboxQueueSchema(db);

      const result = memoryFlush(db, { awaitSeq: -1 });
      expect(result.caught_up).toBe(true);
      db.close();
    } finally {
      cleanup();
    }
  });

  it('catches up to a seeded backlog within timeout', () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = openDb(path.join(dir, 't.db'));
      migrateOutboxQueueSchema(db);

      // Seed items that are already done — watermark should be >= highest seq
      seedQueue(db, [
        { op: 'enrich', payload: '{}', priority: 1, done_at: '2026-01-01T00:00:00Z' },
        { op: 'enrich', payload: '{}', priority: 2, done_at: '2026-01-02T00:00:00Z' },
        { op: 'enrich', payload: '{}', priority: 3, done_at: '2026-01-03T00:00:00Z' },
      ]);

      // Wait for seq 3 — all items already done, so this should resolve instantly
      const t0 = performance.now();
      const result = memoryFlush(db, { awaitSeq: 3, timeoutMs: 2000 });
      const elapsed = performance.now() - t0;

      expect(result.watermark).toBe(3);
      expect(result.caught_up).toBe(true);
      // Should complete well under timeout — strict check for <500ms
      expect(elapsed).toBeLessThan(500);
      db.close();
    } finally {
      cleanup();
    }
  });

  it('times out when awaitSeq is higher than any known seq', () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = openDb(path.join(dir, 't.db'));
      migrateOutboxQueueSchema(db);

      // Seed one done item at seq 1
      seedQueue(db, [
        { op: 'enrich', payload: '{}', priority: 1, done_at: '2026-01-01T00:00:00Z' },
      ]);

      // Ask for seq 999 — doesn't exist → should timeout quickly
      const t0 = performance.now();
      const result = memoryFlush(db, { awaitSeq: 999, timeoutMs: 100 });
      const elapsed = performance.now() - t0;

      expect(result.caught_up).toBe(false);
      // Should respect timeout — allow some overhead but <500ms
      expect(elapsed).toBeLessThan(500);
      db.close();
    } finally {
      cleanup();
    }
  });
});
