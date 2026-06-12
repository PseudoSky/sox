/**
 * scripts/host/adapters/hook.ts — Hook adapter.
 *
 * Adapter for type === 'hook'. Dynamically imports the built entrypoint and
 * registers the exported handler(s) into the provided HookLoader.
 *
 * Hook module contract (two shapes, both supported):
 *   Shape A — single event:
 *     export const event = 'PreToolUse';
 *     export function handler(ctx): void | Promise<void>
 *
 *   Shape B — multiple events:
 *     export const events = ['SessionEnd', 'ScopePromotionProposed'];
 *     export function handler(ctx): void | Promise<void>
 *
 * Both shapes observed in the current hook tenants:
 *   audit-hook  → Shape A (export const event, export function handler)
 *   memory-flush → Shape B (export const events, export function handler)
 *
 * Permission recording: permissions{} is logged at activation (enforcement is P5).
 */

import type { HookLoader, HookHandler } from '../../hook-loader.js';
import type { PermissionsBlock } from '../supervisor.js';

export interface HookAdapterOptions {
  /** Unique key (id@version). */
  key: string;
  /** Absolute path to the BUILT entrypoint (.js). */
  entrypointPath: string;
  /** Hook execution order (from manifest.order, default 100). */
  order?: number | undefined;
  permissions?: PermissionsBlock | undefined;
  /** The HookLoader instance to register into. */
  hookLoader: HookLoader;
}

export interface HookAdapterHandle {
  key: string;
  registeredEvents: string[];
  permissions: PermissionsBlock | undefined;
  type: 'hook';
}

/**
 * Activate a hook extension.
 *
 * Dynamically imports the built entrypoint, inspects exported event binding(s),
 * and registers the handler into the HookLoader for each declared event.
 *
 * Returns a handle describing the registered events for lifecycle management.
 */
export async function activateHook(opts: HookAdapterOptions): Promise<HookAdapterHandle> {
  // P4: record permissions at activation (enforcement is P5 scope)
  if (opts.permissions) {
    console.log(
      `[hook-adapter] Activating "${opts.key}" — permissions declared (P4 record / P5 enforce):`,
      JSON.stringify(opts.permissions),
    );
  } else {
    console.log(`[hook-adapter] Activating "${opts.key}" — no declared permissions`);
  }

  // Dynamic import of the built .js entrypoint (never the .ts source — P0 contract)
  const mod = await import(opts.entrypointPath) as Record<string, unknown>;

  // Resolve the event binding(s) from the module
  const events = resolveEvents(mod, opts.key);

  if (events.length === 0) {
    throw new Error(
      `[hook-adapter] "${opts.key}": entrypoint exports neither 'event' nor 'events'. ` +
        `Hook modules must export 'export const event = "EventName"' or ` +
        `'export const events = ["EventA", "EventB"]'.`,
    );
  }

  // Resolve the handler
  const handler = resolveHandler(mod, opts.key);

  // Register into the HookLoader for each declared event
  for (const eventName of events) {
    opts.hookLoader.register(
      {
        id: opts.key,
        event: eventName,
        order: opts.order ?? 100,
      },
      handler,
    );
    console.log(`[hook-adapter] "${opts.key}" registered for event "${eventName}"`);
  }

  return {
    key: opts.key,
    registeredEvents: events,
    permissions: opts.permissions,
    type: 'hook',
  };
}

// ─── Module shape resolution ──────────────────────────────────────────────────

function resolveEvents(mod: Record<string, unknown>, _key: string): string[] {
  // Shape B: export const events = [...]
  if (Array.isArray(mod['events'])) {
    const evts = mod['events'] as unknown[];
    const strings = evts.filter((e): e is string => typeof e === 'string');
    if (strings.length > 0) return strings;
  }

  // Shape A: export const event = 'EventName'
  if (typeof mod['event'] === 'string' && mod['event'].length > 0) {
    return [mod['event']];
  }

  return [];
}

function resolveHandler(mod: Record<string, unknown>, key: string): HookHandler {
  if (typeof mod['handler'] === 'function') {
    return mod['handler'] as HookHandler;
  }

  // Some hooks may export a default function
  if (typeof mod['default'] === 'function') {
    return mod['default'] as HookHandler;
  }

  throw new Error(
    `[hook-adapter] "${key}": entrypoint does not export a 'handler' function. ` +
      `Hook modules must export 'export function handler(ctx): void | Promise<void>'.`,
  );
}
