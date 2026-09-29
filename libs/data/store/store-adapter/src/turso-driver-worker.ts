/**
 * turso-driver-worker.ts — the realm-isolated Turso driver worker (plan
 * `862129b5`, packet **TUR-B**). A SIDECAR: spawned as the process-wide
 * `worker_threads.Worker` by `turso-driver-host.ts` (TUR-C) via `spawnWorker`,
 * never statically imported by anything.
 *
 * This file owns the ONLY value-import of the native `@tursodatabase/database`
 * driver in `@adhd/sox-store-adapter`. Everything the main thread can observe
 * about a driver call crosses the `parentPort` boundary as a versioned
 * `DriverRequest`/`DriverResponse` envelope from `./turso-driver-protocol.js`
 * (TUR-A) — never a live driver object, never an `Error` thrown across the port.
 *
 * ## Realm isolation — the closed import set (the plan's D3, ADR-0019)
 *
 * The whole point of this worker is that the native chain is absent from every
 * main-thread module graph, so this module's import set is deliberately closed:
 *
 *  - `node:worker_threads` — the transport (`parentPort`, `MessagePort`);
 *  - `./turso-driver-protocol.js` — the marshalling primitives (TUR-A);
 *  - `@tursodatabase/database` — reached ONLY through the lazy, NON-LITERAL
 *    dynamic import below (ADR-0019: a literal specifier is statically
 *    analysable, so a bundler may hoist it back into an eager import and drag
 *    the native chain onto the main thread — the exact defeat this worker
 *    exists to prevent).
 *
 * It deliberately imports NO telemetry, NO `store-lease` (whose module-scope
 * opener registry is main-thread process state), NO `deep-verify`, and NO other
 * `store-adapter` module (the adapters, the factory, the openers, engine-guard,
 * store-rebuild, integrity). A source-scan spec —
 * `__tests__/turso-driver-realm-guard.spec.ts` — asserts this and scans the
 * BUILT `dist/turso-driver-worker.js` for the same forbidden symbols.
 *
 * This is a worker realm, so it also cannot use `@adhd/sox-telemetry`: a
 * marshalling or teardown failure is reported on `process.stderr` here instead,
 * exactly like `deep-verify-child.ts` does for the child-process realm.
 *
 * ## Concurrency and lifecycle (the plan's D4/D5)
 *
 * One `message` loop for the worker's whole lifetime. A request is dispatched
 * fire-and-forget, so a slow driver call on one connection can never delay the
 * dequeue of the next message from the port (no head-of-line blocking). There
 * is NO host-side cancellation: the host owns timeouts and the stall policy
 * (TUR-C/TUR-F), and SIGKILLs a close that parks in native code. This module
 * only runs what it is handed.
 *
 * @module
 */

import { parentPort, type MessagePort } from 'node:worker_threads';
import {
  TURSO_DRIVER_PROTOCOL_VERSION,
  serializeDriverError,
  type DriverMethod,
  type DriverRequest,
  type DriverResponse,
} from './turso-driver-protocol.js';

/**
 * The driver specifier, held in a variable and never written literally at an
 * import site (ADR-0019). The non-literal `import(DRIVER_SPECIFIER)` below is
 * opaque to static analysis, so no bundler can hoist the native chain into a
 * main-thread module graph.
 */
const DRIVER_SPECIFIER = '@tursodatabase/database';

/**
 * Minimum structural surface of a driver connection this worker drives. The
 * native `Database` satisfies it; declaring it locally (rather than importing
 * the driver's types) keeps even a type-only driver import out of the static
 * specifier set, so the realm-guard scan has exactly one non-`node:` specifier
 * to allow.
 */
interface DriverDatabase {
  run(sql: string, ...args: unknown[]): Promise<unknown>;
  get(sql: string, ...args: unknown[]): Promise<unknown>;
  all(sql: string, ...args: unknown[]): Promise<unknown[]>;
  exec(sql: string, ...args: unknown[]): Promise<unknown>;
  pragma(sql: string, ...args: unknown[]): Promise<unknown>;
  close(): Promise<void>;
}

/** The subset of the driver module this worker needs. */
interface DriverModule {
  connect(url: string, opts?: Record<string, unknown>): Promise<DriverDatabase>;
}

/** `connId` → live driver connection. One entry per open connection. */
const connections = new Map<number, DriverDatabase>();

/** Memoized driver load (ADR-0019 §3: resolve lazily, cache once). */
let driverModule: Promise<DriverModule> | undefined;

/** Set once teardown has begun; no further requests are dispatched. */
let shuttingDown = false;

/**
 * Resolve the driver exactly once. The import is lazy (nothing here runs until
 * the first `open` request arrives) and non-literal (see {@link DRIVER_SPECIFIER}).
 */
function loadDriver(): Promise<DriverModule> {
  driverModule ??= resolveDriver();
  return driverModule;
}

async function resolveDriver(): Promise<DriverModule> {
  const mod = await import(DRIVER_SPECIFIER);
  if (typeof (mod as { connect?: unknown }).connect !== 'function') {
    throw new Error(
      `turso-driver-worker: "${DRIVER_SPECIFIER}" did not export a connect() function`,
    );
  }
  return mod as DriverModule;
}

/**
 * Answer one request. Runs off the message loop (the caller never awaits it),
 * so a slow native step cannot block the dequeue of the next message. Never
 * rejects: every rejection becomes the promise's rejected value, which the
 * caller's `onRejected` turns into an `err` envelope.
 */
async function dispatch(req: DriverRequest): Promise<unknown> {
  switch (req.kind) {
    case 'open':
      return openConnection(req.connId, req.url, req.opts);
    case 'call':
      return callConnection(req.connId, req.method, req.sql, req.args);
    case 'close':
      return closeConnection(req.connId);
  }
}

async function openConnection(
  connId: number,
  url: string,
  opts: Record<string, unknown>,
): Promise<undefined> {
  if (connections.has(connId)) {
    throw new Error(`turso-driver-worker: connId ${connId} is already open`);
  }
  const { connect } = await loadDriver();
  const connection = await connect(url, opts);
  connections.set(connId, connection);
  return undefined;
}

async function callConnection(
  connId: number,
  method: DriverMethod,
  sql: string,
  args: unknown[],
): Promise<unknown> {
  const connection = connections.get(connId);
  if (connection === undefined) {
    throw new Error(
      `turso-driver-worker: '${method}' for unknown connId ${connId} — the connection is not open`,
    );
  }
  // Explicit switch (not `connection[method]`) so each method keeps its own
  // signature — a union of function types has no callable common signature.
  switch (method) {
    case 'run':
      return await connection.run(sql, ...args);
    case 'get':
      return await connection.get(sql, ...args);
    case 'all':
      return await connection.all(sql, ...args);
    case 'exec':
      return await connection.exec(sql, ...args);
    case 'pragma':
      return await connection.pragma(sql, ...args);
  }
}

async function closeConnection(connId: number): Promise<undefined> {
  const connection = connections.get(connId);
  // Idempotent: a close for an already-closed / never-opened connId is a no-op,
  // matching ordinary `close()` semantics and tolerating a close racing an open
  // that failed.
  if (connection === undefined) return undefined;
  connections.delete(connId);
  await connection.close();
  return undefined;
}

/**
 * Post one response. Never throws: a driver value that structured clone refuses
 * (a `DataCloneError` from `postMessage`) must not strand the caller, so an
 * `ok` is downgraded to a cloneable `err`. An `err`/`ready` that cannot post
 * means the port itself is gone — reported on stderr, never swallowed.
 */
function post(port: MessagePort, response: DriverResponse): void {
  try {
    port.postMessage(response);
  } catch (err: unknown) {
    if (response.kind === 'ok') {
      post(port, { kind: 'err', id: response.id, error: serializeDriverError(err) });
      return;
    }
    const serialized = serializeDriverError(err);
    process.stderr.write(
      `[turso-driver-worker] could not post a '${response.kind}' message (port closed?): ` +
        `${serialized.name}: ${serialized.message}\n`,
    );
  }
}

/**
 * Handle one port message. A malformed envelope is dropped with an stderr note
 * (it carries no `id`, so it cannot be correlated to a response); a well-formed
 * request is dispatched fire-and-forget with exactly one eventual response —
 * `ok` on success, `err` on any rejection.
 */
function onMessage(port: MessagePort, raw: unknown): void {
  if (shuttingDown) return;
  if (
    raw === null ||
    typeof raw !== 'object' ||
    typeof (raw as { id?: unknown }).id !== 'number' ||
    typeof (raw as { kind?: unknown }).kind !== 'string'
  ) {
    process.stderr.write(
      '[turso-driver-worker] dropping malformed message (missing numeric `id` / string `kind`)\n',
    );
    return;
  }
  const request = raw as DriverRequest;
  // Fire-and-forget: awaiting here would let one slow driver call block the
  // dequeue of the next port message. `dispatch` never rejects unhandled and
  // `post` never throws, so no unhandled rejection can escape this loop.
  dispatch(request).then(
    (value) => post(port, { kind: 'ok', id: request.id, value }),
    (err: unknown) => post(port, { kind: 'err', id: request.id, error: serializeDriverError(err) }),
  );
}

/**
 * Best-effort teardown on parent disconnect / port close. There is no host-side
 * cancellation to observe and nothing left to answer, so each handle is closed
 * and any failure is reported on stderr (never swallowed, never rethrown into
 * an unhandled rejection). The worker terminates once the closes settle; the
 * host's SIGKILL is the bound for a close parked in native code (the plan's D5).
 */
function teardown(origin: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  const open = [...connections.values()];
  connections.clear();
  const closes = open.map((connection) =>
    Promise.resolve()
      .then(() => connection.close())
      .catch((err: unknown) => {
        const serialized = serializeDriverError(err);
        process.stderr.write(
          `[turso-driver-worker] connection close during teardown (${origin}) failed: ` +
            `${serialized.name}: ${serialized.message}\n`,
        );
      }),
  );
  void Promise.allSettled(closes).then(() => {
    // Clean, bounded exit: every handle has been released and the port is gone.
    process.exit(0);
  });
}

function main(): void {
  if (parentPort === null) {
    throw new Error(
      'turso-driver-worker: must run as a worker_threads Worker (parentPort is null)',
    );
  }
  const port = parentPort;

  // Ready first, THEN the handler — the host waits for `ready` before it sends
  // any request. Attaching the listener in the same synchronous turn means no
  // in-flight message can be missed.
  port.postMessage({
    kind: 'ready',
    protocol: TURSO_DRIVER_PROTOCOL_VERSION,
  } satisfies DriverResponse);
  port.on('message', (raw: unknown) => onMessage(port, raw));

  // The two ways this worker learns its parent is gone. The host owns the
  // lifecycle; these only release native handles before it does.
  port.on('close', () => teardown('parent port closed'));
  process.on('disconnect', () => teardown('parent disconnected'));
}

main();
