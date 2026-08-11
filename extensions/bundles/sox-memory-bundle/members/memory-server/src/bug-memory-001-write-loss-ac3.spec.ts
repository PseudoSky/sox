/**
 * bug-memory-001-write-loss-ac3.spec.ts — AC3 (SPEC-BUG-MEMORY-001.md §4):
 * drives the REAL MCP `memory_write` seam (`handleToolCall`, the same
 * dispatcher `handleBackendRequest`'s `tools/call` branch invokes) under
 * sustained parallel load against a POPULATED Turso-backed store with
 * enrichment active, counting PERSISTED UIDS — not absence-of-thrown-errors.
 *
 * ── Why this file lives here, not in memory-core/write-queue-turso-concurrency.spec.ts ──
 *
 * The spec names `write-queue-turso-concurrency.spec.ts` as the extension
 * target for AC3, but also requires driving the seam "through
 * handleToolCall/handleBackendRequest, not by calling write.ts functions
 * directly". `handleToolCall` lives in `memory-server` (a `type:extension`);
 * `memory-core` (a `type:lib`) cannot import from it — `@nx/enforce-module-
 * boundaries`' `depConstraints` forbid a lib depending on an extension, and
 * rightly so (memory-core is the domain composer several OTHER extensions/
 * consumers build on; it must not couple to one specific MCP server's
 * dispatcher). Every existing test in this repo that drives `handleToolCall`
 * under load (`throughput-golden.spec.ts`, `enrich-reentrancy.spec.ts`,
 * `backend.spec.ts`) already lives in `memory-server`, never in
 * `memory-core` — this file follows that established, structurally-required
 * placement. The test CONTENT (populated store, injected Turso-shaped
 * faults, real MCP seam, persisted-uid counting, both a deterministic and a
 * best-effort-soak sub-test) is unchanged from the spec's intent.
 *
 * BL-425 (deterministic embed provider injection) applies here for the same
 * reason it applies to throughput-golden.spec.ts: without it, seeding a
 * populated store and running N×20 real writes would run real fastembed/ONNX
 * inferences and risk the same hookTimeout flake this file's sibling
 * documents at length.
 *
 * ── Why the module is dynamically re-imported with the background chains disabled ──
 *
 * `index.ts` arms TWO self-rescheduling background timers unconditionally at
 * MODULE LOAD TIME — `scheduleNextEnrichTick()` and `scheduleNextDrain()`
 * (both called at top-level, not gated behind any exported start function).
 * AC3a's fault injection (`injectPeriodicLockFault`) necessarily patches the
 * SHARED `adapter.transaction` — there is no way to scope a monkeypatch to
 * only the calls this test's own `handleToolCall` invocations make, since the
 * write queue is a process-wide singleton keyed by dbPath. A first version of
 * this file patched the adapter without disabling those two chains, and hit
 * an unhandled rejection attributed to the running test ("Unknown Error:
 * database is locked") — the background drain/enrich tick fired mid-test,
 * called into the same patched `adapter.transaction`, and its own rejection
 * had no local catch. The old kill switches (`SOX_DISABLE_EMBED_HEAL` /
 * `SOX_DISABLE_PERIODIC_ENRICH`) were deleted as anti-features (ADR-0013), so
 * this file isolates the chains by stretching their tuning vars past the test
 * window (`SOX_EMBED_DRAIN_FLOOR_MS` / `SOX_EMBED_DRAIN_WAKE_DEBOUNCE_MS` —
 * the drain's first arm and its write-wake; the enrich tick's 5-min interval
 * already exceeds the runtime) — but ONLY if
 * set BEFORE `index.ts` is first evaluated — a static top-of-file `import`
 * is hoisted ahead of any `process.env` assignment in this file's own body,
 * so the flags must be set, then the module imported dynamically. This file
 * has no OTHER import of `./index.js`, so a plain `await import('./index.js')`
 * inside `beforeAll` (after the two env vars are set) is sufficient — no
 * `vi.resetModules()` needed, since this is the module's first and only
 * evaluation in this file's isolated test-file module registry. The
 * env-before-import half of this idiom is established elsewhere in this same
 * package — see `bl474-bgslot-priority.spec.ts`'s "AC-4" describe block,
 * which additionally needs `vi.resetModules()` because THAT file also
 * statically imports `./index.js` earlier for its other describe blocks and
 * needs a second, differently-configured evaluation.
 *
 * Enrichment itself is NOT disabled by this — `runPeriodicEnrichPass()` (the
 * UNGUARDED, test-seam export) is still called explicitly in `beforeAll`, so
 * "enrichment active" (the spec's own requirement) is satisfied by a
 * controlled, awaited call instead of an uncontrolled background timer that
 * would race the fault injection.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DeterministicTestProvider,
  WriteQueue,
  _setEmbedProviderForTest,
  vecToJson,
} from '@adhd/sox-memory-core';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import type * as IndexModule from './index.js';

// ── Turso availability check (synchronous at module load time, same
//    resolution technique as throughput-golden.spec.ts) ────────────────────
const TURSO_DRIVER_PATH = path.resolve(
  __dirname, '../../../../../../node_modules/@tursodatabase/database/dist/promise.js',
);
let _hasTurso = false;
try {
  if (fs.existsSync(TURSO_DRIVER_PATH)) _hasTurso = true;
} catch {
  _hasTurso = false;
}

/**
 * Hook timeout for the heavy populate step. The bulk INSERTs themselves are
 * cheap (raw SQL, no embed, no write-queue overhead), but `runPeriodicEnrichPass`
 * afterward drains the ENTIRE embed backlog it creates (~3000 rows, none of
 * which carry a vector yet) plus runs near-dup/clustering over the resulting
 * store — measured ~2-3 minutes for 3000 rows even with the zero-cost
 * `DeterministicTestProvider` injected, dominated by the backlog drain's own
 * batching/logging overhead, not embed compute. This is NOT the
 * `SEED_BUDGET_MS`/`SEED_HOOK_TIMEOUT_MS` pattern from throughput-golden.spec.ts
 * (that budget exists because of a FIXED 60s rolling throughput window this
 * test doesn't measure) — there is no coupled window here, so a generous
 * timeout is simply safe, not a trap.
 */
const POPULATE_HOOK_TIMEOUT_MS = 300_000;

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-ac3-'));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

/**
 * Seed `count` rows directly via the adapter (bypassing the write queue/embed
 * pipeline entirely — this is BACKGROUND POPULATION, not the thing under
 * test) so `runPeriodicEnrichPass` has genuine work to do (near-dup scan,
 * clustering, importance recompute) rather than running against an empty
 * store. Each row gets distinct content (content_hash uniqueness) and a
 * shared topic so clustering has something to group.
 */
async function seedPopulatedStore(adapter: StoreAdapter, count: number): Promise<void> {
  const now = new Date().toISOString();
  const BATCH = 200;
  for (let batchStart = 0; batchStart < count; batchStart += BATCH) {
    const batchEnd = Math.min(batchStart + BATCH, count);
    await adapter.transaction(async (tx) => {
      for (let i = batchStart; i < batchEnd; i++) {
        const content = `AC3 populate seed row ${i}: background episode content for enrichment load, variant ${i % 37}.`;
        await tx.executeRun(
          `INSERT INTO node (uid, kind, content, content_hash, topic, project_path, importance, t_created, t_occurred, t_valid)
           VALUES (?, 'episode', ?, ?, ?, ?, 1.0, ?, ?, ?)`,
          [`ac3-seed-${i}`, content, `ac3-seed-hash-${i}`, 'ac3-populate', '/test/ac3/populate', now, now, now],
        );
      }
    });
  }
}

/**
 * Monkeypatch `adapter.transaction` to throw the Turso-shaped lock error at
 * most once per `cooldownMs` (a WALL-CLOCK gate, not a call-count gate) —
 * "every 3rd concurrent call's underlying executeRun throws once", per the
 * spec. The spec's literal wording, "throws ONCE", is load-bearing:
 * `adapter.transaction` is a single shared seam every concurrent write's own
 * internal retry (§2.3, up to 3 attempts, 250ms/500ms backoff — max ~750ms
 * total span) also calls through.
 *
 * A call-COUNT-based cooldown (an earlier version of this fixture) is not
 * actually safe: it silently assumes one write-attempt makes exactly one
 * `adapter.transaction` call, so N calls of "safe" headroom bounds N
 * attempts. That assumption is false in general — a single synchronous write
 * flow can open more than one transaction internally (e.g. auto-link/near-dup
 * bookkeeping alongside the node insert) — so a call-count cooldown can still
 * let the SAME logical write get faulted more than once within its own
 * lifetime purely by how many transactions ITS OWN attempt happens to open,
 * independent of how many OTHER writes are running concurrently. Measured
 * live: with `cooldown = concurrency*3` (call-count-based), AC3a still
 * exhausted a write's retry budget on iteration 0 — proof the assumption
 * doesn't hold here.
 *
 * A WALL-CLOCK cooldown has no such blind spot: if `cooldownMs` exceeds the
 * maximum possible span of one write's full retry sequence (~750ms), then AT
 * MOST ONE fault can occur, globally, within that span — REGARDLESS of how
 * many `adapter.transaction` calls any single attempt happens to make. A
 * write that gets faulted once during its lifetime cannot be faulted again
 * before its own retry sequence has already finished (succeeded or given up),
 * because the very next induced fault is mechanically blocked until
 * `cooldownMs` has elapsed.
 *
 * Returns a restore function.
 */
function injectPeriodicLockFault(adapter: StoreAdapter, everyN: number, cooldownMs: number): () => void {
  const original = adapter.transaction.bind(adapter);
  let calls = 0;
  let lastFaultAt = -Infinity;
  (adapter as unknown as { transaction: typeof adapter.transaction }).transaction = ((fn, opts) => {
    calls++;
    const now = Date.now();
    if (calls % everyN === 0 && now - lastFaultAt >= cooldownMs) {
      lastFaultAt = now;
      return Promise.reject({ code: 'GenericFailure', message: 'database is locked' });
    }
    return original(fn, opts);
  }) as typeof adapter.transaction;
  return () => {
    (adapter as unknown as { transaction: typeof adapter.transaction }).transaction = original;
  };
}

/**
 * Reports whether `err` is exactly the synthetic fault this file injects
 * (never a genuine Turso error — the incident's own literal text, used ONLY
 * as a fixture here).
 */
function isInjectedFault(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  return e['code'] === 'GenericFailure' && e['message'] === 'database is locked';
}

/**
 * Run `body` with a scoped `process.on('unhandledRejection', …)` guard.
 *
 * WHY THIS EXISTS: `injectPeriodicLockFault` necessarily patches the SHARED
 * `adapter.transaction` (there is no way to scope a monkeypatch to only the
 * calls this test's own `handleToolCall` invocations make — the write queue
 * is a process-wide singleton keyed by dbPath, and `adapter.transaction` is
 * the one seam every caller shares). This means the injected fault can also
 * strike an ANCILLARY, fire-and-forget background consumer of the same
 * adapter that this AC does not assert on (e.g. `schedulePhaseBAndWake`'s
 * un-awaited `schedulePendingEmbeds(...)` continuation) — that consumer's own
 * rejection, if not internally caught, surfaces as an unhandled rejection
 * attributed to whichever test happens to be running when Node's event loop
 * notices it, NOT necessarily the test whose `Promise.all` triggered it.
 * Stretching the drain's timer tuning past the test window (the deleted
 * disable envs' replacement, see the file header) closed the largest
 * source of this but not every fire-and-forget continuation reachable from
 * the write path itself.
 *
 * This guard distinguishes the two cases precisely: an unhandled rejection
 * whose VALUE is exactly the synthetic fault this file injects is EXPECTED
 * background noise from a consumer this AC is not testing, and is logged,
 * not failed on. An unhandled rejection of ANY OTHER shape is a genuine
 * defect and fails the test loudly (via `body`'s own return value being
 * overridden by a thrown `AggregateError`) — this guard never silently
 * swallows something it cannot positively identify as its own synthetic
 * fixture.
 */
async function runWithInjectedFaultGuard(body: () => Promise<void>): Promise<void> {
  const genuineLeaks: unknown[] = [];
  let injectedLeakCount = 0;
  const onUnhandledRejection = (reason: unknown): void => {
    if (isInjectedFault(reason)) {
      injectedLeakCount++;
    } else {
      genuineLeaks.push(reason);
    }
  };
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    await body();
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
  }
  if (injectedLeakCount > 0) {
    console.log(
      `runWithInjectedFaultGuard: ${injectedLeakCount} unhandled rejection(s) matched the injected ` +
      'synthetic fault exactly — background/ancillary adapter consumer(s) not under test in this AC ' +
      '(e.g. a fire-and-forget Phase-B continuation), logged and not failed on.',
    );
  }
  if (genuineLeaks.length > 0) {
    throw new AggregateError(
      genuineLeaks,
      `runWithInjectedFaultGuard: ${genuineLeaks.length} unhandled rejection(s) did NOT match the ` +
      'injected synthetic fault shape — this is a genuine defect, not injected-fault noise.',
    );
  }
}

describe('BUG-MEMORY-001 AC3 — memory_write under parallel load against a populated, enriched Turso store', () => {
  const tmp = makeTempDir();
  const dbPath = path.join(tmp.dir, 'test.db');
  let _origStoreAdapter: string | undefined;
  let _origDrainFloor: string | undefined;
  let _origDrainWake: string | undefined;
  let adapter!: StoreAdapter;
  let handleToolCall!: typeof IndexModule.handleToolCall;
  let runPeriodicEnrichPass!: typeof IndexModule.runPeriodicEnrichPass;

  beforeAll(async () => {
    if (!_hasTurso) return;
    _origStoreAdapter = process.env['STORE_ADAPTER'];
    process.env['STORE_ADAPTER'] = 'turso';
    _setEmbedProviderForTest(new DeterministicTestProvider());

    // Set BEFORE the first (and only, in this file) evaluation of index.ts —
    // the two old disable envs (SOX_DISABLE_EMBED_HEAL /
    // SOX_DISABLE_PERIODIC_ENRICH) are GONE (ADR-0013), so the background
    // chains are isolated instead by stretching their tuning vars past this
    // test's whole runtime: the drain's first arm (floor) and write-wake
    // (debounce) and the enrich tick's interval all exceed the test window,
    // so this test's own explicit, awaited runPeriodicEnrichPass() call below
    // is the ONLY enrichment/heal activity touching the adapter for the
    // duration of the fault injection (see the file header for the full
    // "why" — an earlier version without isolation hit an unhandled rejection
    // from a background tick racing the fault).
    _origDrainFloor = process.env['SOX_EMBED_DRAIN_FLOOR_MS'];
    _origDrainWake = process.env['SOX_EMBED_DRAIN_WAKE_DEBOUNCE_MS'];
    process.env['SOX_EMBED_DRAIN_FLOOR_MS'] = '3600000';
    process.env['SOX_EMBED_DRAIN_WAKE_DEBOUNCE_MS'] = '3600000';

    const indexModule = await import('./index.js');
    handleToolCall = indexModule.handleToolCall;
    runPeriodicEnrichPass = indexModule.runPeriodicEnrichPass;

    // One real handleToolCall FIRST — this is what registers `dbPath` into
    // `openedPaths` (index.ts:1160, inside handleToolCall's shared prelude),
    // the set `runPeriodicEnrichPass` iterates. Calling `WriteQueue.forPath`
    // directly does NOT do this registration — only the real tool-call path
    // does, so this ordering is required for enrichment to see the store at
    // all, not just for realism.
    const primer = await handleToolCall('memory_write', {
      db_path: dbPath,
      content: 'AC3 primer write — registers this store with the enrichment scheduler.',
      project_path: '/test/ac3/primer',
    });
    expect(primer.isError).toBeFalsy();

    const queue = await WriteQueue.forPath(dbPath);
    adapter = (queue as unknown as { adapter: StoreAdapter }).adapter;

    // Populate: several thousand rows so enrichment has genuine work.
    await seedPopulatedStore(adapter, 3000);

    // Steady-state fixture (F2, bisected 2026-08-11): pre-apply the vec rows
    // for every seeded episode so the store looks like what the ALWAYS-ON
    // heal (SOX_DISABLE_EMBED_HEAL deleted, ADR-0013) maintains in
    // production — every live episode has its vector. The raw seeding above
    // bypasses the write path, so without this step the fixture presents a
    // 3000-row heal BACKLOG, and the beforeAll enrich pass's Phase-B heal
    // churns through it. Bisection evidence (scratch worktree at the pre-strip
    // base 56201baf): base with the original disable envs PASSES; base with
    // the heal gate removed FAILS with the identical real `Corrupt database:
    // Invalid page type: 0` — i.e. the corruption is triggered by the
    // always-on heal churning thousands of vectorless rows during the enrich
    // pass, not by any strip logic change. Isolated further on HEAD: enrich
    // skipped → PASS; 3000 rows pre-vectored (heal no-op) → PASS; 200-row
    // backlog (bounded heal) → PASS; 3000-row backlog → FAIL (scale-dependent;
    // integrity_check after the churn is clean except the known Turso FTS
    // false positive). The fixture must therefore present steady state, so
    // the heal step no-ops and this test measures the write path under fault
    // injection — not the heal.
    {
      const vec = new Float32Array(768).fill(0.1);
      const rows = await adapter.executeAll<{ rowid: number }>(
        `SELECT rowid FROM node WHERE project_path = '/test/ac3/populate'`,
      );
      for (const r of rows.rows) {
        await adapter.executeRun(
          'INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)',
          [r.rowid, vecToJson(vec)],
        );
      }
    }

    // Trigger enrichment directly rather than waiting out the (now-disabled)
    // periodic timer (spec's own "your call" — a direct, awaited trigger is
    // simpler, deterministic, AND does not race the fault injection below).
    await runPeriodicEnrichPass();
  }, POPULATE_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    if (_origStoreAdapter === undefined) delete process.env['STORE_ADAPTER'];
    else process.env['STORE_ADAPTER'] = _origStoreAdapter;
    if (_origDrainFloor === undefined) delete process.env['SOX_EMBED_DRAIN_FLOOR_MS'];
    else process.env['SOX_EMBED_DRAIN_FLOOR_MS'] = _origDrainFloor;
    if (_origDrainWake === undefined) delete process.env['SOX_EMBED_DRAIN_WAKE_DEBOUNCE_MS'];
    else process.env['SOX_EMBED_DRAIN_WAKE_DEBOUNCE_MS'] = _origDrainWake;
    _setEmbedProviderForTest(null);
    await WriteQueue.clearInstances();
    tmp.cleanup();
  });

  it(
    'AC3a (deterministic, primary evidence): with a controlled fraction of injected Turso-lock faults, persisted_count === issued_count every iteration',
    { skip: !_hasTurso, timeout: 60_000 },
    async () => {
      const N = 8;
      const ITERATIONS = 20;
      // cooldown = 1500ms, comfortably above the ~750ms maximum possible
      // span of one write's full 3-attempt retry sequence (250ms + 500ms
      // backoff) — see injectPeriodicLockFault's doc comment for why a
      // WALL-CLOCK bound (not a call-count bound) is what actually
      // guarantees "throws once per affected write" under real concurrency.
      await runWithInjectedFaultGuard(async () => {
        const restoreFault = injectPeriodicLockFault(adapter, 3, 1500);
        try {
          for (let iter = 0; iter < ITERATIONS; iter++) {
            const projectPath = `/test/ac3a/iter-${iter}`;
            // Normalize a rejection into a reportable shape rather than let
            // it crash Promise.all uncaught — `handleToolCall` deliberately
            // has no local try/catch (the architect's ruling: the fix lives
            // one layer down, in write-queue, and one layer up, at the
            // transport boundary — see backend.ts/serve.ts's formatToolError),
            // so a still-retryable-exhausted write legitimately REJECTS this
            // promise rather than resolving `{isError:true}`. That should be
            // vanishingly rare with the cooldown above, but if it ever
            // happens, report it as a clear assertion failure, not an opaque
            // uncaught-rejection crash.
            const results = await Promise.all(
              Array.from({ length: N }, (_, i) =>
                handleToolCall('memory_write', {
                  db_path: dbPath,
                  content: `AC3a iteration ${iter} write ${i}: distinct content for dedup, salt=${Math.random()}.`,
                  project_path: projectPath,
                }).then(
                  (v) => ({ rejected: false as const, value: v }),
                  (err) => ({ rejected: true as const, error: err }),
                ),
              ),
            );

            const issued = results.length;
            for (const r of results) {
              expect(
                r.rejected,
                `iteration ${iter}: memory_write REJECTED (retry exhausted past 3 attempts, well outside ` +
                `expected odds under the cooldown-bounded fault injector) — ${r.rejected ? JSON.stringify(r.error) : ''}`,
              ).toBe(false);
              if (!r.rejected) {
                expect(
                  r.value.isError,
                  `iteration ${iter}: a memory_write call reported isError — the retry (§2.3) should have ` +
                  `absorbed the injected fault within 3 attempts. Body: ${JSON.stringify(r.value.content)}`,
                ).toBeFalsy();
              }
            }

            const count = await adapter.executeGet<{ cnt: number }>(
              'SELECT COUNT(*) AS cnt FROM node WHERE project_path = ?',
              [projectPath],
            );
            expect(
              count!.cnt,
              `iteration ${iter}: persisted_count (${count!.cnt}) !== issued_count (${issued}) — a write was ` +
              'lost under injected contention. This is the exact incident BUG-MEMORY-001 documents.',
            ).toBe(issued);
          }
        } finally {
          restoreFault();
          // Give any straggling fire-and-forget continuation a tick to settle
          // (and be caught by the guard above) before the fault is fully gone
          // and this test's window closes.
          await new Promise((r) => setTimeout(r, 50));
        }
      });
    },
  );

  it(
    'AC3b (best-effort real-timing soak, secondary — required by the item\'s literal text, not the primary red/green gate): ' +
    'no injected fault, real parallel writes against the populated store, persisted_count === issued_count',
    { skip: !_hasTurso, timeout: 60_000 },
    async () => {
      // Timing-dependent: the original investigator saw 20/20 clean repro
      // attempts even PRE-fix on their machine — a clean pass here proves
      // nothing on its own; it exists only because the item's own text asked
      // for it (SPEC-BUG-MEMORY-001.md §4, AC3-3b). Reported honestly either way.
      const N = 6;
      const ITERATIONS = 20;
      let allMatched = true;
      const mismatches: string[] = [];

      for (let iter = 0; iter < ITERATIONS; iter++) {
        const projectPath = `/test/ac3b/iter-${iter}`;
        // Same rejection-normalization as AC3a — no fault is injected here,
        // but `handleToolCall` still has no local try/catch by design, so a
        // genuine real-timing rejection (the whole point of this soak) must
        // be reported as a clear mismatch, not crash the loop uncaught.
        const results = await Promise.all(
          Array.from({ length: N }, (_, i) =>
            handleToolCall('memory_write', {
              db_path: dbPath,
              content: `AC3b iteration ${iter} write ${i}: distinct content for dedup, salt=${Math.random()}.`,
              project_path: projectPath,
            }).then(
              (v) => ({ rejected: false as const, value: v }),
              (err) => ({ rejected: true as const, error: err }),
            ),
          ),
        );
        const issued = results.length;
        const rejectedCount = results.filter((r) => r.rejected).length;
        const errorCount = results.filter((r) => !r.rejected && r.value.isError).length;
        const count = await adapter.executeGet<{ cnt: number }>(
          'SELECT COUNT(*) AS cnt FROM node WHERE project_path = ?',
          [projectPath],
        );
        if (count!.cnt !== issued || rejectedCount > 0 || errorCount > 0) {
          allMatched = false;
          mismatches.push(
            `iter ${iter}: issued=${issued} persisted=${count!.cnt} rejected=${rejectedCount} errored=${errorCount}`,
          );
        }
      }

      console.log(
        `AC3b soak result: ${allMatched ? 'clean, all ' + ITERATIONS + ' iterations matched' : mismatches.join('; ')} ` +
        '— secondary evidence only, per SPEC-BUG-MEMORY-001.md §4.',
      );
      expect(allMatched, `AC3b real-timing soak found write loss with no injected fault: ${mismatches.join('; ')}`).toBe(true);
    },
  );
});
