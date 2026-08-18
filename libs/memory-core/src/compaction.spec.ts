/**
 * compaction.spec.ts — HF-4 / BL-133: scheduled compaction/ANALYZE tick.
 *
 * Coverage:
 *   1. runCompactionPass runs optimize + ANALYZE; checkpoint fields always report the
 *      DEBT-004 "not this pass's job any more" sentinel (false/-1).
 *   2. runCompactionPass captures errors and returns them in the result (never throws).
 *   3. startCompactionTick fires at the configured interval and can be stopped.
 *   4. Tick fires → runCompactionPass result is emitted via log.
 *
 * (DEBT-004, 2026-08-17) This suite used to also cover the WriteQueue-vs-
 * compaction double-checkpoint coordination logic (skip-if-WriteQueue-ran-recently).
 * That logic — and the WriteQueue-side idle-checkpoint timer it coordinated with —
 * was deleted (see write-queue.ts's class doc comment and compaction.ts's module doc
 * comment): WAL checkpointing is now owned exclusively by the store adapter's own
 * idle flush, so there is nothing left for this module to coordinate with.
 *
 * Negative control (NC):
 *   - The compaction tick runs against a real in-process DB (no mocks) so its SQL
 *     statements are actually exercised. Disabling ANALYZE by patching the module
 *     would prevent the maintenance from running — verified by the error-capture test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb } from './db.js';
import { WriteQueue } from './write-queue.js';
import { runCompactionPass, startCompactionTick, DEFAULT_COMPACTION_INTERVAL_MS } from './compaction.js';
import { _resetEmbedSingleton } from './embed.js';


// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sox-compaction-test-'));
}

function removeTempDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let tmpDirs: string[] = [];

beforeEach(async () => {
  _resetEmbedSingleton();
  await WriteQueue.clearInstances();
});

afterEach(async () => {
  _resetEmbedSingleton();
  await WriteQueue.clearInstances();
  for (const d of tmpDirs) removeTempDir(d);
  tmpDirs = [];
  vi.useRealTimers();
});

async function freshDb(): Promise<{ db: StoreAdapter; dbPath: string }> {
  const dir = makeTempDir();
  tmpDirs.push(dir);
  const dbPath = path.join(dir, 'test.db');
  const db = await openDb(dbPath);
  return { db, dbPath };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runCompactionPass', () => {
  it('runs optimize + ANALYZE; checkpoint fields report the DEBT-004 sentinel', async () => {
    const { db } = await freshDb();

    const logs: string[] = [];
    const result = await runCompactionPass(db, {
      runOptimize: true,
      log: (...args) => logs.push(args.join(' ')),
    });

    expect(result.error).toBeNull();
    expect(result.optimized).toBe(true);
    expect(result.analyzed).toBe(true);
    // (DEBT-004) This pass no longer checkpoints — the store adapter's
    // own idle flush owns that exclusively now.
    expect(result.checkpointed).toBe(false);
    expect(result.framesCheckpointed).toBe(-1);
    expect(result.runAt).toMatch(/^\d{4}-/); // ISO timestamp
    expect(logs.some((l) => l.toLowerCase().includes('checkpoint'))).toBe(false);

    await db.close();
  });

  it('sets optimized=false when runOptimize=false', async () => {
    const { db } = await freshDb();
    const result = await runCompactionPass(db, { runOptimize: false });
    expect(result.optimized).toBe(false);
    expect(result.analyzed).toBe(true);
    expect(result.error).toBeNull();
    await db.close();
  });

  it('captures errors in result and never throws', async () => {
    // Pass a closed DB to trigger a "database is closed" error from SQLite.
    const { db } = await freshDb();
    await db.close();

    // Should not throw — error is captured in result.error.
    const result = await runCompactionPass(db, {});
    expect(result.error).not.toBeNull();
    expect(typeof result.error).toBe('string');
    expect(result.error!.length).toBeGreaterThan(0);
  });
});

describe('startCompactionTick', () => {
  it('returns a stop function that cancels the tick', async () => {
    vi.useFakeTimers();
    const { db } = await freshDb();
    const logs: string[] = [];
    const intervalMs = 1000;

    const stop = startCompactionTick(db, { intervalMs, log: (...args) => logs.push(args.join(' ')) });
    expect(typeof stop).toBe('function');

    // No tick yet (fake timers; interval not elapsed).
    expect(logs.some((l) => l.includes('ANALYZE'))).toBe(false);

    // Advance time — one tick fires. BL-325: startCompactionTick's setInterval
    // callback fires `runCompactionPass` fire-and-forget, and every StoreAdapter
    // call inside it is now async (Promise-based on both sqlite and turso —
    // see write-pipeline.spec.ts's "fully synchronous" contract discussion).
    // The sync `advanceTimersByTime` fires the interval callback but does not
    // drain the microtasks the async body then queues (PRAGMA optimize, ANALYZE,
    // the log() calls after each await) — use the async variant so those
    // microtasks actually flush before the assertion runs.
    await vi.advanceTimersByTimeAsync(intervalMs + 10);
    expect(logs.some((l) => l.includes('ANALYZE') || l.includes('optimize') || l.includes('checkpoint'))).toBe(true);

    // Stop; advance again — no new ticks.
    stop();
    const logsAfterStop = logs.length;
    await vi.advanceTimersByTimeAsync(intervalMs * 3);
    expect(logs.length).toBe(logsAfterStop);

    await db.close();
  });

  it('exports DEFAULT_COMPACTION_INTERVAL_MS as 5 minutes', () => {
    expect(DEFAULT_COMPACTION_INTERVAL_MS).toBe(5 * 60 * 1000);
  });
});
