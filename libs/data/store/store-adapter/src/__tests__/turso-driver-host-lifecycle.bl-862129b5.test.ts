/**
 * turso-driver-host-lifecycle.bl-862129b5.test.ts — TUR-D correction packet,
 * plan `862129b5`. The two host lifecycle defects the TUR-D review found, each
 * pinned red→green (BL-225): BL-3767d78c and BL-16766e77.
 *
 * Both are pure HOST-state-machine bugs — they are about how `TursoDriverHost`
 * reacts to a worker `exit`, and have nothing to do with the native driver. So
 * this suite drives the host with a CONTROL worker: a real
 * `worker_threads.Worker` whose entry is substituted through `spawnWorker` (the
 * host's only worker transport dependency). Every other telemetry import
 * (`log`, `currentRuntimeState`) is the real one.
 *
 *  1. BL-3767d78c — a worker that dies BEFORE posting `ready` (spawn/bootstrap
 *     failure: a missing sidecar, bad `execArgv`, an entry that cannot load)
 *     left `this.ready` permanently unsettled, so the first
 *     `openTursoConnection()` hung forever. Reproduced the faithful way the
 *     finding prescribes: point the host at a NON-EXISTENT worker entry
 *     (`missing-entry` mode) and assert the open REJECTS promptly with
 *     `E_TURSO_DRIVER_WORKER_EXITED`, not a hang.
 *
 *  2. BL-16766e77 — `expectedTermination` is set by the intentional-dispose
 *     paths but was only cleared inside `onWorkerExit()` AFTER the
 *     `this.worker !== worker` stale-worker guard. Because `maybeDispose()`
 *     nulls `this.worker` before `terminate()`, the disposal's OWN exit took
 *     the stale path and left the flag stuck `true`; the next genuine worker
 *     death was then read as intentional and swallowed — its in-flight calls
 *     hung and never rejected fatal. The `wedge` control worker (answers
 *     `open`/`close`, deliberately never a `call`) makes "a request in flight
 *     at kill time" deterministic: a real Turso worker cannot be held open
 *     without parking in native code, where `terminate()` cannot interrupt it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NodeWorker } from 'node:worker_threads';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { isFatalConnectionError } from '../errors.js';

/**
 * Control knobs for the `spawnWorker` substitute. `vi.hoisted` so the
 * `vi.mock` factory below can read them without tripping vitest's hoisting
 * guard. `spawned[i].exit` resolves once the i-th worker has emitted `exit`
 * (its listener is attached BEFORE the host's, so awaiting it also guarantees
 * the host's own `onWorkerExit` has finished).
 */
const CONTROL = vi.hoisted(() => ({
  /** `'missing-entry'`: entry cannot load. `'wedge'`: ready, but never answers a `call`. */
  mode: 'missing-entry' as 'missing-entry' | 'wedge',
  spawned: [] as { exit: Promise<void> }[],
}));

vi.mock('@adhd/sox-telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@adhd/sox-telemetry')>();
  const { Worker } = await import('node:worker_threads');
  const { tmpdir: osTmpdir } = await import('node:os');
  const { join: pathJoin } = await import('node:path');
  const { TURSO_DRIVER_PROTOCOL_VERSION } = await import('../turso-driver-protocol.js');

  // A path that certainly does not exist — the worker emits `error`
  // (ERR_MODULE_NOT_FOUND) then `exit` before it can post `ready`.
  const missingEntry = pathJoin(osTmpdir(), `sox-missing-worker-entry-${String(process.pid)}.js`);

  // Just enough of the protocol to let the host open/close a connection; a
  // `call` is deliberately never answered, so any request stays in flight.
  const wedgeScript = `
    const { parentPort } = require('node:worker_threads');
    parentPort.postMessage({ kind: 'ready', protocol: ${String(TURSO_DRIVER_PROTOCOL_VERSION)} });
    parentPort.on('message', (m) => {
      if (!m || typeof m.id !== 'number') return;
      if (m.kind === 'open' || m.kind === 'close') {
        parentPort.postMessage({ kind: 'ok', id: m.id, value: undefined });
      }
    });
  `;

  return {
    ...actual,
    spawnWorker: (): NodeWorker => {
      const worker =
        CONTROL.mode === 'missing-entry'
          ? new Worker(missingEntry)
          : new Worker(wedgeScript, { eval: true });
      CONTROL.spawned.push({
        exit: new Promise<void>((resolve) => {
          worker.once('exit', () => {
            resolve();
          });
        }),
      });
      return worker;
    },
  };
});

type HostModule = typeof import('../turso-driver-host.js');
type Connection = Awaited<ReturnType<HostModule['openTursoConnection']>>;

/** The ADR-0018 slot, reached the same way every module copy reaches it. */
const HOST_SLOT = Symbol.for('@adhd/sox-store-adapter/turso-driver-host');

interface SlotShape {
  protocol: number;
  host: { _resetForTest(): Promise<void>; _killWorkerForTest(): void };
}

function slot(): SlotShape | undefined {
  return (globalThis as unknown as Record<symbol, SlotShape | undefined>)[HOST_SLOT];
}

/** A genuinely distinct module instance, sharing the globalThis slot. */
async function freshHost(): Promise<HostModule> {
  vi.resetModules();
  return (await import('../turso-driver-host.js')) as HostModule;
}

/** Reset the process-wide slot between cases (the per-case teardown). */
async function resetHost(): Promise<void> {
  const s = slot();
  if (s !== undefined) await s.host._resetForTest();
  delete (globalThis as unknown as Record<symbol, unknown>)[HOST_SLOT];
}

/** Options mirroring what the adapter passes to the native driver. */
const OPEN_OPTS: Record<string, unknown> = {
  experimental: ['index_method', 'multiprocess_wal'],
  timeout: 5_000,
};

type Outcome<T> =
  | { kind: 'resolved'; value: T }
  | { kind: 'rejected'; error: unknown }
  | { kind: 'timeout' };

/** Settle `p`, or give up after `ms` (so a hang-crash reads as a bounded red). */
async function settleWithin<T>(p: Promise<T>, ms: number): Promise<Outcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then(
        (value): Outcome<T> => ({ kind: 'resolved', value }),
        (error: unknown): Outcome<T> => ({ kind: 'rejected', error }),
      ),
      new Promise<Outcome<T>>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

let dir: string;
let seq = 0;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'turso-driver-host-lifecycle-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
afterEach(async () => {
  await resetHost();
});

function dbPath(label: string): string {
  seq += 1;
  return join(dir, `${label}-${seq}.db`);
}

describe('turso-driver-host — lifecycle across a worker death (TUR-D correction)', () => {
  it('open() rejects promptly when the worker entry cannot load before it posts ready (BL-3767d78c)', async () => {
    CONTROL.mode = 'missing-entry';
    const host = await freshHost();

    // Point the host at a non-existent worker entry. `open()` runs
    // synchronously up to `await this.ready`, so by the time it hands back its
    // promise the worker is spawned and `this.ready` is pending.
    const opening = host.openTursoConnection(dbPath('missing-entry'), OPEN_OPTS);

    const outcome = await settleWithin(opening, 5_000);

    // Before the fix `onWorkerExit()` discarded the pending rejecter, so
    // `this.ready` never settled: `opening` hung and this raced to `timeout`.
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.error).toMatchObject({ code: 'E_TURSO_DRIVER_WORKER_EXITED' });
      // The marker `errors.ts` classifies as fatal — the signal the adapter's
      // `_markIfFatal`/`_reconnect` path keys on.
      expect(isFatalConnectionError(outcome.error)).toBe(true);
    }
    // A bootstrap failure is an UNEXPECTED death: it is counted, not swallowed.
    expect(host.getTursoDriverStatus().exits).toBe(1);
  });

  it('a genuine death after a normal dispose still rejects in-flight calls fatal (BL-16766e77)', async () => {
    CONTROL.mode = 'wedge';
    const host = await freshHost();

    // 1. Normal disposal: the last connection closes and the host tears the
    //    worker down on purpose. `maybeDispose()` sets `expectedTermination`
    //    and nulls `this.worker` BEFORE `terminate()`, so the disposal's own
    //    exit event is the one that must CONSUME the flag.
    const first: Connection = await host.openTursoConnection(dbPath('dispose'), OPEN_OPTS);
    await first.close();
    // Await the disposal worker's exit so the host has fully handled it —
    // otherwise the assertion below could race and mask the sticky flag.
    await CONTROL.spawned[0]!.exit;
    expect(host.getTursoDriverStatus().workerThreadId).toBeNull();

    // 2. Respawn — deliberately WITHOUT resetting the slot. Resetting the whole
    //    slot between cases is exactly what masked the sticky flag.
    const second: Connection = await host.openTursoConnection(dbPath('respawn'), OPEN_OPTS);
    expect(host.getTursoDriverStatus().workerThreadId).not.toBeNull();
    expect(host.getTursoDriverStatus().exits).toBe(0);

    // 3. A request in flight the control worker will never answer.
    const inFlight = second.run('SELECT 1');

    // 4. The freshly-respawned worker dies unexpectedly.
    slot()!.host._killWorkerForTest();

    const outcome = await settleWithin(inFlight, 5_000);

    // Before the fix the sticky `expectedTermination` swallowed this exit: the
    // in-flight call never settled (timeout) and `exits` stayed 0.
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.error).toMatchObject({ code: 'E_TURSO_DRIVER_WORKER_EXITED' });
      expect(isFatalConnectionError(outcome.error)).toBe(true);
    }
    expect(host.getTursoDriverStatus().exits).toBe(1);
    expect(host.getTursoDriverStatus().state).toBe('exited');
  });
});
