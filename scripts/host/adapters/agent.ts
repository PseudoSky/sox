/**
 * scripts/host/adapters/agent.ts — Agent and skill in-process adapter.
 *
 * Adapters for type === 'agent' and type === 'skill'.
 * Dynamically imports the built entrypoint and exposes it for in-process invocation.
 *
 * Agent module contract (observed in tenants):
 *   export const name: string
 *   export const description: string
 *   export const tools: Tool[]   (optional — echo-agent shape)
 *   export const systemPrompt: string (optional)
 *   async function invoke?(input): output  (future standardized invoke)
 *
 * Skill module contract (observed in tenants):
 *   export async function run(input: SkillInput): Promise<SkillOutput>
 *
 * P4 scope: load, record permissions, expose invoke/run callsite.
 * P5 scope: full delivery to the agent surface (invoker + renderer).
 *
 * Permission recording: permissions{} is logged at activation (enforcement is P5).
 */

import type { PermissionsBlock } from '../supervisor.js';

// ─── Agent adapter ────────────────────────────────────────────────────────────

export interface AgentAdapterOptions {
  key: string;
  entrypointPath: string;
  permissions?: PermissionsBlock | undefined;
}

export interface AgentAdapterHandle {
  key: string;
  /** The loaded module — direct access for P5 invoker. */
  module: Record<string, unknown>;
  permissions: PermissionsBlock | undefined;
  type: 'agent';
  /**
   * Invoke the agent with an input object.
   * Tries: module.invoke → module.run → module.execute → error.
   * P5 will standardize this into a typed invoker protocol.
   */
  invoke(input: Record<string, unknown>): Promise<unknown>;
}

export async function activateAgent(opts: AgentAdapterOptions): Promise<AgentAdapterHandle> {
  if (opts.permissions) {
    console.log(
      `[agent-adapter] Activating "${opts.key}" — permissions declared (P4 record / P5 enforce):`,
      JSON.stringify(opts.permissions),
    );
  } else {
    console.log(`[agent-adapter] Activating "${opts.key}" — no declared permissions`);
  }

  const mod = await import(opts.entrypointPath) as Record<string, unknown>;

  // Validate that the module has something invokable
  const invokeFn = resolveInvokeFn(mod);
  if (!invokeFn) {
    console.warn(
      `[agent-adapter] "${opts.key}": no standard invoke/run/execute export found. ` +
        `The agent will be loaded but may not be invokable until P5 standardization.`,
    );
  }

  const invoke = async (input: Record<string, unknown>): Promise<unknown> => {
    if (!invokeFn) {
      throw new Error(
        `[agent-adapter] "${opts.key}": no invokable export (tried invoke/run/execute). ` +
          `Ensure the agent module exports one of these functions.`,
      );
    }
    return invokeFn(input);
  };

  return {
    key: opts.key,
    module: mod,
    permissions: opts.permissions,
    type: 'agent',
    invoke,
  };
}

function resolveInvokeFn(mod: Record<string, unknown>): ((input: unknown) => Promise<unknown>) | null {
  for (const name of ['invoke', 'run', 'execute']) {
    if (typeof mod[name] === 'function') {
      return mod[name] as (input: unknown) => Promise<unknown>;
    }
  }
  return null;
}

// ─── Skill adapter ────────────────────────────────────────────────────────────

export interface SkillAdapterOptions {
  key: string;
  entrypointPath: string;
  permissions?: PermissionsBlock | undefined;
}

export interface SkillAdapterHandle {
  key: string;
  module: Record<string, unknown>;
  permissions: PermissionsBlock | undefined;
  type: 'skill';
  /**
   * Run the skill with an input object.
   * Skill contract: export async function run(input): Promise<output>.
   */
  run(input: Record<string, unknown>): Promise<unknown>;
}

export async function activateSkill(opts: SkillAdapterOptions): Promise<SkillAdapterHandle> {
  if (opts.permissions) {
    console.log(
      `[skill-adapter] Activating "${opts.key}" — permissions declared (P4 record / P5 enforce):`,
      JSON.stringify(opts.permissions),
    );
  } else {
    console.log(`[skill-adapter] Activating "${opts.key}" — no declared permissions`);
  }

  const mod = await import(opts.entrypointPath) as Record<string, unknown>;

  if (typeof mod['run'] !== 'function') {
    throw new Error(
      `[skill-adapter] "${opts.key}": entrypoint does not export a 'run' function. ` +
        `Skill modules must export 'export async function run(input): Promise<output>'.`,
    );
  }

  const runFn = mod['run'] as (input: unknown) => Promise<unknown>;

  return {
    key: opts.key,
    module: mod,
    permissions: opts.permissions,
    type: 'skill',
    run: (input) => runFn(input),
  };
}
