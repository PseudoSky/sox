/**
 * trace.ts — trace-id propagation via AsyncLocalStorage.
 *
 * Migrated from `libs/memory-core/src/telemetry.ts` (BL-320) so there is one
 * ALS instance for the whole process rather than one per consuming package —
 * two independent ALS instances cannot see each other's context, which would
 * silently break trace-id propagation exactly at the memory-core /
 * sox-telemetry boundary this package exists to unify.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { monotonicFactory } from 'ulid';

const ulid = monotonicFactory();
const traceStorage = new AsyncLocalStorage<string>();

/** Mint a new correlation id (ulid — sortable, monotonic within a process). */
export function newTraceId(): string {
  return ulid();
}

/** The trace id of the currently active context, if any. */
export function currentTraceId(): string | undefined {
  return traceStorage.getStore();
}

/** The active trace id, or a freshly minted one if no context is active. */
export function traceIdOrNew(): string {
  return currentTraceId() ?? newTraceId();
}

/** Run `fn` with `traceId` as the active correlation id for every nested
 *  telemetry call made inside it (synchronously or via any awaited async
 *  continuation). */
export function withTrace<T>(traceId: string, fn: () => T): T {
  return traceStorage.run(traceId, fn);
}

/** Convenience: run `fn` under a freshly minted trace id, handing the id to `fn`. */
export function runWithNewTrace<T>(fn: (traceId: string) => T): T {
  const id = newTraceId();
  return traceStorage.run(id, () => fn(id));
}
