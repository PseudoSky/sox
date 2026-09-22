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
import { TransientEmbeddingError, PermanentEmbeddingError } from './errors.js';
import {
  EMBED_HOST_IDLE_GRACE_ENV,
  embedHostSingletonKey,
  embedHostSocketPath,
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

  constructor() {
    _activeClient = this;
  }

  /** True once the host has been resolved and the dial connection established. */
  get started(): boolean {
    return this._started;
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
    const request = { jsonrpc: '2.0' as const, id, method: `embedding.${type}`, params: payload };
    this._pending++;
    try {
      const resp = await this.awaitResponse(conn.send(request), id, timeoutMs, signal);
      const error = (resp as { error?: RpcError }).error;
      if (error) throw this.mapError(error);
      return (resp as { result?: unknown }).result as T;
    } finally {
      this._pending--;
    }
  }

  /**
   * NO-OP by design: under `host: 'shared'` the host is shared with every other
   * consumer on the machine — a consumer must never kill it. Its lifetime is
   * governed solely by its own debounced, ref-counted teardown
   * (`embedHostMain.ts`). Kept to satisfy `SharedFastembedClient`.
   */
  async terminate(): Promise<void> {
    // Intentionally empty — see the method doc.
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private mapError(error: RpcError): Error {
    const where = this.socketPath ?? '(unresolved socket)';
    if (error.code === -32001) {
      return new TransientEmbeddingError(`embedding host unavailable at ${where}: ${error.message}`, 1_000);
    }
    if (error.code === -32601) {
      return new PermanentEmbeddingError(`embedding host does not implement the method: ${error.message}`);
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
          reject(
            new TransientEmbeddingError(
              `embedding funnel transport error: ${msg(err)}`,
              1_000,
            ),
          );
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
    const key = embedHostSingletonKey(ctx.model, ep, ctx.cacheDir);
    const socketPath = embedHostSocketPath(cfg, key);

    if (this.socketPath !== socketPath) {
      // The identity changed (a different model/ep/cacheDir). Drop the old dial
      // and re-point. The old host is NOT killed — it self-reaps.
      this.conn?.close();
      this.conn = null;
      this._started = false;
      this.socketPath = socketPath;
    }

    const live = await probeSocketLive(socketPath, PROBE_TIMEOUT_MS);
    if (!live) {
      const result = await ensureBackend({
        socketPath,
        singletonKey: key,
        command: process.execPath,
        args: [resolveEmbedHostMainPath()],
        env: {
          ...process.env,
          SOX_EMBED_HOST_SOCKET: socketPath,
          // Internal cross-process transport for the typed idle bound: the
          // spawned host consumes the value the spawner resolved here
          // (`EmbedHostConfig.idleGraceMs`), which is what makes the resolved
          // config field the consumed surface rather than a dead declaration.
          // The public knob is `EmbeddingProviderConfig.idleGraceMs`.
          [EMBED_HOST_IDLE_GRACE_ENV]: String(cfg.idleGraceMs),
        },
        stderrLogPath: resolveEmbedHostStderrLogPath(cfg),
        readyTimeoutMs: HOST_READY_TIMEOUT_MS,
      });
      if (result.disposition === 'failed') {
        this.noteEnsureFailure();
        throw new TransientEmbeddingError(
          `embedding funnel could not bring up a host at ${socketPath}: ${result.detail}`,
          1_000,
        );
      }
    }

    this.consecutiveEnsureFailures = 0;
    if (!this.conn) {
      this.conn = dialBackend({
        socketPath,
        onDisconnect: () => {
          // The host may have self-reaped (idle) or crashed. The next request's
          // `send()` re-dials and, on failure, re-ensures. Mark unstarted so
          // `ensureHost()` runs the full probe/spawn path again.
          this._started = false;
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
    } catch {
      // Best-effort: an unreachable host has either reaped (fine) or is wedged;
      // dropping the connection lets the next request re-ensure.
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
