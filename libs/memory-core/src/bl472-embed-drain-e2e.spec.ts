/**
 * bl472-embed-drain-e2e.spec.ts — BL-472: shutdown must drain in-flight
 * Phase-B embeds before closing the adapter, or the just-computed vector is
 * discarded with a literal `E_IO`/"database connection is not open" failure.
 *
 * This is the end-to-end proof of the exact race described in
 * `SPEC-BL-472.md` §1 ("Adapter-close race, step 3") — against REAL
 * components (a real `WriteQueue`, a real SQLite `StoreAdapter`), not mocks.
 * `bl472-shutdown-drain.spec.ts` (memory-server) proves the *sequencing* of
 * `coordinatedShutdown` with mocks; this file proves the underlying data-loss
 * bug the sequencing exists to prevent is actually fixed at the storage
 * layer, using the SAME `Promise.race([flushPendingEmbeds(), timeout])` shape
 * `coordinatedShutdown`'s step 0 uses.
 *
 * RED→GREEN PROCEDURE ACTUALLY PERFORMED (BL-225):
 *   The "RED ARM" test below runs the identical sequence WITHOUT the drain
 *   step — `q.adapter.close()` immediately after scheduling Phase B, before
 *   the embed resolves. This reproduces the literal
 *   "The database connection is not open" error text from the backlog
 *   citation, surfaced through `schedulePendingEmbeds`'s never-throws
 *   failure path (`out.failed === 1`, logged). It is NOT a `.skip`ped
 *   demonstration — it runs on every suite pass so a future regression that
 *   removes the drain (or reintroduces the race elsewhere) re-trips it
 *   immediately. The "GREEN" test proves the SAME race, with the drain step
 *   inserted, lands the row with zero `E_IO`.
 *
 * Gate: npx nx test memory-core -- --run bl472-embed-drain-e2e.spec
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import type { EmbedRole } from '@adhd/sox-embedding-provider';
import { openDb } from './db.js';
import { memoryWritePhaseA } from './write.js';
import type { PhaseAOutcome } from './write.js';
import { schedulePendingEmbeds, flushPendingEmbeds } from './embed-pipeline.js';
import { WriteQueue } from './write-queue.js';
import { vectorDialectFor } from './dialect.js';
import { _setEmbedProviderForTest } from './embed.js';
import { DeterministicTestProvider } from './embed-test-provider.js';

/**
 * Provider whose `embedSingle` blocks on an externally-controlled deferred
 * before resolving — the "shutdown lands mid-embed" fixture. Same
 * subclassing pattern as `FailingProvider` in `embed-pipeline-metrics.spec.ts`.
 */
class SlowProvider extends DeterministicTestProvider {
  private gate: Promise<void>;
  release!: () => void;
  reachedEmbed = false;

  constructor() {
    super();
    this.gate = new Promise<void>((r) => (this.release = r));
  }

  override async embedSingle(text: string, role?: EmbedRole): Promise<Float32Array> {
    this.reachedEmbed = true;
    await this.gate;
    return super.embedSingle(text, role);
  }
}

/** Same bound `backend.ts`'s coordinatedShutdown step 0 uses (BL-472 D1). */
const SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS = 750;

interface TestContext {
  dir: string;
  dbPath: string;
  adapter: StoreAdapter;
  cleanup: () => void;
}

/**
 * Force SqliteAdapter for any openDb call within this test. Mirrors
 * embed-pipeline-metrics.spec.ts / drain-wake.spec.ts's own guard: the live
 * env may be pinned to 'turso' (multiprocess_wal), incompatible with a
 * throwaway /tmp path.
 */
function forceSqliteAdapter(): void {
  process.env.STORE_ADAPTER = 'sqlite';
}

async function tmpDb(): Promise<TestContext> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl472-embed-drain-'));
  const dbPath = path.join(dir, 'm.db');
  const adapter = await openDb(dbPath);
  return {
    dir,
    dbPath,
    adapter,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

async function phaseA(adapter: StoreAdapter, content: string): Promise<PhaseAOutcome> {
  const r = await memoryWritePhaseA(adapter, { content, project_path: '/test/bl472' });
  expect('code' in r).toBe(false);
  return r as PhaseAOutcome;
}

/** Race `flushPendingEmbeds()` against the SAME bound `coordinatedShutdown`'s
 *  step 0 uses. Returns true if the timeout won (drain did not finish in time). */
function raceDrain(): Promise<boolean> {
  return Promise.race([
    flushPendingEmbeds().then(() => false),
    new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(true), SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS);
      if (typeof t.unref === 'function') t.unref();
    }),
  ]);
}

/** Poll a condition on real macrotasks — bounded so a genuine regression
 *  fails fast instead of hanging the suite. */
async function waitFor(cond: () => boolean, label: string, maxIters = 500): Promise<void> {
  for (let i = 0; i < maxIters; i++) {
    if (cond()) return;
    await new Promise<void>((r) => setTimeout(r, 1));
  }
  throw new Error(`waitFor(${label}) timed out after ${maxIters} iterations`);
}

let ctx: TestContext;

beforeEach(async () => {
  forceSqliteAdapter();
  ctx = await tmpDb();
  await WriteQueue.clearInstances();
  WriteQueue.setBypass(false);
  _setEmbedProviderForTest(new DeterministicTestProvider());
});

afterEach(async () => {
  // (BL-472 Risks §5) Never leave a dangling SlowProvider registered — every
  // spec file that runs afterward in the same worker would silently inherit
  // a fake, possibly-hung embed provider. Unconditional, even if the test
  // body threw.
  await flushPendingEmbeds();
  await WriteQueue.clearInstances();
  ctx.cleanup();
  _setEmbedProviderForTest(new DeterministicTestProvider());
});

describe('BL-472 — a genuine in-flight Phase-B embed survives a drained shutdown', () => {
  it('GREEN: draining flushPendingEmbeds() before closing the adapter lands the vec_node row — no E_IO', async () => {
    const wq = await WriteQueue.forPath(ctx.dbPath);
    const slow = new SlowProvider();
    _setEmbedProviderForTest(slow);

    const a = await phaseA(ctx.adapter, 'BL-472 in-flight embed that must survive a drained shutdown');
    const vectorDialect = await vectorDialectFor(ctx.adapter);

    const logs: string[] = [];
    // Fire-and-forget, exactly as schedulePhaseBAndWake does in production —
    // deliberately NOT awaited here.
    void schedulePendingEmbeds(wq, [a.pending!], { logSink: (l) => logs.push(l), vectorDialect });

    // "Shutdown" lands mid-embed: start the SAME bounded race step 0 uses
    // WHILE the deferred is still unresolved.
    await waitFor(() => slow.reachedEmbed, 'schedulePendingEmbeds reaches embedSingle');
    const racePromise = raceDrain();

    // Now resolve the deferred — the embed (and its follow-up wq.enqueue
    // apply) can proceed to completion.
    slow.release();

    const timedOut = await racePromise;
    expect(timedOut).toBe(false); // the drain genuinely waited for the real work, not the timeout

    // No E_IO / closed-connection failure anywhere in the sequence.
    expect(logs.join('\n')).not.toMatch(/E_IO|database connection is not open/i);

    // Mirror closeAllForShutdown()'s own next step: close the WriteQueue's
    // dedicated write connection AFTER the drain has already landed the row.
    await wq.adapter.close();

    // Direct SELECT against vec_node on a connection opened BEFORE the
    // close (ctx.adapter — a separate connection from wq's dedicated one,
    // per WriteQueue._create()'s own doc comment) returns exactly one row.
    const row = await ctx.adapter.executeGet<{ c: number }>(
      'SELECT COUNT(*) AS c FROM vec_node WHERE node_id = ?',
      [a.pending!.rowid],
    );
    expect(row?.c).toBe(1);
  });

  it('RED ARM (no drain, reproduces the bug): closing the adapter immediately after scheduling Phase B — before the embed resolves — throws the literal "database connection is not open" the backlog citation describes', async () => {
    const wq = await WriteQueue.forPath(ctx.dbPath);
    const slow = new SlowProvider();
    _setEmbedProviderForTest(slow);

    const a = await phaseA(ctx.adapter, 'BL-472 in-flight embed with NO drain — reproduces the pre-fix bug');
    const vectorDialect = await vectorDialectFor(ctx.adapter);

    const logs: string[] = [];
    const sched = schedulePendingEmbeds(wq, [a.pending!], { logSink: (l) => logs.push(l), vectorDialect });

    // NO DRAIN: close the adapter immediately, before the embed has even
    // resolved — mirrors the pre-fix `coordinatedShutdown` calling
    // `closeAllForShutdown()`/`closeAllAdapters()` without ever awaiting
    // `flushPendingEmbeds()`.
    await waitFor(() => slow.reachedEmbed, 'schedulePendingEmbeds reaches embedSingle (red arm)');
    await wq.adapter.close();

    // Now let the embed resolve — its follow-up wq.enqueue() apply fires
    // against the now-closed connection.
    slow.release();
    const result = await sched; // never throws (schedulePendingEmbeds's own contract) — per-item failure instead

    expect(result.failed).toBe(1);
    expect(logs.join('\n')).toMatch(/database connection is not open/i);

    // And the row genuinely did NOT land — the exact data loss BL-472 reports.
    const row = await ctx.adapter.executeGet<{ c: number }>(
      'SELECT COUNT(*) AS c FROM vec_node WHERE node_id = ?',
      [a.pending!.rowid],
    );
    expect(row?.c ?? 0).toBe(0);
  });
});
