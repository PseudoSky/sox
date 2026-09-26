/**
 * funnelClient.ts — the host-aware `SharedFastembedClient` (SPEC-EMBEDDING-FUNNEL.md §D).
 *
 * A drop-in `SharedFastembedClient` that transparently dials — and, when absent,
 * peer-spawns — the ONE machine-wide embedding host for `(model, ep, cacheDir)`.
 * It is the consumer half of the funnel: N processes each hold a
 * `FunneledFastembedClient`, but `ensureBackend()`'s O_EXCL spawn-lock collapses
 * their concurrent spawn attempts to a single detached host, and the host
 * reaps itself once the last client leaves (see `embedHostMain.ts`).
 *
 * ── Honest failure, never a silent private re-fork ─────────────────────────────
 *
 * Under the default `host: 'shared'`, a failure to bring the host up throws a
 * typed `TransientEmbeddingError` naming the socket — it does NOT fall back to
 * forking a private host. A silent fallback would defeat the entire funnel
 * (each of 535 short-lived CLIs/day would quietly become its own ONNX host) and
 * is exactly the behaviour this design removes. `host: 'private'` is the
 * explicit, typed CI/diagnostics selection (ADR-0013 closed union).
 *
 * ── Circuit breaker ────────────────────────────────────────────────────────────
 *
 * After `ENSURE_FAILURE_THRESHOLD` consecutive failed ensures, the client fails
 * fast with a typed error for `ENSURE_CIRCUIT_COOLDOWN_MS` rather than paying
 * the full `ensureBackend` ready-timeout on every call. The breaker is
 * per-process (a short-lived CLI cannot share it) — it bounds a retrying
 * consumer, not the fleet; that is stated here rather than implied.
 *
 * Leaf module — `@adhd/sox-service-proxy` + node builtins.
 */

import { dialBackend, ensureBackend, probeSocketLive, type BackendConnection } from '@adhd/sox-service-proxy';
import { log } from '@adhd/sox-telemetry';
import { TransientEmbeddingError, PermanentEmbeddingError } from './errors.js';
import {
  buildEmbedHostEnv,
  computeEmbedHostBuildId,
  embedHostSingletonKey,
  encodeEmbedHostArgs,
  embedHostSocketPath,
  invalidateEmbedHostBuildId,
  resolveEmbedHostConfig,
  resolveEmbedHostMainPath,
  resolveEmbedHostStderrLogPath,
} from './embedHostConfig.js';
import type { SharedFastembedClient } from './sharedFastembedProcess.js';

/** Consecutive failed ensures before the breaker opens. */
export const ENSURE_FAILURE_THRESHOLD = 3;
/** How long the breaker stays open (fail-fast window) once tripped. */
export const ENSURE_CIRCUIT_COOLDOWN_MS = 10_000;
/** Bound on bringing the host up (`ensureBackend`'s readyTimeoutMs). */
export const HOST_READY_TIMEOUT_MS = 10_000;
/** Per-probe connect timeout. */
const PROBE_TIMEOUT_MS = 250;
/** Bound on a control call (reset/health) — never hang the caller. */
const CONTROL_TIMEOUT_MS = 5_000;

/** A JSON-RPC error object from `dialBackend`/the host. */
interface RpcError {
  code: number;
  message: string;
}

/**
 * The last-constructed funnel client. `resetSharedFastembedHost()` targets it.
 * Production constructs exactly one (via `getSharedFastembedProcess()`); tests
 * that construct extras simply re-point it, which is why the reset helper is
 * explicitly documented as operating on the current accessor client.
 */
let _activeClient: FunneledFastembedClient | null = null;

/** TEST-ONLY: clear the active-client reference. */
export function __resetActiveFunnelClientForTests(): void {
  _activeClient = null;
}

/** Extract a host/model/error message safely. */
function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 2fadb3cd: the host went away under a request (it retired, crashed, or the
 * dial gave up). Embeds are idempotent, so `request()` re-ensures a host and
 * retries such a request ONCE. Timeouts and aborts are NOT this class — the
 * caller's own bound has already been spent.
 */
class HostGoneError extends TransientEmbeddingError {}

export class FunneledFastembedClient implements SharedFastembedClient {
  private conn: BackendConnection | null = null;
  private socketPath: string | null = null;
  private initContext: { model: string; cacheDir: string } | null = null;
  private ensurePromise: Promise<void> | null = null;
  private _started = false;
  private _pending = 0;
  private nextId = 1;
  private consecutiveEnsureFailures = 0;
  private circuitOpenUntil = 0;
  /** Successful dial connects on the current connection (1 = first connect). */
  private connects = 0;
  /** Requests handed to the dial connection and not yet answered. */
  private _sent = 0;
  /**
   * (819a416b) True once the CURRENT host connection has answered an
   * init/embed request successfully — proof the host is alive AND has the
   * model loaded (protocol v2: the host loads it before answering either).
   * Cleared on disconnect (the host retired/died) and whenever the connection
   * is dropped or replaced, so a previously initialized client never reports
   * a host it has not heard from on this connection as warm.
   */
  private _servedOnConn = false;

  constructor() {
    _activeClient = this;
  }

  /** True once the host has been resolved and the dial connection established. */
  get started(): boolean {
    return this._started;
  }

  /**
   * (819a416b) Honest host-readiness signal for a caller sizing a latency
   * budget: true only while this consumer holds a LIVE connection to a host
   * that has already served it a successful response since connecting (so the
   * model is loaded). False before the first request, after the host retires
   * (ADR-0022 idle exit) or dies, and after `resetHost()` — i.e. whenever the
   * next request must dial, spawn, or wait for a model load. `started` alone
   * is not this signal: it is set as soon as the dial is armed.
   */
  get warm(): boolean {
    return this._started && this._servedOnConn && (this.conn?.isConnected() ?? false);
  }

  /** In-flight request count on THIS consumer (not the host's). */
  get pendingCount(): number {
    return this._pending;
  }

  /** The resolved host socket path, or `null` before the first successful ensure. */
  get hostSocketPath(): string | null {
    return this.socketPath;
  }

  async request<T = Record<string, unknown>>(
    payload: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const type = typeof payload['type'] === 'string' ? (payload['type'] as string) : '';
    if (type === 'init') {
      // The host's identity is keyed on (model, ep, cacheDir), all carried by
      // the init payload. Record it so `ensureHost()` can compute the key; a
      // non-init first request is a programming error, reported honestly below.
      if (!this.initContext) {
        this.initContext = {
          model: String(payload['model'] ?? ''),
          cacheDir: String(payload['cacheDir'] ?? ''),
        };
      }
    }

    // dc73d9b6: every request carries the model identity, so ANY host that
    // answers this path — including a successor the dial layer replays to —
    // can load the model itself and serve it. Per-connection init is unsound.
    const ctx = this.initContext;
    const params = ctx ? { ...payload, model: ctx.model, cacheDir: ctx.cacheDir } : payload;
    const method = `embedding.${type}`;
    const deadline = timeoutMs !== undefined && timeoutMs > 0 ? Date.now() + timeoutMs : undefined;

    this._pending++;
    try {
      try {
        return await this.sendOnce<T>(method, params, timeoutMs, signal);
      } catch (e) {
        if (!(e instanceof HostGoneError)) throw e;
        // 2fadb3cd: the host went away under this request. Re-ensure (spawning
        // a successor if none answers) and retry ONCE inside the caller's own
        // bound — an embed is idempotent.
        const remaining = deadline === undefined ? undefined : deadline - Date.now();
        if (remaining !== undefined && remaining <= 0) throw e;
        log.info('embedding_provider.funnel.retry', { method, reason: e.message, remaining_ms: remaining ?? null });
        this._started = false;
        return await this.sendOnce<T>(method, params, remaining, signal);
      }
    } finally {
      this._pending--;
    }
  }

  /** Ensure a host, send one request, await its response (bounded). */
  private async sendOnce<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    await this.ensureHost();
    const conn = this.conn;
    if (!conn) {
      // ensureHost() guarantees a connection or throws; this is unreachable but
      // keeps the type honest rather than asserting.
      throw new TransientEmbeddingError(
        `embedding funnel: no connection to host at ${this.socketPath ?? '(unresolved)'}`,
      );
    }
    const id = `embed-funnel-${this.nextId++}`;
    this._sent++;
    let resp: Record<string, unknown>;
    try {
      resp = await this.awaitResponse(conn.send({ jsonrpc: '2.0', id, method, params }), id, timeoutMs, signal);
    } finally {
      this._sent--;
    }
    const error = (resp as { error?: RpcError }).error;
    if (error) throw this.mapError(error);
    // (819a416b) Only a response on the connection that is STILL current proves
    // the live host is serving; a stale connection's late answer proves nothing.
    if (this.conn === conn && (method === 'embedding.init' || method === 'embedding.embed' || method === 'embedding.embedBatch')) {
      this._servedOnConn = true;
    }
    return (resp as { result?: unknown }).result as T;
  }

  /**
   * NO-OP by design: under `host: 'shared'` the host is shared with every other
   * consumer on the machine — a consumer must never kill it. Its lifetime is
   * governed solely by its own work-driven retire (ADR-0022): it retires `W`
   * after its last completed work, irrespective of how many consumers are
   * connected (`embedHostMain.ts`). Kept to satisfy `SharedFastembedClient`.
   */
  async terminate(): Promise<void> {
    // Intentionally empty — see the method doc.
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private mapError(error: RpcError): Error {
    const where = this.socketPath ?? '(unresolved socket)';
    if (error.code === -32001) {
      return new HostGoneError(`embedding host unavailable at ${where}: ${error.message}`, 1_000);
    }
    if (error.code === -32601) {
      return new PermanentEmbeddingError(`embedding host does not implement the method: ${error.message}`);
    }
    if (error.code === -32602) {
      // dc73d9b6: the host serves a different model/cacheDir — retrying the
      // same request can never succeed.
      return new PermanentEmbeddingError(`embedding host at ${where} refused the request: ${error.message}`);
    }
    // Application error from the private ONNX host (e.g. "Model not
    // initialized") — preserve the pre-funnel `new Error(message)` shape so
    // `FastembedProvider.initModel()`'s catch/retry logic is unchanged.
    return new Error(error.message);
  }

  private awaitResponse(
    pending: Promise<unknown>,
    id: string,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const onAbort = (): void => {
        if (settled) return;
        settle();
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new TransientEmbeddingError(`embedding funnel request ${id} aborted`),
        );
      };
      const settle = (): void => {
        settled = true;
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          settle();
          reject(
            new TransientEmbeddingError(
              `embedding funnel request timed out after ${timeoutMs}ms`,
              timeoutMs,
            ),
          );
        }, timeoutMs);
      }
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      pending.then(
        (resp) => {
          if (settled) return;
          settle();
          resolve(resp as Record<string, unknown>);
        },
        (err: unknown) => {
          if (settled) return;
          settle();
          reject(new HostGoneError(`embedding funnel transport error: ${msg(err)}`, 1_000));
        },
      );
    });
  }

  /** Idempotent: resolves once a host is live and dialed, or throws typed. */
  private ensureHost(): Promise<void> {
    if (this._started && this.conn?.isConnected()) return Promise.resolve();
    if (this.ensurePromise) return this.ensurePromise;
    this.ensurePromise = this.doEnsure().finally(() => {
      this.ensurePromise = null;
    });
    return this.ensurePromise;
  }

  private async doEnsure(): Promise<void> {
    if (Date.now() < this.circuitOpenUntil) {
      throw new TransientEmbeddingError(
        `embedding funnel circuit open for ${this.circuitOpenUntil - Date.now()}ms more after ` +
          `${this.consecutiveEnsureFailures} consecutive ensure failures`,
        this.circuitOpenUntil - Date.now(),
      );
    }

    const cfg = resolveEmbedHostConfig();
    const ctx = this.initContext;
    if (!ctx) {
      throw new TransientEmbeddingError(
        'embedding funnel requires an {type:"init"} request before any other request ' +
          '(the host is keyed on model + cacheDir, which only init carries)',
      );
    }
    const ep = process.env['SOX_EMBED_EXECUTION_PROVIDER'] ?? 'auto';
    // 2fe52b0f: the key carries the content build id of the host we would
    // spawn, so we never dial a host from a foreign build. `computeEmbedHostBuildId`
    // itself re-hashes when the host dir's fingerprint changed (a rebuild), so a
    // long-lived consumer that outlives an in-place `dist/` rebuild still gets a
    // fresh id here without recreating this client.
    const hostMain = resolveEmbedHostMainPath();
    let buildId = computeEmbedHostBuildId(hostMain);
    let key = embedHostSingletonKey(ctx.model, ep, ctx.cacheDir, buildId);
    let socketPath = embedHostSocketPath(cfg, key);

    const repoint = (): void => {
      if (this.socketPath !== socketPath) {
        // The identity changed (a different model/ep/cacheDir, or [2fe52b0f] a
        // rebuild changed the build id). Drop the old dial and re-point. The
        // old host is NOT killed — it self-reaps.
        this.conn?.close();
        this.conn = null;
        this._started = false;
        this.socketPath = socketPath;
      } else if (this.conn && !this.conn.isConnected() && this._sent === 0) {
        // 2fadb3cd: a dial that has been down with nothing outstanding carries a
        // stale down-since clock and a maxed backoff — its next connect failure
        // would fast-fail a fresh request at once. Start over with a fresh dial.
        // (With work pending, keep it: its queue replays to the successor.)
        this.conn.close();
        this.conn = null;
      }
    };
    repoint();

    let live = await probeSocketLive(socketPath, PROBE_TIMEOUT_MS);
    // [2fe52b0f] backstop: normally `computeEmbedHostBuildId`'s fingerprint
    // check already catches a rebuild before we ever spawn. This loop only
    // fires (once) when the host we spawn still rejects our build id — e.g. a
    // filesystem with coarse mtimes left the fingerprint unchanged across a
    // rebuild. On that specific failure we force a full rehash and retry with
    // the corrected identity instead of counting the failure and opening the
    // circuit on a stale id forever.
    for (let attempt = 0; !live && attempt < 2; attempt++) {
      const serviceId = process.env['SOX_SERVICE_ID'];
      // 6660076e: the host never inherits its spawner's identity/config/
      // permission env — a service reaper would otherwise treat the shared host
      // as that service's own process. Provenance travels as argv, telemetry-only.
      const hostEnv = buildEmbedHostEnv(process.env);
      if (hostEnv.denied.length > 0) {
        log.info('embedding_provider.funnel.env_denied', { denied_env: hostEnv.denied });
      }
      const hostArgs = encodeEmbedHostArgs({
        socketPath,
        model: ctx.model,
        cacheDir: ctx.cacheDir,
        ep,
        buildId,
        // The typed idle window (`EmbedHostConfig.idleGraceMs`) travels as argv.
        idleWindowMs: cfg.idleGraceMs,
        spawner: {
          pid: process.pid,
          serviceId: serviceId !== undefined && serviceId !== '' ? serviceId : null,
          entry: process.argv[1] ?? null,
          deniedEnv: hostEnv.denied,
        },
      });
      const result = await ensureBackend({
        socketPath,
        singletonKey: key,
        command: process.execPath,
        args: [hostMain, ...hostArgs],
        env: hostEnv.env,
        stderrLogPath: resolveEmbedHostStderrLogPath(cfg),
        readyTimeoutMs: HOST_READY_TIMEOUT_MS,
      });
      log.info('embedding_provider.funnel.spawn', {
        disposition: result.disposition,
        pid: result.pid ?? null,
        build_id: buildId,
        key,
        spawner_pid: process.pid,
        spawner_service: serviceId ?? null,
        denied_env: hostEnv.denied,
        dropped_env_count: hostEnv.dropped.length,
        attempt,
      });
      if (result.disposition === 'failed') {
        // embedHostMain.ts exits 3 (`process.exit(3)`) specifically on a build
        // id mismatch (ensure-backend.ts's exit-monitoring stamps the code
        // into `detail` as `(exit code 3)`). Any other failure shape (timeout,
        // other exit code) is a real failure, not a stale-id symptom.
        const buildMismatch = /\(exit code 3\)/.test(result.detail);
        if (buildMismatch && attempt === 0) {
          log.warn('embedding_provider.funnel.build_id_stale', {
            detail: result.detail,
            stale_build_id: buildId,
            socket: socketPath,
          });
          invalidateEmbedHostBuildId(hostMain);
          buildId = computeEmbedHostBuildId(hostMain);
          key = embedHostSingletonKey(ctx.model, ep, ctx.cacheDir, buildId);
          socketPath = embedHostSocketPath(cfg, key);
          repoint();
          live = await probeSocketLive(socketPath, PROBE_TIMEOUT_MS);
          continue;
        }
        this.noteEnsureFailure();
        // 2fadb3cd: a host killed by a SIGNAL during its startup window (OOM
        // kill, a reaper, `kill -9`) went away under this caller's request just
        // as surely as one killed after it answered — ensure-backend stamps it
        // `(signal SIGKILL)` into `detail`. Classify it host-gone so
        // `request()`'s retry-once respawns a successor inside the caller's
        // bound. An exit-CODE death (a broken entrypoint, a build mismatch) or a
        // readiness timeout is deterministic or has already spent the bound, so
        // it stays a plain transient failure — never retried here.
        const diedBySignal = /\(signal [A-Z0-9]+\)/.test(result.detail);
        const message = `embedding funnel could not bring up a host at ${socketPath}: ${result.detail}`;
        throw diedBySignal ? new HostGoneError(message, 1_000) : new TransientEmbeddingError(message, 1_000);
      }
      live = true;
    }

    this.consecutiveEnsureFailures = 0;
    if (!this.conn) {
      this.connects = 0;
      this._servedOnConn = false;
      this.conn = dialBackend({
        socketPath,
        onConnect: () => {
          this.connects++;
          if (this.connects > 1) {
            log.info('embedding_provider.funnel.reconnected', { attempt: this.connects - 1, socket: socketPath });
          }
        },
        onDisconnect: () => {
          // The host retired or died. Mark unstarted so the next ensure runs the
          // full probe/spawn path.
          this._started = false;
          this._servedOnConn = false;
          // 2fadb3cd: with requests in flight, bring a successor up NOW. The
          // dial layer re-dials this path and replays the unanswered requests;
          // it never spawns, so without this they would sit until the 10 s
          // give-up and fail.
          if (this._sent > 0) {
            void this.ensureHost().catch((e: unknown) => {
              log.warn('embedding_provider.funnel.reensure_failed', {
                error: msg(e),
                pending: this._sent,
                socket: socketPath,
              });
            });
          }
        },
      });
    }
    this._started = true;
  }

  private noteEnsureFailure(): void {
    this.consecutiveEnsureFailures++;
    if (this.consecutiveEnsureFailures >= ENSURE_FAILURE_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + ENSURE_CIRCUIT_COOLDOWN_MS;
    }
  }

  /**
   * Ask the live host to tear down and re-fork its PRIVATE pool, then drop this
   * consumer's connection so the next request re-dials the (still-live) host.
   * No-op when no host has been resolved. Public so the module-level
   * `resetSharedFastembedHost()` can target the accessor client.
   */
  async resetHost(): Promise<void> {
    if (!this.socketPath) return;
    try {
      await this.control('embedding.reset');
    } catch (e) {
      // Best-effort: an unreachable host has either reaped (fine) or is wedged;
      // dropping the connection lets the next request re-ensure.
      log.warn('embedding_provider.funnel.reset_host_unreachable', {
        error: msg(e),
        socket: this.socketPath,
      });
    } finally {
      this.dropConnection();
    }
  }

  /**
   * Send a control method (`embedding.reset` / `embedding.health`) to the live
   * host, bounded. Returns the result, or `null` when no host is resolved.
   */
  private async control<T = Record<string, unknown>>(method: string): Promise<T | null> {
    if (!this.conn || !this.socketPath) return null;
    const id = `embed-funnel-ctl-${this.nextId++}`;
    const resp = await this.awaitResponse(
      this.conn.send({ jsonrpc: '2.0', id, method }),
      id,
      CONTROL_TIMEOUT_MS,
      undefined,
    );
    const error = (resp as { error?: RpcError }).error;
    if (error) throw this.mapError(error);
    return ((resp as { result?: unknown }).result ?? {}) as T;
  }

  /**
   * Drop this consumer's dial connection. The host stays alive.
   */
  private dropConnection(): void {
    this.conn?.close();
    this.conn = null;
    this._started = false;
    this._servedOnConn = false;
  }
}

/**
 * Ask the peer-shared host to tear down and re-fork its PRIVATE pool, then drop
 * this consumer's connection so the next request re-dials the (still-live) host.
 *
 * This is memory-core's heal entry point: under `host: 'shared'`,
 * `terminate()` is a no-op (a consumer must never kill a shared host), so a
 * wedged private child is recovered by asking the host to reset its own pool.
 * A no-op when no host has been resolved yet — nothing to reset.
 */
export async function resetSharedFastembedHost(): Promise<void> {
  await _activeClient?.resetHost();
}
