/**
 * enrich-process-host.ts — BL-348 committed-stage boundary, child-PROCESS side.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Before this file, `runBatchEnrich()` (clustering E6, importance E7, auto-link
 * E9) ran IN-PROCESS against the SAME `StoreAdapter` connection every write and
 * every embed-drain pass also used. Two independent hazards followed from that:
 *
 *   1. `better-sqlite3` is fully SYNCHRONOUS. Any query or transaction inside
 *      `runBatchEnrich` blocks the entire Node event loop for its duration —
 *      not just the DB connection, the whole process, including every pending
 *      `WriteQueue` task and every in-flight embed apply. No JS-level mutex
 *      (the former `_bgSlot`) can fix this: the hazard is the event loop being
 *      unavailable to run ANY other JS, mutex included, while a synchronous
 *      call is on the stack.
 *   2. An uncaught throw inside the periodic enrich tick propagated out of a
 *      floating promise (`void runPeriodicEnrichPassGuarded().finally(...)`),
 *      which is an unhandled promise rejection — by default fatal to the whole
 *      Node process. A clustering bug could therefore crash the server and
 *      lose every embed still in flight, not just the clustering pass. Owner
 *      directive: "Failing clustering should never drop an embedding."
 *
 * The fix: run `runBatchEnrich` in its OWN OS process, forked fresh per pass
 * (mirrors the proven `fastembedProcessHost.ts` pattern — see that file's
 * header for why a real process boundary, not a `worker_threads.Worker`, is
 * the only isolation level that structurally rules out hazard classes like
 * these). A crash, hang, or thrown error in this process can NEVER block the
 * parent's event loop and can NEVER touch the parent's `WriteQueue` or the
 * in-flight embed apply path — there is no shared memory, no shared
 * connection, no shared promise chain. The parent (`enrich-isolation.ts`)
 * treats every outcome — success, thrown error, timeout, crash — as a
 * reported result, never a rejection that could cascade.
 *
 * This process opens its OWN `StoreAdapter` connection to the same DB file.
 * SQLite/Turso WAL mode supports multiple concurrent connections; a
 * long-running write transaction in THIS process can make a concurrent write
 * in the parent wait on the SQLite file lock (bounded, retried via
 * `busy_timeout`), but it can never block the parent's JS event loop — the
 * parent stays fully responsive to every other request while any one
 * statement retries. That is the isolation boundary BL-348 requires: bounded
 * DB-level contention, never unbounded JS-thread starvation, and never a
 * shared-fate crash.
 *
 * ── Protocol (IPC via `process.send`/`process.on('message')`) ──────────────
 *   request:  { id, dbPath: string, opts: BatchEnrichOptions }
 *   response: { id, result: BatchEnrichResult }
 *   response: { id, error: string }
 *
 * Exactly ONE task is accepted, then the process closes its adapter and exits
 * (0 on success, 1 on error) — a fresh fork per pass, not a persistent
 * singleton. Periodic enrich fires at most every few seconds; fork overhead
 * (single-digit ms) is negligible against that cadence, and a one-shot
 * process can never accumulate stale connection state across passes.
 */

import { openDb } from './db.js';
import { runBatchEnrich, type BatchEnrichOptions, type BatchEnrichResult } from './enrich-batch.js';
import { bootstrapChildTelemetry, childTelemetrySnapshot, type ChildTelemetrySnapshot } from '@adhd/sox-telemetry';

interface EnrichRequest {
  id: number;
  dbPath: string;
  opts: BatchEnrichOptions;
}

type EnrichResponse =
  | { type: 'telemetry.ready'; id: number; telemetry: ChildTelemetrySnapshot }
  | { id: number; result: BatchEnrichResult }
  | { id: number; error: string };

async function handleRequest(req: EnrichRequest): Promise<void> {
  const send = (msg: EnrichResponse): void => {
    if (typeof process.send === 'function') process.send(msg);
  };

  // BL-618: the FIRST IPC message is the telemetry.ready ack, sent before
  // openDb — so the parent can see this child's telemetry state (and record it
  // via _recordChildTelemetry) even if openDb / runBatchEnrich hangs forever.
  send({ type: 'telemetry.ready', id: req.id, telemetry: childTelemetrySnapshot() });

  let exitCode = 0;
  try {
    const adapter = await openDb(req.dbPath);
    try {
      const result = await runBatchEnrich(adapter, req.opts);
      send({ id: req.id, result });
    } finally {
      // Best-effort close — never let a close failure mask the real result
      // or hang process exit.
      try {
        await adapter.close();
      } catch {
        /* ignore — the process is exiting regardless */
      }
    }
  } catch (err) {
    exitCode = 1;
    send({ id: req.id, error: err instanceof Error ? err.message : String(err) });
  } finally {
    // Give the IPC channel a macrotask to flush the message before exit.
    setImmediate(() => process.exit(exitCode));
  }
}

// Only wire up the listener when actually run as a forked child (never on
// accidental `require`/import from a test or the parent's own module graph).
if (typeof process.send === 'function' && require.main === module) {
  // BL-618: child composition root. The parent's initTelemetry never crosses the
  // fork — each process has its own module-level _state in @adhd/sox-telemetry —
  // so the child bootstraps its own here. The `require.main === module` guard is
  // what prevents this from clobbering vitest's own initTelemetry when the
  // module is imported in-process by a spec. The parent's SOX_TELEMETRY_INIT env
  // (if any) is merged over these defaults by bootstrapChildTelemetry.
  bootstrapChildTelemetry({ service: 'memory-core', role: 'harness', logSink: 'file' });
  process.on('message', (msg: EnrichRequest) => {
    void handleRequest(msg);
  });
}

// Exported for direct in-process testing of the request/response shape
// without actually forking (fork behaviour itself is covered by
// enrich-isolation.spec.ts against the real child process).
export { handleRequest };
export type { EnrichRequest, EnrichResponse };
