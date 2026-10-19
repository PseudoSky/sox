/**
 * recluster-job-corrections.90ba140a.ac-d.spec.ts
 *
 * Failure mode: (D1) the runner decided defer-vs-fail on the free-text prefix
 * of the isolation layer's refusal message, so rewording it would turn a
 * harmless "holder busy" deferral into a permanently failed job; (D2)
 * `reclusterJobState` folded every unknown status into `failed` via `default:`,
 * so a future status would silently read as failed.
 * Tier: S. Real temp sqlite store for the runner; the isolated child boundary
 * is an injected `runIsolated` (nothing is forked). D2 is a pure function.
 * Fidelity gap: the real refusal is produced by `runEnrichIsolated` when a live
 * child exists; the code field is asserted on that producer only through the
 * exported constant (forking a real child is covered by
 * enrich-isolation-orphan.spec.ts, which still matches the human message).
 * Items: 90ba140a AC-D1, AC-D2 (correction bucket C2).
 *
 * Typecheck proof of D2 exhaustiveness: `npx nx typecheck memory-core` fails
 * if a member is added to `ReclusterJobStatus` without a `reclusterJobState`
 * case (the `never` parameter of `unknownReclusterStatus` rejects it).
 *
 * Recorded red runs (2026-10-19, worktree recluster-bg-c2; spec run via
 * `npx nx test memory-core -- <this file>`; each file restored byte-identical
 * (cmp) afterwards):
 *   AC-D1  recluster-job-runner.ts: the code check replaced by the old
 *          `isolated.error.startsWith('previous enrich child still running')`.
 *          Exit 1, 2 failed / 7 passed. `the runner defers ... wording differs`:
 *          AssertionError: expected { ran: true, ...(2) } to deeply equal
 *          { ran: false }; `the runner fails the job on a non-holder-busy
 *          error`: AssertionError: expected { ran: false } to match object
 *          { ran: true, ...(2) }.
 *   AC-D2  recluster-job.ts: the `never` fallback call replaced by a bare
 *          `return 'failed'`. Exit 1, 1 failed / 8 passed. `an unknown stored
 *          status yields the documented fallback (failed) and is traced`:
 *          AssertionError: expected "warn" to be called with arguments.
 *   AC-D2 typecheck: `'cancelled'` added to ReclusterJobStatus. `npx nx
 *          typecheck memory-core` exit 1: recluster-job.ts:109:37 error TS2345:
 *          Argument of type '"cancelled"' is not assignable to parameter of
 *          type 'never'.
 *   Restored: 9 passed (9), exit 0.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { ENRICH_ERR_HOLDER_BUSY } from './enrich-isolation.js';
import { runPendingSubsetReclusterJob } from './recluster-job-runner.js';
import {
  enqueueReclusterJob,
  readReclusterJob,
  reclusterJobState,
  type ReclusterJobStatus,
} from './recluster-job.js';
import { log } from './telemetry.js';

let dir: string;
let db: StoreAdapter;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recluster-ad-'));
  db = await openDb(path.join(dir, 'store.db'));
});
afterEach(async () => {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const deps = (runIsolated: never) => ({
  runIsolated,
  describeDegradation: () => '',
  owner: 'o',
  leaseMs: 60_000,
});

describe('90ba140a AC-D1 defer-vs-fail is decided by a structured code, not message text', () => {
  it('90ba140a AC-D1: the runner defers (job stays queued) on a holder-busy result whose wording differs from today', async () => {
    const j = await enqueueReclusterJob(db, { scope: 'subset', subset: { filters: { topic: 't' }, persist: true } });
    const out = await runPendingSubsetReclusterJob(
      db,
      deps(vi.fn().mockResolvedValue({ ok: false, code: ENRICH_ERR_HOLDER_BUSY, error: 'another holder is occupying this store right now' }) as never),
    );
    expect(out).toEqual({ ran: false });
    expect(await readReclusterJob(db, j.job_id)).toMatchObject({ state: 'queued', status: 'pending', owner: null });
  });

  it('90ba140a AC-D1: the runner fails the job on a non-holder-busy error, even if its text mimics the old prefix', async () => {
    const j = await enqueueReclusterJob(db, { scope: 'subset', subset: { filters: { topic: 't' }, persist: true } });
    const out = await runPendingSubsetReclusterJob(
      db,
      deps(vi.fn().mockResolvedValue({ ok: false, error: 'previous enrich child still running (pid 1); lookalike without a code' }) as never),
    );
    expect(out).toMatchObject({ ran: true, job_id: j.job_id, state: 'failed' });
    expect(await readReclusterJob(db, j.job_id)).toMatchObject({ state: 'failed', reason: 'child_failed' });
  });

  it('90ba140a AC-D1: the shared holder-busy code is the literal the runner contract documents', () => {
    expect(ENRICH_ERR_HOLDER_BUSY).toBe('holder_busy');
  });
});

describe('90ba140a AC-D2 reclusterJobState has no silent default for known statuses', () => {
  it.each<[ReclusterJobStatus, string]>([
    ['pending', 'queued'],
    ['running', 'running'],
    ['completed', 'completed'],
    ['skipped', 'degraded'],
    ['failed', 'failed'],
  ])('90ba140a AC-D2: stored %s reads %s', (status, state) => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    expect(reclusterJobState(status)).toBe(state);
    expect(warn).not.toHaveBeenCalledWith('recluster_job.unknown_status', expect.anything());
    warn.mockRestore();
  });

  it('90ba140a AC-D2: an unknown stored status yields the documented fallback (failed) and is traced', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    expect(reclusterJobState('cancelled' as ReclusterJobStatus)).toBe('failed');
    expect(warn).toHaveBeenCalledWith('recluster_job.unknown_status', { status: 'cancelled' });
    warn.mockRestore();
  });
});
