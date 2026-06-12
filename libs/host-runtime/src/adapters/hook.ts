/**
 * libs/host-runtime/src/adapters/hook.ts — Hook adapter.
 * Ported from scripts/host/adapters/hook.ts. Imports adjusted for lib paths.
 */

import type { HookLoader, HookHandler } from '../hook-loader.js';
import type { PermissionsBlock } from '../supervisor.js';

export interface HookAdapterOptions {
  key: string;
  entrypointPath: string;
  order?: number | undefined;
  permissions?: PermissionsBlock | undefined;
  hookLoader: HookLoader;
}

export interface HookAdapterHandle {
  key: string;
  registeredEvents: string[];
  permissions: PermissionsBlock | undefined;
  type: 'hook';
}

export async function activateHook(opts: HookAdapterOptions): Promise<HookAdapterHandle> {
  if (opts.permissions) {
    console.log(
      `[hook-adapter] Activating "${opts.key}" — permissions declared (P4 record / P5 enforce):`,
      JSON.stringify(opts.permissions),
    );
  } else {
    console.log(`[hook-adapter] Activating "${opts.key}" — no declared permissions`);
  }

  const mod = await import(opts.entrypointPath) as Record<string, unknown>;

  const events = resolveEvents(mod, opts.key);

  if (events.length === 0) {
    throw new Error(
      `[hook-adapter] "${opts.key}": entrypoint exports neither 'event' nor 'events'. ` +
        `Hook modules must export 'export const event = "EventName"' or ` +
        `'export const events = ["EventA", "EventB"]'.`,
    );
  }

  const handler = resolveHandler(mod, opts.key);

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

function resolveEvents(mod: Record<string, unknown>, _key: string): string[] {
  if (Array.isArray(mod['events'])) {
    const evts = mod['events'] as unknown[];
    const strings = evts.filter((e): e is string => typeof e === 'string');
    if (strings.length > 0) return strings;
  }

  if (typeof mod['event'] === 'string' && mod['event'].length > 0) {
    return [mod['event']];
  }

  return [];
}

function resolveHandler(mod: Record<string, unknown>, key: string): HookHandler {
  if (typeof mod['handler'] === 'function') {
    return mod['handler'] as HookHandler;
  }

  if (typeof mod['default'] === 'function') {
    return mod['default'] as HookHandler;
  }

  throw new Error(
    `[hook-adapter] "${key}": entrypoint does not export a 'handler' function. ` +
      `Hook modules must export 'export function handler(ctx): void | Promise<void>'.`,
  );
}
