/**
 * libs/listen-guard/src/listen-guard.ts — repo-wide listen() safety invariant (BL-619).
 *
 * BL-619 (2026-07-18): `libs/service-proxy/src/shim.ts` called
 * `httpServer.listen(port, host, ...)` with NO 'error' listener — the ONLY
 * unguarded `listen()` in the repo. On a port collision (launchd-held 3099 + a
 * client-spawned duplicate shim) Node emitted an unhandled 'error' event → process
 * death with a raw crash dump, six times in one day.
 *
 * This leaf lib is the LIFETIME fix, not a single error handler. It gives every
 * production `listen()` site:
 *
 *   1. **probe-before-bind** (TCP): `probeTcp` mirrors `probeSocketLive` from
 *      service-proxy's ensure-backend — a live port is detected BEFORE bind, so
 *      the caller resolves an `already-running` outcome without ever calling
 *      `listen()`. (UDS sites keep their own SA-4 probe/stale logic; this lib
 *      does not reimplement it.)
 *   2. **guarded listen**: `listenGuarded` attaches a `once('error')` listener
 *      BEFORE `listen()`, classifies the error, and RESOLVES a structured
 *      outcome instead of ever throwing for a bind failure.
 *   3. **structured record**: `emitListenFailure` appends a JSONL
 *      `ListenFailureRecord` (code/errno/syscall/message/host/port/socketPath/
 *      disposition/pid/ts) so a collision leaves a durable, machine-readable
 *      trace rather than a raw node crash stack.
 *
 * Disposition semantics mirror backend "already-live": EADDRINUSE → 'already-running'
 * (exit 0 — another instance is already serving), any other bind error → 'other'
 * (exit 1 — a genuine fault).
 *
 * Leaf module — node builtins only (net, fs, path).
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

/** The disposition of a failed listen. */
export type ListenDisposition = 'already-running' | 'other';

/** A structured, machine-readable record of a listen failure (JSONL). */
export interface ListenFailureRecord {
  /** errno code string when known (e.g. 'EADDRINUSE', 'EACCES', 'ENOENT'). */
  code?: string;
  /** numeric errno, stringified when present. */
  errno?: string;
  /** syscall that failed (e.g. 'listen'). */
  syscall?: string;
  /** human-readable error message. */
  message: string;
  /** TCP host when applicable. */
  host?: string;
  /** TCP port when applicable. */
  port?: number;
  /** UDS path when applicable. */
  socketPath?: string;
  disposition: ListenDisposition;
  /** pid of the process that wrote the record. */
  pid: number;
  /** ISO-8601 timestamp. */
  ts: string;
}

/** What to bind. TCP (port/host), UDS (socketPath), or an inherited fd. */
export interface ListenTarget {
  port?: number;
  host?: string;
  socketPath?: string;
  fd?: number;
}

/** Options for {@link listenGuarded}. */
export interface ListenGuardOptions {
  /** Optional JSONL file to append a {@link ListenFailureRecord} to on failure. */
  recordFile?: string;
  /** stderr diagnostics sink. */
  onDiagnostic?: (line: string) => void;
  /** TCP probe timeout in ms (default 250). */
  probeTimeoutMs?: number;
}

/** Options for {@link emitListenFailure}. */
export interface EmitFailureOptions {
  /** Optional JSONL file to append the record to. The caller resolves the path. */
  recordFile?: string;
}

/** The outcome of a guarded listen: success, or a structured failure. */
export type ListenOutcome =
  | { ok: true }
  | { ok: false; disposition: ListenDisposition; failure: ListenFailureRecord };

/**
 * Probe whether a TCP port is already serving (mirror `probeSocketLive`).
 * Resolves true iff a connection to host:port is accepted.
 */
export function probeTcp(host: string, port: number, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    let settled = false;
    const done = (live: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(live);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();
    sock.on('connect', () => {
      clearTimeout(timer);
      done(true);
    });
    sock.on('error', () => {
      clearTimeout(timer);
      done(false);
    });
  });
}

/** Classify a listen error: EADDRINUSE → 'already-running', anything else → 'other'. */
export function classifyListenError(err: unknown): ListenDisposition {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return code === 'EADDRINUSE' ? 'already-running' : 'other';
}

/**
 * Build a {@link ListenFailureRecord} from an error (or a synthesized collision).
 *
 * Exported so already-guarded listen sites (backend.ts, runtime.ts, transport.ts,
 * tokenguard/proxy.ts) can emit the same structured record as `listenGuarded`
 * without re-implementing field extraction — BL-619 retrofits them to append a
 * durable trace before their existing reject.
 */
export function buildFailureRecord(
  err: unknown,
  disposition: ListenDisposition,
  target: ListenTarget,
): ListenFailureRecord {
  const e = (err as NodeJS.ErrnoException | null | undefined) ?? null;
  const isTcp = typeof target.port === 'number';
  const host = target.host ?? (isTcp ? '127.0.0.1' : undefined);
  const code = e?.code ?? (disposition === 'already-running' ? 'EADDRINUSE' : undefined);
  const message =
    e?.message ??
    (isTcp
      ? `listen on ${host}:${target.port} failed${code !== undefined ? `: ${code}` : ''}`
      : `listen on ${target.socketPath ?? 'socket'} failed${code !== undefined ? `: ${code}` : ''}`);
  return {
    ...(code !== undefined ? { code } : {}),
    ...(e?.errno !== undefined ? { errno: String(e.errno) } : {}),
    ...(e?.syscall !== undefined ? { syscall: e.syscall } : {}),
    message,
    ...(host !== undefined ? { host } : {}),
    ...(isTcp ? { port: target.port } : {}),
    ...(target.socketPath !== undefined ? { socketPath: target.socketPath } : {}),
    disposition,
    pid: process.pid,
    ts: new Date().toISOString(),
  };
}

/**
 * Append a {@link ListenFailureRecord} as a single JSONL line. Best-effort — a
 * failed record write must never crash the caller (the record is diagnostics,
 * not control flow).
 */
export function emitListenFailure(rec: ListenFailureRecord, opts: EmitFailureOptions = {}): void {
  const line = JSON.stringify(rec) + '\n';
  if (opts.recordFile !== undefined && opts.recordFile !== '') {
    try {
      fs.mkdirSync(path.dirname(opts.recordFile), { recursive: true, mode: 0o700 });
      fs.appendFileSync(opts.recordFile, line, 'utf8');
    } catch {
      // best-effort — never crash on record write failure
    }
  }
}

/** Translate a {@link ListenTarget} into `net.Server.listen` options. */
function toListenOptions(target: ListenTarget): net.ListenOptions {
  if (typeof target.fd === 'number') {
    // `fd` socket-activation is not in @types/node's ListenOptions surface, but is
    // a valid listen() overload (see service-proxy/backend.ts for the same cast).
    return { fd: target.fd } as net.ListenOptions;
  }
  if (typeof target.socketPath === 'string') {
    return { path: target.socketPath };
  }
  return {
    port: target.port ?? 0,
    host: target.host ?? '127.0.0.1',
  };
}

/**
 * Bind `server` with an 'error' listener attached BEFORE `listen()` is called,
 * and resolve a structured outcome rather than ever throwing for a bind failure.
 *
 * For TCP targets, probes the port first (`probeTcp`): a live port resolves
 * `{ ok: false, disposition: 'already-running' }` WITHOUT calling `listen()`. UDS
 * targets skip the probe (the caller owns their SA-4 probe/stale logic) and rely
 * solely on the pre-attached 'error' guard.
 */
export async function listenGuarded(
  server: net.Server,
  target: ListenTarget,
  opts: ListenGuardOptions = {},
): Promise<ListenOutcome> {
  const diag = opts.onDiagnostic ?? (() => {});
  const host = target.host ?? '127.0.0.1';
  const isTcp = typeof target.port === 'number';

  if (isTcp) {
    const live = await probeTcp(host, target.port!, opts.probeTimeoutMs ?? 250);
    if (live) {
      const failure = buildFailureRecord(null, 'already-running', target);
      emitListenFailure(failure, { ...(opts.recordFile !== undefined ? { recordFile: opts.recordFile } : {}) });
      diag(`[listen-guard] ${host}:${target.port} already in use — not binding`);
      return { ok: false, disposition: 'already-running', failure };
    }
  }

  return new Promise<ListenOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: ListenOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    // Attach the error guard BEFORE listen() — the entire point of this module.
    server.once('error', (err: NodeJS.ErrnoException) => {
      const disposition = classifyListenError(err);
      const failure = buildFailureRecord(err, disposition, target);
      emitListenFailure(failure, { ...(opts.recordFile !== undefined ? { recordFile: opts.recordFile } : {}) });
      diag(`[listen-guard] listen failed (${disposition}): ${err.message}`);
      settle({ ok: false, disposition, failure });
    });

    server.listen(toListenOptions(target), () => {
      settle({ ok: true });
    });
  });
}
