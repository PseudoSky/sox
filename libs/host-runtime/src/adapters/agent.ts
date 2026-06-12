/**
 * libs/host-runtime/src/adapters/agent.ts — Agent and skill in-process adapter.
 *
 * Enforcement level: SOFT — declaration + activation policy + audit log;
 * no OS isolation (shared address space) — see [dod.6].
 * [def:inproc-types] [inv:per-type] [ref:deny-by-default]
 *
 * At activation time, the declared permissions block is compiled into a
 * queryable Policy and attached to the handle. Callers may use the handle's
 * checkFs/checkSocket/checkNetwork methods (from InprocPolicyHandle) to make
 * policy-checked, audit-logged access decisions. No hard OS enforcement is
 * possible for in-process imports (shared address space, [dod.6]).
 */

import type { PermissionsBlock } from '../supervisor.js';
import { compilePolicy } from '../policy.js';
import type { Policy } from '../policy.js';
import { makeInprocHandle } from '../audit-log.js';
import type { InprocPolicyHandle } from '../audit-log.js';

export interface AgentAdapterOptions {
  key: string;
  entrypointPath: string;
  permissions?: PermissionsBlock | undefined;
}

export interface AgentAdapterHandle extends InprocPolicyHandle {
  key: string;
  module: Record<string, unknown>;
  permissions: PermissionsBlock | undefined;
  policy: Policy;
  type: 'agent';
  invoke(input: Record<string, unknown>): Promise<unknown>;
}

export async function activateAgent(opts: AgentAdapterOptions): Promise<AgentAdapterHandle> {
  const policy = compilePolicy(opts.permissions);

  if (opts.permissions) {
    console.log(
      `[agent-adapter] Activating "${opts.key}" — permissions declared (SOFT enforcement: policy attached, audit log active):`,
      JSON.stringify(opts.permissions),
    );
  } else {
    console.log(
      `[agent-adapter] Activating "${opts.key}" — no declared permissions (policy.enforced=false, unconstrained)`,
    );
  }

  const mod = await import(opts.entrypointPath) as Record<string, unknown>;

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

  const policyHandle = makeInprocHandle(opts.key, 'agent', policy);

  return {
    key: opts.key,
    module: mod,
    permissions: opts.permissions,
    policy,
    type: 'agent',
    invoke,
    checkFs: policyHandle.checkFs.bind(policyHandle),
    checkSocket: policyHandle.checkSocket.bind(policyHandle),
    checkNetwork: policyHandle.checkNetwork.bind(policyHandle),
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

export interface SkillAdapterOptions {
  key: string;
  entrypointPath: string;
  permissions?: PermissionsBlock | undefined;
}

export interface SkillAdapterHandle extends InprocPolicyHandle {
  key: string;
  module: Record<string, unknown>;
  permissions: PermissionsBlock | undefined;
  policy: Policy;
  type: 'skill';
  run(input: Record<string, unknown>): Promise<unknown>;
}

export async function activateSkill(opts: SkillAdapterOptions): Promise<SkillAdapterHandle> {
  const policy = compilePolicy(opts.permissions);

  if (opts.permissions) {
    console.log(
      `[skill-adapter] Activating "${opts.key}" — permissions declared (SOFT enforcement: policy attached, audit log active):`,
      JSON.stringify(opts.permissions),
    );
  } else {
    console.log(
      `[skill-adapter] Activating "${opts.key}" — no declared permissions (policy.enforced=false, unconstrained)`,
    );
  }

  const mod = await import(opts.entrypointPath) as Record<string, unknown>;

  if (typeof mod['run'] !== 'function') {
    throw new Error(
      `[skill-adapter] "${opts.key}": entrypoint does not export a 'run' function. ` +
        `Skill modules must export 'export async function run(input): Promise<output>'.`,
    );
  }

  const runFn = mod['run'] as (input: unknown) => Promise<unknown>;

  const policyHandle = makeInprocHandle(opts.key, 'skill', policy);

  return {
    key: opts.key,
    module: mod,
    permissions: opts.permissions,
    policy,
    type: 'skill',
    run: (input) => runFn(input),
    checkFs: policyHandle.checkFs.bind(policyHandle),
    checkSocket: policyHandle.checkSocket.bind(policyHandle),
    checkNetwork: policyHandle.checkNetwork.bind(policyHandle),
  };
}
