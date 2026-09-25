/**
 * embedHostMain.ts — the peer-spawned embedding host: a work-driven drainer
 * (ADR-0022, superseding ADR-0020 D2/D6).
 *
 * This is the compute backend of the funnel: a plain, DETACHED Node process,
 * spawned on demand by the first consumer through `ensureBackend()`'s O_EXCL
 * singleton spawn-lock. It is **never supervised** (no launchd/KeepAlive).
 *
 * ── Lifecycle: it works, then it dies (ADR-0022 §1, §2) ───────────────────────
 *
 * The host lives while it has work and retires `W` (`--idle-window-ms`, the
 * typed `idleGraceMs`, default 60 s) after its last COMPLETED real work.
 * "Work" is `embedding.init` / `embedding.embed` / `embedding.embedBatch` and
 * the host's own eager model load. Connections are NOT an input: the `:3099`
 * front shim holds a permanent connection, and a connection-counted reap made
 * the host immortal. Health probes, resets and handshakes are not work.
 * There is no keep-warm.
 *
 * {@link reapDueInMs} is the whole policy. Retirement is ordered and starts
 * synchronously in one tick: flip to `'retiring'` → close the listener
 * (destroys client sockets; the socket path is unlinked, inode-guarded) → THEN
 * terminate the private pool → exit 0. A frame that lands after the flip gets
 * -32001 "embedding host retiring" and never touches the pool; the client
 * retries through a fresh ensure.
 *
 * ── Identity (ADR-0022 §3, §4, §5) ───────────────────────────────────────────
 *
 * The host takes its identity from argv (`parseEmbedHostArgs`), refuses to run
 * under a build id that is not its own (exit 3), serves only the model it was
 * spawned for (-32602 otherwise), and loads that model itself — eagerly, and
 * again after `embedding.reset` — so any request routed to it can be served.
 *
 * ── Compute-only (ADR-0012) ────────────────────────────────────────────────────
 *
 * The host holds NO store connection. It forwards `embedding.*` payloads to its
 * private ONNX pool and never opens a database.
 *
 * ── No recursion; the accessor is resolved at EVERY use ────────────────────────
 *
 * The handler forwards to `getPrivateFastembedProcess()` — the PRIVATE pool —
 * and NEVER to `getSharedFastembedProcess()` (which would dial this very host).
 * `embedding.reset` terminates AND nulls the private singleton, so every use
 * resolves the accessor fresh rather than capturing it.
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { serveBackend, type BackendHandle, type JsonRpcRequest, type JsonRpcResponse } from '@adhd/sox-service-proxy';
import { bootstrapChildTelemetry, log } from '@adhd/sox-telemetry';
import {
  EMBED_HOST_PROTOCOL_VERSION,
  computeEmbedHostBuildId,
  parseEmbedHostArgs,
  type EmbedHostSpawnArgs,
} from './embedHostConfig.js';
import { getPrivateFastembedProcess, resetPrivateFastembedProcess } from './sharedFastembedProcess.js';

/** `'serving'` until retirement starts; `'retiring'` is terminal. */
export type EmbedHostState = 'serving' | 'retiring';

/** JSON-RPC code a retiring host answers with (the client re-ensures and retries). */
export const ERR_HOST_RETIRING = -32001;

/**
 * 68a4bf68: the reap policy, as a pure function (ADR-0022 §1).
 *
 * Returns `null` when the host must not retire at all right now (it is already
 * retiring, or work is in flight, or its private pool still has requests
 * pending) and otherwise the milliseconds until the idle window `W` since the
 * last COMPLETED work elapses (0 = retire now). Connection count is
 * deliberately not a parameter.
 */
export function reapDueInMs(args: {
  state: EmbedHostState;
  inFlightWork: number;
  poolPending: number;
  lastWorkAt: number;
  now: number;
  idleWindowMs: number;
}): number | null {
  if (args.state === 'retiring' || args.inFlightWork > 0 || args.poolPending > 0) return null;
  return Math.max(0, args.lastWorkAt + args.idleWindowMs - args.now);
}

/** The `embedding.*` methods the host serves. */
const HOST_METHODS = new Set([
  'embedding.init',
  'embedding.embed',
  'embedding.embedBatch',
  'embedding.reset',
  'embedding.health',
]);

function ok(id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function fail(id: JsonRpcRequest['id'], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** JSON-RPC invalid params — a request for a model/cacheDir this host does not serve. */
export const ERR_WRONG_MODEL = -32602;

/**
 * dc73d9b6: check a work request's `{model, cacheDir}` against the identity
 * this host was spawned for. Returns an error message, or `null` when it matches.
 * A request with no identity at all is also refused — a v2 client always stamps it.
 */
export function checkRequestIdentity(
  params: Record<string, unknown>,
  served: { model: string; cacheDir: string },
): string | null {
  const model = params['model'];
  const cacheDir = params['cacheDir'];
  if (model !== served.model || cacheDir !== served.cacheDir) {
    return (
      `embedding host serves model ${JSON.stringify(served.model)} with cacheDir ${JSON.stringify(served.cacheDir)}; ` +
      `request named model ${JSON.stringify(model)} with cacheDir ${JSON.stringify(cacheDir)}`
    );
  }
  return null;
}

/**
 * Start the host: parse argv, bind the UDS, serve `embedding.*`, load the
 * model, and arm the work-driven reap. Resolves once the listener is up; the
 * process stays alive until it retires or a signal arrives.
 */
export async function runEmbedHost(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  // Composition root for this process (mirrors memory-server's index.ts BL-404
  // call): the detached host starts with fresh @adhd/sox-telemetry module state
  // — service:'unlabeled', logSink:'none' — so without this every record would
  // be silently dropped. It runs before anything that can exit.
  bootstrapChildTelemetry({ service: 'embed-host', role: 'live-service', logSink: 'file' });
  const startedAt = Date.now();

  // dc73d9b6: identity arrives as argv (ADR-0022), never as inherited env.
  let args: EmbedHostSpawnArgs;
  try {
    args = parseEmbedHostArgs(argv);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.error('embedding_provider.embed_host.bad_args', { error: message });
    process.stderr.write(
      `[embed-host] ${message} — the host is spawned by the funnel client, not run directly.\n`,
    );
    process.exit(2);
  }
  const socketPath = args.socketPath;

  // 2fe52b0f: refuse to serve under a build id that is not our own. The
  // spawner computed it from the same host main path; a mismatch means a
  // different build's bytes are answering for this key.
  const entry = process.argv[1] ?? '';
  const ownBuildId = entry ? computeEmbedHostBuildId(entry) : '';
  if (ownBuildId !== args.buildId) {
    log.error('embedding_provider.embed_host.spawn_rejected', {
      reason: 'build_id_mismatch',
      expected: args.buildId,
      actual: ownBuildId,
      entry,
    });
    process.stderr.write(
      `[embed-host] build id mismatch: spawned as ${args.buildId}, this build is ${ownBuildId} (${entry})\n`,
    );
    process.exit(3);
  }

  // The execution provider is part of the key; pin it before the private pool
  // forks its ONNX child (which reads SOX_EMBED_EXECUTION_PROVIDER).
  if (args.ep !== 'auto') process.env['SOX_EMBED_EXECUTION_PROVIDER'] = args.ep;

  const idleWindowMs = args.idleWindowMs;
  const served = { model: args.model, cacheDir: args.cacheDir };
  const hostInstanceId = randomUUID();

  let state: EmbedHostState = 'serving';
  let handle: BackendHandle | null = null;
  /** Live client connections — reported for diagnostics only, NEVER a reap input. */
  let activeClients = 0;
  let requestsServed = 0;
  /**
   * Real work in flight (init/embed/embedBatch + the eager model load).
   * Incremented synchronously before a handler's first `await`, so it covers a
   * cold-start fork where the private pool's `pendingCount` still reads 0.
   */
  let inFlightWork = 0;
  /** When the last real work COMPLETED (success or failure). Starts at spawn. */
  let lastWorkAt = startedAt;
  let reapTimer: NodeJS.Timeout | null = null;

  // ── host-owned model init (dc73d9b6) ────────────────────────────────────────
  let modelPromise: Promise<Record<string, unknown>> | null = null;
  let modelLoaded = false;
  let resetSinceInit = false;
  /**
   * Load the served model into the private pool. Memoized so concurrent work
   * shares one init; cleared on failure (the next request retries) and on
   * `embedding.reset` (the fresh pool has no model).
   */
  const ensureModel = (trigger: 'eager' | 'request' | 'after_reset'): Promise<Record<string, unknown>> => {
    if (modelPromise) return modelPromise;
    const started = performance.now();
    const p = getPrivateFastembedProcess()
      .request<Record<string, unknown>>({ type: 'init', model: served.model, cacheDir: served.cacheDir })
      .then(
        (res) => {
          modelLoaded = true;
          log.info('embedding_provider.embed_host.model.init', {
            trigger,
            ok: true,
            model: served.model,
            init_ms: performance.now() - started,
          });
          return res;
        },
        (e: unknown) => {
          if (modelPromise === p) modelPromise = null;
          modelLoaded = false;
          log.warn('embedding_provider.embed_host.model.init', {
            trigger,
            ok: false,
            model: served.model,
            init_ms: performance.now() - started,
            error: e instanceof Error ? e.message : String(e),
          });
          throw e;
        },
      );
    modelPromise = p;
    return p;
  };

  // ── the work-driven reap (68a4bf68) ─────────────────────────────────────────
  const dueNow = (): number | null =>
    reapDueInMs({
      state,
      inFlightWork,
      poolPending: getPrivateFastembedProcess().pendingCount,
      lastWorkAt,
      now: Date.now(),
      idleWindowMs,
    });

  const clearReap = (): void => {
    if (reapTimer) {
      clearTimeout(reapTimer);
      reapTimer = null;
    }
  };

  /** (Re-)arm the reap from the current state. Called at startup and after every work completion. */
  const scheduleReap = (): void => {
    const due = dueNow();
    const wasArmed = reapTimer !== null;
    clearReap();
    if (due === null) return;
    reapTimer = setTimeout(onReapTimer, due);
    // The listener keeps the loop alive; the timer itself must not.
    reapTimer.unref?.();
    if (!wasArmed) log.info('embedding_provider.embed_host.reap.armed', { due_ms: due, idle_window_ms: idleWindowMs });
  };

  const onReapTimer = (): void => {
    reapTimer = null;
    const due = dueNow();
    if (due === null) return;
    if (due > 0) {
      reapTimer = setTimeout(onReapTimer, due);
      reapTimer.unref?.();
      return;
    }
    void retire('idle_window_elapsed');
  };

  /**
   * Ordered retirement (ADR-0022 §2). The prefix up to `handle.close()` runs
   * synchronously in one tick: nothing can be admitted between the decision
   * and the listener closing. Only then is the pool terminated.
   */
  const retire = async (reason: string): Promise<void> => {
    if (state === 'retiring') return;
    state = 'retiring';
    clearReap();
    log.info('embedding_provider.embed_host.reap.fired', {
      reason,
      lifetime_ms: Date.now() - startedAt,
      requests_served: requestsServed,
      active_clients: activeClients,
      last_work_ago_ms: Date.now() - lastWorkAt,
    });
    const closing = handle ? handle.close() : Promise.resolve();
    try {
      await closing;
    } catch (e) {
      log.warn('embedding_provider.embed_host.close_failed', { error: e instanceof Error ? e.message : String(e) });
    }
    try {
      // Resolve the accessor now: a reset may have swapped the private singleton.
      await getPrivateFastembedProcess().terminate();
    } catch (e) {
      // The ONNX child is forked detached:false and dies with us regardless.
      log.warn('embedding_provider.embed_host.pool_terminate_failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    log.info('embedding_provider.embed_host.exit', { code: 0, reason });
    process.exit(0);
  };

  /** Run one unit of real work under the in-flight count; completion re-arms the reap. */
  const doWork = async <T>(method: string, fn: () => Promise<T>): Promise<T> => {
    inFlightWork++;
    if (reapTimer) {
      clearReap();
      log.info('embedding_provider.embed_host.reap.cancelled', { reason: 'work', method });
    }
    try {
      return await fn();
    } finally {
      inFlightWork--;
      lastWorkAt = Date.now();
      scheduleReap();
    }
  };

  const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
    const id = req.id;
    const method = req.method;
    // A frame that lands after the retire flip never touches the pool.
    if (state === 'retiring') return fail(id, ERR_HOST_RETIRING, 'embedding host retiring');
    if (!HOST_METHODS.has(method)) return fail(id, -32601, `method not found: ${method}`);

    try {
      if (method === 'embedding.health') {
        const pc = getPrivateFastembedProcess();
        return ok(id, {
          protocol: EMBED_HOST_PROTOCOL_VERSION,
          buildId: args.buildId,
          hostInstanceId,
          state,
          modelLoaded,
          lastWorkAgoMs: Date.now() - lastWorkAt,
          reapDueInMs: dueNow(),
          started: pc.started,
          pendingCount: pc.pendingCount,
          inFlightWork,
          activeClients,
          idleWindowMs,
          requestsServed,
        });
      }
      if (method === 'embedding.reset') {
        // The fresh pool has no model: forget the memo so the next work
        // request (from ANY client) re-inits it — a reset never bricks peers.
        modelPromise = null;
        modelLoaded = false;
        resetSinceInit = true;
        await resetPrivateFastembedProcess();
        return ok(id, { reset: true });
      }
      // embedding.init | embedding.embed | embedding.embedBatch — the request
      // must name the model this host serves (a refusal is not work).
      const params = (req.params ?? {}) as Record<string, unknown>;
      const mismatch = checkRequestIdentity(params, served);
      if (mismatch !== null) return fail(id, ERR_WRONG_MODEL, mismatch);
      return await doWork(method, async () => {
        const trigger = resetSinceInit ? 'after_reset' : 'request';
        resetSinceInit = false;
        const initResult = await ensureModel(trigger);
        requestsServed++;
        if (method === 'embedding.init') return ok(id, initResult);
        // Forward to the PRIVATE pool, resolved per use (never captured).
        return ok(id, await getPrivateFastembedProcess().request(params));
      });
    } catch (e) {
      return fail(id, -32603, e instanceof Error ? e.message : String(e));
    }
  };

  handle = await serveBackend({
    socketPath,
    handler,
    onDiagnostic: (line) => process.stderr.write(line + '\n'),
    onClientCountChange: (active) => {
      // Diagnostics only — connections are not a reap input (ADR-0022 §1).
      activeClients = active;
    },
  });
  log.info('embedding_provider.embed_host.listening', {
    socket: socketPath,
    build_id: args.buildId,
    host_instance_id: hostInstanceId,
    idle_window_ms: idleWindowMs,
  });

  // Load the model eagerly (counted as work): the first request should not pay
  // for it, and a replayed request must find a ready host.
  void doWork('eager_init', () => ensureModel('eager')).catch((e: unknown) => {
    // Already logged by ensureModel (model.init ok:false); the next request retries.
    log.debug('embedding_provider.embed_host.eager_init_deferred', {
      error: e instanceof Error ? e.message : String(e),
    });
  });

  // Arm at startup too: a host nobody ever uses must still retire.
  scheduleReap();

  // A detached host can still be signalled directly (kill, OS teardown).
  process.on('SIGTERM', () => void retire('signal:SIGTERM'));
  process.on('SIGINT', () => void retire('signal:SIGINT'));
}

/**
 * True when this module is the process entrypoint (`node dist/embedHostMain.js`).
 * `ensureBackend` spawns exactly that. A test shim that imports this module and
 * calls `runEmbedHost()` explicitly is NOT the entrypoint, so it does not
 * double-start.
 */
function isEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return resolve(fileURLToPath(import.meta.url)) === resolve(argv1);
  } catch (e) {
    // An unresolvable module URL means we cannot prove we are the entrypoint;
    // never double-start (a shim that imports this module calls runEmbedHost).
    process.stderr.write(`[embed-host] entrypoint check skipped: ${e instanceof Error ? e.message : String(e)}\n`);
    return false;
  }
}

if (isEntrypoint()) {
  runEmbedHost().catch((err: unknown) => {
    process.stderr.write(`[embed-host] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
