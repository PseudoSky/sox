/**
 * channel.ts — c536ce29 L2: the raw log channel.
 *
 * A `LogChannel` is a second, independently-retained JSONL stream beside the
 * span/event stream: structured ops records (`logEvent`) and raw wire records
 * (`logRaw`) that carry full headers and bodies. It composes
 * `DurableJsonlSink` (per-process file names, size rotation, async gzip, age +
 * directory-byte retention) with:
 *
 *  - **Redaction inside the channel** (the structured fields AND the serialized
 *    line), so no call site can forget it.
 *  - **Typed durability** (not a toggle): `sync` writes every record with
 *    `writeSync` on an `O_APPEND` fd (survives `kill -9`); `hybrid` writes
 *    records <= `syncMaxBytes` synchronously and routes larger ones through a
 *    bounded queue that is flushed before the next sync record of the same
 *    channel, on `flush()`, and on `beforeExit`/`exit`.
 *  - **A flood breaker**: past `maxBytes` of `logRaw` output inside `windowMs`
 *    the channel degrades to digest-only records (`body: null`, with
 *    `body_sha256`/`body_bytes` kept) and emits `log.budget_tripped` once.
 *
 * Nothing here reads an environment variable (ADR-0013) and no method throws
 * into the caller: serialization faults become a `log.serialize_error` record,
 * filesystem faults become counters plus a rate-limited stderr line. The
 * channel is safe for concurrent processes (ADR-0012): with the default
 * `fileScope: 'per-process'` no two processes ever share an open file.
 */

import { createRedactor, type Redactor } from './redact.js';
import type { CapturedBody } from './body.js';
import { currentLogContext } from './context.js';
import { currentRuntimeState, type LogFields } from './runtime.js';
import { currentTraceId } from './trace.js';
import { DurableJsonlSink, type JsonlSinkOptions } from './sink.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

export interface LogChannelOptions {
  /** Absolute directory; created recursively. The caller resolves it (e.g. via `@adhd/environment`). */
  dir: string;
  /** File prefix. Same collision rule as the sink: use '.' separators, never '-'. */
  component: string;
  /** Default `'per-process'` for channels (the existing sinks keep `'shared'`). */
  fileScope?: 'shared' | 'per-process';
  /** Stable instance label inserted into the file name. Default `proc`. */
  fileLabel?: string;
  /** Per-file rotation threshold. Default 64 MiB. */
  maxBytes?: number;
  /** Delete files older than this many days. Default 14. */
  maxAgeDays?: number;
  /** Delete oldest files until the component's files total <= this. Default 2 GiB. */
  maxDirBytes?: number;
  /** Gzip rotated files asynchronously. Default true. */
  gzipRotated?: boolean;
  /** Advisory per-body cap for callers using `captureBody`. Default 4 MiB. */
  bodyMaxBytes?: number;
  /** `logRaw` byte budget per window before digest-only mode. Default 256 MiB / 10 min. */
  floodBreaker?: { windowMs: number; maxBytes: number };
  /** Default `{ mode: 'hybrid', syncMaxBytes: 65536 }`. */
  durability?: { mode: 'sync' | 'hybrid'; syncMaxBytes?: number };
  /** Bytes of large records the hybrid queue may hold; overflow drops the oldest, counted. Default 16 MiB. */
  queueMaxBytes?: number;
  /** Default `createRedactor()`. */
  redactor?: Redactor;
}

export interface LogChannel {
  /** Structured ops record. */
  logEvent(event: string, fields?: LogFields, level?: Level): void;
  /** Wire record (headers/body). Honours the flood breaker. */
  logRaw(event: string, payload: { headers?: Record<string, string>; body?: CapturedBody; [k: string]: unknown }): void;
  /** pino-compatible destination: `pino.multistream([{ stream: channel.destination() }])`. */
  destination(): { write(chunk: string): void };
  /** Scrub this exact value (>= 8 chars) from everything written from now on. */
  registerSecret(value: string): void;
  /** Resolve once every queued record and pending gzip has reached disk. */
  flush(): Promise<void>;
  /** Flush, then stop accepting records. Idempotent. */
  close(): Promise<void>;
  stats(): { written: number; dropped: number; serializeErrors: number; rotated: number; floodTripped: boolean };
}

const MIB = 1024 * 1024;
const DEFAULT_SYNC_MAX_BYTES = 64 * 1024;
const QUEUE_FLUSH_BYTES = 64 * 1024;
const QUEUE_FLUSH_MS = 50;
const STDERR_MIN_INTERVAL_MS = 10_000;
/** Envelope keys a caller field or context id can never overwrite. */
const RESERVED = new Set(['ts', 'level', 'event', 'service', 'role', 'release', 'pid', 'schema', 'stream', 'trace_id']);

/** Drain hooks of every open channel; one process-level listener pair serves them all. */
const openChannels = new Set<() => void>();
let exitHooksInstalled = false;

function drainAll(): void {
  for (const drain of [...openChannels]) {
    try {
      drain();
    } catch {
      /* never throw at process exit */
    }
  }
}

function installExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  process.on('beforeExit', drainAll);
  process.on('exit', drainAll);
}

/**
 * Create a raw log channel. Never throws for a bad directory (the failure
 * surfaces as `stats().dropped` plus a rate-limited stderr line on write).
 */
export function createLogChannel(opts: LogChannelOptions): LogChannel {
  const component = opts.component;
  const redactor = opts.redactor ?? createRedactor();
  const mode = opts.durability?.mode ?? 'hybrid';
  const syncMaxBytes = opts.durability?.syncMaxBytes ?? DEFAULT_SYNC_MAX_BYTES;
  const queueMaxBytes = opts.queueMaxBytes ?? 16 * MIB;
  const flood = opts.floodBreaker ?? { windowMs: 10 * 60_000, maxBytes: 256 * MIB };

  let written = 0;
  let dropped = 0;
  let serializeErrors = 0;
  let closed = false;
  let lastStderrAt = 0;

  const warnStderr = (msg: string): void => {
    try {
      const now = Date.now();
      if (now - lastStderrAt < STDERR_MIN_INTERVAL_MS) return;
      lastStderrAt = now;
      process.stderr.write(`[sox-telemetry] log channel '${component}': ${msg}\n`);
    } catch {
      /* stderr itself failed — nothing left to do */
    }
  };

  const sinkOpts: JsonlSinkOptions = {
    dir: opts.dir,
    component,
    maxBytes: opts.maxBytes ?? 64 * MIB,
    // Count retention is not a channel concept: age + directory bytes govern.
    maxFiles: Number.MAX_SAFE_INTEGER,
    durable: true,
    fileScope: opts.fileScope ?? 'per-process',
    maxAgeDays: opts.maxAgeDays ?? 14,
    maxDirBytes: opts.maxDirBytes ?? 2 * 1024 * MIB,
    gzipRotated: opts.gzipRotated ?? true,
    onError: (err, op): void => {
      warnStderr(`${op} failed (${err instanceof Error ? err.message : String(err)}); records are being dropped`);
    },
  };
  if (opts.fileLabel !== undefined) sinkOpts.fileLabel = opts.fileLabel;
  const sink = new DurableJsonlSink(sinkOpts);

  // ---- write path -------------------------------------------------------
  let queue: Array<{ line: string; bytes: number }> = [];
  let queueBytes = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let immediate: ReturnType<typeof setImmediate> | null = null;

  const commit = (line: string): void => {
    if (sink.tryWrite(line)) written++;
    else dropped++;
  };

  const drain = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (immediate !== null) {
      clearImmediate(immediate);
      immediate = null;
    }
    if (queue.length === 0) return;
    const q = queue;
    queue = [];
    queueBytes = 0;
    for (const e of q) commit(e.line);
  };

  const enqueue = (line: string, bytes: number): void => {
    queue.push({ line, bytes });
    queueBytes += bytes;
    while (queueBytes > queueMaxBytes && queue.length > 0) {
      const old = queue.shift();
      if (old) {
        queueBytes -= old.bytes;
        dropped++;
      }
    }
    if (queueBytes >= QUEUE_FLUSH_BYTES) {
      if (immediate === null) immediate = setImmediate(drain);
    } else if (timer === null && queue.length > 0) {
      timer = setTimeout(drain, QUEUE_FLUSH_MS);
      timer.unref();
    }
  };

  const emitLine = (line: string): void => {
    if (closed) {
      dropped++;
      return;
    }
    const bytes = Buffer.byteLength(line);
    if (mode === 'sync' || bytes <= syncMaxBytes) {
      drain(); // a queued record precedes the next sync record of this channel
      commit(line);
    } else {
      enqueue(line, bytes);
    }
  };

  openChannels.add(drain);
  installExitHooks();

  // ---- record building --------------------------------------------------
  const buildRecord = (level: Level, event: string, fields: Record<string, unknown> | undefined): Record<string, unknown> => {
    const st = currentRuntimeState();
    const ctx = currentLogContext();
    const explicitTrace = fields && typeof fields['trace_id'] === 'string' ? (fields['trace_id'] as string) : undefined;
    const ctxTrace = typeof ctx['trace_id'] === 'string' ? (ctx['trace_id'] as string) : undefined;
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      event,
      service: st.service,
      role: st.role,
      release: { ...st.release },
      trace_id: explicitTrace ?? ctxTrace ?? currentTraceId() ?? null,
      pid: process.pid,
      schema: 1,
      stream: component,
    };
    for (const src of [ctx as Record<string, unknown>, fields ?? {}]) {
      for (const k of Object.keys(src)) {
        if (RESERVED.has(k) || src[k] === undefined) continue;
        record[k] = src[k];
      }
    }
    return record;
  };

  /** Redact + serialize. A fault becomes a `log.serialize_error` record, never a throw. */
  const serialize = (record: Record<string, unknown>): string => {
    try {
      return redactor.redactLine(JSON.stringify(redactor.redactValue(record))) + '\n';
    } catch {
      serializeErrors++;
      try {
        return (
          JSON.stringify({
            ts: record['ts'],
            level: 'error',
            event: 'log.serialize_error',
            service: record['service'],
            role: record['role'],
            trace_id: record['trace_id'] ?? null,
            pid: process.pid,
            schema: 1,
            stream: component,
            original_event: typeof record['event'] === 'string' ? record['event'] : null,
          }) + '\n'
        );
      } catch {
        return '{"event":"log.serialize_error"}\n';
      }
    }
  };

  // ---- flood breaker ----------------------------------------------------
  let windowStart = Date.now();
  let windowBytes = 0;
  let tripped = false;

  /** True when this logRaw record must be digest-only. Emits `log.budget_tripped` on the trip. */
  const shouldDigest = (lineBytes: number): boolean => {
    const now = Date.now();
    if (now - windowStart >= flood.windowMs) {
      windowStart = now;
      windowBytes = 0;
      tripped = false;
    }
    if (tripped) return true;
    if (windowBytes + lineBytes > flood.maxBytes) {
      tripped = true;
      api.logEvent('log.budget_tripped', { window_ms: flood.windowMs, max_bytes: flood.maxBytes, window_bytes: windowBytes }, 'warn');
      return true;
    }
    windowBytes += lineBytes;
    return false;
  };

  const rawFields = (payload: { headers?: Record<string, string>; body?: CapturedBody; [k: string]: unknown }, digestOnly: boolean): Record<string, unknown> => {
    const { headers, body, ...rest } = payload;
    const fields: Record<string, unknown> = { ...rest };
    if (headers !== undefined) fields['headers'] = headers;
    if (body !== undefined && body !== null && typeof body === 'object') {
      fields['body'] = digestOnly ? null : body.body;
      fields['body_bytes'] = body.body_bytes;
      fields['body_sha256'] = body.body_sha256;
      fields['truncated'] = body.truncated;
    }
    if (digestOnly) fields['digest_only'] = true;
    return fields;
  };

  const api: LogChannel = {
    logEvent(event, fields, level = 'info'): void {
      try {
        emitLine(serialize(buildRecord(level, event, fields)));
      } catch {
        serializeErrors++;
      }
    },

    logRaw(event, payload): void {
      try {
        let line = serialize(buildRecord('info', event, rawFields(payload, false)));
        if (shouldDigest(Buffer.byteLength(line))) {
          line = serialize(buildRecord('info', event, rawFields(payload, true)));
        }
        emitLine(line);
      } catch {
        serializeErrors++;
      }
    },

    destination(): { write(chunk: string): void } {
      return {
        write(chunk: string): void {
          try {
            const text = typeof chunk === 'string' ? chunk : String(chunk);
            const lines = text.split('\n').filter((l) => l.length > 0);
            if (lines.length === 0) return;
            emitLine(lines.map((l) => redactor.redactLine(l)).join('\n') + '\n');
          } catch {
            serializeErrors++;
          }
        },
      };
    },

    registerSecret(value: string): void {
      try {
        redactor.registerSecret(value);
      } catch {
        /* never throws */
      }
    },

    async flush(): Promise<void> {
      try {
        drain();
        await sink.flush();
      } catch {
        /* never throws */
      }
    },

    async close(): Promise<void> {
      if (closed) return;
      try {
        await api.flush();
      } finally {
        closed = true;
        openChannels.delete(drain);
        try {
          sink.close();
        } catch {
          /* ignore */
        }
      }
    },

    stats(): { written: number; dropped: number; serializeErrors: number; rotated: number; floodTripped: boolean } {
      return { written, dropped, serializeErrors, rotated: sink.rotatedCount(), floodTripped: tripped };
    },
  };
  return api;
}
