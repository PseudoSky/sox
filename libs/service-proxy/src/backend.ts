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
      } catch {
        /* dir may already exist */
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
          try { fs.unlinkSync(opts.socketPath); } catch { /* best-effort */ }
          doBind();
        }).catch(() => {
          // Probe itself failed — still try to unlink the stale socket.
          try { fs.unlinkSync(opts.socketPath); } catch { /* best-effort */ }
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
  _diag: (line: string) => void,
  sockets: Set<net.Socket>,
): void {
  server.listen(opts.socketPath, () => {
    try {
      fs.chmodSync(opts.socketPath, 0o600);
    } catch {
      /* best-effort perms hardening */
    }
    resolve({
      socketPath: opts.socketPath,
      close: () =>
        new Promise<void>((res) => {
          for (const s of sockets) s.destroy();
          sockets.clear();
          server.close(() => {
            try {
              if (fs.existsSync(opts.socketPath)) fs.unlinkSync(opts.socketPath);
            } catch {
              /* best-effort */
            }
            res();
          });
        }),
    });
  });
}
