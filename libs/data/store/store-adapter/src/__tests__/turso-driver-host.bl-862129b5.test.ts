/**
 * turso-driver-host.bl-862129b5.test.ts — packet TUR-C, plan `862129b5`.
 *
 * The process-wide Turso driver host must be a `globalThis` singleton (ADR-0018
 * pattern) so that N bundled/installed copies of `@adhd/sox-store-adapter` in
 * one process resolve to ONE native driver worker thread — not one worker per
 * copy, which is the multi-open hazard the off-thread design exists to remove.
 *
 * Two properties are pinned here:
 *
 *   1. SINGLETON PARITY — two independently-evaluated copies of the host module
 *      (a genuine second module instance, produced the only honest in-process
 *      way: `vi.resetModules()` clears the module registry, so the fresh
 *      dynamic `import()` is a NEW evaluation while `globalThis` — and therefore
 *      the `Symbol.for` slot — is shared) report the SAME `workerThreadId`.
 *   2. PROTOCOL MISMATCH — a host copy that disagrees with the version the slot
 *      was created under throws `E_TURSO_DRIVER_PROTOCOL_MISMATCH` rather than
 *      spawning a second worker.
 *
 * The mismatch is induced the faithful way, not by stubbing a function: the
 * slot records the protocol it was created with (its entire reason for
 * existing), so the test sets that field to a different value — exactly what a
 * host-only reload pairing new bytes with an older worker produces — and then
 * loads a fresh host copy, which must refuse.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch (err) {
    process.stderr.write(`[turso-driver-host test] driver unavailable: ${String(err)}\n`);
    return false;
  }
})();
const itTurso = hasTurso ? it : it.skip;

type HostModule = typeof import('../turso-driver-host.js');

/** The ADR-0018 slot, reached the same way every module copy reaches it. */
const HOST_SLOT = Symbol.for('@adhd/sox-store-adapter/turso-driver-host');

interface SlotShape {
  protocol: number;
  host: { _resetForTest(): Promise<void> };
}

function slot(): SlotShape | undefined {
  return (globalThis as unknown as Record<symbol, SlotShape | undefined>)[HOST_SLOT];
}

/** A genuinely distinct module instance, sharing the globalThis slot. */
async function freshHost(): Promise<HostModule> {
  vi.resetModules();
  return (await import('../turso-driver-host.js')) as HostModule;
}

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

let dir: string;
let seq = 0;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'turso-driver-host-'));
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

async function waitFor(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
    await new Promise<void>((r) => setTimeout(r, 20));
  }
}

describe('turso-driver-host — process-wide singleton (TUR-C)', () => {
  itTurso('two independently-loaded host copies share ONE worker thread', async () => {
    const first = await freshHost();
    const conn = await first.openTursoConnection(dbPath('shared'), OPEN_OPTS);
    const statusA = first.getTursoDriverStatus();
    expect(statusA.workerThreadId).not.toBeNull();
    expect(statusA.openConnections).toBe(1);

    const second = await freshHost();
    expect(second).not.toBe(first); // control: this really is a second instance

    expect(second.getTursoDriverStatus().workerThreadId).toBe(statusA.workerThreadId);

    // A connection opened through the SECOND copy lands on the SAME worker,
    // and the FIRST copy observes it — one host, one thread, shared state.
    const conn2 = await second.openTursoConnection(dbPath('shared-2'), OPEN_OPTS);
    expect(second.getTursoDriverStatus().workerThreadId).toBe(statusA.workerThreadId);
    expect(first.getTursoDriverStatus().workerThreadId).toBe(statusA.workerThreadId);
    expect(first.getTursoDriverStatus().openConnections).toBe(2);

    await conn.close();
    await conn2.close();
  });

  itTurso('a protocol-version mismatch throws rather than spawning a second worker', async () => {
    const first = await freshHost();
    const conn = await first.openTursoConnection(dbPath('mismatch'), OPEN_OPTS);
    const original = first.getTursoDriverStatus().workerThreadId;
    expect(original).not.toBeNull();

    const s = slot();
    expect(s).toBeDefined();
    const originalHost = s!.host;
    // A slot created by an older protocol version: the next host copy to load
    // must refuse rather than pair a second worker with the one already here.
    s!.protocol = 1_000_001;

    const second = await freshHost();
    expect(second).not.toBe(first);

    let caught: unknown;
    try {
      await second.openTursoConnection(dbPath('mismatch-2'), OPEN_OPTS);
    } catch (err: unknown) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe('E_TURSO_DRIVER_PROTOCOL_MISMATCH');
    // Refusal is side-effect-free: the original slot + worker are untouched.
    const still = slot();
    expect(still!.host).toBe(originalHost);
    expect(first.getTursoDriverStatus().workerThreadId).toBe(original);

    await conn.close();
  });

  itTurso('terminates the worker once the last connection closes (0 connections, 0 in flight)', async () => {
    const host = await freshHost();
    const conn = await host.openTursoConnection(dbPath('dispose'), OPEN_OPTS);
    expect(host.getTursoDriverStatus().workerThreadId).not.toBeNull();

    await conn.close();
    await waitFor(
      () => host.getTursoDriverStatus().workerThreadId === null,
      5_000,
      'worker termination at zero connections',
    );

    const status = host.getTursoDriverStatus();
    expect(status.openConnections).toBe(0);
    expect(status.inFlight).toBe(0);
    expect(status.state).toBe('idle');
  });
});
