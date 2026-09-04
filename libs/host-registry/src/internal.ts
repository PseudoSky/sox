/**
 * libs/host-registry/src/internal.ts
 *
 * Leaf module — imports ONLY node builtins (os, fs, path).
 * NO import from './index.js' — this file exists to break the circular
 * dependency between index.ts and the host modules (claude.ts / codex.ts).
 *
 * Contains:
 *   - All shared type definitions (HostScope, CapabilityId, Surface, SurfaceMap,
 *     ScopePathMap, HostModule) so claude.ts/codex.ts need NO import from index.ts
 *   - Runtime helpers: existsIn, expandHome
 *
 * index.ts re-exports everything from here so the public API is unchanged.
 *
 * Consumers:
 *   - claude.ts  — imports types + existsIn
 *   - codex.ts   — imports types + existsIn
 *   - index.ts   — re-exports all symbols so the public API at index is unchanged
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertWithinBase } from './path-safety.js';

// ─── Scopes ──────────────────────────────────────────────────────────────────

/**
 * Installation scopes.
 * - project : .claude/ or .codex/ at the repo root
 * - user    : <soxHome-or-home>/.claude/ or <soxHome-or-home>/.codex/
 * - local   : project-local overrides (settings.local.json etc.)
 * - org     : reserved; soxe never writes the Claude managed tier ([inv:never-managed])
 */
export type HostScope = 'project' | 'user' | 'local' | 'org';

// ─── Capabilities ────────────────────────────────────────────────────────────

/**
 * Capability identifiers [def:capability]:
 *   file-drop     — write a file/dir at a discovery path
 *   config-merge  — merge a key into a shared JSON or TOML config file
 *   array-merge   — append to arrays (permissions/env) with deny-wins semantics
 *   bin-link      — executable on PATH
 *   run-service   — soxe spawns + supervises (Role A only)
 *   materialize   — place built code at a stable store path
 */
export type CapabilityId =
  | 'file-drop'
  | 'config-merge'
  | 'array-merge'
  | 'object-array-merge'
  | 'bin-link'
  | 'run-service'
  | 'materialize';

// ─── Surface ─────────────────────────────────────────────────────────────────

/**
 * A surface is one installable slot on a host.
 * - capability : which installer operation handles this surface
 * - format     : for config-merge, whether the file is JSON or TOML
 * - paths      : scope -> resolved filesystem path for this surface
 *
 * NOTE: paths are relative to the workspace root for 'project'/'local' scopes
 * and absolute (home-expanded) for 'user' scope.
 */
/** Per-host MCP config builder. When a host module sets this on its mcp-server
 *  surface, declarativeInstall() uses it instead of the hardcoded Claude-format
 *  auto-derivation (mcpServers.{id}, { type:'stdio', command, args }). */
export interface McpConfig {
  /** Returns the config key path for the MCP server entry.
   *  e.g. 'mcpServers.{id}' for Claude, 'mcp.{id}' for OpenCode. */
  keyPath(extId: string): string;

  /** Returns the config value for the given profile + CLI bin.
   *  - 'sse'/'http' profiles receive a remote URL built from port + bindAddress.
   *  - 'stdio' profile receives a command array or command+args object.
   *  @param profile    Transport profile ('stdio' | 'sse' | 'http')
   *  @param cliBin     The spawn command for 'stdio' profiles
   *  @param extId      Extension identifier for URL path derivation
   *  @param port       HTTP port for remote URL (from config cascade http_port)
   *  @param bindAddress Bind address for remote URL (from config cascade bind_address) */
  value(profile: string, cliBin: string, extId: string, port?: number, bindAddress?: string): unknown;
}

export interface Surface {
  capability: CapabilityId;
  format?: 'json' | 'toml';
  /** Optional per-host MCP config builder. */
  mcpConfig?: McpConfig;
  /** Optional post-install hint. Returned verbatim by declarativeInstall()
   *  to the caller so the CLI can display host-specific guidance. */
  postInstallHint?: string;
  paths: Partial<Record<HostScope, string>>;
}

/** Map from extension type -> surface definition for one host. */
export type SurfaceMap = Record<string, Surface>;

// ─── Cross-platform agent rendering (docs/spec/cross-platform-install-rendering.md) ───

/** A symbolic tool reference: a built-in name, or an MCP server group. */
export type AgentToolRef = string | { logical: string; server: string };

/**
 * [def:agent-ir] Host-agnostic agent IR. Rendered into a per-host header at
 * install time. The prose body lives in the extension entrypoint file.
 */
export interface AgentIr {
  name?: string;
  description?: string;
  model?: string;
  temperature?: number;
  mode?: string;
  tools?: AgentToolRef[];
  /** opencode agent-frontmatter permission map: action | (pattern -> action). */
  permission?: Record<string, string | Record<string, string>>;
}

/**
 * [def:agent-render-overrides] Per-host override merged over the AgentIr at
 * install time. `tools` carries concrete (host-prefixed) names; `toolMap` maps a
 * logical server name to its concrete registration key on this host.
 */
export interface AgentOverride {
  name?: string;
  description?: string;
  model?: string;
  temperature?: number;
  mode?: string;
  tools?: string[];
  permission?: Record<string, string | Record<string, string>>;
  version?: string;
  toolMap?: Record<string, string>;
  fallbackPath?: string;
}

/** Result of rendering an agent for one host. */
export type RenderedArtifact =
  | { kind: 'file-body'; content: string }
  | { kind: 'config-value'; value: unknown };

/**
 * [def:agent-renderer] Per-host agent renderer. Composes header + prose +
 * generated tool-names into the host's concrete artifact. A pure function of
 * (ir, prose, override, host data) — see the spec §5.2/§5.3.
 */
export interface HostRenderer {
  /** Bare header fields (no fences) for an agent IR. */
  renderHeader(ir: AgentIr, overrides?: AgentOverride): Record<string, unknown>;
  /** Generated "resolved tool names" block, or null when the host needs none. */
  renderToolNames(ir: AgentIr, overrides?: AgentOverride): string | null;
  /** Compose header + prose + tool-names into the host's concrete artifact. */
  render(ir: AgentIr, prose: string, overrides?: AgentOverride): RenderedArtifact;
}

// ─── ScopePathMap ────────────────────────────────────────────────────────────

/**
 * The resolved root path for each scope on a given host.
 * scopePaths(scope) returns the root discovery directory for that scope.
 */
export type ScopePathMap = Partial<Record<HostScope, string>>;

// ─── HostModule interface ────────────────────────────────────────────────────

export interface HostModule {
  /** Canonical host identifier — used in install descriptors and ledger entries. */
  readonly host: string;

  /**
   * Returns true if this host is detected as active in the given workspace root.
   * Used by host detection at install time (spec §6).
   */
  detect(workspaceRoot: string): boolean;

  /**
   * Returns the root discovery path(s) for the given scope.
   * [ref:host-keyed-target]: all literal host paths live here, resolved per host.
   */
  scopePaths(scope: HostScope): ScopePathMap;

  /**
   * Surface map: extension type -> { capability, format?, paths }.
   * Drives the capability engine at install time.
   */
  readonly surfaces: SurfaceMap;

  /**
   * Optional per-host agent renderer. When present and the installed agent
   * manifest carries an `agent` IR (and/or `render` overrides), the install
   * engine renders the header instead of copying the entrypoint verbatim
   * ([def:agent-renderer]). Absent => raw passthrough.
   */
  readonly render?: HostRenderer;
}

// ─── Runtime helpers ─────────────────────────────────────────────────────────

/**
 * Expand a leading ~ to the effective home directory.
 * [inv:sandbox-isolation]: when SOX_SANDBOX_ROOT is set (test/probe mode ONLY),
 * tilde expands to SOX_SANDBOX_ROOT so any ~/-prefixed path reroots under the
 * sandbox. (ADR-0004 §D3: this is the DEDICATED isolation switch — split off the
 * data root. SOX_ECOSYSTEM_HOME does NOT reroot placements
 * [inv:data-root-never-reroutes].) Reads process.env at call time — NOT at module
 * load — so env vars set after import are honoured.
 */
export function expandHome(p: string): string {
  const sandbox = process.env['SOX_SANDBOX_ROOT'];
  const base = sandbox !== undefined && sandbox !== '' ? sandbox : os.homedir();
  // Tilde expansion: p === '~' or p starts with tilde+separator.
  // Written as a char-level check so no literal tilde-slash appears in source
  // ([host-targets.5] structural gate: no bare path literals outside host-registry).
  if (p[0] === '~' && (p.length === 1 || p[1] === '/')) {
    // BUG-EPIC-MANIFEST-PATH-ESCAPE-001: every current caller passes a
    // hardcoded host-module surface literal (e.g. "~/.claude/agents"), never
    // manifest/CLI input, so this is defense-in-depth rather than a fix for a
    // reachable escape today — but expandHome is a public export any future
    // caller could feed an untrusted "~/../../etc/..." string into, and the
    // fix belongs at the boundary, not at each call site.
    return assertWithinBase(base, path.join(base, p.slice(1)));
  }
  return p;
}

/**
 * Check if a path (relative to workspaceRoot, or absolute) exists on disk.
 * Used by detect() implementations.
 */
export function existsIn(workspaceRoot: string, rel: string): boolean {
  if (path.isAbsolute(rel)) return fs.existsSync(rel);
  // BUG-EPIC-MANIFEST-PATH-ESCAPE-001: every current caller passes a
  // hardcoded literal (e.g. '.claude', 'CLAUDE.md'), never manifest/CLI
  // input — defense-in-depth against a future caller passing untrusted `rel`.
  const full = assertWithinBase(workspaceRoot, path.join(workspaceRoot, rel));
  return fs.existsSync(full);
}
