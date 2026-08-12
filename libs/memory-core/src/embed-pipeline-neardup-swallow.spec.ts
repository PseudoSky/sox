/**
 * embed-pipeline-neardup-swallow.spec.ts — regression test for the silent
 * near-dup swallow in `applyEmbedding()` (BL-324 follow-on, found by `logging`
 * during the embed-backfill-stampede investigation).
 *
 * THE BUG (fixed 2026-07-30): `applyEmbedding`'s deferred E8 near-dup pass
 * wrapped `detectNearDup()` in a bare, unlogged `catch {}`. Two things made
 * this the perfect blind spot:
 *   1. It runs AFTER the vec_node INSERT has already committed, so
 *      `applyEmbedding` still returns `status: 'applied'` and every
 *      caller-side counter (applies_applied, embeds_completed) reports
 *      success — a failure here was invisible in every metric memory_ping
 *      exposes.
 *   2. It can swallow a real, reproducible concurrency error (concurrent
 *      Turso transactions throwing "cannot start a transaction within a
 *      transaction"), not just the historical "KNN may fail on empty
 *      stores" case the comment described.
 *
 * THIS TEST proves the fix red→green:
 *   RED:   before the fix, a thrown detectNearDup error was swallowed with
 *          zero log output — this test's assertion on the JSONL log file
 *          would find no matching record.
 *   GREEN: after the fix, the same thrown error produces exactly one
 *          `embed_pipeline.neardup.error` WARN record carrying uid, rowid,
 *          and the error message — while `applyEmbedding` still returns
 *          `status: 'applied'` (the vec_node row IS durably present; only
 *          near-dup detection degraded, and that degradation is now visible).
 *
 * Gate: npx nx test memory-core --skip-nx-cache
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { memoryWritePhaseA } from './write.js';
import type { PhaseAOutcome } from './write.js';
import { applyEmbedding } from './embed-pipeline.js';
import { vectorDialectFor } from './dialect.js';
import { _setEmbedProviderForTest, embed } from './embed.js';
import { DeterministicTestProvider } from './embed-test-provider.js';
import {
  currentLogFilePath,
  _resetTelemetryForTest,
  _flushTelemetryForTest,
} from './telemetry.js';

// Force detectNearDup to throw for this file only — the seam that reproduces
// "any error inside the deferred near-dup pass", independent of WHICH real
// condition causes it (empty store, concurrent-transaction collision, etc).
// The bug is in how applyEmbedding handles the failure, not in what causes it.
vi.mock('./neardup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./neardup.js')>();
  return {
    ...actual,
    detectNearDup: vi.fn(async () => {
      throw new Error('injected near-dup KNN failure (regression seam)');
    }),
  };
});

function readLines(filePath: string | null): Record<string, unknown>[] {
  // BL-433: currentLogFilePath() is `string | null` — null means logging is off.
  if (filePath === null || !fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function tmpLogDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-neardup-swallow-log-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

interface TestContext {
  dbDir: string;
  logDir: string;
  dbPath: string;
  adapter: StoreAdapter;
  cleanup: () => void;
}

async function tmpDb(): Promise<TestContext> {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-neardup-swallow-db-'));
  const { dir: logDir, cleanup: logCleanup } = tmpLogDir();
  const dbPath = path.join(dbDir, 'm.db');
  const adapter = await openDb(dbPath);
  return {
    dbDir,
    logDir,
    dbPath,
    adapter,
    cleanup: () => {
      fs.rmSync(dbDir, { recursive: true, force: true });
      logCleanup();
    },
  };
}

let ctx: TestContext;

/** Force SqliteAdapter — matches the sibling embed-pipeline specs' pattern. */
function forceSqliteAdapter(): void {
  process.env.STORE_ADAPTER = 'sqlite';
}

beforeEach(async () => {
  forceSqliteAdapter();
  ctx = await tmpDb();
  process.env['SOX_MEMORY_LOG_DIR'] = ctx.logDir;
  process.env['SOX_MEMORY_LOG_COMPONENT'] = 'neardup-swallow-test';
  delete process.env['SOX_MEMORY_LOG_LEVEL'];
  _resetTelemetryForTest();
  _setEmbedProviderForTest(new DeterministicTestProvider());
});

afterEach(async () => {
  await _flushTelemetryForTest();
  _resetTelemetryForTest();
  delete process.env['SOX_MEMORY_LOG_DIR'];
  delete process.env['SOX_MEMORY_LOG_COMPONENT'];
  ctx.cleanup();
  _setEmbedProviderForTest(new DeterministicTestProvider());
});

describe('applyEmbedding — near-dup failures are no longer a silent swallow', () => {
  it('GREEN: a thrown detectNearDup error produces embed_pipeline.neardup.error with uid/rowid/error, and the apply still succeeds', async () => {
    const r = await memoryWritePhaseA(ctx.adapter, {
      content: 'neardup swallow regression: distinctive zeppelin narwhal content',
      project_path: '/test/project',
    });
    expect('code' in r).toBe(false);
    const pending = (r as PhaseAOutcome).pending!;

    const vec = await embed(pending.text);
    const vectorDialect = await vectorDialectFor(ctx.adapter);
    const result = await ctx.adapter.transaction(async (tx) =>
      applyEmbedding(tx, pending, vec, ctx.adapter.capabilities.nativeVectors, vectorDialect),
    );

    // The near-dup failure must NOT prevent the vector from landing — the
    // apply still succeeds; only near-dup detection degrades.
    expect(result.status).toBe('applied');
    expect(result.near_dup).toBeNull();

    await _flushTelemetryForTest();
    const lines = readLines(currentLogFilePath());
    const errorRecords = lines.filter((l) => l['event'] === 'embed_pipeline.neardup.error');

    // THE FIX: exactly one structured log record for the swallowed error —
    // before the fix this array is empty (the bare `catch {}` produced ZERO
    // log lines; this assertion is what would fail red, pre-fix).
    expect(errorRecords).toHaveLength(1);
    const rec = errorRecords[0]!;
    expect(rec['level']).toBe('warn');
    expect(rec['uid']).toBe(pending.uid);
    expect(rec['rowid']).toBe(pending.rowid);
    expect(typeof rec['error']).toBe('string');
    expect(rec['error']).toContain('injected near-dup KNN failure');
  });
});
