/**
 * recluster-job.spec.ts — SR-9: an OBSERVABLE global recluster.
 *
 * The requirement: a caller must be able to know when a reorganisation has
 * COMPLETED, not merely that it was enqueued. This suite proves:
 *   - a global `memory_curate recluster` returns a durable JOB HANDLE;
 *   - the job's state is polled by the caller (`recluster_status`) to a
 *     TERMINAL state — `completed` (with the resulting partition) or `failed`
 *     (with the error);
 *   - the state is a persisted record, readable after a store REOPEN and from
 *     a DIFFERENT connection (no sleeps — the poll observes cross-connection
 *     state).
 *
 * ## Negative control (SR9_NEGATIVE=1)
 *
 * The completion test asserts `status === 'completed'` unconditionally. With
 * `SR9_NEGATIVE=1` the settle step is skipped — the pre-SR-9
 * fire-and-forget shape, where the caller never reaches a terminal state — and
 * the assertion goes RED (status stays `pending`). Without the flag the tick's
 * settle runs and the test is GREEN.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { memoryCurate } from './curate.js';
import {
  enqueueReclusterJob,
  readReclusterJob,
  settleReclusterJobs,
  type ReclusterSettleOutcome,
} from './recluster-job.js';

let dir: string;
let dbPath: string;
let db: StoreAdapter;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recluster-job-'));
  dbPath = path.join(dir, 'store.db');
  db = await openDb(dbPath);
});

afterEach(async () => {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Settle, unless the negative control disables it (the fire-and-forget shape). */
async function settleOrSkip(
  adapter: StoreAdapter,
  seq: number,
  outcome: ReclusterSettleOutcome,
): Promise<number> {
  if (process.env['SR9_NEGATIVE'] === '1') return 0; // never settles
  return settleReclusterJobs(adapter, seq, outcome);
}

describe('SR-9 — observable recluster job lifecycle', () => {
  it('enqueue mints a pending job AND its full-pass trigger row atomically', async () => {
    const job = await enqueueReclusterJob(db, { reason: 'test' });
    expect(job.status).toBe('pending');
    expect(job.job_id.length).toBeGreaterThan(0);

    const read = await readReclusterJob(db, job.job_id);
    expect(read).not.toBeNull();
    expect(read!.status).toBe('pending');
    expect(read!.seq).toBe(job.seq);
    expect(read!.partition).toBeNull();

    // The trigger row it points at exists, is a FULL enrich, and is open.
    const q = await db.executeGet<{ op: string; payload: string; done_at: string | null }>(
      `SELECT op, payload, done_at FROM organizer_queue WHERE seq = ?`,
      [job.seq],
    );
    expect(q!.op).toBe('enrich');
    expect((JSON.parse(q!.payload) as { full: boolean }).full).toBe(true);
    expect(q!.done_at).toBeNull();
  });

  it('a successful pass settles the job to completed WITH a partition', async () => {
    const job = await enqueueReclusterJob(db);
    const settled = await settleOrSkip(db, job.seq, { ok: true });
    expect(settled).toBe(1);

    const read = await readReclusterJob(db, job.job_id);
    expect(read!.status).toBe('completed');
    expect(read!.partition).not.toBeNull();
    expect(typeof read!.partition!.community_count).toBe('number');
    expect(typeof read!.partition!.coverage).toBe('number');
    expect(read!.error).toBeNull();
  });

  it('a FAILED pass is distinguishable from pending; failure is terminal', async () => {
    const job = await enqueueReclusterJob(db);
    await settleOrSkip(db, job.seq, { ok: false, error: 'cluster pass boom' });

    const failed = await readReclusterJob(db, job.job_id);
    expect(failed!.status).toBe('failed');
    expect(failed!.error).toBe('cluster pass boom');
    expect(failed!.partition).toBeNull();

    // A later successful settle must NOT resurrect a terminal job.
    await settleReclusterJobs(db, job.seq, { ok: true });
    const after = await readReclusterJob(db, job.job_id);
    expect(after!.status).toBe('failed');
  });

  it('a SKIPPED cluster pass settles `skipped` (with the reason) — never `completed`', async () => {
    // M1: the enrich child can run to completion (`ok`) while its cluster STEP is
    // skipped by the mixed-model / no-neighbour guard, leaving the partition
    // unchanged. Reporting that `completed` told a caller a reorganisation
    // happened when it had not. It must settle the distinct terminal `skipped`.
    const job = await enqueueReclusterJob(db);
    const settled = await settleOrSkip(db, job.seq, {
      ok: false,
      skipped: true,
      reason: 'mixed-model guard: null enrich_ver episodes detected; reindex required (D5.3)',
    });
    expect(settled).toBe(1);

    const skipped = await readReclusterJob(db, job.job_id);
    expect(skipped!.status).toBe('skipped');
    expect(skipped!.status).not.toBe('completed');
    expect(skipped!.skip_reason).toContain('mixed-model guard');
    expect(skipped!.partition).toBeNull();
    expect(skipped!.error).toBeNull();

    // Terminal — a later successful settle must NOT resurrect a skipped job.
    await settleReclusterJobs(db, job.seq, { ok: true });
    const after = await readReclusterJob(db, job.job_id);
    expect(after!.status).toBe('skipped');
  });

  it('the job state SURVIVES A STORE REOPEN — the caller keeps polling a fresh connection', async () => {
    const job = await enqueueReclusterJob(db);
    await settleOrSkip(db, job.seq, { ok: true });
    await db.close();

    const reopened = await openDb(dbPath);
    try {
      const read = await readReclusterJob(reopened, job.job_id);
      expect(read!.status).toBe('completed');
      expect(read!.partition).not.toBeNull();
    } finally {
      await reopened.close();
    }
    db = await openDb(dbPath); // re-establish for afterEach
  });
});

describe('SR-9 — the caller-facing `recluster` / `recluster_status` surface', () => {
  it('global recluster returns an observable handle; recluster_status polls it to completion', async () => {
    const out = (await memoryCurate(db, { op: 'recluster' })) as {
      op: string;
      scope: string;
      enqueued: boolean;
      seq: number;
      job_id: string;
      status: string;
    };
    expect(out.op).toBe('recluster');
    expect(out.scope).toBe('global');
    expect(out.enqueued).toBe(true);
    expect(out.status).toBe('pending');
    expect(typeof out.job_id).toBe('string');

    // Poll #1 — pending (the pass has not run).
    const p1 = (await memoryCurate(db, { op: 'recluster_status', job_id: out.job_id })) as {
      op: string;
      status: string;
      partition: unknown;
    };
    expect(p1.op).toBe('recluster_status');
    expect(p1.status).toBe('pending');

    // The tick settles it (SR9_NEGATIVE disables this → RED at the assert below).
    await settleOrSkip(db, out.seq, { ok: true });

    // Poll #2 — terminal, with the partition.
    const p2 = (await memoryCurate(db, { op: 'recluster_status', job_id: out.job_id })) as {
      status: string;
      partition: { community_count: number } | null;
    };
    expect(p2.status).toBe('completed');
    expect(p2.partition).not.toBeNull();
  });

  it('recluster_status requires job_id and reports E_NOT_FOUND for an unknown handle', async () => {
    const missing = (await memoryCurate(db, { op: 'recluster_status' })) as { code: string };
    expect(missing.code).toBe('E_MISSING');
    const unknown = (await memoryCurate(db, { op: 'recluster_status', job_id: 'nope' })) as { code: string };
    expect(unknown.code).toBe('E_NOT_FOUND');
  });
});

describe('SR-9 — cross-connection observability (no sleeps)', () => {
  it('a SECOND connection observes pending → completed through the same job handle', async () => {
    const job = await enqueueReclusterJob(db, { reason: 'cross-conn' });
    const observer = await openDb(dbPath);
    try {
      const before = await readReclusterJob(observer, job.job_id);
      expect(before!.status).toBe('pending');

      // The "tick" settles on the writer connection...
      await settleOrSkip(db, job.seq, { ok: true });

      // ...and the independent reader connection observes the terminal state.
      const after = await readReclusterJob(observer, job.job_id);
      expect(after!.status).toBe('completed');
      expect(after!.partition).not.toBeNull();
    } finally {
      await observer.close();
    }
  });
});
