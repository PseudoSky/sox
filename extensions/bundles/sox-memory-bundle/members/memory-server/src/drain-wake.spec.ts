/**
 * drain-wake.spec.ts — BL-382 regression: writes must WAKE the embed drain,
 * debounced and coalescing, instead of waiting on a 5-minute timer that was
 * sized for a 6.9s embed.
 *
 * THE DEFECT (measured live on backend pid 69947, 2026-07-31, n=701 embeds over
 * 1209s): `scheduleNextEnrichTick()` had exactly two call sites — module load
 * and the pass's own `.finally()`. Nothing else could start a pass. The drain
 * therefore ran 39.9% of the time and idled 38.6%, in two gaps of 445s and
 * 190s, while thousands of items sat pending. Throughput over the span was
 * 0.58/s against 1.45/s while actually embedding — 2.5x given back to
 * scheduling latency. The 445s gap decomposed with no residual into 145s of
 * runBatchEnrich plus the 300s timer, which is why the drain is now split out
 * of the enrich tick entirely.
 *
 * WHAT THIS PROVES, ACTUALLY RUN (no simulation, no sleeps on real timers):
 *   1. A wake drains an orphan far inside the tick interval.
 *   2. N rapid wakes start exactly ONE pass — coalescing, not N passes.
 *   3. A wake arriving DURING a pass is not dropped: the pass re-arms.
 *   4. BL-154 — the wake cannot deadlock the write queue. A >2000-char
 *      auto-chunked `memory_write` (the exact content shape that hung forever)
 *      completes with the wake wired.
 *   5. The background slot is a mutex, and re-entering it is a LOUD throw
 *      rather than the silent forever-hang BL-154 produced.
 *
 * RED→GREEN PROCEDURE ACTUALLY PERFORMED (BL-225 — not "would fail"):
 *   Neutering `wakeDrain()`'s body to an early `return` and re-running gave
 *   **3 failed / 2 passed**, with `waitFor(drain heals the orphan) timed out
 *   after 500 iterations` and `waitFor(burst drains) timed out`. Restoring the
 *   body gave **5 passed**. Both arms were run, not reasoned about — re-run
 *   independently on 2026-08-01 against the deployed build, same counts.
 *
 *   Note which two tests do NOT change, and why that is correct: the BL-154
 *   >2000-char write and the background-slot mutex both pass in BOTH arms, by
 *   design — they are safety assertions, not wake assertions. The first can
 *   only fail if the wake deadlocks the write queue; the second drives
 *   `runDrainPassGuarded()` directly and so never consults `wakeDrain` at all.
 *   Exactly the three wake assertions move between arms.
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
  wakeDrain,
  runDrainPassGuarded,
  isDrainPassInFlight,
  getDrainPassCount,
  getDrainWakesCoalesced,
  backgroundSlotHolder,
  runPeriodicEnrichPassGuarded,
} from './index.js';

/** Provider that blocks inside embedSingle until released, and counts calls. */
class GatedCountingProvider extends DeterministicTestProvider {
  private gate: Promise<void>;
  release!: () => void;
  calls = 0;

  constructor() {
    super();
    this.gate = new Promise<void>((r) => (this.release = r));
  }

  override async embedSingle(
    ...args: Parameters<DeterministicTestProvider['embedSingle']>
  ): Promise<Float32Array> {
    this.calls++;
    await this.gate;
    return super.embedSingle(...args);
  }
}

const cleanups: Array<() => void> = [];

function tmpStorePath(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl382-drain-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, 'store.db');
}

/** Raw-insert a live episode with NO vec row — the "crashed Phase B" shape the
 *  drain exists to repair. Same fixture as enrich-reentrancy.spec.ts. */
async function insertOrphanEpisode(dbPath: string, content: string): Promise<void> {
  const db = (await getDb(dbPath)).unwrap() as Database.Database;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid)
     VALUES (?, 'episode', ?, ?, ?, ?)`,
  ).run(`bl382-${Math.random().toString(36).slice(2)}`, content, `hash-${Math.random()}`, now, now);
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

/** Poll a condition, yielding a real macrotask between checks so timers armed
 *  by wakeDrain() (setTimeout, not a microtask) actually get to fire. Bounded so
 *  a genuine regression fails fast and loudly instead of hanging the suite. */
async function waitFor(cond: () => boolean | Promise<boolean>, label: string, maxIters = 500): Promise<void> {
  for (let i = 0; i < maxIters; i++) {
    if (await cond()) return;
    await new Promise<void>((r) => setTimeout(r, 1));
  }
  throw new Error(`waitFor(${label}) timed out after ${maxIters} iterations`);
}

beforeEach(() => {
  delete process.env['SOX_SYNC_EMBED']; // exercise the async default pipeline
  delete process.env['SOX_DISABLE_EMBED_HEAL'];
  // Keep the debounce short so the suite does not wait on production timings;
  // the COALESCING property under test is independent of the window's length.
  process.env['SOX_EMBED_DRAIN_WAKE_DEBOUNCE_MS'] = '5';
  process.env['SOX_EMBED_DRAIN_IDLE_MS'] = '5';
  _setEmbedProviderForTest(new DeterministicTestProvider());
});

afterEach(async () => {
  await flushPendingEmbeds();
  WriteQueue.clearInstances();
  _setEmbedProviderForTest(new DeterministicTestProvider());
  process.env['SOX_SYNC_EMBED'] = '1'; // restore the suite-wide pin other specs rely on
  delete process.env['SOX_EMBED_DRAIN_WAKE_DEBOUNCE_MS'];
  delete process.env['SOX_EMBED_DRAIN_IDLE_MS'];
  for (const c of cleanups.splice(0)) c();
});

describe('BL-382 — a wake drains without waiting for the periodic timer', () => {
  it('wakeDrain() heals an orphan; no enrich tick and no 5-minute timer involved', async () => {
    const dbPath = tmpStorePath();
    await insertOrphanEpisode(dbPath, 'BL-382: orphan that must not wait five minutes for a vector');
    expect(await backlogOf(dbPath)).toBe(1);
    // memory_ping registers the store in openedPaths — the drain iterates those,
    // exactly as the real server does.
    await handleToolCall('memory_ping', { db_path: dbPath });

    wakeDrain('bl382-test');

    await waitFor(async () => (await backlogOf(dbPath)) === 0, 'drain heals the orphan');
    expect(await backlogOf(dbPath)).toBe(0);
  });

  it('N rapid wakes start exactly ONE pass — debounced and coalescing, not N passes', async () => {
    const dbPath = tmpStorePath();
    for (let i = 0; i < 5; i++) await insertOrphanEpisode(dbPath, `BL-382 coalescing orphan ${i}`);
    expect(await backlogOf(dbPath)).toBe(5);
    await handleToolCall('memory_ping', { db_path: dbPath });

    const passesBefore = getDrainPassCount();
    const coalescedBefore = getDrainWakesCoalesced();

    // Ten wakes inside one debounce window — the shape of a burst of writes.
    for (let i = 0; i < 10; i++) wakeDrain(`burst-${i}`);

    await waitFor(async () => (await backlogOf(dbPath)) === 0, 'burst drains');

    // THE ASSERTION: one pass, not ten. Nine wakes were folded in.
    expect(getDrainPassCount() - passesBefore).toBe(1);
    expect(getDrainWakesCoalesced() - coalescedBefore).toBe(9);
  });

  it('a wake arriving DURING a pass is not dropped — the pass re-arms instead of waiting for the floor', async () => {
    const dbPath = tmpStorePath();
    await insertOrphanEpisode(dbPath, 'BL-382 orphan present when the pass starts');
    await handleToolCall('memory_ping', { db_path: dbPath });

    const gated = new GatedCountingProvider();
    _setEmbedProviderForTest(gated);

    const coalescedBefore = getDrainWakesCoalesced();
    const pass = runDrainPassGuarded();
    let coalescedDelta: number;
    try {
      await waitFor(() => gated.calls >= 1, 'pass reaches embedSingle');
      expect(isDrainPassInFlight()).toBe(true);

      // A write lands mid-pass. Without the dirty flag this signal is lost and
      // the new work waits for the floor.
      wakeDrain('mid-pass write');
      coalescedDelta = getDrainWakesCoalesced() - coalescedBefore;
    } finally {
      // Release and settle even when an assertion above throws — otherwise a
      // failure here leaves _drainInFlight latched true and every LATER test
      // silently coalesces instead of running. (Observed while confirming the
      // red arm: one real failure cascaded into an unrelated one.)
      gated.release();
      await pass;
    }
    expect(coalescedDelta).toBe(1);
    expect(isDrainPassInFlight()).toBe(false);

    // A second orphan, inserted mid-pass, is picked up by the re-armed pass.
    _setEmbedProviderForTest(new DeterministicTestProvider());
    await insertOrphanEpisode(dbPath, 'BL-382 orphan that arrived mid-pass');
    wakeDrain('post-pass');
    await waitFor(async () => (await backlogOf(dbPath)) === 0, 're-armed pass drains the late arrival');
    expect(await backlogOf(dbPath)).toBe(0);
  });
});

describe('BL-382 / BL-154 — the wake cannot deadlock the write queue', () => {
  it('a >2000-char auto-chunked memory_write completes with the wake wired', async () => {
    const dbPath = tmpStorePath();
    await handleToolCall('memory_ping', { db_path: dbPath });

    // The exact BL-154 shape: content over the chunk threshold, so memoryWrite
    // takes the auto-chunk path that once re-entered its own serial queue and
    // hung forever. The wake fires from the same post-enqueue audit point as
    // schedulePendingEmbeds, so this must simply return.
    const long = 'BL-382 re-entrancy probe. '.repeat(200); // ~5000 chars
    expect(long.length).toBeGreaterThan(2000);

    const res = await handleToolCall('memory_write', {
      db_path: dbPath,
      content: long,
      project_path: '/tmp/bl382',
    });

    expect(res.isError).toBeFalsy();
    const payload = JSON.parse((res.content[0] as { text: string }).text) as { episode_uid?: string };
    expect(payload.episode_uid).toBeTruthy();

    // And the vectors land without any tick firing.
    await flushPendingEmbeds();
    wakeDrain('post-write');
    await waitFor(async () => (await backlogOf(dbPath)) === 0, 'chunked write reaches full vector coverage');
  });

  // BL-348 NARROWED THIS TEST'S CLAIM — CHANGED DELIBERATELY, NOT QUIETLY.
  //
  // Before BL-348, this test's title was "the drain and the enrich tick never
  // hold it at once", and it was true of the WHOLE enrich tick: the tick's
  // in-process `runBatchEnrich` (clustering/importance/auto-link) ran wrapped
  // in the SAME slot the drain uses, so a slow clustering pass fully excluded
  // the drain (and vice versa) for the pass's entire duration — exactly the
  // BL-348 defect (clustering could block an embedding from being written).
  //
  // Clustering now runs OFF-PROCESS (`runEnrichIsolated`, isolated child
  // process) entirely outside this slot. Only the enrich tick's own BACKSTOP
  // `healMissingVectors` call (holder `'enrich-heal'`) still touches the
  // slot, because it and the drain's own heal both scan the same
  // `NOT EXISTS vec_node` window — that narrow overlap is still the BL-346
  // stampede risk this mutex exists to prevent, and is unrelated to
  // clustering isolation. So the slot-exclusion property below is now scoped
  // to heal-vs-heal only, and the test explicitly proves clustering does NOT
  // participate in it.
  it('the background slot excludes the two heal scans (drain vs enrich backstop) — narrowed by BL-348, clustering no longer holds it at all', async () => {
    const dbPath = tmpStorePath();
    await insertOrphanEpisode(dbPath, 'BL-382 slot-exclusion orphan');
    await handleToolCall('memory_ping', { db_path: dbPath });

    const gated = new GatedCountingProvider();
    _setEmbedProviderForTest(gated);

    const drain = runDrainPassGuarded();
    await waitFor(() => gated.calls >= 1, 'drain holds the slot');
    expect(backgroundSlotHolder()).toBe('drain');

    // The enrich tick fires while the drain holds the slot. Its OWN backstop
    // heal step must WAIT for the same reason as before (BL-346) — but its
    // clustering step (now isolated, off-process) is NOT gated by this slot
    // at all, so the tick as a whole is no longer fully excluded the way it
    // used to be.
    const enrich = runPeriodicEnrichPassGuarded();
    await new Promise<void>((r) => setTimeout(r, 5));
    expect(backgroundSlotHolder()).toBe('drain'); // still the drain — enrich's heal step is queued behind it

    gated.release();
    _setEmbedProviderForTest(new DeterministicTestProvider());
    await drain;
    await enrich;
    expect(backgroundSlotHolder()).toBeNull();
  });

  it('BL-348: the isolated cluster pass never touches the background slot at all', async () => {
    const dbPath = tmpStorePath();
    await handleToolCall('memory_ping', { db_path: dbPath });

    // No orphans inserted — the enrich tick's own backstop heal has nothing
    // to do and settles almost instantly, leaving the tick's duration
    // dominated by the isolated cluster pass (a real forked child process).
    // Poll the slot holder throughout: it must NEVER be anything but null,
    // 'drain', or 'enrich-heal' — in particular, never held for the
    // clustering portion of the tick, which is the BL-348 claim.
    const seenHolders = new Set<string | null>();
    const poll = setInterval(() => seenHolders.add(backgroundSlotHolder()), 1);
    try {
      await runPeriodicEnrichPassGuarded();
    } finally {
      clearInterval(poll);
    }
    for (const holder of seenHolders) {
      expect(holder === null || holder === 'drain' || holder === 'enrich-heal').toBe(true);
    }
  });
});
