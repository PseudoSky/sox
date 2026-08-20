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

// vitest's default reporter swallows console.log from passing tests under
// this nx run-commands pipe — write results directly to a file so they
// survive regardless of reporter/stdout buffering behavior.
const RESULTS_LOG = '/private/tmp/claude-502/-Users-nix-dev-ai-sox-ecosystem/c899d6b8-aeb3-43e4-875c-846f92d311a5/scratchpad/heal-churn-results.jsonl';
function recordResult(entry: Record<string, unknown>): void {
  fs.appendFileSync(RESULTS_LOG, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
}

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
    const rows = result.rows.map((r) => Object.values(r)[0] ?? '');
    return { ok: rows.length === 1 && rows[0] === 'ok', rows };
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
    'BASELINE (reproduction check): single healMissingVectors call over the FULL 3000-row backlog ' +
    '(limit=3000, one pass, one call) — must reproduce the documented corruption or this whole ' +
    'investigation is standing on a stale/environment-dependent bisection',
    { skip: !_hasTurso, timeout: HOOK_TIMEOUT_MS },
    async () => {
      const ctx = await tmpTursoDb();
      try {
        await seedVectorlessBacklog(ctx.adapter, 3000);
        let corrupted = false;
        let corruptionDetail = '';
        try {
          const result = await healMissingVectors(ctx.adapter, ctx.wq, { limit: 3000, logSink: () => { /* quiet */ } });
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
        recordResult({ case: 'BASELINE-single-3000', corrupted, detail: corruptionDetail });
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
        try {
          const result = await healMissingVectors(ctx.adapter, ctx.wq, { limit: 500, logSink: () => { /* quiet */ } });
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
        recordResult({ case: 'EXPERIMENT-A-single-500', corrupted, detail: corruptionDetail });
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
        try {
          for (let pass = 0; pass < 6; pass++) {
            const result = await healMissingVectors(ctx.adapter, ctx.wq, { limit: 500, logSink: () => { /* quiet */ } });
            totalHealed += result.healed;
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
        recordResult({ case: 'EXPERIMENT-B-sequential-6x500', corrupted, total_healed: totalHealed, detail: corruptionDetail });
      } finally {
        ctx.cleanup();
      }
    },
  );
});
