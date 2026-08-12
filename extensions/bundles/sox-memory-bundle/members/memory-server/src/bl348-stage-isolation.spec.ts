/**
 * bl348-stage-isolation.spec.ts — BL-348 regression: clustering/enrichment
 * must never block or lose a written embedding.
 *
 * Owner directive, verbatim: "the execution of clustering should never block
 * an embedding from being written. Failing clustering should never drop an
 * embedding. Embedding vector loss is a critical failure."
 *
 * THE DEFECT THIS REPLACES: before this change, `runPeriodicEnrichPass()` ran
 * `runBatchEnrich` (clustering/importance/auto-link) IN-PROCESS, wrapped in
 * the SAME `_bgSlot` mutex the embed drain uses, and any uncaught throw from
 * it propagated out of a floating promise as an unhandled rejection (fatal to
 * the whole process by default). See enrich-process-host.ts / enrich-isolation.ts
 * for the full architecture: clustering now runs in an isolated CHILD PROCESS,
 * forked fresh per pass, whose outcome (success, thrown error, crash, timeout)
 * is always reported back as a value, never a rejection.
 *
 * Both tests point `_setEnrichHostForkResolverForTest` at a tiny fake host
 * script (not the real enrich-process-host) so the isolation BOUNDARY itself
 * (separate process, controlled outcome, no shared state) is what's under
 * test — not real clustering math, which is PKT-28/30's territory.
 *
 * RED→GREEN PROCEDURE ACTUALLY PERFORMED (BL-225):
 *   Both tests were first run against the PRE-BL-348 code (in-process
 *   `runBatchEnrich(adapter, ...)`, whole-tick `withBackgroundSlot('enrich', ...)`
 *   wrap). Test 1 failed: `await pass` rejected — the forced throw propagated
 *   as an unhandled rejection into the SAME process the write's WriteQueue
 *   lives in, and vitest reported it as a test failure (not "vector missing",
 *   but the process-level symptom BL-348's owner directive is about — a
 *   thrown clustering error was not a contained, reported outcome). Test 2
 *   failed: `writeToVectorMs` measured >= the enrichment stage's artificial
 *   delay, proving the synchronous in-process work blocked the concurrent
 *   write's embed from landing. After the isolation-boundary change, both
 *   pass: the forced throw resolves as `{ok:false}` inside the isolated
 *   process's caller and never reaches the write path, and the slow stage
 *   (now off-process) does not measurably delay `writeToVectorMs`.
 *
 * Gate: npx nx test memory-server --skip-nx-cache
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getDb,
  _setEmbedProviderForTest,
  _setEnrichHostForkResolverForTest,
  DeterministicTestProvider,
  flushPendingEmbeds,
  WriteQueue,
} from '@adhd/sox-memory-core';
import { handleToolCall, runEnrichPassOnDb, wakeDrain } from './index.js';
import type { StoreAdapter } from '@adhd/sox-store-adapter';

const cleanups: Array<() => void> = [];

function tmpStorePath(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl348-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, 'store.db');
}

/** Write a standalone Node script and point the enrich-isolation fork
 *  resolver at it directly (no execArgv needed — it's already plain JS). */
function fakeHostScript(body: string): { modulePath: string; execArgv: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl348-host-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, 'fake-host.js');
  fs.writeFileSync(p, body);
  return { modulePath: p, execArgv: [] };
}

/** Fake host that ALWAYS reports a thrown error over IPC — the "clustering
 *  stage forced to throw" shape, isolated. Never touches any DB. */
const THROWING_HOST = `
process.on('message', (msg) => {
  if (typeof process.send === 'function') {
    process.send({ id: msg.id, error: 'BL-348 forced clustering failure (test fixture)' });
  }
  setImmediate(() => process.exit(1));
});
`;

/** Fake host that sleeps for \`delayMs\` (read from the request) before
 *  reporting success — the "deliberately slow enrichment stage" shape. */
const SLOW_HOST = `
process.on('message', async (msg) => {
  const delayMs = (msg.opts && msg.opts.__testDelayMs) || 2000;
  await new Promise((r) => setTimeout(r, delayMs));
  if (typeof process.send === 'function') {
    process.send({
      id: msg.id,
      result: {
        communities_upserted: 0, member_of_edges: 0, importance_updated: 0,
        relates_to_edges: 0, topics_backfilled: 0, legacy_nodes_stamped: 0,
        cluster_pass_skipped: false,
      },
    });
  }
  setImmediate(() => process.exit(0));
});
`;

beforeEach(() => {
  delete process.env['SOX_SYNC_EMBED']; // exercise the async default pipeline
  _setEmbedProviderForTest(new DeterministicTestProvider());
});

afterEach(async () => {
  _setEnrichHostForkResolverForTest(null);
  await flushPendingEmbeds();
  WriteQueue.clearInstances();
  _setEmbedProviderForTest(new DeterministicTestProvider());
  process.env['SOX_SYNC_EMBED'] = '1'; // restore the suite-wide pin other specs rely on
  for (const c of cleanups.splice(0)) c();
});

async function insertLiveEpisodeWithVector(dbPath: string, content: string): Promise<string> {
  const res = await handleToolCall('memory_write', {
    db_path: dbPath,
    content,
    project_path: '/tmp/bl348',
  });
  expect(res.isError).toBeFalsy();
  const payload = JSON.parse((res.content[0] as { text: string }).text) as { episode_uid: string };
  return payload.episode_uid;
}

async function hasVector(adapter: StoreAdapter, uid: string): Promise<boolean> {
  const row = await adapter.executeGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM vec_node v JOIN node n ON n.rowid = v.node_id WHERE n.uid = ?`,
    [uid],
  );
  return (row?.c ?? 0) > 0;
}

describe('BL-348 — a failing clustering/enrichment stage never drops an embedding', () => {
  it('the embedding is still durably present in vec_node after the isolated cluster pass throws', async () => {
    const dbPath = tmpStorePath();
    await handleToolCall('memory_ping', { db_path: dbPath });

    const uid = await insertLiveEpisodeWithVector(dbPath, 'BL-348: must survive a forced clustering throw');
    await flushPendingEmbeds();
    wakeDrain('bl348-setup');
    // Let the write-triggered drain wake land the vector before we force
    // the cluster pass to fail — this is the state a real periodic tick
    // would see.
    await new Promise((r) => setTimeout(r, 50));

    const adapter = await getDb(dbPath);
    expect(await hasVector(adapter, uid)).toBe(true);

    // Point the isolated cluster pass at a fake host that always reports a
    // thrown error over IPC.
    _setEnrichHostForkResolverForTest(() => fakeHostScript(THROWING_HOST));

    const tickResult = await runEnrichPassOnDb(adapter, dbPath);

    // THE ASSERTION: the tick reports the failure (not silently swallowed —
    // an operator can see it), but does NOT throw, and the embedding written
    // before the failing pass is still there, untouched.
    expect(tickResult.cluster_ok).toBe(false);
    expect(tickResult.cluster_error).toContain('BL-348 forced clustering failure');
    expect(await hasVector(adapter, uid)).toBe(true);

    // And a write made AFTER the failure still reaches a vector normally —
    // the failure did not poison anything for subsequent writes either.
    const uid2 = await insertLiveEpisodeWithVector(dbPath, 'BL-348: written after the cluster failure');
    await flushPendingEmbeds();
    wakeDrain('bl348-post-failure');
    await new Promise((r) => setTimeout(r, 50));
    expect(await hasVector(adapter, uid2)).toBe(true);
  });
});

describe('BL-348 — a slow enrichment/clustering stage does not block the embed path', () => {
  it('write_to_vector_ms for a concurrent write is not increased by a slow isolated cluster pass', async () => {
    const dbPath = tmpStorePath();
    await handleToolCall('memory_ping', { db_path: dbPath });
    const adapter = await getDb(dbPath);
    // Warm the WriteQueue singleton for this path BEFORE the race starts.
    // NOTE (found while proving this test's red arm, filed as a new backlog
    // item — out of scope for BL-348 itself): `WriteQueue.forPath`'s
    // check-then-set on `WriteQueue.instances` is not atomic. Two concurrent
    // FIRST callers for the same never-before-seen dbPath (exactly this
    // test's shape without this warm-up) both see no cached instance and
    // each independently call `openDb()` — paying the full migration/
    // integrity-check sequence twice, concurrently, on the same file. That
    // measured 5+ real seconds here, which would have been misattributed to
    // BL-348's isolation boundary. A live server's WriteQueue is always
    // already warm by the time a periodic tick runs, so this warm-up matches
    // real steady-state behaviour, not just papering over the race.
    await WriteQueue.forPath(dbPath);

    // Point the isolated cluster pass at a fake host that sleeps 2s before
    // reporting success — long enough that if the write path were blocked
    // behind it (the pre-BL-348 shape: whole-tick withBackgroundSlot wrap),
    // write_to_vector_ms would be forced to >= ~2000ms.
    _setEnrichHostForkResolverForTest(() => fakeHostScript(SLOW_HOST));

    // Measured from BEFORE the slow pass is even started — any hazard where
    // starting/running the cluster pass itself starves the event loop (and
    // so delays the write's OWN async calls from even being scheduled) must
    // show up here. Measuring from after the pass call returns would hide
    // exactly that class of hazard.
    const writeStartedAt = Date.now();

    // Fire the slow cluster pass — deliberately not awaited here, exactly
    // like the real periodic tick's floating `void runPeriodicEnrichPassGuarded()`.
    const slowPass = runEnrichPassOnDb(adapter, dbPath).catch(() => undefined);

    const uid = await insertLiveEpisodeWithVector(dbPath, 'BL-348: concurrent write during a slow cluster pass');
    await flushPendingEmbeds();
    wakeDrain('bl348-concurrent-write');

    // Poll for the vector to land, measuring real wall-clock time.
    let writeToVectorMs = -1;
    for (let i = 0; i < 500; i++) {
      if (await hasVector(adapter, uid)) {
        writeToVectorMs = Date.now() - writeStartedAt;
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(writeToVectorMs).toBeGreaterThanOrEqual(0);
    // THE ASSERTION: the write's vector lands in well under the slow stage's
    // 2000ms delay — proving the isolation boundary is real, not nominal.
    expect(writeToVectorMs).toBeLessThan(1000);

    // Let the slow pass finish so it doesn't leak into the next test.
    await slowPass;
  });
});
