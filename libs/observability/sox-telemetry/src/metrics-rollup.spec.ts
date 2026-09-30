/**
 * metrics-rollup.spec.ts — durable-metrics **S8**
 * (`6df0d673-2dd5-488f-9539-9a33c6f3866d`), BL-225.
 *
 * WHAT IT PROVES
 * ──────────────
 * The library OWNS continuous rollup of the `metrics.snapshot` stream: the S1
 * interval tick writes an aggregated `metrics.rollup` row per distinct release
 * every cadence, and `close()` folds one last row on shutdown. There is no
 * external repo tool and no human `--apply` — the aggregation is a pure function
 * (`rollup.ts`) driven by the runtime, landing in the resolved adhd env root.
 *
 * The file covers the S8 acceptance set:
 *   (a) one `snapshotMetrics()` + one `rollupMetrics('interval')` ⇒ exactly one
 *       rollup file with one row carrying window / snapshots_in_window / series /
 *       release.
 *   (b) with `release` unset the row's release is null-filled and explicitly
 *       `not.toBe('')` (the BL-433 contract).
 *   (c) `rollup.ts` is PURE — `aggregateSnapshots` unit-tested with an injected
 *       `now`, no filesystem, deterministic nearest-rank percentiles.
 *   (d) two snapshot records with DIFFERENT release values in the window produce
 *       TWO rollup rows (release keying, not blending).
 *   (e) zero rollup artifacts under the REAL `~/.adhd/sox-ecosystem` root.
 *   (f) the BL-225 uid-named test: an INTERVAL TICK (not a manual call) writes
 *       one row per release to the temp home and nothing under the real root.
 *
 * ## S8 blind-review fixes folded in
 *   (c2) a single-sample `cumulative_delta` is `null`, never a fabricated `0`
 *        (`4846a2c9`'s sibling; BL-334). — FIX 4.
 *   (d2) a RESTART (same release, a new `pid`) is TWO rows, not one blended row:
 *        the group key is (release, process instance), not release alone. — FIX 2.
 *   —    the uid-named interval test (f) waits on a BOUNDED POLL for the row to
 *        appear, never a fixed `sleep` that races the timer's first fire
 *        (`bc0a30ae`; the BL-167/BL-225 timing-luck shape). — FIX 1.
 *
 * ## Hermeticity
 *
 * `vitest.setup.ts` (S1) pins `SOX_ECOSYSTEM_HOME` at a per-file temp root; the
 * `afterEach`/`afterAll` guards below prove every artifact resolved under it and
 * that the real root gained nothing. `SOX_TRACE_SNAPSHOT_MS` /
 * `SOX_TRACE_SNAPSHOT_EVERY` are scrubbed-and-restored for the file (`dbcaffb4`:
 * the suite is not hermetic against those ambient overrides, and an interval
 * assertion must be deterministic).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initTelemetry, snapshotMetrics, rollupMetrics, _resetTelemetryForTest } from './index.js';
import { aggregateSnapshots, ROLLUP_SERIES, type MetricsSnapshotRecord } from './rollup.js';

/** A service no real composition root uses, so its absence under the real root
 *  is an unambiguous leak signal. */
const SERVICE = 's8-rollup';
const ROLE = 'live-service';

const REL_A = { version: '1.0.0', artifact_sha256: `sha256:${'a'.repeat(64)}`, git_sha: 'a'.repeat(40) } as const;
const REL_B = { version: '2.0.0', artifact_sha256: `sha256:${'b'.repeat(64)}`, git_sha: 'b'.repeat(40) } as const;

/** The real, production data root — no test may ever add a file here. */
const REAL_ROOT = path.join(os.homedir(), '.adhd', 'sox-ecosystem');
const REAL_SERVICE_DIR = path.join(REAL_ROOT, SERVICE);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * FIX 1 (`bc0a30ae`): a BOUNDED POLL, never a fixed `sleep`. The S1 interval
 * tick is a floating async chain (`await snapshotMetrics('interval'); await
 * rollupMetrics('interval')`, `runtime.ts`), and `rollupMetrics` async-reads
 * the snapshot files before it can write a row — so a fixed sleep must guess
 * the entire first-fire + read + write latency. A measured ~71 ms first fire
 * against `snapshotEveryMs: 30` left under one tick of margin, and the test
 * failed ~1/3 of runs (the BL-167/BL-225 timing-luck anti-pattern: a test named
 * for the invariant that passes only by luck). Waiting for the observable
 * effect makes the assertion deterministic while leaving the TIMER as the only
 * thing that can produce it — the test still proves the wiring, not a manual
 * call.
 *
 * Polls the synchronous, side-effect-free `probe` every `intervalMs` until it
 * returns non-null; throws after `timeoutMs` (a guard against a genuinely
 * broken timer, not a latency budget). Reusable — any "wait until effect X" in
 * this file goes through it.
 */
async function waitFor<T>(
  label: string,
  probe: () => T | null,
  { timeoutMs = 2_000, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = probe();
    if (found !== null) return found;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor(${label}): not satisfied within ${timeoutMs}ms`);
    }
    await sleep(intervalMs);
  }
}

function utcDate(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Every persisted `metrics.rollup` row under a `rollup/` dir, across files. */
function readRollupRows(rollupDir: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(rollupDir)) return [];
  return fs
    .readdirSync(rollupDir)
    .filter((f) => f.includes('.metrics-rollup-'))
    .flatMap((f) =>
      fs
        .readFileSync(path.join(rollupDir, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    );
}

/** Recursive file listing (absolute, sorted) — proves the real root gained
 *  nothing. Returns `[]` when the root does not exist. */
function listFilesRecursive(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(p));
    else out.push(p);
  }
  return out.sort();
}

let savedTraceMs: string | undefined;
let savedTraceEvery: string | undefined;
let realRootBefore: string[] = [];

beforeAll(() => {
  // dbcaffb4: scrub-and-restore the ambient overrides so this file's interval
  // assertions are deterministic (and so the file never leaks a cadence into a
  // sibling spec's process).
  savedTraceMs = process.env['SOX_TRACE_SNAPSHOT_MS'];
  savedTraceEvery = process.env['SOX_TRACE_SNAPSHOT_EVERY'];
  delete process.env['SOX_TRACE_SNAPSHOT_MS'];
  delete process.env['SOX_TRACE_SNAPSHOT_EVERY'];
  realRootBefore = listFilesRecursive(REAL_ROOT);
});

afterEach(() => {
  _resetTelemetryForTest();
  const home = process.env['SOX_ECOSYSTEM_HOME'];
  if (home !== undefined) fs.rmSync(path.join(home, SERVICE), { recursive: true, force: true });
  // Per-spec real-root negative guard (in addition to the afterAll addition
  // check): the unique test service must never appear under the real root.
  expect(fs.existsSync(REAL_SERVICE_DIR), `test telemetry leaked to ${REAL_SERVICE_DIR}`).toBe(false);
});

afterAll(() => {
  _resetTelemetryForTest();

  const added = listFilesRecursive(REAL_ROOT).filter((p) => !realRootBefore.includes(p));

  if (savedTraceMs === undefined) delete process.env['SOX_TRACE_SNAPSHOT_MS'];
  else process.env['SOX_TRACE_SNAPSHOT_MS'] = savedTraceMs;
  if (savedTraceEvery === undefined) delete process.env['SOX_TRACE_SNAPSHOT_EVERY'];
  else process.env['SOX_TRACE_SNAPSHOT_EVERY'] = savedTraceEvery;

  // The real root must have gained NOTHING from this run (a live production
  // writer may append/prune existing files, so additions are the only shape a
  // leaked test write can take).
  expect(added, `test telemetry leaked new files under ${REAL_ROOT}`).toEqual([]);
  expect(fs.existsSync(REAL_SERVICE_DIR), `test wrote the real ${REAL_SERVICE_DIR}`).toBe(false);
});

describe('S8 — library-owned continuous rollup (6df0d673…)', () => {
  it('6df0d673-2dd5-488f-9539-9a33c6f3866d: an interval tick writes one aggregated rollup row keyed by release to the temp home, none under the real root', async () => {
    const home = process.env['SOX_ECOSYSTEM_HOME'];
    expect(home).toBeDefined();
    const logDir = path.join(home!, SERVICE, 'logs');
    const rollupDir = path.join(logDir, 'rollup');

    // A real INTERVAL TICK — no manual `rollupMetrics` call — proves the wiring:
    // the S1 timer callback folds a row every cadence. We wait for the row to
    // APPEAR (a bounded poll on the observable effect) rather than sleeping a
    // fixed interval that races the timer's first fire.
    initTelemetry({
      service: SERVICE,
      role: ROLE,
      logSink: 'file',
      otel: false,
      snapshotEveryRecords: 0,
      snapshotEveryMs: 30,
      release: REL_A,
    });
    const rows = await waitFor('interval rollup row', () => {
      const found = readRollupRows(rollupDir);
      return found.length >= 1 ? found : null;
    });
    _resetTelemetryForTest();

    expect(rows.length).toBeGreaterThanOrEqual(1);

    // ONE row per distinct release per tick: with a single release, every tick's
    // window carries exactly one row.
    const perWindow = new Map<number, number>();
    for (const row of rows) {
      expect(row['event']).toBe('metrics.rollup');
      expect(row['release']).toEqual(REL_A);
      expect(row['window']).toBeDefined();
      expect(typeof row['snapshots_in_window']).toBe('number');
      expect(row['series']).toBeDefined();
      const w = row['window'] as { from: number; to: number; kind: string };
      expect(w.kind).toBe('trailing');
      perWindow.set(w.to, (perWindow.get(w.to) ?? 0) + 1);
    }
    for (const count of perWindow.values()) expect(count).toBe(1);

    // The temp home is where it landed — never the real root.
    expect(rollupDir.startsWith(home!)).toBe(true);
    expect(fs.existsSync(REAL_SERVICE_DIR)).toBe(false);
  });

  it('acceptance (a): one snapshot + one rollupMetrics passes exactly one rollup file with one row carrying window/snapshots_in_window/series/release', async () => {
    const home = process.env['SOX_ECOSYSTEM_HOME']!;
    const logDir = path.join(home, SERVICE, 'logs');
    const rollupDir = path.join(logDir, 'rollup');

    initTelemetry({
      service: SERVICE,
      role: ROLE,
      logSink: 'file',
      otel: false,
      snapshotEveryRecords: 0,
      snapshotEveryMs: 0,
      release: REL_A,
    });
    await snapshotMetrics('pull');
    await rollupMetrics('interval');

    const files = fs.readdirSync(rollupDir).filter((f) => f.includes('.metrics-rollup-'));
    expect(files).toHaveLength(1);
    // The exact production layout: <logDir>/rollup/<service>.<role>.metrics-rollup-<UTC-date>.jsonl
    expect(files[0]).toBe(`${SERVICE}.${ROLE}.metrics-rollup-${utcDate()}.jsonl`);

    const rows = readRollupRows(rollupDir);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row['window']).toBeDefined();
    expect(row['snapshots_in_window'] as number).toBeGreaterThanOrEqual(1);
    expect(row['series']).toBeDefined();
    expect(row['release']).toEqual(REL_A);
    expect(row['self_check']).toBeDefined();
    expect(row['otel']).toBeDefined();
  });

  it('acceptance (b): with release unset the rollup row is null-filled and explicitly not ""', async () => {
    const home = process.env['SOX_ECOSYSTEM_HOME']!;
    const logDir = path.join(home, SERVICE, 'logs');
    const rollupDir = path.join(logDir, 'rollup');

    initTelemetry({
      service: SERVICE,
      role: ROLE,
      logSink: 'file',
      otel: false,
      snapshotEveryRecords: 0,
      snapshotEveryMs: 0,
    });
    await snapshotMetrics('pull');
    await rollupMetrics('interval');

    const rows = readRollupRows(rollupDir);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      const rel = row['release'] as Record<string, unknown> | undefined;
      expect(rel, 'release must still be present as an object').toBeDefined();
      expect(rel!['version']).toBeNull();
      expect(rel!['artifact_sha256']).toBeNull();
      expect(rel!['git_sha']).toBeNull();
      expect(rel!['version']).not.toBe('');
      expect(rel!['artifact_sha256']).not.toBe('');
      expect(rel!['git_sha']).not.toBe('');
    }
  });

  it('acceptance (c): aggregateSnapshots is pure — injected now, no fs, nearest-rank percentiles, closed series list', () => {
    const now = Date.parse('2026-09-30T12:00:00.000Z');
    const release = { version: '1.0.0', artifact_sha256: null, git_sha: null } as const;
    const records: MetricsSnapshotRecord[] = [
      {
        ts: '2026-09-30T11:59:00.000Z',
        snapshot_seq: 1,
        records_covered: 10,
        process: { rss_bytes: 100, cpu_user_ms: 5, cpu_system_ms: 1, uptime_s: 10 },
        release,
      },
      {
        ts: '2026-09-30T11:59:30.000Z',
        snapshot_seq: 2,
        records_covered: 20,
        process: { rss_bytes: 200, cpu_user_ms: 8, cpu_system_ms: 2, uptime_s: 12 },
        release,
      },
    ];

    const rows = aggregateSnapshots(records, { windowMs: 3_600_000, now });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    expect(row.snapshots_in_window).toBe(2);
    expect(row.window).toEqual({ from: now - 3_600_000, to: now, kind: 'trailing' });
    expect(row.release).toEqual(release);

    // Closed series list: every row carries THE declared key set, each tagged.
    expect(Object.keys(row.series).sort()).toEqual(ROLLUP_SERIES.map((s) => s.name).sort());
    for (const entry of Object.values(row.series)) expect(typeof entry.agg).toBe('string');

    expect(row.series['process.rss_bytes']!.agg).toBe('gauge');
    expect(row.series['process.rss_bytes']!.value).toBe(150); // mean
    expect(row.series['records_covered']!.agg).toBe('sum');
    expect(row.series['records_covered']!.value).toBe(30);
    expect(row.series['snapshots_written']!.agg).toBe('counter_max');
    expect(row.series['snapshots_written']!.value).toBe(2);
    expect(row.series['cpu.user_ms']!.agg).toBe('cumulative_delta');
    expect(row.series['cpu.user_ms']!.value).toBe(3); // 8 − 5

    // Nearest-rank over 2 samples: p50 → lower, p99 → upper.
    expect(row.series['process.rss_bytes']!.p50).toBe(100);
    expect(row.series['process.rss_bytes']!.p99).toBe(200);

    // An unsummable percentile is never presented as summable.
    expect(row.series['write_latency_ms']!.agg).toBe('max_of_percentiles');
    expect(row.series['write_latency_ms']!.sum).toBeNull();
    // No store_metrics section ⇒ zero samples, null stats (honest, not zeros).
    expect(row.series['write_latency_ms']!.samples).toBe(0);
    expect(row.series['write_latency_ms']!.value).toBeNull();

    // Out-of-window records are dropped; an empty window yields no rows.
    expect(aggregateSnapshots(records, { windowMs: 1_000, now })).toEqual([]);
  });

  it('acceptance (c2): a single-sample cumulative_delta is null, never a fabricated 0 (BL-334)', () => {
    // FIX 4: `max − min` over ONE sample is a fabricated `0` — it reports "no
    // CPU work" for a process that plainly did work, which is exactly the state
    // of a freshly-started process and of a release/restart boundary's first
    // row. With fewer than two samples the delta is UNMEASURABLE, so `value` is
    // `null`; the raw reading stays visible in min/max, so nothing is hidden.
    const now = Date.parse('2026-09-30T12:00:00.000Z');
    const rows = aggregateSnapshots(
      [
        {
          ts: '2026-09-30T11:59:30.000Z',
          snapshot_seq: 1,
          records_covered: 10,
          process: { cpu_user_ms: 5, cpu_system_ms: 2, uptime_s: 10 },
          release: REL_A,
        },
      ],
      { windowMs: 3_600_000, now },
    );
    expect(rows).toHaveLength(1);
    const cpu = rows[0]!.series['cpu.user_ms']!;
    expect(cpu.agg).toBe('cumulative_delta');
    expect(cpu.samples).toBe(1);
    expect(cpu.value).toBeNull();
    expect(rows[0]!.series['cpu.system_ms']!.value).toBeNull();
    // The one reading is not lost — only the unmeasurable delta is withheld.
    expect(cpu.min).toBe(5);
    expect(cpu.max).toBe(5);
  });

  it('acceptance (d): two snapshot records with different release values in the window produce TWO rollup rows', async () => {
    // Pure level: one group per distinct release.
    const now = Date.now();
    const pure = aggregateSnapshots(
      [
        { ts: new Date(now - 1_000).toISOString(), release: REL_A },
        { ts: new Date(now - 500).toISOString(), release: REL_B },
      ],
      { windowMs: 3_600_000, now },
    );
    expect(pure).toHaveLength(2);
    expect(pure.map((r) => r.release.version).sort()).toEqual(['1.0.0', '2.0.0']);

    // End-to-end: both releases land in ONE snapshot component file, and ONE
    // rollup pass emits two rows into ONE rollup file.
    const home = process.env['SOX_ECOSYSTEM_HOME']!;
    const logDir = path.join(home, SERVICE, 'logs');
    const rollupDir = path.join(logDir, 'rollup');

    initTelemetry({
      service: SERVICE,
      role: ROLE,
      logSink: 'file',
      otel: false,
      snapshotEveryRecords: 0,
      snapshotEveryMs: 0,
      release: REL_A,
    });
    await snapshotMetrics('pull');
    _resetTelemetryForTest();

    initTelemetry({
      service: SERVICE,
      role: ROLE,
      logSink: 'file',
      otel: false,
      snapshotEveryRecords: 0,
      snapshotEveryMs: 0,
      release: REL_B,
    });
    await snapshotMetrics('pull');
    await sleep(20); // let any deferred startup snapshot drain
    await rollupMetrics('interval');

    const rows = readRollupRows(rollupDir);
    expect(rows).toHaveLength(2);
    const versions = rows.map((r) => (r['release'] as Record<string, unknown>)['version']).sort();
    expect(versions).toEqual(['1.0.0', '2.0.0']);
  });

  it('acceptance (d2): a restart — same release, a NEW pid — produces TWO rollup rows, not one blended row', () => {
    // FIX 2 (`4846a2c9`): grouping on `release` ALONE collapsed two process
    // lifetimes of the SAME build into one row, silently corrupting every
    // aggregate over them — `cpu.*` as `max − min` straddles the counter reset,
    // `process.uptime_s` reports the dead process, `records_covered` double
    // counts, `snapshots_written` reports only the further-advanced process.
    // The group key is now (release, pid), so a restart yields two rows, each
    // carrying its own `process_pid` — the same splitting a release boundary
    // already had, extended to the restart axis S1 exists for.
    const now = Date.now();
    const records: MetricsSnapshotRecord[] = [
      {
        ts: new Date(now - 1_000).toISOString(),
        release: REL_A,
        pid: 4100,
        records_covered: 10,
        process: { rss_bytes: 100, cpu_user_ms: 5, cpu_system_ms: 1, uptime_s: 10 },
      },
      {
        ts: new Date(now - 500).toISOString(),
        release: REL_A,
        pid: 4200,
        records_covered: 20,
        process: { rss_bytes: 200, cpu_user_ms: 2, cpu_system_ms: 1, uptime_s: 3 },
      },
    ];

    const rows = aggregateSnapshots(records, { windowMs: 3_600_000, now });
    // THE fix: two lifetimes of one release are two rows, one per process.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.process_pid).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([4100, 4200]);
    // Each row is internally consistent — one snapshot — never a blend.
    for (const row of rows) expect(row.snapshots_in_window).toBe(1);
    // `records_covered` is `sum`: per-process it is 10 and 20, NEVER a
    // double-counted 30. This is the misleading number the old grouping
    // produced, now impossible.
    expect(
      rows.map((r) => r.series['records_covered']!.value).sort((a, b) => (a ?? 0) - (b ?? 0)),
    ).toEqual([10, 20]);
  });

  it('acceptance (e): every rollup artifact lands under the temp home, none under the real adhd root', async () => {
    const home = process.env['SOX_ECOSYSTEM_HOME']!;
    const logDir = path.join(home, SERVICE, 'logs');
    const rollupDir = path.join(logDir, 'rollup');

    initTelemetry({
      service: SERVICE,
      role: ROLE,
      logSink: 'file',
      otel: false,
      snapshotEveryRecords: 0,
      snapshotEveryMs: 0,
    });
    await snapshotMetrics('pull');
    await rollupMetrics('interval');

    const files = fs.readdirSync(rollupDir);
    expect(files.length).toBeGreaterThanOrEqual(1);
    // The rollup dir nests UNDER the resolved (temp) logDir…
    expect(path.resolve(rollupDir).startsWith(path.resolve(home))).toBe(true);
    // …and the real root has neither the service dir nor any rollup artifact.
    expect(fs.existsSync(REAL_SERVICE_DIR)).toBe(false);
    expect(listFilesRecursive(path.join(REAL_ROOT, SERVICE))).toEqual([]);
  });
});
