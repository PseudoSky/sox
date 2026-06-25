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
 * Leaf module — node builtins only (net).
 */

import * as net from 'node:net';
import { encodeFrame, FrameDecoder } from './framing.js';
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
}

const DEFAULTS: Required<BackoffOptions> = {
  initialMs: 50,
  maxMs: 2000,
  giveUpAfterMs: 10000,
  maxQueue: 256,
};

/** A pending request awaiting a backend response. */
interface Pending {
  request: JsonRpcRequest;
  resolve: (resp: JsonRpcResponse) => void;
  /** Has this request been written to the current backend socket yet? */
  sent: boolean;
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

  /** Requests awaiting a response, keyed by JSON-RPC id. */
  const pending = new Map<JsonRpcId, Pending>();
  /** FIFO of requests queued while disconnected (preserves send order). */
  const queue: Pending[] = [];

  function connect(): void {
    if (closed || connecting || socket) return;
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
      }
      maybeFastFail();
      scheduleRedial();
    });
  }

  function scheduleRedial(): void {
    if (closed || redialTimer || socket || connecting) return;
    redialTimer = setTimeout(() => {
      redialTimer = null;
      connect();
    }, backoffMs);
    // Don't keep the event loop alive solely for the re-dial timer.
    redialTimer.unref?.();
    backoffMs = Math.min(backoffMs * 2, cfg.maxMs);
  }

  /** Move any sent-but-unanswered pending back to the front of the queue. */
  function requeueUnanswered(): void {
    const unanswered: Pending[] = [];
    for (const p of pending.values()) {
      if (p.sent) {
        p.sent = false;
        unanswered.push(p);
      }
    }
    // Preserve original order: unanswered (older) ahead of already-queued.
    queue.unshift(...unanswered);
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

  function failAllPending(message: string): void {
    for (const p of queue.splice(0)) {
      p.resolve(errorResponse(p.request.id ?? null, ERR_BACKEND_UNAVAILABLE, message));
    }
    for (const p of pending.values()) {
      p.resolve(errorResponse(p.request.id ?? null, ERR_BACKEND_UNAVAILABLE, message));
    }
    pending.clear();
  }

  function flushQueue(): void {
    if (!socket) return;
    while (queue.length > 0 && socket) {
      const p = queue.shift();
      if (!p) break;
      writeToBackend(p);
    }
  }

  function writeToBackend(p: Pending): void {
    if (!socket || !socket.writable) {
      queue.push(p);
      return;
    }
    p.sent = true;
    if (p.request.id !== undefined) pending.set(p.request.id, p);
    socket.write(encodeFrame(p.request));
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

      if (socket && socket.writable) {
        writeToBackend(p);
      } else {
        queue.push(p);
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
