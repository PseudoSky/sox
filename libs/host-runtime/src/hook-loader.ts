/**
 * libs/host-runtime/src/hook-loader.ts — Host-side hook registry
 *
 * Ported from scripts/hook-loader.ts. Logic unchanged.
 * [def:session-fixes] fireIsolated carried forward (DEFECT-1 fix from PA).
 */

export interface HookContext {
  event: string;
  timestamp: string;
  payload?: unknown;
}

export interface HookManifest {
  id: string;
  event: string;
  order?: number | undefined;
}

export type HookHandler = (ctx: HookContext) => void | Promise<void>;

export interface RegisteredHook {
  manifest: HookManifest;
  handler: HookHandler;
}

export function compareHooks(a: RegisteredHook, b: RegisteredHook): number {
  const orderA = a.manifest.order ?? 100;
  const orderB = b.manifest.order ?? 100;

  if (orderA !== orderB) {
    return orderA - orderB;
  }

  return a.manifest.id < b.manifest.id ? -1 : a.manifest.id > b.manifest.id ? 1 : 0;
}

export class HookLoader {
  private readonly registry = new Map<string, RegisteredHook[]>();

  register(manifest: HookManifest, handler: HookHandler): void {
    const event = manifest.event;
    if (!this.registry.has(event)) {
      this.registry.set(event, []);
    }

    const hooks = this.registry.get(event)!;
    hooks.push({ manifest, handler });
    hooks.sort(compareHooks);
  }

  hooksFor(event: string): ReadonlyArray<RegisteredHook> {
    return [...(this.registry.get(event) ?? [])];
  }

  async fire(event: string, ctx: Omit<HookContext, 'event'>): Promise<void> {
    const hooks = this.hooksFor(event);
    const fullCtx: HookContext = { event, ...ctx };

    for (const hook of hooks) {
      await hook.handler(fullCtx);
    }
  }

  /**
   * fireIsolated — [def:session-fixes] DEFECT-1 fix.
   *
   * A throwing hook does NOT abort the chain — the error is caught, recorded in
   * the result array, and execution continues with the next hook.
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
      }
    }

    return results;
  }

  orderedIdsFor(event: string): string[] {
    return this.hooksFor(event).map((h) => h.manifest.id);
  }

  clear(): void {
    this.registry.clear();
  }
}
