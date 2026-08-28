/**
 * runtime.ts — process-wide telemetry state: the sink, the `role`/`service`
 * resource attributes, and the in-memory aggregates that back
 * `telemetrySelfCheck()`.
 *
 * Nothing here requires `initTelemetry()` to have been called. Every emitter
 * is safe to call from a library that never initialises telemetry at all —
 * it falls back to a `service: 'unlabeled'`, `logSink: 'none'` no-op state
 * (BL-351 §5.0: "instrumentation is unconditionally safe to add anywhere").
 * The fallback `role` is genuinely detected (`defaultRole()`, BL-404): `'test'`
 * under NODE_ENV=test / a Vitest worker, `'harness'` otherwise — never a
 * hardcoded lie. The FIRST emission made while still in this uninitialised
 * fallback state prints a one-shot stderr warning (BL-404) so an unwired
 * composition root is self-reporting instead of silently no-op'ing forever
 * (this is exactly how BL-404 itself shipped unnoticed — a well-formed-looking
 * `role: 'test'` on the live memory-server, no error, no warning).
 * `stdout` is not a representable `LogSink` value — the type system does not
 * offer it, because a stray stdout write corrupts memory-server's MCP
 * JSON-RPC channel.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { DurableJsonlSink, type JsonlSinkOptions } from './sink.js';
import { NOOP_OTEL, type OtelMetricPoint, type OtelRuntime, type OtelState } from './otel-types.js';
import { currentTraceId } from './trace.js';

export type Role = 'live-service' | 'test' | 'cli' | 'harness';
export type LogSink = 'file' | 'stderr' | 'none';
export type Outcome = 'started' | 'finished' | 'error';

export interface InitTelemetryOptions {
  /** Resource attribute on every span/metric/log record. */
  service: string;
  /** REQUIRED, closed union. Separates the live-service population from test
   *  and harness populations sharing the same disk (BL-353). */
  role: Role;
  /** Where records land. 'file' (default in production) durably persists via
   *  `DurableJsonlSink`; 'stderr' is for local debugging; 'none' silences
   *  everything (tests that don't want log noise). Never 'stdout'. */
  logSink?: LogSink;
  /** Directory for the file sink. Defaults to
   *  `~/.adhd/sox-ecosystem/<service>/logs`. */
  logDir?: string;
  maxBytes?: number;
  maxFiles?: number;
  /** `writeSync` durability (default true — BL-365). */
  durable?: boolean;
  /**
   * BL-401 gap 4: bring up the real OpenTelemetry SDK (context manager,
   * `BasicTracerProvider` + `JsonlSpanProcessor`, pull-only `MeterProvider`).
   *
   * Defaults to **on for `live-service`/`cli`, off for `test`/`harness`** —
   * loading the SDK costs a measured 91.5 ms and 23.6 MB RSS (`otel-types.ts`),
   * which is the right price once at a composition root and the wrong price in
   * every vitest worker. Pass `true` explicitly to opt a test in.
   *
   * The SDK is loaded through a dynamic `import()`, so bring-up completes a few
   * ms AFTER `initTelemetry` returns. Nothing is lost in that window: the
   * durable JSONL sink is fully live synchronously, and the OTel span/metric
   * mirror is additive. `telemetrySelfCheck().otel.state` reports
   * `pending`/`ready`/`failed`/`disabled` rather than leaving the caller to
   * guess — the §5.3 principle that the system must report what it does not
   * yet know. `await otelReady()` if you need determinism.
   */
  otel?: boolean;
  /** Records written between activity-triggered metric snapshots (BL-401 gap 6,
   *  §5.8 option C). `0` disables the activity trigger. Default 1000. */
  snapshotEveryRecords?: number;
}

export interface TelemetryHandle {
  readonly service: string;
  readonly role: Role;
  /**
   * Where telemetry from this handle lands on disk.
   *
   * **`null` means "no file sink configured"** (`logSink: 'stderr' | 'none'`) —
   * the ONLY meaning it has. A non-null value is the file the next record will
   * be written to, whether or not anything has been written yet.
   *
   * BL-433: this used to return `''` for BOTH "no sink configured" AND "sink
   * configured, nothing written yet" — two states with opposite remedies (fix
   * your config vs. just wait) collapsed into one indistinguishable value, the
   * BL-319/BL-347 absent-field ambiguity. `''` is no longer a legal return
   * value; the two states are now distinguishable in the TYPE, so a caller
   * cannot fail to handle the difference by forgetting to.
   */
  currentLogFilePath(): string | null;
  /** Await any buffered writes (only meaningful in non-durable mode). */
  flush(): Promise<void>;
  /** Resolves once OTel bring-up has settled (immediately when `otel: false`).
   *  Never rejects — a failed bring-up is reported through
   *  `telemetrySelfCheck().otel.state`, never thrown at the composition root,
   *  because telemetry must not be able to prevent a service from starting. */
  otelReady(): Promise<void>;
  close(): void;
}

interface RuntimeState {
  service: string;
  role: Role;
  logSink: LogSink;
  sink: DurableJsonlSink | null;
  otel: OtelRuntime;
  otelState: OtelState;
}

// BL-404: previously all three branches returned 'test' unconditionally —
// the two env probes below were dead code that made the function READ as if
// it detected its environment while actually being a hardcoded constant.
// That is precisely how a live production process (memory-server, never
// under NODE_ENV=test or a Vitest worker) ended up reporting role:'test' in
// telemetry_self_check without anyone noticing: the function looked correct
// on inspection. Now the probes actually gate the result. Processes that are
// neither a detected test run nor an explicitly-initialised role (via
// `initTelemetry`) fall back to 'harness' — an honest "unlabeled, ad-hoc
// context", not a false claim of being a test.
function defaultRole(): Role {
  if (process.env['NODE_ENV'] === 'test') return 'test';
  if (process.env['VITEST_WORKER_ID'] !== undefined) return 'test';
  return 'harness';
}

/**
 * BL-501: resolve the role a composition root should actually pass to
 * `initTelemetry()`, instead of a hardcoded literal baked in at import time
 * that survives no matter how the process was really launched.
 *
 * `defaultRole()` above only fires for a process that NEVER calls
 * `initTelemetry()` at all. It does nothing for the far more common failure
 * shape this fixes: a composition root DOES call `initTelemetry({ role:
 * 'live-service' })` (or `'cli'`), unconditionally, as a literal — so every
 * spawn of that exact binary reports the exact same role regardless of who
 * spawned it or why. Two real populations collapse onto one label:
 *
 *   - a genuine production spawn (an MCP client launching memory-server, an
 *     operator running the CLI for real), vs.
 *   - a synthetic spawn of the SAME compiled/transpiled binary by an
 *     integration harness (`scripts/smoke-test.mjs` `execSync`s the real
 *     `soxe` binary, which execs the real entrypoint out-of-process) or a
 *     vitest worker importing the module in-process.
 *
 * The cross-repo instance of exactly this bug — a `role:'cli'` literal at a
 * bin-entry composition root that also (same process) dispatches a
 * long-lived `serve` mode, so 2.5-day-old server processes and true one-shot
 * CLI invocations were bitwise indistinguishable in the log's `role` field
 * during a live WAL/checkpoint corruption investigation — is documented in
 * `docs/reporting/memory/findings/2026-08-17-store-connection-lifetime-
 * forensics.md` §1d. `role` must derive from something STRUCTURAL (how the
 * process was actually started), never from a compile-time constant that
 * cannot see its own runtime context.
 *
 * `structuralDefault` is the role this composition root reports when
 * genuinely running as itself — its own real identity (`'live-service'` for
 * memory-server, `'cli'` for memory-cli). This function overrides that
 * default ONLY when a structural signal proves otherwise; absent any such
 * signal, the caller's own claimed identity is trusted as-is (this function
 * can only ever correct a mislabel toward `'harness'`, never invent a false
 * `'cli'` the way the cross-repo bug did):
 *
 *   - `SOX_TELEMETRY_HARNESS=1` — set by `scripts/smoke-test.mjs` (and any
 *     other integration harness that execs the REAL compiled/transpiled
 *     binary out-of-process to exercise it end-to-end) on every child
 *     process it launches.                                          -> 'harness'
 *
 * DELIBERATELY does NOT check `VITEST_WORKER_ID`/`NODE_ENV==='test'` the way
 * `defaultRole()` above does. Those env vars are ambient to the WHOLE vitest
 * worker process, including any `{ ...process.env, ... }` spread a spec file
 * uses to build a CHILD process's env (e.g. `bl404-telemetry-composition-
 * root.spec.ts` spawning the real entrypoint via `tsx` to black-box test it)
 * — so a vitest-inherited `VITEST_WORKER_ID` would leak into that genuinely
 * out-of-process, real-entrypoint child and mislabel it 'test', which is
 * wrong (it is not a vitest worker; it is the actual production code path
 * under black-box test). `SOX_TELEMETRY_HARNESS` has no such ambient-leak
 * problem: it is set explicitly, only by a harness that means it, and if a
 * harness-spawned process itself spawns a further child, propagating
 * `'harness'` down that chain is the CORRECT behaviour, not a bug.
 */
export function resolveProcessRole(structuralDefault: Role): Role {
  if (process.env['SOX_TELEMETRY_HARNESS'] === '1') return 'harness';
  return structuralDefault;
}

function ecosystemHome(): string {
  const override = process.env['SOX_ECOSYSTEM_HOME'];
  if (override !== undefined && override !== '') return override;
  return path.join(os.homedir(), '.adhd', 'sox-ecosystem');
}

let _state: RuntimeState = {
  service: 'unlabeled',
  role: defaultRole(),
  logSink: 'none',
  sink: null,
  otel: NOOP_OTEL,
  otelState: 'disabled',
};

/** Not memoised across calls: honours whatever `initTelemetry` most recently
 *  configured, including in tests that re-init between cases. */
export function currentRuntimeState(): Readonly<RuntimeState> {
  return _state;
}

/** The active OTel runtime, or the null object. Never null — `stages.ts` has
 *  ONE code path, not an `if (otel)` fork whose branches drift apart. */
export function _currentOtel(): OtelRuntime {
  return _state.otel;
}

let _otelReady: Promise<void> = Promise.resolve();

/** Resolves once OTel bring-up has settled. Never rejects. */
export function otelReady(): Promise<void> {
  return _otelReady;
}

/** OTel defaults ON at a real composition root and OFF under test, because the
 *  SDK costs 91.5 ms + 23.6 MB to load and a vitest worker pays that per file. */
function otelDefaultFor(role: Role): boolean {
  return role === 'live-service' || role === 'cli';
}

export function initTelemetry(opts: InitTelemetryOptions): TelemetryHandle {
  _state.sink?.close();
  void _state.otel.shutdown();

  const logSink = opts.logSink ?? 'file';
  let sink: DurableJsonlSink | null = null;
  if (logSink === 'file') {
    const dir = opts.logDir ?? path.join(ecosystemHome(), opts.service, 'logs');
    // Role-qualified component (BL-353 §5.1): '.' separator, never '-', so the
    // pruning anchor in DurableJsonlSink can never treat 'memory-core' and
    // 'memory-core.live' as the same prefix.
    const component = `${opts.service}.${opts.role}`;
    // Built incrementally (rather than passing `maxBytes: opts.maxBytes`
    // directly) because `exactOptionalPropertyTypes` treats an explicit
    // `undefined` assignment to an optional field as distinct from omitting
    // the field entirely — passing through an unset `opts.maxBytes` would be
    // a type error against `JsonlSinkOptions['maxBytes']: number | undefined`
    // not being assignable to the narrower `number | undefined` optional-omit
    // contract the sink declares.
    const sinkOpts: JsonlSinkOptions = { dir, component };
    if (opts.maxBytes !== undefined) sinkOpts.maxBytes = opts.maxBytes;
    if (opts.maxFiles !== undefined) sinkOpts.maxFiles = opts.maxFiles;
    if (opts.durable !== undefined) sinkOpts.durable = opts.durable;
    sink = new DurableJsonlSink(sinkOpts);
  }

  const wantOtel = opts.otel ?? otelDefaultFor(opts.role);
  _state = {
    service: opts.service,
    role: opts.role,
    logSink,
    sink,
    otel: NOOP_OTEL,
    otelState: wantOtel ? 'pending' : 'disabled',
  };
  _snapshotEveryRecords = opts.snapshotEveryRecords ?? resolveSnapshotEveryRecords();
  _recordsSinceSnapshot = 0;
  resetSelfCheck();
  configureSnapshotSink(opts, logSink);

  if (wantOtel) {
    const generation = _state;
    _otelReady = import('./otel.js')
      .then(({ bringUpOtel }) => {
        // A second initTelemetry() may have landed while the SDK was loading;
        // do not resurrect telemetry for a superseded configuration.
        if (_state !== generation) return;
        _state.otel = bringUpOtel({
          service: opts.service,
          role: opts.role,
          emit: (event, level, fields) => emitRecord(event, level, fields),
        });
        _state.otelState = 'ready';
      })
      .catch((err: unknown) => {
        if (_state !== generation) return;
        _state.otelState = 'failed';
        // Loud, once, on stderr — never stdout (MCP JSON-RPC channel). A
        // silently-absent SDK is the BL-404 shape all over again.
        process.stderr.write(
          `[sox-telemetry] WARNING: OpenTelemetry bring-up failed (${
            err instanceof Error ? err.message : String(err)
          }); spans/metrics are no-ops, durable JSONL is unaffected (BL-401).\n`,
        );
      });
  } else {
    _otelReady = Promise.resolve();
  }

  return {
    service: opts.service,
    role: opts.role,
    // BL-433: `plannedPath()`, not `currentPath()` — the question a caller is
    // asking is "where do I look?", which has an answer before the first write.
    // `null` is reserved for the one state that genuinely has no answer.
    currentLogFilePath: () => _state.sink?.plannedPath() ?? null,
    flush: () => _state.sink?.flush() ?? Promise.resolve(),
    otelReady: () => _otelReady,
    close: () => {
      // §5.8: a snapshot on graceful shutdown, so the final window of
      // non-recomputable state (counters, sink drop counts) is not lost.
      void snapshotMetrics('shutdown').finally(() => {
        void _state.otel.shutdown();
        _state.sink?.close();
        closeSnapshotSink();
      });
    },
  };
}

/** Test-only: drop all state back to the uninitialised default. */
export function _resetTelemetryForTest(): void {
  _state.sink?.close();
  void _state.otel.shutdown();
  closeSnapshotSink();
  stopSnapshotTimer();
  _state = {
    service: 'unlabeled',
    role: defaultRole(),
    logSink: 'none',
    sink: null,
    otel: NOOP_OTEL,
    otelState: 'disabled',
  };
  _otelReady = Promise.resolve();
  _recordsSinceSnapshot = 0;
  _snapshotsWritten = 0;
  _warnedUnlabeled = false;
  resetSelfCheck();
}

// ── Emission ─────────────────────────────────────────────────────────────

export interface LogFields {
  [key: string]: unknown;
}

// BL-404: fires once per process, the first time anything is emitted while
// `initTelemetry()` has never been called. `service === 'unlabeled'` is the
// unambiguous signal — it is the literal default in `_state` above and is
// never a value a real caller would pass to `initTelemetry` (BL-353 requires
// a real service name). Deliberately independent of `st.logSink === 'none'`
// short-circuit below: the whole point is that the uninitialised state is
// ALSO the silent no-op sink, so this is the one path that must not be
// silent.
let _warnedUnlabeled = false;
function warnIfUnlabeled(st: RuntimeState): void {
  if (_warnedUnlabeled || st.service !== 'unlabeled') return;
  _warnedUnlabeled = true;
  process.stderr.write(
    '[sox-telemetry] WARNING: emitting with no initTelemetry() call in this process ' +
      `(role:'${st.role}', logSink:'none' — records are being silently dropped). ` +
      'Call initTelemetry({ service, role, logSink }) at process startup, before any ' +
      'handler can emit, or this process\'s telemetry is a permanent no-op (BL-404).\n',
  );
}

function emitRecord(event: string, level: 'debug' | 'info' | 'warn' | 'error', fields?: LogFields): void {
  try {
    const st = _state;
    warnIfUnlabeled(st);
    if (st.logSink === 'none') return;
    const traceId =
      (fields && typeof fields['trace_id'] === 'string' ? (fields['trace_id'] as string) : undefined) ??
      currentTraceId() ??
      null;
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      event,
      service: st.service,
      role: st.role,
      trace_id: traceId,
      pid: process.pid,
      ...fields,
    };
    const line = JSON.stringify(record) + '\n';
    if (st.logSink === 'file' && st.sink) {
      st.sink.write(line);
    } else if (st.logSink === 'stderr') {
      process.stderr.write(line);
    }
    noteRecordWritten();
  } catch {
    // Telemetry must NEVER break or slow the caller.
  }
}

export const log = {
  debug: (event: string, fields?: LogFields): void => emitRecord(event, 'debug', fields),
  info: (event: string, fields?: LogFields): void => emitRecord(event, 'info', fields),
  warn: (event: string, fields?: LogFields): void => emitRecord(event, 'warn', fields),
  error: (event: string, fields?: LogFields): void => emitRecord(event, 'error', fields),
};

export { emitRecord as _emitRecord };

// ── Self-check aggregation (BL-351 §5.3, §5.7) ──────────────────────────────
//
// In-memory, since-process-start counters. NOT a replacement for replaying the
// JSONL stream (which is the durable, cross-restart source of truth per §5.8)
// — this is the live view `memory_ping`/`memory_stats` reads with zero I/O.
// Every field is explicitly labelled "since process start" per §5.8's warning
// against unlabelled cumulative counters (the BL-334 pattern).

interface PathCounts {
  started: number;
  finished: number;
  error: number;
}

interface DurationStats {
  count: number;
  sum: number;
  min: number;
  max: number;
}

interface StageAggregate {
  paths: Map<string, PathCounts>;
  wait: DurationStats;
  work: DurationStats;
}

const stageDeclarations = new Map<string, { pkg: string; paths: readonly string[] }>();
const stageAggregates = new Map<string, StageAggregate>();

function newDurationStats(): DurationStats {
  return { count: 0, sum: 0, min: Infinity, max: -Infinity };
}

function recordDuration(stats: DurationStats, ms: number): void {
  stats.count += 1;
  stats.sum += ms;
  if (ms < stats.min) stats.min = ms;
  if (ms > stats.max) stats.max = ms;
}

export function _registerStageDeclaration(key: string, pkg: string, paths: readonly string[]): void {
  stageDeclarations.set(key, { pkg, paths });
  if (!stageAggregates.has(key)) {
    stageAggregates.set(key, { paths: new Map(), wait: newDurationStats(), work: newDurationStats() });
  }
}

export function _recordStageOutcome(stageKey: string, pathName: string, outcome: Outcome): void {
  let agg = stageAggregates.get(stageKey);
  if (!agg) {
    agg = { paths: new Map(), wait: newDurationStats(), work: newDurationStats() };
    stageAggregates.set(stageKey, agg);
  }
  let pc = agg.paths.get(pathName);
  if (!pc) {
    pc = { started: 0, finished: 0, error: 0 };
    agg.paths.set(pathName, pc);
  }
  pc[outcome] += 1;
}

export function _recordStageDuration(stageKey: string, phase: 'wait' | 'work', ms: number): void {
  const agg = stageAggregates.get(stageKey);
  if (!agg) return;
  recordDuration(phase === 'wait' ? agg.wait : agg.work, ms);
}

function resetSelfCheck(): void {
  stageAggregates.clear();
  for (const [key, decl] of stageDeclarations) {
    stageAggregates.set(key, { paths: new Map(), wait: newDurationStats(), work: newDurationStats() });
    void decl;
  }
  resetChildTelemetry();
}

// ── Child telemetry accounting (BL-618) ─────────────────────────────────────
//
// In-memory, since-process-start counters + a bounded ring. The PARENT records
// every child it forks/spawns (`_recordChildTelemetry`), whether or not the
// child ever acks its own telemetry state — so a child that silently drops its
// records (the BL-618 defect: no `initTelemetry` in the fork child) shows up as
// `unacked_with_success` here instead of leaving the parent with no signal at
// all that it spawned anything.

const CHILD_TELEMETRY_RING_MAX = 20;

const childTelemetryCounters = {
  spawned: 0,
  acked_with_sink: 0,
  acked_without_sink: 0,
  unacked_with_success: 0,
};
const childTelemetryRing: ChildTelemetryRecord[] = [];

/** Record one child telemetry observation (spawned/acked/unacked). Never throws. */
export function _recordChildTelemetry(rec: ChildTelemetryRecord): void {
  if (rec.acked === true) {
    if (rec.logSink === 'file' && typeof rec.filePath === 'string') {
      childTelemetryCounters.acked_with_sink += 1;
    } else {
      childTelemetryCounters.acked_without_sink += 1;
    }
  } else if (rec.unacked === true) {
    childTelemetryCounters.unacked_with_success += 1;
  } else {
    childTelemetryCounters.spawned += 1;
  }
  childTelemetryRing.push(rec);
  if (childTelemetryRing.length > CHILD_TELEMETRY_RING_MAX) childTelemetryRing.shift();
}

function resetChildTelemetry(): void {
  childTelemetryCounters.spawned = 0;
  childTelemetryCounters.acked_with_sink = 0;
  childTelemetryCounters.acked_without_sink = 0;
  childTelemetryCounters.unacked_with_success = 0;
  childTelemetryRing.length = 0;
}

export interface StageSelfCheck {
  stage: string;
  package: string;
  wait_ms: { count: number; mean: number; min: number; max: number };
  work_ms: { count: number; mean: number; min: number; max: number };
  /** `starts - (finishes + errors)`, per declared path. A process killed
   *  mid-operation is indistinguishable from a hang by this method (BL-353's
   *  caveat) — treat as an upper bound and a lead, not a verdict. */
  unaccounted: Record<string, number>;
}

/**
 * A single child-process/worker telemetry observation, recorded by the parent
 * via `_recordChildTelemetry`. A record is one of three kinds, distinguished by
 * which of the optional flags is set (and by presence in the `recent` ring):
 *   - `spawned` (neither flag): the parent forked/spawned the child with a
 *     known intended config.
 *   - `acked` (`acked: true`): the child's `telemetry.ready` arrived, carrying
 *     the child's OWN reported `service`/`role`/`logSink`/`filePath`.
 *   - `unacked` (`unacked: true`): the child settled successfully without ever
 *     acking — a child whose telemetry never initialised (BL-618's signal).
 */
export interface ChildTelemetryRecord {
  service: string;
  role: Role;
  logSink: LogSink;
  /** Non-null iff `logSink === 'file'` — the file the child's records land in. */
  filePath: string | null;
  pid: number;
  /** Call site that spawned the child (e.g. 'enrich', 'embedding-provider'). */
  source?: string;
  /** Present + true on a child's `telemetry.ready` ack. */
  acked?: boolean;
  /** Present + true when a child settled successfully without ever acking. */
  unacked?: boolean;
}

export interface ChildrenTelemetrySelfCheck {
  /** Children this process has forked/spawned since process start. */
  spawned: number;
  /** Children that acked telemetry AND reported a file sink. */
  acked_with_sink: number;
  /** Children that acked telemetry but reported no file sink (stderr/none). */
  acked_without_sink: number;
  /** Children that settled successfully without ever acking telemetry. */
  unacked_with_success: number;
  /** The most recent {@link CHILD_TELEMETRY_RING_MAX} records, newest last. */
  recent: ChildTelemetryRecord[];
}

export interface TelemetrySelfCheck {
  window: 'since process start';
  role: Role;
  stages_declared: number;
  stages_with_zero_samples: string[];
  paths_with_zero_samples: string[];
  stages: StageSelfCheck[];
  /** BL-618: spawn-time child telemetry accounting — makes no-op children
   *  (forked/spawned but never initialised) visible to the parent's self-check. */
  children: ChildrenTelemetrySelfCheck;
  /** BL-401 gap 4. `state` is `disabled` (never asked for), `pending` (the
   *  dynamic `import()` has not settled), `ready`, or `failed`. Reported rather
   *  than inferred: "no spans" and "SDK never came up" are otherwise the same
   *  silence, which is the BL-319/BL-404 failure shape. */
  otel: { state: OtelState; spans_enabled: boolean };
  /** BL-401 gap 6. `written` counts durable `metrics.snapshot` lines this
   *  process has emitted; `records_since` is how much un-snapshotted activity
   *  is currently at risk from a SIGKILL. `every_records: 0` means the activity
   *  trigger is off and only pull/shutdown snapshots occur. */
  /** BL-433: `file` is `null` — never `''` — when no snapshot sink is configured,
   *  and otherwise the path the next snapshot lands in, written or not. */
  metric_persistence: { written: number; records_since: number; every_records: number; file: string | null };
}

function summarize(stats: DurationStats): { count: number; mean: number; min: number; max: number } {
  return {
    count: stats.count,
    mean: stats.count > 0 ? Math.round((stats.sum / stats.count) * 100) / 100 : 0,
    min: stats.count > 0 ? stats.min : 0,
    max: stats.count > 0 ? stats.max : 0,
  };
}

/** The public pull. Also the §5.8 option-A opportunistic snapshot trigger —
 *  kept OUT of `telemetrySelfCheckCore()` so the snapshot writer can read the
 *  aggregate without re-triggering itself. */
export function telemetrySelfCheck(): TelemetrySelfCheck {
  // Read BEFORE triggering. The snapshot resets `records_since`, so triggering
  // first would make the field this surface exists to expose — how much
  // un-snapshotted state is at risk — read `0` on every single pull, i.e. a
  // number that is always reassuring and never true.
  const view = telemetrySelfCheckCore();
  scheduleOpportunisticSnapshot();
  return view;
}

function telemetrySelfCheckCore(): TelemetrySelfCheck {
  const stagesWithZero: string[] = [];
  const pathsWithZero: string[] = [];
  const stages: StageSelfCheck[] = [];

  for (const [key, decl] of stageDeclarations) {
    const agg = stageAggregates.get(key) ?? { paths: new Map(), wait: newDurationStats(), work: newDurationStats() };
    let stageSampled = false;
    const unaccounted: Record<string, number> = {};
    for (const pathName of decl.paths) {
      const pc = agg.paths.get(pathName);
      const started = pc?.started ?? 0;
      const finished = pc?.finished ?? 0;
      const error = pc?.error ?? 0;
      if (started === 0) {
        pathsWithZero.push(`${key}:${pathName}`);
      } else {
        stageSampled = true;
      }
      unaccounted[pathName] = started - (finished + error);
    }
    if (!stageSampled) stagesWithZero.push(key);
    stages.push({
      stage: key,
      package: decl.pkg,
      wait_ms: summarize(agg.wait),
      work_ms: summarize(agg.work),
      unaccounted,
    });
  }

  return {
    window: 'since process start',
    role: _state.role,
    stages_declared: stageDeclarations.size,
    stages_with_zero_samples: stagesWithZero,
    paths_with_zero_samples: pathsWithZero,
    stages,
    children: {
      spawned: childTelemetryCounters.spawned,
      acked_with_sink: childTelemetryCounters.acked_with_sink,
      acked_without_sink: childTelemetryCounters.acked_without_sink,
      unacked_with_success: childTelemetryCounters.unacked_with_success,
      recent: childTelemetryRing.slice(),
    },
    otel: { state: _state.otelState, spans_enabled: _state.otel.enabled },
    metric_persistence: {
      written: _snapshotsWritten,
      records_since: _recordsSinceSnapshot,
      every_records: _snapshotEveryRecords,
      file: _snapshotSink?.plannedPath() ?? null,
    },
  };
}

// ── Metric persistence (BL-401 gap 6, §5.8) ─────────────────────────────────
//
// `telemetrySelfCheck()` is a live in-memory view and a crash takes it with
// it. §5.8's reframing is what makes fixing that cheap: stage histograms are
// RECOMPUTABLE by replaying the span records already on disk, so only the
// non-recomputable state (cumulative counters, gauges, sink-drop counts) truly
// needs its own durable copy — and only as often as that state changes.
//
// Triggers, per §5.8's costing:
//   C (PRIMARY)  every N records written — no timer, so the zero-handle
//                property (§3.3/BL-345) survives intact, and staleness is
//                bounded by WORK DONE rather than wall-clock. An idle process
//                has nothing to lose and snapshots nothing.
//   A            opportunistically on the `telemetrySelfCheck()` pull.
//   shutdown     on `handle.close()`.
//   D (opt-in)   `SOX_TRACE_SNAPSHOT_MS` — an .unref()'d interval for a
//                deliberate debugging session. OFF by default: it is the only
//                option that costs a handle.
//
// Option B (piggyback the periodic enrich tick) is deliberately NOT used:
// persistence that silently stops when an unrelated subsystem changes is worse
// than no persistence at all — and the enrich tick's cadence is not this
// ledger's to borrow (the old `SOX_DISABLE_PERIODIC_ENRICH` brake is gone,
// ADR-0013, so the tick is always on, but coupling two subsystems' liveness is
// still the wrong shape).

const DEFAULT_SNAPSHOT_EVERY_RECORDS = 1000;

function resolveSnapshotEveryRecords(): number {
  const raw = process.env['SOX_TRACE_SNAPSHOT_EVERY'];
  if (raw === undefined || raw === '') return DEFAULT_SNAPSHOT_EVERY_RECORDS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SNAPSHOT_EVERY_RECORDS;
}

let _snapshotSink: DurableJsonlSink | null = null;
let _snapshotEveryRecords = DEFAULT_SNAPSHOT_EVERY_RECORDS;
let _recordsSinceSnapshot = 0;
let _snapshotsWritten = 0;
let _snapshotInFlight = false;
let _snapshotTimer: ReturnType<typeof setInterval> | null = null;

/**
 * §5.8's first consequence, implemented: the snapshot gets its OWN component,
 * and therefore its own rotation/retention budget. Sharing the event stream's
 * files would prune checkpoints alongside the very events they exist to
 * outlive — at which point "recomputable by replay" quietly becomes false at
 * exactly the ages where it was the whole point.
 *
 * The component separator is `.`, never `-` (§5.8's prefix-collision footgun:
 * a pruner anchored on `memory-server-` also matches `memory-server-live-…`).
 */
function configureSnapshotSink(opts: InitTelemetryOptions, logSink: LogSink): void {
  closeSnapshotSink();
  if (logSink !== 'file') return;
  const dir = opts.logDir ?? path.join(ecosystemHome(), opts.service, 'logs');
  const sinkOpts: JsonlSinkOptions = { dir, component: `${opts.service}.${opts.role}.metrics-snapshot` };
  if (opts.maxFiles !== undefined) sinkOpts.maxFiles = opts.maxFiles;
  _snapshotSink = new DurableJsonlSink(sinkOpts);

  stopSnapshotTimer();
  const everyMs = Number.parseInt(process.env['SOX_TRACE_SNAPSHOT_MS'] ?? '', 10);
  if (Number.isFinite(everyMs) && everyMs > 0) {
    _snapshotTimer = setInterval(() => {
      void snapshotMetrics('interval');
    }, everyMs);
    // .unref() keeps `getActiveResourcesInfo()` empty and does not hold the
    // event loop open — measured in §5.9. Without it, opting into option D
    // would make the process immortal.
    _snapshotTimer.unref();
  }
}

function closeSnapshotSink(): void {
  _snapshotSink?.close();
  _snapshotSink = null;
}

function stopSnapshotTimer(): void {
  if (_snapshotTimer !== null) {
    clearInterval(_snapshotTimer);
    _snapshotTimer = null;
  }
}

function noteRecordWritten(): void {
  _recordsSinceSnapshot += 1;
  if (_snapshotEveryRecords > 0 && _recordsSinceSnapshot >= _snapshotEveryRecords) {
    void snapshotMetrics('activity');
  }
}

function scheduleOpportunisticSnapshot(): void {
  if (_recordsSinceSnapshot > 0) void snapshotMetrics('pull');
}

/**
 * Write one durable `metrics.snapshot` line. Never throws and never rejects —
 * it is called from the emission hot path.
 *
 * Deliberately NOT routed through `emitRecord`: that would increment the
 * activity counter it is resetting and recurse, and it would put a large
 * aggregate line into the event stream whose retention it must outlive.
 */
export async function snapshotMetrics(reason: 'activity' | 'pull' | 'shutdown' | 'interval'): Promise<void> {
  if (_snapshotInFlight) return;
  const sink = _snapshotSink;
  if (!sink) {
    _recordsSinceSnapshot = 0;
    return;
  }
  _snapshotInFlight = true;
  const covered = _recordsSinceSnapshot;
  _recordsSinceSnapshot = 0;
  try {
    let otelMetrics: OtelMetricPoint[] = [];
    try {
      otelMetrics = await _state.otel.collect();
    } catch {
      otelMetrics = [];
    }
    const stagesView = telemetrySelfCheckCore();
    const record = {
      ts: new Date().toISOString(),
      level: 'info',
      event: 'metrics.snapshot',
      service: _state.service,
      role: _state.role,
      pid: process.pid,
      trace_id: null,
      reason,
      // §5.8's second consequence: a cumulative counter without its window is
      // an unfalsifiable number (the BL-334 pattern). Both windows are stated.
      window: 'since process start',
      records_covered: covered,
      snapshot_seq: _snapshotsWritten + 1,
      self_check: stagesView,
      otel_metrics: otelMetrics,
    };
    sink.write(JSON.stringify(record) + '\n');
    _snapshotsWritten += 1;
  } catch {
    // A snapshot failure must never break or slow the caller.
  } finally {
    _snapshotInFlight = false;
  }
}

/** Test seam: number of durable snapshots this process has written. */
export function _snapshotCountForTest(): number {
  return _snapshotsWritten;
}
