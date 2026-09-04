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
import { formatAuthority, unbracket, validatePort } from './wire-endpoint.js';
import { agentRenderers } from './agent-renderers.js';

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
 *   - remote profile (sse/http): { type: "remote", url: "http://<host>:<port>/sse" }
 *   Port and host come from config cascade (http_port, bind_address).
 *
 * `"remote"` here is OpenCode's OWN correct value — verified by capturing its
 * REAL traffic (not assumed): OpenCode does NOT perform the classic HTTP+SSE
 * GET-handshake at all, regardless of the URL path — it POSTs JSON-RPC
 * directly to whatever URL is configured with StreamableHTTP semantics. The
 * server (libs/service-proxy/src/shim.ts) serves POST /sse identically to
 * POST /mcp for exactly this reason, so the /sse vs /mcp endpoint choice
 * below is cosmetic, not functional. See [ref:mcp-remote-type-matrix] in
 * claude.ts for the full three-host comparison: Claude requires
 * "http"/"sse" and rejects "remote" outright; Codex has no type field at
 * all. None of the three schemas generalizes to another — do not "fix"
 * this value to match Claude's.
 */
const mcpConfig: McpConfig = {
  keyPath(extId: string): string {
    return `mcp.${extId}`;
  },
  value(profile: string, cliBin: string, extId: string, port?: number, bindAddress?: string): unknown {
    if (profile === 'sse' || profile === 'http') {
      // BUG-EPIC-WIRE-INPUTS-UNBOUNDED-001 (class B): validate at the parse
      // site — `port` arrives typed but unchecked (see wire-endpoint.ts).
      // Validation is scoped to the remote branch (matches claude.ts/codex.ts)
      // so a stdio-profile install with a garbage http_port never fails.
      const p = validatePort(port ?? 3000, 'http_port');
      const rawHost = bindAddress ?? '127.0.0.1';
      const bareHost = unbracket(rawHost);
      // Use localhost for loopback addresses (more portable in host configs)
      const displayHost = bareHost === '127.0.0.1' || bareHost === '::1' ? 'localhost' : rawHost;
      // formatAuthority brackets any non-loopback IPv6 literal (the pre-fix
      // code only special-cased the literal string '::1' and left every
      // other IPv6 address unbracketed and broken).
      const authority = displayHost === 'localhost' ? `localhost:${p}` : formatAuthority(displayHost, p);
      // Endpoint choice is cosmetic (see docblock above) — the server treats
      // /sse and /mcp identically for a POST. Kept as /sse for readability.
      return { type: 'remote', url: `http://${authority}/sse` };
    }
    // stdio (default)
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
  // [def:agent-renderer]: render agent IR → opencode frontmatter at install time.
  render: agentRenderers.opencode,
  get surfaces(): SurfaceMap {
    return buildSurfaces();
  },
};
