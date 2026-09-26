/**
 * libs/service-proxy/src/backend.ts — the backend-side UDS listener (§9.5.4).
 *
 * The real server (the M2/M4 daemon holding the tool implementation) wraps its
 * existing in-process JSON-RPC dispatcher with `serveBackend`. The front-shim dials
 * this socket; every length-prefixed request frame is handed to `handler`, and the
 * response is framed back. The backend NEVER touches stdout — it is a detached
 * daemon, not the client's pipe; all diagnostics go to stderr/the serve-record.
 *
 * SA-4 hardening: `serveBackend` NEVER unlinks a live socket. Before any bind
 * (inherited fd or own-bind), if the socket file exists we probe-connect first.
 * A live socket is refused with a structured `E_LIVE_SOCKET` error — the caller
 * must use ensureBackend() which coordinates via O_EXCL lock.
 *
 * Leaf module — node builtins only (net, fs, path).
 */

import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildFailureRecord, classifyListenError, emitListenFailure } from '@adhd/sox-listen-guard';
import { encodeFrame, FrameDecoder } from './framing.js';
import { probeSocketLive } from './ensure-backend.js';
import {
  type JsonRpcRequest,
  type JsonRpcResponse,
  errorResponse,
  isJsonRpcRequest,
  isNotification,
} from './jsonrpc.js';

/** A request handler: receives a JSON-RPC request, returns a response. */
export type BackendHandler = (
  request: JsonRpcRequest,
) => Promise<JsonRpcResponse | undefined> | JsonRpcResponse | undefined;

/** Options for {@link serveBackend}. */
export interface ServeBackendOptions {
  /** The UDS path to listen on (data-root-derived, ADR-0004). */
  socketPath: string;
  /** The JSON-RPC dispatcher. Return `undefined` for notifications (no response). */
  handler: BackendHandler;
  /** stderr diagnostics sink. Defaults to writing to process.stderr. */
  onDiagnostic?: (line: string) => void;
  /**
   * SA-3: A pre-bound, pre-listening file descriptor from an OS supervisor
   * (launchd socket activation). When set, `serveBackend` listens on this
   * inherited fd instead of creating + binding + chmod'ing a UDS file. The
   * `socketPath` field is still used for identification (the BackendHandle
   * reports it), but no file is created on disk.
   *
   * Negative-control invariant: when omitted (the normal case), the original
   * create+bind+chmod path is used unchanged.
   */
  inheritFd?: number | undefined;
  /**
   * The embedding-funnel lifecycle hook (SPEC-EMBEDDING-FUNNEL.md §A): called
   * with the live client-connection count on EVERY connect and disconnect.
   *
   * `sockets` (the per-`serveBackend` Set below) is the single source of truth
   * for "how many clients are attached right now". A self-reaping host uses
   * this to know when the last cross-process consumer has left, so it can arm
   * its idle teardown. Purely observational: the hook never affects the
   * accept/dispatch path, and omitting it (every existing caller) changes
   * nothing.
   */
  onClientCountChange?: (active: number) => void;
}

/** A running backend listener handle. */
export interface BackendHandle {
  /** The bound socket path. */
  socketPath: string;
  /** Stop listening and close all client connections. */
  close(): Promise<void>;
}

/**
 * Start a UDS listener that relays framed JSON-RPC to `handler`.
 *
 * SA-4 hardening: this function NEVER unlinks a live socket. If the socket file
 * exists we probe-connect first; a live socket is refused with a structured
 * `E_LIVE_SOCKET` error. Only a stale socket (no process listening) is cleaned.
 * The caller should use ensureBackend() for coordinated singleton spawn.
 *
 * The socket is created 0600.
 */
export function serveBackend(opts: ServeBackendOptions): Promise<BackendHandle> {
  const diag = opts.onDiagnostic ?? ((line: string) => process.stderr.write(line + '\n'));
  const useInheritedFd = typeof opts.inheritFd === 'number';

  const sockets = new Set<net.Socket>();

  /**
   * Emit the live client-connection count to the optional lifecycle hook.
   * `sockets` is the source of truth; this is the ONLY place the count is read
   * for the hook, so connect/disconnect can never disagree about it.
   */
  const notifyClientCount = (): void => {
    if (!opts.onClientCountChange) return;
    try {
      opts.onClientCountChange(sockets.size);
    } catch (err) {
      // An observer must never break the accept/close path — a throwing
      // `onClientCountChange` would otherwise crash the connection callback
      // (and, for the embedding funnel, take the host's teardown bookkeeping
      // with it). Report and continue.
      diag(
        `[service-proxy backend] onClientCountChange threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  async function onFrame(msg: unknown, socket: net.Socket): Promise<void> {
    if (!isJsonRpcRequest(msg)) {
      diag(`[service-proxy backend] dropping non-request frame`);
      return;
    }
    const req = msg as JsonRpcRequest;
    let resp: JsonRpcResponse | undefined;
    try {
      resp = (await opts.handler(req)) ?? undefined;
    } catch (e) {
      diag(`[service-proxy backend] handler threw: ${(e as Error).message}`);
      if (!isNotification(req)) {
        resp = errorResponse(req.id ?? null, -32603, `internal error: ${(e as Error).message}`);
      }
    }
    if (resp === undefined && !isNotification(req)) {
      resp = errorResponse(req.id ?? null, -32603, 'backend produced no response');
    }
    if (resp !== undefined && socket.writable) {
      socket.write(encodeFrame(resp));
    }
  }

  const server = net.createServer((socket) => {
    sockets.add(socket);
    notifyClientCount();
    const decoder = new FrameDecoder(
      (msg) => { void onFrame(msg, socket); },
      (err) => {
        diag(`[service-proxy backend] frame error: ${err.message}`);
        socket.destroy();
      },
    );

    socket.on('data', (chunk: Buffer) => decoder.push(chunk));
    socket.on('error', (err) => {
      diag(`[service-proxy backend] socket error: ${err.message}`);
    });
    socket.on('close', () => {
      decoder.reset();
      sockets.delete(socket);
      notifyClientCount();
    });
  });

  return new Promise<BackendHandle>((resolve, reject) => {
    server.on('error', (err) => {
      // BL-619: emit a durable structured record before rejecting, so a bind
      // failure at this already-guarded site leaves the same JSONL trace as
      // every other production listen site (rather than a bare reject).
      emitListenFailure(
        buildFailureRecord(err, classifyListenError(err), { socketPath: opts.socketPath }),
      );
      reject(err);
    });

    if (!useInheritedFd) {
      try {
        fs.mkdirSync(path.dirname(opts.socketPath), { recursive: true, mode: 0o700 });
      } catch (err) {
        diag(`[service-proxy backend] mkdir ${path.dirname(opts.socketPath)} failed: ${errMessage(err)}`);
      }

      // SA-4: Probe-connect before bind — NEVER steal a live socket.
      const doBind = () => doListen(server, opts, resolve, diag, sockets);

      if (fs.existsSync(opts.socketPath)) {
        probeSocketLive(opts.socketPath, 250).then((live) => {
          if (live) {
            reject(Object.assign(new Error(
              `E_LIVE_SOCKET: socket ${opts.socketPath} is already in use by a live backend`,
            ), { code: 'E_LIVE_SOCKET' }));
            return;
          }
          // Stale socket from a dead backend — clean it so bind succeeds.
          try { fs.unlinkSync(opts.socketPath); } catch (err) { diag(`[service-proxy backend] stale-socket unlink failed: ${errMessage(err)}`); }
          doBind();
        }).catch((probeErr: unknown) => {
          // Probe itself failed — still try to unlink the stale socket.
          diag(`[service-proxy backend] liveness probe failed: ${errMessage(probeErr)}`);
          try { fs.unlinkSync(opts.socketPath); } catch (err) { diag(`[service-proxy backend] stale-socket unlink failed: ${errMessage(err)}`); }
          doBind();
        });
        return; // Async probe in flight above
      }
    }

    // No socket file exists, or we are using an inherited fd — bind directly.
    if (useInheritedFd) {
      server.listen({ fd: opts.inheritFd } as net.ListenOptions, () => {
        resolve({
          socketPath: opts.socketPath,
          close: () =>
            new Promise<void>((res) => {
              for (const s of sockets) s.destroy();
              sockets.clear();
              notifyClientCount();
              server.close(() => res());
            }),
        });
      });
    } else {
      doListen(server, opts, resolve, diag, sockets);
    }
  });
}

/**
 * SA-4 refactored listen helper: bind the server to its socket path (non-inherited).
 */
function doListen(
  server: net.Server,
  opts: ServeBackendOptions,
  resolve: (h: BackendHandle) => void,
  diag: (line: string) => void,
  sockets: Set<net.Socket>,
): void {
  server.listen(opts.socketPath, () => {
    try {
      fs.chmodSync(opts.socketPath, 0o600);
    } catch (err) {
      diag(`[service-proxy backend] chmod 0600 failed on ${opts.socketPath}: ${errMessage(err)}`);
    }
    // 448f9d93: record WHICH filesystem object we bound. The close callback
    // below runs only after every client connection has closed — long after
    // libuv already unlinked the path inside `server.close()` — so by then a
    // successor may have bound a fresh socket at the same path. Unlinking by
    // path alone deleted that successor's socket (reproduced on Node 24.11.1).
    const bound = statIdentity(opts.socketPath, diag);
    resolve({
      socketPath: opts.socketPath,
      close: () =>
        new Promise<void>((res) => {
          for (const s of sockets) s.destroy();
          sockets.clear();
          opts.onClientCountChange?.(0);
          server.close(() => {
            unlinkIfStillOurs(opts.socketPath, bound, diag);
            res();
          });
        }),
    });
  });
}

/** `(dev, ino)` of the socket file we bound — the identity the close path checks. */
interface SocketIdentity {
  dev: number;
  ino: number;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function statIdentity(socketPath: string, diag: (line: string) => void): SocketIdentity | null {
  try {
    const st = fs.lstatSync(socketPath);
    return { dev: st.dev, ino: st.ino };
  } catch (err) {
    diag(`[service-proxy backend] could not stat bound socket ${socketPath}: ${errMessage(err)}`);
    return null;
  }
}

/**
 * 448f9d93: unlink `socketPath` only when it is still the exact filesystem
 * object this listener bound. A path that is gone (libuv already unlinked it)
 * or that now names a DIFFERENT socket (a successor bound it) is left alone.
 * An unknown bound identity never unlinks — deleting a live successor's socket
 * is strictly worse than leaving a stale file the next binder's probe cleans.
 */
function unlinkIfStillOurs(
  socketPath: string,
  bound: SocketIdentity | null,
  diag: (line: string) => void,
): void {
  if (bound === null) return;
  let current: fs.Stats;
  try {
    current = fs.lstatSync(socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    diag(`[service-proxy backend] could not stat ${socketPath} at close: ${errMessage(err)}`);
    return;
  }
  if (current.dev !== bound.dev || current.ino !== bound.ino) {
    diag(
      `[service-proxy backend] not unlinking ${socketPath}: it now names a successor's socket ` +
        `(bound ino ${bound.ino}, current ino ${current.ino})`,
    );
    return;
  }
  try {
    fs.unlinkSync(socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      diag(`[service-proxy backend] unlink ${socketPath} failed: ${errMessage(err)}`);
    }
  }
}
