/**
 * libs/host-runtime/src/event-bus.ts — Host-side lifecycle event bus.
 *
 * Ported from the pre-nx host runtime.
 * [def:session-fixes] fireIsolated dispatch (DEFECT-1 closure) carried forward.
 *
 * All events fire through HookLoader.fireIsolated() — NOT the legacy fire().
 */

import type { HookLoader, HookContext } from './hook-loader.js';

export const LIFECYCLE_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'SessionEnd',
  'ScopePromotionProposed',
  'Stop',
] as const;

export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

export function isLifecycleEvent(s: string): s is LifecycleEvent {
  return (LIFECYCLE_EVENTS as readonly string[]).includes(s);
}

export type BusHandlerResult =
  | undefined
  | { id: string; error: unknown };

export type BusEmitResult = BusHandlerResult[];

export type LifecycleHandler = (ctx: HookContext) => void | Promise<void>;

export class HostEventBus {
  private readonly hookLoader: HookLoader;
  private readonly reactions = new Map<LifecycleEvent, Array<{ id: string; handler: LifecycleHandler }>>();
  private reactionCounter = 0;

  constructor(hookLoader: HookLoader) {
    this.hookLoader = hookLoader;
  }

  on(event: LifecycleEvent, handler: LifecycleHandler, id?: string): string {
    const reactionId = id ?? `reaction-${++this.reactionCounter}`;
    if (!this.reactions.has(event)) {
      this.reactions.set(event, []);
    }
    this.reactions.get(event)!.push({ id: reactionId, handler });
    return reactionId;
  }

  off(event: LifecycleEvent, id: string): boolean {
    const list = this.reactions.get(event);
    if (!list) return false;
    const before = list.length;
    const filtered = list.filter((r) => r.id !== id);
    this.reactions.set(event, filtered);
    return filtered.length < before;
  }

  /**
   * emit — dispatch through fireIsolated() [def:session-fixes].
   * A throwing participant never aborts the chain.
   */
  async emit(
    event: LifecycleEvent,
    partial: Omit<HookContext, 'event'>,
  ): Promise<BusEmitResult> {
    // Phase 1: HookLoader hooks through fireIsolated()
    const hookResults = await this.hookLoader.fireIsolated(event, partial);

    // Phase 2: direct reactions
    const reactionList = this.reactions.get(event) ?? [];
    const fullCtx: HookContext = { event, ...partial };
    const reactionResults: BusEmitResult = [];

    for (const { id, handler } of reactionList) {
      try {
        await handler(fullCtx);
        reactionResults.push(undefined);
      } catch (e) {
        reactionResults.push({ id, error: e });
      }
    }

    return [...hookResults, ...reactionResults];
  }

  reactionsFor(event: LifecycleEvent): string[] {
    return (this.reactions.get(event) ?? []).map((r) => r.id);
  }

  clearReactions(): void {
    this.reactions.clear();
  }
}

export function createEventBus(hookLoader: HookLoader): HostEventBus {
  return new HostEventBus(hookLoader);
}
