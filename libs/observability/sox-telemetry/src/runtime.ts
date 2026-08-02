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
}

export interface TelemetryHandle {
  readonly service: string;
  readonly role: Role;
  /** Full path of the file currently being written, '' if sink is not 'file'. */
  currentLogFilePath(): string;
  /** Await any buffered writes (only meaningful in non-durable mode). */
  flush(): Promise<void>;
  close(): void;
}

interface RuntimeState {
  service: string;
  role: Role;
  logSink: LogSink;
  sink: DurableJsonlSink | null;
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
};

/** Not memoised across calls: honours whatever `initTelemetry` most recently
 *  configured, including in tests that re-init between cases. */
export function currentRuntimeState(): Readonly<RuntimeState> {
  return _state;
}

export function initTelemetry(opts: InitTelemetryOptions): TelemetryHandle {
  _state.sink?.close();

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

  _state = { service: opts.service, role: opts.role, logSink, sink };
  resetSelfCheck();

  return {
    service: opts.service,
    role: opts.role,
    currentLogFilePath: () => _state.sink?.currentPath() ?? '',
    flush: () => _state.sink?.flush() ?? Promise.resolve(),
    close: () => {
      _state.sink?.close();
    },
  };
}

/** Test-only: drop all state back to the uninitialised default. */
export function _resetTelemetryForTest(): void {
  _state.sink?.close();
  _state = { service: 'unlabeled', role: defaultRole(), logSink: 'none', sink: null };
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

export interface TelemetrySelfCheck {
  window: 'since process start';
  role: Role;
  stages_declared: number;
  stages_with_zero_samples: string[];
  paths_with_zero_samples: string[];
  stages: StageSelfCheck[];
}

function summarize(stats: DurationStats): { count: number; mean: number; min: number; max: number } {
  return {
    count: stats.count,
    mean: stats.count > 0 ? Math.round((stats.sum / stats.count) * 100) / 100 : 0,
    min: stats.count > 0 ? stats.min : 0,
    max: stats.count > 0 ? stats.max : 0,
  };
}

export function telemetrySelfCheck(): TelemetrySelfCheck {
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
  };
}
