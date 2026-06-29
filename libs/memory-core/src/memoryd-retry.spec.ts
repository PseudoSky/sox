/**
 * memoryd-retry.spec.ts — fix ⑥ verification: drainBatch must NOT mark
 * enrich/ingest queue rows as done when processBatchEnrich throws.
 *
 * This ensures a transient runBatchEnrich failure leaves done_at=NULL so the
 * next drain cycle picks the rows up again — preventing silent data loss on
 * transient errors (REVIEW-code.md MED-2).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from './db.js';

// We need to test the private drainBatch behavior of MemoryDaemon.
// Strategy: import MemoryDaemon, monkey-patch runBatchEnrich via vi.mock, and
// exercise the drain by directly calling the daemon's internal drain trigger.

// We'll reach drainBatch by calling the exported enqueueIngest + the daemon's
// loop — but since we can't call a private method, we instead directly test
// the observable contract: after a failing drain, the queue row has done_at=NULL.

// MemoryDaemon exposes `drainBatch` only internally; we test the observable
// contract by importing the class, instantiating it with a DB that has the schema,
// and then injecting a failure via vi.spyOn on the runBatchEnrich import.

import * as batchModule from './enrich-batch.js';
import { MemoryDaemon, enqueueIngest } from './memoryd.js';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-retry-'));
  dbPath = path.join(tmpDir, 'test.db');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function queueRow(db: ReturnType<typeof openDb>, seq: number): { done_at: string | null } | undefined {
  return db.prepare<[number], { done_at: string | null }>(
    `SELECT done_at FROM organizer_queue WHERE seq = ?`,
  ).get(seq) as { done_at: string | null } | undefined;
}

describe('drainBatch — enrich failure leaves rows retryable (fix ⑥)', () => {
  it('leaves enrich row done_at=NULL when runBatchEnrich throws', async () => {
    // Open a fresh DB so schema and DDL are in place.
    const db = openDb(dbPath);

    // Enqueue one ingest row (triggers the enrich path in drainBatch).
    enqueueIngest(db, 'ep-test-001', 'project', null);

    // Confirm the row is un-done.
    const rows = db.prepare<[], { seq: number }>(
      `SELECT seq FROM organizer_queue WHERE done_at IS NULL`,
    ).all() as { seq: number }[];
    expect(rows.length).toBe(1);
    const seq = rows[0]!.seq;

    // Spy on runBatchEnrich to throw.
    vi.spyOn(batchModule, 'runBatchEnrich').mockImplementation(() => {
      throw new Error('simulated transient enrichment failure');
    });

    // Create a MemoryDaemon (does not start the loop; just sets up the instance).
    const daemon = new MemoryDaemon(dbPath);

    // Trigger one drain manually via the nudge path — we call the internal
    // method indirectly by calling `stop()` which calls drainBatch once.
    await daemon.stop();

    // The enrich row must still have done_at=NULL — the failure was not masked.
    const row = queueRow(db, seq);
    expect(row?.done_at).toBeNull();

    db.close();
  });

  it('marks enrich rows done when runBatchEnrich succeeds', async () => {
    const db = openDb(dbPath);

    enqueueIngest(db, 'ep-test-002', 'project', null);
    const rows = db.prepare<[], { seq: number }>(
      `SELECT seq FROM organizer_queue WHERE done_at IS NULL`,
    ).all() as { seq: number }[];
    expect(rows.length).toBe(1);
    const seq = rows[0]!.seq;

    // Let runBatchEnrich succeed (return a no-op result).
    vi.spyOn(batchModule, 'runBatchEnrich').mockReturnValue({
      communities_upserted: 0,
      member_of_edges: 0,
      importance_updated: 0,
      relates_to_edges: 0,
      topics_backfilled: 0,
      legacy_nodes_stamped: 0,
      cluster_pass_skipped: false,
    });

    const daemon = new MemoryDaemon(dbPath);
    await daemon.stop();

    // On success the row must be marked done.
    const row = queueRow(db, seq);
    expect(row?.done_at).not.toBeNull();

    db.close();
  });
});
