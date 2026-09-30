/**
 * metrics-snapshot-cadence.spec.ts — durable-metrics S1 (979c54…), BL-225.
 *
 * The defect this closes: `runtime.ts` emitted a `metrics.snapshot` ONLY from
 * the record trigger (`metric_persistence.every_records`, default 1000). A
 * process that restarts — every process in a release window — never accumulates
 * 1000 records, so it persisted NOTHING; there was no post-cutover production
 * `metrics.snapshot` at all. S1 adds a wall-clock floor (`snapshotEveryMs`,
 * default 60 s) plus one snapshot at startup, so a restart-heavy window still
 * leaves a durable series.
 *
 * `vitest.setup.ts` points `SOX_ECOSYSTEM_HOME` at a per-file temp root; the
 * `afterEach` guard below is the belt-and-braces proof that no test in this file
 * ever wrote the real `~/.adhd/sox-ecosystem/s1` (acceptance (b)).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initTelemetry, log, telemetrySelfCheck, _resetTelemetryForTest } from './index.js';

/** The production path this file's service ('s1') would leak to if the sandbox
 *  failed. It is deliberately a service no real composition root uses. */
const REAL_ROOT = path.join(os.homedir(), '.adhd', 'sox-ecosystem', 's1');

const dirs: string[] = [];

function makeDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-cadence-'));
  dirs.push(d);
  return d;
}

function utcDate(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function readSnapshotRecords(dir: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.includes('.metrics-snapshot-'))
    .flatMap((f) =>
      fs
        .readFileSync(path.join(dir, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** One check phase — enough for the deferred startup snapshot to land. */
const tick = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

afterEach(() => {
  _resetTelemetryForTest();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  // The setup sandbox may have accumulated <scratch>/s1/logs — clear it so the
  // next case starts clean.
  const scratch = process.env['SOX_ECOSYSTEM_HOME'];
  if (scratch !== undefined) fs.rmSync(path.join(scratch, 's1'), { recursive: true, force: true });
  // Acceptance (b): test telemetry must NEVER land in the production root.
  expect(fs.existsSync(REAL_ROOT), `test telemetry leaked to ${REAL_ROOT}`).toBe(false);
});

describe('S1 — the durable wall-clock snapshot floor (979c54…)', () => {
  it('979c542e-75f1-4cdb-a726-8f58df1365fe: a restarting process persists a startup snapshot without reaching every_records', async () => {
    const dir = makeDir();
    initTelemetry({ service: 's1', role: 'live-service', logSink: 'file', logDir: dir, otel: false });

    // ONE record — nowhere near the default 1000-record activity trigger. A
    // process that restarts here writes this and then vanishes; before S1 that
    // left no durable snapshot at all.
    log.info('s1.one', {});
    await tick();

    const snaps = readSnapshotRecords(dir);
    expect(snaps.length).toBeGreaterThanOrEqual(1);
    expect(snaps.some((s) => s['reason'] === 'startup')).toBe(true);
  });

  it('acceptance (a): with SOX_ECOSYSTEM_HOME unset the resolver targets the real root (planned path, no write)', () => {
    const saved = process.env['SOX_ECOSYSTEM_HOME'];
    delete process.env['SOX_ECOSYSTEM_HOME'];
    try {
      initTelemetry({ service: 's1', role: 'live-service', logSink: 'file', otel: false, snapshotEveryMs: 0 });
      const planned = telemetrySelfCheck().metric_persistence.file;
      expect(planned).toBe(
        path.join(
          os.homedir(),
          '.adhd',
          'sox-ecosystem',
          's1',
          'logs',
          `s1.live-service.metrics-snapshot-${utcDate()}.jsonl`,
        ),
      );
    } finally {
      // Close the sink synchronously so the deferred startup snapshot cannot
      // perform a real production write; the afterEach guard proves it did not.
      _resetTelemetryForTest();
      if (saved === undefined) delete process.env['SOX_ECOSYSTEM_HOME'];
      else process.env['SOX_ECOSYSTEM_HOME'] = saved;
    }
  });

  it('acceptance (a)/(b): with SOX_ECOSYSTEM_HOME=<scratch> the startup snapshot lands under <scratch>/s1/logs, never in the real root', async () => {
    const home = process.env['SOX_ECOSYSTEM_HOME'];
    expect(home).toBeDefined();
    const expectedDir = path.join(home!, 's1', 'logs');

    initTelemetry({ service: 's1', role: 'live-service', logSink: 'file', otel: false });
    await tick();

    const snaps = readSnapshotRecords(expectedDir);
    expect(snaps.some((s) => s['reason'] === 'startup')).toBe(true);
    expect(fs.existsSync(REAL_ROOT)).toBe(false);
  });

  it('acceptance (c): the interval cadence fires once per interval with strictly monotonic snapshot_seq', async () => {
    const dir = makeDir();
    const interval = 40;
    const wait = 160;
    initTelemetry({
      service: 's1',
      role: 'live-service',
      logSink: 'file',
      logDir: dir,
      otel: false,
      snapshotEveryRecords: 0,
      snapshotEveryMs: interval,
    });

    await sleep(wait);

    const snaps = readSnapshotRecords(dir);
    const intervals = snaps.filter((s) => s['reason'] === 'interval');
    // Once per interval, never MORE than that: over `wait` ms with an
    // `interval` ms tick, at most ceil(wait/interval)+1 ticks can land.
    expect(intervals.length).toBeGreaterThanOrEqual(2);
    expect(intervals.length).toBeLessThanOrEqual(Math.ceil(wait / interval) + 1);

    const seqs = snaps.map((s) => s['snapshot_seq'] as number);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
  });

  it('acceptance (d): snapshotEveryMs 0 disables the interval and adds no live Timeout handle', async () => {
    const dir = makeDir();
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

    initTelemetry({
      service: 's1',
      role: 'live-service',
      logSink: 'file',
      logDir: dir,
      otel: false,
      snapshotEveryRecords: 0,
      snapshotEveryMs: 0,
    });
    // Give a (buggy) timer ample time to fire.
    await sleep(50);

    const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    expect(after).toBe(before);
    expect(readSnapshotRecords(dir).filter((s) => s['reason'] === 'interval')).toHaveLength(0);
    expect(telemetrySelfCheck().metric_persistence.every_ms).toBe(0);
  });

  it('acceptance (e): the typed cadence arms the timer; SOX_TRACE_SNAPSHOT_MS overrides it', async () => {
    const saved = process.env['SOX_TRACE_SNAPSHOT_MS'];
    delete process.env['SOX_TRACE_SNAPSHOT_MS'];
    try {
      // Unset typed config ⇒ the documented default floor.
      const dirDefault = makeDir();
      initTelemetry({ service: 's1', role: 'live-service', logSink: 'file', logDir: dirDefault, otel: false });
      expect(telemetrySelfCheck().metric_persistence.every_ms).toBe(60_000);

      // Typed cadence actually ARMS the timer (env unset).
      const dirTyped = makeDir();
      initTelemetry({
        service: 's1',
        role: 'live-service',
        logSink: 'file',
        logDir: dirTyped,
        otel: false,
        snapshotEveryRecords: 0,
        snapshotEveryMs: 25,
      });
      await sleep(90);
      expect(readSnapshotRecords(dirTyped).some((s) => s['reason'] === 'interval')).toBe(true);

      // The env override REPLACES the typed interval (here typed = 60 s).
      const dirEnv = makeDir();
      process.env['SOX_TRACE_SNAPSHOT_MS'] = '25';
      initTelemetry({
        service: 's1',
        role: 'live-service',
        logSink: 'file',
        logDir: dirEnv,
        otel: false,
        snapshotEveryRecords: 0,
        snapshotEveryMs: 60_000,
      });
      expect(telemetrySelfCheck().metric_persistence.every_ms).toBe(25);
      await sleep(90);
      expect(readSnapshotRecords(dirEnv).some((s) => s['reason'] === 'interval')).toBe(true);
    } finally {
      if (saved === undefined) delete process.env['SOX_TRACE_SNAPSHOT_MS'];
      else process.env['SOX_TRACE_SNAPSHOT_MS'] = saved;
    }
  });

  it('acceptance (f): logSink none/stderr writes nothing anywhere, even with a short cadence', async () => {
    for (const logSink of ['none', 'stderr'] as const) {
      const dir = makeDir();
      const handle = initTelemetry({
        service: 's1',
        role: 'live-service',
        logSink,
        logDir: dir,
        otel: false,
        snapshotEveryMs: 25,
      });
      await sleep(60);

      expect(handle.currentLogFilePath()).toBeNull();
      expect(telemetrySelfCheck().metric_persistence.file).toBeNull();
      expect(fs.readdirSync(dir)).toHaveLength(0);
      _resetTelemetryForTest();
    }
  });
});
