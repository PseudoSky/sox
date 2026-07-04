/**
 * write-pipeline.spec.ts — two-phase write split (2026-07-04 incident fix).
 *
 * Pins the core contract: expensive compute (ONNX embedding) must not block
 * writes. Phase A (memoryWritePhaseA) holds the WriteQueue slot and performs
 * ZERO embed calls; Phase B (embed-pipeline.ts) computes the embedding off the
 * slot and applies it in a short follow-up queue task. Crash between phases is
 * healed by healMissingVectors and visible via embedBacklogStats.
 *
 * All tests use the BL-161 deterministic provider seam (_setEmbedProviderForTest)
 * — no real ONNX, no timing assertions (the "no embed in Phase A" proof is a
 * SEAM-LEVEL call count, not a wall clock).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import type { EmbedRole } from '@adhd/sox-embedding-provider';
import { openDb } from './db.js';
import {
  memoryWrite,
  memoryWritePhaseA,
  memoryWriteBatchPhaseA,
  memoryInvalidate,
} from './write.js';
import type { PhaseAOutcome } from './write.js';
import {
  applyEmbedding,
  schedulePendingEmbeds,
  flushPendingEmbeds,
  healMissingVectors,
  embedBacklogStats,
  syncEmbedEnabled,
} from './embed-pipeline.js';
import { memoryRecall } from './recall.js';
import { WriteQueue } from './write-queue.js';
import { _setEmbedProviderForTest, embed } from './embed.js';
import { DeterministicTestProvider } from './embed-test-provider.js';

// ── Seam-level instrumented providers ─────────────────────────────────────────

/** Deterministic provider that counts embedSingle calls (the R1-style guard). */
class CountingProvider extends DeterministicTestProvider {
  calls = 0;
  override async embedSingle(text: string, role?: EmbedRole): Promise<Float32Array> {
    this.calls++;
    return super.embedSingle(text, role);
  }
}

/** Provider whose embedSingle always throws — the Phase-B "crash" injector. */
class FailingProvider extends DeterministicTestProvider {
  override async embedSingle(_text: string, _role?: EmbedRole): Promise<Float32Array> {
    throw new Error('injected Phase-B embed failure');
  }
}

function tmpDb(): { dir: string; dbPath: string; db: Database.Database; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-pipeline-'));
  const dbPath = path.join(dir, 'p.db');
  const db = openDb(dbPath);
  return {
    dir,
    dbPath,
    db,
    cleanup: () => {
      try { if (db.open) db.close(); } catch { /* closed */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function vecRowFor(db: Database.Database, rowid: number): unknown {
  return db.prepare('SELECT node_id FROM vec_node WHERE node_id = ?').get(rowid);
}

function rowidFor(db: Database.Database, uid: string): number {
  const r = db.prepare<[string], { rowid: number }>('SELECT rowid FROM node WHERE uid = ?').get(uid);
  expect(r).toBeDefined();
  return r!.rowid;
}

let ctx: ReturnType<typeof tmpDb>;

beforeEach(() => {
  ctx = tmpDb();
  WriteQueue.clearInstances();
  WriteQueue.setBypass(false);
});

afterEach(async () => {
  await flushPendingEmbeds();
  WriteQueue.clearInstances();
  ctx.cleanup();
  // Restore the suite-wide deterministic provider (vitest.setup.ts contract).
  _setEmbedProviderForTest(new DeterministicTestProvider());
  delete process.env['SOX_DISABLE_EMBED_HEAL'];
  delete process.env['SOX_SYNC_EMBED'];
});

// ── Phase A: zero embed calls while holding the queue slot ────────────────────

describe('Phase A holds the queue slot with ZERO embed calls (seam-level proof)', () => {
  it('memoryWritePhaseA inside a WriteQueue task never touches the provider; Phase B does exactly one call per episode', async () => {
    const counter = new CountingProvider();
    _setEmbedProviderForTest(counter);

    const wq = WriteQueue.forPath(ctx.dbPath);
    const outcome = await wq.enqueue('memory_write', (qdb) =>
      memoryWritePhaseA(qdb, { content: 'Phase A must not run ONNX inference on the slot.' }),
    );

    // The queue-slot task is complete — not a single provider call was made.
    expect(counter.calls).toBe(0);
    expect('code' in outcome).toBe(false);
    const a = outcome as PhaseAOutcome;
    expect(a.pending).not.toBeNull();
    expect(a.result.enrichment?.near_dup).toBeNull(); // deferred to Phase B

    // No vec row yet — Phase B has not run.
    expect(vecRowFor(ctx.db, a.pending!.rowid)).toBeUndefined();

    // Phase B: exactly one embed call, vec row lands via a short queue task.
    const res = await schedulePendingEmbeds(wq, [a.pending!]);
    expect(res).toEqual({ applied: 1, exists: 0, gone: 0, failed: 0 });
    expect(counter.calls).toBe(1);
    expect(vecRowFor(ctx.db, a.pending!.rowid)).toBeDefined();
  });

  it('memoryWritePhaseA is fully synchronous (returns a value, not a promise)', () => {
    const r = memoryWritePhaseA(ctx.db, { content: 'synchronous phase A return value' });
    expect(r).not.toBeInstanceOf(Promise);
    expect('code' in r).toBe(false);
  });
});

// ── Recall: BM25/temporal immediately, vec joins after Phase B ────────────────

describe('fresh Phase-A write is BM25-recallable before its vector exists', () => {
  it('no-vec node returns via the fts channel; vec channel joins after Phase B; breakdown stays consistent', async () => {
    // Node A: full write (has a vector) — background population.
    const a = await memoryWrite(ctx.db, {
      content: 'Astronomy telescopes capture distant galaxies through long exposures.',
    });
    expect('episode_uid' in a).toBe(true);

    // Node B: Phase A only — committed, FTS-indexed, NO vec row.
    const b = memoryWritePhaseA(ctx.db, {
      content: 'Zanzibar spice merchants traded cloves cardamom and vanilla pods.',
    });
    expect('code' in b).toBe(false);
    const bOut = b as PhaseAOutcome;
    expect(vecRowFor(ctx.db, bOut.pending!.rowid)).toBeUndefined();

    // Recall with B's tokens: B must be found via BM25 despite the missing vector.
    const before = await memoryRecall(ctx.db, 'project', {
      query: 'zanzibar cloves cardamom merchants',
      limit: 10,
    });
    const bBefore = before.results.find((r) => r.uid === bOut.result.episode_uid);
    expect(bBefore).toBeDefined();
    expect(bBefore!.provenance).toContain('fts');
    expect(bBefore!.provenance).not.toContain('vec');
    expect(bBefore!.score_breakdown.vec).toBe(0);
    // Channel-sum invariant holds for the no-vec result too (HF-3).
    const sb = bBefore!.score_breakdown;
    expect(Math.abs(sb.vec + sb.bm25 + sb.temporal - sb.total)).toBeLessThan(1e-9);

    // Phase B lands the vector — the vec channel now includes B.
    const vec = await embed(bOut.pending!.text);
    expect(applyEmbedding(ctx.db, bOut.pending!, vec).status).toBe('applied');

    const after = await memoryRecall(ctx.db, 'project', {
      query: 'zanzibar cloves cardamom merchants',
      limit: 10,
    });
    const bAfter = after.results.find((r) => r.uid === bOut.result.episode_uid);
    expect(bAfter).toBeDefined();
    expect(bAfter!.provenance).toContain('vec');
    expect(bAfter!.score_breakdown.vec).toBeGreaterThan(0);
  });
});

// ── Dedup + idempotency semantics pinned across the split ─────────────────────

describe('E_DEDUP and client_request_id replay are identical pre/post split', () => {
  it('Phase A of duplicate content returns E_DEDUP with existing_uid — even before the vector lands', () => {
    const first = memoryWritePhaseA(ctx.db, { content: 'Dedup is content-hash based, not vector based.' });
    expect('code' in first).toBe(false);
    const firstUid = (first as PhaseAOutcome).result.episode_uid;

    // Duplicate (same content after trim+lowercase) while the first still has NO vec row.
    const second = memoryWritePhaseA(ctx.db, { content: '  DEDUP IS CONTENT-HASH BASED, NOT VECTOR BASED.  ' });
    expect('code' in second).toBe(true);
    expect((second as { code: string }).code).toBe('E_DEDUP');
    expect((second as { existing_uid: string }).existing_uid).toBe(firstUid);
  });

  it('client_request_id replay returns the original uid, creates no node, schedules no embed', () => {
    const first = memoryWritePhaseA(ctx.db, {
      content: 'Idempotent write via request ledger.',
      client_request_id: 'req-pipeline-1',
    });
    expect('code' in first).toBe(false);
    const firstOut = first as PhaseAOutcome;
    expect(firstOut.pending).not.toBeNull();

    const replay = memoryWritePhaseA(ctx.db, {
      content: 'Different content, same request id — must replay.',
      client_request_id: 'req-pipeline-1',
    });
    expect('code' in replay).toBe(false);
    const replayOut = replay as PhaseAOutcome;
    expect(replayOut.result.replayed).toBe(true);
    expect(replayOut.result.episode_uid).toBe(firstOut.result.episode_uid);
    expect(replayOut.pending).toBeNull(); // the original write owns the vector

    const count = ctx.db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM node WHERE kind='episode'")
      .get()!;
    expect(count.c).toBe(1);
  });
});

// ── Batch Phase A ─────────────────────────────────────────────────────────────

describe('memoryWriteBatchPhaseA — one sync queue task, pipelined Phase B', () => {
  it('per-item E_DEDUP semantics hold; pendings collected only for inserted items; single queue entry', async () => {
    const wq = WriteQueue.forPath(ctx.dbPath);
    WriteQueue.resetAllEnqueueCounts();

    const items = [
      { content: 'The volcano erupted at dawn revealing ancient lava flows.' },
      { content: 'Stock markets closed higher amid positive earnings reports.' },
      { content: '' }, // per-item validation error
      { content: 'THE VOLCANO ERUPTED AT DAWN REVEALING ANCIENT LAVA FLOWS.' }, // byte-dup of [0]
    ];

    const outcome = await wq.enqueue('memory_write_batch', (qdb) =>
      memoryWriteBatchPhaseA(qdb, items),
    );
    expect(wq._enqueueCount).toBe(1); // CONTRACTS §C: the whole batch is one entry

    expect(outcome.results).toHaveLength(4);
    expect(outcome.results[0]!.ok).toBe(true);
    expect(outcome.results[1]!.ok).toBe(true);
    expect(outcome.results[2]!.ok).toBe(false);
    expect((outcome.results[2] as { code: string }).code).toBe('E_SCOPE_RO');
    expect(outcome.results[3]!.ok).toBe(false);
    expect((outcome.results[3] as { code: string }).code).toBe('E_DEDUP');
    const dupDetails = (outcome.results[3] as { details?: { existing_uid?: string } }).details;
    expect(dupDetails?.existing_uid).toBe(
      (outcome.results[0] as { episode_uid: string }).episode_uid,
    );

    // Exactly the two inserted episodes need Phase B.
    expect(outcome.pendings).toHaveLength(2);
    expect(embedBacklogStats(ctx.db).count).toBe(2);

    // Phase B pipelined off-slot: backlog drains to zero.
    const sched = await schedulePendingEmbeds(wq, outcome.pendings);
    expect(sched.applied).toBe(2);
    expect(sched.failed).toBe(0);
    expect(embedBacklogStats(ctx.db).count).toBe(0);
  });
});

// ── Deferred near-dup (E8 in Phase B) ────────────────────────────────────────

describe('deferred E8 near-dup runs in Phase B', () => {
  it('Phase A defers near-dup; Phase B inserts SAME_AS and invalidates the older episode at >= threshold', async () => {
    // Full write: the "older" episode with a vector.
    const older = await memoryWrite(ctx.db, {
      content: 'quartz garnet topaz obsidian feldspar mineral catalogue',
    });
    expect('episode_uid' in older).toBe(true);
    const olderUid = (older as { episode_uid: string }).episode_uid;

    // Phase A of a token-permuted duplicate: identical token multiset (cosine 1.0
    // under the feature-hash provider) but different bytes → passes content-hash dedup.
    const newer = memoryWritePhaseA(ctx.db, {
      content: 'garnet quartz topaz obsidian feldspar mineral catalogue',
    });
    expect('code' in newer).toBe(false);
    const newerOut = newer as PhaseAOutcome;
    expect(newerOut.result.enrichment?.near_dup).toBeNull(); // deferred — documented semantics

    // Phase B: near-dup detected and applied.
    const vec = await embed(newerOut.pending!.text);
    const applied = applyEmbedding(ctx.db, newerOut.pending!, vec);
    expect(applied.status).toBe('applied');
    expect(applied.near_dup).not.toBeNull();
    expect(applied.near_dup!.existing_uid).toBe(olderUid);

    const newerRowid = rowidFor(ctx.db, newerOut.result.episode_uid);
    const olderRowid = rowidFor(ctx.db, olderUid);
    const edge = ctx.db
      .prepare<[number, number], { rowid: number }>(
        `SELECT rowid FROM edge WHERE src = ? AND dst = ? AND rel = 'SAME_AS' AND t_expired IS NULL`,
      )
      .get(newerRowid, olderRowid);
    expect(edge).toBeDefined();

    const olderNode = ctx.db
      .prepare<[string], { t_invalid: string | null }>('SELECT t_invalid FROM node WHERE uid = ?')
      .get(olderUid)!;
    expect(olderNode.t_invalid).not.toBeNull(); // cosine >= 0.95 → invalidated
  });
});

// ── Between-phases lifecycle edges ───────────────────────────────────────────

describe('applyEmbedding — node lifecycle between phases', () => {
  it('node invalidated between phases: vector still lands (bi-temporal), near-dup pass skipped', async () => {
    const a = memoryWritePhaseA(ctx.db, { content: 'ephemeral fact invalidated before its embedding lands' });
    expect('code' in a).toBe(false);
    const out = a as PhaseAOutcome;

    const inv = memoryInvalidate(ctx.db, { claim_uid: out.result.episode_uid, reason: 'superseded mid-flight' });
    expect('ok' in inv && inv.ok).toBe(true);

    const vec = await embed(out.pending!.text);
    const applied = applyEmbedding(ctx.db, out.pending!, vec);
    expect(applied.status).toBe('applied');
    expect(applied.near_dup).toBeNull(); // dead nodes never drive near-dup invalidation
    expect(vecRowFor(ctx.db, out.pending!.rowid)).toBeDefined();
    // Invalidated nodes are EXCLUDED from the backlog (they may never embed).
    expect(embedBacklogStats(ctx.db).count).toBe(0);
  });

  it('rowid/uid mismatch (node gone) → status gone, nothing written', async () => {
    const vec = await embed('whatever');
    const applied = applyEmbedding(ctx.db, { uid: 'no-such-uid', rowid: 99_999, text: 'whatever' }, vec);
    expect(applied.status).toBe('gone');
    expect(vecRowFor(ctx.db, 99_999)).toBeUndefined();
  });

  it('double apply (pipeline/heal race) → second returns exists, no duplicate vec row', async () => {
    const a = memoryWritePhaseA(ctx.db, { content: 'raced by the heal pass' });
    const out = a as PhaseAOutcome;
    const vec = await embed(out.pending!.text);
    expect(applyEmbedding(ctx.db, out.pending!, vec).status).toBe('applied');
    expect(applyEmbedding(ctx.db, out.pending!, vec).status).toBe('exists');
    const rows = ctx.db
      .prepare<[number], { c: number }>('SELECT COUNT(*) AS c FROM vec_node WHERE node_id = ?')
      .get(out.pending!.rowid)!;
    expect(rows.c).toBe(1);
  });
});

// ── Phase-B crash → heal (the load-bearing recovery path) ─────────────────────

describe('Phase-B crash recovery: embedBacklogStats + healMissingVectors', () => {
  it('killed Phase B leaves a detected backlog; the heal drains it to zero (N→0)', async () => {
    const wq = WriteQueue.forPath(ctx.dbPath);

    // Simulate the crash: Phase B's embed always throws.
    _setEmbedProviderForTest(new FailingProvider());
    const logLines: string[] = [];

    const a = memoryWritePhaseA(ctx.db, { content: 'first orphan awaiting its embedding vector' });
    const b = memoryWritePhaseA(ctx.db, { content: 'second orphan from a different write entirely' });
    const pendings = [(a as PhaseAOutcome).pending!, (b as PhaseAOutcome).pending!];

    const sched = await schedulePendingEmbeds(wq, pendings, { logSink: (l) => logLines.push(l) });
    expect(sched.failed).toBe(2);
    expect(sched.applied).toBe(0);
    // Stderr observability: every Phase-B failure logs.
    expect(logLines.filter((l) => l.includes('Phase-B FAILURE'))).toHaveLength(2);

    // The backlog is DETECTED, with an age signal for the stall verdict.
    const backlog = embedBacklogStats(ctx.db);
    expect(backlog.count).toBe(2);
    expect(backlog.oldest_created_at).not.toBeNull();

    // "Process restart": the provider works again; the periodic heal repairs.
    _setEmbedProviderForTest(new DeterministicTestProvider());
    const heal = await healMissingVectors(ctx.db, wq);
    expect(heal.scanned).toBe(2);
    expect(heal.healed).toBe(2);
    expect(heal.failed).toBe(0);
    expect(embedBacklogStats(ctx.db).count).toBe(0); // N→0
  });

  // NC (documented negative control, repo convention): with the heal disabled,
  // the orphaned no-vec node stays orphaned forever — proving healMissingVectors
  // is the load-bearing recovery path, not incidentally-redundant machinery.
  // Skipped per repo NC convention; the body is real and runnable.
  it.skip('NC: with SOX_DISABLE_EMBED_HEAL=1 the orphan stays orphaned', async () => {
    const wq = WriteQueue.forPath(ctx.dbPath);
    _setEmbedProviderForTest(new FailingProvider());
    const a = memoryWritePhaseA(ctx.db, { content: 'orphan that nobody heals' });
    await schedulePendingEmbeds(wq, [(a as PhaseAOutcome).pending!], { logSink: () => {} });
    expect(embedBacklogStats(ctx.db).count).toBe(1);

    _setEmbedProviderForTest(new DeterministicTestProvider());
    process.env['SOX_DISABLE_EMBED_HEAL'] = '1';
    const heal = await healMissingVectors(ctx.db, wq);
    expect(heal.disabled).toBe(true);
    expect(heal.healed).toBe(0);
    expect(embedBacklogStats(ctx.db).count).toBe(1); // still orphaned
  });
});

// ── Kill-switch composition ───────────────────────────────────────────────────

describe('SOX_SYNC_EMBED kill-switch', () => {
  it('syncEmbedEnabled reads the env per call', () => {
    expect(syncEmbedEnabled()).toBe(false);
    process.env['SOX_SYNC_EMBED'] = '1';
    expect(syncEmbedEnabled()).toBe(true);
    delete process.env['SOX_SYNC_EMBED'];
    expect(syncEmbedEnabled()).toBe(false);
  });

  it('memoryWrite (the sync composition) still returns near_dup and leaves no backlog', async () => {
    await memoryWrite(ctx.db, { content: 'silver copper bronze pewter alloys reference table' });
    const r = await memoryWrite(ctx.db, { content: 'copper silver bronze pewter alloys reference table' });
    expect('episode_uid' in r).toBe(true);
    const wr = r as { enrichment?: { near_dup: { existing_uid: string } | null } };
    expect(wr.enrichment?.near_dup).not.toBeNull(); // synchronous E8 — pre-split behaviour
    expect(embedBacklogStats(ctx.db).count).toBe(0); // vector landed before returning
  });
});
