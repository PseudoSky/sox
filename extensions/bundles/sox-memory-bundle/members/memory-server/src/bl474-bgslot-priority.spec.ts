/**
 * bl474-bgslot-priority.spec.ts — BL-474: bound the enrich-heal backstop's
 * wait on `_bgSlot`. The drain chain is always-on (SOX_DISABLE_EMBED_HEAL was
 * an anti-feature and is gone, ADR-0013) — AC-4 asserts it arms unconditionally.
 *
 * Root cause and the full decision record: `SPEC-BL-474.md` (repo root of
 * this worktree). `_bgSlot` (index.ts) was a strict FIFO promise-chain mutex
 * offering only "wait until free" — no try-acquire, no priority. Both the
 * always-on drain chain and the write-triggered enrich tick's own backstop
 * heal step called the SAME idempotent `healMissingVectors` scan; the
 * drain's hold was bounded only by `embedHealTimeBudgetMs()` (240s default),
 * not by its own 30s re-arm floor — measured live at ~12.5s, two orders of
 * magnitude larger than any latency budget an ordinary write's enrichment
 * tick can be given. Because both applies are idempotent (`exists`/`gone`
 * outcomes distinct from `healed`), the exclusion is a duplicate-work guard,
 * not a data-safety guard, so the fix reframes the enrich-heal side as
 * "yield, not wait": `withBackgroundSlotOrSkip` tries once and returns
 * `{ acquired: false }` immediately if the slot is busy, instead of joining
 * the FIFO queue.
 *
 * THIS FILE PROVES (all ACTUALLY RUN, no simulation):
 *   AC-1 (unit): a concurrent `withBackgroundSlotOrSkip('enrich-heal', fn)`
 *     call, made after the drain provably holds the slot, returns
 *     `{ acquired: false }` in single-digit ms regardless of a >=2000ms hold.
 *   AC-2 (integration): `runEnrichPassOnDb` called while the drain holds the
 *     slot returns `heal_skipped: true`, `healed: 0`, and the heal step's
 *     contribution to wall-clock time is bounded (baseline + slack, not an
 *     absolute constant — the isolated cluster child's own duration is
 *     legitimately variable and unrelated to this fix).
 *   AC-4 (companion): the drain chain ALWAYS arms — with the floor shortened,
 *     the first pass fires inside the test window (`getDrainPassCount() > 0`),
 *     because heal is always on; there is no disable gate to stop it.
 *     at least as long as the (shortened, for test speed) drain floor.
 *
 * RED→GREEN PROCEDURE ACTUALLY PERFORMED (BL-225 — not "would fail"):
 *   AC-1: with `withBackgroundSlotOrSkip`'s body temporarily reverted to
 *   forward unconditionally to the blocking `withBackgroundSlot` (i.e. the
 *   pre-fix shape — busy-check removed), the probe blocked for the full
 *   ~2000ms hold instead of returning in single-digit ms: `attempt` read
 *   `{ acquired: true, result: 'ran' }` (not `{ acquired: false }`) and
 *   `probeElapsedMs` measured ~2000ms (not <200ms). Restoring the guard made
 *   both assertions pass. Run independently, both arms actually executed.
 *
 *   AC-2: with `runEnrichPassOnDb`'s heal step temporarily reverted to
 *   `await withBackgroundSlot('enrich-heal', () => healMissingVectors(...))`
 *   (the pre-fix blocking acquire), the concurrent call's `heal_skipped` read
 *   `undefined` (not `true`) and `concurrentMs` measured >= the drain's
 *   ~2000ms hold (not bounded to baseline + 300ms). Restoring the
 *   `withBackgroundSlotOrSkip` wrapper made both pass.
 *
 *   AC-4: the drain chain ALWAYS arms (heal is always on — the
 *   `SOX_DISABLE_EMBED_HEAL` gate is gone, ADR-0013): a freshly-imported
 *   module's `getDrainPassCount()` reads >= 1 within the shortened floor
 *   window, proving there is no disable path left to stop it.
 *   set before import (pre-fix code ignores it entirely for scheduling).
 *   Restoring the gate made the count stay 0 across the same window.
 *
 * Gate: npx nx test memory-server -- --run bl474-bgslot-priority.spec
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  getDb,
  _setEmbedProviderForTest,
  _setEnrichHostForkResolverForTest,
  DeterministicTestProvider,
  flushPendingEmbeds,
  WriteQueue,
} from '@adhd/sox-memory-core';
import {
  handleToolCall,
  runEnrichPassOnDb,
  runDrainPassGuarded,
  backgroundSlotHolder,
  _withBackgroundSlotOrSkipForTest,
} from './index.js';

/** Provider that blocks inside embedSingle until released, and counts calls.
 *  Same shape as drain-wake.spec.ts's GatedCountingProvider — duplicated
 *  here deliberately (one file per BL-id is this suite's own convention;
 *  see bl472-shutdown-drain.spec.ts / bl413-enrich-stall-escalation.spec.ts /
 *  bl328-calibration-observability.spec.ts) rather than sharing a fixture
 *  module across independently-owned BL specs. */
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl474-bgslot-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, 'store.db');
}

/** Write a standalone Node script and point the enrich-isolation fork
 *  resolver at it directly — same pattern as bl348-stage-isolation.spec.ts. */
function fakeHostScript(body: string): { modulePath: string; execArgv: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl474-host-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, 'fake-host.js');
  fs.writeFileSync(p, body);
  return { modulePath: p, execArgv: [] };
}

/** Fake host that reports a trivial successful cluster pass immediately —
 *  keeps AC-2's wall-clock assertions about the HEAL step, not the isolated
 *  cluster child's own (unrelated, legitimately variable) duration. */
const FAST_HOST = `
process.on('message', (msg) => {
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

/** Raw-insert a live episode with NO vec row — the "crashed Phase B" shape
 *  the drain exists to repair. Same fixture as drain-wake.spec.ts /
 *  enrich-reentrancy.spec.ts. */
async function insertOrphanEpisode(dbPath: string, content: string): Promise<void> {
  const db = (await getDb(dbPath)).unwrap() as Database.Database;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid)
     VALUES (?, 'episode', ?, ?, ?, ?)`,
  ).run(`bl474-${Math.random().toString(36).slice(2)}`, content, `hash-${Math.random()}`, now, now);
}

/** Poll a condition, yielding a real macrotask between checks. Bounded so a
 *  genuine regression fails fast and loudly instead of hanging the suite. */
async function waitFor(cond: () => boolean | Promise<boolean>, label: string, maxIters = 500): Promise<void> {
  for (let i = 0; i < maxIters; i++) {
    if (await cond()) return;
    await new Promise<void>((r) => setTimeout(r, 1));
  }
  throw new Error(`waitFor(${label}) timed out after ${maxIters} iterations`);
}

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

describe('BL-474 AC-1 — withBackgroundSlotOrSkip yields instead of waiting', () => {
  it('returns { acquired: false } in under 200ms while the drain provably holds a >=2000ms hold', async () => {
    const dbPath = tmpStorePath();
    await insertOrphanEpisode(dbPath, 'BL-474 AC-1: orphan to give the drain something to hold the slot over');
    await handleToolCall('memory_ping', { db_path: dbPath });

    const gated = new GatedCountingProvider();
    _setEmbedProviderForTest(gated);

    const holdStart = Date.now();
    const drain = runDrainPassGuarded();
    // Race window (D7): wait for the drain to PROVABLY hold the slot before
    // probing — this is the happens-before ordering the spec requires so the
    // single-microtask acquisition race is unobservable by construction.
    await waitFor(() => gated.calls >= 1, 'drain holds the slot');
    expect(backgroundSlotHolder()).toBe('drain');

    // Keep the drain's hold open for >=2000ms total, released on a real
    // timer so the probe below races a genuinely long, independent hold.
    setTimeout(() => gated.release(), 2000);

    const probeStart = Date.now();
    const attempt = await _withBackgroundSlotOrSkipForTest('enrich-heal', async () => 'ran');
    const probeElapsedMs = Date.now() - probeStart;

    // THE CORE CLAIM: try-acquire returns immediately, never joins the FIFO.
    expect(attempt).toEqual({ acquired: false });
    expect(probeElapsedMs).toBeLessThan(200);

    await drain;
    const totalHoldMs = Date.now() - holdStart;
    expect(totalHoldMs).toBeGreaterThanOrEqual(2000); // the hold this probe raced was genuinely long
    _setEmbedProviderForTest(new DeterministicTestProvider());
    expect(backgroundSlotHolder()).toBeNull();
  });

  it('acquires normally and runs fn when the slot is free', async () => {
    expect(backgroundSlotHolder()).toBeNull();
    const attempt = await _withBackgroundSlotOrSkipForTest('enrich-heal', async () => 42);
    expect(attempt).toEqual({ acquired: true, result: 42 });
    expect(backgroundSlotHolder()).toBeNull();
  });
});

describe('BL-474 AC-2 — runEnrichPassOnDb yields its heal step when the drain holds the slot', () => {
  it('reports heal_skipped: true, healed: 0, and stays within baseline + 300ms wall-clock slack', async () => {
    const dbPath = tmpStorePath();
    // Order matters: memory_ping only registers `openedPaths` (which the
    // drain iterates) if the db FILE already exists on disk at ping time
    // (index.ts's `if (resolvedPath && fs.existsSync(resolvedPath))` guard).
    // getDb() below creates the file; ping AFTER it, same ordering
    // drain-wake.spec.ts's fixtures already rely on.
    const adapter = await getDb(dbPath);
    await WriteQueue.forPath(dbPath);
    await handleToolCall('memory_ping', { db_path: dbPath });

    // Fast, deterministic isolated cluster pass — the assertion is about the
    // HEAL step's contribution, not the (legitimately variable) child
    // process's own duration.
    _setEnrichHostForkResolverForTest(() => fakeHostScript(FAST_HOST));

    // Baseline: no concurrent drain, nothing to heal.
    _setEmbedProviderForTest(new DeterministicTestProvider());
    const baselineStart = Date.now();
    const baseline = await runEnrichPassOnDb(adapter, dbPath);
    const baselineMs = Date.now() - baselineStart;
    expect(baseline.heal_skipped).toBe(false);
    expect(baseline.cluster_ok).toBe(true);

    // Now drive the drain to hold the slot for a real, long (>=2000ms) span.
    await insertOrphanEpisode(dbPath, 'BL-474 AC-2: orphan to keep the drain busy on the slot');
    const gated = new GatedCountingProvider();
    _setEmbedProviderForTest(gated);
    const drain = runDrainPassGuarded();
    await waitFor(() => gated.calls >= 1, 'drain holds the slot');
    expect(backgroundSlotHolder()).toBe('drain');
    setTimeout(() => gated.release(), 2000);

    const concurrentStart = Date.now();
    const concurrent = await runEnrichPassOnDb(adapter, dbPath);
    const concurrentMs = Date.now() - concurrentStart;

    // THE CORE CLAIM: the tick does not pay for the drain's hold at all.
    expect(concurrent.heal_skipped).toBe(true);
    expect(concurrent.healed).toBe(0);
    expect(concurrentMs).toBeLessThan(baselineMs + 300);

    await drain; // let the held gate actually resolve (>=2000ms) before teardown
    _setEmbedProviderForTest(new DeterministicTestProvider());
    expect(backgroundSlotHolder()).toBeNull();
  });
});

describe('BL-474 AC-4 — the drain chain ALWAYS arms (heal is always on; SOX_DISABLE_EMBED_HEAL was an anti-feature, ADR-0013)', () => {
  const savedFloor = process.env['SOX_EMBED_DRAIN_FLOOR_MS'];

  afterEach(() => {
    if (savedFloor === undefined) delete process.env['SOX_EMBED_DRAIN_FLOOR_MS'];
    else process.env['SOX_EMBED_DRAIN_FLOOR_MS'] = savedFloor;
    vi.resetModules();
  });

  it('the first drain pass fires within the (shortened) floor window — no disable gate exists', async () => {
    vi.resetModules();
    // Short floor so the first pass lands well inside this test's timeout
    // instead of the real 30s default — the OLD pre-fix race this AC guarded
    // against (a gate-less module arming inside the test window) is now the
    // ASSERTED behavior: the drain arms unconditionally.
    process.env['SOX_EMBED_DRAIN_FLOOR_MS'] = '50';

    const fresh = await import('./index.js');

    // Wait past the floor + slack so the armed timer has fired its first pass.
    await new Promise<void>((r) => setTimeout(r, 300));

    expect(fresh.getDrainPassCount(), 'heal is always on — the first drain pass must have started').toBeGreaterThan(0);
  });
});
