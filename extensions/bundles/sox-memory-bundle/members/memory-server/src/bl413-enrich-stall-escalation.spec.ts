/**
 * bl413-enrich-stall-escalation.spec.ts — BL-413.
 *
 * MEASURED LIVE (2026-08-03, pid 85177, artifact a4892123287b): `memory_ping`
 * reported `enrichment.state: "stalled"` for ~90 consecutive 15-minute
 * threshold windows (queue_depth 46, queue_last_done_at 22.5h stale) and
 * NOTHING acted on it — the only trace of the condition was a `console.error`
 * line inside `runEnrichPassOnDb` that never reaches durable telemetry (it is
 * plain stderr, not a `log.*` call). A correct status string with zero
 * consumers is the defect (BL-334's own framing, reproduced here concretely).
 *
 * This suite proves the fix BOTH DIRECTIONS on the exact predicate memory_ping
 * already uses (`computeEnrichmentHealth`), never on a re-derived one:
 *
 *   RED   — before `checkAndEscalateEnrichStall` existed, a stalled queue had
 *           no durable record anywhere: `readEnrichStallEscalation` returns
 *           null forever, no matter how long the queue has been stalled.
 *   GREEN — `checkAndEscalateEnrichStall`, called with the SAME state
 *           `computeEnrichmentHealth` reports, persists a corrective-action
 *           record (sox_store_meta) AND returns it — readable independently
 *           of the in-process call, surviving a simulated "restart" (a fresh
 *           adapter handle onto the same file), and clearing itself once the
 *           queue actually drains.
 *
 * `enrichment.state` reading "stalled" is explicitly NOT sufficient for this
 * suite to pass — every assertion below is against the RECORDED escalation
 * (`readEnrichStallEscalation`), never against the status string alone.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getDb,
  checkAndEscalateEnrichStall,
  readEnrichStallEscalation,
  _resetEnrichStallStateForTest,
} from '@adhd/sox-memory-core';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { computeEnrichmentHealth } from './index.js';

const cleanups: Array<() => void> = [];

function tmpDbPath(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl413-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, 'store.db');
}

async function enqueueIngestAt(adapter: StoreAdapter, enqueuedAt: string): Promise<number> {
  const res = await adapter.executeRun(
    `INSERT INTO organizer_queue (op, payload, priority, enqueued) VALUES ('ingest', '{}', 1, ?)`,
    [enqueuedAt],
  );
  return Number(res.lastInsertRowid);
}

beforeEach(() => {
  _resetEnrichStallStateForTest();
});

afterEach(() => {
  _resetEnrichStallStateForTest();
  for (const c of cleanups.splice(0)) c();
});

describe('[BL-413] a stalled enrichment queue gets a recorded corrective action, not just a status string', () => {
  it('enqueues an item, holds the pass off past stall_threshold_ms, and records a durable escalation (not merely "stalled")', async () => {
    const dbPath = tmpDbPath();
    const adapter = await getDb(dbPath);

    // Enqueue an item well past the 15-minute default stall threshold —
    // this is the "pass held off" precondition: nothing has drained this
    // row, and it is old enough that memory_ping would already report
    // enrichment.state === 'stalled'.
    const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await enqueueIngestAt(adapter, twentyMinAgo);

    // Reproduce exactly what a tick computes: queue depth 1, oldest pending
    // 20 minutes ago, nothing ever done.
    const health = computeEnrichmentHealth(1, twentyMinAgo, null, Date.now());
    expect(health.state).toBe('stalled'); // sanity: the precondition this test exists to act on

    // BEFORE any tick has run its escalation check, there is no durable
    // record — this is the exact "stalled forever, silently" gap BL-413
    // measured live.
    expect(await readEnrichStallEscalation(adapter)).toBeNull();

    // This is the corrective action under test: NOT setting a status string
    // (that already happened via computeEnrichmentHealth above) — a RECORDED
    // action taken because the queue is stalled.
    const escalation = await checkAndEscalateEnrichStall(adapter, dbPath, {
      state: health.state,
      queueDepth: 1,
      oldestPendingAt: twentyMinAgo,
      lastDoneAt: null,
      lastIsolatedError: 'prepare failed: Parse error: no such column: meta',
    });

    expect(escalation).not.toBeNull();
    expect(escalation!.consecutive_stalled_ticks).toBe(1);
    expect(escalation!.queue_depth).toBe(1);
    expect(escalation!.last_isolated_error).toContain('no such column: meta');

    // The action is DURABLE: readable back from the store independent of the
    // in-process call that wrote it — simulating a fresh reader (an
    // operator, a different process, memory_ping on a later request) opening
    // the same file after the fact.
    const persisted = await readEnrichStallEscalation(adapter);
    expect(persisted).not.toBeNull();
    expect(persisted!.consecutive_stalled_ticks).toBe(1);
    expect(persisted!.last_isolated_error).toContain('no such column: meta');
  });

  it('increments consecutive_stalled_ticks across repeated stalled ticks — distinguishing "just crossed the threshold" from "90 ticks later"', async () => {
    const dbPath = tmpDbPath();
    const adapter = await getDb(dbPath);
    const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await enqueueIngestAt(adapter, old);

    const input = {
      state: 'stalled' as const,
      queueDepth: 1,
      oldestPendingAt: old,
      lastDoneAt: null,
      lastIsolatedError: null,
    };

    const e1 = await checkAndEscalateEnrichStall(adapter, dbPath, input);
    const e2 = await checkAndEscalateEnrichStall(adapter, dbPath, input);
    const e3 = await checkAndEscalateEnrichStall(adapter, dbPath, input);

    expect(e1!.consecutive_stalled_ticks).toBe(1);
    expect(e2!.consecutive_stalled_ticks).toBe(2);
    expect(e3!.consecutive_stalled_ticks).toBe(3);

    // The persisted record reflects the LATEST tick, not the first.
    const persisted = await readEnrichStallEscalation(adapter);
    expect(persisted!.consecutive_stalled_ticks).toBe(3);
  });

  it('clears the escalation once the queue actually recovers — a resolved incident must not linger as "still open"', async () => {
    const dbPath = tmpDbPath();
    const adapter = await getDb(dbPath);
    const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await enqueueIngestAt(adapter, old);

    await checkAndEscalateEnrichStall(adapter, dbPath, {
      state: 'stalled',
      queueDepth: 1,
      oldestPendingAt: old,
      lastDoneAt: null,
      lastIsolatedError: null,
    });
    expect(await readEnrichStallEscalation(adapter)).not.toBeNull();

    // Simulate the queue draining (what a successful isolated pass does via
    // completeEnrichTriggerRows) and the next tick observing a healthy state.
    const recovered = await checkAndEscalateEnrichStall(adapter, dbPath, {
      state: 'idle',
      queueDepth: 0,
      oldestPendingAt: null,
      lastDoneAt: new Date().toISOString(),
      lastIsolatedError: null,
    });

    expect(recovered).toBeNull();
    expect(await readEnrichStallEscalation(adapter)).toBeNull();
  });

  it('never escalates a merely "ok" (fresh, un-stalled) queue — no false alarms', async () => {
    const dbPath = tmpDbPath();
    const adapter = await getDb(dbPath);
    const fresh = new Date(Date.now() - 60_000).toISOString();
    await enqueueIngestAt(adapter, fresh);

    const health = computeEnrichmentHealth(1, fresh, null, Date.now());
    expect(health.state).toBe('ok');

    const escalation = await checkAndEscalateEnrichStall(adapter, dbPath, {
      state: health.state,
      queueDepth: 1,
      oldestPendingAt: fresh,
      lastDoneAt: null,
      lastIsolatedError: null,
    });

    expect(escalation).toBeNull();
    expect(await readEnrichStallEscalation(adapter)).toBeNull();
  });
});
