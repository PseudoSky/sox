/**
 * libs/host-registry/src/claude.ts
 *
 * Claude Code host module — [def:host-registry], [ref:host-keyed-target].
 *
 * Encodes the verified §4 surface matrix (P0.5 corrections applied):
 *   - agents / skills / commands / hooks-scripts -> file-drop
 *   - CLAUDE.md / rules -> file-drop
 *   - settings / MCP servers -> config-merge (JSON)
 *   - permissions -> array-merge
 *   - MCP trust -> array-merge (enabledMcpjsonServers); DEFAULT = prompt (no auto-flag)
 *   - plugins -> registry + config-merge
 *
 * P0.5 CORRECTIONS (verified against live Claude docs, 2026-06):
 *   - output-style is NOT a file surface — it is a settings.json value only.
 *     Do NOT add it as a surface here.
 *   - hooks are file-drop (script at ~/.claude/hooks/<id>/) + config-merge
 *     (settings.json -> hooks entry referencing the script by absolute path).
 *   - MCP trust is a prompt (no enableAllProjectMcpServers flag to auto-write).
 *   - User MCP lives in ~/.claude.json (not settings.json).
 *   - Project .mcp.json trust is an approval prompt — sox never auto-writes a trust flag.
 *
 * [inv:never-managed]: sox NEVER writes the Claude managed tier (org/enterprise policy).
 *   MANAGED tier paths are NEVER emitted by scopePaths() or surfaces.
 *   This guard is tested explicitly in host-registry.spec.ts (never-managed assertion).
 *
 * Scope mapping (spec §4):
 *   project -> .claude/...  (and repo-root .mcp.json for MCP servers)
 *   user    -> ~/.claude/...
 *   local   -> .claude/settings.local.json
 *   managed -> SOX NEVER WRITES THIS (enterprise/org policy tier)
 *
 * [inv:sandbox-isolation]: when SOX_HOME is set (sandbox/test mode), ALL absolute
 *   user-scope paths reroot under SOX_HOME so probe_done can assert zero real-home writes.
 *   getBase() reads SOX_HOME at call time — NOT at module load time — so the env var
 *   set after import is honoured.
 */

import * as os from 'os';
import * as path from 'path';
import type { HostModule, HostScope, ScopePathMap, SurfaceMap } from './internal.js';
import { existsIn } from './internal.js';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect the Claude host from the workspace root.
 * Spec §6: presence of .claude/ directory, .mcp.json, or CLAUDE.md indicates Claude.
 */
function detect(workspaceRoot: string): boolean {
  return (
    existsIn(workspaceRoot, '.claude') ||
    existsIn(workspaceRoot, '.mcp.json') ||
    existsIn(workspaceRoot, 'CLAUDE.md')
  );
}

// ---------------------------------------------------------------------------
// Scope root paths
// ---------------------------------------------------------------------------

const HOME = os.homedir();

/**
 * [inv:sandbox-isolation]: Return the effective base directory for user-scope paths.
 * When SOX_HOME is set (probe/test sandbox), all absolute user paths reroot there.
 * Reads at call time so the env var set after module load is honoured.
 */
function getBase(): string {
  const soxHome = process.env['SOX_HOME'];
  return soxHome !== undefined && soxHome !== '' ? soxHome : HOME;
}

/**
 * Root discovery directory for each scope on the Claude host.
 *
 * [inv:never-managed]: The 'managed' (org/enterprise) tier is deliberately
 * ABSENT from this map. sox has no code path that writes managed-tier paths.
 * If a caller passes scope='org', scopePaths() returns an empty object — not
 * a path to the managed tier.
 */
function scopePaths(scope: HostScope): ScopePathMap {
  // [inv:sandbox-isolation]: when SOX_HOME is set, user-scope paths reroot under it.
  switch (scope) {
    case 'project':
      // Relative paths from the workspace root — portable, committed to repo.
      return { project: '.claude' };
    case 'user':
      // Absolute home-relative path — rerooted under SOX_HOME when set.
      return { user: path.join(getBase(), '.claude') };
    case 'local':
      // Local overrides sit inside the project .claude/ dir.
      return { local: '.claude' };
    case 'org':
      // [inv:never-managed]: sox never writes the managed tier.
      // Return empty — callers must not receive a path to managed-tier config.
      return {};
    default: {
      // Exhaustive check — TypeScript will catch unknown scopes at compile time.
      const _exhaustive: never = scope;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Surfaces — the §4 matrix (P0.5 verified)
// ---------------------------------------------------------------------------

/**
 * Build the surface map for the Claude host.
 *
 * Each key is an extension type (or logical surface name).
 * Each value is { capability, format?, paths }.
 *
 * Literal .claude/ and ~/.claude/ paths live HERE — [ref:host-keyed-target].
 * User-scope absolute paths use getBase() so SOX_HOME sandboxing is honoured.
 *
 * NOTE: 'output-style' is intentionally absent (P0.5: it is a settings.json
 * value, not a file surface — do not add it here).
 */
function buildSurfaces(): SurfaceMap {
  const base = getBase();
  return {
    // ── Declarative content types: file-drop ─────────────────────────────────

    agent: {
      capability: 'file-drop',
      paths: {
        project: '.claude/agents',
        user: path.join(base, '.claude', 'agents'),
      },
    },

    skill: {
      capability: 'file-drop',
      paths: {
        project: '.claude/skills',
        user: path.join(base, '.claude', 'skills'),
      },
    },

    command: {
      capability: 'file-drop',
      paths: {
        project: '.claude/commands',
        user: path.join(base, '.claude', 'commands'),
        // local scope: commands placed in the same .claude/commands dir as project scope
        // (local = project-local overrides, same discovery path).
        local: '.claude/commands',
      },
    },

    // rules are .claude/rules/**/*.md (prompt --inject rules target; Managed > User > Project)
    rules: {
      capability: 'file-drop',
      paths: {
        project: '.claude/rules',
        user: path.join(base, '.claude', 'rules'),
      },
    },

    // CLAUDE.md: file-drop at project root or user home
    'claude-md': {
      capability: 'file-drop',
      paths: {
        project: 'CLAUDE.md',
        user: path.join(base, 'CLAUDE.md'),
      },
    },

    // Hooks: TWO surfaces — script file-drop + settings config-merge.
    // The script is stored in ~/.claude/hooks/<id>/; the settings entry references it
    // by absolute path (P0.5: hooks are NOT auto-discovered from the dir).
    'hook-script': {
      capability: 'file-drop',
      paths: {
        user: path.join(base, '.claude', 'hooks'),
      },
    },

    // Plugins: ~/.claude/plugins/ registry (installed_plugins.json + marketplaces/)
    plugin: {
      capability: 'file-drop',
      paths: {
        user: path.join(base, '.claude', 'plugins'),
      },
    },

    // ── JSON config-merge surfaces ────────────────────────────────────────────

    // settings.json — merged for permissions, hooks entries, output-style value, etc.
    settings: {
      capability: 'config-merge',
      format: 'json',
      paths: {
        project: '.claude/settings.json',
        user: path.join(base, '.claude', 'settings.json'),
        local: '.claude/settings.local.json',
      },
    },

    // MCP servers: project -> .mcp.json (repo root); user -> ~/.claude.json
    // (P0.5 correction: user MCP lives in ~/.claude.json, NOT settings.json)
    'mcp-server': {
      capability: 'config-merge',
      format: 'json',
      paths: {
        project: '.mcp.json',
        user: path.join(base, '.claude.json'),
      },
    },

    // ── Service surface — run-service capability (ht-6) ──────────────────────
    // type:service extensions register through run-service; no literal host path
    // beyond the registry base ([ref:host-keyed-target]). The store dir is resolved
    // at install time relative to scopeRoot (.sox/ext/<id>/) — not encoded here.
    service: {
      capability: 'run-service',
      paths: {
        project: '.sox',
        user: path.join(base, '.sox'),
      },
    },

    // ── Array-merge surfaces ──────────────────────────────────────────────────

    // permissions array inside settings.json
    permissions: {
      capability: 'array-merge',
      format: 'json',
      paths: {
        project: '.claude/settings.json',
        user: path.join(base, '.claude', 'settings.json'),
      },
    },

    // MCP trust: project .mcp.json servers are trust-gated via
    // ~/.claude.json -> projects[<repo>].enabledMcpjsonServers (array-merge).
    // DEFAULT trust = prompt (sox does NOT auto-write a trust flag).
    // P0.5: There is no enableAllProjectMcpServers flag — trust is per-approval.
    'mcp-trust': {
      capability: 'array-merge',
      format: 'json',
      paths: {
        user: path.join(base, '.claude.json'),
      },
    },

    // Plugin enable toggle in settings.json -> enabledPlugins
    'plugin-enable': {
      capability: 'config-merge',
      format: 'json',
      paths: {
        user: path.join(base, '.claude', 'settings.json'),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const claudeHost: HostModule = {
  host: 'claude',
  detect,
  scopePaths,
  // [inv:sandbox-isolation]: surfaces is a getter that calls buildSurfaces() each time,
  // so SOX_HOME set after import is honoured for all user-scope path lookups.
  get surfaces(): SurfaceMap {
    return buildSurfaces();
  },
};
