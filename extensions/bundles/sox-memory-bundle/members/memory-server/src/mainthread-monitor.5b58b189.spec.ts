/**
 * 5b58b189 — a synchronous Turso step freezes memory-server's main thread and
 * nothing in telemetry showed it (diagnosable only via `sample <pid>`).
 *
 * Pins the signals `MainThreadMonitor` adds:
 *   - `mainthread.blocked{duration_ms}` after a real synchronous block;
 *   - `mainthread.lag{p99_ms,max_ms,cpu_pct,rss_bytes,…}` per interval, whose
 *     max reflects the block;
 *   - `mainthread.stalled` written OFF-THREAD to fd 2 while the block is live
 *     (child-process arm — the only way to observe a real fd-2 write);
 *   - `metrics.snapshot` carries `process` CPU/RSS and the `mainthread` section.
 *
 * RED (fix disabled — `tick`/`emitSummary` no-op, watcher source never
 * reports): the blocked/lag/stalled assertions fail.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { log, initTelemetry, snapshotMetrics, _resetTelemetryForTest } from '@adhd/sox-telemetry';
import { MainThreadMonitor, MAINTHREAD_WATCHER_SOURCE } from './mainthread-monitor.js';

function busyWait(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // deliberately synchronous — the shape of a long Turso driver step
  }
}

let monitor: MainThreadMonitor | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await monitor?.stop();
  monitor = null;
});

describe('5b58b189 — main-thread observability', () => {
  it('a 1.5 s synchronous block emits mainthread.blocked, and the interval summary reports it', async () => {
    const warn = vi.spyOn(log, 'warn');
    const info = vi.spyOn(log, 'info');
    monitor = new MainThreadMonitor({ intervalMs: 600_000, blockedThresholdMs: 500, offThreadWatcher: false });
    monitor.start();
    await new Promise((r) => setTimeout(r, 250));
    busyWait(1500);
    await new Promise((r) => setTimeout(r, 300)); // let the drift ticker observe it

    const blocked = warn.mock.calls.filter(([e]) => e === 'mainthread.blocked');
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    expect((blocked[0]![1] as { duration_ms: number }).duration_ms).toBeGreaterThanOrEqual(1000);

    const s = monitor.emitSummary();
    expect(info.mock.calls.some(([e]) => e === 'mainthread.lag')).toBe(true);
    expect(s.max_ms).toBeGreaterThanOrEqual(1000);
    expect(s.blocked_events).toBeGreaterThanOrEqual(1);
    expect(s.longest_block_ms).toBeGreaterThanOrEqual(1000);
    expect(s.rss_bytes).toBeGreaterThan(0);
    expect(s.cpu_pct).toBeGreaterThan(0);
  }, 30_000);

  it('the off-thread watcher reports a LIVE stall on fd 2 (child process, real block)', () => {
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        `
        const { Worker } = require('node:worker_threads');
        const src = ${JSON.stringify(MAINTHREAD_WATCHER_SOURCE)};
        const sab = new SharedArrayBuffer(16); const hb = new Float64Array(sab); hb[0] = Number(process.hrtime.bigint() / 1000000n);
        const w = new Worker(src, { eval: true, workerData: { sab, stallThresholdMs: 300, pid: process.pid } });
        setTimeout(() => {
          const end = Date.now() + 1500; while (Date.now() < end) {}
          process.stdout.write('unblocked-at ' + Date.now() + '\\n');
          hb[1] = 1; w.terminate();
        }, 200);
        `,
      ],
      { encoding: 'utf8', timeout: 20_000 },
    );
    const line = child.stderr.split('\n').find((l) => l.includes('"event":"mainthread.stalled"'));
    expect(line, `stderr was: ${child.stderr}`).toBeDefined();
    const rec = JSON.parse(line!) as { blocked_for_ms: number; ts: string };
    expect(rec.blocked_for_ms).toBeGreaterThanOrEqual(300);
    // Written WHILE blocked: its timestamp precedes the moment the main thread resumed.
    const unblockedAt = Number(/unblocked-at (\d+)/.exec(child.stdout)?.[1]);
    expect(Date.parse(rec.ts)).toBeLessThan(unblockedAt);
  }, 30_000);

  it('metrics.snapshot carries process CPU/RSS and the mainthread section', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '5b58b189-'));
    try {
      initTelemetry({ service: 'ms-5b58b189', role: 'test', logSink: 'file', logDir: dir, snapshotEveryRecords: 0 });
      monitor = new MainThreadMonitor({ intervalMs: 600_000, offThreadWatcher: false });
      monitor.start();
      monitor.emitSummary();
      await snapshotMetrics('pull');
      const files = fs.readdirSync(dir).filter((f) => f.includes('metrics-snapshot'));
      const rec = JSON.parse(fs.readFileSync(path.join(dir, files[0]!), 'utf8').trim().split('\n').pop()!) as {
        process: { rss_bytes: number; cpu_user_ms: number };
        sections: { mainthread: { p99_ms: number; threshold_ms: number } };
      };
      expect(rec.process.rss_bytes).toBeGreaterThan(0);
      expect(typeof rec.process.cpu_user_ms).toBe('number');
      expect(typeof rec.sections.mainthread.p99_ms).toBe('number');
      expect(rec.sections.mainthread.threshold_ms).toBe(1000);
    } finally {
      _resetTelemetryForTest();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
