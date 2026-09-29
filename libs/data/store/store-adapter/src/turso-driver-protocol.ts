/**
 * turso-driver-protocol.ts — the marshalling primitives for the off-thread
 * Turso driver boundary (plan `862129b5`, packet **TUR-A**).
 *
 * The native `@tursodatabase/database` driver is moved off the memory-server
 * main thread onto a single process-wide worker thread (ADR-0024, proposed).
 * Every request/response crossing that boundary goes through the versioned
 * envelopes and helpers declared here.
 *
 * ## Why this module is deliberately dependency-free
 *
 * This file is imported by BOTH realms — the main-thread host that owns the
 * RPC (TUR-C) and the realm-isolated worker sidecar that actually loads the
 * native driver (TUR-B). It therefore may not pull in anything that would
 * drag a realm-specific dependency across the boundary:
 *
 * - **no `worker_threads`** — the primitives are pure data-shaping; only the
 *   host/worker transport modules may touch the port.
 * - **no telemetry** — a marshalling failure must be observable via the
 *   returned envelope, never an emit that could itself cross the boundary.
 * - **no `@tursodatabase/database`** — the driver lives in the worker realm
 *   only (TUR-B); importing it here would defeat realm isolation.
 *
 * The only import is the `Buffer` constructor, which is a Node builtin present
 * in both realms. A source-scan spec (`turso-driver-protocol.spec.ts`) asserts
 * this purity so a future edit cannot quietly violate it.
 *
 * ## The error round-trip (why it exists — ADR-0012 §5)
 *
 * `@adhd/sox-store-adapter`'s own `errors.ts` classifies driver failures by
 * DUCK-TYPE SHAPE (`err.code`, `err.name`, `err.message` markers) — see
 * ADR-0012 §3/§5. When an error is raised in the worker realm and crosses the
 * boundary, `Error` instances do not survive `structuredClone`: the revived
 * value must be re-shaped such that `store-adapter/src/errors.ts`'s predicates
 * return the SAME verdicts they would for the native in-thread error. That is
 * exactly what `serializeDriverError` → `reviveDriverError` guarantee, and
 * what the predicate-parity spec pins.
 */

import { Buffer } from 'node:buffer';

/**
 * Wire-format version for every `DriverRequest`/`DriverResponse` envelope.
 *
 * A protocol mismatch is a hard error at the host boundary (TUR-C throws
 * `E_TURSO_DRIVER_PROTOCOL_MISMATCH`): the singletons are keyed on
 * `globalThis[Symbol.for('@adhd/sox-store-adapter/turso-driver-host')]`, so a
 * host-only reload can otherwise pair a new host with a worker built from older
 * bytes. Bump this whenever the envelope shape changes incompatibly.
 */
export const TURSO_DRIVER_PROTOCOL_VERSION = 1;

/** The driver methods proxied across the boundary. */
export type DriverMethod = 'run' | 'get' | 'all' | 'exec' | 'pragma';

/**
 * A main-thread → worker request. Every request carries a monotonically
 * increasing `id` (used to resolve the matching response; a single FIFO port,
 * no host-side timeouts) and the `connId` of the connection it targets.
 */
export type DriverRequest =
  | { kind: 'open'; id: number; connId: number; url: string; opts: Record<string, unknown> }
  | {
      kind: 'call';
      id: number;
      connId: number;
      method: DriverMethod;
      sql: string;
      args: unknown[];
      label: string;
    }
  | { kind: 'close'; id: number; connId: number };

/**
 * A worker → main-thread response.
 *
 * `ready` is posted exactly once, before the worker begins draining the port.
 * Every `open`/`call`/`close` resolves to either `ok` (carrying the revived
 * driver value) or `err` (carrying the serialized driver error) — the worker
 * never lets a rejection escape as an unhandled rejection.
 */
export type DriverResponse =
  | { kind: 'ok'; id: number; value: unknown }
  | { kind: 'err'; id: number; error: SerializedDriverError }
  | { kind: 'ready'; protocol: number };

/**
 * The cloneable projection of a driver error.
 *
 * Field-for-field this is what `store-adapter/src/errors.ts` inspects:
 * `name` + `message` + `code` (the shape gate `isErrorWithCode`), and
 * `rawCode` preserved for a caller that wants the driver's numeric code.
 */
export interface SerializedDriverError {
  name: string;
  /** A string `err.name`, or `'Error'`/`'NonError'` for a non-Error throw. */
  message: string;
  /** A string `err.code` (e.g. `'GenericFailure'`, `'SQLITE_BUSY'`), when present. */
  code?: string;
  /** The driver's raw numeric/other code (`err.rawCode`), when present. */
  rawCode?: unknown;
  /** The worker-realm stack, when the throw was an `Error`. */
  stack?: string;
}

/** `String(value)` that can never itself throw (a hostile `toString`). */
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch (e) {
    // Not an empty catch: the failure is recorded in the returned marker so a
    // truly unstringifiable throw still produces a usable message downstream.
    return `<unstringifiable:${(e as { name?: unknown })?.name ?? 'unknown'}>`;
  }
}

/** Sentinel for a property whose getter threw — see {@link safeGet}. */
const UNREADABLE = Symbol('unreadable');

/**
 * Read a property without letting a hostile getter escape. A thrown getter is
 * not silently swallowed: it is replaced by the {@link UNREADABLE} sentinel,
 * which every caller maps onto an explicit documented fallback (never into the
 * serialized error as a half-read value).
 */
function safeGet(obj: object, key: string): unknown {
  try {
    return (obj as Record<string, unknown>)[key];
  } catch {
    return UNREADABLE;
  }
}

/** True for a non-null object — the only carrier that can hold `code`/`rawCode`. */
function asRecord(err: unknown): Record<string, unknown> | undefined {
  return typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : undefined;
}

/**
 * Project any thrown value into the cloneable {@link SerializedDriverError}
 * envelope. Never throws, even for a non-Error throw or a hostile getter — it
 * runs in the worker's failure path, where a rethrow would strand the caller.
 */
export function serializeDriverError(err: unknown): SerializedDriverError {
  const out: SerializedDriverError = { name: 'Error', message: '' };

  const rec = asRecord(err);
  if (rec !== undefined) {
    const name = safeGet(rec, 'name');
    out.name = typeof name === 'string' ? name : 'Error';

    const message = safeGet(rec, 'message');
    out.message = typeof message === 'string' ? message : safeString(err);

    const stack = safeGet(rec, 'stack');
    if (typeof stack === 'string') out.stack = stack;

    const code = safeGet(rec, 'code');
    if (typeof code === 'string') out.code = code;

    const rawCode = safeGet(rec, 'rawCode');
    if (rawCode !== undefined && rawCode !== UNREADABLE) out.rawCode = rawCode;
  } else if (typeof err === 'string') {
    out.name = 'Error';
    out.message = err;
  } else {
    out.name = 'NonError';
    out.message = safeString(err);
  }

  return out;
}

/**
 * Rebuild a live `Error` in the current realm from a {@link SerializedDriverError}.
 *
 * Restores `name`, `code` and `rawCode` so the `errors.ts` duck-type predicates
 * classify the revived error EXACTLY as they classify the native one
 * (ADR-0012 §5 — see the predicate-parity spec). `callSiteStack`, the
 * main-thread stack captured at the proxy call site, is APPENDED to the
 * worker-realm stack: the worker frame explains what failed, the call-site
 * frame explains who asked.
 */
export function reviveDriverError(e: SerializedDriverError, callSiteStack?: string): Error {
  const err = new Error(e.message);
  err.name = e.name;

  const carrier = err as Error & { code?: string; rawCode?: unknown };
  if (e.code !== undefined) carrier.code = e.code;
  if (e.rawCode !== undefined) carrier.rawCode = e.rawCode;

  const parts: string[] = [];
  if (e.stack !== undefined) parts.push(e.stack);
  if (callSiteStack !== undefined) parts.push(callSiteStack);
  if (parts.length > 0) err.stack = parts.join('\n');

  return err;
}

/**
 * Re-materialize a structured-clone-survived driver value as a plain JS value.
 *
 * Structured clone delivers a `Uint8Array` for every BLOB and preserves
 * `bigint` exactly — so the only transformation needed is `Uint8Array` →
 * `Buffer`. That conversion is ZERO-COPY (`Buffer.from(arrayBuffer, offset,
 * length)` shares the clone's backing store, so no byte is copied), and this
 * walks rows (objects) and result arrays recursively. Non-`Uint8Array` values —
 * including a `bigint` `lastInsertRowid` — pass through untouched, already-
 * `Buffer` values are returned by identity, and `Date`/`Map`/`Set`/`RegExp`
 * and other non-plain objects are left as-is rather than flattened.
 */
export function reviveBuffers<T>(value: T): T {
  return reviveBuffersValue(value) as T;
}

function reviveBuffersValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;

  // Already a Node Buffer — the common case on the main thread, and re-wrapping
  // would still be zero-copy but pointless. Return by identity.
  if (Buffer.isBuffer(value)) return value;

  if (value instanceof Uint8Array) {
    // Zero-copy: the returned Buffer is a view over the exact same ArrayBuffer
    // window the structured clone produced (byteOffset/byteLength preserved).
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }

  if (Array.isArray(value)) return value.map(reviveBuffersValue);

  // Leave non-plain objects (Date, Map, Set, RegExp, other typed arrays)
  // untouched — a row's columns are plain data, and flattening a Date would be
  // a silent corruption.
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = reviveBuffersValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }

  return value;
}

/** True only for `{}`/`Object.create(null)` objects (never class instances). */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === null || proto === Object.prototype;
}

/**
 * Assert that a connection's `opts` (the `opts` field of a `DriverRequest.open`)
 * can be carried across the worker boundary by structured clone.
 *
 * `structuredClone` silently DROPS, or outright throws on, a function or symbol
 * property — either way the worker would receive options the main thread never
 * intended (e.g. an `onOpStart` hook that never fires). Fail fast on the main
 * thread instead, naming the offending key so the caller can see exactly which
 * option is not serializable.
 *
 * Recurses through nested plain objects, arrays, `Map`s and `Set`s (cycle-safe)
 * so a hook buried in a nested option is caught too; typed arrays, `Buffer`s,
 * `Date`, `RegExp` and `bigint` are all cloneable and pass through untouched.
 */
export function assertCloneableOpts(opts: Record<string, unknown>): void {
  const seen = new WeakSet<object>();
  for (const key of Object.keys(opts)) {
    assertCloneableValue(opts[key], key, seen);
  }
}

function assertCloneableValue(value: unknown, path: string, seen: WeakSet<object>): void {
  const t = typeof value;
  if (t === 'function' || t === 'symbol') {
    throw new Error(
      `assertCloneableOpts: option "${path}" is not structured-cloneable — a ${t} cannot cross ` +
        `the Turso driver worker boundary (structuredClone would drop or reject it). ` +
        `Pass the value itself, or move the hook to the main-thread caller.`,
    );
  }

  if (value === null || t !== 'object') return;

  const obj = value as object;
  // Cloneable leaves that must never be walked into.
  if (
    Buffer.isBuffer(obj) ||
    ArrayBuffer.isView(obj) ||
    obj instanceof ArrayBuffer ||
    obj instanceof Date ||
    obj instanceof RegExp
  ) {
    return;
  }

  if (seen.has(obj)) return; // cycle-safe
  seen.add(obj);

  if (Array.isArray(obj)) {
    obj.forEach((item, i) => assertCloneableValue(item, `${path}[${i}]`, seen));
    return;
  }

  if (obj instanceof Map) {
    let i = 0;
    for (const [k, v] of obj) {
      assertCloneableValue(k, `${path}<key:${i}>`, seen);
      assertCloneableValue(v, `${path}<value:${i}>`, seen);
      i += 1;
    }
    return;
  }

  if (obj instanceof Set) {
    let i = 0;
    for (const v of obj) {
      assertCloneableValue(v, `${path}<set:${i}>`, seen);
      i += 1;
    }
    return;
  }

  for (const key of Object.keys(obj as Record<string, unknown>)) {
    assertCloneableValue((obj as Record<string, unknown>)[key], `${path}.${key}`, seen);
  }
}
