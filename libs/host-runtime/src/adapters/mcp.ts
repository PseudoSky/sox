/**
 * libs/host-runtime/src/adapters/mcp.ts — MCP-server adapter.
 * Ported from the pre-nx host runtime. Imports adjusted for lib paths.
 */

import { ProcessSupervisor, type LifecycleBlock, type PermissionsBlock } from '../supervisor.js';

export interface McpAdapterOptions {
  key: string;
  entrypointPath: string;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  lifecycle: LifecycleBlock;
  permissions?: PermissionsBlock | undefined;
  onRestart?: ((n: number) => void) | undefined;
}

export interface McpAdapterHandle {
  key: string;
  supervisor: ProcessSupervisor;
  permissions: PermissionsBlock | undefined;
  type: 'mcp-server';
}

export async function activateMcp(opts: McpAdapterOptions): Promise<McpAdapterHandle> {
  if (opts.permissions) {
    console.log(
      `[mcp-adapter] Activating "${opts.key}" — permissions declared (P4 record / P5 enforce):`,
      JSON.stringify(opts.permissions),
    );
  } else {
    console.log(`[mcp-adapter] Activating "${opts.key}" — no declared permissions`);
  }

  const lifecycle = opts.lifecycle;

  if (lifecycle.background) {
    const supervisor = new ProcessSupervisor({
      key: opts.key,
      entrypointPath: opts.entrypointPath,
      args: opts.args ?? [],
      env: opts.env,
      lifecycle,
      permissions: opts.permissions,
      onRestart: opts.onRestart,
    });

    await supervisor.start();
    console.log(`[mcp-adapter] "${opts.key}" started (pid=${String(supervisor.pid())})`);

    return {
      key: opts.key,
      supervisor,
      permissions: opts.permissions,
      type: 'mcp-server',
    };
  }

  console.log(
    `[mcp-adapter] "${opts.key}" is non-background — will be loaded in-process by registrar (P5)`,
  );

  const supervisor = new ProcessSupervisor({
    key: opts.key,
    entrypointPath: opts.entrypointPath,
    args: opts.args ?? [],
    env: opts.env,
    lifecycle: { ...lifecycle },
    permissions: opts.permissions,
  });

  return {
    key: opts.key,
    supervisor,
    permissions: opts.permissions,
    type: 'mcp-server',
  };
}
