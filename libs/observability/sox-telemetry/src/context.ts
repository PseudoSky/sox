/**
 * context.ts — c536ce29 L1: async log context (correlation ids).
 *
 * The AsyncLocalStorage instance lives on a `globalThis` slot keyed by
 * `Symbol.for('@adhd/sox-telemetry/log-context')` (ADR-0018), never module-local:
 * duplicate installed copies of this package in one realm then share ONE
 * context. A pre-existing slot object created by an older copy (without the
 * `als` field) is accepted and lazily extended in place, never replaced.
 * Nothing here reads an environment variable and nothing throws into the caller
 * (apart from whatever `fn` itself throws).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** Flat correlation ids merged into every channel record. */
export interface LogContext {
  [key: string]: string | number | boolean | null | undefined;
}

/** The `globalThis` key of the shared log-context slot (semver-stable contract). */
const LOG_CONTEXT_SLOT_KEY: symbol = Symbol.for('@adhd/sox-telemetry/log-context');

interface LogContextSlot {
  als?: AsyncLocalStorage<Readonly<LogContext>>;
  [key: string]: unknown;
}

const EMPTY: Readonly<LogContext> = Object.freeze({});
/** Used only if the shared slot cannot be created or extended (frozen / hostile global). */
let fallbackAls: AsyncLocalStorage<Readonly<LogContext>> | undefined;

function isAls(v: unknown): v is AsyncLocalStorage<Readonly<LogContext>> {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { run?: unknown }).run === 'function' &&
    typeof (v as { getStore?: unknown }).getStore === 'function'
  );
}

function localAls(): AsyncLocalStorage<Readonly<LogContext>> {
  fallbackAls ??= new AsyncLocalStorage<Readonly<LogContext>>();
  return fallbackAls;
}

/** Resolve (creating / extending as needed) the shared ALS. Never throws. */
function sharedAls(): AsyncLocalStorage<Readonly<LogContext>> {
  try {
    const g = globalThis as unknown as Record<symbol, unknown>;
    let slot = g[LOG_CONTEXT_SLOT_KEY];
    if (typeof slot !== 'object' || slot === null) {
      slot = {};
      g[LOG_CONTEXT_SLOT_KEY] = slot;
    }
    const s = slot as LogContextSlot;
    if (!isAls(s.als)) s.als = new AsyncLocalStorage<Readonly<LogContext>>();
    return isAls(s.als) ? s.als : localAls();
  } catch {
    return localAls();
  }
}

/**
 * Run `fn` with `ctx` merged over the current context (child keys win;
 * a key set to `undefined` unsets the inherited value).
 */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  let als: AsyncLocalStorage<Readonly<LogContext>>;
  let merged: Readonly<LogContext>;
  try {
    als = sharedAls();
    const out: LogContext = { ...(als.getStore() ?? EMPTY), ...ctx };
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    merged = Object.freeze(out);
  } catch {
    return fn();
  }
  return als.run(merged, fn);
}

/** The merged context of the current async scope; empty (frozen) outside any scope. */
export function currentLogContext(): Readonly<LogContext> {
  try {
    return sharedAls().getStore() ?? EMPTY;
  } catch {
    return EMPTY;
  }
}
