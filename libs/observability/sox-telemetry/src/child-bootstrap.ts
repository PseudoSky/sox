/**
 * child-bootstrap.ts — BL-618 spawn-time telemetry bootstrap convention.
 *
 * ## The defect this closes
 *
 * `initTelemetry()` initialises PER-PROCESS module state in `runtime.ts`. A
 * composition root that calls it only fixes ITS OWN process — it can never
 * reach a forked child (`node:child_process.fork`) or a spawned worker
 * (`worker_threads.Worker`), each of which starts with its own fresh
 * `_state` at the `service:'unlabeled'`, `logSink:'none'` fallback. The
 * memory-core enrich fork child (`enrich-process-host.ts`) had exactly this
 * shape: the parent called `initTelemetry` at its own composition root, the
 * child never did, and every `sox.stage.cluster.*` / STAGE / OTel record the
 * child emitted was silently dropped (role `'harness'` fallback, `logSink:
 * 'none'`). BL-404 fixed the backend composition root (`index.ts`); it did not
 * — and structurally could not — fix the fork child.
 *
 * ## The convention
 *
 * Every process the system forks/spawns gets telemetry initialised through
 * this shared helper, and ACKS its resulting state back to the parent over the
 * child's existing IPC/`parentPort` channel with a `telemetry.ready` message
 * carrying `childTelemetrySnapshot()`. Two consequences, both deliberate:
 *
 *   1. A child that never calls `initTelemetry` (a bug, or a child added
 *      tomorrow by someone who never heard of telemetry) is no longer silently
 *      invisible — the parent records it as `unacked` in
 *      `telemetrySelfCheck().children`.
 *   2. A child that DID initialise is no longer trusted on faith — the parent
 *      records the child's OWN reported `service`/`role`/`logSink`/`filePath`
 *      (the ack), not the parent's intended config. `role` can legitimately
 *      differ: `resolveProcessRole` corrects `SOX_TELEMETRY_HARNESS=1` toward
 *      `'harness'` inside the child.
 *
 * ## Never throws
 *
 * `bootstrapChildTelemetry` is deliberately unable to break or slow the child
 * it initialises: malformed env is warned-on-stderr + fallen back to the
 * caller's defaults, and a failed `initTelemetry` returns a no-op handle.
 * Telemetry is an observability aid, never a correctness mechanism.
 */

import { fork, type ForkOptions, type ChildProcess } from 'node:child_process';
import { Worker, SHARE_ENV, type WorkerOptions } from 'node:worker_threads';
import {
  initTelemetry,
  resolveProcessRole,
  currentRuntimeState,
  type InitTelemetryOptions,
  type TelemetryHandle,
  type Role,
  type LogSink,
} from './runtime.js';

/**
 * The env key a parent writes and a child reads. Value is a JSON object
 * `{ service, role, logSink?, logDir?, maxBytes?, maxFiles?, durable?, otel? }`
 * — the same shape `initTelemetry` accepts (minus `snapshotEveryRecords`).
 */
export const SOX_TELEMETRY_INIT = 'SOX_TELEMETRY_INIT';

/** The child's own reported telemetry state, sent back as a `telemetry.ready` ack. */
export interface ChildTelemetrySnapshot {
  service: string;
  role: Role;
  logSink: LogSink;
  /** `null` iff `logSink !== 'file'` — the file the child's records land in. */
  filePath: string | null;
  pid: number;
}

const ROLES: readonly string[] = ['live-service', 'test', 'cli', 'harness'];
const LOG_SINKS: readonly string[] = ['file', 'stderr', 'none'];

function isRole(v: unknown): v is Role {
  return typeof v === 'string' && ROLES.includes(v);
}

function isLogSink(v: unknown): v is LogSink {
  return typeof v === 'string' && LOG_SINKS.includes(v);
}

function warn(message: string): void {
  process.stderr.write(`[sox-telemetry] ${message}\n`);
}

/**
 * Initialise telemetry in a forked/spawned child.
 *
 * Reads `SOX_TELEMETRY_INIT` from the environment (written by `forkChild` /
 * `spawnWorker` in the parent), validates and merges it over `defaults`, runs
 * `resolveProcessRole` on the resulting `role` (so a `SOX_TELEMETRY_HARNESS=1`
 * ambient still corrects toward `'harness'`), then calls `initTelemetry`.
 *
 * Never throws. Malformed env → warn on stderr and use `defaults` unchanged. A
 * failed `initTelemetry` → warn and return a no-op handle. The merged
 * `{ ...defaults, ...parsed }` precedence means the parent's explicitly-sent
 * config (e.g. a test-sandbox `logDir`) overrides the child's own defaults.
 */
export function bootstrapChildTelemetry(defaults: InitTelemetryOptions): TelemetryHandle {
  let parsed: Partial<InitTelemetryOptions> = {};
  const raw = process.env[SOX_TELEMETRY_INIT];
  if (raw !== undefined && raw !== '') {
    try {
      const candidate = JSON.parse(raw) as unknown;
      if (candidate !== null && typeof candidate === 'object' && typeof (candidate as { service?: unknown }).service === 'string') {
        const c = candidate as Record<string, unknown>;
        parsed = { service: c['service'] as string };
        if (isRole(c['role'])) parsed.role = c['role'];
        if (isLogSink(c['logSink'])) parsed.logSink = c['logSink'];
        if (typeof c['logDir'] === 'string') parsed.logDir = c['logDir'];
        if (typeof c['maxBytes'] === 'number') parsed.maxBytes = c['maxBytes'];
        if (typeof c['maxFiles'] === 'number') parsed.maxFiles = c['maxFiles'];
        if (typeof c['durable'] === 'boolean') parsed.durable = c['durable'];
        if (typeof c['otel'] === 'boolean') parsed.otel = c['otel'];
      } else {
        warn(`WARNING: malformed ${SOX_TELEMETRY_INIT} env (missing string 'service'); falling back to caller defaults.`);
      }
    } catch {
      warn(`WARNING: malformed ${SOX_TELEMETRY_INIT} env (invalid JSON); falling back to caller defaults.`);
    }
  }

  const merged: InitTelemetryOptions = { ...defaults, ...parsed };
  merged.role = resolveProcessRole(merged.role);

  try {
    return initTelemetry(merged);
  } catch (err) {
    warn(
      `WARNING: initTelemetry failed during child bootstrap (${err instanceof Error ? err.message : String(err)}); ` +
        'telemetry is a no-op for this child.',
    );
    return {
      service: merged.service,
      role: merged.role,
      currentLogFilePath: () => null,
      flush: () => Promise.resolve(),
      otelReady: () => Promise.resolve(),
      close: () => {},
    };
  }
}

/**
 * Snapshot the child's CURRENT telemetry state for a `telemetry.ready` ack.
 * `filePath` is `null` iff `logSink !== 'file'` — the sink's planned path
 * otherwise (so a reader knows where to look before the first record lands).
 */
export function childTelemetrySnapshot(): ChildTelemetrySnapshot {
  const st = currentRuntimeState();
  const filePath = st.logSink === 'file' ? (st.sink?.plannedPath() ?? null) : null;
  return {
    service: st.service,
    role: st.role,
    logSink: st.logSink,
    filePath,
    pid: process.pid,
  };
}

function mergeChildEnv(
  ambient: NodeJS.ProcessEnv | NodeJS.Dict<string> | typeof SHARE_ENV | undefined,
  telemetry: InitTelemetryOptions,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (ambient !== undefined && ambient !== SHARE_ENV) {
    Object.assign(env, ambient);
  }
  env[SOX_TELEMETRY_INIT] = JSON.stringify(telemetry);
  return env;
}

/**
 * Fork a child process with `SOX_TELEMETRY_INIT` injected into its env
 * (last-write-wins over any ambient/`forkOpts.env` value), so the child's
 * `bootstrapChildTelemetry` finds the parent's intended config.
 */
export function forkChild(
  modulePath: string,
  telemetry: InitTelemetryOptions,
  forkOpts?: ForkOptions,
): ChildProcess {
  return fork(modulePath, [], {
    ...forkOpts,
    env: mergeChildEnv(forkOpts?.env, telemetry),
  });
}

/**
 * Spawn a worker thread with `SOX_TELEMETRY_INIT` injected into its env — the
 * same contract as `forkChild`, for `worker_threads.Worker` entrypoints.
 */
export function spawnWorker(
  workerPath: string,
  telemetry: InitTelemetryOptions,
  workerOpts?: WorkerOptions,
): Worker {
  return new Worker(workerPath, {
    ...workerOpts,
    env: mergeChildEnv(workerOpts?.env, telemetry),
  });
}
