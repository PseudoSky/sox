/**
 * sr7-sr9-substrate.spec.ts — the SR-7/SR-9 substrate capabilities driven
 * through the REAL MCP tool surface and the REAL enrich tick, as a consumer
 * uses them.
 *
 * SR-7: `memory_claim_upsert` / `memory_claim_get` / `memory_claim_list` —
 *   a claim round-trip that SURVIVES A STORE REOPEN, a distinct caller refused
 *   with the typed E_CLAIM_HELD, and idempotency for the same caller.
 *
 * SR-9: `memory_curate {op:'recluster'}` returns an observable handle; the REAL
 *   tick (`runEnrichPassOnDb`) settles it; `{op:'recluster_status'}` polls it to
 *   the terminal `completed` state with the resulting partition. A failed pass
 *   is distinguishable from a pending one.
 *
 * Default-running (no env gate). Uses the suite's deterministic mock embed
 * provider; the isolated enrich child clusters already-vectorised episodes, so
 * no real ONNX load occurs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  closeCachedAdapter,
  getDb,
  flushPendingEmbeds,
  _setEnrichHostForkResolverForTest,
} from '@adhd/sox-memory-core';
import { handleToolCall, runEnrichPassOnDb } from './index.js';

const cleanups: Array<() => void> = [];
function tmpStorePath(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sr7sr9-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, 'store.db');
}

/** Write a fake isolated-enrich host and point the fork resolver at it directly
 *  (plain JS — no execArgv needed). Mirrors bl348-stage-isolation.spec.ts: this
 *  is the isolation BOUNDARY, the seam the parent's settle logic consumes. */
function fakeHostScript(body: string): { modulePath: string; execArgv: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr7sr9-host-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, 'fake-host.js');
  fs.writeFileSync(p, body);
  return { modulePath: p, execArgv: [] };
}

/** Fake host that reports success BUT sets `cluster_pass_skipped` — the
 *  mixed-model / no-neighbour guard shape (enrich-batch.ts): the pass ran,
 *  the cluster step did not, the partition is unchanged. */
const SKIPPED_HOST = `
process.on('message', (msg) => {
  if (typeof process.send === 'function') {
    process.send({ id: msg.id, result: {
      communities_upserted: 0, member_of_edges: 0, importance_updated: 0,
      relates_to_edges: 0, topics_backfilled: 0, legacy_nodes_stamped: 0,
      cluster_pass_skipped: true,
      cluster_skip_reason: 'mixed-model guard: null enrich_ver episodes detected; reindex required (D5.3)',
    } });
  }
  setImmediate(() => process.exit(0));
});
`;

function parseResult(resp: { content: Array<{ text?: string }> }): Record<string, unknown> {
  return JSON.parse(resp.content[0]?.text ?? '{}') as Record<string, unknown>;
}

async function writeEpisode(dbPath: string, content: string): Promise<string> {
  const resp = await handleToolCall('memory_write', {
    db_path: dbPath,
    content,
    project_path: '/test/sr7sr9',
  });
  const body = parseResult(resp as { content: Array<{ text?: string }> });
  // memory_write returns { uid, ... } on success (or a code on error).
  return (body['uid'] ?? body['episode_uid'] ?? '') as string;
}

beforeEach(() => {
  cleanups.length = 0;
});

afterEach(async () => {
  _setEnrichHostForkResolverForTest(null);
  for (const c of cleanups) c();
  cleanups.length = 0;
});

describe('SR-7 — claim surface through the real MCP tools', () => {
  it('claim → reopen the store → the same holder is still readable; a distinct caller is refused', async () => {
    const dbPath = tmpStorePath();
    await getDb(dbPath);
    const uid = await writeEpisode(dbPath, 'SR-7 claim target episode with unique walrus tokens');
    expect(uid.length).toBeGreaterThan(0);
    await flushPendingEmbeds();

    const claim = parseResult(
      (await handleToolCall('memory_claim_upsert', { db_path: dbPath, uid, caller: 'alpha' })) as {
        content: Array<{ text?: string }>;
      },
    );
    expect(claim['ok']).toBe(true);
    expect((claim['claim'] as { caller: string }).caller).toBe('alpha');

    // A distinct caller is refused with a typed conflict.
    const refused = parseResult(
      (await handleToolCall('memory_claim_upsert', { db_path: dbPath, uid, caller: 'beta' })) as {
        content: Array<{ text?: string }>;
      },
    );
    expect(refused['ok']).toBe(false);
    expect(refused['code']).toBe('E_CLAIM_HELD');
    expect(refused['held_by']).toBe('alpha');

    // Idempotent re-claim by the same caller.
    const again = parseResult(
      (await handleToolCall('memory_claim_upsert', { db_path: dbPath, uid, caller: 'alpha' })) as {
        content: Array<{ text?: string }>;
      },
    );
    expect(again['ok']).toBe(true);
    expect(again['refreshed']).toBe(true);

    // Reopen the store (close the cached adapter; the next tool call reopens it)
    // and prove the claim is a PERSISTED record, not in-process state.
    await closeCachedAdapter(dbPath);

    const got = parseResult(
      (await handleToolCall('memory_claim_get', { db_path: dbPath, uid })) as {
        content: Array<{ text?: string }>;
      },
    );
    expect(got['ok']).toBe(true);
    expect((got['claim'] as { caller: string }).caller).toBe('alpha');

    const list = parseResult(
      (await handleToolCall('memory_claim_list', { db_path: dbPath, caller: 'alpha' })) as {
        content: Array<{ text?: string }>;
      },
    );
    expect(list['count']).toBe(1);

    await closeCachedAdapter(dbPath);
  });
});

describe('SR-9 — observable recluster through the real MCP tools and the real tick', () => {
  it('recluster → pending handle → the tick settles it → recluster_status reports completed + partition', async () => {
    const dbPath = tmpStorePath();
    const adapter = await getDb(dbPath);
    await writeEpisode(dbPath, 'Observable recluster corpus alpha with unique narwhal tokens.');
    await writeEpisode(dbPath, 'Observable recluster corpus beta with unique pangolin tokens.');
    await flushPendingEmbeds();

    // 1. Request the global recluster — an OBSERVABLE handle, not fire-and-forget.
    const out = parseResult(
      (await handleToolCall('memory_curate', { db_path: dbPath, op: 'recluster' })) as {
        content: Array<{ text?: string }>;
      },
    );
    expect(out['op']).toBe('recluster');
    expect(out['enqueued']).toBe(true);
    expect(out['status']).toBe('pending');
    const jobId = out['job_id'] as string;
    expect(typeof jobId).toBe('string');

    const before = parseResult(
      (await handleToolCall('memory_curate', { db_path: dbPath, op: 'recluster_status', job_id: jobId })) as {
        content: Array<{ text?: string }>;
      },
    );
    expect(before['status']).toBe('pending');

    // 2. The REAL tick runs the full pass and settles the job.
    const pass = await runEnrichPassOnDb(adapter, dbPath);
    expect(pass.full_pass).toBe(true);

    // 3. The caller observes the terminal state — with the resulting partition.
    const after = parseResult(
      (await handleToolCall('memory_curate', { db_path: dbPath, op: 'recluster_status', job_id: jobId })) as {
        content: Array<{ text?: string }>;
      },
    );
    expect(after['status']).toBe('completed');
    const partition = after['partition'] as { community_count: number; coverage: number } | null;
    expect(partition).not.toBeNull();
    expect(typeof partition!.community_count).toBe('number');

    await closeCachedAdapter(dbPath);
  });

  it('recluster_status on an unknown handle reports E_NOT_FOUND (never a false terminal state)', async () => {
    const dbPath = tmpStorePath();
    await getDb(dbPath);
    const resp = parseResult(
      (await handleToolCall('memory_curate', { db_path: dbPath, op: 'recluster_status', job_id: 'no-such-job' })) as {
        content: Array<{ text?: string }>;
      },
    );
    expect(resp['code']).toBe('E_NOT_FOUND');
    await closeCachedAdapter(dbPath);
  });

  it('a SKIPPED cluster pass settles `skipped`, NOT `completed` (M1)', async () => {
    const dbPath = tmpStorePath();
    const adapter = await getDb(dbPath);
    await writeEpisode(dbPath, 'SR-9 skipped-pass corpus with unique quokka tokens.');
    await flushPendingEmbeds();

    const out = parseResult(
      (await handleToolCall('memory_curate', { db_path: dbPath, op: 'recluster' })) as {
        content: Array<{ text?: string }>;
      },
    );
    const jobId = out['job_id'] as string;
    expect(typeof jobId).toBe('string');

    // The isolated enrich child runs cleanly (`ok`) but SKIPS its cluster step —
    // the mixed-model / no-neighbour guard shape (enrich-batch.ts). Before M1 the
    // tick settled `completed` whenever `isolated.ok`, reporting a reorganisation
    // that never happened and leaving the partition unchanged.
    _setEnrichHostForkResolverForTest(() => fakeHostScript(SKIPPED_HOST));

    const pass = await runEnrichPassOnDb(adapter, dbPath);
    expect(pass.cluster_ok).toBe(true); // the pass itself completed...

    const after = parseResult(
      (await handleToolCall('memory_curate', { db_path: dbPath, op: 'recluster_status', job_id: jobId })) as {
        content: Array<{ text?: string }>;
      },
    );
    // ...but the reorganisation did NOT happen, and the caller is told so.
    expect(after['status']).toBe('skipped');
    expect(after['status']).not.toBe('completed');
    expect(String(after['skip_reason'])).toContain('mixed-model guard');

    await closeCachedAdapter(dbPath);
  });
});
