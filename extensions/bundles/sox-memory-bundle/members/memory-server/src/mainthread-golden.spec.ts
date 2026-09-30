/**
 * mainthread-golden.spec.ts — durable-metrics **S5**, BL-225.
 *
 * Backlog item `15628c7a-06a1-44ae-9930-03287a01c5a6` (component memory-server).
 *
 * WHAT THIS GOLDEN CATCHES
 * ────────────────────────
 * The Turso off-thread release (TUR-C/D) deliberately moved the driver onto a
 * worker thread. The regression class that release can introduce — and that NO
 * golden covered — is **bounded main-thread blocking**: the driver is off the
 * loop, but the process can still be wedged by a synchronous main-thread holder
 * (an FTS writer, a `better-sqlite3` `pread`, an accidental O(n²) scan). The
 * `MainThreadMonitor` (5b58b189) measures exactly that and exposes it as the
 * `mainthread` section of every `metrics.snapshot` line — but until S5 nothing
 * asserted those numbers were **durably persisted**, so a change that silently
 * unwired `registerSnapshotSection`, dropped the persistence sink, or lost the
 * snapshot row would have gone unnoticed in telemetry-only sight.
 *
 * This test therefore asserts end-to-end persistence of the main-thread
 * blocking signal:
 *   monitor (injected block) ──▶ registerSnapshotSection('mainthread') ──▶
 *   snapshotMetrics() ──▶ <service>.<role>.metrics-snapshot-<date>.jsonl
 * on disk under a pinned scratch ecosystem home.
 *
 * DETERMINISM — INJECTED TIME, NEVER A WALL-CLOCK SLEEP
 * ────────────────────────────────────────────────────
 * `MainThreadMonitor.tick(nowMs)` and `.emitSummary(nowMs)` already take the
 * clock as an argument, so the block is injected as an exact drift, and the
 * interval window is injected as an exact duration. The ONE remaining wall-clock
 * input is the `perf_hooks.monitorEventLoopDelay` histogram whose `max` becomes
 * `max_ms`; this file replaces ONLY that factory (every other `node:perf_hooks`
 * export is preserved) with a histogram whose `max` reads an injected value.
 * The result is that every asserted number is the value the test injected —
 * `max_ms`, `longest_block_ms`, `blocked_events`, `threshold_ms`,
 * `kill_after_ms` are compared with `toBe` (bit-for-bit, no rounding drift).
 *
 * SANDBOX — acceptance (c)
 * ────────────────────────
 * `SOX_ECOSYSTEM_HOME` is pinned in `beforeAll` to a fresh `fs.mkdtempSync` root
 * (NOT inherited ambiently from the suite's own scratch root, and NOT the
 * operator's `~/.adhd/sox-ecosystem`), restored in `afterAll`, and the temp dir
 * removed there. The artifact is asserted to land under that temp root and the
 * production `<homedir>/.adhd/sox-ecosystem/<service>/` tree is asserted absent.
 *
 * BL-225 RED→GREEN (both captured on this exact tree):
 *   RED — with the section registration neutralised (`monitor.start()` removed,
 *         so `registerSnapshotSection('mainthread', …)` never runs):
 *         `AssertionError: the undisturbed injected window must be persisted:
 *          expected undefined to be defined`
 *   GREEN — registration restored: the three assertions naming the injected
 *         values pass, and the row is read back off disk.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IntervalHistogram } from 'node:perf_hooks';
import { _resetTelemetryForTest, initTelemetry, snapshotMetrics } from '@adhd/sox-telemetry';
import { MainThreadMonitor } from './mainthread-monitor.js';
import { SCRATCH_ROOT_ENV } from './test-support/bl-26291f21-embed-scratch-env.js';

// ── Injected histogram ──────────────────────────────────────────────────────
// `maxNs` is the ONLY mutable input; `max_ms` = round2(maxNs / 1e6). Held in
// `vi.hoisted` state so the hoisted `vi.mock` factory below can read it, and so
// the test can change it between injected windows.
const hist = vi.hoisted(() => ({ maxNs: 0 }));

vi.mock('node:perf_hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:perf_hooks')>();
  // Only `monitorEventLoopDelay` is replaced; performance/timers/etc. stay real.
  const histogram = {
    enable() {},
    disable() {},
    reset() {},
    percentile: () => 0,
    get exceeds() {
      return 0;
    },
    get max() {
      return hist.maxNs;
    },
    get mean() {
      return 0;
    },
    get min() {
      return 0;
    },
    get stddev() {
      return 0;
    },
    [Symbol.dispose]() {},
  } as unknown as IntervalHistogram;
  return { ...actual, monitorEventLoopDelay: () => histogram };
});

// ── Injected constants ──────────────────────────────────────────────────────
const SERVICE = 's5-golden';
const ROLE = 'test';
/** The injected block, in ms — large enough to dominate any real loop jitter. */
const BLOCK_MS = 4321;
/** The undisturbed window's injected histogram max — below the threshold. */
const UNDISTURBED_MS = 37;
const THRESHOLD_MS = 1000;
const KILL_AFTER_MS = 12_345;
/** The drift-ticker period; large so no real tick can fire during the test. */
const TICK_MS = 3_600_000;
const NS_PER_MS = 1e6;
/** Injected wall-clock anchors passed to `emitSummary` (never the real clock). */
const WINDOW0_NOW = 1_700_000_000_000;
const WINDOW1_NOW = WINDOW0_NOW + 60_000;

const REAL_SERVICE_ROOT = path.join(os.homedir(), '.adhd', 'sox-ecosystem', SERVICE);

interface MainThreadSection {
  interval_ms?: number;
  p50_ms?: number;
  p99_ms?: number;
  max_ms?: number;
  mean_ms?: number;
  blocked_events?: number;
  longest_block_ms?: number;
  threshold_ms?: number;
  kill_after_ms?: number;
}

interface SnapshotRow {
  reason?: string;
  snapshot_seq?: number;
  sections?: { mainthread?: MainThreadSection };
}

function utcDate(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function snapshotFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.includes('.metrics-snapshot-'));
}

function readRows(dir: string): SnapshotRow[] {
  return snapshotFiles(dir).flatMap((f) =>
    fs
      .readFileSync(path.join(dir, f), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as SnapshotRow),
  );
}

function sectionOf(row: SnapshotRow | undefined): MainThreadSection | undefined {
  return row?.sections?.mainthread;
}

/** One macrotask turn — enough for the S1 deferred startup snapshot to land. */
function turn(): Promise<void> {
  return new Promise<void>((r) => setImmediate(r));
}

let tempHome: string;
let savedEcosystemHome: string | undefined;
let savedScratchRoot: string | undefined;
let savedEmbedCacheDir: string | undefined;
let monitor: MainThreadMonitor | null = null;

beforeAll(() => {
  // Acceptance (c): pin the persistence root explicitly — never inherit it.
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 's5-'));
  savedEcosystemHome = process.env['SOX_ECOSYSTEM_HOME'];
  process.env['SOX_ECOSYSTEM_HOME'] = tempHome;
  // Coherence with the suite's BL-26291f21 embed-isolation guard: moving the
  // ecosystem home moves the DERIVED embed-host socket dir (`$SOX_ECOSYSTEM_HOME/run`,
  // resolveEmbedHostSocketDir()), so the run scratch root and the model cache must
  // re-home under the same temp tree — otherwise the guard's positive-containment
  // check (`hostSocketDir`/`cacheDir` inside the scratch root) would red every
  // `afterEach` and mask the golden. This test embeds nothing, so the empty cache
  // dir is never opened; only the guard's lexical containment reads it. Both are
  // restored in `afterAll` alongside `SOX_ECOSYSTEM_HOME`.
  savedScratchRoot = process.env[SCRATCH_ROOT_ENV];
  savedEmbedCacheDir = process.env['SOX_EMBED_CACHE_DIR'];
  process.env[SCRATCH_ROOT_ENV] = tempHome;
  process.env['SOX_EMBED_CACHE_DIR'] = path.join(tempHome, 'models');
});

afterEach(async () => {
  await monitor?.stop();
  monitor = null;
  _resetTelemetryForTest();
  hist.maxNs = 0;
});

afterAll(() => {
  if (savedEcosystemHome === undefined) delete process.env['SOX_ECOSYSTEM_HOME'];
  else process.env['SOX_ECOSYSTEM_HOME'] = savedEcosystemHome;
  if (savedScratchRoot === undefined) delete process.env[SCRATCH_ROOT_ENV];
  else process.env[SCRATCH_ROOT_ENV] = savedScratchRoot;
  if (savedEmbedCacheDir === undefined) delete process.env['SOX_EMBED_CACHE_DIR'];
  else process.env['SOX_EMBED_CACHE_DIR'] = savedEmbedCacheDir;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe('durable-metrics S5 — persisted main-thread blocking', () => {
  it('15628c7a-06a1-44ae-9930-03287a01c5a6: persisted main-thread blocking golden', async () => {
    // (c) the pin is in effect for this test.
    expect(process.env['SOX_ECOSYSTEM_HOME'], 'beforeAll must pin SOX_ECOSYSTEM_HOME').toBe(tempHome);
    const expectedLogDir = path.join(tempHome, SERVICE, 'logs');

    initTelemetry({
      service: SERVICE,
      role: ROLE,
      logSink: 'file',
      otel: false,
      snapshotEveryRecords: 0,
      snapshotEveryMs: 0,
    });
    // Let the S1 deferred startup snapshot write before our two windows, so the
    // last row is deterministically the injected block window.
    await turn();

    monitor = new MainThreadMonitor({
      intervalMs: 3_600_000,
      tickMs: TICK_MS,
      blockedThresholdMs: THRESHOLD_MS,
      killAfterMs: KILL_AFTER_MS,
      offThreadWatcher: false,
    });
    // start() is what registers the `mainthread` snapshot section.
    monitor.start();

    // ── Injected window 0: undisturbed — no drift tick, histogram max < threshold.
    hist.maxNs = UNDISTURBED_MS * NS_PER_MS;
    monitor.emitSummary(WINDOW0_NOW);
    await snapshotMetrics('pull');

    // ── Injected window 1: a deterministic block, injected twice — once as the
    //    drift the ticker observes, once as the histogram max — with no sleep.
    monitor.tick(0); // rebase lastTickAt := 0 (drift hugely negative, no block)
    monitor.tick(TICK_MS + BLOCK_MS); // drift = (TICK_MS+BLOCK_MS) - 0 - TICK_MS = BLOCK_MS exactly
    hist.maxNs = BLOCK_MS * NS_PER_MS;
    monitor.emitSummary(WINDOW1_NOW);
    await snapshotMetrics('pull');

    const rows = readRows(expectedLogDir);

    // (a) at least two rows persisted in the metrics-snapshot series.
    expect(rows.length, 'the persisted metrics-snapshot series must have >= 2 rows').toBeGreaterThanOrEqual(2);

    // (e) snapshot_seq strictly increasing across every persisted row.
    const seqs = rows.map((r) => r.snapshot_seq as number);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);

    // The two windows we injected, located by their injected max_ms.
    const withMax = rows.filter((r) => typeof sectionOf(r)?.max_ms === 'number');
    const undisturbed = withMax.find((r) => sectionOf(r)!.max_ms === UNDISTURBED_MS);
    const blocked = withMax.find((r) => sectionOf(r)!.max_ms === BLOCK_MS);

    // (b) the undisturbed window's max_ms stays below the block threshold.
    const undisturbedSection = sectionOf(undisturbed);
    expect(undisturbed, 'the undisturbed injected window must be persisted').toBeDefined();
    expect(undisturbedSection, 'the undisturbed row must carry a mainthread section').toBeDefined();
    expect(undisturbedSection!.max_ms!).toBeLessThan(THRESHOLD_MS);
    expect(undisturbedSection!.blocked_events).toBe(0);

    // (a) the LAST persisted row reports the injected block.
    expect(blocked, 'the injected-block window must be persisted').toBeDefined();
    const lastSection = sectionOf(rows[rows.length - 1]);
    expect(lastSection, 'the last persisted row must carry a mainthread section').toBeDefined();
    expect(lastSection!.max_ms!).toBeGreaterThanOrEqual(BLOCK_MS);
    expect(lastSection!.blocked_events!).toBeGreaterThanOrEqual(1);

    // (d) persisted mainthread values equal the injected values bit-for-bit.
    const blockedSection = sectionOf(blocked)!;
    expect(blockedSection.max_ms).toBe(BLOCK_MS);
    expect(blockedSection.longest_block_ms).toBe(BLOCK_MS);
    expect(blockedSection.blocked_events).toBe(1);
    expect(blockedSection.threshold_ms).toBe(THRESHOLD_MS);
    expect(blockedSection.kill_after_ms).toBe(KILL_AFTER_MS);

    // (c) the artifact landed under the pinned temp root, in the expected
    //     `<service>.<role>.metrics-snapshot-<UTC-date>.jsonl` file, and NEVER
    //     under the production `~/.adhd/sox-ecosystem/<service>/` tree.
    expect(snapshotFiles(expectedLogDir), `expected a snapshot file in ${expectedLogDir}`).toContain(
      `${SERVICE}.${ROLE}.metrics-snapshot-${utcDate()}.jsonl`,
    );
    expect(fs.existsSync(REAL_SERVICE_ROOT), `test telemetry leaked to ${REAL_SERVICE_ROOT}`).toBe(false);
  }, 30_000);
});
