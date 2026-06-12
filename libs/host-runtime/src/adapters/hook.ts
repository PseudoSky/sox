/**
 * libs/host-runtime/src/adapters/hook.ts — Hook adapter.
 *
 * Enforcement level: SOFT — declaration + activation policy + audit log;
 * no OS isolation (shared address space) — see [dod.6].
 * [def:inproc-types] [inv:per-type] [ref:deny-by-default]
 *
 * At activation time, the declared permissions block is compiled into a
 * queryable Policy and attached to the handle. The fireIsolated dispatch
 * mechanism ([def:session-fixes] DEFECT-1 fix) is preserved unchanged on the
 * HookLoader — this adapter only extends the activation path, never the
 * dispatch/isolation logic. [inv:carry-fixes]
 */

import type { HookLoader, HookHandler } from '../hook-loader.js';
import type { PermissionsBlock } from '../supervisor.js';
import { compilePolicy } from '../policy.js';
import type { Policy } from '../policy.js';
import { makeInprocHandle } from '../audit-log.js';
import type { InprocPolicyHandle } from '../audit-log.js';

export interface HookAdapterOptions {
  key: string;
  entrypointPath: string;
  order?: number | undefined;
  permissions?: PermissionsBlock | undefined;
  hookLoader: HookLoader;
}

export interface HookAdapterHandle extends InprocPolicyHandle {
  key: string;
  registeredEvents: string[];
  permissions: PermissionsBlock | undefined;
  policy: Policy;
  type: 'hook';
}

export async function activateHook(opts: HookAdapterOptions): Promise<HookAdapterHandle> {
  const policy = compilePolicy(opts.permissions);

  if (opts.permissions) {
    console.log(
      `[hook-adapter] Activating "${opts.key}" — permissions declared (SOFT enforcement: policy attached, audit log active):`,
      JSON.stringify(opts.permissions),
    );
  } else {
    console.log(
      `[hook-adapter] Activating "${opts.key}" — no declared permissions (policy.enforced=false, unconstrained)`,
    );
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

  const policyHandle = makeInprocHandle(opts.key, 'hook', policy);

  return {
    key: opts.key,
    registeredEvents: events,
    permissions: opts.permissions,
    policy,
    type: 'hook',
    checkFs: policyHandle.checkFs.bind(policyHandle),
    checkSocket: policyHandle.checkSocket.bind(policyHandle),
    checkNetwork: policyHandle.checkNetwork.bind(policyHandle),
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
