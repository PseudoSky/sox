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

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DurableJsonlSink, type JsonlSinkOptions } from './sink.js';
import { NOOP_OTEL, type OtelMetricPoint, type OtelRuntime, type OtelState } from './otel-types.js';
import { currentTraceId } from './trace.js';
import { aggregateSnapshots, type MetricsSnapshotRecord, type RollupRow } from './rollup.js';

export type Role = 'live-service' | 'test' | 'cli' | 'harness';
export type LogSink = 'file' | 'stderr' | 'none';
export type Outcome = 'started' | 'finished' | 'error';
/** When a rollup pass ran — `'interval'` on the S1 cadence tick, `'shutdown'`
 *  once on `handle.close()` before the sinks are closed. Never human-invoked. */
export type RollupReason = 'interval' | 'shutdown';

/**
 * Durable-metrics S3 (`5ac0a1a8…`): the RELEASE identity stamped onto every
 * persisted `metrics.snapshot` row, so snapshots from different releases are
 * differentiable and programmatically comparable.
 *
 * Every field is `string | null` on purpose — an unavailable value is `null`,
 * NEVER `''` (the BL-433 spirit: `''` is a legal-looking string indistinguishable
 * from a real value, the BL-319/BL-347 absent-field ambiguity). The three
 * resolvers answer three distinct questions:
 *   - `version`         — the running artifact's declared semver, else null.
 *   - `artifact_sha256` — exact byte identity of the running code, else null.
 *   - `git_sha`         — the source revision the artifact was built from, else null.
 */
export interface ReleaseIdentity {
  version: string | null;
  artifact_sha256: string | null;
  git_sha: string | null;
}

/** The all-absent release identity — the uninitialised/default state, and the
 *  normalised result whenever a caller passes nothing. */
const NULL_RELEASE: ReleaseIdentity = { version: null, artifact_sha256: null, git_sha: null };

/** Normalise one release field: a non-empty string passes through, everything
 *  else (`undefined`, `null`, `''`) becomes `null` — never `''`, never
 *  `undefined` (S3's contract; `''` and `undefined` are not values here). */
function releaseField(v: string | null | undefined): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Normalise a caller-supplied {@link ReleaseIdentity} — per-field, so a partial
 *  object fills the omitted fields with `null` rather than inheriting anything. */
function resolveRelease(raw: ReleaseIdentity | undefined): ReleaseIdentity {
  if (raw === undefined) return NULL_RELEASE;
  return {
    version: releaseField(raw.version),
    artifact_sha256: releaseField(raw.artifact_sha256),
    git_sha: releaseField(raw.git_sha),
  };
}

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
  /**
   * Retention cap for the SNAPSHOT component's rotated files (durable-metrics
   * S2). Kept distinct from {@link maxFiles} (the EVENT stream's cap) so the
   * durable `metrics.snapshot` series can span releases while the high-volume
   * event stream stays small.
   *
   * Precedence — the snapshot sink resolves its cap as
   * `snapshotMaxFiles ?? maxFiles ?? 30`. An explicit `maxFiles` still governs
   * BOTH sinks (the pre-S2 behaviour other callers depend on); only the DEFAULT
   * diverges — event 7, snapshot 30. The rollup sink (S8) will sit above this:
   * `rollupMaxFiles ?? snapshotMaxFiles ?? maxFiles ?? 30`.
   *
   * Hard-floored at 1 by the pruner: `0` (or a negative value) keeps exactly one
   * file — the newest is never deleted. Typed config only (ADR-0013); there is
   * no environment override for this.
   */
  snapshotMaxFiles?: number;
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
  /**
   * Wall-clock floor (ms) between interval-triggered metric snapshots (979c54…,
   * durable-metrics S1). Guards against the record trigger's blind spot: a
   * process that restarts before it ever accumulates `snapshotEveryRecords`
   * writes NOTHING, so a release window full of restarts leaves no durable
   * series at all. `0` disables the interval trigger. Default 60_000.
   *
   * Typed config only (ADR-0013). `SOX_TRACE_SNAPSHOT_MS` remains as a debug
   * OVERRIDE that replaces this interval; it is never the sole trigger (the
   * default above always arms one). The timer is `.unref()`'d, so it adds no
   * live handle (BL-345) — `getActiveResourcesInfo()` stays empty.
   */
  snapshotEveryMs?: number;
  /**
   * Durable-metrics S3 (`5ac0a1a8…`): the RELEASE identity stamped onto every
   * persisted `metrics.snapshot` row. All three fields are `string | null` and
   * an omitted value normalises to `null` — never `''`, never `undefined`.
   *
   * Typed config only (ADR-0013): there is no environment override for any of
   * the three fields; a caller that cannot resolve one MUST pass `null`.
   */
  release?: ReleaseIdentity;
  /**
   * Durable-metrics S8 (`6df0d673…`): the trailing window (ms) the continuous
   * rollup folds over. Re-derived on every tick (`from = now − window`, `to =
   * now`) — consecutive rows deliberately OVERLAP and each is self-describing
   * via `window.from`/`window.to`. Default `3_600_000` (one hour): long enough
   * to smooth a 60 s cadence, short enough to reflect the current release.
   *
   * Typed config only (ADR-0013): no new environment var. The rollup runs on
   * the S1 interval (`snapshotEveryMs`); `snapshotEveryMs: 0` disables BOTH the
   * snapshot and the rollup (there is nothing to fold).
   */
  rollupWindowMs?: number;
  /**
   * Durable-metrics S8: directory for the rollup cache. Defaults to
   * `<resolved logDir>/rollup`, i.e. production lands at
   * `~/.adhd/sox-ecosystem/<service>/logs/rollup/`. Nesting under `logDir`
   * (rather than a sibling of it) transfers the test-isolation seam for free —
   * specs pass `logDir`, production does not — and is structurally
   * collision-safe: a `rollup/` SUBDIRECTORY cannot match `DurableJsonlSink`'s
   * anchored FILE regex (`sink.ts`'s `_pruneOldFiles`), so neither sink's prune
   * can ever walk into the other's files.
   */
  rollupDir?: string;
  /**
   * Durable-metrics S8: retention cap for the rollup cache's rotated files.
   * Default `30`. A rollup file is a DERIVED CACHE — every row is recomputable
   * from the retained snapshots it folded — so pruning a rollup destroys no
   * information. This is a cache-size knob, NOT primary retention, and is
   * deliberately distinct from ADR-0014's report-first/no-auto-delete rule for
   * the primary store snapshots. Hard-floored at 1 by the pruner.
   *
   * Precedence: `rollupMaxFiles ?? snapshotMaxFiles ?? maxFiles ?? 30`.
   */
  rollupMaxFiles?: number;
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
  /** S3 (`5ac0a1a8…`): normalised release identity; always all-three-present
   *  (each `string | null`), so the snapshot record never carries `undefined`. */
  release: ReleaseIdentity;
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

// ── Process-wide singleton runtime (BL-404 duplicate-module hazard) ─────────
//
// Everything mutable in this module lives in ONE object keyed on `globalThis`
// rather than in module-level `let` bindings. This is not a style choice — it
// is the fix for the BL-404 "emitting with no initTelemetry()" warning firing
// from a DUPLICATE installed copy of this package.
//
// The defect: `@adhd/sox-telemetry` can be installed more than once in a single
// process — a top-level copy (e.g. 0.3.0, whose `initTelemetry` a consumer
// called) and a nested copy (e.g. 0.2.1 under a dependency's own
// `node_modules`, through which that dependency's emitted records routed). Two
// module instances meant two independent state bindings, so the nested copy's
// first emission saw its OWN `service:'unlabeled'` fallback, printed the BL-404
// warning, and no amount of initialising the top-level copy could silence it.
// The two copies were, to each other, strangers.
//
// `Symbol.for()` returns the SAME symbol for the same string in every module
// instance in a realm (it is the global symbol registry), so N copies of this
// file all resolve `globalThis[TELEMETRY_RUNTIME_SLOT_KEY]` to one shared
// runtime object. The FIRST copy to run creates it; every later copy reads it.
// One `initTelemetry` is then visible to all of them and the warning cannot
// fire from a duplicate-module hazard.
//
// SEPARATE REALMS ARE UNAFFECTED, DELIBERATELY: a forked child process or a
// `worker_threads.Worker` has its own `globalThis` (and its own symbol
// registry), so it gets its own runtime — which is correct, because it is a
// genuinely separate process/isolate. Those realms are initialised by
// `child-bootstrap.ts`'s `SOX_TELEMETRY_INIT` convention, unchanged.
//
// ⚠️ THE KEY IS A SEMVER-STABLE CONTRACT. The string inside `Symbol.for(...)`
// identifies the shared slot across every version of this package that
// coexists in one process; changing it silently splits the runtime again (two
// copies, two states, the warning returns). Treat a change to it as a breaking
// change: bump the `.vN` suffix only when the runtime object's SHAPE changes
// incompatibly, and never reuse an old suffix for a new shape. See ADR-0018.
const TELEMETRY_RUNTIME_SLOT_KEY: symbol = Symbol.for('@adhd/sox-telemetry.runtime.v1');

/** Default cadence (in records) between activity-triggered metric snapshots.
 *  Declared here, above the singleton, because `newRuntime()` seeds it. */
const DEFAULT_SNAPSHOT_EVERY_RECORDS = 1000;

/** Default wall-clock floor (ms) between interval-triggered metric snapshots
 *  (979c54…, durable-metrics S1). One minute is frequent enough that a
 *  restart-heavy release window still accumulates a durable series, and cheap
 *  enough that an idle process writes ~1.4k tiny lines/day. `0` disables. */
const DEFAULT_SNAPSHOT_EVERY_MS = 60_000;

/** Default retention cap for the SNAPSHOT component's rotated files
 *  (durable-metrics S2). Deliberately larger than the event stream's 7
 *  (`sink.ts`'s default): a snapshot is a CHECKPOINT the event stream is meant
 *  to be recomputable from (§5.8), so its series must outlive the events it
 *  covers and span several releases — the whole reason snapshots got their own
 *  component. `0`/negative is clamped to 1 by the pruner (never zero files). */
const DEFAULT_SNAPSHOT_MAX_FILES = 30;

/** Default trailing window (ms) the continuous rollup folds over (S8). One
 *  hour: long enough to smooth the 60 s cadence, short enough that the newest
 *  row reflects the current release. Re-derived each tick — overlap is
 *  deliberate and self-describing, never summed. */
const DEFAULT_ROLLUP_WINDOW_MS = 3_600_000;

/** Default retention cap for the ROLLUP cache's rotated files (S8). A rollup
 *  file is a DERIVED CACHE (recomputable from the retained snapshots), so this
 *  is a cache-size knob, not primary retention (ADR-0014 governs the primary
 *  store snapshots and is untouched). Kept ≥ the snapshot horizon (30) so the
 *  cache spans every snapshot the window could read. `0`/negative clamps to 1. */
const DEFAULT_ROLLUP_MAX_FILES = 30;

/** Everything mutable this module owns, in one process-global object. */
interface TelemetryRuntime {
  state: RuntimeState;
  otelReady: Promise<void>;
  warnedUnlabeled: boolean;
  stageDeclarations: Map<string, { pkg: string; paths: readonly string[] }>;
  stageAggregates: Map<string, StageAggregate>;
  childTelemetryCounters: {
    spawned: number;
    acked_with_sink: number;
    acked_without_sink: number;
    unacked_with_success: number;
  };
  childTelemetryRing: ChildTelemetryRecord[];
  snapshotSink: DurableJsonlSink | null;
  snapshotEveryRecords: number;
  /** Wall-clock floor (ms) for the interval trigger; `0` disables it. */
  snapshotEveryMs: number;
  recordsSinceSnapshot: number;
  snapshotsWritten: number;
  snapshotInFlight: boolean;
  snapshotTimer: ReturnType<typeof setInterval> | null;
  // ── Durable-metrics S8: continuous rollup ─────────────────────────────────
  /** The SECOND `DurableJsonlSink`, for `metrics.rollup` rows. Separate
   *  component/dir/retention from the snapshot sink. Null when `logSink` is not
   *  `'file'`, which makes `rollupMetrics` a no-op. */
  rollupSink: DurableJsonlSink | null;
  /** Re-entrancy guard, mirroring `snapshotInFlight`: an interval tick that
   *  fires while a prior rollup pass is still reading must not stack. */
  rollupInFlight: boolean;
  /** Trailing window (ms) re-derived each tick; `0`-safe (no records ⇒ no rows). */
  rollupWindowMs: number;
  /** The resolved log dir the snapshot files live in (for `rollupMetrics`'s
   *  read). Derived from `opts.logDir ?? ecosystemHome()/…` — never hardcoded. */
  snapshotDir: string | null;
  /** The snapshot component name (`<service>.<role>.metrics-snapshot`) whose
   *  files `rollupMetrics` enumerates. */
  snapshotComponent: string;
  /** mtime+size-keyed parse cache: an unchanged file is not re-read/re-parsed,
   *  so a tick over N rotating files touches only the one that changed. */
  rollupFileCache: Map<string, RollupCachedFile>;
}

/** A parsed snapshot file, cached by its (mtimeMs, size) identity. */
interface RollupCachedFile {
  mtimeMs: number;
  size: number;
  records: MetricsSnapshotRecord[];
}

function defaultState(): RuntimeState {
  return {
    service: 'unlabeled',
    role: defaultRole(),
    logSink: 'none',
    sink: null,
    otel: NOOP_OTEL,
    otelState: 'disabled',
    release: NULL_RELEASE,
  };
}

function newRuntime(): TelemetryRuntime {
  return {
    state: defaultState(),
    otelReady: Promise.resolve(),
    warnedUnlabeled: false,
    stageDeclarations: new Map(),
    stageAggregates: new Map(),
    childTelemetryCounters: {
      spawned: 0,
      acked_with_sink: 0,
      acked_without_sink: 0,
      unacked_with_success: 0,
    },
    childTelemetryRing: [],
    snapshotSink: null,
    snapshotEveryRecords: DEFAULT_SNAPSHOT_EVERY_RECORDS,
    snapshotEveryMs: DEFAULT_SNAPSHOT_EVERY_MS,
    recordsSinceSnapshot: 0,
    snapshotsWritten: 0,
    snapshotInFlight: false,
    snapshotTimer: null,
    rollupSink: null,
    rollupInFlight: false,
    rollupWindowMs: DEFAULT_ROLLUP_WINDOW_MS,
    snapshotDir: null,
    snapshotComponent: '',
    rollupFileCache: new Map(),
  };
}

/**
 * The ONE process-wide runtime. The first caller in this realm creates it and
 * installs it on `globalThis[TELEMETRY_RUNTIME_SLOT_KEY]`; every other copy of
 * this module reads that same object instead of creating its own. See the
 * slot-key doc comment above for the full BL-404 rationale.
 */
function runtime(): TelemetryRuntime {
  const slot = globalThis as unknown as Record<symbol, TelemetryRuntime | undefined>;
  const existing = slot[TELEMETRY_RUNTIME_SLOT_KEY];
  if (existing !== undefined) return existing;
  const created = newRuntime();
  slot[TELEMETRY_RUNTIME_SLOT_KEY] = created;
  return created;
}

/** Not memoised across calls: honours whatever `initTelemetry` most recently
 *  configured, including in tests that re-init between cases. */
export function currentRuntimeState(): Readonly<RuntimeState> {
  return runtime().state;
}

/** The active OTel runtime, or the null object. Never null — `stages.ts` has
 *  ONE code path, not an `if (otel)` fork whose branches drift apart. */
export function _currentOtel(): OtelRuntime {
  return runtime().state.otel;
}

/** Resolves once OTel bring-up has settled. Never rejects. */
export function otelReady(): Promise<void> {
  return runtime().otelReady;
}

/** OTel defaults ON at a real composition root and OFF under test, because the
 *  SDK costs 91.5 ms + 23.6 MB to load and a vitest worker pays that per file. */
function otelDefaultFor(role: Role): boolean {
  return role === 'live-service' || role === 'cli';
}

export function initTelemetry(opts: InitTelemetryOptions): TelemetryHandle {
  const rt = runtime();
  rt.state.sink?.close();
  void rt.state.otel.shutdown();

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
  rt.state = {
    service: opts.service,
    role: opts.role,
    logSink,
    sink,
    otel: NOOP_OTEL,
    otelState: wantOtel ? 'pending' : 'disabled',
    release: resolveRelease(opts.release),
  };
  rt.snapshotEveryRecords = opts.snapshotEveryRecords ?? resolveSnapshotEveryRecords();
  rt.snapshotEveryMs = resolveSnapshotEveryMs(opts.snapshotEveryMs);
  rt.recordsSinceSnapshot = 0;
  resetSelfCheck();
  configureSnapshotSink(opts, logSink);
  // S8: the rollup sink + its read coordinates are configured alongside the
  // snapshot sink, since the interval tick drives both. Its own component/dir/
  // retention; the same `snapshotEveryMs` cadence gate applies.
  configureRollupSink(opts, logSink);

  // 979c54… S1: one snapshot at startup, before any activity can accumulate.
  // A process that restarts (everything in a release window) may never reach
  // `snapshotEveryRecords`, so without this it persists nothing at all.
  //
  // Scheduled on the next check phase rather than awaited/invoked inline: the
  // write is one TICK behind init regardless, and deferring it keeps the
  // composition root's own synchronous bootstrap — and any snapshot it triggers
  // explicitly, e.g. a first `telemetrySelfCheck()` pull — ordered AHEAD of this
  // baseline line, so the durable series opens with 'startup'. No sink (logSink
  // 'none'/'stderr') ⇒ nothing scheduled, nothing written (acceptance (f)).
  if (rt.snapshotSink !== null) {
    setImmediate(() => {
      void snapshotMetrics('startup');
    });
  }

  if (wantOtel) {
    const generation = rt.state;
    rt.otelReady = import('./otel.js')
      .then(({ bringUpOtel }) => {
        // A second initTelemetry() may have landed while the SDK was loading;
        // do not resurrect telemetry for a superseded configuration.
        if (rt.state !== generation) return;
        rt.state.otel = bringUpOtel({
          service: opts.service,
          role: opts.role,
          // S3: the release identity rides every span and metric point as a
          // RESOURCE attribute (see `bringUpOtel`). `generation.release` is the
          // already-normalised identity for THIS configuration — no second
          // resolution path.
          release: generation.release,
          emit: (event, level, fields) => emitRecord(event, level, fields),
        });
        rt.state.otelState = 'ready';
      })
      .catch((err: unknown) => {
        if (rt.state !== generation) return;
        rt.state.otelState = 'failed';
        // Loud, once, on stderr — never stdout (MCP JSON-RPC channel). A
        // silently-absent SDK is the BL-404 shape all over again.
        process.stderr.write(
          `[sox-telemetry] WARNING: OpenTelemetry bring-up failed (${
            err instanceof Error ? err.message : String(err)
          }); spans/metrics are no-ops, durable JSONL is unaffected (BL-401).\n`,
        );
      });
  } else {
    rt.otelReady = Promise.resolve();
  }

  return {
    service: opts.service,
    role: opts.role,
    // BL-433: `plannedPath()`, not `currentPath()` — the question a caller is
    // asking is "where do I look?", which has an answer before the first write.
    // `null` is reserved for the one state that genuinely has no answer.
    currentLogFilePath: () => rt.state.sink?.plannedPath() ?? null,
    flush: () => rt.state.sink?.flush() ?? Promise.resolve(),
    otelReady: () => rt.otelReady,
    close: () => {
      // §5.8: a snapshot on graceful shutdown, so the final window of
      // non-recomputable state (counters, sink drop counts) is not lost.
      // S8: then fold one last rollup over the just-written final snapshot —
      // BEFORE the sinks close — so shutdown's own data is in the final row.
      void (async () => {
        await snapshotMetrics('shutdown');
        await rollupMetrics('shutdown');
      })()
        .catch((err: unknown) => {
          // `snapshotMetrics`/`rollupMetrics` are written never to reject, but
          // this chain is `void`-floating: a future edit that lets either throw
          // must not surface as an unhandled rejection (which Node terminates
          // the process on by default). Traced via the runtime logger — never an
          // empty catch — and placed BEFORE `.finally` so the sinks are still
          // open when the warning is emitted.
          log.warn('telemetry.close.failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          void rt.state.otel.shutdown();
          rt.state.sink?.close();
          closeSnapshotSink();
          closeRollupSink();
        });
    },
  };
}

/** Test-only: drop all state back to the uninitialised default. */
export function _resetTelemetryForTest(): void {
  const rt = runtime();
  rt.state.sink?.close();
  void rt.state.otel.shutdown();
  closeSnapshotSink();
  closeRollupSink();
  stopSnapshotTimer();
  rt.state = defaultState();
  rt.otelReady = Promise.resolve();
  rt.recordsSinceSnapshot = 0;
  rt.snapshotEveryMs = DEFAULT_SNAPSHOT_EVERY_MS;
  rt.snapshotsWritten = 0;
  rt.warnedUnlabeled = false;
  rt.rollupInFlight = false;
  rt.rollupWindowMs = DEFAULT_ROLLUP_WINDOW_MS;
  rt.snapshotDir = null;
  rt.snapshotComponent = '';
  rt.rollupFileCache.clear();
  resetSelfCheck();
}

// ── Emission ─────────────────────────────────────────────────────────────

export interface LogFields {
  [key: string]: unknown;
}

// BL-404: fires once per process, the first time anything is emitted while
// `initTelemetry()` has never been called. `service === 'unlabeled'` is the
// unambiguous signal — it is the literal default in `defaultState()` above and
// is never a value a real caller would pass to `initTelemetry` (BL-353 requires
// a real service name). Deliberately independent of `st.logSink === 'none'`
// short-circuit below: the whole point is that the uninitialised state is
// ALSO the silent no-op sink, so this is the one path that must not be
// silent.
function warnIfUnlabeled(st: RuntimeState): void {
  const rt = runtime();
  if (rt.warnedUnlabeled || st.service !== 'unlabeled') return;
  rt.warnedUnlabeled = true;
  process.stderr.write(
    '[sox-telemetry] WARNING: emitting with no initTelemetry() call in this process ' +
      `(role:'${st.role}', logSink:'none' — records are being silently dropped). ` +
      'Call initTelemetry({ service, role, logSink }) at process startup, before any ' +
      'handler can emit, or this process\'s telemetry is a permanent no-op (BL-404).\n',
  );
}

function emitRecord(event: string, level: 'debug' | 'info' | 'warn' | 'error', fields?: LogFields): void {
  try {
    const st = runtime().state;
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
      // S3 (`5ac0a1a8…`): release identity is part of the ENVELOPE, exactly as
      // `service`/`role` are — so EVERY durable log/span/event record names the
      // release that produced it, and a production error or span is
      // attributable ("which release produced this?"). Read from the runtime's
      // already-resolved state (`initTelemetry` normalises it once) and copied
      // verbatim, so the contract is identical to `snapshotMetrics`: unset ⇒
      // all three fields `null`, never `''` (BL-433). No second resolution path
      // and no new env var (ADR-0013).
      release: { ...st.release },
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
  const rt = runtime();
  rt.stageDeclarations.set(key, { pkg, paths });
  if (!rt.stageAggregates.has(key)) {
    rt.stageAggregates.set(key, { paths: new Map(), wait: newDurationStats(), work: newDurationStats() });
  }
}

export function _recordStageOutcome(stageKey: string, pathName: string, outcome: Outcome): void {
  const rt = runtime();
  let agg = rt.stageAggregates.get(stageKey);
  if (!agg) {
    agg = { paths: new Map(), wait: newDurationStats(), work: newDurationStats() };
    rt.stageAggregates.set(stageKey, agg);
  }
  let pc = agg.paths.get(pathName);
  if (!pc) {
    pc = { started: 0, finished: 0, error: 0 };
    agg.paths.set(pathName, pc);
  }
  pc[outcome] += 1;
}

export function _recordStageDuration(stageKey: string, phase: 'wait' | 'work', ms: number): void {
  const agg = runtime().stageAggregates.get(stageKey);
  if (!agg) return;
  recordDuration(phase === 'wait' ? agg.wait : agg.work, ms);
}

function resetSelfCheck(): void {
  const rt = runtime();
  rt.stageAggregates.clear();
  for (const [key, decl] of rt.stageDeclarations) {
    rt.stageAggregates.set(key, { paths: new Map(), wait: newDurationStats(), work: newDurationStats() });
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

/** Record one child telemetry observation (spawned/acked/unacked). Never throws. */
export function _recordChildTelemetry(rec: ChildTelemetryRecord): void {
  const rt = runtime();
  if (rec.acked === true) {
    if (rec.logSink === 'file' && typeof rec.filePath === 'string') {
      rt.childTelemetryCounters.acked_with_sink += 1;
    } else {
      rt.childTelemetryCounters.acked_without_sink += 1;
    }
  } else if (rec.unacked === true) {
    rt.childTelemetryCounters.unacked_with_success += 1;
  } else {
    rt.childTelemetryCounters.spawned += 1;
  }
  rt.childTelemetryRing.push(rec);
  if (rt.childTelemetryRing.length > CHILD_TELEMETRY_RING_MAX) rt.childTelemetryRing.shift();
}

function resetChildTelemetry(): void {
  const rt = runtime();
  rt.childTelemetryCounters.spawned = 0;
  rt.childTelemetryCounters.acked_with_sink = 0;
  rt.childTelemetryCounters.acked_without_sink = 0;
  rt.childTelemetryCounters.unacked_with_success = 0;
  rt.childTelemetryRing.length = 0;
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
   *  and otherwise the path the next snapshot lands in, written or not.
   *  S1 (`979c54…`): `every_ms` mirrors the resolved interval cadence — `0`
   *  means the interval trigger is off (the typed config was `0` and no
   *  `SOX_TRACE_SNAPSHOT_MS` override was set). */
  metric_persistence: {
    written: number;
    records_since: number;
    every_records: number;
    every_ms: number;
    file: string | null;
  };
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
  const rt = runtime();
  const stagesWithZero: string[] = [];
  const pathsWithZero: string[] = [];
  const stages: StageSelfCheck[] = [];

  for (const [key, decl] of rt.stageDeclarations) {
    const agg = rt.stageAggregates.get(key) ?? { paths: new Map(), wait: newDurationStats(), work: newDurationStats() };
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
    role: rt.state.role,
    stages_declared: rt.stageDeclarations.size,
    stages_with_zero_samples: stagesWithZero,
    paths_with_zero_samples: pathsWithZero,
    stages,
    children: {
      spawned: rt.childTelemetryCounters.spawned,
      acked_with_sink: rt.childTelemetryCounters.acked_with_sink,
      acked_without_sink: rt.childTelemetryCounters.acked_without_sink,
      unacked_with_success: rt.childTelemetryCounters.unacked_with_success,
      recent: rt.childTelemetryRing.slice(),
    },
    otel: { state: rt.state.otelState, spans_enabled: rt.state.otel.enabled },
    metric_persistence: {
      written: rt.snapshotsWritten,
      records_since: rt.recordsSinceSnapshot,
      every_records: rt.snapshotEveryRecords,
      every_ms: rt.snapshotEveryMs,
      file: rt.snapshotSink?.plannedPath() ?? null,
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
//   C (PRIMARY)  every N records written — staleness bounded by WORK DONE rather
//                than wall-clock. An idle process has nothing to lose.
//   S1 (floor)   a wall-clock interval (`snapshotEveryMs`, default 60 s) and one
//                snapshot at startup. The record trigger alone leaves a
//                restart-heavy release window (a process that never accumulates
//                N records before it is replaced) with NO durable series at all
//                — proven: no post-cutover `metrics.snapshot` existed. The
//                interval is `.unref()`'d, so the zero-handle property
//                (§3.3/BL-345) still holds.
//   A            opportunistically on the `telemetrySelfCheck()` pull.
//   shutdown     on `handle.close()`.
//   D (override) `SOX_TRACE_SNAPSHOT_MS` REPLACES the S1 interval for a
//                deliberate debugging session. It can only change the cadence,
//                never disable the trigger.
//
// Option B (piggyback the periodic enrich tick) is deliberately NOT used:
// persistence that silently stops when an unrelated subsystem changes is worse
// than no persistence at all — and the enrich tick's cadence is not this
// ledger's to borrow (the old `SOX_DISABLE_PERIODIC_ENRICH` brake is gone,
// ADR-0013, so the tick is always on, but coupling two subsystems' liveness is
// still the wrong shape).

function resolveSnapshotEveryRecords(): number {
  const raw = process.env['SOX_TRACE_SNAPSHOT_EVERY'];
  if (raw === undefined || raw === '') return DEFAULT_SNAPSHOT_EVERY_RECORDS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SNAPSHOT_EVERY_RECORDS;
}

/**
 * S1: resolve the interval cadence from the typed config, with
 * `SOX_TRACE_SNAPSHOT_MS` as a debug OVERRIDE that — when it parses to a
 * positive integer — REPLACES the typed value entirely. The override can only
 * ever change the cadence, never disable the trigger: an unset/invalid env var
 * falls through to the typed config, whose default arms a timer. `0` (typed, no
 * env override) disables the interval — but the startup snapshot still fires,
 * because that path is not gated on this value.
 */
function resolveSnapshotEveryMs(configured: number | undefined): number {
  const raw = Number.parseInt(process.env['SOX_TRACE_SNAPSHOT_MS'] ?? '', 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  if (configured === undefined) return DEFAULT_SNAPSHOT_EVERY_MS;
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_SNAPSHOT_EVERY_MS;
}

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
  const rt = runtime();
  closeSnapshotSink();
  if (logSink !== 'file') return;
  const dir = opts.logDir ?? path.join(ecosystemHome(), opts.service, 'logs');
  const sinkOpts: JsonlSinkOptions = { dir, component: `${opts.service}.${opts.role}.metrics-snapshot` };
  // S2 retention precedence — snapshot's own cap first, then an explicit event
  // cap, then the snapshot default (30), NOT the event sink's 7. Before S2 this
  // forwarded `opts.maxFiles` only, so `snapshotMaxFiles` would have been
  // silently ignored and snapshots shared the event stream's tiny budget.
  sinkOpts.maxFiles = opts.snapshotMaxFiles ?? opts.maxFiles ?? DEFAULT_SNAPSHOT_MAX_FILES;
  rt.snapshotSink = new DurableJsonlSink(sinkOpts);

  stopSnapshotTimer();
  // S1: the interval is armed from the resolved typed cadence (`rt.snapshotEveryMs`,
  // which already folds in the SOX_TRACE_SNAPSHOT_MS override), never from the
  // env var alone — the env var is an OVERRIDE of the typed floor, not the
  // trigger itself.
  const everyMs = rt.snapshotEveryMs;
  if (everyMs > 0) {
    rt.snapshotTimer = setInterval(() => {
      // S8: the SAME already-`.unref()`d S1 handle drives the rollup — NO
      // second timer, so the zero-handle property (BL-345) is preserved. The
      // snapshot is awaited first so the just-written checkpoint (writeSync-
      // durable when its promise resolves) is what the rollup folds in.
      void (async () => {
        await snapshotMetrics('interval');
        await rollupMetrics('interval');
      })().catch((err: unknown) => {
        // The tick's chain is `void`-floating, so a rejection would be an
        // unhandled rejection that Node terminates the process on. `snapshotMetrics`
        // /`rollupMetrics` are written never to reject; this is the guard that
        // keeps that an invariant rather than a hope. Traced via the runtime
        // logger — never a silent or empty catch (BL-319).
        log.warn('telemetry.interval.failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, everyMs);
    // .unref() keeps `getActiveResourcesInfo()` empty and does not hold the
    // event loop open — measured in §5.9. Without it, opting into option D
    // (or the S1 floor) would make the process immortal.
    rt.snapshotTimer.unref();
  }
}

function closeSnapshotSink(): void {
  const rt = runtime();
  rt.snapshotSink?.close();
  rt.snapshotSink = null;
}

function stopSnapshotTimer(): void {
  const rt = runtime();
  if (rt.snapshotTimer !== null) {
    clearInterval(rt.snapshotTimer);
    rt.snapshotTimer = null;
  }
}

// ── Continuous rollup (durable-metrics S8, 6df0d673…) ───────────────────────
//
// The library OWNS continuous rollup (owner directive): the S1 interval tick
// calls `rollupMetrics('interval')` right after `snapshotMetrics('interval')`,
// and `close()` calls it once with `'shutdown'`. There is no external repo tool
// and no human `--apply` step. The aggregation itself is PURE (`rollup.ts`);
// everything filesystem-shaped — enumerating the snapshot component's files,
// async reading, mtime caching, writing the row — lives here.
//
// Reads are `fs.promises`-based and NEVER throw, so the event loop is never
// blocked by a sync directory scan and a transient I/O fault only skips a tick
// rather than breaking the process.

function resolveRollupWindowMs(configured: number | undefined): number {
  if (configured === undefined) return DEFAULT_ROLLUP_WINDOW_MS;
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_ROLLUP_WINDOW_MS;
}

/** Local copy of `sink.ts`'s anchored-regex escaper (not exported there). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Configure the S8 rollup sink — the additive sibling of
 * `configureSnapshotSink`. A SECOND `DurableJsonlSink` with component
 * `<service>.<role>.metrics-rollup`, its own dir (`<resolved logDir>/rollup`,
 * or `rollupDir`), and its own cache cap (`rollupMaxFiles`).
 */
function configureRollupSink(opts: InitTelemetryOptions, logSink: LogSink): void {
  const rt = runtime();
  closeRollupSink();
  // Resolve the read coordinates unconditionally (the sink itself is only
  // created for a file sink) so a non-file sink never leaves a stale dir cached.
  const resolvedLogDir = opts.logDir ?? path.join(ecosystemHome(), opts.service, 'logs');
  rt.snapshotDir = resolvedLogDir;
  rt.snapshotComponent = `${opts.service}.${opts.role}.metrics-snapshot`;
  rt.rollupWindowMs = resolveRollupWindowMs(opts.rollupWindowMs);
  if (logSink !== 'file') return;
  const dir = opts.rollupDir ?? path.join(resolvedLogDir, 'rollup');
  const sinkOpts: JsonlSinkOptions = { dir, component: `${opts.service}.${opts.role}.metrics-rollup` };
  // Precedence: the rollup's own cap, else the snapshot's, else the event cap,
  // else the rollup default (30). A rollup file is a DERIVED CACHE, so this is
  // a cache-size knob, never primary retention (ADR-0014 is untouched).
  sinkOpts.maxFiles = opts.rollupMaxFiles ?? opts.snapshotMaxFiles ?? opts.maxFiles ?? DEFAULT_ROLLUP_MAX_FILES;
  rt.rollupSink = new DurableJsonlSink(sinkOpts);
}

function closeRollupSink(): void {
  const rt = runtime();
  rt.rollupSink?.close();
  rt.rollupSink = null;
}

/**
 * Read every persisted `metrics.snapshot` record under `dir` whose file name
 * matches the snapshot component's full anchored shape (`<component>-<date>
 * [.<epoch>-<seq>].jsonl`). `fs.promises` only — never a sync directory scan —
 * and mtime+size-cached, so an unchanged file is neither re-read nor re-parsed
 * (only the current day's file changes between ticks). NEVER throws: a missing
 * dir, an unreadable file, or a malformed line is skipped.
 */
async function readSnapshotRecords(
  dir: string,
  component: string,
  cache: Map<string, RollupCachedFile>,
): Promise<MetricsSnapshotRecord[]> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const anchor = new RegExp(`^${escapeRegExp(component)}-\\d{4}-\\d{2}-\\d{2}(\\.\\d+-\\d+)?\\.jsonl$`);
  const matching = names.filter((f) => anchor.test(f)).sort();
  const matchingSet = new Set(matching);
  // Evict cache entries whose file was rotated/pruned away.
  for (const key of [...cache.keys()]) {
    if (!matchingSet.has(key)) cache.delete(key);
  }

  const out: MetricsSnapshotRecord[] = [];
  for (const name of matching) {
    const full = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(full);
    } catch {
      continue;
    }
    const cached = cache.get(name);
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      out.push(...cached.records);
      continue;
    }
    let text: string;
    try {
      text = await fs.promises.readFile(full, 'utf8');
    } catch {
      continue;
    }
    const records: MetricsSnapshotRecord[] = [];
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (isPlainRecord(parsed)) records.push(parsed as MetricsSnapshotRecord);
    }
    cache.set(name, { mtimeMs: stat.mtimeMs, size: stat.size, records });
    out.push(...records);
  }
  return out;
}

/**
 * One continuous rollup pass: enumerate + async-read the `(service, role)`
 * snapshot component files, fold the trailing window into one row per release
 * identity (`aggregateSnapshots`), and write the rows to the rollup sink.
 *
 * Never throws and never rejects (it rides the interval tick), re-entrancy-
 * guarded against a slow read overlapping the next tick, and a no-op when no
 * rollup sink was configured (a non-file sink, or `snapshotEveryMs: 0`).
 */
export async function rollupMetrics(reason: RollupReason): Promise<void> {
  const rt = runtime();
  if (rt.rollupInFlight) return;
  const sink = rt.rollupSink;
  const dir = rt.snapshotDir;
  if (sink === null || dir === null || rt.snapshotComponent === '') return;
  rt.rollupInFlight = true;
  try {
    const now = Date.now();
    const cache = rt.rollupFileCache ?? new Map<string, RollupCachedFile>();
    rt.rollupFileCache = cache;
    const records = await readSnapshotRecords(dir, rt.snapshotComponent, cache);
    const rows: RollupRow[] = aggregateSnapshots(records, {
      windowMs: rt.rollupWindowMs ?? DEFAULT_ROLLUP_WINDOW_MS,
      now,
    });
    const ts = new Date(now).toISOString();
    for (const row of rows) {
      const record = {
        ts,
        level: 'info',
        event: 'metrics.rollup',
        service: rt.state.service,
        role: rt.state.role,
        // The envelope's `pid` is the process that WROTE this row (never a
        // group's). The row's own `process_pid` — the process instance the
        // aggregate describes, which differs after a restart — is carried
        // alongside so a reader comparing rows keys off the right one.
        pid: process.pid,
        process_pid: row.process_pid,
        release: row.release,
        reason,
        window: row.window,
        snapshots_in_window: row.snapshots_in_window,
        series: row.series,
        self_check: row.self_check,
        otel: row.otel,
      };
      sink.write(JSON.stringify(record) + '\n');
    }
  } catch (err) {
    // A rollup failure must never break or slow the interval it rides, but it
    // is NOT swallowed silently: an unexpected fault (the per-file read/parse
    // catches above already handle the EXPECTED churn — a missing dir, a file
    // rotating under us, a line still in flight) is traced so a broken rollup
    // is a signal, not a silence (the BL-319 shape).
    log.warn('metrics.rollup.failed', {
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    rt.rollupInFlight = false;
  }
}

function noteRecordWritten(): void {
  const rt = runtime();
  rt.recordsSinceSnapshot += 1;
  if (rt.snapshotEveryRecords > 0 && rt.recordsSinceSnapshot >= rt.snapshotEveryRecords) {
    void snapshotMetrics('activity');
  }
}

function scheduleOpportunisticSnapshot(): void {
  if (runtime().recordsSinceSnapshot > 0) void snapshotMetrics('pull');
}

/**
 * Write one durable `metrics.snapshot` line. Never throws and never rejects —
 * it is called from the emission hot path.
 *
 * Deliberately NOT routed through `emitRecord`: that would increment the
 * activity counter it is resetting and recurse, and it would put a large
 * aggregate line into the event stream whose retention it must outlive.
 */
/**
 * (5b58b189) Named, process-local extra sections for every `metrics.snapshot`
 * line (e.g. memory-server's main-thread lag summary). A section provider is
 * called synchronously at snapshot time; a throwing provider is recorded as
 * `{ error }` and never breaks the snapshot.
 */
const snapshotSections = new Map<string, () => Record<string, unknown>>();

export function registerSnapshotSection(name: string, provider: () => Record<string, unknown>): () => void {
  snapshotSections.set(name, provider);
  return () => {
    if (snapshotSections.get(name) === provider) snapshotSections.delete(name);
  };
}

/** (5b58b189) Process CPU/RSS at snapshot time — cheap, always present, so a
 *  CPU-pinned or ballooning process is visible from telemetry alone (the
 *  22:02Z hang was diagnosable only via `sample <pid>`). */
function processStats(): Record<string, unknown> {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    rss_bytes: mem.rss,
    heap_used_bytes: mem.heapUsed,
    external_bytes: mem.external,
    cpu_user_ms: Math.round(cpu.user / 1000),
    cpu_system_ms: Math.round(cpu.system / 1000),
    uptime_s: Math.round(process.uptime()),
  };
}

function collectSnapshotSections(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, provider] of snapshotSections) {
    try {
      out[name] = provider();
    } catch (err) {
      out[name] = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  return out;
}

export async function snapshotMetrics(
  reason: 'startup' | 'activity' | 'pull' | 'shutdown' | 'interval',
): Promise<void> {
  const rt = runtime();
  if (rt.snapshotInFlight) return;
  const sink = rt.snapshotSink;
  if (!sink) {
    rt.recordsSinceSnapshot = 0;
    return;
  }
  rt.snapshotInFlight = true;
  const covered = rt.recordsSinceSnapshot;
  rt.recordsSinceSnapshot = 0;
  try {
    let otelMetrics: OtelMetricPoint[] = [];
    try {
      otelMetrics = await rt.state.otel.collect();
    } catch {
      otelMetrics = [];
    }
    const stagesView = telemetrySelfCheckCore();
    const record = {
      ts: new Date().toISOString(),
      level: 'info',
      event: 'metrics.snapshot',
      service: rt.state.service,
      role: rt.state.role,
      pid: process.pid,
      trace_id: null,
      reason,
      // S3 (`5ac0a1a8…`): the release identity this snapshot was produced by,
      // so two snapshots a release apart are differentiable and comparable.
      // A shallow copy, so a caller mutating a shared object cannot retroactively
      // rewrite a line already written.
      release: { ...rt.state.release },
      // §5.8's second consequence: a cumulative counter without its window is
      // an unfalsifiable number (the BL-334 pattern). Both windows are stated.
      window: 'since process start',
      records_covered: covered,
      snapshot_seq: rt.snapshotsWritten + 1,
      self_check: stagesView,
      otel_metrics: otelMetrics,
      process: processStats(),
      sections: collectSnapshotSections(),
    };
    sink.write(JSON.stringify(record) + '\n');
    rt.snapshotsWritten += 1;
  } catch {
    // A snapshot failure must never break or slow the caller.
  } finally {
    rt.snapshotInFlight = false;
  }
}

/** Test seam: number of durable snapshots this process has written. */
export function _snapshotCountForTest(): number {
  return runtime().snapshotsWritten;
}
