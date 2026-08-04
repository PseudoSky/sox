/**
 * bl401-otel-sdk-and-metric-persistence.spec.ts — BL-401 gaps 4 and 6.
 *
 * **Gap 4 (was: "the OpenTelemetry SDK itself is not wired").** What shipped in
 * PKT-45 was the substrate's own span/metric model with OTel-shaped names;
 * `@opentelemetry/api` was declared as a dependency and never imported. These
 * tests assert the real SDK: a registered `AsyncLocalStorageContextManager`, a
 * `BasicTracerProvider` whose `SpanProcessor.onStart` writes the START record
 * before the span body finishes, and a pull-only `MeterReader` that holds no
 * timer.
 *
 * **Gap 6 (was: "metric persistence is not implemented").** `telemetrySelfCheck()`
 * was a live in-memory view only, so a crash lost everything it held. These
 * tests assert a durable `metrics.snapshot` line, written to its OWN component
 * file — §5.8's first consequence, because a snapshot pruned alongside the
 * events it exists to outlive silently falsifies the "recomputable by replay"
 * property at exactly the ages where it was the whole point.
 *
 * The strongest test here is `onStart fires before the body finishes`: it is
 * the one property a `SpanExporter` structurally cannot provide (it only ever
 * sees ENDED spans), and it is the property the whole telemetry module exists
 * for — a hang leaves `try/finally` unreached and would otherwise produce zero
 * trace.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  initTelemetry,
  log,
  otelReady,
  snapshotMetrics,
  telemetrySelfCheck,
  withSpan,
  declareStages,
  _resetTelemetryForTest,
} from './index.js';

const dirs: string[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl401-'));
  dirs.push(d);
  return d;
}

function readRecords(dir: string, match: (f: string) => boolean): Array<Record<string, unknown>> {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') && match(f));
  return files.flatMap((f) =>
    fs
      .readFileSync(path.join(dir, f), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>),
  );
}

const isSnapshotFile = (f: string): boolean => f.includes('.metrics-snapshot-');
const isEventFile = (f: string): boolean => !f.includes('.metrics-snapshot-');

afterEach(() => {
  _resetTelemetryForTest();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('BL-401 gap 4 — the real OpenTelemetry SDK is wired', () => {
  it('brings the SDK up and reports its own state instead of leaving it to be inferred', async () => {
    const dir = tmpDir();
    initTelemetry({ service: 'bl401', role: 'test', logSink: 'file', logDir: dir, otel: true });

    // Before the dynamic import() settles the state is honestly 'pending' —
    // NOT silently absent. "No spans yet" and "the SDK never came up" were
    // previously the same silence, which is the BL-319/BL-404 failure shape.
    expect(telemetrySelfCheck().otel.state).toBe('pending');

    await otelReady();
    expect(telemetrySelfCheck().otel.state).toBe('ready');
    expect(telemetrySelfCheck().otel.spans_enabled).toBe(true);
  });

  it('is OFF by default under a test role and ON by default for a live service', async () => {
    const dir = tmpDir();
    initTelemetry({ service: 'bl401', role: 'test', logSink: 'file', logDir: dir });
    await otelReady();
    // 91.5 ms + 23.6 MB per vitest worker is the wrong price; a composition
    // root pays it once.
    expect(telemetrySelfCheck().otel.state).toBe('disabled');

    initTelemetry({ service: 'bl401', role: 'live-service', logSink: 'file', logDir: dir });
    await otelReady();
    expect(telemetrySelfCheck().otel.state).toBe('ready');
  });

  it('writes the START record from SpanProcessor.onStart — BEFORE the span body finishes', async () => {
    const dir = tmpDir();
    initTelemetry({ service: 'bl401', role: 'test', logSink: 'file', logDir: dir, otel: true });
    await otelReady();

    let release!: () => void;
    const blocked = new Promise<void>((res) => {
      release = res;
    });
    const inFlight = withSpan('bl401.hang_probe', { probe: true }, async () => {
      await blocked;
      return 'done';
    });

    // The span has NOT ended. A SpanExporter would have exported nothing at
    // all here — the exact reason the research chose SpanProcessor.onStart.
    await new Promise((res) => setTimeout(res, 20));
    const midFlight = readRecords(dir, isEventFile);
    expect(midFlight.some((r) => r['event'] === 'bl401.hang_probe.start')).toBe(true);
    expect(midFlight.some((r) => r['event'] === 'bl401.hang_probe.finish')).toBe(false);

    release();
    await expect(inFlight).resolves.toBe('done');

    const after = readRecords(dir, isEventFile);
    const finish = after.find((r) => r['event'] === 'bl401.hang_probe.finish');
    expect(finish).toBeDefined();
    expect(typeof finish!['duration_ms']).toBe('number');
    expect(finish!['probe']).toBe(true);
  });

  it('joins a nested span to its parent across an await, with no context threaded by hand', async () => {
    const dir = tmpDir();
    initTelemetry({ service: 'bl401', role: 'test', logSink: 'file', logDir: dir, otel: true });
    await otelReady();

    await withSpan('bl401.outer', {}, async () => {
      await new Promise((res) => setTimeout(res, 5));
      // Nothing is passed from outer to inner. Without a registered
      // AsyncLocalStorageContextManager these become two unrelated roots —
      // silently, with no error and no warning (§3.4). That is the single
      // omission `initTelemetry` exists to make unreachable.
      await withSpan('bl401.inner', {}, async () => undefined);
    });

    const recs = readRecords(dir, isEventFile);
    const outer = recs.find((r) => r['event'] === 'bl401.outer.finish');
    const inner = recs.find((r) => r['event'] === 'bl401.inner.finish');
    expect(outer).toBeDefined();
    expect(inner).toBeDefined();
    expect(inner!['otel_trace_id']).toBe(outer!['otel_trace_id']);
    expect(inner!['span_id']).not.toBe(outer!['span_id']);
  });

  it('records a stage error onto the span and still re-throws unchanged', async () => {
    const dir = tmpDir();
    initTelemetry({ service: 'bl401', role: 'test', logSink: 'file', logDir: dir, otel: true });
    await otelReady();

    const boom = new Error('bl401-boom');
    await expect(withSpan('bl401.failing', {}, () => Promise.reject(boom))).rejects.toBe(boom);

    const recs = readRecords(dir, isEventFile);
    const rec = recs.find((r) => r['event'] === 'bl401.failing.error');
    expect(rec).toBeDefined();
    expect(rec!['level']).toBe('error');
    expect(rec!['error']).toBe('bl401-boom');
  });

  it('holds no timer: the pull-only reader adds zero active handles (BL-345)', async () => {
    const dir = tmpDir();
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    initTelemetry({ service: 'bl401', role: 'test', logSink: 'file', logDir: dir, otel: true });
    await otelReady();
    await withSpan('bl401.handle_probe', {}, async () => undefined);
    const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    // A PeriodicExportingMetricReader or BatchSpanProcessor would each add one
    // — a timer waking up to do work on the same event loop as memory_recall,
    // which is precisely the BL-345 starvation shape.
    expect(after).toBe(before);
  });

  it('aggregates stage durations into a real exponential histogram with recovered percentiles', async () => {
    const dir = tmpDir();
    initTelemetry({ service: 'bl401', role: 'test', logSink: 'file', logDir: dir, otel: true });
    await otelReady();

    const catalog = declareStages('bl401-hist', { probe: { paths: ['only'] } } as const);
    for (let i = 0; i < 5; i++) {
      await catalog.withContendedStage(
        'probe',
        'only',
        () => new Promise<void>((res) => setTimeout(res, 2)),
        () => new Promise<Nil>((res) => setTimeout(() => res(null), 4)),
      );
    }

    await snapshotMetrics('pull');
    const snaps = readRecords(dir, isSnapshotFile);
    const last = snaps[snaps.length - 1]!;
    const metrics = last['otel_metrics'] as Array<Record<string, unknown>>;
    const wait = metrics.find((m) => m['name'] === 'sox.stage.wait_ms');
    const work = metrics.find((m) => m['name'] === 'sox.stage.work_ms');
    const count = metrics.find((m) => m['name'] === 'sox.stage.count');

    // Wait and work are emitted as a PAIR or not at all — there is no API that
    // records one without the other (§5.2's anti-convention).
    expect(wait).toBeDefined();
    expect(work).toBeDefined();
    expect(wait!['count']).toBe(5);
    expect(work!['count']).toBe(5);
    expect(wait!['kind']).toBe('histogram');
    // Percentiles are bucket UPPER bounds — they read high, never low.
    expect(typeof work!['p50']).toBe('number');
    expect(work!['p99'] as number).toBeGreaterThanOrEqual(work!['p50'] as number);
    expect(count).toBeDefined();
  });
});

type Nil = null;

describe('BL-401 gap 6 — metric persistence', () => {
  it('writes a durable metrics.snapshot line to its OWN component file, not the event stream', async () => {
    const dir = tmpDir();
    initTelemetry({ service: 'bl401', role: 'test', logSink: 'file', logDir: dir, snapshotEveryRecords: 0 });
    log.info('bl401.some_event', {});
    await snapshotMetrics('pull');

    const snapshots = readRecords(dir, isSnapshotFile);
    expect(snapshots.length).toBe(1);
    expect(snapshots[0]!['event']).toBe('metrics.snapshot');
    // §5.8's first consequence: sharing the event stream's files would prune
    // checkpoints alongside the events they are meant to outlive.
    const eventRecords = readRecords(dir, isEventFile);
    expect(eventRecords.some((r) => r['event'] === 'metrics.snapshot')).toBe(false);
    expect(eventRecords.some((r) => r['event'] === 'bl401.some_event')).toBe(true);

    // The component separator is '.', never '-' — a pruner anchored on
    // `bl401-` would otherwise also match `bl401-test-…` (§5.8's footgun).
    const snapFile = fs.readdirSync(dir).find(isSnapshotFile)!;
    expect(snapFile.startsWith('bl401.test.metrics-snapshot-')).toBe(true);
  });

  it('labels its window and carries the full self-check, so a crash loses only the last N records', async () => {
    const dir = tmpDir();
    initTelemetry({ service: 'bl401', role: 'test', logSink: 'file', logDir: dir, snapshotEveryRecords: 0 });
    const catalog = declareStages('bl401-snap', { s: { paths: ['a', 'b'] } } as const);
    await catalog.withContendedStage('s', 'a', () => Promise.resolve(), () => Promise.resolve(null));
    await snapshotMetrics('pull');

    const snap = readRecords(dir, isSnapshotFile)[0]!;
    // A cumulative counter without its window is an unfalsifiable number —
    // the BL-334 pattern this design was written against.
    expect(snap['window']).toBe('since process start');
    expect(snap['reason']).toBe('pull');
    expect(typeof snap['records_covered']).toBe('number');
    const selfCheck = snap['self_check'] as Record<string, unknown>;
    expect(selfCheck['stages_declared']).toBeGreaterThan(0);
    // The declared-but-unsampled sibling is visible IN THE DURABLE RECORD, not
    // just in a live pull that a crash would take with it (BL-319).
    expect(selfCheck['paths_with_zero_samples']).toContain('bl401-snap.s:b');
  });

  it('snapshots on activity — no timer, staleness bounded by work done rather than wall-clock', async () => {
    const dir = tmpDir();
    initTelemetry({ service: 'bl401', role: 'test', logSink: 'file', logDir: dir, snapshotEveryRecords: 3 });
    for (let i = 0; i < 3; i++) log.info(`bl401.activity_${i}`, {});
    // The trigger fires synchronously from the emit path; the write itself is
    // one awaited tick behind it.
    await new Promise((res) => setTimeout(res, 30));

    const snapshots = readRecords(dir, isSnapshotFile);
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    expect(snapshots[0]!['reason']).toBe('activity');
    expect(telemetrySelfCheck().metric_persistence.written).toBeGreaterThanOrEqual(1);
  });

  it('reports how much un-snapshotted state is currently at risk', async () => {
    const dir = tmpDir();
    initTelemetry({ service: 'bl401', role: 'test', logSink: 'file', logDir: dir, snapshotEveryRecords: 0 });
    log.info('bl401.risk_a', {});
    log.info('bl401.risk_b', {});
    // Read the aggregate WITHOUT the opportunistic snapshot resetting it first.
    expect(telemetrySelfCheck().metric_persistence.records_since).toBeGreaterThanOrEqual(2);
    await snapshotMetrics('pull');
    expect(telemetrySelfCheck().metric_persistence.records_since).toBe(0);
  });
});
