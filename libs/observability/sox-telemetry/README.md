# @adhd/sox-telemetry

A shared tracing/metrics substrate: a durable JSONL log sink, a `log`/`withTimedEvent` API that
makes hangs visible (the "start" line lands before the work even begins, so a process that never
returns is already on disk), a stage catalog for measuring wait-vs-work on contended resources, a
self-check surface you can poll instead of grepping logs, and an opt-in bridge to the real
OpenTelemetry SDK. It is the one place in a codebase that should own `@opentelemetry/*` — every
other package can log/trace through this facade without paying the SDK's load cost unless
`initTelemetry({ otel: true })` actually asks for it.

```bash
pnpm add @adhd/sox-telemetry
```

## Quick start

```typescript
import { initTelemetry, log, withTimedEvent } from '@adhd/sox-telemetry';

const handle = initTelemetry({
  service: 'my-service',
  role: 'live-service', // required, closed union: 'live-service' | 'test' | 'cli' | 'harness'
  logDir: './logs',      // defaults to ~/.adhd/sox-ecosystem/<service>/logs
});

log.info('startup.begin', { pid: process.pid });

await withTimedEvent('db.migrate', { table: 'users' }, async () => {
  // ... do the work; a "db.migrate.start" line is already durable on disk
  // before this callback even runs, so a hang here is visible immediately.
});

console.log('records are landing in', handle.currentLogFilePath());
await handle.flush();
handle.close();
```

Every record — from `log.*`, from `withTimedEvent`, from a stage, from an OTel span — carries
`service`, `role`, `trace_id`, `pid`, `ts` (ISO-8601), and `level`, stamped once by `initTelemetry`
rather than per call site. Calling any emitter before `initTelemetry()` is safe: it falls back to a
`service: 'unlabeled'`, no-op sink rather than throwing, and prints one stderr warning on first use
so an unwired composition root doesn't fail silently forever.

## API reference

### Initialization

```typescript
function initTelemetry(opts: InitTelemetryOptions): TelemetryHandle;

interface InitTelemetryOptions {
  service: string;
  role: Role;                    // 'live-service' | 'test' | 'cli' | 'harness' — required
  logSink?: LogSink;              // 'file' (default) | 'stderr' | 'none' — never 'stdout'
  logDir?: string;                 // default: ~/.adhd/sox-ecosystem/<service>/logs
  maxBytes?: number;                // size-based log rotation threshold
  maxFiles?: number;                 // rotated files retained
  durable?: boolean;                  // writeSync durability, default true
  otel?: boolean;                       // bring up the real OTel SDK; default on for
                                         // 'live-service'/'cli', off for 'test'/'harness'
  snapshotEveryRecords?: number;         // activity-triggered metrics snapshot cadence, default 1000
}

interface TelemetryHandle {
  readonly service: string;
  readonly role: Role;
  currentLogFilePath(): string | null; // null means "no file sink configured" — the only meaning it has
  flush(): Promise<void>;              // await any buffered writes
  otelReady(): Promise<void>;          // resolves once OTel bring-up settles; never rejects
  close(): void;
}

function currentRuntimeState(): Readonly<{ service: string; role: Role; logSink: LogSink }>;

/** Resolve the role a composition root should actually pass to initTelemetry(),
 *  correcting a structural default toward 'harness' when an out-of-process
 *  integration harness set SOX_TELEMETRY_HARNESS=1 on this process's env. */
function resolveProcessRole(structuralDefault: Role): Role;
```

### Logging

```typescript
interface LogFields { [key: string]: unknown; }

const log: {
  debug: (event: string, fields?: LogFields) => void;
  info: (event: string, fields?: LogFields) => void;
  warn: (event: string, fields?: LogFields) => void;
  error: (event: string, fields?: LogFields) => void;
};

/** Truncate a value for safe, size-bounded logging (SQL text, error messages). */
function truncateForLog(s: string, maxLen?: number): string; // default maxLen 500

/** Log `<event>.start` immediately, run fn, then log `.finish`/`.error` with
 *  an elapsed duration_ms. The start line reaches the sink before fn even runs. */
function withTimedEvent<T>(event: string, fields: LogFields, fn: () => Promise<T>): Promise<T>;

/** Wrap every named method of obj so it emits withTimedEvent automatically,
 *  bound to the real target — `this` inside a wrapped method is never a Proxy. */
function instrumentBoundary<T extends object>(
  obj: T,
  opts: { component: string; methods: readonly (keyof T & string)[] },
): T;
```

```typescript
import { instrumentBoundary } from '@adhd/sox-telemetry';

const store = instrumentBoundary(rawStore, { component: 'user-store', methods: ['get', 'put'] });
// store.get(...) / store.put(...) now emit user-store.get.start/finish/error automatically;
// every other method on rawStore passes through untouched.
```

### Stages — measuring wait vs. work on a contended resource

```typescript
interface StageDeclaration { paths: readonly string[]; }
type StageMap = Record<string, StageDeclaration>;

function declareStages<T extends StageMap>(pkg: string, stages: T): StageCatalog<T>;

class StageCatalog<T extends StageMap> {
  withContendedStage<K extends keyof T & string, R>(
    stage: K,
    stagePath: T[K]['paths'][number],
    admit: () => Promise<void>,
    work: () => Promise<R>,
  ): Promise<R>;
}
```

Declaring a stage's code paths up front makes an unwired sibling path a visible finding in
`telemetrySelfCheck()` (`paths_with_zero_samples`) instead of a metric that silently never fires:

```typescript
import { declareStages } from '@adhd/sox-telemetry';

const stages = declareStages('embed-service', {
  embed: { paths: ['write', 'heal'] as const },
});

await stages.withContendedStage(
  'embed',
  'write',
  async () => { /* acquire a slot/lock — this is the "wait" phase */ },
  async () => { /* do the embedding work — this is the "work" phase */ return 'ok'; },
);
```

### Self-check

```typescript
function telemetrySelfCheck(): TelemetrySelfCheck;

interface TelemetrySelfCheck {
  window: 'since process start';
  role: Role;
  stages_declared: number;
  stages_with_zero_samples: string[];
  paths_with_zero_samples: string[];
  stages: StageSelfCheck[];
  children: ChildrenTelemetrySelfCheck;
  otel: { state: 'disabled' | 'pending' | 'ready' | 'failed'; spans_enabled: boolean };
  metric_persistence: { written: number; records_since: number; every_records: number; file: string | null };
}
```

A process's own health is a pull, not a log-scrape: `telemetrySelfCheck()` reports whether every
declared stage/path has ever produced a sample, whether spawned children ever initialized telemetry,
and whether the OTel SDK actually came up — each field distinguishes "never happened" from "not
asked for" rather than collapsing both into silence.

### Spans and metrics (OpenTelemetry, opt-in)

```typescript
function withSpan<R>(name: string, attrs: OtelAttributes, fn: (span: OtelSpanHandle) => Promise<R>): Promise<R>;
function otelReady(): Promise<void>;
function snapshotMetrics(reason: 'activity' | 'pull' | 'shutdown' | 'interval'): Promise<void>;

interface OtelSpanHandle {
  setAttributes(attrs: OtelAttributes): void;
  recordError(err: unknown): void;
}
```

```typescript
import { withSpan } from '@adhd/sox-telemetry';

await withSpan('checkout.process', { orderId }, async (span) => {
  span.setAttributes({ itemCount: items.length });
  // ... do the work; span.recordError(err) on catch if you want it on the span
});
```

When `initTelemetry({ otel: true })` hasn't been called (or hasn't finished — the SDK loads via a
dynamic import so it settles a few ms after `initTelemetry` returns), `withSpan` is `fn` plus one
no-op object — the same call site works whether or not anything is actually collecting spans.

### Trace-id propagation

```typescript
function newTraceId(): string;                       // ulid — sortable, monotonic within a process
function currentTraceId(): string | undefined;
function traceIdOrNew(): string;
function withTrace<T>(traceId: string, fn: () => T): T;
function runWithNewTrace<T>(fn: (traceId: string) => T): T;
```

```typescript
import { runWithNewTrace, log } from '@adhd/sox-telemetry';

runWithNewTrace((traceId) => {
  log.info('request.start', { traceId }); // every nested telemetry call in this
  // continuation (sync or awaited-async) shares the same active trace id.
});
```

### The durable sink

```typescript
class DurableJsonlSink {
  constructor(opts: JsonlSinkOptions);
  currentPath(): string;
  plannedPath(): string;
  reconfigure(opts: JsonlSinkOptions): void;
  flush(): Promise<void>;
  write(line: string): void;
  close(): void;
}

interface JsonlSinkOptions {
  dir: string;
  component: string;      // file-name prefix; role-qualify with '.', e.g. 'my-svc.live', not '-'
  maxBytes?: number;       // default 20 MB rotation threshold
  maxFiles?: number;       // default 7 retained
  durable?: boolean;       // writeSync (true, default) vs. a fire-and-forget stream
}
```

`initTelemetry` constructs one of these for you; reach for `DurableJsonlSink` directly only if you
need a second, independently-rotated JSONL stream outside the main telemetry record flow. Writes are
synchronous (`durable: true`) by default because a fire-and-forget stream loses buffered records on
a hard kill — `write()` returning means the line is already on disk.

### Child processes and worker threads

```typescript
const SOX_TELEMETRY_INIT: string; // env var name a parent writes and a child reads

function forkChild(modulePath: string, telemetry: InitTelemetryOptions, forkOpts?: ForkOptions): ChildProcess;
function spawnWorker(workerPath: string, telemetry: InitTelemetryOptions, workerOpts?: WorkerOptions): Worker;
function bootstrapChildTelemetry(defaults: InitTelemetryOptions): TelemetryHandle;
function childTelemetrySnapshot(): ChildTelemetrySnapshot;

interface ChildTelemetrySnapshot {
  service: string;
  role: Role;
  logSink: LogSink;
  filePath: string | null; // null iff logSink !== 'file'
  pid: number;
}
```

`initTelemetry()` only initializes the calling process's own state — a `node:child_process.fork`'d
child or a `worker_threads.Worker` starts with fresh, uninitialized telemetry unless the parent uses
`forkChild`/`spawnWorker` (which inject `SOX_TELEMETRY_INIT` into the child's env) and the child
calls `bootstrapChildTelemetry` at its own entrypoint:

```typescript
// parent.ts
import { forkChild } from '@adhd/sox-telemetry';
const child = forkChild('./worker.js', { service: 'my-service', role: 'live-service' });

// worker.js — the child's own composition root
import { bootstrapChildTelemetry } from '@adhd/sox-telemetry';
bootstrapChildTelemetry({ service: 'my-service-worker', role: 'live-service' });
```

A child that never calls `bootstrapChildTelemetry` shows up as `unacked` in the parent's
`telemetrySelfCheck().children` rather than silently vanishing.

## Gotchas

- `role` is required and has no default — pass whichever of `'live-service' | 'test' | 'cli' |
  'harness'` genuinely describes this process. There is no `'stdout'` `LogSink`: writing telemetry
  to stdout is not offered as an option, because a stray stdout write can corrupt a process's own
  JSON-RPC/stdio protocol channel.
- `otel: true` costs real time and memory to bring up (SDK trace/metrics providers +
  context-manager); it defaults on for `'live-service'`/`'cli'` and off for `'test'`/`'harness'` for
  that reason. Pass it explicitly to opt a test in.
- `currentLogFilePath()` and `metric_persistence.file` return `null` for "no file sink configured"
  and a real path otherwise (even before the first write lands) — never `''`. Treat `null` and a
  string as the only two states.
- `otelReady()` never rejects, even if OTel bring-up failed — a failed bring-up is reported through
  `telemetrySelfCheck().otel.state` (`'failed'`) instead, because telemetry must not be able to
  prevent the service it's observing from starting.
- `DurableJsonlSink` never throws on a write fault (disk full, fd revoked, directory unwritable) —
  it drops the record silently rather than propagating, because a logging fault must never break or
  slow the operation it is observing.
