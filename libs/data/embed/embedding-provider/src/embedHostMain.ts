/**
 * embedHostMain.ts — the peer-spawned, self-reaping embedding host process
 * (SPEC-EMBEDDING-FUNNEL.md §C).
 *
 * This is the compute backend of the funnel: a plain, DETACHED Node process,
 * spawned on demand by the first consumer through `ensureBackend()`'s O_EXCL
 * singleton spawn-lock. It is **never supervised** (no launchd/KeepAlive) and it
 * **reaps itself** — a debounced, ref-counted teardown retires it
 * `idleGraceMs` after the last cross-process client disconnects and in-flight
 * work drains.
 *
 * ── Compute-only (ADR-0012) ────────────────────────────────────────────────────
 *
 * The host holds NO store connection. It forwards `embedding.*` payloads 1:1 to
 * its private ONNX pool and never opens a database. It therefore cannot
 * serialize store access and must never be described as single-writer or as a
 * store serialization point; concurrent store writers are unaffected.
 *
 * ── No recursion ───────────────────────────────────────────────────────────────
 *
 * The handler forwards to `getPrivateFastembedProcess()` — the PRIVATE pool — and
 * NEVER to `getSharedFastembedProcess()`, which under `host: 'shared'` would
 * return a `FunneledFastembedClient` and dial this very host (infinite
 * recursion). The import graph is arranged so that mistake is a type error, not
 * a runtime hang.
 *
 * ── Teardown inputs are CROSS-PROCESS ─────────────────────────────────────────
 *
 *   - `activeClients` — live UDS client connections, from `serveBackend`'s
 *     `onClientCountChange` hook (the cross-process half);
 *   - `inFlight` — THIS host's own request depth, incremented synchronously at
 *     the top of every handler invocation and decremented in its `finally` (the
 *     in-process half). It is deliberately NOT the private pool's
 *     `pendingCount`: that counter is incremented only AFTER `ensureProcess()`
 *     (the fork) resolves, so it reads 0 during a cold-start fork and would arm
 *     a reap over live work. `inFlight` is the synchronous truth.
 *
 * `activeClients === 0 && inFlight === 0` arms the grace timer; a new client
 * or request cancels it. On expiry the private pool is terminated, the listener
 * closed (which unlinks the socket), and the process exits 0. The private pool's
 * ONNX child is forked `detached: false`, so it dies with the host — no orphans.
 *
 * ── The accessor is resolved at EVERY use, never captured ──────────────────────
 *
 * `embedding.reset` terminates AND nulls the private singleton
 * (`resetPrivateFastembedProcess()`); a host that captured the accessor once
 * would keep forwarding through the terminated reference and answer every later
 * request with `shared fastembed process terminated`. Every use
 * (the request handler, `armIfIdle`, `teardown`, `health`) therefore calls
 * `getPrivateFastembedProcess()` fresh.
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

/**
 * How often to run a tiny keep-warm embed while at least one client is
 * attached, so the host's ONNX model pages stay resident under memory
 * pressure (root cause of 5-73s cold-page query embeds). `0` disables.
 * Default 45s — comfortably inside the funnel client's idle windows but
 * cheap enough not to compete meaningfully with real traffic.
 */
export function resolveEmbedKeepWarmMs(): number {
  const raw = process.env['SOX_EMBED_KEEPWARM_MS'];
  const DEFAULT_MS = 45_000;
  if (raw === undefined || raw === '') return DEFAULT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    // Never let a malformed optional tuning var kill the detached host at
    // startup (it has no client watching stderr) — log through telemetry so
    // the cause lands in the host's own log file, and fall back to the
    // default, matching resolveRecallVecCooldownMs's convention in recall.ts.
    log.warn('embedding_provider.embed_host.invalid_keepwarm_ms', { raw, fallback: DEFAULT_MS });
    return DEFAULT_MS;
  }
  return parsed;
}

/** Cap for both the active window and the backoff-doubled keep-warm interval. */
const KEEPWARM_INTERVAL_CAP_MS = 900_000;

/** A slow keep-warm embed (> this) signals memory pressure and triggers backoff. */
export const KEEPWARM_SLOW_MS = 6_000;

/**
 * Pure decision function for whether a keep-warm tick should be skipped,
 * factored out of `keepWarmTick`'s closure so the three independent gates
 * (activity window / cadence / no-init-yet) are unit-testable without
 * spinning up the real UDS host or a private fastembed process. Mirrors the
 * exact checks (and order) in `keepWarmTick` — see the inline comments there
 * for the rationale of each gate.
 */
export function shouldSkipKeepWarmTick(args: {
  now: number;
  lastRealActivityAt: number;
  lastActivityAt: number;
  keepWarmActiveWindowMs: number;
  keepWarmIntervalMs: number;
  hasInit: boolean;
}): boolean {
  const { now, lastRealActivityAt, lastActivityAt, keepWarmActiveWindowMs, keepWarmIntervalMs, hasInit } = args;
  if (now - lastRealActivityAt >= keepWarmActiveWindowMs) return true;
  if (now - lastActivityAt < keepWarmIntervalMs) return true;
  if (!hasInit) return true;
  return false;
}

/**
 * Pure adaptive-cadence function, factored out of `keepWarmTick`'s `.finally`.
 * A successful slow tick (> `KEEPWARM_SLOW_MS`) doubles the interval, capped
 * at `KEEPWARM_INTERVAL_CAP_MS`; a successful fast tick resets to `baseMs`; a
 * failed tick (timeout, child crash) leaves the cadence untouched — its
 * timing says nothing about paging cost.
 */
export function nextKeepWarmIntervalMs(args: {
  currentIntervalMs: number;
  baseMs: number;
  workMs: number;
  tickOk: boolean;
  capMs?: number;
  slowMs?: number;
}): number {
  const { currentIntervalMs, baseMs, workMs, tickOk, capMs = KEEPWARM_INTERVAL_CAP_MS, slowMs = KEEPWARM_SLOW_MS } = args;
  if (!tickOk) return currentIntervalMs;
  if (workMs > slowMs) return Math.min(currentIntervalMs * 2, capMs);
  return baseMs;
}

/**
 * How recently a REAL (non-keep-warm) request must have been served for
 * keep-warm to keep ticking. The `:3099` front shim holds a permanent UDS
 * connection to this host, so `activeClients` alone is always >= 1 and can
 * never signal real demand — gating on client count made keep-warm fire
 * forever even with zero actual traffic. Default 900s (15min).
 */
export function resolveEmbedKeepWarmActiveWindowMs(): number {
  const raw = process.env['SOX_EMBED_KEEPWARM_ACTIVE_WINDOW_MS'];
  const DEFAULT_MS = KEEPWARM_INTERVAL_CAP_MS;
  if (raw === undefined || raw === '') return DEFAULT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    log.warn('embedding_provider.embed_host.invalid_keepwarm_active_window_ms', { raw, fallback: DEFAULT_MS });
    return DEFAULT_MS;
  }
  return parsed;
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
 * Start the host: bind the UDS, serve `embedding.*`, and arm the debounced
 * self-reap. Resolves once the listener is up (so a caller/test can await
 * readiness); the process stays alive until the teardown fires or a signal
 * arrives.
 */
export async function runEmbedHost(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  // Composition root for this process (mirrors memory-server's index.ts BL-404
  // call): the detached host forked by `ensureBackend()` starts with fresh
  // module state in @adhd/sox-telemetry — service:'unlabeled', logSink:'none' —
  // so every `fastembed_process.request.*` record was silently dropped until
  // this call. `bootstrapChildTelemetry` (BL-618 convention) also honours a
  // `SOX_TELEMETRY_INIT` env override from the spawner if one is ever added,
  // falling back to these defaults today since the funnel client does not set it.
  bootstrapChildTelemetry({ service: 'embed-host', role: 'live-service', logSink: 'file' });

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

  const idleGraceMs = args.idleWindowMs;
  const served = { model: args.model, cacheDir: args.cacheDir };
  const hostInstanceId = randomUUID();
  let requestsServed = 0;

  /**
   * dc73d9b6: the host owns its model init. Memoized so concurrent work
   * requests share one init; cleared on failure (the next request retries) and
   * on `embedding.reset` (the fresh pool has no model).
   */
  let modelPromise: Promise<Record<string, unknown>> | null = null;
  let modelLoaded = false;
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
  let resetSinceInit = false;

  let activeClients = 0;
  /**
   * This host's own in-flight request depth. Incremented synchronously before
   * the handler's first `await` and decremented in its `finally`, so it covers a
   * request's entire synchronous prefix — including the cold-start fork, where
   * the private pool's `pendingCount` still reads 0.
   */
  let inFlight = 0;
  let idleTimer: NodeJS.Timeout | null = null;
  let shuttingDown = false;
  let handle: BackendHandle | null = null;

  const keepWarmMs = resolveEmbedKeepWarmMs();
  const keepWarmActiveWindowMs = resolveEmbedKeepWarmActiveWindowMs();
  let keepWarmTimer: NodeJS.Timeout | null = null;
  // Last time a request (real or keep-warm) COMPLETED — used to skip a tick
  // when a real request already refreshed the model pages this interval.
  let lastActivityAt = Date.now();
  // Last time a REAL (non-keep-warm) request was served. Epoch (0) until the
  // first one lands, so keep-warm never fires before any genuine traffic has
  // been observed — a permanently-connected client with zero real requests
  // must not keep the model paged in forever.
  let lastRealActivityAt = 0;
  // Adaptive keep-warm cadence: doubles (capped at KEEPWARM_INTERVAL_CAP_MS)
  // whenever a keep-warm embed takes > 6s (a sign the box is under memory
  // pressure and paging is expensive), and resets to the configured base on
  // a fast tick.
  let keepWarmIntervalMs = keepWarmMs;

  const cancelIdle = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const stopKeepWarm = (): void => {
    if (keepWarmTimer) {
      clearInterval(keepWarmTimer);
      keepWarmTimer = null;
    }
  };

  const keepWarmTick = (): void => {
    if (shuttingDown || activeClients === 0 || inFlight !== 0) return;
    // Activity gate: the `:3099` front shim holds a permanent connection, so
    // `activeClients` is always >= 1 and can never signal real demand on its
    // own. Only keep warming while a REAL (non-keep-warm) request landed
    // within the active window, AND skip this particular tick if something
    // (real or keep-warm) already completed within the current cadence. Also
    // skip while no client has sent embedding.init yet — the child would just
    // reply "Model not initialized" (fastembedProcessHost.ts) and we'd log a
    // keep_warm_failed warning every interval for nothing.
    if (
      shouldSkipKeepWarmTick({
        now: Date.now(),
        lastRealActivityAt,
        lastActivityAt,
        keepWarmActiveWindowMs,
        keepWarmIntervalMs,
        hasInit: Boolean(getPrivateFastembedProcess().lastInit),
      })
    ) {
      return;
    }
    inFlight++;
    const start = performance.now();
    let tickOk = false;
    void getPrivateFastembedProcess()
      // `_keepWarm: true` tags this as synthetic demand: the adaptive pool's
      // shrink/idle clock (sharedFastembedProcess.ts request()) must not
      // treat it as real traffic, or a host idle except for its own
      // keep-warm ticks would never shrink back to minSize. `stage` is NOT
      // read by anything downstream today (sharedFastembedProcess.ts /
      // fastembedProcessHost.ts have no `stage` handling) — it is forwarded
      // unchanged over IPC to the ONNX child and otherwise inert. Keep-warm
      // requests are therefore logged under the same
      // `fastembed_process.request.start/finish` telemetry as real embeds;
      // distinguish them downstream via `_keepWarm`, not `stage`.
      .request({ type: 'embed', text: 'keepwarm', _keepWarm: true })
      .then(() => {
        tickOk = true;
      })
      .catch((e: unknown) => {
        log.warn('embedding_provider.embed_host.keep_warm_failed', {
          error: e instanceof Error ? e.message : String(e),
        });
      })
      .finally(() => {
        inFlight--;
        lastActivityAt = Date.now();
        const work_ms = performance.now() - start;
        log.info('embedding_provider.embed_host.keep_warm', {
          ok: tickOk,
          work_ms,
          activeClients,
          keepWarmIntervalMs,
        });
        // Backoff: a slow keep-warm embed signals memory pressure — space
        // ticks out further (capped) rather than compounding the pressure
        // with more frequent warm-ups. A fast tick resets to the configured
        // base cadence. Only a SUCCESSFUL tick's timing is trustworthy for
        // this — a failed tick (timeout, child crash) says nothing about
        // paging cost and must not be conflated with a slow successful one.
        const nextIntervalMs = nextKeepWarmIntervalMs({
          currentIntervalMs: keepWarmIntervalMs,
          baseMs: keepWarmMs,
          workMs: work_ms,
          tickOk,
        });
        if (nextIntervalMs !== keepWarmIntervalMs) {
          const wasBackoff = nextIntervalMs > keepWarmIntervalMs;
          keepWarmIntervalMs = nextIntervalMs;
          if (wasBackoff) {
            log.info('embedding_provider.embed_host.keepwarm.backoff', {
              work_ms,
              keepWarmIntervalMs,
            });
          }
        }
        // A keep-warm embed can be the last in-flight work when the final
        // client disconnects mid-tick — onClientCountChange(0) would have
        // seen inFlight !== 0 and returned early, so nothing else re-arms
        // the idle timer. Mirror the request handler's re-arm here.
        if (activeClients === 0) armIfIdle();
      });
  };

  const startKeepWarm = (): void => {
    if (keepWarmMs <= 0 || keepWarmTimer || shuttingDown) return;
    // Tick at half the skip threshold: keepWarmTick itself no-ops until
    // `keepWarmIntervalMs` has elapsed since the last activity, so ticking at
    // the full period lets the real gap between warm embeds drift toward 2x
    // the interval depending on where in it the last request landed. Ticking
    // at half the BASE interval is still frequent enough to catch a
    // backed-off (doubled) cadence promptly once it resets.
    keepWarmTimer = setInterval(keepWarmTick, Math.max(1, Math.floor(keepWarmMs / 2)));
    keepWarmTimer.unref?.();
  };

  const teardown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    cancelIdle();
    stopKeepWarm();
    try {
      // Resolve the accessor at teardown time: a preceding `embedding.reset`
      // may have swapped the private singleton for a fresh one.
      await getPrivateFastembedProcess().terminate();
    } catch {
      /* best-effort — the ONNX child dies with us regardless (detached:false) */
    }
    try {
      await handle?.close();
    } catch {
      /* best-effort — the socket unlink happens inside close() */
    }
    process.exit(0);
  };

  const armIfIdle = (): void => {
    if (shuttingDown || idleTimer) return;
    if (activeClients !== 0 || inFlight !== 0) return;
    // Defensive second gate: the private pool's own counter, resolved per use so
    // a post-reset pool is never the stale terminated reference.
    if (getPrivateFastembedProcess().pendingCount !== 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      void teardown();
    }, idleGraceMs);
    // The listener keeps the loop alive; the timer itself must not.
    idleTimer.unref?.();
  };

  const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
    // Any inbound request is demand — cancel a pending reap, and count this
    // request as in-flight BEFORE the first await (the synchronous prefix).
    cancelIdle();
    inFlight++;
    const id = req.id;
    const method = req.method;
    // Only a successful embedding.init/embed/embedBatch forward counts as
    // REAL demand for `lastRealActivityAt` — health probes, resets, and
    // method-not-found replies must not keep the activity-window gate open,
    // or the permanently-connected `:3099` shim's own health polling would
    // keep keep-warm firing forever (the exact failure this gate exists to
    // prevent).
    let isRealForward = false;

    try {
      if (!HOST_METHODS.has(method)) {
        return fail(id, -32601, `method not found: ${method}`);
      }

      if (method === 'embedding.health') {
        const pc = getPrivateFastembedProcess();
        return ok(id, {
          protocol: EMBED_HOST_PROTOCOL_VERSION,
          buildId: args.buildId,
          hostInstanceId,
          modelLoaded,
          started: pc.started,
          pendingCount: pc.pendingCount,
          inFlight,
          activeClients,
          idleGraceMs,
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
      // must name the model this host serves; the host loads it itself, then
      // forwards to the PRIVATE pool (never the funnel accessor), resolving it
      // per use so a reset mid-life never leaves us on a terminated pool.
      const params = (req.params ?? {}) as Record<string, unknown>;
      const mismatch = checkRequestIdentity(params, served);
      if (mismatch !== null) return fail(id, ERR_WRONG_MODEL, mismatch);
      const trigger = resetSinceInit ? 'after_reset' : 'request';
      resetSinceInit = false;
      const initResult = await ensureModel(trigger);
      requestsServed++;
      if (method === 'embedding.init') {
        isRealForward = true;
        return ok(id, initResult);
      }
      const result = await getPrivateFastembedProcess().request(params);
      isRealForward = true;
      return ok(id, result);
    } catch (e) {
      return fail(id, -32603, e instanceof Error ? e.message : String(e));
    } finally {
      inFlight--;
      lastActivityAt = Date.now();
      if (isRealForward) lastRealActivityAt = lastActivityAt;
      // A request may have drained the last in-flight work with no clients
      // attached (e.g. a one-shot embed) — re-arm the reap.
      if (activeClients === 0) armIfIdle();
    }
  };

  handle = await serveBackend({
    socketPath,
    handler,
    onDiagnostic: (line) => process.stderr.write(line + '\n'),
    onClientCountChange: (active) => {
      activeClients = active;
      if (active > 0) {
        cancelIdle();
        startKeepWarm();
      } else {
        armIfIdle();
        stopKeepWarm();
      }
    },
  });

  // dc73d9b6: load the model eagerly — the first request should not pay for
  // it, and a replayed request must find a ready host. Counted as work.
  inFlight++;
  void ensureModel('eager')
    .catch((e: unknown) => {
      // Already logged by ensureModel (model.init ok:false); the next request retries.
      log.debug('embedding_provider.embed_host.eager_init_deferred', { error: e instanceof Error ? e.message : String(e) });
    })
    .finally(() => {
      inFlight--;
      if (activeClients === 0) armIfIdle();
    });

  // Arm immediately: if no client ever connects (e.g. the spawner died between
  // spawn and dial), the host must still reap rather than linger forever.
  armIfIdle();

  // A detached host can still be signalled directly (kill, OS teardown).
  process.on('SIGTERM', () => void teardown());
  process.on('SIGINT', () => void teardown());
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
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  runEmbedHost().catch((err: unknown) => {
    process.stderr.write(`[embed-host] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
