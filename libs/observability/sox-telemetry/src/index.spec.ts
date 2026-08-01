import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  initTelemetry,
  _resetTelemetryForTest,
  declareStages,
  telemetrySelfCheck,
  withTimedEvent,
  DurableJsonlSink,
  log,
} from './index.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sox-telemetry-spec-'));
}

function readRecords(logFilePath: string): Record<string, unknown>[] {
  if (!fs.existsSync(logFilePath)) return [];
  return fs
    .readFileSync(logFilePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('initTelemetry — role is required and stamped on every record', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    _resetTelemetryForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stamps service+role on every emitted record, never stdout', () => {
    const handle = initTelemetry({ service: 'spec-svc', role: 'live-service', logDir: dir });
    log.info('probe.event', { some_field: 1 });
    const records = readRecords(handle.currentLogFilePath());
    expect(records).toHaveLength(1);
    expect(records[0]?.['service']).toBe('spec-svc');
    expect(records[0]?.['role']).toBe('live-service');
    expect(records[0]?.['some_field']).toBe(1);
    // logSink type does not admit 'stdout' at all — compile-time guarantee;
    // the runtime guarantee is that the only sinks are file/stderr/none.
  });
});

describe('DurableJsonlSink — BL-365 crash-durability (writeSync, no buffering)', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a record is readable on disk immediately after write() returns, with no flush/await', () => {
    const sink = new DurableJsonlSink({ dir, component: 'spec-durable' });
    sink.write('{"event":"a"}\n');
    // No await, no flush() call — if this were the pre-BL-365 buffered stream,
    // the write would still be sitting in the stream's internal buffer and
    // this synchronous read would race it. writeSync makes the race disappear.
    const onDisk = fs.readFileSync(sink.currentPath(), 'utf8');
    expect(onDisk).toBe('{"event":"a"}\n');
    sink.close();
  });

  it('pruning is anchored on the full <component>-<date> shape, not a bare prefix (BL-351 §5.8 footgun)', () => {
    const sink = new DurableJsonlSink({ dir, component: 'memory-core', maxBytes: 1, maxFiles: 1 });
    // A file belonging to an UNRELATED, role-qualified component that merely
    // starts with the same characters once you drop the anchor.
    const liveFile = path.join(dir, 'memory-core.live-2026-08-01.jsonl');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(liveFile, '{"event":"must-survive"}\n');

    // Force several rotations on the 'memory-core' component (maxBytes: 1 —
    // every write rotates) so the pruner runs repeatedly.
    sink.write('{"event":"1"}\n');
    sink.write('{"event":"2"}\n');
    sink.write('{"event":"3"}\n');
    sink.close();

    expect(fs.existsSync(liveFile)).toBe(true);
    expect(fs.readFileSync(liveFile, 'utf8')).toContain('must-survive');
  });

  it('reconfigure() takes effect on the NEXT write without constructing a new sink (per-call env-read migration path)', () => {
    const dirA = tmpDir();
    const dirB = tmpDir();
    const sink = new DurableJsonlSink({ dir: dirA, component: 'reconf' });
    sink.write('{"event":"in-a"}\n');
    expect(sink.currentPath()).toContain(dirA);

    // Simulate a caller re-resolving an env var (SOX_MEMORY_LOG_DIR-style)
    // before every write, exactly memory-core's per-call contract.
    sink.reconfigure({ dir: dirB, component: 'reconf' });
    sink.write('{"event":"in-b"}\n');
    expect(sink.currentPath()).toContain(dirB);
    expect(fs.readFileSync(sink.currentPath(), 'utf8')).toContain('in-b');
    // The first file is untouched, not overwritten or migrated.
    const fileA = fs.readdirSync(dirA).find((f) => f.endsWith('.jsonl'));
    expect(fileA).toBeDefined();
    expect(fs.readFileSync(path.join(dirA, fileA!), 'utf8')).toContain('in-a');

    sink.close();
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });
});

describe('withTimedEvent — START is durable before the awaited call resolves (hang visibility)', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    _resetTelemetryForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('logs <event>.start durably even if the wrapped function never resolves', async () => {
    const handle = initTelemetry({ service: 'spec-svc', role: 'test', logDir: dir });
    // A promise that deliberately never settles — models a hung operation.
    const hang = new Promise<void>(() => {});

    // Fire-and-forget: intentionally do not await the hung operation.
    void withTimedEvent('probe.op', {}, () => hang);

    // Give the microtask queue one tick so the synchronous start-log inside
    // withTimedEvent (which runs before `await fn()`) has definitely happened.
    await new Promise((r) => setTimeout(r, 10));

    const records = readRecords(handle.currentLogFilePath());
    const events = records.map((r) => r['event']);
    expect(events).toContain('probe.op.start');
    expect(events).not.toContain('probe.op.finish'); // never finishes — that's the point
  });
});

describe('withContendedStage — wait/work emitted as a pair; declared paths make omission visible (BL-319)', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    _resetTelemetryForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('RED: an unexercised declared path is reported by telemetrySelfCheck; GREEN once both paths run', async () => {
    initTelemetry({ service: 'spec-svc', role: 'test', logDir: dir });
    const stages = declareStages('spec-pkg', {
      embed: { paths: ['write', 'heal'] as const },
    });

    // Only the 'write' path runs.
    await stages.withContendedStage(
      'embed',
      'write',
      () => Promise.resolve(),
      () => Promise.resolve('ok'),
    );

    const redCheck = telemetrySelfCheck();
    expect(redCheck.paths_with_zero_samples).toContain('spec-pkg.embed:heal');

    // Now the sibling 'heal' path runs too.
    await stages.withContendedStage(
      'embed',
      'heal',
      () => Promise.resolve(),
      () => Promise.resolve('ok'),
    );

    const greenCheck = telemetrySelfCheck();
    expect(greenCheck.paths_with_zero_samples).not.toContain('spec-pkg.embed:heal');
    expect(greenCheck.stages_with_zero_samples).toEqual([]);

    // Wait/work are always emitted together, never one without the other.
    const stageResult = greenCheck.stages.find((s) => s.stage === 'spec-pkg.embed');
    expect(stageResult).toBeDefined();
    expect(stageResult!.wait_ms.count).toBe(2);
    expect(stageResult!.work_ms.count).toBe(2);
    expect(stageResult!.unaccounted['write']).toBe(0);
    expect(stageResult!.unaccounted['heal']).toBe(0);
  });

  it('an error in work() still records the pair and counts as unaccounted-safe (started, error, no finish)', async () => {
    initTelemetry({ service: 'spec-svc', role: 'test', logDir: dir });
    const stages = declareStages('spec-pkg-2', {
      risky: { paths: ['only'] as const },
    });

    await expect(
      stages.withContendedStage(
        'risky',
        'only',
        () => Promise.resolve(),
        () => Promise.reject(new Error('boom')),
      ),
    ).rejects.toThrow('boom');

    const check = telemetrySelfCheck();
    const stage = check.stages.find((s) => s.stage === 'spec-pkg-2.risky');
    expect(stage!.unaccounted['only']).toBe(0); // started=1, error=1 -> 1-(0+1)=0
  });
});
