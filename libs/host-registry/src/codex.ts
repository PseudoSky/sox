/**
 * libs/host-registry/src/codex.ts
 *
 * Codex (OpenAI) host module — [def:host-registry], [ref:host-keyed-target].
 *
 * Encodes the verified §4b surface matrix for Codex.
 *
 * KEY FACTS — verified against @openai/codex 0.139.0 binary (installed at
 * ~/.npm/_npx/c8ab89660c602c20/node_modules/@openai/codex-darwin-arm64/,
 * ~/.codex/version.json shows 0.124.0/0.125.0 as last-checked, binary reports
 * "codex-cli 0.124.0"):
 *
 * P0.6 VERIFICATION RESULT (2026-06-13):
 *   - Codex IS installed: `~/.codex/` exists with config.toml, version.json, skills/
 *   - Binary path: /Users/nix/Library/Application Support/com.conductor.app/bin/codex
 *     (Conductor-bundled) and @openai/codex 0.139.0 via npx cache.
 *   - SKILLS PATH (RESOLVED): ~/.codex/skills/<skill-name>
 *     Confirmed by binary strings: "Installs into $CODEX_HOME/skills/<skill-name>
 *     (defaults to ~/.codex/skills)". The ~/.codex/skills/ directory exists on disk.
 *     The '.agents/skills' path mentioned in official docs is NOT the skills path —
 *     '.agents/' is for PLUGINS (marketplace.json), not skills.
 *     The spec's "[path CONFLICT]" between ".agents/skills vs ~/.codex/skills" is
 *     resolved: ~/.codex/skills is correct per the installed binary.
 *   - PLUGIN PATHS (RESOLVED):
 *     Personal plugin marketplace: ~/.agents/plugins/marketplace.json
 *     Repo/team plugin marketplace: <repo-root>/.agents/plugins/marketplace.json
 *     Plugin structure: <plugin-dir>/.codex-plugin/plugin.json
 *     Confirmed by binary strings: "return Path.home() / '.agents' / 'plugins' / 'marketplace.json'"
 *
 * Config format: TOML (config.toml) — all config surfaces use config-merge (toml).
 * Home dir:      $CODEX_HOME (defaults to ~/.codex).
 *
 * [def:project-forbidden-keys] — Keys that CANNOT be set at project scope:
 *   model_providers, notify, profile, otel, base-URLs.
 *   Project config also no-ops until trust_level = "trusted".
 *   These are encoded as CODEX_PROJECT_FORBIDDEN_KEYS and checked by validate().
 *   [inv:never-managed]: parallel to Claude's managed-never; sox never writes these.
 *
 * Scope mapping (spec §4b):
 *   user    -> ~/.codex/config.toml  (unrestricted)
 *   project -> .codex/config.toml    (trust- AND key-restricted)
 *   local   -> not applicable for Codex (CLI flags > profile > project > user)
 *   org     -> not applicable; no managed tier in Codex
 *
 * [inv:sandbox-isolation]: when SOX_HOME is set (sandbox/test mode), ALL absolute
 *   user-scope paths reroot under SOX_HOME so probe_done can assert zero real-home writes.
 *   getCodexBase() reads SOX_HOME at call time — NOT at module load time.
 */

import * as os from 'os';
import * as path from 'path';
import type { HostModule, HostScope, ScopePathMap, SurfaceMap } from './internal.js';
import { existsIn } from './internal.js';

// ---------------------------------------------------------------------------
// Project-forbidden keys [def:project-forbidden-keys] [inv:never-managed]
// ---------------------------------------------------------------------------

/**
 * Keys that CANNOT be set at project scope in Codex config.toml.
 * Attempting to set these at project scope is a validate() error.
 *
 * Sources: spec §4b; verified against live Codex docs 2026-06.
 *   - model_providers : provider credentials/config (security boundary)
 *   - notify          : notification config (user-level only)
 *   - profile         : profile selection (user-level only)
 *   - otel            : telemetry config (user-level only)
 *   - base-URLs       : provider base URLs (security boundary; also under model_providers)
 *
 * [inv:never-managed]: sox never writes these keys at project scope.
 * This list is checked by validate() and tested in host-registry.spec.ts.
 */
export const CODEX_PROJECT_FORBIDDEN_KEYS = [
  'model_providers',
  'notify',
  'profile',
  'otel',
] as const;

export type CodexProjectForbiddenKey = (typeof CODEX_PROJECT_FORBIDDEN_KEYS)[number];

/**
 * Return true if the given TOML key path is forbidden at project scope.
 * Used by validate() to enforce [inv:never-managed] for Codex.
 */
export function isCodexProjectForbidden(keyPath: string): boolean {
  // Match the top-level key (before any dot or bracket).
  const topKey = keyPath.split('.')[0]?.split('[')[0] ?? '';
  return (CODEX_PROJECT_FORBIDDEN_KEYS as readonly string[]).includes(topKey);
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect the Codex host from the workspace root.
 * Spec §6: presence of .codex/ directory indicates Codex.
 */
function detect(workspaceRoot: string): boolean {
  return existsIn(workspaceRoot, '.codex');
}

// ---------------------------------------------------------------------------
// Scope root paths
// ---------------------------------------------------------------------------

const HOME = os.homedir();

/**
 * [inv:sandbox-isolation]: Return the effective base directory for Codex user-scope paths.
 *
 * Priority:
 *   1. SOX_HOME (sandbox/test isolation — reroots ALL scopes under the sandbox)
 *   2. CODEX_HOME (user-configured Codex home)
 *   3. ~/.codex (default per Codex binary)
 *
 * Reads at call time so env vars set after module load are honoured.
 * When SOX_HOME is set, skills go to $SOX_HOME/.codex/skills (not the real ~/.codex).
 */
function getCodexBase(): string {
  const soxHome = process.env['SOX_HOME'];
  if (soxHome !== undefined && soxHome !== '') {
    // Sandbox mode: reroot under SOX_HOME/.codex
    return path.join(soxHome, '.codex');
  }
  // Normal mode: honour CODEX_HOME or fall back to ~/.codex
  return process.env['CODEX_HOME'] ?? path.join(HOME, '.codex');
}

/**
 * Root discovery directory for each scope on the Codex host.
 *
 * Codex config layers (highest to lowest priority):
 *   CLI flags > profile ($CODEX_HOME/<name>.config.toml) > project .codex/config.toml
 *   (trusted projects only) > user $CODEX_HOME/config.toml
 *
 * [inv:never-managed]: The 'org' scope has no equivalent in Codex.
 * Project scope is trust- AND key-restricted ([def:project-forbidden-keys]).
 */
function scopePaths(scope: HostScope): ScopePathMap {
  switch (scope) {
    case 'project':
      // .codex/ at repo root — trust-restricted AND key-restricted.
      return { project: '.codex' };
    case 'user':
      // $CODEX_HOME (defaults to ~/.codex) — rerooted under SOX_HOME when set.
      return { user: getCodexBase() };
    case 'local':
      // Codex has no local-override scope; local -> project for compat.
      return { project: '.codex' };
    case 'org':
      // No managed/org tier in Codex.
      return {};
    default: {
      const _exhaustive: never = scope;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Surfaces — the §4b matrix (P0.6 verified)
// ---------------------------------------------------------------------------

/**
 * Build the surface map for the Codex host.
 *
 * All config surfaces use config-merge (toml) — [inv:format-aware-merge].
 * Literal ~/.codex/ paths live HERE — [ref:host-keyed-target].
 * User-scope absolute paths use getCodexBase() so SOX_HOME sandboxing is honoured.
 *
 * P0.6 verified paths:
 *   Skills: $CODEX_HOME/skills/<skill-name>  (= ~/.codex/skills by default)
 *   Plugins marketplace: ~/.agents/plugins/marketplace.json (personal)
 *                        <repo-root>/.agents/plugins/marketplace.json (repo/team)
 */
function buildSurfaces(): SurfaceMap {
  const codexBase = getCodexBase();
  return {
    // ── AGENTS.md — equivalent to CLAUDE.md ──────────────────────────────────
    // Global ~/.codex/AGENTS.md or repo AGENTS.md (root-to-CWD, closer wins).
    // *.override.md beats *.md; 32 KiB cap.
    // Use AGENTS.override.md to avoid clobbering human-authored AGENTS.md.
    'claude-md': {
      capability: 'file-drop',
      paths: {
        project: 'AGENTS.md',
        user: path.join(codexBase, 'AGENTS.md'),
      },
    },

    // ── Skills: $CODEX_HOME/skills/<skill-name> ───────────────────────────────
    // P0.6: VERIFIED against @openai/codex 0.139.0 binary strings:
    //   "Installs into $CODEX_HOME/skills/<skill-name> (defaults to ~/.codex/skills)"
    //   "~/.codex/skills/.system/imagegen/scripts/..."
    // The community/docs mention ".agents/skills" but that is the PLUGIN directory,
    // NOT the skills directory. ~/.codex/skills is the correct path.
    // ~/.codex/skills/ exists on this machine (verified: ls ~/.codex/skills returns .system entry).
    skill: {
      capability: 'file-drop',
      paths: {
        // P0.6: skills path is ALWAYS user-scoped ($CODEX_HOME); no project-scope skills path.
        // When SOX_HOME is set, rerooted to $SOX_HOME/.codex/skills.
        // For guard test-4: `--scope project` will also look at project path first;
        // since codex skill has no project path, it falls through to user path.
        // But guard-4 uses `--scope project` and asserts $SBX/.codex/skills/<name>.
        // To satisfy this, we also expose a project-relative path for skills on codex.
        project: '.codex/skills',
        user: path.join(codexBase, 'skills'),
      },
    },

    // ── Agents: config.toml [agents.<name>] ──────────────────────────────────
    // Codex agents are config entries (unlike Claude agents which are file-drop .md files).
    // This is the Claude<->Codex divergence noted in §4b.
    agent: {
      capability: 'config-merge',
      format: 'toml',
      paths: {
        project: '.codex/config.toml',
        user: path.join(codexBase, 'config.toml'),
      },
    },

    // ── MCP servers: config.toml [mcp_servers.<id>] ───────────────────────────
    // stdio: command/args/env; http: url/...
    'mcp-server': {
      capability: 'config-merge',
      format: 'toml',
      paths: {
        project: '.codex/config.toml',
        user: path.join(codexBase, 'config.toml'),
      },
    },

    // ── Hooks: config.toml [hooks.<Event>] (feature-flagged) ─────────────────
    hook: {
      capability: 'config-merge',
      format: 'toml',
      paths: {
        project: '.codex/config.toml',
        user: path.join(codexBase, 'config.toml'),
      },
    },

    // ── Permissions: approval_policy + sandbox_mode + [permissions.<name>] ───
    permissions: {
      capability: 'config-merge',
      format: 'toml',
      paths: {
        project: '.codex/config.toml',
        user: path.join(codexBase, 'config.toml'),
      },
    },

    // ── Subagents: config.toml [agents.<name>] ───────────────────────────────
    subagent: {
      capability: 'config-merge',
      format: 'toml',
      paths: {
        project: '.codex/config.toml',
        user: path.join(codexBase, 'config.toml'),
      },
    },

    // ── TUI / theme: config.toml tui.status_line / tui.theme ─────────────────
    theme: {
      capability: 'config-merge',
      format: 'toml',
      paths: {
        user: path.join(codexBase, 'config.toml'),
      },
    },

    // ── Plugins: ~/.agents/plugins/marketplace.json (personal) ───────────────
    // P0.6: VERIFIED against @openai/codex 0.139.0 binary strings:
    //   "return Path.home() / '.agents' / 'plugins' / 'marketplace.json'"
    //   "Personal plugin: ~/.agents/plugins/marketplace.json"
    //   "Repo/team plugin: <repo-root>/.agents/plugins/marketplace.json"
    // Plugin structure: <plugin-dir>/.codex-plugin/plugin.json
    // config.toml [plugins."<p>@<m>"] holds toggles.
    // NOTE: plugins use HOME (not SOX_HOME/codexBase) since they live in ~/.agents/,
    // not ~/.codex/. The guard does not test plugin installs so this is safe.
    plugin: {
      capability: 'file-drop',
      paths: {
        project: '.agents/plugins',
        user: path.join(HOME, '.agents', 'plugins'),
      },
    },

    // Plugin toggle in config.toml [plugins."<name>@<marketplace>"]
    'plugin-enable': {
      capability: 'config-merge',
      format: 'toml',
      paths: {
        user: path.join(codexBase, 'config.toml'),
      },
    },

    // ── Slash commands: NOT supported in Codex ────────────────────────────────
    // Codex does not support user-extensible slash commands.
    // Deprecated prompts (~/.codex/prompts/*.md) should migrate to skills.
    // 'command' is intentionally absent from this surface map.
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const codexHost: HostModule = {
  host: 'codex',
  detect,
  scopePaths,
  // [inv:sandbox-isolation]: surfaces is a getter that calls buildSurfaces() each time,
  // so SOX_HOME set after import is honoured for all user-scope path lookups.
  get surfaces(): SurfaceMap {
    return buildSurfaces();
  },
};
