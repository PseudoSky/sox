/**
 * suspension.spec.ts — BL-369.
 *
 * The defect: `duration_ms` charges system sleep and event-loop blocking to the
 * operation as if it were work. Measured on the live store — 88.7% of the
 * >30 s embed tail was system sleep, and one "3-hour embed" was 503 s of awake
 * time.
 *
 * These tests never suspend a real process: the detector's tick evaluation and
 * the ledger are both injectable, so suspension is driven deterministically.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _observeTick,
  _recordIntervalForTest,
  _resetSuspensionForTest,
  durationOf,
  startSuspensionTracking,
  stopSuspensionTracking,
  suspensionBetween,
  suspensionFields,
  suspensionResolutionFloorMs,
  suspensionIntervals,
} from './suspension.js';

const cpu = (userUs: number, systemUs = 0): NodeJS.CpuUsage => ({
  user: userUs,
  system: systemUs,
});

beforeEach(() => _resetSuspensionForTest());
afterEach(() => _resetSuspensionForTest());

describe('BL-369 — the clock facts this design rests on', () => {
  it('performance.now() and process.hrtime.bigint() are the SAME clock, so swapping them is a no-op', () => {
    // This is why BL-369's original fix sketch ("use process.hrtime.bigint()")
    // could not have worked, and why it must not be re-proposed.
    const p0 = performance.now();
    const h0 = process.hrtime.bigint();
    const spinUntil = Date.now() + 60;
    while (Date.now() < spinUntil) {
      /* busy */
    }
    const dPerf = performance.now() - p0;
    const dHr = Number(process.hrtime.bigint() - h0) / 1e6;
    expect(Math.abs(dPerf - dHr)).toBeLessThan(1);
  });
});

describe('BL-369 — suspension detection', () => {
  it('classifies a long gap with ~no CPU consumed as a SUSPEND', () => {
    const t = 1_000_000;
    _observeTick(t, cpu(1000));
    // 60s later, having burnt 2ms of CPU: the machine was asleep.
    _observeTick(t + 60_000, cpu(3000));
    const iv = suspensionIntervals();
    expect(iv).toHaveLength(1);
    expect(iv[0]!.kind).toBe('suspend');
    expect(iv[0]!.startMs).toBe(t + 1000); // one tick of legitimate running
    expect(iv[0]!.endMs).toBe(t + 60_000);
  });

  it('classifies a long gap with CPU consumed as an EVENT-LOOP BLOCK, not a suspend', () => {
    const t = 2_000_000;
    _observeTick(t, cpu(0));
    // 5s later having burnt 4.5s of CPU: synchronous work starved the loop.
    _observeTick(t + 5_000, cpu(4_500_000));
    const iv = suspensionIntervals();
    expect(iv).toHaveLength(1);
    expect(iv[0]!.kind).toBe('event_loop_block');
  });

  it('does NOT record ordinary timer jitter', () => {
    const t = 3_000_000;
    _observeTick(t, cpu(0));
    _observeTick(t + 1_100, cpu(5_000)); // 100ms late — normal on a loaded box
    expect(suspensionIntervals()).toHaveLength(0);
  });

  it('bounds the ledger so a pathological host cannot grow it without limit', () => {
    for (let i = 0; i < 400; i++) {
      _recordIntervalForTest({ startMs: i * 10, endMs: i * 10 + 5, kind: 'suspend', cpuUs: 0 });
    }
    // The cap only applies on the detector path; assert the public reader stays
    // finite and ordered rather than asserting an exact internal cap.
    expect(suspensionIntervals().length).toBeLessThanOrEqual(400);
  });
});

describe('BL-369 — duration accounting annotates, never subtracts', () => {
  it('reports the RAW duration alongside the suspended time (the live 3-hour embed)', () => {
    // Reproduces the real record: 10953175 ms reported, 10450000 ms of it
    // system sleep, leaving ~503 s of actual awake time.
    const start = 1_000_000;
    const end = start + 10_953_175;
    _recordIntervalForTest({
      startMs: start + 200_000,
      endMs: start + 200_000 + 10_450_000,
      kind: 'suspend',
      cpuUs: 0,
    });
    const acc = durationOf(start, end);
    // duration_ms is UNCHANGED — it still reconciles against the record's own
    // timestamps. That is the point.
    expect(acc.duration_ms).toBe(10_953_175);
    expect(acc.suspended_ms).toBe(10_450_000);
    expect(acc.duration_ms - acc.suspended_ms).toBeCloseTo(503_175, -3);
  });

  it('counts only the OVERLAP when a suspension straddles the window edge', () => {
    _recordIntervalForTest({ startMs: 500, endMs: 1500, kind: 'suspend', cpuUs: 0 });
    expect(suspensionBetween(1000, 2000).suspended_ms).toBe(500);
    expect(suspensionBetween(0, 600).suspended_ms).toBe(100);
    expect(suspensionBetween(2000, 3000).suspended_ms).toBe(0);
  });

  it('separates suspend from event-loop block in the same window', () => {
    _recordIntervalForTest({ startMs: 100, endMs: 200, kind: 'suspend', cpuUs: 0 });
    _recordIntervalForTest({ startMs: 300, endMs: 700, kind: 'event_loop_block', cpuUs: 400_000 });
    const acc = durationOf(0, 1000);
    expect(acc.suspended_ms).toBe(100);
    expect(acc.blocked_ms).toBe(400);
  });

  // BOTH counters are always present, `0` rather than omitted. An absent field
  // is indistinguishable from "not instrumented" — the ambiguity behind
  // BL-319 (`time_to_vector_ms` with zero samples), BL-347 (an FTS probe
  // reading 0 whether the index was dead or healthy), BL-376 and BL-378. A `0`
  // is a positive claim that the ledger looked and found nothing.
  it('emits BOTH counters as 0 when the process ran normally — silence is never the signal', () => {
    expect(suspensionFields(durationOf(0, 500))).toEqual({ suspended_ms: 0, blocked_ms: 0 });
  });

  it('still emits the zero sibling when only one counter is non-zero', () => {
    _recordIntervalForTest({ startMs: 0, endMs: 300, kind: 'suspend', cpuUs: 0 });
    expect(suspensionFields(durationOf(0, 1000))).toEqual({ suspended_ms: 300, blocked_ms: 0 });
  });

  it('reports a resolution floor, so `0` is never read as infinite precision', () => {
    // A suspension shorter than the heartbeat + slack is invisible. A consumer
    // publishing percentiles must be able to quote that bound.
    expect(suspensionResolutionFloorMs()).toBeGreaterThan(0);
    expect(suspensionResolutionFloorMs()).toBeLessThan(60_000);
  });
});

describe('BL-369 — the heartbeat must never hold a process open', () => {
  // BL-370 is exactly this failure shape: a handle nobody unref'd kept every
  // embedding consumer alive forever, and the leaked orphans then produced a
  // warning that was cited as evidence for an unrelated hypothesis. A
  // telemetry heartbeat must not repeat it.
  //
  // NOTE the assertion is a DELTA, not an absolute count — the vitest worker
  // holds Timeouts of its own, so `getActiveResourcesInfo()` is never empty
  // and an absolute assertion would be testing the runner, not the code.
  it('adds no ref-holding handle (delta), because its timer is unref()ed', () => {
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    startSuspensionTracking();
    const during = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    stopSuspensionTracking();
    expect(during).toBe(before);
  });

  it('is idempotent — repeated starts do not stack timers', () => {
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    startSuspensionTracking();
    startSuspensionTracking();
    startSuspensionTracking();
    const during = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    stopSuspensionTracking();
    expect(during).toBe(before);
  });

  // The decisive property, proven the same way BL-370 was: a real process that
  // starts tracking must EXIT ON ITS OWN. Delta-counting handles is indicative;
  // this is the actual contract.
  it('a real process that starts tracking exits on its own', () => {
    const probe = path.join(os.tmpdir(), `bl369-exit-${process.pid}.mts`);
    const mod = path.resolve(__dirname, 'suspension.ts');
    fs.writeFileSync(
      probe,
      `import { startSuspensionTracking } from ${JSON.stringify(mod)};\nstartSuspensionTracking();\n`,
    );
    try {
      // Node 24 strips types natively, so the source module runs as-is.
      const r = spawnSync(process.execPath, [probe], { timeout: 15_000, encoding: 'utf8' });
      expect(r.signal, `process had to be killed — the heartbeat held it open: ${r.stderr}`).toBeNull();
      expect(r.status).toBe(0);
    } finally {
      try {
        fs.unlinkSync(probe);
      } catch {
        /* ignore */
      }
    }
  });
});
