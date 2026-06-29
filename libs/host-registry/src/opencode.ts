/**
 * libs/host-registry/src/opencode.ts
 *
 * OpenCode host module — [def:host-registry], [ref:host-keyed-target].
 *
 * OpenCode is a local-first AI coding agent that uses opencode.json for config
 * and .opencode/ for project-local agents, skills, and tools.
 *
 * Scope mapping:
 *   project -> .opencode/...
 *   user    -> ~/.config/opencode/...
 *   local   -> .opencode/... (same as project — local overrides)
 *   org     -> not applicable (no managed tier)
 *
 * [inv:sandbox-isolation]: when SOX_SANDBOX_ROOT is set (sandbox/test mode), ALL
 *   absolute user-scope paths reroot under it so probe_done can assert zero real-home
 *   writes. getBase() reads SOX_SANDBOX_ROOT at call time — NOT at module load time.
 */

import * as os from 'os';
import * as path from 'path';
import type { HostModule, HostScope, ScopePathMap, SurfaceMap, McpConfig } from './internal.js';
import { existsIn } from './internal.js';

// ─── Detection ──────────────────────────────────────────────────────────────

/**
 * Detect OpenCode from the workspace root: opencode.json or .opencode/ dir.
 */
function detect(workspaceRoot: string): boolean {
  return (
    existsIn(workspaceRoot, 'opencode.json') ||
    existsIn(workspaceRoot, '.opencode')
  );
}

// ─── Scope root paths ──────────────────────────────────────────────────────

const HOME = os.homedir();

/**
 * [inv:sandbox-isolation]: Return the effective base directory for user-scope paths.
 * When SOX_SANDBOX_ROOT is set (probe/test sandbox), all absolute user paths reroot
 * there. Reads at call time so the env var set after module load is honoured.
 */
function getBase(): string {
  const sandbox = process.env['SOX_SANDBOX_ROOT'];
  return sandbox !== undefined && sandbox !== '' ? sandbox : HOME;
}

/**
 * Root discovery directory for each scope on the OpenCode host.
 */
function scopePaths(scope: HostScope): ScopePathMap {
  switch (scope) {
    case 'project':
      return { project: '.opencode' };
    case 'user':
      return { user: path.join(getBase(), '.config', 'opencode') };
    case 'local':
      return { local: '.opencode' };
    case 'org':
      return {};
    default: {
      const _exhaustive: never = scope;
      return _exhaustive;
    }
  }
}

// ─── MCP config builder ────────────────────────────────────────────────────

/**
 * OpenCode MCP format:
 *   - Key path: mcp.{id} (NOT mcpServers.{id})
 *   - stdio profile: { type: "local", command: [cliBin, "serve", extId] }
 *   - sse/http profile: { type: "remote", url: "http://localhost:<port>/mcp" }
 */
const mcpConfig: McpConfig = {
  keyPath(extId: string): string {
    return `mcp.${extId}`;
  },
  value(profile: string, cliBin: string, extId: string): unknown {
    if (profile === 'sse' || profile === 'http') {
      const port = 3000;
      return { type: 'remote', url: `http://localhost:${port}/mcp` };
    }
    return { type: 'local', command: [cliBin, 'serve', extId] };
  },
};

// ─── Surfaces ──────────────────────────────────────────────────────────────

function buildSurfaces(): SurfaceMap {
  const base = getBase();

  return {
    // ── file-drop surfaces ────────────────────────────────────────────────

    agent: {
      capability: 'file-drop',
      paths: {
        project: '.opencode/agents',
        user: path.join(base, '.config', 'opencode', 'agents'),
      },
    },

    skill: {
      capability: 'file-drop',
      paths: {
        project: '.opencode/skills',
        user: path.join(base, '.config', 'opencode', 'skills'),
      },
    },

    command: {
      capability: 'file-drop',
      paths: {
        project: '.opencode/tools',
        user: path.join(base, '.config', 'opencode', 'tools'),
        local: '.opencode/tools',
      },
    },

    // ── config-merge surfaces ─────────────────────────────────────────────

    'mcp-server': {
      capability: 'config-merge',
      format: 'json',
      mcpConfig,
      postInstallHint:
        'MCP server installed to opencode. Run `soxe service enable {ext}` to keep it running across sessions (remote profile), or opencode will spawn it per-session (local profile).',
      paths: {
        project: 'opencode.json',
        user: path.join(base, '.config', 'opencode', 'opencode.json'),
      },
    },

    // ── run-service (service type) ────────────────────────────────────────

    service: {
      capability: 'run-service',
      paths: {
        project: '.sox',
        user: path.join(base, '.sox'),
      },
    },
  };
}

// ─── Export ────────────────────────────────────────────────────────────────

export const opencodeHost: HostModule = {
  host: 'opencode',
  detect,
  scopePaths,
  get surfaces(): SurfaceMap {
    return buildSurfaces();
  },
};
