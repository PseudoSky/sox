/**
 * scripts/host/adapters/mcp.ts — MCP-server adapter.
 *
 * Adapter for type === 'mcp-server'. Spawns the built entrypoint as a
 * child process and supervises it per the extension's lifecycle{} block.
 *
 * P4 scope: spawn + supervision + health probe. The registrar (host-side MCP
 *   client that exposes discovered tools into the agent surface) is P5 scope.
 *
 * Transport: spawn(node, [entrypointPath], { stdio: ['ignore','pipe','pipe'] }).
 *   The MCP server communicates via stdio JSON-RPC; the registrar (P5) wraps
 *   the spawned process's stdio to read tool descriptors.
 *
 * Permission recording: permissions{} from the manifest is logged at activation.
 *   Runtime sandboxing (fs/network/socket path restrictions) is P5 scope.
 */

import { ProcessSupervisor, type LifecycleBlock, type PermissionsBlock } from '../supervisor.js';

export interface McpAdapterOptions {
  key: string;
  entrypointPath: string;
  /** Additional CLI args (e.g. --db-path, --scope). */
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  lifecycle: LifecycleBlock;
  permissions?: PermissionsBlock | undefined;
  onRestart?: ((n: number) => void) | undefined;
}

export interface McpAdapterHandle {
  key: string;
  supervisor: ProcessSupervisor;
  /** Declared permissions — recorded at P4 activation for P5 enforcement. */
  permissions: PermissionsBlock | undefined;
  type: 'mcp-server';
}

/**
 * Activate an mcp-server extension.
 *
 * Spawns the built entrypoint under the supervisor honoring the lifecycle{} block.
 * Returns a handle with the supervisor for lifecycle management (stop/restart/health).
 *
 * Note: the MCP protocol registrar (host-side client) is P5 scope. P4 establishes
 * the spawned, supervised process and records permissions.
 */
export async function activateMcp(opts: McpAdapterOptions): Promise<McpAdapterHandle> {
  // P4: record permissions at activation (enforcement is P5 scope)
  if (opts.permissions) {
    console.log(
      `[mcp-adapter] Activating "${opts.key}" — permissions declared (P4 record / P5 enforce):`,
      JSON.stringify(opts.permissions),
    );
  } else {
    console.log(`[mcp-adapter] Activating "${opts.key}" — no declared permissions`);
  }

  const lifecycle = opts.lifecycle;

  // Only spawn out-of-process if lifecycle.background === true.
  // Non-background mcp-servers (rare) are activated in-process via dynamic import (P5 refinement).
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

  // Non-background case: dynamic import for in-process MCP (P5 refinement)
  // P4 scope: record but do not spawn (no lifecycle.background means consumer calls it directly)
  console.log(
    `[mcp-adapter] "${opts.key}" is non-background — will be loaded in-process by registrar (P5)`,
  );

  // Return a stub handle (no supervisor needed for non-background servers)
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
