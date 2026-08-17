/**
 * bl502-log-manager-date-retention.spec.ts — regression for host-runtime
 * observability defect B (filed as a backlog item, see the commit that
 * introduced this file for the id).
 *
 * BEFORE this fix: `LogManager._pruneOldFiles()` (the enforcement of the
 * documented "Max files per extId prefix: 7" policy in this file's own
 * module doc comment) was called ONLY from `_rotateSizeExceeded()` — the
 * branch that fires when a single day's log file crosses the 50 MB cap.
 * `_rotateDate()` — the branch that fires every time the calendar date
 * changes, which is the ONLY rotation path for any extension whose daily log
 * volume never approaches 50 MB (the common case) — closed the old stream
 * and stopped there, never calling `_pruneOldFiles()`. Date-rolled logs
 * therefore accumulated on disk without limit: `maxFiles` was read and
 * enforced by one rotation path and silently unreachable from the other.
 *
 * This spec drives real date-triggered rotation (via `vi.setSystemTime`,
 * faking ONLY `Date` — real timers/event loop stay live so the genuinely
 * async `fs.createWriteStream` open/write completes for real between
 * iterations, never touching the actual system clock) across more days than
 * `maxFiles` allows and asserts against the real filesystem (`mkdtemp`
 * scratch dir, no touching any real log directory) that:
 *   1. Files older than the retention bound are actually removed.
 *   2. Files within the retention bound survive.
 *   3. The size-triggered pruning path (already correct before this fix)
 *      still works, proving this change is additive, not a behaviour swap.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LogManager } from './log-manager.js';

function listLogFiles(dir: string, extId: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${extId}-`) && f.endsWith('.log'))
    .sort();
}

/** Yield to the real event loop so the async fs.createWriteStream open/write
 *  this iteration just kicked off actually lands on disk before the next
 *  `_rotateDate()`'s synchronous `_pruneOldFiles()` reads the directory. */
function realTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe('BL-502: LogManager enforces maxFiles retention on DATE-triggered rotation, not only size-triggered rotation', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl502-log-manager-'));
    // Fake ONLY Date — real timers/event loop stay live so real async fs I/O
    // (createWriteStream open/write, unaffected by a faked wall clock) still
    // completes normally between awaited iterations below.
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it(
    'date rollover across MORE days than maxFiles allows leaves at most maxFiles ' +
      'files on disk — THE regression: before this fix, every one of these files ' +
      'would still exist because _rotateDate() never pruned',
    async () => {
      const extId = 'bl502-ext';
      const maxFiles = 3;
      const mgr = new LogManager({ logDir: dir, extId, maxFiles });

      const base = new Date('2026-01-01T00:00:00.000Z').getTime();
      const totalDays = 6; // more than maxFiles=3
      const oneDayMs = 24 * 60 * 60 * 1000;

      for (let d = 0; d < totalDays; d++) {
        vi.setSystemTime(base + d * oneDayMs);
        mgr.write(Buffer.from(`day ${d}\n`));
        await realTick();
      }
      mgr.close();
      await realTick();

      // Steady-state bound is `maxFiles + 1`, not exactly `maxFiles`: pruning
      // runs BEFORE the new day's file is opened (mirroring the pre-existing
      // size-rotation path's own ordering — prune, then reopen), so the count
      // check at prune time never sees the file that's about to be created.
      // The property this regression test exists to prove is UNBOUNDED vs.
      // BOUNDED growth — before this fix, all 6 files below would still be on
      // disk (one per day, forever); after it, growth is capped.
      const steadyStateMax = maxFiles + 1;
      const files = listLogFiles(dir, extId);
      expect(files.length).toBeLessThan(totalDays);
      expect(files.length).toBeLessThanOrEqual(steadyStateMax);
      expect(files.length).toBe(steadyStateMax);

      // The survivors are the MOST RECENT `steadyStateMax` days (oldest pruned first).
      const expectedDates: string[] = [];
      for (let d = totalDays - steadyStateMax; d < totalDays; d++) {
        const iso = new Date(base + d * oneDayMs).toISOString().slice(0, 10);
        expectedDates.push(`${extId}-${iso}.log`);
      }
      expect(files).toEqual(expectedDates);
    },
  );

  it('date rollover across FEWER days than maxFiles keeps every file (no over-pruning)', async () => {
    const extId = 'bl502-ext-few';
    const maxFiles = 7;
    const mgr = new LogManager({ logDir: dir, extId, maxFiles });

    const base = new Date('2026-02-01T00:00:00.000Z').getTime();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const totalDays = 3; // fewer than maxFiles=7

    for (let d = 0; d < totalDays; d++) {
      vi.setSystemTime(base + d * oneDayMs);
      mgr.write(Buffer.from(`day ${d}\n`));
      await realTick();
    }
    mgr.close();
    await realTick();

    const files = listLogFiles(dir, extId);
    expect(files.length).toBe(totalDays);
  });

  it('size-triggered pruning (the pre-existing correct path) still enforces maxFiles unchanged', async () => {
    const extId = 'bl502-ext-size';
    const maxFiles = 2;
    const maxSizeBytes = 100;
    const mgr = new LogManager({ logDir: dir, extId, maxSizeBytes, maxFiles });

    // Each write exceeds the 100-byte cap, forcing a size-rotation per write.
    const chunk = Buffer.from('x'.repeat(150) + '\n');
    for (let i = 0; i < 5; i++) {
      mgr.write(chunk);
      await realTick();
    }
    mgr.close();
    await realTick();

    const files = listLogFiles(dir, extId);
    expect(files.length).toBeLessThanOrEqual(maxFiles);
    expect(files.length).toBeGreaterThan(0);
  });
});
