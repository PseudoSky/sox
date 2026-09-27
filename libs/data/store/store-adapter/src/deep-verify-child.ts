/**
 * deep-verify-child.ts — the out-of-process `deep` integrity verifier
 * (BL-fc5ab895). A SIDECAR: forked by `deep-verify.ts` via
 * `child_process.fork()`, never imported.
 *
 * Why a child PROCESS and not a worker_thread: the work is one native call
 * (`PRAGMA integrity_check` → `turso_node::step_sync` → `pread`) that has been
 * measured holding a thread for 21+ minutes. `Worker.terminate()` cannot
 * interrupt a thread parked in native code; SIGKILL on a process can. The
 * parent's timeout is therefore a real bound only if the work lives in a
 * process.
 *
 * Contract (argv, not IPC, so the payload is fixed before any work starts):
 *
 *   node deep-verify-child.js --payload '<json DeepVerifyChildPayload>' \
 *        [--sox-parent-entry <parent argv[1]>]
 *
 * `--sox-parent-entry` repeats the parent's entrypoint path as a
 * whitespace-bounded argv token so the host-runtime identity reaper
 * (`findOrphansByIdentity`, reaper.ts) finds this child alongside its parent.
 *
 * Replies over IPC with exactly one message, then exits:
 *   { type: 'result', findings: IntegrityFinding[], duration_ms, query_only: 1 }
 *   { type: 'error',  message }
 *
 * Invariants (ADR-0007 D2 / the approved verdict):
 *  - opens its OWN read connection (`readonly: true`) and sets
 *    `PRAGMA query_only = 1`, verified by reading it back — a connection that
 *    cannot prove it is query-only does not run the check;
 *  - NEVER repairs: it only runs {@link probeIntegrityCheck} and reports;
 *  - starts its off-thread self-reaper BEFORE opening the store, so it cannot
 *    outlive its parent or its hard deadline even while parked in native code.
 *
 * @module
 */

import { bootstrapChildTelemetry, log } from '@adhd/sox-telemetry';
import type { StoreConcurrencyMode } from './concurrency-mode.js';
import { startDeepVerifyReaper } from './deep-verify-reaper.js';
import { probeIntegrityCheck, type IntegrityFinding } from './integrity.js';
import type { StoreAdapter } from './types.js';

/** What the parent passes on argv. */
export interface DeepVerifyChildPayload {
  dbPath: string;
  adapterType: 'turso' | 'sqlite';
  concurrencyMode?: StoreConcurrencyMode;
  /** The parent's pid — the reaper's liveness anchor. */
  parentPid: number;
  /** Absolute self-kill budget, ms (parent bound + grace). */
  hardDeadlineMs: number;
}

export type DeepVerifyChildMessage =
  | { type: 'result'; findings: IntegrityFinding[]; duration_ms: number; query_only: number }
  | { type: 'error'; message: string };

function parsePayload(argv: readonly string[]): DeepVerifyChildPayload {
  const i = argv.indexOf('--payload');
  const raw = i >= 0 ? argv[i + 1] : undefined;
  if (raw === undefined) throw new Error('deep-verify-child: missing --payload <json>');
  const p = JSON.parse(raw) as Partial<DeepVerifyChildPayload>;
  if (typeof p.dbPath !== 'string' || p.dbPath === '') throw new Error('deep-verify-child: payload.dbPath missing');
  if (p.adapterType !== 'turso' && p.adapterType !== 'sqlite') {
    throw new Error(`deep-verify-child: payload.adapterType invalid: ${String(p.adapterType)}`);
  }
  if (typeof p.parentPid !== 'number' || typeof p.hardDeadlineMs !== 'number') {
    throw new Error('deep-verify-child: payload.parentPid / payload.hardDeadlineMs missing');
  }
  const out: DeepVerifyChildPayload = {
    dbPath: p.dbPath,
    adapterType: p.adapterType,
    parentPid: p.parentPid,
    hardDeadlineMs: p.hardDeadlineMs,
  };
  if (p.concurrencyMode !== undefined) out.concurrencyMode = p.concurrencyMode;
  return out;
}

function send(msg: DeepVerifyChildMessage): Promise<void> {
  return new Promise((resolve) => {
    if (!process.connected || typeof process.send !== 'function') {
      process.stderr.write(
        `[deep-verify-child] IPC channel is gone; dropping ${msg.type} message (parent likely exited)\n`,
      );
      resolve();
      return;
    }
    process.send(msg, (err: Error | null) => {
      if (err) {
        process.stderr.write(`[deep-verify-child] ${msg.type} send failed: ${err.message}\n`);
      }
      resolve();
    });
  });
}

async function openReadOnly(p: DeepVerifyChildPayload): Promise<StoreAdapter> {
  if (p.adapterType === 'turso') {
    const { TursoAdapterImpl } = await import('./turso-adapter.js');
    const opts: Parameters<typeof TursoAdapterImpl.connect>[0] = { dbPath: p.dbPath, readonly: true };
    if (p.concurrencyMode !== undefined) opts.concurrencyMode = p.concurrencyMode;
    return TursoAdapterImpl.connect(opts);
  }
  const { SqliteAdapterImpl } = await import('./sqlite-adapter.js');
  return new SqliteAdapterImpl(p.dbPath, { readonly: true });
}

async function main(): Promise<void> {
  const payload = parsePayload(process.argv);
  // FIRST — before the store is touched. Everything after this line may park
  // the main thread in native code for as long as the store takes to read.
  startDeepVerifyReaper({ parentPid: payload.parentPid, hardDeadlineMs: payload.hardDeadlineMs });
  bootstrapChildTelemetry({ service: 'store-adapter-deep-verify', role: 'harness', logSink: 'file' });

  const adapter = await openReadOnly(payload);
  try {
    // ADR-0007 D2: read connections open query_only. `readonly: true` already
    // refuses writes natively; query_only is asserted on top and READ BACK —
    // a verifier that cannot prove it is read-only does not run.
    await adapter.pragmaSet('query_only', 1);
    const qoRows = await adapter.executeAll<Record<string, unknown>>('PRAGMA query_only');
    const qo = Number(Object.values(qoRows.rows[0] ?? {})[0]);
    if (qo !== 1) {
      throw new Error(`PRAGMA query_only read back as ${String(qo)}, expected 1 — refusing to verify`);
    }
    const t0 = performance.now();
    const findings = await probeIntegrityCheck(adapter);
    await send({
      type: 'result',
      findings,
      duration_ms: Math.round(performance.now() - t0),
      query_only: qo,
    });
  } finally {
    await adapter.close().catch((err: unknown) => {
      log.warn('store_adapter.deep_verify.child_close_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

main().then(
  () => process.exit(0),
  async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[deep-verify-child] failed: ${message}\n`);
    await send({ type: 'error', message });
    process.exit(1);
  },
);
