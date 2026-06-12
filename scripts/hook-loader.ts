/**
 * hook-loader.ts — Host-side hook registry with deterministic execution ordering.
 *
 * Gap 2 resolution (migration.md Section 5, Gap 2):
 *   When multiple hooks bind the SAME lifecycle event, they are sorted ascending
 *   by their integer `order` field (default 100), with ties broken by `id`
 *   lexicographic order.
 *
 * IMPORTANT: hooks should be order-independent where possible. The `order` field
 * is an escape hatch for edge cases — not a dependency mechanism. If your hook
 * only works after another hook has run, that is a design smell: prefer idempotent,
 * stateless hooks that compose cleanly regardless of execution sequence.
 *
 * Source: extension-type-taxonomy.md (hooks fire unconditionally);
 *         Gap 2 decision (suggestions #7, Conjecture on tie-break).
 */

export interface HookContext {
  event: string;
  timestamp: string;
  payload?: unknown;
}

export interface HookManifest {
  /** Unique extension id — used as tie-breaker when order values collide. */
  id: string;
  /** Lifecycle event this hook binds to (e.g. "PreToolUse", "PostToolUse"). */
  event: string;
  /**
   * Execution order for this hook within its lifecycle event (ascending).
   * Only meaningful when multiple hooks bind the same event.
   * Ties are broken by id lexicographic order.
   * Default: 100.
   * This is an ESCAPE HATCH — prefer order-independent hooks.
   */
  order?: number | undefined;
}

export type HookHandler = (ctx: HookContext) => void | Promise<void>;

export interface RegisteredHook {
  manifest: HookManifest;
  handler: HookHandler;
}

/**
 * Compare two registered hooks for sort order within the same lifecycle event.
 *
 * Primary key:  `order` ascending (lower = earlier). Missing order defaults to 100.
 * Secondary key: `id` lexicographic ascending (tie-breaker).
 */
export function compareHooks(a: RegisteredHook, b: RegisteredHook): number {
  const orderA = a.manifest.order ?? 100;
  const orderB = b.manifest.order ?? 100;

  if (orderA !== orderB) {
    return orderA - orderB;
  }

  // Tie-break by id lexicographic order
  return a.manifest.id < b.manifest.id ? -1 : a.manifest.id > b.manifest.id ? 1 : 0;
}

/**
 * HookLoader — registry that maps lifecycle event names → sorted hook arrays.
 *
 * Usage:
 *   const loader = new HookLoader();
 *   loader.register(manifest, handler);
 *   await loader.fire('PreToolUse', ctx);
 */
export class HookLoader {
  /** Map from lifecycle event name → hooks sorted by (order ASC, id ASC). */
  private readonly registry = new Map<string, RegisteredHook[]>();

  /**
   * Register a hook for its declared lifecycle event.
   * After registration the hook list for that event is re-sorted so insertion
   * order never matters — only `order` and `id` determine execution sequence.
   */
  register(manifest: HookManifest, handler: HookHandler): void {
    const event = manifest.event;
    if (!this.registry.has(event)) {
      this.registry.set(event, []);
    }

    const hooks = this.registry.get(event)!;
    hooks.push({ manifest, handler });

    // Re-sort after each registration so the list is always in canonical order.
    // O(n log n) per registration — acceptable for small hook counts (<100).
    hooks.sort(compareHooks);
  }

  /**
   * Return the ordered hook list for a lifecycle event (ascending order).
   * Returns an empty array if no hooks are registered for the event.
   * The returned array is a COPY — callers must not mutate it.
   */
  hooksFor(event: string): ReadonlyArray<RegisteredHook> {
    return [...(this.registry.get(event) ?? [])];
  }

  /**
   * Fire all hooks bound to `event` in sorted order (order ASC, id ASC).
   * Each hook executes sequentially (awaited). A hook throwing causes the
   * sequence to abort — callers should wrap in try/catch if isolation is needed.
   *
   * Back-compat: semantics unchanged. Use `fireIsolated()` when one hook must
   * not prevent later hooks from executing.
   */
  async fire(event: string, ctx: Omit<HookContext, 'event'>): Promise<void> {
    const hooks = this.hooksFor(event);
    const fullCtx: HookContext = { event, ...ctx };

    for (const hook of hooks) {
      await hook.handler(fullCtx);
    }
  }

  /**
   * Fire all hooks bound to `event` with per-hook error isolation.
   *
   * Unlike `fire()`, a throwing hook does NOT abort the chain — the error is
   * caught, recorded in the result array, and execution continues with the next
   * hook. This closes DEFECT-1 (docs/engine-defects-found.md): a single buggy
   * hook can no longer silently suppress all later hooks in the same event.
   *
   * Returns a result array, one entry per registered hook (in execution order):
   *   - `undefined`           — hook completed successfully
   *   - `{ id, error }`       — hook threw; `id` is the hook's manifest id
   *
   * Callers may inspect the results to surface or aggregate hook errors without
   * losing subsequent hook execution.
   */
  async fireIsolated(
    event: string,
    ctx: Omit<HookContext, 'event'>,
  ): Promise<Array<{ id: string; error: unknown } | undefined>> {
    const hooks = this.hooksFor(event);
    const fullCtx: HookContext = { event, ...ctx };
    const results: Array<{ id: string; error: unknown } | undefined> = [];

    for (const hook of hooks) {
      try {
        await hook.handler(fullCtx);
        results.push(undefined);
      } catch (e) {
        results.push({ id: hook.manifest.id, error: e });
        // Continue to next hook regardless of this one's failure
      }
    }

    return results;
  }

  /**
   * Return the ids of hooks bound to `event` in execution order.
   * Convenience helper used by tests to assert ordering without running handlers.
   */
  orderedIdsFor(event: string): string[] {
    return this.hooksFor(event).map((h) => h.manifest.id);
  }

  /** Clear all registered hooks. */
  clear(): void {
    this.registry.clear();
  }
}
