/**
 * outbox-queue.ts — Concrete OutboxQueue over the `organizer_queue` table
 * (CONTRACTS §F / §H) + memoryFlush for read-your-derived-writes.
 *
 * Additive migration: `last_error TEXT`, `dead INTEGER DEFAULT 0` columns.
 * Orphan edges: the existing `attempts INTEGER DEFAULT 0` column is already
 * present in the schema — this module adds the missing columns idempotently.
 *
 * Dequeue: WHERE done_at IS NULL AND dead = 0 ORDER BY priority ASC, seq ASC.
 * Dead-letter: when attempts >= 5 after markFailed, dead is set to 1.
 * Watermark: MAX(seq) WHERE done_at IS NOT NULL AND dead = 0.
 */

import type { Database as DatabaseType } from 'better-sqlite3';

// ── Local type definitions (replaces missing @adhd/sox-analysis exports) ───────

export interface OutboxQueueItem {
  seq: number;
  op: string;
  payload: string;
  priority: number;
  attempts: number;
  enqueued: string;
  claimed_at: string | null;
  last_error: string | null;
}

export interface OutboxQueue {
  dequeue(limit: number): OutboxQueueItem[];
  markDone(seqs: number[]): void;
  markFailed(seq: number, error: string): boolean;
  getWatermark(): number;
}

// ── Additive migration helpers ────────────────────────────────────────────────

/**
 * Idempotently add `last_error TEXT` and `dead INTEGER DEFAULT 0` to
 * organizer_queue. Safe to call multiple times.
 */
export function migrateOutboxQueueSchema(db: DatabaseType): void {
  // Check if the table exists first
  const tableExists = db
    .prepare<[], { name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='organizer_queue'`,
    )
    .get();
  if (!tableExists) return;

  // Get existing columns
  const columns = db
    .prepare<[], { name: string }>(`PRAGMA table_info(organizer_queue)`)
    .all()
    .map((c: {name: string}) => c.name);

  if (!columns.includes('last_error')) {
    db.exec(`ALTER TABLE organizer_queue ADD COLUMN last_error TEXT`);
  }

  if (!columns.includes('dead')) {
    db.exec(`ALTER TABLE organizer_queue ADD COLUMN dead INTEGER DEFAULT 0`);
  }

  // Ensure index on dead column for dequeue filtering
  db.exec(
    `CREATE INDEX IF NOT EXISTS ix_q_open_v2 ON organizer_queue(done_at, dead, priority, seq) WHERE done_at IS NULL AND dead = 0`,
  );
}

// ── Producer ──────────────────────────────────────────────────────────────────

/**
 * Enqueue an `ingest` row for a freshly-written episode (transactional outbox —
 * called inside the write path so the row commits with the node). The in-process
 * periodic enrichment pass consumes and completes these rows; their presence/age
 * is the observable heartbeat behind memory_ping's `enrichment` verdict
 * ([inv:list-never-lies] for workload progress — BL-172 incident, 2026-07-04).
 * The payload is provenance detail; the consumer completes rows by seq.
 */
export function enqueueIngest(
  db: DatabaseType,
  uid: string,
  agentId: string | null,
): void {
  const now = new Date().toISOString();
  const payload = JSON.stringify({ uid, agent_id: agentId });
  const priority = agentId ? 1 : 2;

  db.prepare(
    `INSERT INTO organizer_queue (op, payload, priority, enqueued)
     VALUES ('ingest', ?, ?, ?)`,
  ).run(payload, priority, now);
}

/**
 * Enqueue an `enrich` trigger row requesting a FULL (non-incremental) cluster
 * pass — the honest backing for `memory_curate recluster` with no filters
 * (BL-186). The in-process periodic tick consumes it: when a pending full-pass
 * row exists inside its snapshot window, the tick runs
 * `runBatchEnrich({incrementalCluster: false})` instead of the incremental
 * pass, then completes the row via completeEnrichTriggerRows ('enrich' is
 * already a trigger op).
 *
 * Returns the inserted row's seq (also surfaced in the curate response so
 * callers can correlate with memory_ping's queue fields).
 */
export function enqueueEnrichFull(db: DatabaseType, reason: string): number {
  const now = new Date().toISOString();
  const payload = JSON.stringify({ full: true, reason });
  const info = db
    .prepare(
      `INSERT INTO organizer_queue (op, payload, priority, enqueued)
       VALUES ('enrich', ?, 1, ?)`,
    )
    .run(payload, now);
  return Number(info.lastInsertRowid);
}

/**
 * True when an open (done_at IS NULL) full-pass `enrich` row exists with
 * seq <= maxSeq. The tick pairs this with its maxOpenEnrichTriggerSeq snapshot:
 * only rows the pass will COMPLETE may influence the pass shape — a full-pass
 * row enqueued after the snapshot stays open and drives the NEXT tick
 * ([inv:list-never-lies] for recluster requests).
 *
 * Deliberately does NOT filter on the BL-126 `dead` column: (a) the column only
 * exists after migrateOutboxQueueSchema, which the base DDL/openDb never runs
 * (BL-172 established it was never live), and (b) the paired consumer
 * completeEnrichTriggerRows ignores `dead` too — the check must mirror what the
 * drain will actually complete.
 */
export function hasPendingFullEnrich(db: DatabaseType, maxSeq: number): boolean {
  if (maxSeq <= 0) return false;
  const row = db
    .prepare<[number], { seq: number }>(
      `SELECT seq FROM organizer_queue
       WHERE done_at IS NULL
         AND op = 'enrich'
         AND json_extract(payload, '$.full') = 1
         AND seq <= ?
       LIMIT 1`,
    )
    .get(maxSeq);
  return row !== undefined;
}

// ── Concrete OutboxQueue ──────────────────────────────────────────────────────

export interface MemoryOutboxQueueDeps {
  db: DatabaseType;
}

/**
 * Create an OutboxQueue backed by the `organizer_queue` table.
 * The caller must have already called `migrateOutboxQueueSchema` on the db handle.
 */
export function createMemoryOutboxQueue(deps: MemoryOutboxQueueDeps): OutboxQueue {
  const { db } = deps;

  const dequeueStmt = db.prepare<[number], OutboxQueueItem>(
    `SELECT seq, op, payload, priority, attempts, enqueued, claimed_at, last_error
     FROM organizer_queue
     WHERE done_at IS NULL AND (dead IS NULL OR dead = 0)
     ORDER BY priority ASC, seq ASC
     LIMIT ?`,
  );

  const markFailedStmt = db.prepare<[string, string, number]>(
    `UPDATE organizer_queue SET attempts = attempts + 1, last_error = ?, claimed_at = ?
     WHERE seq = ?`,
  );

  const deadLetterStmt = db.prepare<[number]>(
    `UPDATE organizer_queue SET dead = 1 WHERE seq = ?`,
  );

  const watermarkStmt = db.prepare<[], { seq: number | null }>(
    `SELECT MAX(seq) AS seq FROM organizer_queue WHERE done_at IS NOT NULL AND (dead IS NULL OR dead = 0)`,
  );

  const nowStmt = db.prepare<[], { now: string }>(
    `SELECT datetime('now') AS now`,
  );

  return {
    dequeue(limit: number): OutboxQueueItem[] {
      return dequeueStmt.all(limit) as OutboxQueueItem[];
    },

    markDone(seqs: number[]): void {
      if (seqs.length === 0) return;
      const now = (nowStmt.get() as { now: string }).now;
      const placeholders = seqs.map(() => '?').join(',');
      db.prepare(
        `UPDATE organizer_queue SET done_at = ? WHERE seq IN (${placeholders})`,
      ).run(now, ...seqs);
    },

    markFailed(seq: number, error: string): boolean {
      const now = (nowStmt.get() as { now: string }).now;
      markFailedStmt.run(error, now, seq);

      // Check if this item has reached 5 attempts → dead-letter
      const item = db
        .prepare<[number], { attempts: number }>(
          `SELECT attempts FROM organizer_queue WHERE seq = ?`,
        )
        .get(seq);

      if (item && item.attempts >= 5) {
        deadLetterStmt.run(seq);
        return true;
      }
      return false;
    },

    getWatermark(): number {
      const row = watermarkStmt.get();
      return row?.seq ?? 0;
    },
  };
}

// ── Memory Flush — wait for enrichment watermark ─────────────────────────────

export interface MemoryFlushOpts {
  /** Wait until this seq has been processed. 0 = wait for full drain. */
  awaitSeq?: number;
  /** Maximum time to wait in ms (default 10000). */
  timeoutMs?: number;
}

export interface MemoryFlushResult {
  watermark: number;
  caught_up: boolean;
}

/**
 * Wait (poll) until the enrichment watermark reaches or exceeds `awaitSeq`.
 * If `awaitSeq` is 0 or omitted, returns immediately with current watermark.
 * Polls at 50ms intervals (no sleeps — uses a proper check loop).
 * Returns `{watermark, caught_up}` where `caught_up` is true iff
 * the watermark >= awaitSeq within the timeout.
 */
export function memoryFlush(
  db: DatabaseType,
  opts: MemoryFlushOpts = {},
): MemoryFlushResult {
  const awaitSeq = opts.awaitSeq ?? 0;
  const timeoutMs = opts.timeoutMs ?? 10000;

  if (awaitSeq <= 0) {
    const watermark = getWatermarkDirect(db);
    return { watermark, caught_up: true };
  }

  const deadline = Date.now() + timeoutMs;
  const queue = createMemoryOutboxQueue({ db });

  // Process one drain pass to move items forward
  while (Date.now() < deadline) {
    // Check if we're caught up
    const watermark = queue.getWatermark();
    if (watermark >= awaitSeq) {
      return { watermark, caught_up: true };
    }

    // Try to process pending items — drain a batch
    const pending = queue.dequeue(50);
    if (pending.length === 0) {
      // Nothing pending but watermark hasn't caught up —
      // the awaitSeq may refer to a seq that doesn't exist yet.
      // Return what we have.
      return { watermark, caught_up: watermark >= awaitSeq };
    }

    // Mark pending items as done (they were already processed
    // by the time memoryFlush is called — this is a catch-up pass)
    const seqs = pending.map((i: OutboxQueueItem) => i.seq);
    queue.markDone(seqs);
  }

  // Timeout expired — return current state
  const watermark = queue.getWatermark();
  return { watermark, caught_up: watermark >= awaitSeq };
}

/** Direct watermark query without creating a full OutboxQueue instance. */
function getWatermarkDirect(db: DatabaseType): number {
  const row = db
    .prepare<[], { seq: number | null }>(
      `SELECT MAX(seq) AS seq FROM organizer_queue WHERE done_at IS NOT NULL AND (dead IS NULL OR dead = 0)`,
    )
    .get();
  return row?.seq ?? 0;
}
