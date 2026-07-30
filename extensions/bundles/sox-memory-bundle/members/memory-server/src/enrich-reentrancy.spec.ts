/**
 * enrich-reentrancy.spec.ts — regression test for the embed-backfill
 * self-stampede (proven root cause: the periodic enrich timer had ZERO
 * reentrancy guard).
 *
 * THE BUG (confirmed live before this fix): `_periodicEnrichTimer` was a bare
 * `setInterval(() => void runPeriodicEnrichPass(), 5min)`. A single pass
 * (healMissingVectors' sequential scan through ONE shared embed child
 * process) routinely takes far longer than 5 minutes at real throughput. The
 * next tick fired anyway, re-ran the SAME `NOT EXISTS vec_node ... ORDER BY
 * rowid ASC LIMIT 500` scan (the previous pass's applies hadn't landed yet),
 * and queued a second full round of embeds for the SAME rows behind the
 * first — compounding every tick forever. `embed_backlog` was frozen for
 * five weeks; whichever tick finished first landed the row, every other
 * overlapping tick discarded its work as 'exists' after burning a redundant
 * embed call.
 *
 * THIS TEST PROVES BOTH DIRECTIONS, ACTUALLY RUN (not simulated):
 *   RED   — calling the UNGUARDED `runPeriodicEnrichPass()` concurrently
 *           reproduces the stampede: the same orphan row is embedded TWICE
 *           because the second call's scan races the first call's apply.
 *   GREEN — calling the GUARDED `runPeriodicEnrichPassGuarded()` concurrently
 *           embeds the row exactly ONCE; the second call detects the
 *           in-flight pass, skips its work, and increments the (visible,
 *           non-silent) skip counter.
 *
 * DETERMINISM: a GatedProvider (BL-161 seam, no real ONNX) blocks the first
 * embed call mid-flight so the second concurrent call's SELECT scan
 * deterministically observes the pre-apply state — no sleeps, no flakiness.
 *
 * Gate: npx nx test memory-server --skip-nx-cache
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  getDb,
  _setEmbedProviderForTest,
  DeterministicTestProvider,
  flushPendingEmbeds,
  WriteQueue,
} from '@adhd/sox-memory-core';
import {
  handleToolCall,
  runPeriodicEnrichPass,
  runPeriodicEnrichPassGuarded,
  isEnrichPassInFlight,
  getEnrichPassSkipCount,
} from './index.js';

/**
 * Provider whose embedSingle blocks on a shared gate until released, and
 * counts every invocation — the instrumentation needed to prove whether a
 * SECOND concurrent pass independently re-embeds the same still-unhealed row
 * (the bug) or is turned away before touching it (the fix).
 */
class GatedCountingProvider extends DeterministicTestProvider {
  private gate: Promise<void>;
  release!: () => void;
  calls = 0;
  callTexts: string[] = [];

  constructor() {
    super();
    this.gate = new Promise<void>((r) => (this.release = r));
  }

  override async embedSingle(
    ...args: Parameters<DeterministicTestProvider['embedSingle']>
  ): Promise<Float32Array> {
    this.calls++;
    this.callTexts.push(args[0]);
    await this.gate;
    return super.embedSingle(...args);
  }
}

const cleanups: Array<() => void> = [];

function tmpStorePath(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-enrich-reentrancy-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, 'store.db');
}

/** Raw-insert a live episode WITHOUT a vec row — the "crashed Phase B" shape
 *  healMissingVectors targets, matching async-embed.spec.ts's fixture. */
async function insertOrphanEpisode(dbPath: string, content: string, tCreated: string): Promise<void> {
  const db = (await getDb(dbPath)).unwrap() as Database.Database;
  db.prepare(
    `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid)
     VALUES (?, 'episode', ?, ?, ?, ?)`,
  ).run(`orphan-${Math.random().toString(36).slice(2)}`, content, `hash-${Math.random()}`, tCreated, tCreated);
}

/**
 * Poll until `cond()` is true, yielding to the event loop between checks via
 * a real macrotask (setTimeout(0)) so pending microtasks AND already-queued
 * macrotasks (e.g. better-sqlite3 wrapped in async StoreAdapter calls) get a
 * chance to run. Bounded so a real regression (guard broken, gate never
 * reached) fails fast with a clear message instead of hanging the suite.
 */
async function waitFor(cond: () => boolean, label: string, maxIters = 500): Promise<void> {
  for (let i = 0; i < maxIters; i++) {
    if (cond()) return;
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  throw new Error(`waitFor(${label}) timed out after ${maxIters} iterations`);
}

async function backlogOf(dbPath: string): Promise<number> {
  const db = (await getDb(dbPath)).unwrap() as Database.Database;
  const row = db
    .prepare<[], { c: number }>(
      `SELECT COUNT(*) AS c FROM node n
       WHERE n.kind='episode' AND n.t_invalid IS NULL AND n.content IS NOT NULL AND n.content != ''
         AND NOT EXISTS (SELECT 1 FROM vec_node v WHERE v.node_id = n.rowid)`,
    )
    .get()!;
  return row.c;
}

beforeEach(() => {
  delete process.env['SOX_SYNC_EMBED']; // exercise the async default pipeline
  _setEmbedProviderForTest(new DeterministicTestProvider());
});

afterEach(async () => {
  await flushPendingEmbeds();
  WriteQueue.clearInstances();
  _setEmbedProviderForTest(new DeterministicTestProvider());
  process.env['SOX_SYNC_EMBED'] = '1'; // restore the suite-wide pin used by other spec files
  for (const c of cleanups.splice(0)) c();
});

describe('RED — unguarded runPeriodicEnrichPass() reproduces the stampede', () => {
  it('two concurrent unguarded passes embed the SAME still-unhealed orphan TWICE', async () => {
    const dbPath = tmpStorePath();

    // insertOrphanEpisode calls getDb() first, which materialises the sqlite
    // file on disk — memory_ping only registers openedPaths when the
    // resolved path already exists (fs.existsSync guard), so the orphan must
    // be inserted BEFORE the ping.
    await insertOrphanEpisode(dbPath, 'red case: one orphan racing two overlapping ticks', new Date().toISOString());
    expect(await backlogOf(dbPath)).toBe(1);

    // Register the store path in openedPaths — memory_ping does this, mirroring
    // the real server (the periodic tick only iterates openedPaths).
    await handleToolCall('memory_ping', { db_path: dbPath });

    const gated = new GatedCountingProvider();
    _setEmbedProviderForTest(gated);

    // Fire tick #1 (unguarded) — it enters healMissingVectors, SELECTs the
    // orphan, and blocks INSIDE embedSingle on the gate.
    const tick1 = runPeriodicEnrichPass();

    // Wait for tick #1 to actually reach the (gated) embed call before firing
    // tick #2 — deterministic on gated.calls, not a fixed number of ticks.
    await waitFor(() => gated.calls >= 1, 'tick1 reaches embedSingle');
    expect(gated.calls).toBe(1); // tick #1 is now blocked inside its embed call

    // Fire tick #2 (unguarded, exactly what the un-fixed setInterval would do
    // when a pass overruns the 5-minute period) — its independent SELECT scan
    // ALSO sees the orphan as still missing (tick #1 hasn't applied yet) and
    // it too calls embedSingle for the SAME row.
    const tick2 = runPeriodicEnrichPass();
    await waitFor(() => gated.calls >= 2, 'tick2 reaches embedSingle');
    expect(gated.calls).toBe(2); // THE BUG: duplicate embed work for one row

    gated.release();
    await Promise.all([tick1, tick2]);
    await flushPendingEmbeds();

    // The row is healed exactly once in the database (applyEmbedding's
    // exists-check is the correct last line of defense) — but the wasted
    // duplicate embed computation already happened, which is the resource
    // stampede the fix eliminates.
    expect(await backlogOf(dbPath)).toBe(0);
    expect(gated.calls).toBe(2);
  });
});

describe('GREEN — runPeriodicEnrichPassGuarded() eliminates the stampede', () => {
  it('two concurrent guarded calls embed the orphan exactly ONCE; the second is skipped, not silently discarded', async () => {
    const dbPath = tmpStorePath();
    await insertOrphanEpisode(dbPath, 'green case: one orphan, two overlapping guarded ticks', new Date().toISOString());
    expect(await backlogOf(dbPath)).toBe(1);
    await handleToolCall('memory_ping', { db_path: dbPath });

    const gated = new GatedCountingProvider();
    _setEmbedProviderForTest(gated);

    const skipsBefore = getEnrichPassSkipCount();
    expect(isEnrichPassInFlight()).toBe(false);

    // Tick #1 (guarded) — enters, sets the in-flight flag, blocks in embed.
    const tick1 = runPeriodicEnrichPassGuarded();
    await waitFor(() => gated.calls >= 1, 'guarded tick1 reaches embedSingle');
    expect(gated.calls).toBe(1);
    expect(isEnrichPassInFlight()).toBe(true);

    // Tick #2 (guarded) fires while #1 is still in flight — exactly the
    // overlapping-timer scenario, but now the guard turns it away BEFORE it
    // ever touches the database or the embed provider.
    const tick2 = runPeriodicEnrichPassGuarded();
    await tick2; // guarded no-op resolves immediately — never blocks on the gate
    expect(gated.calls).toBe(1); // THE FIX: no duplicate embed call
    expect(getEnrichPassSkipCount()).toBe(skipsBefore + 1); // visible, not silent

    // Release tick #1 to completion.
    gated.release();
    await tick1;
    await flushPendingEmbeds();

    expect(isEnrichPassInFlight()).toBe(false);
    expect(await backlogOf(dbPath)).toBe(0);
    expect(gated.calls).toBe(1); // confirmed: exactly one embed for one row
  });

  it('sequential (non-overlapping) guarded ticks each make forward progress — no manual trigger needed', async () => {
    const dbPath = tmpStorePath();
    await insertOrphanEpisode(dbPath, 'forward progress orphan A', new Date().toISOString());
    await insertOrphanEpisode(dbPath, 'forward progress orphan B', new Date().toISOString());
    expect(await backlogOf(dbPath)).toBe(2);
    await handleToolCall('memory_ping', { db_path: dbPath });

    _setEmbedProviderForTest(new DeterministicTestProvider());

    // Tick #1 heals whatever it can (both, at this small scale) without any
    // external nudge — simulating the timer firing on its own schedule.
    await runPeriodicEnrichPassGuarded();
    await flushPendingEmbeds();
    expect(await backlogOf(dbPath)).toBe(0);

    // A later tick over an already-drained backlog is a safe no-op — it must
    // NOT re-embed already-healed rows (the NOT EXISTS predicate excludes them).
    const gated = new GatedCountingProvider();
    _setEmbedProviderForTest(gated);
    gated.release();
    await runPeriodicEnrichPassGuarded();
    expect(gated.calls).toBe(0);
  });
});
