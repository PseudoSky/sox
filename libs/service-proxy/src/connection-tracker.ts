/**
 * libs/service-proxy/src/connection-tracker.ts — per-connection identity for
 * `serveBackend` (8468f7b1 Feature A, SP1/SP3/SP5).
 *
 * Pure bookkeeping: no `net`, no timers, no I/O. The tracker keys on an opaque
 * connection object (a `net.Socket` in production, any object in tests), mints a
 * counter-based id ("c1", "c2", ...) for each, and fires `onClientConnect` /
 * `onClientDisconnect` exactly once each with isolated hook exceptions.
 *
 * ADR-0022: a connection id is identity only. Nothing here feeds any retire
 * decision, and the tracker never holds a connection open.
 *
 * Leaf module — no imports.
 */

/** Per-connection context handed to a {@link BackendHandler} as its second argument. */
export interface ConnectionContext {
  /** Opaque, unique per accepted connection within one `serveBackend`. Not a secret. */
  readonly connectionId: string;
}

/**
 * Why a connection ended. A peer SIGKILL normally surfaces as `'end'`;
 * consumers must not rely on telling `'end'` and `'error'` apart.
 */
export type ClientDisconnectReason = 'end' | 'error' | 'closed-by-backend';

export interface ConnectionTrackerOptions {
  onClientConnect?: ((connectionId: string) => void) | undefined;
  onClientDisconnect?: ((connectionId: string, reason: ClientDisconnectReason) => void) | undefined;
  /** Diagnostic sink for isolated hook exceptions. */
  diag: (line: string) => void;
}

export interface ConnectionTracker<C extends object> {
  /** Register a freshly accepted connection, fire `onClientConnect`, return its context. */
  connected(conn: C): ConnectionContext;
  /** The frozen context of a tracked connection, or `undefined` once it is gone. */
  context(conn: C): ConnectionContext | undefined;
  /** Mark the connection as ending because of an error (first mark wins). */
  markError(conn: C): void;
  /** Mark the connection as being closed by the backend (first mark wins). */
  markClosingByBackend(conn: C): void;
  /** The connection closed: fire `onClientDisconnect` once, then forget it. Idempotent. */
  disconnected(conn: C): void;
  /** Number of tracked connections (diagnostics/tests). */
  readonly size: number;
}

interface Entry {
  readonly ctx: ConnectionContext;
  reason: ClientDisconnectReason | null;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createConnectionTracker<C extends object>(
  opts: ConnectionTrackerOptions,
): ConnectionTracker<C> {
  const entries = new Map<C, Entry>();
  let counter = 0;

  return {
    connected(conn) {
      counter += 1;
      const ctx: ConnectionContext = Object.freeze({ connectionId: `c${counter}` });
      entries.set(conn, { ctx, reason: null });
      if (opts.onClientConnect) {
        try {
          opts.onClientConnect(ctx.connectionId);
        } catch (err) {
          opts.diag(`[service-proxy backend] onClientConnect threw: ${errText(err)}`);
        }
      }
      return ctx;
    },
    context(conn) {
      return entries.get(conn)?.ctx;
    },
    markError(conn) {
      const e = entries.get(conn);
      if (e && e.reason === null) e.reason = 'error';
    },
    markClosingByBackend(conn) {
      const e = entries.get(conn);
      if (e && e.reason === null) e.reason = 'closed-by-backend';
    },
    disconnected(conn) {
      const e = entries.get(conn);
      if (!e) return;
      entries.delete(conn);
      if (opts.onClientDisconnect) {
        try {
          opts.onClientDisconnect(e.ctx.connectionId, e.reason ?? 'end');
        } catch (err) {
          opts.diag(`[service-proxy backend] onClientDisconnect threw: ${errText(err)}`);
        }
      }
    },
    get size() {
      return entries.size;
    },
  };
}
