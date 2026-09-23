/**
 * debug-heal-churn-repro-check.spec.ts — bounded canary for
 * BUG-HEAL-CHURN-TRIGGERS-PAGE-CORRUPTION-001, cross-linked to ae763675
 * (CRITICAL, OPEN — "Invalid page type: 0", **UNREPRODUCED** — "4 serial configs
 * clean") and b1500aa3 (HIGH, the absent-assertion defect this file was rewritten
 * to fix).
 *
 * ⚠️ THIS IS NOT A REPRODUCTION TEST. ae763675 itself records that the documented
 * 3000-row-backlog corruption did NOT reproduce across 4 serial attempts — there is
 * no row count, seed, or timing window known to trigger it today. A green run here
 * is therefore NOT evidence that ae763675 is fixed, absent, or safe; it only means
 * this particular call did not throw. Do not cite a green run of this file as
 * closing ae763675 — the trigger condition remains unknown.
 *
 * What this file actually is: a bounded canary that exercises the same code path
 * the original bisection used — ONE call to `runPeriodicEnrichPass()` (heal +
 * clustering, the full pass, not the isolated `healMissingVectors` probed in
 * debug-heal-churn-perpass-vs-cumulative.spec.ts) over a vectorless heal backlog —
 * and asserts that the call does not throw. If ae763675 (or any future regression
 * along this path) starts reproducing reliably at this row count, this test goes
 * red and stays red until fixed. Same isolation technique as
 * bug-memory-001-write-loss-ac3.spec.ts: stretch the background drain/enrich
 * timers past the test window, dynamically import index.ts AFTER setting env,
 * call `runPeriodicEnrichPass()` explicitly.
 *
 * **Benign-artifact check (verified, not assumed):** the isolated `healMissingVectors`
 * probe's sibling file hits a known-benign Turso FTS dir-index count artifact
 * (`wrong # of entries in index __turso_internal_fts_dir_idx_fts_node_key`, see
 * libs/data/store/store-adapter/src/preflight.ts:56-90 and
 * store-adapter/src/integrity.ts's `classifyIntegrityMessages`) via an EXPLICIT
 * `PRAGMA integrity_check` it runs itself. This file runs no explicit integrity
 * check and calls `runOpenTimeIntegrity` only once, at `WriteQueue.forPath()` — a
 * single open, before seeding, outside the try/catch this test asserts on. Neither
 * `embed-pipeline.ts` (healMissingVectors) nor `db.ts` reference the FTS-benign
 * classifier at all (grepped, 2026-09-22). So a throw caught below cannot be that
 * benign artifact — it is a genuine exception from the heal/cluster pass.
 *
 * b1500aa3: the original version of this file computed `corrupted` inside the catch
 * around `runPeriodicEnrichPass()`, wrote it to a jsonl, `console.log`'d it — and never
 * asserted it. It passed unconditionally, including in the run where the pass threw
 * the exact corruption this file is named for. That made it a green regression test
 * for a CRITICAL open bug, with no regression coverage at all. Fixed below:
 * `expect(corrupted, ...).toBe(false)` is now the test's outcome, not a side note.
 * The row count is also cut from the original 3000 (a ~711s run whose 300s timeout
 * bound fired ~410s before the promise resolved, itself an unconditional green
 * regardless of the outcome) to the largest count measured to complete comfortably
 * inside a sane bound — see the ROW_COUNT comment below for the measurements taken.
 *
 * Gate: run directly with vitest (`npx vitest run <this file>` from this package, or
 * the project's configured 'default-mock' vitest project) — do not use `npx nx test`
 * while investigating; a stale dist/ artifact is invisible to git and can make this
 * result unattributable (see docs cross-reference in CLAUDE.md, dist-freshness.mjs).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DeterministicTestProvider, WriteQueue, _setEmbedProviderForTest } from '@adhd/sox-memory-core';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import type * as IndexModule from './index.js';

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
 * ROW_COUNT: no row count is known to trigger ae763675 today (it is UNREPRODUCED),
 * so there is no "smallest count that still exercises the path" to aim for — more
 * churn is strictly more chance of catching it if it ever fires. The choice here is
 * therefore the LARGEST row count measured to complete comfortably inside a sane
 * bound, not the smallest. Measured locally (mock embed provider, Turso adapter,
 * this machine, 2026-09-22), wall clock for the full `it()` body:
 *   600 rows  →  25.6s
 *   1000 rows →  56.4s   ← chosen: ~38% of TEST_TIMEOUT_MS, real margin
 *   1500 rows → 161.4s   (superlinear growth — too close to a 180s bound to be safe)
 * The scaling is well above linear (2.5x rows cost 6.3x time between 600 and 1500),
 * so headroom shrinks fast; 1000 was kept as the largest count still comfortably
 * clear of its timeout rather than raised further. Re-measure before changing this
 * constant — do not guess at a new value.
 */
const ROW_COUNT = 1000;
const TEST_TIMEOUT_MS = 150_000;

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-heal-repro-'));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

async function seedVectorlessBacklog(adapter: StoreAdapter, count: number): Promise<void> {
  const now = new Date().toISOString();
  const BATCH = 200;
  for (let batchStart = 0; batchStart < count; batchStart += BATCH) {
    const batchEnd = Math.min(batchStart + BATCH, count);
    await adapter.transaction(async (tx) => {
      for (let i = batchStart; i < batchEnd; i++) {
        const content = `heal-repro backlog row ${i}: distinct content, variant ${i % 37}.`;
        await tx.executeRun(
          `INSERT INTO node (uid, kind, content, content_hash, topic, project_path, importance, t_created, t_occurred, t_valid)
           VALUES (?, 'episode', ?, ?, ?, ?, 1.0, ?, ?, ?)`,
          [`heal-repro-${batchStart}-${i}`, content, `heal-repro-hash-${i}-${batchStart}`, 'heal-repro', '/test/heal-repro', now, now, now],
        );
      }
    });
  }
}

interface CaseResult {
  corrupted: boolean;
  detail: string;
}

async function runOneCase(rowCount: number, label: string): Promise<CaseResult> {
  let _origStoreAdapter: string | undefined;
  let _origDrainFloor: string | undefined;
  let _origDrainWake: string | undefined;
  const tmp = makeTempDir();
  const dbPath = path.join(tmp.dir, 'test.db');
  try {
    _origStoreAdapter = process.env['STORE_ADAPTER'];
    process.env['STORE_ADAPTER'] = 'turso';
    _setEmbedProviderForTest(new DeterministicTestProvider());
    _origDrainFloor = process.env['SOX_EMBED_DRAIN_FLOOR_MS'];
    _origDrainWake = process.env['SOX_EMBED_DRAIN_WAKE_DEBOUNCE_MS'];
    process.env['SOX_EMBED_DRAIN_FLOOR_MS'] = '3600000';
    process.env['SOX_EMBED_DRAIN_WAKE_DEBOUNCE_MS'] = '3600000';

    // Fresh module registry per case so index.ts's background timers are
    // re-armed against this case's own (stretched) env values.
    const indexModule = await import(/* @vite-ignore */ `./index.js?case=${encodeURIComponent(label)}`) as typeof IndexModule;
    const handleToolCall = indexModule.handleToolCall;
    const runPeriodicEnrichPass = indexModule.runPeriodicEnrichPass;

    const primer = await handleToolCall('memory_write', {
      db_path: dbPath,
      content: `heal-repro primer write (${label}) — registers this store with the enrichment scheduler.`,
      project_path: '/test/heal-repro/primer',
    });
    expect(primer.isError, 'warm-up memory_write must succeed before seeding the heal backlog').toBeFalsy();

    const queue = await WriteQueue.forPath(dbPath);
    const adapter = (queue as unknown as { adapter: StoreAdapter }).adapter;

    await seedVectorlessBacklog(adapter, rowCount);

    let corrupted = false;
    let detail = '';
    try {
      await runPeriodicEnrichPass();
      detail = 'runPeriodicEnrichPass completed without throwing';
    } catch (err) {
      corrupted = true;
      detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    }
    console.log(`REPRO ${label} (rows=${rowCount}): corrupted=${corrupted} detail=${detail.slice(0, 300)}`);
    return { corrupted, detail };
  } finally {
    if (_origStoreAdapter === undefined) delete process.env['STORE_ADAPTER'];
    else process.env['STORE_ADAPTER'] = _origStoreAdapter;
    if (_origDrainFloor === undefined) delete process.env['SOX_EMBED_DRAIN_FLOOR_MS'];
    else process.env['SOX_EMBED_DRAIN_FLOOR_MS'] = _origDrainFloor;
    if (_origDrainWake === undefined) delete process.env['SOX_EMBED_DRAIN_WAKE_DEBOUNCE_MS'];
    else process.env['SOX_EMBED_DRAIN_WAKE_DEBOUNCE_MS'] = _origDrainWake;
    _setEmbedProviderForTest(null);
    await WriteQueue.clearInstances();
    tmp.cleanup();
  }
}

describe('BUG-HEAL-CHURN-TRIGGERS-PAGE-CORRUPTION-001 (ae763675) — bounded canary over full runPeriodicEnrichPass [b1500aa3 regression: this test now asserts its own invariant instead of always passing]', () => {
  beforeAll(() => {
    if (!_hasTurso) {
      console.warn('debug-heal-churn-repro-check: Turso native driver not present — skipping (this bug is Turso-storage-layer-specific, never reproduced on the sqlite adapter).');
    }
  });

  it(
    `runPeriodicEnrichPass() must not throw over a ${ROW_COUNT}-row vectorless heal backlog — ae763675/b1500aa3 ` +
    `(a green here is a bounded canary, NOT proof ae763675 is fixed: no trigger row count is known)`,
    { skip: !_hasTurso, timeout: TEST_TIMEOUT_MS },
    async () => {
      const { corrupted, detail } = await runOneCase(ROW_COUNT, `repro-${ROW_COUNT}-single-enrichpass`);
      expect(
        corrupted,
        `runPeriodicEnrichPass() threw during heal/cluster churn over a ${ROW_COUNT}-row vectorless ` +
        `backlog — this reproduces the CRITICAL open corruption bug ae763675 ("Invalid page type: 0"). ` +
        `Do not weaken this assertion to force green; escalate ae763675 instead. Detail: ${detail.slice(0, 500)}`,
      ).toBe(false);
    },
  );
});
