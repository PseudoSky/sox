/**
 * libs/service-proxy/src/dial.ts — bounded re-dial backend connection (§9.5.2).
 *
 * `dialBackend` maintains a connection to the backend UDS that SURVIVES backend
 * restarts. This is the mechanism behind the zero-downtime guarantee: when the
 * backend rolling-restarts during an upgrade, the connection drops, and this
 * module re-dials with bounded exponential backoff while buffering in-flight
 * requests; on reconnect it forwards them. If the backend stays down past the
 * bound, pending requests fast-fail with -32001 (backend unavailable) WITHOUT
 * closing the client's stdio pipe — so once the backend returns, the same shim
 * resumes with no client reconnect.
 *
 * BL-4041c6e0: before every dial the socket's directory must pass the privacy
 * check (`socket-dir.ts`). An unsafe directory fast-fails pending requests with
 * -32001 carrying `data.code: 'E_UDS_DIR_UNSAFE'` and schedules no re-dial.
 *
 * BL-6b4ff2b8: the disconnected-request buffer (`queue`) is a {@link Deque},
 * not a plain array, and `flushQueue()`'s drain is bounded and yields. A live
 * incident (2026-09-28, memory-server pid 50436) pinned the main thread for
 * 640,232ms inside this file (`sample <pid> 3` showed 100% of a 3s window
 * inside `PipeWrap::AfterConnect -> ArrayPrototypeShift`) — this was TWO
 * compounding defects in the pre-fix code, confirmed independently:
 *
 *   1. `flushQueue()` drove a `while` loop calling `Array.prototype.shift()`
 *      once per queued request — O(remaining length) per call, so draining a
 *      backlog of N requests was O(N^2). Fixed by the `Deque`'s O(1)
 *      amortized `shift()`.
 *   2. GENUINE INFINITE HANG, empirically reproduced against the pre-fix
 *      source (df7b4595): `net.Socket.writable` flips to `false` SYNCHRONOUSLY
 *      the instant `destroy()` is called, well before the async 'close' event
 *      fires. A synchronous EPIPE from `socket.write()` (inside
 *      `writeToBackend`, called from within the SAME `while` loop) destroyed
 *      the socket while `writeToBackend`'s `!socket.writable` branch kept
 *      re-`queue.push()`ing every item the loop `shift()`ed off — the loop's
 *      only exit conditions (`queue.length === 0`, `!socket`) could never
 *      become true, and it never yielded, so the async 'close' handler that
 *      would recover could never run. A 200-item repro against the exact
 *      pre-fix source pinned a real subprocess at 99.4% CPU and never
 *      returned (`timeout 15 ...` → exit 124); the same repro against this
 *      fix exits 0 in under a second (see
 *      dial-flush-writable-check.bl-6b4ff2b8.spec.ts). Fixed by
 *      `drainQueueChunk`'s `socket.writable` check, which stops draining (and
 *      skips the reschedule) the instant the socket is known-dead, handing
 *      off to the close/redial/reconnect cycle instead of spinning against it.
 *
 * `flushQueue()` additionally caps work to `cfg.maxItemsPerTick` per
 * synchronous tick and yields via `setImmediate` between chunks — so even a
 * backlog large enough to matter for (1) degrades throughput instead of
 * freezing the event loop, and a live-but-unwritable socket (partially
 * mitigating (2) even without the `.writable` check) burns at most one bounded
 * chunk of non-productive churn per tick rather than spinning forever.
 *
 * Leaf module — node builtins only (net, path, fs via socket-dir).
 */

import * as net from 'node:net';
import * as path from 'node:path';
import { encodeFrame, FrameDecoder } from './framing.js';
import { assertPrivateSocketDir, isUdsDirUnsafeError, type UdsDirUnsafeError } from './socket-dir.js';

/** The structured `data` carried by a -32001 response for an unsafe socket dir. */
function unsafeData(err: UdsDirUnsafeError): Record<string, unknown> {
  return {
    code: err.code,
    dir: err.dir,
    expectedUid: err.expectedUid,
    actualUid: err.actualUid,
    mode: err.mode,
    isSymlink: err.isSymlink,
  };
}
import {
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  ERR_BACKEND_UNAVAILABLE,
  errorResponse,
  isJsonRpcResponse,
} from './jsonrpc.js';

/** Backoff + buffering bounds for the re-dial loop. */
export interface BackoffOptions {
  /** Initial re-dial delay in ms (default 50). */
  initialMs?: number;
  /** Max single re-dial delay in ms (default 2000). */
  maxMs?: number;
  /** Total time to keep re-dialing before fast-failing pending calls (default
   * 10000). After this elapses with no successful connect, all queued + in-flight
   * requests fast-fail with -32001; the loop KEEPS re-dialing at maxMs so it
   * auto-recovers when the backend returns. */
  giveUpAfterMs?: number;
  /** Max number of requests to buffer while disconnected (default 256). Beyond
   * this, the oldest are fast-failed to bound memory. */
  maxQueue?: number;
  /** BL-6b4ff2b8: max queued requests drained synchronously per event-loop
   * tick during a reconnect flush (default 100). Once a tick hits this cap,
   * the rest of the drain is deferred via `setImmediate` so a large backlog
   * degrades throughput instead of pinning the main thread. */
  maxItemsPerTick?: number;
}

const DEFAULTS: Required<BackoffOptions> = {
  initialMs: 50,
  maxMs: 2000,
  giveUpAfterMs: 10000,
  maxQueue: 256,
  maxItemsPerTick: 100,
};

/** A pending request awaiting a backend response. */
interface Pending {
  request: JsonRpcRequest;
  resolve: (resp: JsonRpcResponse) => void;
  /** Has this request been written to the current backend socket yet? */
  sent: boolean;
}

/**
 * A FIFO queue with O(1) amortized `shift()`/`push()`, implemented as the
 * classic two-stack deque (`front` consumed via `pop()`, `back` accumulates
 * via `push()`, refilled from `back` when `front` empties). BL-6b4ff2b8: a
 * plain array's `.shift()` is O(remaining length) per call, so draining N
 * queued requests one at a time in a `while` loop was O(N^2) — a real,
 * secondary defect, but NOT what pinned the main thread for 640s in the live
 * incident (the default `maxQueue` is 256; O(N^2) on 256 items is not a
 * multi-minute stall). The dominant, incident-causing mechanism was the
 * genuine infinite hang documented on `drainQueueChunk` below. `pushFrontMany`
 * supports `requeueUnanswered`'s "put these back ahead of the queue,
 * preserving their order" need without `Array.prototype.unshift(...spread)`
 * (unsafe for very large arrays — call-argument limits — and O(N) per call
 * against the whole remaining queue on a plain array).
 */
class Deque<T> {
  private front: T[] = [];
  private back: T[] = [];

  get length(): number {
    return this.front.length + this.back.length;
  }

  pushBack(item: T): void {
    this.back.push(item);
  }

  /** Prepend `items` (in their given order) ahead of everything currently queued. */
  pushFrontMany(items: readonly T[]): void {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item !== undefined) this.front.push(item);
    }
  }

  shift(): T | undefined {
    if (this.front.length === 0) {
      while (this.back.length > 0) {
        const item = this.back.pop();
        if (item !== undefined) this.front.push(item);
      }
    }
    return this.front.pop();
  }

  /** Remove and return every item, in dequeue order. */
  drainAll(): T[] {
    const result: T[] = [];
    let item: T | undefined;
    while ((item = this.shift()) !== undefined) result.push(item);
    return result;
  }
}

/** Options for {@link dialBackend}. */
export interface DialOptions {
  socketPath: string;
  backoff?: BackoffOptions;
  /** stderr diagnostics sink (NEVER stdout — [inv:no-stdout-diagnostics]). */
  onDiagnostic?: (line: string) => void;
  /** Called whenever a fresh backend connection is established (for schema re-read /
   * list_changed handshake, §9.5.3). */
  onConnect?: () => void;
  /** Called whenever an ESTABLISHED backend connection drops (not on a failed
   * initial dial). Used by the shim to re-ensure a crashed backend (§9.5 step 3). */
  onDisconnect?: () => void;
}

/** A live (re-dialing) backend connection. */
export interface BackendConnection {
  /**
   * Send a JSON-RPC request and await its response. If the backend is down it is
   * buffered and forwarded on reconnect; if it stays down past the give-up bound,
   * the promise resolves with a -32001 error response (never rejects, never hangs).
   */
  send(request: JsonRpcRequest): Promise<JsonRpcResponse>;
  /** Send a notification (no response awaited). Dropped if backend is unavailable. */
  notify(request: JsonRpcRequest): void;
  /** Is a backend socket currently connected? */
  isConnected(): boolean;
  /** Tear down the connection and re-dial loop; fast-fails any pending. */
  close(): void;
}

/**
 * Establish a re-dialing connection to the backend UDS.
 *
 * Begins connecting immediately and returns synchronously — callers `send()` right
 * away; requests issued before the first connect are queued.
 */
export function dialBackend(opts: DialOptions): BackendConnection {
  const cfg = { ...DEFAULTS, ...(opts.backoff ?? {}) };
  const diag = opts.onDiagnostic ?? ((line: string) => process.stderr.write(line + '\n'));

  let socket: net.Socket | null = null;
  let closed = false;
  let connecting = false;
  let backoffMs = cfg.initialMs;
  let downSince: number | null = null; // ms timestamp the backend first went down
  let redialTimer: NodeJS.Timeout | null = null;
  /** BL-4041c6e0: the last unsafe-directory verdict; suppresses re-dial while set. */
  let unsafeDir: UdsDirUnsafeError | null = null;
  /** BL-6b4ff2b8: the scheduled continuation of a chunked flushQueue() drain,
   * or null when no drain is in flight. Guards against overlapping drains. */
  let flushImmediate: NodeJS.Immediate | null = null;

  /** Requests awaiting a response, keyed by JSON-RPC id. */
  const pending = new Map<JsonRpcId, Pending>();
  /** FIFO of requests queued while disconnected (preserves send order). */
  const queue = new Deque<Pending>();

  /** Is there a request that still needs the connection to make progress? */
  function hasOutstandingWork(): boolean {
    return pending.size > 0 || queue.length > 0;
  }

  /**
   * Keep the backend socket REFERENCED only while a request needs it.
   *
   * A connected socket is a referenced libuv handle: left referenced it pins
   * the event loop open forever, so a short-lived CLI that embeds once and then
   * has nothing else to do never exits — it hangs after its query completes.
   * That is the regression this guards (the funnel's UDS dial was never
   * unref'd).
   *
   * Unref'ing unconditionally would be equally wrong: a standalone consumer
   * whose ONLY pending work is an in-flight `send()` has nothing else
   * referenced, so Node would tear the process down mid-request before the
   * reply arrives (the `ensure-backend-await-survives` failure shape — verified
   * empirically: an unref'd socket with a pending read does NOT hold the loop).
   * So mirror `SharedFastembedProcessClient.refForPending()`/`unrefIfIdle()`:
   * ref while work is outstanding, unref the instant it drains.
   */
  function updateSocketRef(): void {
    if (!socket) return;
    if (hasOutstandingWork()) socket.ref();
    else socket.unref();
  }

  function connect(): void {
    if (closed || connecting || socket) return;

    // BL-4041c6e0: never dial into a socket directory another user could have
    // planted an impostor in. The verdict is terminal for this attempt: every
    // outstanding request fast-fails with the coded error and NO re-dial is
    // scheduled (backing off cannot fix a directory; it needs an operator). A
    // later send() re-checks, so a repaired directory recovers without restart.
    // A directory that cannot be stat'd (e.g. not created yet on first start) is
    // not a trust verdict — fall through to the ordinary connect/re-dial path.
    // Cleared on every attempt: only a fresh unsafe verdict may suppress re-dial.
    // (A directory the operator removed — the remediation the error prescribes —
    // must fall back to ordinary re-dialing, or the queued send would hang.)
    unsafeDir = null;
    try {
      assertPrivateSocketDir(path.dirname(opts.socketPath));
    } catch (err) {
      if (isUdsDirUnsafeError(err)) {
        unsafeDir = err;
        diag(`[service-proxy shim] ${err.message}`);
        if (redialTimer) {
          clearTimeout(redialTimer);
          redialTimer = null;
        }
        failAllPending(err.message, unsafeData(err));
        return;
      }
      diag(`[service-proxy shim] socket dir check deferred: ${(err as Error).message}`);
    }

    connecting = true;

    const s = net.createConnection(opts.socketPath);
    const dec = new FrameDecoder(
      (msg) => onBackendMessage(msg),
      (err) => {
        diag(`[service-proxy shim] backend frame error: ${err.message}`);
        s.destroy();
      },
    );

    s.on('connect', () => {
      connecting = false;
      socket = s;
      backoffMs = cfg.initialMs;
      downSince = null;
      diag(`[service-proxy shim] backend connected: ${opts.socketPath}`);
      try {
        opts.onConnect?.();
      } catch (e) {
        diag(`[service-proxy shim] onConnect threw: ${(e as Error).message}`);
      }
      flushQueue();
      // A fresh connection with nothing outstanding must not pin the loop open.
      updateSocketRef();
    });

    s.on('data', (chunk: Buffer) => dec.push(chunk));

    s.on('error', () => {
      // Connection refused / reset — handled uniformly by 'close'.
    });

    s.on('close', () => {
      const wasConnected = socket === s;
      if (socket === s) {
        socket = null;
      }
      connecting = false;
      if (closed) return;
      if (downSince === null) downSince = Date.now();
      if (wasConnected) {
        diag(`[service-proxy shim] backend disconnected; re-dialing`);
        // In-flight (sent) requests will never get a response on this socket —
        // requeue them so they replay on reconnect.
        requeueUnanswered();
        try {
          opts.onDisconnect?.();
        } catch (e) {
          diag(`[service-proxy shim] onDisconnect threw: ${(e as Error).message}`);
        }
      }
      maybeFastFail();
      scheduleRedial();
    });
  }

  function scheduleRedial(): void {
    if (closed || unsafeDir || redialTimer || socket || connecting) return;
    redialTimer = setTimeout(() => {
      redialTimer = null;
      connect();
    }, backoffMs);
    // A re-dial that a pending request is waiting on MUST hold the loop (else a
    // standalone consumer is torn down mid-request, before the retry can land);
    // an idle re-dial must not keep the process alive solely for the timer.
    if (hasOutstandingWork()) redialTimer.ref?.();
    else redialTimer.unref?.();
    backoffMs = Math.min(backoffMs * 2, cfg.maxMs);
  }

  /**
   * Move any sent-but-unanswered pending back to the front of the queue.
   *
   * This stays a single synchronous pass (unlike flushQueue below) — it's a
   * one-shot O(n) sweep over `pending` (bounded by however many requests were
   * in flight, not by the disconnected backlog), and its ordering invariant
   * ("unanswered ahead of already-queued") must be established atomically
   * before the next flushQueue() drain starts reading the queue; deferring
   * part of the transfer risks a request being read out of order — or, worse,
   * re-added to `queue` by a still-pending chunk AFTER `failAllPending` has
   * already resolved and cleared it out of `pending` (double-resolve).
   * `pushFrontMany` itself is O(n) via the two-stack Deque (BL-6b4ff2b8) —
   * no `Array.prototype.unshift(...spread)` — so this sweep is safe even for
   * a large in-flight count.
   */
  function requeueUnanswered(): void {
    const unanswered: Pending[] = [];
    for (const p of pending.values()) {
      if (p.sent) {
        p.sent = false;
        unanswered.push(p);
      }
    }
    // Preserve original order: unanswered (older) ahead of already-queued.
    queue.pushFrontMany(unanswered);
    updateSocketRef();
  }

  /** Once the give-up bound elapses with no connection, fast-fail everything. */
  function maybeFastFail(): void {
    if (downSince === null) return;
    if (Date.now() - downSince < cfg.giveUpAfterMs) return;
    diag(
      `[service-proxy shim] backend down > ${cfg.giveUpAfterMs}ms; fast-failing ${pending.size + queue.length} pending`,
    );
    failAllPending('backend unavailable');
  }

  function failAllPending(message: string, data?: unknown): void {
    // A drain in flight is about to have its backing queue emptied out from
    // under it — cancel the scheduled continuation so it doesn't wake up to
    // an empty (or, worse, freshly-repopulated-by-a-later-send) queue.
    if (flushImmediate) {
      clearImmediate(flushImmediate);
      flushImmediate = null;
    }
    for (const p of queue.drainAll()) {
      p.resolve(errorResponse(p.request.id ?? null, ERR_BACKEND_UNAVAILABLE, message, data));
    }
    for (const p of pending.values()) {
      p.resolve(errorResponse(p.request.id ?? null, ERR_BACKEND_UNAVAILABLE, message, data));
    }
    pending.clear();
    // Nothing is outstanding any more — release the loop if we were holding it.
    updateSocketRef();
  }

  /**
   * Drain `queue` onto the backend socket. BL-6b4ff2b8: bounded to
   * `cfg.maxItemsPerTick` items per synchronous tick, yielding via
   * `setImmediate` between chunks — so draining a large backlog (e.g. after a
   * long disconnect, or a burst of reconnect cycles) degrades throughput
   * instead of pinning the main thread. Re-entrant-safe: a second call while a
   * drain is already scheduled is a no-op (the in-flight drain will pick up
   * anything newly queued before it next yields).
   *
   * Ordering: while this drain is in flight (`flushImmediate` set), `send()`
   * routes every new request through `queue` instead of writing directly
   * even when the socket is writable — otherwise a request issued during the
   * yield window between two chunks would overtake older backlog items still
   * waiting for their chunk (review finding on BL-6b4ff2b8; see
   * dial-flush-ordering.bl-6b4ff2b8.spec.ts).
   */
  function flushQueue(): void {
    if (!socket) return;
    if (flushImmediate) return;
    drainQueueChunk();
  }

  function drainQueueChunk(): void {
    flushImmediate = null;
    let processed = 0;
    while (queue.length > 0 && socket && socket.writable && processed < cfg.maxItemsPerTick) {
      const p = queue.shift();
      if (!p) break;
      writeToBackend(p);
      processed++;
    }
    // `socket.writable` can go false synchronously (destroy()/end() flip it
    // immediately) BEFORE the async 'close' handler runs and nulls `socket`
    // out — e.g. a synchronous EPIPE from `socket.write()` inside
    // writeToBackend. Without the `socket.writable` check above (but WITH the
    // maxItemsPerTick cap + setImmediate yield already in place — this is a
    // distinct, milder defect from the genuine unbounded infinite hang
    // documented in this file's header comment, which requires BOTH no
    // socket.writable check AND no per-tick cap/yield), the loop would keep
    // shifting items off the front only to have writeToBackend immediately
    // push them back onto the queue (the unwritable branch) — wasted,
    // non-productive work (NOT an ordering hazard: the two-stack `Deque`
    // preserves FIFO order under this exact shift-then-pushBack churn
    // pattern, confirmed via instrumented tracing during this investigation)
    // — for up to `maxItemsPerTick` iterations, then reschedule and do it
    // again next tick, for as many ticks as it takes the async 'close'
    // handler to actually run and null out `socket`. Checking
    // `socket.writable` here stops draining and skips the reschedule the
    // INSTANT the socket is known-dead: the pending 'close' handler will
    // requeueUnanswered() + scheduleRedial(), and the next successful
    // connect's onConnect->flushQueue() resumes the drain.
    if (queue.length > 0 && socket && socket.writable && !closed) {
      flushImmediate = setImmediate(drainQueueChunk);
    }
  }

  function writeToBackend(p: Pending): void {
    if (!socket || !socket.writable) {
      queue.pushBack(p);
      return;
    }
    p.sent = true;
    if (p.request.id !== undefined) pending.set(p.request.id, p);
    socket.write(encodeFrame(p.request));
    updateSocketRef();
  }

  function onBackendMessage(msg: unknown): void {
    if (!isJsonRpcResponse(msg)) {
      // Could be a server-initiated notification (e.g. tools/list_changed). The
      // shim's stdio side forwards those separately; here we only resolve replies.
      diag(`[service-proxy shim] backend sent non-response frame (ignored at dial layer)`);
      return;
    }
    const resp = msg as JsonRpcResponse;
    const p = pending.get(resp.id);
    if (!p) {
      diag(`[service-proxy shim] backend response for unknown id ${String(resp.id)}`);
      return;
    }
    pending.delete(resp.id);
    p.resolve(resp);
    // The request that was holding the loop has settled; drop the ref if this
    // was the last outstanding one.
    updateSocketRef();
  }

  function send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    return new Promise<JsonRpcResponse>((resolve) => {
      if (closed) {
        resolve(errorResponse(request.id ?? null, ERR_BACKEND_UNAVAILABLE, 'proxy closed'));
        return;
      }
      const p: Pending = { request, resolve, sent: false };

      // Bound the buffer: drop the oldest queued request if we're over capacity.
      if (queue.length >= cfg.maxQueue) {
        const dropped = queue.shift();
        dropped?.resolve(
          errorResponse(dropped.request.id ?? null, ERR_BACKEND_UNAVAILABLE, 'proxy queue overflow'),
        );
      }

      // BL-6b4ff2b8 (review finding): while a chunked drain is in flight
      // (flushImmediate set), a request that lands in the yield window
      // between chunks must NOT be written directly even though the socket
      // is currently writable — it would overtake older, still-queued
      // backlog items waiting for their next chunk. Route it through the
      // queue instead; the in-flight drain will pick it up in FIFO order
      // once it reaches the back of the queue.
      if (socket && socket.writable && !flushImmediate) {
        writeToBackend(p);
      } else {
        queue.pushBack(p);
        connect();
        scheduleRedial();
      }
    });
  }

  function notify(request: JsonRpcRequest): void {
    if (closed) return;
    if (socket && socket.writable) {
      socket.write(encodeFrame(request));
    }
    // Notifications are best-effort; not buffered (no id to correlate).
  }

  function close(): void {
    closed = true;
    if (redialTimer) {
      clearTimeout(redialTimer);
      redialTimer = null;
    }
    failAllPending('proxy closed');
    if (socket) {
      socket.destroy();
      socket = null;
    }
  }

  // Begin connecting immediately.
  connect();
  scheduleRedial();

  return {
    send,
    notify,
    isConnected: () => socket !== null,
    close,
  };
}
