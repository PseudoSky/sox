/**
 * scripts/host/event-bus.ts — Host-side lifecycle event bus.
 *
 * CONTRACT GAP CLOSED (analysis.md row #12 — "event/lifecycle signal → reaction"):
 *   Provides the host event bus that fires lifecycle signals through `fireIsolated()`
 *   so a throwing hook never suppresses downstream reactions (DEFECT-1 fix from PA).
 *
 * This module is the AUTHORITATIVE owner of the closed lifecycle event vocabulary —
 * the same enum that `schemas/extension/v1.json` uses to validate hook `events` fields.
 *
 * Dispatch contract:
 *   - All events fire through `HookLoader.fireIsolated()` — NOT the legacy `fire()`.
 *   - `fire()` is kept for back-compat in hook-loader.ts but is NOT the bus's call site.
 *   - A throwing hook does NOT abort the chain; its error is collected and returned.
 *
 * Reaction registration:
 *   - mcp/agent/skill/command may call `bus.on(event, handler)` to register a reaction.
 *   - Hooks registered via the HookLoader (P4 hook adapter) are fired automatically.
 *   - The bus composes both registration paths into a single `emit()` call.
 *
 * Usage:
 *   const bus = new HostEventBus(hookLoader);
 *   bus.on('SessionEnd', async (ctx) => { ... });
 *   const results = await bus.emit('SessionEnd', { timestamp: new Date().toISOString() });
 *   // results[i] === undefined → hook/handler i succeeded
 *   // results[i] === { id, error } → hook/handler i threw (others still ran)
 */

import type { HookLoader, HookContext } from '../hook-loader.js';

// ─── Closed event vocabulary ──────────────────────────────────────────────────

/**
 * The closed set of host lifecycle event names.
 *
 * These are the only events the host bus recognises — matching the `enum` in
 * `schemas/extension/v1.json` (hook `events` field, added by P2). Adding a new
 * lifecycle event requires updating BOTH this tuple AND the schema enum.
 *
 * Current vocabulary (seeded from usage: audit-hook → PreToolUse; memory-flush →
 * SessionEnd + ScopePromotionProposed):
 *   PreToolUse            — fires before any tool call executes
 *   PostToolUse           — fires after a tool call completes (success or error)
 *   SessionEnd            — fires when the host session is shutting down
 *   ScopePromotionProposed — fires when an extension proposes a scope promotion
 *   Stop                  — fires when the host requests an extension to halt
 */
export const LIFECYCLE_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'SessionEnd',
  'ScopePromotionProposed',
  'Stop',
] as const;

/** Union type for all valid lifecycle event names. */
export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

/**
 * Type guard: returns true if `s` is a valid lifecycle event name.
 */
export function isLifecycleEvent(s: string): s is LifecycleEvent {
  return (LIFECYCLE_EVENTS as readonly string[]).includes(s);
}

// ─── Result types ─────────────────────────────────────────────────────────────

/** A handler result for a single bus participant on one event emit. */
export type BusHandlerResult =
  | undefined                          // success
  | { id: string; error: unknown };    // failure (handler threw)

/** The result array returned by `bus.emit()` — one entry per participant. */
export type BusEmitResult = BusHandlerResult[];

// ─── Handler type ─────────────────────────────────────────────────────────────

/** A lifecycle event reaction registered by mcp/agent/skill/command. */
export type LifecycleHandler = (ctx: HookContext) => void | Promise<void>;

// ─── HostEventBus ─────────────────────────────────────────────────────────────

/**
 * HostEventBus — composes the HookLoader registry with directly-registered
 * reactions (from mcp/agent/skill/command) and dispatches all participants
 * through `fireIsolated()`.
 *
 * Participants are fired in two groups (in order):
 *   1. HookLoader hooks (sorted by order ASC, id ASC — deterministic P4 ordering).
 *   2. Directly-registered handlers (via `on()`), in registration order.
 *
 * A throwing participant never aborts the chain — each is isolated.
 */
export class HostEventBus {
  /** The hook registry (populated by the P4 hook adapter). */
  private readonly hookLoader: HookLoader;

  /**
   * Directly-registered reactions keyed by event name.
   * Used by mcp/agent/skill/command callers (unlike hooks, these are not manifest-driven).
   */
  private readonly reactions = new Map<LifecycleEvent, Array<{ id: string; handler: LifecycleHandler }>>();

  /** Monotonically-increasing counter for auto-generating reaction ids. */
  private reactionCounter = 0;

  constructor(hookLoader: HookLoader) {
    this.hookLoader = hookLoader;
  }

  /**
   * Register a direct reaction for `event`.
   *
   * For mcp/agent/skill/command subsystems that need to react to lifecycle
   * events without going through the manifest-driven HookLoader path.
   *
   * Returns a unique reaction id that can be used with `off()` to deregister.
   *
   * @param event  — must be a valid LifecycleEvent (type-checked at compile time)
   * @param handler — called on each `emit()` for this event
   * @param id      — optional stable id; auto-generated if absent
   */
  on(event: LifecycleEvent, handler: LifecycleHandler, id?: string): string {
    const reactionId = id ?? `reaction-${++this.reactionCounter}`;
    if (!this.reactions.has(event)) {
      this.reactions.set(event, []);
    }
    this.reactions.get(event)!.push({ id: reactionId, handler });
    return reactionId;
  }

  /**
   * Deregister a reaction by its id.
   * Returns true if the reaction was found and removed, false otherwise.
   */
  off(event: LifecycleEvent, id: string): boolean {
    const list = this.reactions.get(event);
    if (!list) return false;
    const before = list.length;
    const filtered = list.filter((r) => r.id !== id);
    this.reactions.set(event, filtered);
    return filtered.length < before;
  }

  /**
   * Emit a lifecycle event — fires ALL participants through `fireIsolated()`.
   *
   * Dispatch order:
   *   1. HookLoader hooks for `event` (sorted by order ASC, id ASC).
   *   2. Directly-registered reactions (via `on()`) in registration order.
   *
   * Each participant is independently isolated — a throw is caught, recorded in
   * the result array, and execution continues with the next participant. This
   * closes DEFECT-1 (docs/engine-defects-found.md) at the bus level: the bus
   * ONLY dispatches through `fireIsolated()`, never through the abort-on-throw
   * `fire()` path.
   *
   * @param event   — must be a valid LifecycleEvent
   * @param partial — the rest of HookContext (event name is injected by the bus)
   * @returns per-participant result array (undefined = success, {id, error} = failure)
   */
  async emit(
    event: LifecycleEvent,
    partial: Omit<HookContext, 'event'>,
  ): Promise<BusEmitResult> {
    // Phase 1: fire hooks through HookLoader.fireIsolated() (the PA-delivered call site)
    const hookResults = await this.hookLoader.fireIsolated(event, partial);

    // Phase 2: fire directly-registered reactions (mcp/agent/skill/command)
    const reactionList = this.reactions.get(event) ?? [];
    const fullCtx: HookContext = { event, ...partial };
    const reactionResults: BusEmitResult = [];

    for (const { id, handler } of reactionList) {
      try {
        await handler(fullCtx);
        reactionResults.push(undefined);
      } catch (e) {
        reactionResults.push({ id, error: e });
        // Continue to next reaction regardless — isolation guarantee
      }
    }

    return [...hookResults, ...reactionResults];
  }

  /**
   * Return the reaction ids registered for `event` (in registration order).
   * Convenience helper for tests and diagnostics.
   */
  reactionsFor(event: LifecycleEvent): string[] {
    return (this.reactions.get(event) ?? []).map((r) => r.id);
  }

  /**
   * Clear all directly-registered reactions.
   * Does NOT affect HookLoader state (that is managed by the loader/adapter layer).
   */
  clearReactions(): void {
    this.reactions.clear();
  }
}

// ─── Module-level convenience factory ────────────────────────────────────────

/**
 * Create a HostEventBus backed by the given HookLoader.
 *
 * Convenience wrapper for callers that do not want to `new HostEventBus(...)`.
 */
export function createEventBus(hookLoader: HookLoader): HostEventBus {
  return new HostEventBus(hookLoader);
}
