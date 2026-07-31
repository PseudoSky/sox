/**
 * outbox-queue.spec.ts — tests for the transactional-outbox PRODUCERS over
 * `organizer_queue` (enqueueIngest / enqueueEnrichFull / hasPendingFullEnrich).
 *
 * These are the live-wired surface: rows are consumed by memory-server's
 * in-process periodic enrichment pass. The former consumer-class tests
 * (createMemoryOutboxQueue / memoryFlush / migrateOutboxQueueSchema, RS-4/RS-5,
 * BL-126/BL-127) were deleted with that unwired scaffolding in the BL-183
 * closeout — see outbox-queue.ts header.
 *
 * Uses the REAL base DDL via openDb (no synthetic table) so the specs pin the
 * exact schema the producers run against in production — including the op
 * CHECK constraint and the absence of any dead-letter columns.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import type Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb } from './db.js';
import {
  enqueueIngest,
  enqueueEnrichFull,
  hasPendingFullEnrich,
} from './outbox-queue.js';

/**
 * BL-325: openDb() returns a StoreAdapter, not a raw better-sqlite3 handle.
 * These specs' own verification reads use raw SQL against the sqlite backend,
 * so unwrap once here rather than rewriting every assertion.
 */
function raw(a: StoreAdapter): Database.Database {
  return a.unwrap() as Database.Database;
}

interface QueueRow {
  seq: number;
  op: string;
  payload: string;
  priority: number;
  enqueued: string;
  done_at: string | null;
}

let dir: string;
let db: StoreAdapter;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-'));
  db = await openDb(path.join(dir, 'test.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function allRows(): QueueRow[] {
  return raw(db)
    .prepare<[], QueueRow>(
      `SELECT seq, op, payload, priority, enqueued, done_at FROM organizer_queue ORDER BY seq`,
    )
    .all();
}

describe('enqueueIngest', () => {
  it('inserts an open ingest row with uid + agent_id payload at priority 1 for agent writes', () => {
    enqueueIngest(db, 'uid-agent-1', 'claude');
    const rows = allRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.op).toBe('ingest');
    expect(row.priority).toBe(1);
    expect(row.done_at).toBeNull();
    expect(row.enqueued).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp
    expect(JSON.parse(row.payload)).toEqual({ uid: 'uid-agent-1', agent_id: 'claude' });
  });

  it('uses priority 2 for agent-less writes (null agent_id)', () => {
    enqueueIngest(db, 'uid-anon-1', null);
    const row = allRows()[0]!;
    expect(row.priority).toBe(2);
    expect(JSON.parse(row.payload)).toEqual({ uid: 'uid-anon-1', agent_id: null });
  });
});

describe('enqueueEnrichFull', () => {
  it('inserts an open full-pass enrich trigger and returns its seq', () => {
    const seq = enqueueEnrichFull(db, 'recluster requested');
    const rows = allRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.seq).toBe(seq);
    expect(row.op).toBe('enrich');
    expect(row.priority).toBe(1);
    expect(row.done_at).toBeNull();
    expect(JSON.parse(row.payload)).toEqual({ full: true, reason: 'recluster requested' });
  });

  it('returns monotonically increasing seqs across calls', async () => {
    const a = enqueueEnrichFull(db, 'first');
    const b = enqueueEnrichFull(db, 'second');
    expect(b).toBeGreaterThan(await a);
  });
});

describe('hasPendingFullEnrich', () => {
  it('is false when maxSeq <= 0 (empty snapshot window)', () => {
    enqueueEnrichFull(db, 'r');
    expect(hasPendingFullEnrich(db, 0)).toBe(false);
    expect(hasPendingFullEnrich(db, -5)).toBe(false);
  });

  it('is true for an open full-pass row inside the snapshot window', async () => {
    const seq = enqueueEnrichFull(db, 'r');
    expect(hasPendingFullEnrich(db, await seq)).toBe(true);
    expect(hasPendingFullEnrich(db, await seq + 100)).toBe(true);
  });

  it('is false for a full-pass row enqueued AFTER the snapshot (seq > maxSeq) — it drives the NEXT tick', async () => {
    const before = enqueueEnrichFull(db, 'in-window');
    // complete the in-window row, then enqueue a fresh one past the snapshot
    raw(db).prepare(`UPDATE organizer_queue SET done_at = ? WHERE seq = ?`).run(
      new Date().toISOString(),
      before,
    );
    const after = enqueueEnrichFull(db, 'post-snapshot');
    expect(after).toBeGreaterThan(await before);
    expect(hasPendingFullEnrich(db, await before)).toBe(false);
  });

  it('ignores completed full-pass rows', async () => {
    const seq = enqueueEnrichFull(db, 'r');
    raw(db).prepare(`UPDATE organizer_queue SET done_at = ? WHERE seq = ?`).run(
      new Date().toISOString(),
      seq,
    );
    expect(hasPendingFullEnrich(db, await seq)).toBe(false);
  });

  it('ignores ingest rows and non-full enrich rows', () => {
    enqueueIngest(db, 'uid-1', 'claude');
    const incremental = raw(db)
      .prepare(
        `INSERT INTO organizer_queue (op, payload, priority, enqueued) VALUES ('enrich', '{}', 1, ?)`,
      )
      .run(new Date().toISOString());
    const maxSeq = Number(incremental.lastInsertRowid);
    expect(hasPendingFullEnrich(db, maxSeq)).toBe(false);
  });
});
