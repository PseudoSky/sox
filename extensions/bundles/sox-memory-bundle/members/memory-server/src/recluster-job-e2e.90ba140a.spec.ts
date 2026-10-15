/**
 * recluster-job-e2e.90ba140a.spec.ts — AC-B7: a recluster BEGINS and COMPLETES,
 * end to end, on a synthetic store.
 *
 * Nothing is mocked: the full pass and the filtered pass each run in the REAL
 * isolated enrich child process (forked by `runEnrichIsolated`) against a
 * synthetic store in a unique temp dir — never `~/.memory/memory.db`, no shared
 * socket or port, no embedding host (vectors are written straight into
 * `vec_node`, so the heal step has nothing to embed). One shared scaffold for
 * all three tests keeps the duration minimal.
 *
 * Size: SOX_RECLUSTER_E2E_NODES (default 400 — seconds). The numbers the owner
 * asked for (a full pass over thousands of nodes) come from running this spec
 * with a larger value; each run prints one `E2E_METRICS {json}` line with node
 * count, wall times, load average and the observed state transitions.
 *
 * Item: 90ba140a / 2f998081 AC-B7 (also exercises AC-B1 prompt return, AC-B2
 * begin->complete states, AC-B3 single-flight on a real store).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { closeCachedAdapter, getDb, vecToBuffer, vecToJson } from '@adhd/sox-memory-core';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { handleToolCall, runEnrichPassOnDb, runReclusterSubsetJobOnDb } from './index.js';

const N = Number(process.env['SOX_RECLUSTER_E2E_NODES'] ?? 400);
const GROUP = 25;
const DIM = 768;
const T = 20 * 60_000;

type Resp = { content: Array<{ text?: string }> };
const parse = (r: unknown): Record<string, unknown> =>
  JSON.parse((r as Resp).content[0]?.text ?? '{}') as Record<string, unknown>;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function unitGaussian(rnd: () => number): Float32Array {
  const v = new Float32Array(DIM);
  let norm = 0;
  for (let i = 0; i < DIM; i++) {
    const g = Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
    v[i] = g; norm += g * g;
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < DIM; i++) v[i] = v[i]! / norm;
  return v;
}

async function seed(adapter: StoreAdapter, n: number): Promise<void> {
  const rnd = mulberry32(90140);
  const now = new Date().toISOString();
  const binary = adapter.capabilities.nativeVectors;
  const centers = Array.from({ length: Math.ceil(n / GROUP) }, () => unitGaussian(rnd));
  for (let start = 0; start < n; start += 250) {
    await adapter.transaction(async (tx) => {
      for (let i = start; i < Math.min(n, start + 250); i++) {
        const c = centers[Math.floor(i / GROUP)]!;
        const noise = unitGaussian(rnd);
        const v = new Float32Array(DIM);
        let norm = 0;
        for (let d = 0; d < DIM; d++) { v[d] = c[d]! + 0.33 * noise[d]!; norm += v[d]! * v[d]!; }
        norm = Math.sqrt(norm);
        for (let d = 0; d < DIM; d++) v[d] = v[d]! / norm;
        const content = `synthetic episode ${i} of topic group ${Math.floor(i / GROUP)} for the recluster e2e`;
        const row = await tx.executeGet<{ rowid: number }>(
          `INSERT INTO node (uid, kind, content, name, summary, meta, source, importance, content_hash,
                             t_created, t_occurred, t_valid, topic, tags, project_path, enrich_ver, t_updated)
           VALUES (?, 'episode', ?, ?, ?, '{}', 'observation', 5, ?, ?, ?, ?, ?, '[]', ?, ?, ?)
           RETURNING rowid`,
          [`e2e-${i}-${crypto.randomUUID()}`, content, `e${i}`, content,
           crypto.createHash('sha256').update(content).digest('hex'), now, now, now,
           `group-${Math.floor(i / GROUP)}`, i % 2 === 0 ? '/proj/a' : '/proj/b',
           JSON.stringify({ pass: '1.0.0', ts: now }), now],
        );
        await tx.executeRun(
          'INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)',
          [row!.rowid, binary ? vecToBuffer(v) : vecToJson(v)],
        );
      }
    });
  }
}

/** Prints the metrics line and, when SOX_RECLUSTER_E2E_METRICS_FILE is set, appends it there (vitest hides console output of passing tests). */
function emitMetrics(json: string): void {
  console.info('E2E_METRICS ' + json);
  const f = process.env['SOX_RECLUSTER_E2E_METRICS_FILE'];
  if (f) fs.appendFileSync(f, json + '\n');
}

let dir: string;
let dbPath: string;
let adapter: StoreAdapter;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl90ba140a-e2e-'));
  dbPath = path.join(dir, 'store.db');
  adapter = await getDb(dbPath);
  await seed(adapter, N);
}, T);
afterAll(async () => {
  await closeCachedAdapter(dbPath);
  fs.rmSync(dir, { recursive: true, force: true });
});

async function watchStates(jobId: string, stop: { v: boolean }): Promise<Array<{ state: string; at_ms: number }>> {
  const seen: Array<{ state: string; at_ms: number }> = [];
  const t0 = performance.now();
  while (!stop.v) {
    const st = parse(await handleToolCall('memory_curate', { db_path: dbPath, op: 'recluster_status', job_id: jobId }));
    const state = String(st['state']);
    if (seen.length === 0 || seen[seen.length - 1]!.state !== state) seen.push({ state, at_ms: Math.round(performance.now() - t0) });
    await new Promise((r) => setTimeout(r, 25));
  }
  // one last read after the pass returned, so the terminal state is recorded
  const last = parse(await handleToolCall('memory_curate', { db_path: dbPath, op: 'recluster_status', job_id: jobId }));
  const lastState = String(last['state']);
  if (seen.length === 0 || seen[seen.length - 1]!.state !== lastState) seen.push({ state: lastState, at_ms: Math.round(performance.now() - t0) });
  return seen;
}

describe('90ba140a AC-B7 a recluster begins and completes on a synthetic store', () => {
  it(`90ba140a AC-B7: whole-store full pass over ${N} synthetic episodes runs in the isolated child: queued -> running -> completed`, async () => {
    const reqStart = performance.now();
    const req = parse(await handleToolCall('memory_curate', { db_path: dbPath, op: 'recluster' }));
    const requestMs = Math.round(performance.now() - reqStart);
    expect(req['state']).toBe('queued');
    const jobId = req['job_id'] as string;
    expect(requestMs).toBeLessThan(2000); // AC-B1

    const stop = { v: false };
    const watcher = watchStates(jobId, stop);
    const passStart = performance.now();
    await runEnrichPassOnDb(adapter, dbPath, { acquireHealSlot: false });
    const passMs = Math.round(performance.now() - passStart);
    stop.v = true;
    const transitions = await watcher;

    const st = parse(await handleToolCall('memory_curate', { db_path: dbPath, op: 'recluster_status', job_id: jobId }));
    const partition = st['partition'] as { community_count: number; clustered_episodes: number; live_episodes: number };
    emitMetrics(JSON.stringify({
      kind: 'full', nodes: N, request_ms: requestMs, full_pass_wall_ms: passMs,
      load_avg: os.loadavg().map((x) => Math.round(x * 100) / 100), transitions,
      started_at: st['started_at'], finished_at: st['finished_at'], partition,
    }));
    expect(st['state']).toBe('completed');
    expect(typeof st['started_at']).toBe('string');
    expect(typeof st['finished_at']).toBe('string');
    expect(String(st['finished_at']) >= String(st['started_at'])).toBe(true);
    expect(partition.live_episodes).toBe(N);
    expect(partition.community_count).toBeGreaterThan(0);
    expect(partition.clustered_episodes).toBeGreaterThan(0);
    const states = transitions.map((t) => t.state);
    expect(states[0]).toBe('queued');
    expect(states[states.length - 1]).toBe('completed');
  }, T);

  it('90ba140a AC-B7: a FILTERED recluster runs in the isolated child and completes with a persisted lens', async () => {
    const reqStart = performance.now();
    const req = parse(await handleToolCall('memory_curate', {
      db_path: dbPath, op: 'recluster', filters: { project_path: '/proj/a' },
    }));
    const requestMs = Math.round(performance.now() - reqStart);
    expect(req).toMatchObject({ scope: 'subset', state: 'queued', joined: false });
    const jobId = req['job_id'] as string;
    const passStart = performance.now();
    // The enrich tick retries a job whose fork was refused (this process's one-holder
    // child from the previous pass may still be exiting), so the test does the same,
    // bounded.
    let out = await runReclusterSubsetJobOnDb(adapter, dbPath);
    for (let i = 0; !out.ran && i < 120; i++) {
      await new Promise((r) => setTimeout(r, 500));
      out = await runReclusterSubsetJobOnDb(adapter, dbPath);
    }
    const passMs = Math.round(performance.now() - passStart);
    if (out.ran && out.state !== 'completed') {
      const bad = parse(await handleToolCall('memory_curate', { db_path: dbPath, op: 'recluster_status', job_id: jobId }));
      console.info('E2E_SUBSET_NOT_COMPLETED ' + JSON.stringify({ state: bad['state'], error: bad['error'], reason: bad['reason'], skip_reason: bad['skip_reason'] }));
    }
    expect(out).toMatchObject({ ran: true, job_id: jobId, state: 'completed' });
    const st = parse(await handleToolCall('memory_curate', { db_path: dbPath, op: 'recluster_status', job_id: jobId }));
    const result = st['result'] as { candidate_count: number; cluster_count: number; persisted: boolean };
    emitMetrics(JSON.stringify({
      kind: 'subset', nodes: N, candidates: result.candidate_count, request_ms: requestMs, subset_pass_wall_ms: passMs,
      load_avg: os.loadavg().map((x) => Math.round(x * 100) / 100), clusters: result.cluster_count,
    }));
    expect(st['state']).toBe('completed');
    expect(result.persisted).toBe(true);
    expect(result.candidate_count).toBe(Math.ceil(N / 2));
    expect(result.cluster_count).toBeGreaterThan(0);
  }, T);

  it('90ba140a AC-B3 AC-B7: once settled, a new request mints a fresh job (not joined to the finished one)', async () => {
    const again = parse(await handleToolCall('memory_curate', { db_path: dbPath, op: 'recluster' }));
    expect(again).toMatchObject({ joined: false, state: 'queued' });
    const joined = parse(await handleToolCall('memory_curate', { db_path: dbPath, op: 'recluster' }));
    expect(joined).toMatchObject({ job_id: again['job_id'], joined: true });
  }, T);
});
