/**
 * compaction.spec.ts — HF-4 / BL-133: scheduled compaction/ANALYZE tick.
 *
 * Coverage:
 *   1. runCompactionPass runs optimize + ANALYZE and checkpoints when no recent WQ checkpoint.
 *   2. runCompactionPass skips WAL checkpoint when WriteQueue ran one very recently.
 *   3. runCompactionPass captures errors and returns them in the result (never throws).
 *   4. startCompactionTick fires at the configured interval and can be stopped.
 *   5. Tick fires → runCompactionPass result is emitted via log.
 *
 * Negative control (NC):
 *   - The compaction tick runs against a real in-process DB (no mocks) so its SQL
 *     statements are actually exercised. Disabling ANALYZE by patching the module
 *     would prevent the maintenance from running — verified by the error-capture test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
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

beforeEach(() => {
  _resetEmbedSingleton();
  WriteQueue.clearInstances();
});

afterEach(() => {
  _resetEmbedSingleton();
  WriteQueue.clearInstances();
  for (const d of tmpDirs) removeTempDir(d);
  tmpDirs = [];
  vi.useRealTimers();
});

function freshDb(): { db: Database.Database; dbPath: string } {
  const dir = makeTempDir();
  tmpDirs.push(dir);
  const dbPath = path.join(dir, 'test.db');
  const db = openDb(dbPath);
  return { db, dbPath };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runCompactionPass', () => {
  it('runs optimize + ANALYZE and checkpoints when no recent WriteQueue checkpoint', () => {
    const { db, dbPath } = freshDb();
    // Ensure no WriteQueue instance exists (so lastCheckpointAtForPath returns 0).
    expect(WriteQueue.lastCheckpointAtForPath(dbPath)).toBe(0);

    const logs: string[] = [];
    const result = runCompactionPass(db, {
      runOptimize: true,
      log: (...args) => logs.push(args.join(' ')),
    });

    expect(result.error).toBeNull();
    expect(result.optimized).toBe(true);
    expect(result.analyzed).toBe(true);
    expect(result.checkpointed).toBe(true);
    expect(result.framesCheckpointed).toBeGreaterThanOrEqual(0);
    expect(result.runAt).toMatch(/^\d{4}-/); // ISO timestamp

    db.close();
  });

  it('skips WAL checkpoint when WriteQueue checkpointed very recently', () => {
    const { db, dbPath } = freshDb();

    // Simulate a very recent WriteQueue checkpoint by creating a queue instance
    // and forcing a checkpoint on it.
    const wq = WriteQueue.forPath(dbPath);
    wq.walCheckpoint(); // This updates lastCheckpointAt.

    // lastCheckpointAt should be very recent (within CHECKPOINT_IDLE_MS).
    expect(WriteQueue.lastCheckpointAtForPath(dbPath)).toBeGreaterThan(0);

    const logs: string[] = [];
    const result = runCompactionPass(db, {
      log: (...args) => logs.push(args.join(' ')),
    });

    expect(result.error).toBeNull();
    expect(result.analyzed).toBe(true);
    // checkpoint was skipped because WriteQueue ran one recently
    expect(result.checkpointed).toBe(false);
    expect(result.framesCheckpointed).toBe(-1);
    expect(logs.some((l) => l.includes('skipped'))).toBe(true);

    db.close();
  });

  it('runs checkpoint when WriteQueue checkpoint was long ago (beyond idle window)', () => {
    const { db, dbPath } = freshDb();

    // Create a WQ, do a checkpoint, but backdate its lastCheckpointAt so the
    // compaction tick treats it as stale.
    const wq = WriteQueue.forPath(dbPath);
    wq.walCheckpoint();
    // Monkey-patch _lastCheckpointAt to be old (beyond CHECKPOINT_IDLE_MS).
    // We use a casting trick since the field is private.
    (wq as unknown as { _lastCheckpointAt: number })._lastCheckpointAt =
      Date.now() - WriteQueue.CHECKPOINT_IDLE_MS - 1000;

    const result = runCompactionPass(db, {});
    expect(result.error).toBeNull();
    expect(result.checkpointed).toBe(true);

    db.close();
  });

  it('sets optimized=false when runOptimize=false', () => {
    const { db } = freshDb();
    const result = runCompactionPass(db, { runOptimize: false });
    expect(result.optimized).toBe(false);
    expect(result.analyzed).toBe(true);
    expect(result.error).toBeNull();
    db.close();
  });

  it('captures errors in result and never throws', () => {
    // Pass a closed DB to trigger a "database is closed" error from SQLite.
    const { db } = freshDb();
    db.close();

    // Should not throw — error is captured in result.error.
    const result = runCompactionPass(db, {});
    expect(result.error).not.toBeNull();
    expect(typeof result.error).toBe('string');
    expect(result.error!.length).toBeGreaterThan(0);
  });
});

describe('startCompactionTick', () => {
  it('returns a stop function that cancels the tick', () => {
    vi.useFakeTimers();
    const { db } = freshDb();
    const logs: string[] = [];
    const intervalMs = 1000;

    const stop = startCompactionTick(db, { intervalMs, log: (...args) => logs.push(args.join(' ')) });
    expect(typeof stop).toBe('function');

    // No tick yet (fake timers; interval not elapsed).
    expect(logs.some((l) => l.includes('ANALYZE'))).toBe(false);

    // Advance time — one tick fires.
    vi.advanceTimersByTime(intervalMs + 10);
    // The tick runs synchronously in fake timer mode.
    expect(logs.some((l) => l.includes('ANALYZE') || l.includes('optimize') || l.includes('checkpoint'))).toBe(true);

    // Stop; advance again — no new ticks.
    stop();
    const logsAfterStop = logs.length;
    vi.advanceTimersByTime(intervalMs * 3);
    expect(logs.length).toBe(logsAfterStop);

    db.close();
  });

  it('exports DEFAULT_COMPACTION_INTERVAL_MS as 5 minutes', () => {
    expect(DEFAULT_COMPACTION_INTERVAL_MS).toBe(5 * 60 * 1000);
  });
});
