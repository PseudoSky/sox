/**
 * outbox-queue.ts — transactional-outbox PRODUCERS over the `organizer_queue`
 * table (CONTRACTS §F). Rows are consumed and completed by memory-server's
 * in-process periodic enrichment pass (maxOpenEnrichTriggerSeq →
 * runBatchEnrich → completeEnrichTriggerRows); their presence/age is the
 * observable heartbeat behind memory_ping's `enrichment` verdict.
 *
 * History (BL-183 closeout, 2026-07-04): this module previously also carried a
 * full OutboxQueue consumer class (`createMemoryOutboxQueue`), a
 * `memoryFlush` poller, and an additive dead-letter migration
 * (`migrateOutboxQueueSchema`, BL-126). All three were built-but-never-wired
 * scaffolding — zero consumers repo-wide, the migration never ran against any
 * live store, and `memoryFlush` marked rows done without processing them.
 * Deleted rather than deprecated (owner rule). If a dead-letter lane is ever
 * needed, design it WITH the live periodic-tick consumer, not beside it.
 */

import type { StoreAdapter } from '@adhd/sox-store-adapter';

// ── Producer ──────────────────────────────────────────────────────────────────

/**
 * Enqueue an `ingest` row for a freshly-written episode (transactional outbox —
 * called inside the write path so the row commits with the node). The in-process
 * periodic enrichment pass consumes and completes these rows; their presence/age
 * is the observable heartbeat behind memory_ping's `enrichment` verdict
 * ([inv:list-never-lies] for workload progress — BL-172 incident, 2026-07-04).
 * The payload is provenance detail; the consumer completes rows by seq.
 */
export async function enqueueIngest(
  adapter: StoreAdapter,
  uid: string,
  agentId: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  const payload = JSON.stringify({ uid, agent_id: agentId });
  const priority = agentId ? 1 : 2;

  await adapter.executeRun(
    `INSERT INTO organizer_queue (op, payload, priority, enqueued)
     VALUES ('ingest', ?, ?, ?)`,
    [payload, priority, now],
  );
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
export async function enqueueEnrichFull(adapter: StoreAdapter, reason: string): Promise<number> {
  const now = new Date().toISOString();
  const payload = JSON.stringify({ full: true, reason });
  const info = await adapter.executeRun(
    `INSERT INTO organizer_queue (op, payload, priority, enqueued)
     VALUES ('enrich', ?, 1, ?)`,
    [payload, now],
  );
  return Number(info.lastInsertRowid);
}

/**
 * True when an open (done_at IS NULL) full-pass `enrich` row exists with
 * seq <= maxSeq. The tick pairs this with its maxOpenEnrichTriggerSeq snapshot:
 * only rows the pass will COMPLETE may influence the pass shape — a full-pass
 * row enqueued after the snapshot stays open and drives the NEXT tick
 * ([inv:list-never-lies] for recluster requests).
 *
 * Deliberately does NOT filter on a `dead` column: the BL-126 dead-letter
 * migration never ran against any live store (BL-172; the migration itself was
 * deleted in the BL-183 closeout), and the paired consumer
 * completeEnrichTriggerRows has no dead-letter notion either — the check must
 * mirror what the drain will actually complete.
 */
export async function hasPendingFullEnrich(adapter: StoreAdapter, maxSeq: number): Promise<boolean> {
  if (maxSeq <= 0) return false;
  const row = await adapter.executeGet<{ seq: number }>(
    `SELECT seq FROM organizer_queue
     WHERE done_at IS NULL
       AND op = 'enrich'
       AND json_extract(payload, '$.full') = 1
       AND seq <= ?
     LIMIT 1`,
    [maxSeq],
  );
  return row !== null;
}
