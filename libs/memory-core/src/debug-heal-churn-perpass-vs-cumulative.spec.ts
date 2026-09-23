/**
 * debug-heal-churn-perpass-vs-cumulative.spec.ts — decisive experiment for
 * BUG-HEAL-CHURN-TRIGGERS-PAGE-CORRUPTION-001.
 *
 * QUESTION: is the "Corrupt database: Invalid page type: 0" trigger bisected
 * by bug-memory-001-write-loss-ac3.spec.ts:317-334 (3000-row heal backlog
 * FAILS, 200-row PASSES) driven by PER-PASS volume (rows scanned/healed in
 * one `healMissingVectors` call) or CUMULATIVE churn (total rows healed
 * across repeated calls, regardless of per-call size)?
 *
 * This file isolates `healMissingVectors` directly — no `runPeriodicEnrichPass`,
 * no clustering, no index.ts background timers — so the only variable across
 * cases is: one call of N vs. many calls summing to N. Everything else (store
 * size, adapter, provider, transaction shape) is held constant.
 *
 * Turso-only (STORE_ADAPTER='turso'): the corruption is a Turso storage-layer
 * defect (`Invalid page type: 0`), never reproduced on the sqlite adapter.
 * Skips cleanly if the Turso native driver is not present in this checkout.
 *
 * 4b2bcce9 (this fix): all three `it()` blocks below computed `corrupted` /
 * `corruptionDetail` from `healMissingVectors()` + an explicit
 * `PRAGMA integrity_check`, wrote them to a hardcoded scratchpad jsonl, and
 * `console.log`'d them — but never called `expect()` on `corrupted`. That is
 * the exact b1500aa3/BL-167 shape: a green run proved nothing, including on a
 * run where the pass reproduced the CRITICAL open corruption bug (ae763675,
 * "Invalid page type: 0") these tests are named for. Each `it()` now ends
 * with `expect(corrupted, ...).toBe(false)`, naming ae763675/4b2bcce9. The
 * hardcoded `RESULTS_LOG` scratchpad path (another agent session's temp dir,
 * not a durable artifact location) is removed — the assertion is now the
 * test's actual outcome, not a side channel nobody reads.
 *
 * 4b2bcce9 red→green also surfaced a SECOND pre-existing defect in
 * `checkIntegrity()` below: this probe's `PRAGMA integrity_check` reliably
 * hits the documented-benign Turso FTS directory-index count mismatch
 * (`wrong # of entries in index __turso_internal_fts_dir_idx_fts_node_key`)
 * on every one of these three tests — a real Turso storage-layer artifact,
 * but NOT the CRITICAL ae763675 corruption ("Invalid page type: 0") these
 * tests exist to catch. See `libs/data/store/store-adapter/src/integrity.ts`'s
 * `classifyIntegrityMessages`/`isKnownFalsePositive`, the shared single
 * source of truth every other integrity caller in this repo already uses for
 * this exact distinction. `checkIntegrity()` now routes through it instead of
 * treating any non-'ok' row as damage — before this fix, asserting `corrupted`
 * at all (this item's own remediation) would have made all three tests
 * permanently, falsely RED on a benign artifact, which is likely WHY the
 * original author never added the assertion in the first place.
 *
 * Gate: npx nx test memory-core --skip-nx-cache
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { healMissingVectors } from './embed-pipeline.js';
import { WriteQueue } from './write-queue.js';
import { _setEmbedProviderForTest } from './embed.js';
import { DeterministicTestProvider } from './embed-test-provider.js';

const TURSO_DRIVER_PATH = path.resolve(
  __dirname, '../../../node_modules/@tursodatabase/database/dist/promise.js',
);
let _hasTurso = false;
try {
  if (fs.existsSync(TURSO_DRIVER_PATH)) _hasTurso = true;
} catch {
  _hasTurso = false;
}

const HOOK_TIMEOUT_MS = 300_000;

interface TestContext {
  dir: string;
  dbPath: string;
  adapter: StoreAdapter;
  wq: WriteQueue;
  cleanup: () => void;
}

let _origStoreAdapter: string | undefined;

async function tmpTursoDb(): Promise<TestContext> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-heal-churn-'));
  const dbPath = path.join(dir, 'test.db');
  process.env['STORE_ADAPTER'] = 'turso';
  const adapter = await openDb(dbPath);
  const wq = await WriteQueue.forPath(dbPath);
  return {
    dir,
    dbPath,
    adapter,
    wq,
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

/** Raw-insert `count` vectorless episodes directly via the adapter — the
 * "full heal backlog" shape (skips the write queue/embed pipeline entirely,
 * same technique as bug-memory-001-write-loss-ac3.spec.ts's seedPopulatedStore). */
async function seedVectorlessBacklog(adapter: StoreAdapter, count: number): Promise<void> {
  const now = new Date().toISOString();
  const BATCH = 200;
  for (let batchStart = 0; batchStart < count; batchStart += BATCH) {
    const batchEnd = Math.min(batchStart + BATCH, count);
    await adapter.transaction(async (tx) => {
      for (let i = batchStart; i < batchEnd; i++) {
        const content = `heal-churn backlog row ${i}: distinct content, variant ${i % 37}.`;
        await tx.executeRun(
          `INSERT INTO node (uid, kind, content, content_hash, topic, project_path, importance, t_created, t_occurred, t_valid)
           VALUES (?, 'episode', ?, ?, ?, ?, 1.0, ?, ?, ?)`,
          [`heal-churn-${batchStart}-${i}`, content, `heal-churn-hash-${i}-${batchStart}`, 'heal-churn', '/test/heal-churn', now, now, now],
        );
      }
    });
  }
}

interface IntegrityVerdict {
  ok: boolean;
  rows: string[];
}

async function checkIntegrity(adapter: StoreAdapter): Promise<IntegrityVerdict> {
  try {
    const result = await adapter.executeAll<Record<string, string>>('PRAGMA integrity_check');
    const rawRows = result.rows.map((r) => Object.values(r)[0] ?? '');
    // Strip the clean-bill-of-health 'ok' banner before classifying — it is
    // not a message and classifyIntegrityMessages does not special-case it
    // (see its own doc comment: callers are expected to strip it upstream).
    const messages = rawRows.filter((r) => r !== 'ok');
    // `@adhd/sox-store-adapter` is lazy-loaded throughout memory-core (see
    // dialect.ts/store-path.ts) — dynamic import here matches that pattern
    // and keeps this test file from tripping the enforce-module-boundaries
    // static-import-of-lazy-library rule.
    const { classifyIntegrityMessages } = await import('@adhd/sox-store-adapter');
    const classified = classifyIntegrityMessages(messages);
    // Only `damage` (real, unclassified rows) counts as corruption for this
    // probe. `knownFalsePositives` (the Turso FTS dir-index count artifact —
    // see file header, 4b2bcce9) and `pageAccounting` (reclaimable-free-space
    // noise) are documented-benign and are NOT ae763675.
    return { ok: classified.damage.length === 0, rows: rawRows };
  } catch (err) {
    // A thrown "Corrupt database: Invalid page type: 0" from the integrity
    // check itself IS the corruption signal — the whole point of this probe.
    return { ok: false, rows: [err instanceof Error ? err.message : String(err)] };
  }
}

describe('BUG-HEAL-CHURN-TRIGGERS-PAGE-CORRUPTION-001 — per-pass vs cumulative heal churn', () => {
  beforeEach(() => {
    _origStoreAdapter = process.env['STORE_ADAPTER'];
    _setEmbedProviderForTest(new DeterministicTestProvider());
  });

  afterEach(async () => {
    if (_origStoreAdapter === undefined) delete process.env['STORE_ADAPTER'];
    else process.env['STORE_ADAPTER'] = _origStoreAdapter;
    _setEmbedProviderForTest(null);
    await WriteQueue.clearInstances();
  });

  it(
    'BASELINE (bounded canary, NOT a reproduction requirement — ae763675 is itself UNREPRODUCED, ' +
    'so a green run here is not proof the bug is absent): single healMissingVectors call over the ' +
    'FULL 3000-row backlog (limit=3000, one pass, one call) must not corrupt the store, must not ' +
    'exceed its time budget, and must heal every row in that single pass',
    { skip: !_hasTurso, timeout: HOOK_TIMEOUT_MS },
    async () => {
      const ctx = await tmpTursoDb();
      try {
        await seedVectorlessBacklog(ctx.adapter, 3000);
        let corrupted = false;
        let corruptionDetail = '';
        let healed = -1;
        let failed = -1;
        let timeBudgetExceeded = true;
        try {
          const result = await healMissingVectors(ctx.adapter, ctx.wq, { limit: 3000, logSink: () => { /* quiet */ } });
          healed = result.healed;
          failed = result.failed;
          timeBudgetExceeded = result.time_budget_exceeded;
          const verdict = await checkIntegrity(ctx.adapter);
          corrupted = !verdict.ok;
          corruptionDetail = verdict.rows.join('; ');
          console.log(
            `BASELINE single-pass-3000: healed=${result.healed} failed=${result.failed} ` +
            `time_budget_exceeded=${result.time_budget_exceeded} integrity_ok=${verdict.ok} detail=${corruptionDetail}`,
          );
        } catch (err) {
          corrupted = true;
          corruptionDetail = err instanceof Error ? err.message : String(err);
          console.log(`BASELINE single-pass-3000: healMissingVectors THREW: ${corruptionDetail}`);
        }
        console.log(`BASELINE RESULT: corrupted=${corrupted} detail=${corruptionDetail}`);
        expect(
          corrupted,
          `BASELINE single-pass-3000 healMissingVectors() left the store failing PRAGMA ` +
          `integrity_check (or threw) — this reproduces the CRITICAL open corruption bug ` +
          `ae763675 ("Invalid page type: 0"). Do not weaken this assertion to force green; ` +
          `escalate ae763675 instead (4b2bcce9). Detail: ${corruptionDetail.slice(0, 500)}`,
        ).toBe(false);
        expect(
          timeBudgetExceeded,
          'BASELINE must complete the full 3000-row backlog inside one pass’s time budget ' +
          '(DEFAULT_EMBED_HEAL_TIME_BUDGET_MS) for the "one pass, one call" premise to hold — a ' +
          'budget-truncated pass is EXPERIMENT A in disguise, not the baseline (4b2bcce9).',
        ).toBe(false);
        expect(failed, 'BASELINE must not fail to heal any row over a clean vectorless backlog (4b2bcce9).').toBe(0);
        expect(healed, 'BASELINE (limit=3000 over a 3000-row backlog) must heal every row in the single pass (4b2bcce9).').toBe(3000);
      } finally {
        ctx.cleanup();
      }
    },
  );

  it(
    'EXPERIMENT A: single pass, limit=500, over a 3000-row backlog (heals 500, leaves 2500 unhealed) ' +
    '— PER-PASS-VOLUME hypothesis probe',
    { skip: !_hasTurso, timeout: HOOK_TIMEOUT_MS },
    async () => {
      const ctx = await tmpTursoDb();
      try {
        await seedVectorlessBacklog(ctx.adapter, 3000);
        let corrupted = false;
        let corruptionDetail = '';
        let healed = -1;
        let failed = -1;
        try {
          const result = await healMissingVectors(ctx.adapter, ctx.wq, { limit: 500, logSink: () => { /* quiet */ } });
          healed = result.healed;
          failed = result.failed;
          const verdict = await checkIntegrity(ctx.adapter);
          corrupted = !verdict.ok;
          corruptionDetail = verdict.rows.join('; ');
          console.log(
            `EXPERIMENT A single-pass-500: healed=${result.healed} failed=${result.failed} ` +
            `integrity_ok=${verdict.ok} detail=${corruptionDetail}`,
          );
        } catch (err) {
          corrupted = true;
          corruptionDetail = err instanceof Error ? err.message : String(err);
          console.log(`EXPERIMENT A single-pass-500: healMissingVectors THREW: ${corruptionDetail}`);
        }
        console.log(`EXPERIMENT A RESULT: corrupted=${corrupted} detail=${corruptionDetail}`);
        expect(
          corrupted,
          `EXPERIMENT A single-pass-500 healMissingVectors() left the store failing PRAGMA ` +
          `integrity_check (or threw) — this reproduces the CRITICAL open corruption bug ` +
          `ae763675 ("Invalid page type: 0"). Do not weaken this assertion to force green; ` +
          `escalate ae763675 instead (4b2bcce9). Detail: ${corruptionDetail.slice(0, 500)}`,
        ).toBe(false);
        expect(failed, 'EXPERIMENT A must not fail to heal any row within its 500-row limit (4b2bcce9).').toBe(0);
        expect(healed, 'EXPERIMENT A (limit=500 over a 3000-row backlog) must heal exactly 500 rows in this single pass (4b2bcce9).').toBe(500);
      } finally {
        ctx.cleanup();
      }
    },
  );

  it(
    'EXPERIMENT B: SIX sequential passes, limit=500 each, over a 3000-row backlog ' +
    '(cumulative total healed = 3000, same as the failing baseline, but spread across 6 discrete ' +
    'awaited calls — the self-rescheduling drain chain shape) — CUMULATIVE-CHURN hypothesis probe',
    { skip: !_hasTurso, timeout: HOOK_TIMEOUT_MS },
    async () => {
      const ctx = await tmpTursoDb();
      try {
        await seedVectorlessBacklog(ctx.adapter, 3000);
        let corrupted = false;
        let corruptionDetail = '';
        let totalHealed = 0;
        let totalFailed = 0;
        const perPassHealed: number[] = [];
        try {
          for (let pass = 0; pass < 6; pass++) {
            const result = await healMissingVectors(ctx.adapter, ctx.wq, { limit: 500, logSink: () => { /* quiet */ } });
            totalHealed += result.healed;
            totalFailed += result.failed;
            perPassHealed.push(result.healed);
            console.log(
              `EXPERIMENT B pass ${pass}: healed=${result.healed} failed=${result.failed} ` +
              `cumulative_healed=${totalHealed}`,
            );
            const midVerdict = await checkIntegrity(ctx.adapter);
            if (!midVerdict.ok) {
              corrupted = true;
              corruptionDetail = `pass ${pass}: ${midVerdict.rows.join('; ')}`;
              console.log(`EXPERIMENT B: corruption detected mid-sequence at pass ${pass}: ${corruptionDetail}`);
              break;
            }
          }
          if (!corrupted) {
            const finalVerdict = await checkIntegrity(ctx.adapter);
            corrupted = !finalVerdict.ok;
            corruptionDetail = finalVerdict.rows.join('; ');
          }
        } catch (err) {
          corrupted = true;
          corruptionDetail = err instanceof Error ? err.message : String(err);
          console.log(`EXPERIMENT B: threw mid-sequence: ${corruptionDetail}`);
        }
        console.log(`EXPERIMENT B RESULT: corrupted=${corrupted} total_healed=${totalHealed} detail=${corruptionDetail}`);
        expect(
          corrupted,
          `EXPERIMENT B sequential-6x500 healMissingVectors() (cumulative_healed=${totalHealed}) ` +
          `left the store failing PRAGMA integrity_check (or threw) — this reproduces the ` +
          `CRITICAL open corruption bug ae763675 ("Invalid page type: 0"). Do not weaken this ` +
          `assertion to force green; escalate ae763675 instead (4b2bcce9). ` +
          `Detail: ${corruptionDetail.slice(0, 500)}`,
        ).toBe(false);
        expect(totalFailed, 'EXPERIMENT B must not fail to heal any row across all 6 passes (4b2bcce9).').toBe(0);
        expect(
          perPassHealed,
          `EXPERIMENT B must complete all 6 passes and heal exactly 500 rows in each — a short pass ` +
          `means the backlog ran out before churn accumulated, invalidating the "cumulative churn = ` +
          `3000, spread across 6 calls" premise this experiment is named for (4b2bcce9).`,
        ).toEqual([500, 500, 500, 500, 500, 500]);
        expect(totalHealed, 'EXPERIMENT B cumulative healed across all 6 passes must equal the full 3000-row backlog (4b2bcce9).').toBe(3000);
      } finally {
        ctx.cleanup();
      }
    },
  );
});
