/**
 * recluster-job-corrections.90ba140a.spec.ts
 *
 * Failure mode: the background recluster job (90ba140a) reported the wrong thing
 * or paid the wrong cost: (C1) a degraded filtered pass not surfaced as
 * `degraded`; (C4) enqueue/claim/reap scanning the whole done-row history;
 * (C5) a job whose owner died reading `running` until some server's next tick;
 * (C6) a request that joined a job carrying other filters not saying so;
 * (C8) the job row and the `latest` pointer committing separately.
 * Tier: S. Real temp sqlite stores (openDb); the isolated child boundary is an
 * injected `runIsolated` that calls the real `runBatchEnrich` in-process, and
 * `clusterSubset` is the only mock (the O(n^2) pass is not under test here).
 * Fidelity gap: no child process is forked and no live store is touched; the
 * real fork on a real store is covered by the memory-server e2e spec
 * (recluster-job-e2e.90ba140a.spec.ts).
 * Items: 90ba140a AC-C1, AC-C4, AC-C5, AC-C6, AC-C8.
 *
 * Recorded red runs (2026-10-19, worktree recluster-bg-c1; spec run via
 * `npx nx test memory-core -- <this file>`; each file restored byte-identical
 * (cmp) afterwards):
 *   AC-C1  enrich-batch.ts: the `if (res.degraded) {...}` block deleted.
 *          Exit 1, 2 failed / 8 passed (both it.each arms): AssertionError:
 *          expected { ran: true, ... } to deeply equal ... with
 *          `-   "state": "degraded"` / `+   "state": "completed"`.
 *   AC-C4  recluster-job.ts: `done_at IS NULL` removed from OPEN_JOB_SQL and the
 *          global claim. Exit 1, 1 failed: `the enqueue NOT EXISTS ... search
 *          ix_q_open`: AssertionError: expected 'SCAN organizer_queue | SCAN
 *          CONSTANT ROW' to contain 'ix_q_open'. Measured on 50,000 done rows
 *          (budget temporarily set to 1 ms to print it): enqueue + subset claim
 *          = 4.1 ms with the fix, 178.6 ms without. The 2 s ceiling test passes
 *          in both states by design (it guards against a gross regression, not
 *          this one); the EXPLAIN QUERY PLAN test is the discriminator.
 *   AC-C5  recluster-job.ts rowToJob: effectiveEnvelope bypassed. Exit 1, 1
 *          failed: `an expired lease reads failed/owner_lost ...`: AssertionError:
 *          expected { op: 'recluster_status', ... } to match object { state:
 *          'failed', ... }.
 *   AC-C8  recluster-job.ts enqueue: the pointer written with the non-
 *          transactional adapter instead of tx. Exit 1, 1 failed:
 *          AssertionError: promise resolved "{ ... }" instead of rejecting.
 *   AC-B3  recluster-job.ts claim: foreign-lease NOT EXISTS neutered (status
 *          'running' -> 'never-running'). Exit 1, 1 failed: AssertionError:
 *          expected { proceed: true, claimed: 1 } to match object { proceed:
 *          false, blocked: 'held' }.
 *   AC-C6  asserted on both the lib result and the memory_curate result; the
 *          CLI half is in recluster-cli.90ba140a.spec.ts.
 *   Restored: 11 passed (11), exit 0.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AdapterTransaction, StoreAdapter } from '@adhd/sox-store-adapter';

const { subsetSpy } = vi.hoisted(() => ({ subsetSpy: vi.fn() }));
vi.mock('./cluster.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cluster.js')>();
  return { ...actual, clusterSubset: subsetSpy };
});

import { openDb } from './db.js';
import { memoryCurate } from './curate.js';
import { runBatchEnrich } from './enrich-batch.js';
import { runPendingSubsetReclusterJob } from './recluster-job-runner.js';
import {
  OPEN_JOB_SQL,
  claimGlobalReclusterJobs,
  claimSubsetReclusterJob,
  enqueueReclusterJob,
  readLatestReclusterJob,
  readOpenReclusterJob,
  readReclusterJob,
  settleReclusterJobs,
} from './recluster-job.js';

let dir: string;
let db: StoreAdapter;
beforeEach(async () => {
  subsetSpy.mockReset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recluster-c1-'));
  db = await openDb(path.join(dir, 'store.db'));
});
afterEach(async () => {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const SUBSET_REQ = { filters: { topic: 't' }, persist: true };
const emptySubsetResult = (extra: Record<string, unknown> = {}) => ({
  clusters: [], full_pass: false, unclustered_count: 5, persisted: false,
  provenance_hash: 'h', candidate_count: 5, ...extra,
});

describe('90ba140a AC-C1 a degraded clusterSubset result settles the job `degraded`', () => {
  it.each([
    ['nodeCap', { reason: 'nodeCap', episodeCount: 20000, nodeCap: 16000 }],
    ['budget', { reason: 'budget', episodeCount: 9000, budgetMs: 1000, elapsedMs: 1500 }],
  ])('90ba140a AC-C1: runBatchEnrich({subsetRecluster}) with a %s-degraded clusterSubset settles degraded (not completed)', async (kind, degraded) => {
    const j = await enqueueReclusterJob(db, { scope: 'subset', subset: SUBSET_REQ });
    subsetSpy.mockResolvedValueOnce(emptySubsetResult({ degraded }));

    const out = await runPendingSubsetReclusterJob(db, {
      // The real batch-enrich runs in-process; only clusterSubset is mocked.
      runIsolated: async (opts) => ({ ok: true, result: await runBatchEnrich(db, opts) }),
      describeDegradation: (d) => `${d.reason} refused the pass`,
      owner: 'o', leaseMs: 60_000,
    });

    expect(subsetSpy).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ ran: true, job_id: j.job_id, state: 'degraded' });
    const settled = await readReclusterJob(db, j.job_id);
    expect(settled).toMatchObject({
      state: 'degraded', status: 'skipped', reason: kind, skip_reason: `${kind} refused the pass`,
    });
    expect(settled!.state).not.toBe('completed');
  });
});

const LATENCY_BUDGET_MS = 2000;

describe('90ba140a AC-C4 the open-job predicate is answerable from ix_q_open', () => {
  const plan = async (sql: string): Promise<string> =>
    (await db.executeAll<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)).rows
      .map((r) => r.detail).join(' | ');

  it('90ba140a AC-C4: the enqueue NOT EXISTS and the reap/claim probes search ix_q_open, not the whole table', async () => {
    const enqueueGuard = await plan(
      `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM organizer_queue WHERE ${OPEN_JOB_SQL})`,
    );
    expect(enqueueGuard).toContain('ix_q_open');
    expect(enqueueGuard).not.toMatch(/SCAN organizer_queue(?! USING)/);
    const readOpen = await plan(`SELECT seq, payload FROM organizer_queue WHERE ${OPEN_JOB_SQL} ORDER BY seq LIMIT 1`);
    expect(readOpen).toContain('ix_q_open');
  });

  it('90ba140a AC-C4: enqueue + subset claim + reap stay under 2s on a store with 50,000 done queue rows', async () => {
    await db.executeRun(
      `INSERT INTO organizer_queue (op, payload, priority, enqueued, done_at)
       WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 50000)
       SELECT 'enrich',
              json_object('job', json_object('job_id', 'done-' || i, 'status', 'completed')),
              1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'
         FROM c`,
    );
    const total = (await db.executeGet<{ c: number }>(`SELECT COUNT(*) AS c FROM organizer_queue`))!.c;
    expect(total).toBe(50000);

    const t0 = performance.now();
    const j = await enqueueReclusterJob(db, { scope: 'subset', subset: SUBSET_REQ });
    const claimed = await claimSubsetReclusterJob(db, { owner: 'o', leaseMs: 60_000 });
    const elapsedMs = performance.now() - t0;

    expect(j.joined).toBe(false);
    expect(claimed?.job_id).toBe(j.job_id);
    // Measured and asserted: an unindexed json_extract scan of 50k rows per
    // statement is what AC-C4 removes.
    expect(elapsedMs, `enqueue+reap+claim elapsedMs=${elapsedMs.toFixed(1)}`).toBeLessThan(LATENCY_BUDGET_MS);
  });
});

describe('90ba140a AC-C5 status reports the effective state of an orphaned job, with no tick', () => {
  it('90ba140a AC-C5: an expired lease reads failed/owner_lost via recluster_status, latest:true, readOpen — the stored row is untouched', async () => {
    const stale = Date.now() - 60_000;
    const j = await enqueueReclusterJob(db, { nowMs: stale });
    await claimGlobalReclusterJobs(db, { maxSeq: j.seq, owner: 'dead', leaseMs: 1000, nowMs: stale });

    // No tick, no enqueue, no claim has run: the stored status is still `running`.
    const stored = await db.executeGet<{ s: string }>(
      `SELECT json_extract(payload, '$.job.status') AS s FROM organizer_queue WHERE seq = ?`, [j.seq],
    );
    expect(stored!.s).toBe('running');

    const byId = await memoryCurate(db, { op: 'recluster_status', job_id: j.job_id });
    expect(byId).toMatchObject({ state: 'failed', status: 'failed', reason: 'owner_lost' });
    expect((byId as Record<string, unknown>)['error']).toMatch(/owner lost/);
    expect(await memoryCurate(db, { op: 'recluster_status', latest: true })).toMatchObject({
      job_id: j.job_id, state: 'failed', reason: 'owner_lost',
    });
    expect((await readLatestReclusterJob(db))!.state).toBe('failed');
    expect(await readOpenReclusterJob(db)).toBeNull();

    // A read never writes.
    const still = await db.executeGet<{ s: string }>(
      `SELECT json_extract(payload, '$.job.status') AS s FROM organizer_queue WHERE seq = ?`, [j.seq],
    );
    expect(still!.s).toBe('running');
  });

  it('90ba140a AC-C5: a live lease still reads running', async () => {
    const j = await enqueueReclusterJob(db, {});
    await claimGlobalReclusterJobs(db, { maxSeq: j.seq, owner: 'live', leaseMs: 600_000 });
    expect(await memoryCurate(db, { op: 'recluster_status', job_id: j.job_id })).toMatchObject({ state: 'running' });
    expect((await readOpenReclusterJob(db))!.job_id).toBe(j.job_id);
  });
});

describe('90ba140a AC-C6 a request that joined a job carrying other filters says so', () => {
  it('90ba140a AC-C6: request_honored is true only when the open job carries the request', async () => {
    const g = await enqueueReclusterJob(db, {});
    expect(g.request_honored).toBe(true);
    expect(await enqueueReclusterJob(db, { scope: 'subset', subset: SUBSET_REQ })).toMatchObject({ joined: true, request_honored: false });
    expect(await enqueueReclusterJob(db, {})).toMatchObject({ joined: true, request_honored: true });
    await settleReclusterJobs(db, g.seq, { ok: true });

    const s = await enqueueReclusterJob(db, { scope: 'subset', subset: SUBSET_REQ });
    expect(s.request_honored).toBe(true);
    expect(await enqueueReclusterJob(db, { scope: 'subset', subset: { filters: { topic: 't' }, persist: true } }))
      .toMatchObject({ joined: true, request_honored: true });
    expect(await enqueueReclusterJob(db, { scope: 'subset', subset: { filters: { topic: 'other' }, persist: true } }))
      .toMatchObject({ joined: true, request_honored: false });
    expect(await enqueueReclusterJob(db, { scope: 'subset', subset: { filters: { topic: 't' }, persist: false } }))
      .toMatchObject({ joined: true, request_honored: false });
    expect(await enqueueReclusterJob(db, {})).toMatchObject({ joined: true, request_honored: false });
  });

  it('90ba140a AC-C6: memory_curate recluster with filters reports filters_applied:false when it joined a global job', async () => {
    await memoryCurate(db, { op: 'recluster' });
    const res = await memoryCurate(db, { op: 'recluster', filters: { topic: 't' } });
    expect(res).toMatchObject({ scope: 'subset', joined: true, job_scope: 'global', filters_applied: false });
  });

  it('90ba140a AC-C6: a fresh filtered request reports filters_applied:true', async () => {
    expect(await memoryCurate(db, { op: 'recluster', filters: { topic: 't' } })).toMatchObject({ joined: false, filters_applied: true });
  });
});

describe('90ba140a AC-C8 the job row and the latest pointer commit together', () => {
  function failingPointerAdapter(): StoreAdapter {
    const wrapTx = (tx: AdapterTransaction): AdapterTransaction => ({
      executeGet: (s, a) => tx.executeGet(s, a),
      executeAll: (s, a) => tx.executeAll(s, a),
      exec: (s) => tx.exec(s),
      executeRun: async (sql, args) => {
        if (sql.includes('sox_store_meta')) throw new Error('injected: crash between enqueue and pointer');
        return tx.executeRun(sql, args);
      },
    });
    return new Proxy(db, {
      get(target, prop) {
        if (prop === 'transaction') {
          return (fn: (tx: AdapterTransaction) => unknown, opts?: unknown) =>
            (target.transaction as (f: (t: AdapterTransaction) => unknown, o?: unknown) => Promise<unknown>)
              .call(target, (tx) => fn(wrapTx(tx)), opts);
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  }

  it('90ba140a AC-C8: a failure between the enqueue INSERT and the pointer write leaves no orphan job and `latest` unchanged', async () => {
    const a = await enqueueReclusterJob(db, {});
    await settleReclusterJobs(db, a.seq, { ok: true });
    expect((await readLatestReclusterJob(db))!.job_id).toBe(a.job_id);

    await expect(enqueueReclusterJob(failingPointerAdapter(), {})).rejects.toThrow(/injected/);

    const rows = (await db.executeGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM organizer_queue WHERE json_extract(payload,'$.job.job_id') IS NOT NULL`,
    ))!.c;
    expect(rows).toBe(1); // the INSERT rolled back with the failed pointer write
    expect((await readLatestReclusterJob(db))!.job_id).toBe(a.job_id);

    const b = await enqueueReclusterJob(db, {});
    expect(b.joined).toBe(false);
    expect((await readLatestReclusterJob(db))!.job_id).toBe(b.job_id);
  });
});

describe('90ba140a AC-B3 the claim refuses while another owner holds a live lease', () => {
  it('90ba140a AC-B3: a pending row beside a live foreign lease (a pre-single-flight leftover) is not claimable', async () => {
    const a = await enqueueReclusterJob(db, {});
    await claimGlobalReclusterJobs(db, { maxSeq: a.seq, owner: 'a', leaseMs: 600_000 });
    const iso = new Date().toISOString();
    const legacy = {
      full: true,
      job: {
        job_id: 'legacy-b', status: 'pending', scope: 'global', partition: null, error: null,
        skip_reason: null, reason: null, requested_by: null, owner: null, created_at: iso,
        started_at: null, finished_at: null, updated_at: iso, lease_expires_at: null,
        attempts: 0, next_retry_at: null, request: null, result: null,
      },
    };
    const info = await db.executeRun(
      `INSERT INTO organizer_queue (op, payload, priority, enqueued) VALUES ('enrich', ?, 1, ?)`,
      [JSON.stringify(legacy), iso],
    );
    const seqB = Number(info.lastInsertRowid);
    expect(await claimGlobalReclusterJobs(db, { maxSeq: seqB, owner: 'b', leaseMs: 60_000 }))
      .toMatchObject({ proceed: false, blocked: 'held' });
    expect((await readReclusterJob(db, 'legacy-b'))!.status).toBe('pending');
  });
});
