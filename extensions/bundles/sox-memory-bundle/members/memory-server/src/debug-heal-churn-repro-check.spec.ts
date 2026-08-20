/**
 * debug-heal-churn-repro-check.spec.ts — BUG-HEAL-CHURN-TRIGGERS-PAGE-CORRUPTION-001
 *
 * Reproduction check for the exact documented failing case at
 * bug-memory-001-write-loss-ac3.spec.ts:317-334: a 3000-row vectorless heal
 * backlog, ONE call to `runPeriodicEnrichPass()` (heal + clustering, the full
 * pass — not the isolated `healMissingVectors` probed in
 * debug-heal-churn-perpass-vs-cumulative.spec.ts). This file exists because
 * that isolated-heal probe did NOT reproduce "Invalid page type: 0" — it only
 * hit the known-benign Turso FTS dir-index count artifact
 * (`wrong # of entries in index __turso_internal_fts_dir_idx_fts_node_key`,
 * see libs/data/store/store-adapter/src/preflight.ts:56-90). Per the
 * dispatcher's own instruction: if the documented failure cannot be
 * reproduced, stop and report immediately — this file is that check, run
 * through the SAME code path (full `runPeriodicEnrichPass`, clustering
 * included) the original bisection actually used.
 *
 * Same isolation technique as bug-memory-001-write-loss-ac3.spec.ts: stretch
 * the background drain/enrich timers past the test window, dynamically
 * import index.ts AFTER setting env, call runPeriodicEnrichPass() explicitly.
 *
 * Gate: npx nx test memory-server --skip-nx-cache
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

const POPULATE_HOOK_TIMEOUT_MS = 300_000;

const RESULTS_LOG = '/private/tmp/claude-502/-Users-nix-dev-ai-sox-ecosystem/c899d6b8-aeb3-43e4-875c-846f92d311a5/scratchpad/heal-churn-repro-results.jsonl';
function recordResult(entry: Record<string, unknown>): void {
  fs.appendFileSync(RESULTS_LOG, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
}

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

async function runOneCase(rowCount: number, label: string): Promise<void> {
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
    expect(primer.isError).toBeFalsy();

    const queue = await WriteQueue.forPath(dbPath);
    const adapter = (queue as unknown as { adapter: StoreAdapter }).adapter;

    await seedVectorlessBacklog(adapter, rowCount);

    let corrupted = false;
    let detail = '';
    try {
      await runPeriodicEnrichPass();
      recordResult({ case: label, row_count: rowCount, corrupted: false, detail: 'runPeriodicEnrichPass completed without throwing' });
    } catch (err) {
      corrupted = true;
      detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
      recordResult({ case: label, row_count: rowCount, corrupted: true, detail });
    }
    console.log(`REPRO ${label} (rows=${rowCount}): corrupted=${corrupted} detail=${detail.slice(0, 300)}`);
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

describe('BUG-HEAL-CHURN-TRIGGERS-PAGE-CORRUPTION-001 — reproduction check via full runPeriodicEnrichPass', () => {
  beforeAll(() => {
    try { fs.mkdirSync(path.dirname(RESULTS_LOG), { recursive: true }); } catch { /* ignore */ }
  });

  afterAll(async () => {
    // no-op; per-case cleanup handled in runOneCase
  });

  it(
    'reproduces (or does not) the documented 3000-row-backlog corruption via ONE runPeriodicEnrichPass() call',
    { skip: !_hasTurso, timeout: POPULATE_HOOK_TIMEOUT_MS },
    async () => {
      await runOneCase(3000, 'repro-3000-single-enrichpass');
    },
  );
});
