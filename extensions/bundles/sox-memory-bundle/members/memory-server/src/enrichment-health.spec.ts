/**
 * enrichment-health.spec.ts — BL-172 (orphaned organizer_queue) + queue-drain SLO.
 *
 * BL-172 background: ADR-0007 moved batch enrichment in-process (memory-daemon
 * intentionally absent), but the write path still enqueues `ingest` trigger rows
 * into organizer_queue and the ONLY consumers that ever marked rows done were
 * memoryd (dead by design) and the never-wired RS-4 outbox orchestrator. Result
 * on the live store: rows unclaimed since 2026-07-03T16:04Z, queue_depth growing
 * forever, and memory_ping reporting ok:true throughout — RPC liveness without
 * workload progress.
 *
 * Proves:
 *   1. completeEnrichTriggerRows completes open TRIGGER rows (ingest/enrich/legacy)
 *      up to the pre-pass snapshot seq, mirrors memoryd semantics (claimed_at,
 *      attempts+1, done_at), and leaves decay/reindex + post-snapshot rows open.
 *   2. computeEnrichmentHealth verdicts: idle (empty), ok (fresh pending),
 *      stalled (pending older than threshold), env-overridable threshold.
 *   3. memory_ping's store block surfaces queue_oldest_pending_at /
 *      queue_last_done_at / enrichment{state} — stalled→idle flips after the
 *      queue is drained (the SQL-forensics-free stall detector).
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { getDb } from '@adhd/sox-memory-core';
import {
  completeEnrichTriggerRows,
  computeEnrichmentHealth,
  enrichStallThresholdMs,
  handleToolCall,
  maxOpenEnrichTriggerSeq,
} from './index.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-enrich-health-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** Minimal schema slice: only the tables the units under test touch. */
function openQueueDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS organizer_queue (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      op         TEXT NOT NULL CHECK (op IN ('ingest','enrich','extract','link','consolidate','decay','reindex')),
      payload    TEXT NOT NULL,
      priority   INTEGER NOT NULL DEFAULT 100,
      enqueued   TEXT NOT NULL, claimed_at TEXT, done_at TEXT,
      attempts   INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS node (
      rowid INTEGER PRIMARY KEY, uid TEXT UNIQUE, kind TEXT,
      t_created TEXT, enrich_ver TEXT
    );
  `);
  cleanups.push(() => db.close());
  return db;
}

function enqueue(db: Database.Database, op: string, enqueuedAt: string): number {
  const res = db
    .prepare(`INSERT INTO organizer_queue (op, payload, priority, enqueued) VALUES (?, '{}', 0, ?)`)
    .run(op, enqueuedAt);
  return Number(res.lastInsertRowid);
}

describe('[BL-172] completeEnrichTriggerRows', () => {
  it('completes open trigger rows up to the snapshot seq with memoryd semantics', () => {
    const db = openQueueDb(path.join(tmpDir(), 'q.db'));
    const t = new Date().toISOString();
    const s1 = enqueue(db, 'ingest', t);
    const s2 = enqueue(db, 'enrich', t);
    const s3 = enqueue(db, 'consolidate', t); // legacy trigger op
    const sDecay = enqueue(db, 'decay', t); // real work item — NOT a trigger

    const maxSeq = maxOpenEnrichTriggerSeq(db);
    expect(maxSeq).toBe(s3);

    // A row enqueued AFTER the snapshot (simulates a mid-window write).
    const sLate = enqueue(db, 'ingest', t);

    const completed = completeEnrichTriggerRows(db, maxSeq);
    expect(completed).toBe(3);

    const rows = db
      .prepare(`SELECT seq, op, claimed_at, done_at, attempts FROM organizer_queue ORDER BY seq`)
      .all() as Array<{ seq: number; op: string; claimed_at: string | null; done_at: string | null; attempts: number }>;

    for (const seq of [s1, s2, s3]) {
      const r = rows.find((x) => x.seq === seq);
      expect(r?.done_at).not.toBeNull();
      expect(r?.claimed_at).not.toBeNull();
      expect(r?.attempts).toBe(1);
    }
    // decay is real un-performed work — left open; post-snapshot row left open.
    expect(rows.find((x) => x.seq === sDecay)?.done_at).toBeNull();
    expect(rows.find((x) => x.seq === sLate)?.done_at).toBeNull();
  });

  it('is a no-op on an empty queue (maxSeq 0)', () => {
    const db = openQueueDb(path.join(tmpDir(), 'q.db'));
    expect(maxOpenEnrichTriggerSeq(db)).toBe(0);
    expect(completeEnrichTriggerRows(db, 0)).toBe(0);
  });

  it('never re-completes already-done rows (attempts stays put)', () => {
    const db = openQueueDb(path.join(tmpDir(), 'q.db'));
    const t = new Date().toISOString();
    const s1 = enqueue(db, 'ingest', t);
    expect(completeEnrichTriggerRows(db, s1)).toBe(1);
    expect(completeEnrichTriggerRows(db, s1)).toBe(0);
    const r = db.prepare(`SELECT attempts FROM organizer_queue WHERE seq = ?`).get(s1) as { attempts: number };
    expect(r.attempts).toBe(1);
  });
});

describe('queue-drain SLO: computeEnrichmentHealth', () => {
  const NOW = Date.parse('2026-07-04T20:00:00.000Z');

  it('idle when the queue is empty', () => {
    const h = computeEnrichmentHealth(0, null, '2026-07-03T16:04:53.567Z', NOW);
    expect(h.state).toBe('idle');
    expect(h.last_done_at).toBe('2026-07-03T16:04:53.567Z');
  });

  it('ok when pending work is younger than the threshold', () => {
    const fresh = new Date(NOW - 60_000).toISOString(); // 1 min old
    const h = computeEnrichmentHealth(3, fresh, null, NOW);
    expect(h.state).toBe('ok');
  });

  it('stalled when the oldest pending item exceeds the threshold (the live incident shape)', () => {
    // The incident: oldest pending 2026-07-04T05:23:24Z, ~14.5h old at probe time.
    const h = computeEnrichmentHealth(29, '2026-07-04T05:23:24.898Z', '2026-07-03T16:04:53.567Z', NOW);
    expect(h.state).toBe('stalled');
    expect(h.oldest_pending_at).toBe('2026-07-04T05:23:24.898Z');
    expect(h.last_done_at).toBe('2026-07-03T16:04:53.567Z');
  });

  it('stalled when pending rows carry an unparseable timestamp (never silently ok)', () => {
    const h = computeEnrichmentHealth(1, 'not-a-timestamp', null, NOW);
    expect(h.state).toBe('stalled');
  });

  it('threshold defaults to 3x the consumer tick and honours SOX_ENRICH_STALL_THRESHOLD_MS', () => {
    const original = process.env.SOX_ENRICH_STALL_THRESHOLD_MS;
    cleanups.push(() => {
      if (original === undefined) delete process.env.SOX_ENRICH_STALL_THRESHOLD_MS;
      else process.env.SOX_ENRICH_STALL_THRESHOLD_MS = original;
    });

    delete process.env.SOX_ENRICH_STALL_THRESHOLD_MS;
    expect(enrichStallThresholdMs()).toBe(15 * 60 * 1000);

    process.env.SOX_ENRICH_STALL_THRESHOLD_MS = '1000';
    expect(enrichStallThresholdMs()).toBe(1000);
    const twoSecOld = new Date(Date.now() - 2000).toISOString();
    expect(computeEnrichmentHealth(1, twoSecOld, null, Date.now()).state).toBe('stalled');

    // Garbage override falls back to the default.
    process.env.SOX_ENRICH_STALL_THRESHOLD_MS = 'banana';
    expect(enrichStallThresholdMs()).toBe(15 * 60 * 1000);
  });
});

// ── Phase-B embed backlog folded into the verdict (two-phase write, 2026-07-04) ──
//
// A dead Phase-B pipeline (episodes committed, vectors never landing) must read
// `stalled`, never silent: the backlog is a second pending-work channel aged by
// the oldest no-vec episode's t_created against the SAME stall threshold.

describe('embed-backlog channel: computeEnrichmentHealth', () => {
  const NOW = Date.parse('2026-07-04T20:00:00.000Z');

  it('empty queue + zero backlog stays idle; backlog fields are carried through', () => {
    const h = computeEnrichmentHealth(0, null, null, NOW, { count: 0, oldest_created_at: null });
    expect(h.state).toBe('idle');
    expect(h.embed_backlog).toBe(0);
    expect(h.embed_backlog_oldest_at).toBeNull();
  });

  it('fresh backlog alone (queue empty) → ok, not a false stall alarm', () => {
    const fresh = new Date(NOW - 5_000).toISOString();
    const h = computeEnrichmentHealth(0, null, null, NOW, { count: 2, oldest_created_at: fresh });
    expect(h.state).toBe('ok');
    expect(h.embed_backlog).toBe(2);
  });

  it('backlog older than the threshold → stalled (dead Phase-B pipeline detected)', () => {
    const old = new Date(NOW - 2 * 3600 * 1000).toISOString(); // 2h >> 15min
    const h = computeEnrichmentHealth(0, null, null, NOW, { count: 1, oldest_created_at: old });
    expect(h.state).toBe('stalled');
  });

  it('stalled dominates: healthy queue channel cannot mask a stalled embed backlog', () => {
    const freshQueue = new Date(NOW - 60_000).toISOString();
    const oldBacklog = new Date(NOW - 2 * 3600 * 1000).toISOString();
    const h = computeEnrichmentHealth(3, freshQueue, null, NOW, {
      count: 1,
      oldest_created_at: oldBacklog,
    });
    expect(h.state).toBe('stalled');
  });

  it('backlog with an unparseable timestamp is stalled, never silently ok', () => {
    const h = computeEnrichmentHealth(0, null, null, NOW, {
      count: 1,
      oldest_created_at: 'not-a-timestamp',
    });
    expect(h.state).toBe('stalled');
  });

  it('omitting the backlog argument preserves the original 4-arg behaviour exactly', () => {
    expect(computeEnrichmentHealth(0, null, null, NOW).state).toBe('idle');
    expect(computeEnrichmentHealth(0, null, null, NOW).embed_backlog).toBeUndefined();
  });
});

describe('queue-drain SLO: memory_ping surfaces the verdict', () => {
  interface PingStoreBlock {
    queue_depth: number;
    queue_oldest_pending_at: string | null;
    queue_last_done_at: string | null;
    enrichment: { state: string; oldest_pending_at: string | null; last_done_at: string | null };
  }

  async function pingStore(dbPath: string): Promise<PingStoreBlock> {
    const resp = await handleToolCall('memory_ping', { db_path: dbPath });
    expect(resp.isError).not.toBe(true);
    const body = JSON.parse(resp.content[0]?.text ?? '{}') as { store: PingStoreBlock | null };
    expect(body.store).not.toBeNull();
    return body.store as PingStoreBlock;
  }

  it('reports stalled for an old unclaimed item, then idle once drained', async () => {
    const dbPath = path.join(tmpDir(), 'store.db');
    // Initialize a REAL store (full schema) — the ping store block opens it via
    // the same getDb path, so a partial schema would silently omit the block.
    const adapter = await getDb(dbPath);
    const db = (adapter as any).unwrap() as Database.Database;

    // Seed the incident shape: one ingest row, 14h old, never claimed.
    const old = new Date(Date.now() - 14 * 3600 * 1000).toISOString();
    const seq = enqueue(db, 'ingest', old);

    const stalled = await pingStore(dbPath);
    expect(stalled.queue_depth).toBe(1);
    expect(stalled.queue_oldest_pending_at).toBe(old);
    expect(stalled.enrichment.state).toBe('stalled');

    // Drain (what the fixed fallback pass now does) → verdict flips to idle.
    completeEnrichTriggerRows(db, seq);
    const drained = await pingStore(dbPath);
    expect(drained.queue_depth).toBe(0);
    expect(drained.enrichment.state).toBe('idle');
    expect(drained.queue_last_done_at).not.toBeNull();
  });

  it('reports ok for fresh pending work (no false stall alarms)', async () => {
    const dbPath = path.join(tmpDir(), 'store2.db');
    const adapter = await getDb(dbPath);
    const db = (adapter as any).unwrap() as Database.Database;
    enqueue(db, 'ingest', new Date().toISOString());

    const h = await pingStore(dbPath);
    expect(h.queue_depth).toBe(1);
    expect(h.enrichment.state).toBe('ok');
  });
});
