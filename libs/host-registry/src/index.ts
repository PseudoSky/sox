/**
 * libs/host-registry/src/index.ts
 *
 * Pluggable host registry — [def:host-registry], [ref:host-keyed-target].
 *
 * This is the ONLY package allowed to contain literal host-discovery paths
 * (.claude/, .codex/, .opencode/, ~/.claude/, ~/.codex/, ~/.config/opencode/).
 * All other code must resolve targets via this registry — never hard-code
 * host paths elsewhere.
 *
 * The registry ships three modules:
 *   claude.ts  — [inv:never-managed], MCP trust = prompt
 *   codex.ts   — [def:project-forbidden-keys], TOML config-merge
 *   opencode.ts — mcp.{id} key format, command array format, json config-merge
 *
 * [shape:host-registry]:
 *   interface HostModule {
 *     host: string;
 *     detect(workspaceRoot: string): boolean;
 *     scopePaths(scope: HostScope): ScopePathMap;
 *     surfaces: SurfaceMap;
 *   }
 *
 * Circular-import note:
 *   All shared types and runtime helpers (existsIn, expandHome) live in
 *   ./internal.ts (a leaf with no imports from this file). claude.ts,
 *   codex.ts, and opencode.ts import only from ./internal.ts, so there is
 *   no import cycle. This file re-exports everything from internal.ts to
 *   keep the public API unchanged for external consumers.
 */

// ─── Re-export all types and helpers from the leaf internal module ────────────
// (HostScope, CapabilityId, Surface, SurfaceMap, ScopePathMap, HostModule,
//  expandHome, existsIn)
export type {
  HostScope,
  CapabilityId,
  Surface,
  SurfaceMap,
  ScopePathMap,
  HostModule,
  McpConfig,
  AgentIr,
  AgentOverride,
  AgentToolRef,
  RenderedArtifact,
  HostRenderer,
} from './internal.js';
export { expandHome, existsIn } from './internal.js';
export { agentRenderers, stripFrontmatter, yamlScalar, yamlStringify } from './agent-renderers.js';

// ─── Registry ────────────────────────────────────────────────────────────────

import type { HostModule } from './internal.js';
import { claudeHost } from './claude.js';
import { codexHost } from './codex.js';
import { opencodeHost } from './opencode.js';

const _registry: Map<string, HostModule> = new Map([
  [claudeHost.host, claudeHost],
  [codexHost.host, codexHost],
  [opencodeHost.host, opencodeHost],
]);

/** Retrieve a registered host module by name, or throw. */
export function getHost(name: string): HostModule {
  const mod = _registry.get(name);
  if (!mod) {
    throw new Error(
      `[host-registry] Unknown host "${name}". Registered hosts: ${[..._registry.keys()].join(', ')}`
    );
  }
  return mod;
}

/** Return all registered host names. */
export function listHosts(): string[] {
  return [..._registry.keys()];
}

/**
 * Detect which host(s) are active in a workspace root (spec §6: host detection at install).
 * Returns the host names whose detect() returns true.
 * Multiple detected hosts -> caller must prompt the user (or pass --host).
 */
export function detectHosts(workspaceRoot: string): string[] {
  return [..._registry.values()]
    .filter((mod) => mod.detect(workspaceRoot))
    .map((mod) => mod.host);
}

/**
 * Resolve the effective workspace root: use the provided path if given,
 * else fall back to process.cwd().
 */
export function resolveWorkspaceRoot(workspaceRoot?: string): string {
  return workspaceRoot ?? process.cwd();
}

// ─── Re-export host modules (for direct import by tests / engine) ─────────────

export { claudeHost } from './claude.js';
export { codexHost } from './codex.js';
export { opencodeHost } from './opencode.js';
