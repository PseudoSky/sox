/**
 * libs/host-registry/src/host-registry.spec.ts
 *
 * Guard: ./node_modules/.bin/nx run host-registry:test
 *
 * P0.6 Codex skills path verification (2026-06-13):
 *   Installed: @openai/codex 0.139.0 (npx cache at ~/.npm/_npx/c8ab89660c602c20/)
 *              Conductor-bundled binary at
 *              ~/Library/Application Support/com.conductor.app/bin/codex (reports codex-cli 0.124.0)
 *              ~/.codex/ directory exists with skills/, config.toml, version.json.
 *
 *   SKILLS PATH verified from @openai/codex binary strings:
 *     "Installs into $CODEX_HOME/skills/<skill-name> (defaults to ~/.codex/skills)"
 *     "python ${CODEX_HOME:-$HOME/.codex}/skills/.system/imagegen/..."
 *     -> P0.6 CONCLUSION: skills path = $CODEX_HOME/skills = ~/.codex/skills
 *     The spec's "[path CONFLICT]" (.agents/skills vs ~/.codex/skills) is RESOLVED:
 *     ~/.codex/skills is correct. .agents/ is the PLUGIN marketplace dir, NOT skills.
 *
 *   PLUGIN PATH verified from @openai/codex binary strings:
 *     "return Path.home() / '.agents' / 'plugins' / 'marketplace.json'"
 *     "Personal plugin: ~/.agents/plugins/marketplace.json"
 *     "Repo/team plugin: <repo-root>/.agents/plugins/marketplace.json"
 *     Plugin structure: <plugin-dir>/.codex-plugin/plugin.json
 *
 *   Verification method: `strings` against the compiled Rust binary in the npx cache,
 *   plus `ls ~/.codex/skills/` (directory exists with .system entry).
 *
 * Tests:
 *   - Both host modules export detect/scopePaths/surfaces [host-registry.1]
 *   - scopePaths for project+user on both hosts [host-registry.2]
 *   - Codex encodes project-forbidden keys [host-registry.3]
 *   - Claude never-managed assertion (NEGATIVE test) [host-registry.4]
 *   - P0.6 codex paths recorded and asserted [host-registry.5]
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  claudeHost,
  codexHost,
  detectHosts,
  getHost,
  listHosts,
} from './index.js';

import {
  CODEX_PROJECT_FORBIDDEN_KEYS,
  isCodexProjectForbidden,
} from './codex.js';

const HOME = os.homedir();

// ─── Fixture workspace helpers ────────────────────────────────────────────────

function makeTmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sox-host-test-'));
}

function cleanupTmpWorkspace(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── [host-registry.1] Both modules export detect/scopePaths/surfaces ─────────

describe('host-registry.1 — HostModule interface', () => {
  it('claudeHost exports detect, scopePaths, surfaces', () => {
    expect(typeof claudeHost.detect).toBe('function');
    expect(typeof claudeHost.scopePaths).toBe('function');
    expect(typeof claudeHost.surfaces).toBe('object');
    expect(claudeHost.host).toBe('claude');
  });

  it('codexHost exports detect, scopePaths, surfaces', () => {
    expect(typeof codexHost.detect).toBe('function');
    expect(typeof codexHost.scopePaths).toBe('function');
    expect(typeof codexHost.surfaces).toBe('object');
    expect(codexHost.host).toBe('codex');
  });

  it('registry contains both hosts', () => {
    const hosts = listHosts();
    expect(hosts).toContain('claude');
    expect(hosts).toContain('codex');
  });

  it('getHost("claude") returns claudeHost', () => {
    expect(getHost('claude').host).toBe('claude');
  });

  it('getHost("codex") returns codexHost', () => {
    expect(getHost('codex').host).toBe('codex');
  });

  it('getHost throws for unknown host', () => {
    expect(() => getHost('unknown-host')).toThrow('[host-registry]');
  });
});

// ─── [host-registry.2] scopePaths for project + user on both hosts ────────────

describe('host-registry.2 — scopePaths: project and user on Claude', () => {
  // Ensure SOX_SANDBOX_ROOT is unset for these tests so we assert real-HOME paths.
  // (SOX_SANDBOX_ROOT may be set in CI; we test the non-sandboxed default here.)
  let _savedSandbox: string | undefined;
  beforeEach(() => {
    _savedSandbox = process.env['SOX_SANDBOX_ROOT'];
    delete process.env['SOX_SANDBOX_ROOT'];
  });
  afterEach(() => {
    if (_savedSandbox === undefined) {
      delete process.env['SOX_SANDBOX_ROOT'];
    } else {
      process.env['SOX_SANDBOX_ROOT'] = _savedSandbox;
    }
  });

  it('project scope returns .claude relative path', () => {
    const result = claudeHost.scopePaths('project');
    expect(result.project).toBe('.claude');
  });

  it('user scope returns ~/.claude absolute path', () => {
    const result = claudeHost.scopePaths('user');
    expect(result.user).toBe(path.join(HOME, '.claude'));
    // Must be absolute
    expect(path.isAbsolute(result.user as string)).toBe(true);
  });

  it('local scope returns .claude (local overrides)', () => {
    const result = claudeHost.scopePaths('local');
    expect(result.local).toBe('.claude');
  });

  it('surfaces.agent.paths.project contains .claude', () => {
    expect(claudeHost.surfaces['agent']?.paths.project).toContain('.claude');
  });

  it('surfaces.agent.paths.user contains ~/.claude', () => {
    expect(claudeHost.surfaces['agent']?.paths.user).toContain(path.join(HOME, '.claude'));
  });

  it('surfaces.skill.paths.project contains .claude/skills', () => {
    expect(claudeHost.surfaces['skill']?.paths.project).toBe('.claude/skills');
  });

  it('surfaces.skill.paths.user contains ~/.claude/skills', () => {
    expect(claudeHost.surfaces['skill']?.paths.user).toBe(path.join(HOME, '.claude', 'skills'));
  });

  it('surfaces.command.paths.project contains .claude/commands', () => {
    expect(claudeHost.surfaces['command']?.paths.project).toBe('.claude/commands');
  });

  it('surfaces.settings.paths.project is .claude/settings.json', () => {
    expect(claudeHost.surfaces['settings']?.paths.project).toBe('.claude/settings.json');
  });

  it('surfaces.settings.paths.local is .claude/settings.local.json', () => {
    expect(claudeHost.surfaces['settings']?.paths.local).toBe('.claude/settings.local.json');
  });

  it('surfaces.mcp-server.paths.project is .mcp.json (repo root)', () => {
    // P0.5 verified: project MCP is at repo-root .mcp.json (not .claude/.mcp.json)
    expect(claudeHost.surfaces['mcp-server']?.paths.project).toBe('.mcp.json');
  });

  it('surfaces.mcp-server.paths.user is ~/.claude.json (P0.5 correction)', () => {
    // P0.5: user MCP lives in ~/.claude.json, NOT settings.json
    expect(claudeHost.surfaces['mcp-server']?.paths.user).toBe(path.join(HOME, '.claude.json'));
  });

  it('surfaces.mcp-server uses config-merge json capability', () => {
    expect(claudeHost.surfaces['mcp-server']?.capability).toBe('config-merge');
    expect(claudeHost.surfaces['mcp-server']?.format).toBe('json');
  });

  it('surfaces.mcp-server emits mcpServers.{id} stdio configuration', () => {
    const mcpConfig = claudeHost.surfaces['mcp-server']!.mcpConfig!;
    expect(mcpConfig.keyPath('memory-server')).toBe('mcpServers.memory-server');
    expect(mcpConfig.value('stdio', '/usr/local/bin/soxe', 'memory-server')).toEqual({
      type: 'stdio',
      command: '/usr/local/bin/soxe',
      args: ['serve', 'memory-server'],
    });
  });

  it('surfaces.mcp-server defaults remote profiles to port 3099 (matches live memory-server deployment, BL-156/157)', () => {
    const mcpConfig = claudeHost.surfaces['mcp-server']!.mcpConfig!;
    expect(mcpConfig.value('http', 'soxe', 'memory-server')).toEqual({
      type: 'remote',
      url: 'http://localhost:3099/mcp',
    });
    expect(mcpConfig.value('sse', 'soxe', 'memory-server')).toEqual({
      type: 'remote',
      url: 'http://localhost:3099/sse',
    });
  });

  it('surfaces.mcp-server emits profile-specific remote endpoints with explicit port/host', () => {
    const mcpConfig = claudeHost.surfaces['mcp-server']!.mcpConfig!;
    expect(mcpConfig.value('http', 'soxe', 'memory-server', 3099, '127.0.0.1')).toEqual({
      type: 'remote',
      url: 'http://localhost:3099/mcp',
    });
    expect(mcpConfig.value('sse', 'soxe', 'memory-server', 4001, '0.0.0.0')).toEqual({
      type: 'remote',
      url: 'http://0.0.0.0:4001/sse',
    });
  });

  it('surfaces.permissions uses array-merge capability', () => {
    expect(claudeHost.surfaces['permissions']?.capability).toBe('array-merge');
  });

  it('surfaces.mcp-trust uses array-merge capability for enabledMcpjsonServers', () => {
    expect(claudeHost.surfaces['mcp-trust']?.capability).toBe('array-merge');
    expect(claudeHost.surfaces['mcp-trust']?.paths.user).toBe(path.join(HOME, '.claude.json'));
  });
});

describe('host-registry.2 — scopePaths: project and user on Codex', () => {
  // Ensure SOX_SANDBOX_ROOT is unset for these tests so we assert real-HOME paths.
  let _savedSandbox: string | undefined;
  beforeEach(() => {
    _savedSandbox = process.env['SOX_SANDBOX_ROOT'];
    delete process.env['SOX_SANDBOX_ROOT'];
  });
  afterEach(() => {
    if (_savedSandbox === undefined) {
      delete process.env['SOX_SANDBOX_ROOT'];
    } else {
      process.env['SOX_SANDBOX_ROOT'] = _savedSandbox;
    }
  });

  it('project scope returns .codex relative path', () => {
    const result = codexHost.scopePaths('project');
    expect(result.project).toBe('.codex');
  });

  it('user scope returns $CODEX_HOME or ~/.codex', () => {
    const result = codexHost.scopePaths('user');
    const expected = process.env['CODEX_HOME'] ?? path.join(HOME, '.codex');
    expect(result.user).toBe(expected);
    expect(path.isAbsolute(result.user as string)).toBe(true);
  });

  it('surfaces.agent uses config-merge toml (Claude divergence: agent is config not file-drop)', () => {
    // Codex agents are config.toml [agents.<name>] entries, unlike Claude's file-drop .md
    expect(codexHost.surfaces['agent']?.capability).toBe('config-merge');
    expect(codexHost.surfaces['agent']?.format).toBe('toml');
    expect(codexHost.surfaces['agent']?.paths.project).toBe('.codex/config.toml');
    expect(codexHost.surfaces['agent']?.paths.user).toContain('.codex');
  });

  it('surfaces.mcp-server uses config-merge toml', () => {
    expect(codexHost.surfaces['mcp-server']?.capability).toBe('config-merge');
    expect(codexHost.surfaces['mcp-server']?.format).toBe('toml');
    expect(codexHost.surfaces['mcp-server']?.paths.project).toBe('.codex/config.toml');
  });

  it('surfaces.hook uses config-merge toml', () => {
    expect(codexHost.surfaces['hook']?.capability).toBe('config-merge');
    expect(codexHost.surfaces['hook']?.format).toBe('toml');
  });

  it('surfaces.permissions uses config-merge toml', () => {
    expect(codexHost.surfaces['permissions']?.capability).toBe('config-merge');
    expect(codexHost.surfaces['permissions']?.format).toBe('toml');
  });

  // P0.6: Skills path assertion — verified against @openai/codex 0.139.0 binary
  it('P0.6 — surfaces.skill path is $CODEX_HOME/skills (= ~/.codex/skills by default)', () => {
    // Verified: binary string "Installs into $CODEX_HOME/skills/<skill-name> (defaults to ~/.codex/skills)"
    // agents/skills is WRONG — that is the plugin marketplace dir.
    const codexHome = process.env['CODEX_HOME'] ?? path.join(HOME, '.codex');
    expect(codexHost.surfaces['skill']?.paths.user).toBe(path.join(codexHome, 'skills'));
    // Must NOT be .agents/skills
    expect(codexHost.surfaces['skill']?.paths.user).not.toContain('.agents');
  });

  it('P0.6 — plugin marketplace path is ~/.agents/plugins (not ~/.codex/)', () => {
    // Verified: binary string "return Path.home() / '.agents' / 'plugins' / 'marketplace.json'"
    expect(codexHost.surfaces['plugin']?.paths.user).toBe(path.join(HOME, '.agents', 'plugins'));
    expect(codexHost.surfaces['plugin']?.paths.project).toBe('.agents/plugins');
  });

  it('surfaces."claude-md" maps to AGENTS.md (Codex equivalent)', () => {
    expect(codexHost.surfaces['claude-md']?.paths.project).toBe('AGENTS.md');
    expect(codexHost.surfaces['claude-md']?.capability).toBe('file-drop');
  });

  it('Codex has no surfaces.command (slash commands not user-extensible)', () => {
    // spec §4b: "slash commands: built-in only — NOT user-extensible"
    expect(codexHost.surfaces['command']).toBeUndefined();
  });
});

// ─── [host-registry.3] Codex project-forbidden keys ──────────────────────────

describe('host-registry.3 — Codex project-forbidden keys [inv:never-managed]', () => {
  it('CODEX_PROJECT_FORBIDDEN_KEYS includes model_providers', () => {
    expect(CODEX_PROJECT_FORBIDDEN_KEYS).toContain('model_providers');
  });

  it('CODEX_PROJECT_FORBIDDEN_KEYS includes notify', () => {
    expect(CODEX_PROJECT_FORBIDDEN_KEYS).toContain('notify');
  });

  it('CODEX_PROJECT_FORBIDDEN_KEYS includes profile', () => {
    expect(CODEX_PROJECT_FORBIDDEN_KEYS).toContain('profile');
  });

  it('CODEX_PROJECT_FORBIDDEN_KEYS includes otel', () => {
    expect(CODEX_PROJECT_FORBIDDEN_KEYS).toContain('otel');
  });

  it('isCodexProjectForbidden("model_providers") returns true', () => {
    expect(isCodexProjectForbidden('model_providers')).toBe(true);
  });

  it('isCodexProjectForbidden("model_providers.openai.api_key") returns true (nested)', () => {
    expect(isCodexProjectForbidden('model_providers.openai.api_key')).toBe(true);
  });

  it('isCodexProjectForbidden("notify") returns true', () => {
    expect(isCodexProjectForbidden('notify')).toBe(true);
  });

  it('isCodexProjectForbidden("profile") returns true', () => {
    expect(isCodexProjectForbidden('profile')).toBe(true);
  });

  it('isCodexProjectForbidden("otel") returns true', () => {
    expect(isCodexProjectForbidden('otel')).toBe(true);
  });

  it('isCodexProjectForbidden("mcp_servers") returns false (allowed at project scope)', () => {
    expect(isCodexProjectForbidden('mcp_servers')).toBe(false);
  });

  it('isCodexProjectForbidden("agents") returns false (allowed at project scope)', () => {
    expect(isCodexProjectForbidden('agents')).toBe(false);
  });

  it('isCodexProjectForbidden("hooks") returns false (allowed at project scope)', () => {
    expect(isCodexProjectForbidden('hooks')).toBe(false);
  });

  it('isCodexProjectForbidden("permissions") returns false (allowed at project scope)', () => {
    expect(isCodexProjectForbidden('permissions')).toBe(false);
  });
});

// ─── [host-registry.4] Claude never-managed assertion (NEGATIVE TEST) ─────────

describe('host-registry.4 — Claude never-managed assertion [inv:never-managed]', () => {
  /**
   * NEGATIVE TEST FIXTURE — [host-registry.4]
   *
   * This suite asserts that NO managed-tier path is EVER emitted by the Claude
   * host module. This is the explicit never-managed assertion required by the
   * architect notes: "Add an explicit NEGATIVE test fixture ... asserting that
   * NO managed/never-managed path is ever emitted".
   *
   * The Claude managed tier = org/enterprise policy (set by org admins).
   * soxe NEVER writes it. [inv:never-managed], [def:managed-tier].
   */

  const ALL_SCOPES: Array<'project' | 'user' | 'local' | 'org'> = [
    'project',
    'user',
    'local',
    'org',
  ];

  it('scopePaths("org") returns an empty object — no managed-tier path emitted', () => {
    const result = claudeHost.scopePaths('org');
    // Must be empty — no path should be returned for the managed tier
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('scopePaths never returns a path containing "managed" for any scope', () => {
    for (const scope of ALL_SCOPES) {
      const result = claudeHost.scopePaths(scope);
      const paths = Object.values(result).filter(Boolean) as string[];
      for (const p of paths) {
        expect(p.toLowerCase()).not.toContain('managed');
      }
    }
  });

  it('no surface in claudeHost.surfaces has a path containing "managed"', () => {
    for (const [surfaceName, surface] of Object.entries(claudeHost.surfaces)) {
      const paths = Object.values(surface.paths).filter(Boolean) as string[];
      for (const p of paths) {
        expect(p.toLowerCase(), `surface "${surfaceName}" path "${p}" must not reference managed tier`).not.toContain('managed');
      }
    }
  });

  it('no surface in claudeHost.surfaces emits an "org"-scoped path', () => {
    // The org scope is the managed tier — soxe never emits it as a target.
    for (const [surfaceName, surface] of Object.entries(claudeHost.surfaces)) {
      expect(
        surface.paths['org'],
        `surface "${surfaceName}" must not have an org-scoped path (managed tier)`
      ).toBeUndefined();
    }
  });

  it('no surface path references ~/.claude/managed/ or similar managed-tier dirs', () => {
    const managedPatterns = [/managed/i, /enterprise/i, /org-policy/i];
    for (const [surfaceName, surface] of Object.entries(claudeHost.surfaces)) {
      const paths = Object.values(surface.paths).filter(Boolean) as string[];
      for (const p of paths) {
        for (const pattern of managedPatterns) {
          expect(
            pattern.test(p),
            `surface "${surfaceName}" path "${p}" matches managed-tier pattern ${pattern}`
          ).toBe(false);
        }
      }
    }
  });
});

// ─── detect() fixture tests ────────────────────────────────────────────────────

describe('detect() — host detection from workspace fixtures', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpWorkspace();
  });

  afterEach(() => {
    cleanupTmpWorkspace(tmpDir);
  });

  it('claudeHost.detect() returns true when .claude/ directory exists', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'));
    expect(claudeHost.detect(tmpDir)).toBe(true);
  });

  it('claudeHost.detect() returns true when .mcp.json exists', () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), '{}');
    expect(claudeHost.detect(tmpDir)).toBe(true);
  });

  it('claudeHost.detect() returns true when CLAUDE.md exists', () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Claude');
    expect(claudeHost.detect(tmpDir)).toBe(true);
  });

  it('claudeHost.detect() returns false for empty workspace', () => {
    expect(claudeHost.detect(tmpDir)).toBe(false);
  });

  it('codexHost.detect() returns true when .codex/ directory exists', () => {
    fs.mkdirSync(path.join(tmpDir, '.codex'));
    expect(codexHost.detect(tmpDir)).toBe(true);
  });

  it('codexHost.detect() returns false for empty workspace', () => {
    expect(codexHost.detect(tmpDir)).toBe(false);
  });

  it('detectHosts() returns ["claude"] for a .claude/ workspace', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'));
    expect(detectHosts(tmpDir)).toEqual(['claude']);
  });

  it('detectHosts() returns ["codex"] for a .codex/ workspace', () => {
    fs.mkdirSync(path.join(tmpDir, '.codex'));
    expect(detectHosts(tmpDir)).toEqual(['codex']);
  });

  it('detectHosts() returns both hosts when both markers exist', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'));
    fs.mkdirSync(path.join(tmpDir, '.codex'));
    const result = detectHosts(tmpDir);
    expect(result).toContain('claude');
    expect(result).toContain('codex');
    expect(result).toHaveLength(2);
  });

  it('detectHosts() returns [] for empty workspace', () => {
    expect(detectHosts(tmpDir)).toEqual([]);
  });
});

// ─── [host-registry.6] SOX_SANDBOX_ROOT sandbox isolation — [inv:sandbox-isolation] ──
// ADR-0004 §D3: the isolation switch is SOX_SANDBOX_ROOT (split off the data root).

describe('host-registry.6 — SOX_SANDBOX_ROOT sandbox isolation [inv:sandbox-isolation]', () => {
  /**
   * When SOX_SANDBOX_ROOT is set, ALL user-scope absolute paths must reroot under it
   * so the probe_done assertion (zero real-home writes) holds. getBase() /
   * getCodexBase() read the env at call time, not module load time.
   */

  let savedSandbox: string | undefined;
  let savedEcosystemHome: string | undefined;
  let savedSoxHome: string | undefined;

  beforeEach(() => {
    savedSandbox = process.env['SOX_SANDBOX_ROOT'];
    savedEcosystemHome = process.env['SOX_ECOSYSTEM_HOME'];
    savedSoxHome = process.env['SOX_SANDBOX_ROOT'];
    // Ensure a clean slate: no stray data-root/legacy vars leaking into placement.
    delete process.env['SOX_SANDBOX_ROOT'];
    delete process.env['SOX_ECOSYSTEM_HOME'];
    delete process.env['SOX_SANDBOX_ROOT'];
  });

  const restore = (key: string, val: string | undefined): void => {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  };

  afterEach(() => {
    restore('SOX_SANDBOX_ROOT', savedSandbox);
    restore('SOX_ECOSYSTEM_HOME', savedEcosystemHome);
    restore('SOX_HOME', savedSoxHome);
  });

  it('claude: scopePaths("user") reroots under SOX_SANDBOX_ROOT when set', () => {
    const sbx = '/tmp/sox-sbx-test-sentinel';
    process.env['SOX_SANDBOX_ROOT'] = sbx;
    const result = claudeHost.scopePaths('user');
    expect(result.user).toBe(path.join(sbx, '.claude'));
    // Must NOT be the real home
    expect(result.user).not.toBe(path.join(HOME, '.claude'));
  });

  it('claude: surfaces.agent.paths.user reroots under SOX_SANDBOX_ROOT when set', () => {
    const sbx = '/tmp/sox-sbx-test-sentinel';
    process.env['SOX_SANDBOX_ROOT'] = sbx;
    const agentPath = claudeHost.surfaces['agent']?.paths.user;
    expect(agentPath).toBe(path.join(sbx, '.claude', 'agents'));
    expect(agentPath).not.toContain(HOME);
  });

  it('claude: surfaces.skill.paths.user reroots under SOX_SANDBOX_ROOT when set', () => {
    const sbx = '/tmp/sox-sbx-test-sentinel';
    process.env['SOX_SANDBOX_ROOT'] = sbx;
    const skillPath = claudeHost.surfaces['skill']?.paths.user;
    expect(skillPath).toBe(path.join(sbx, '.claude', 'skills'));
  });

  it('claude: surfaces.command.paths.user reroots under SOX_SANDBOX_ROOT when set', () => {
    const sbx = '/tmp/sox-sbx-test-sentinel';
    process.env['SOX_SANDBOX_ROOT'] = sbx;
    const cmdPath = claudeHost.surfaces['command']?.paths.user;
    expect(cmdPath).toBe(path.join(sbx, '.claude', 'commands'));
  });

  it('claude: project and local scopes are unaffected by SOX_SANDBOX_ROOT (relative paths)', () => {
    const sbx = '/tmp/sox-sbx-test-sentinel';
    process.env['SOX_SANDBOX_ROOT'] = sbx;
    expect(claudeHost.scopePaths('project').project).toBe('.claude');
    expect(claudeHost.scopePaths('local').local).toBe('.claude');
  });

  it('claude: [inv:never-managed] org scope returns empty even with SOX_SANDBOX_ROOT set', () => {
    const sbx = '/tmp/sox-sbx-test-sentinel';
    process.env['SOX_SANDBOX_ROOT'] = sbx;
    const result = claudeHost.scopePaths('org');
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('codex: scopePaths("user") reroots under SOX_SANDBOX_ROOT/.codex when set', () => {
    const sbx = '/tmp/sox-sbx-test-sentinel';
    process.env['SOX_SANDBOX_ROOT'] = sbx;
    const result = codexHost.scopePaths('user');
    expect(result.user).toBe(path.join(sbx, '.codex'));
  });

  it('codex: surfaces.skill.paths.user reroots under SOX_SANDBOX_ROOT/.codex/skills when set', () => {
    const sbx = '/tmp/sox-sbx-test-sentinel';
    process.env['SOX_SANDBOX_ROOT'] = sbx;
    const skillPath = codexHost.surfaces['skill']?.paths.user;
    expect(skillPath).toBe(path.join(sbx, '.codex', 'skills'));
  });

  it('codex: surfaces.skill.paths.project is relative .codex/skills (always)', () => {
    // project-scope skill path is relative (joined with workspaceRoot by install engine)
    expect(codexHost.surfaces['skill']?.paths.project).toBe('.codex/skills');
  });

  it('both hosts: paths restore to HOME-based values when SOX_SANDBOX_ROOT is unset', () => {
    process.env['SOX_SANDBOX_ROOT'] = '/tmp/sox-sbx-test-sentinel';
    // verify sandboxed
    expect(claudeHost.scopePaths('user').user).not.toBe(path.join(HOME, '.claude'));
    // unset
    delete process.env['SOX_SANDBOX_ROOT'];
    // verify restored
    expect(claudeHost.scopePaths('user').user).toBe(path.join(HOME, '.claude'));
    const codexHome = process.env['CODEX_HOME'] ?? path.join(HOME, '.codex');
    expect(codexHost.scopePaths('user').user).toBe(codexHome);
  });

  // ─── [inv:data-root-never-reroutes] — ADR-0004 §D3 governing invariant ──────
  // Setting SOX_ECOSYSTEM_HOME (the data root) must NEVER change a host placement
  // path. This is the exact failure the founder hit (data var rerouting placement),
  // encoded as a test.

  it('[inv:data-root-never-reroutes]: SOX_ECOSYSTEM_HOME does NOT reroot claude user placement', () => {
    process.env['SOX_ECOSYSTEM_HOME'] = '/tmp/sox-data-root-sentinel';
    // SOX_SANDBOX_ROOT is unset (cleared in beforeEach) → placement must hit real HOME.
    expect(claudeHost.scopePaths('user').user).toBe(path.join(HOME, '.claude'));
    expect(claudeHost.surfaces['skill']?.paths.user).toBe(path.join(HOME, '.claude', 'skills'));
    expect(claudeHost.surfaces['mcp-server']?.paths.user).toBe(path.join(HOME, '.claude.json'));
  });

  it('[inv:data-root-never-reroutes]: SOX_ECOSYSTEM_HOME does NOT reroot codex user placement', () => {
    process.env['SOX_ECOSYSTEM_HOME'] = '/tmp/sox-data-root-sentinel';
    const codexHome = process.env['CODEX_HOME'] ?? path.join(HOME, '.codex');
    expect(codexHost.scopePaths('user').user).toBe(codexHome);
    expect(codexHost.surfaces['skill']?.paths.user).toBe(path.join(codexHome, 'skills'));
  });

  it('[inv:data-root-never-reroutes]: legacy SOX_HOME does NOT reroot placement (retired)', () => {
    // ADR-0004: SOX_HOME is retired. A still-set SOX_HOME must NOT reroot placement
    // (only SOX_SANDBOX_ROOT does).
    process.env['SOX_HOME'] = '/tmp/sox-legacy-sentinel';
    expect(claudeHost.scopePaths('user').user).toBe(path.join(HOME, '.claude'));
    expect(codexHost.scopePaths('user').user).toBe(
      process.env['CODEX_HOME'] ?? path.join(HOME, '.codex'),
    );
  });

  it('sandbox + data-root together: only SOX_SANDBOX_ROOT governs placement', () => {
    process.env['SOX_SANDBOX_ROOT'] = '/tmp/sox-sbx';
    process.env['SOX_ECOSYSTEM_HOME'] = '/tmp/sox-data';
    // Placement follows SANDBOX, never the data root.
    expect(claudeHost.scopePaths('user').user).toBe(path.join('/tmp/sox-sbx', '.claude'));
    expect(claudeHost.scopePaths('user').user).not.toContain('sox-data');
  });
});

// ─── [host-registry.5] P0.6 path verification recorded ───────────────────────

describe('host-registry.5 — P0.6 codex path verification', () => {
  // Ensure SOX_SANDBOX_ROOT is unset so we assert real-HOME paths (not sandbox paths).
  let _savedSandbox: string | undefined;
  beforeEach(() => {
    _savedSandbox = process.env['SOX_SANDBOX_ROOT'];
    delete process.env['SOX_SANDBOX_ROOT'];
  });
  afterEach(() => {
    if (_savedSandbox === undefined) {
      delete process.env['SOX_SANDBOX_ROOT'];
    } else {
      process.env['SOX_SANDBOX_ROOT'] = _savedSandbox;
    }
  });

  /**
   * P0.6 verification summary (verified 2026-06-13):
   *
   * Environment:
   *   - @openai/codex 0.139.0 in npx cache (~/.npm/_npx/c8ab89660c602c20/)
   *   - Conductor codex binary: ~/Library/Application Support/com.conductor.app/bin/codex
   *     (reports "codex-cli 0.124.0")
   *   - ~/.codex/ directory exists with: config.toml, skills/, version.json etc.
   *   - ~/.codex/skills/ exists (contains .system entry)
   *
   * Skills path resolution:
   *   Method: `strings` on the compiled Rust binary
   *   Evidence: "Installs into $CODEX_HOME/skills/<skill-name> (defaults to ~/.codex/skills)"
   *             "python ${CODEX_HOME:-$HOME/.codex}/skills/.system/imagegen/..."
   *   Conclusion: ~/.codex/skills is the correct path.
   *               ".agents/skills" is NOT the skills path.
   *
   * Plugin path resolution:
   *   Method: `strings` on the compiled Rust binary
   *   Evidence: "return Path.home() / '.agents' / 'plugins' / 'marketplace.json'"
   *             "Personal plugin: ~/.agents/plugins/marketplace.json"
   *             "Repo/team plugin: <repo-root>/.agents/plugins/marketplace.json"
   *             "Creates or updates ~/.agents/plugins/marketplace.json when --with-marketplace"
   *   Conclusion: ~/.agents/plugins/ is the plugin marketplace, not a skills directory.
   */

  it('P0.6 agents/skills path — skill surface uses $CODEX_HOME/skills not .agents/skills', () => {
    // This assertion documents the P0.6 resolution:
    // The spec listed ".agents/skills" as a CONFLICT candidate vs "~/.codex/skills".
    // The installed binary confirms ~/.codex/skills is the real path.
    const codexHome = process.env['CODEX_HOME'] ?? path.join(HOME, '.codex');
    const skillPath = codexHost.surfaces['skill']?.paths.user;

    // Positive assertion: must be $CODEX_HOME/skills
    expect(skillPath).toBe(path.join(codexHome, 'skills'));

    // NEGATIVE assertion: must NOT be .agents/skills (the wrong path)
    expect(skillPath).not.toContain('.agents/skills');
    expect(skillPath).not.toContain('.agents');
  });

  it('P0.6 plugin marketplace — plugin surface uses ~/.agents/plugins not ~/.codex/', () => {
    // Plugins use ~/.agents/plugins/marketplace.json, NOT a path inside ~/.codex/
    const pluginPath = codexHost.surfaces['plugin']?.paths.user;
    expect(pluginPath).toBe(path.join(HOME, '.agents', 'plugins'));
    expect(pluginPath).not.toContain('.codex');
  });

  it('P0.6 codex CODEX_HOME default — user scope root is ~/.codex', () => {
    // When CODEX_HOME is not set, defaults to ~/.codex
    const expectedDefault = path.join(HOME, '.codex');
    const userScope = codexHost.scopePaths('user');
    // Either the env var value or the default
    const codexHome = process.env['CODEX_HOME'] ?? expectedDefault;
    expect(userScope.user).toBe(codexHome);
  });
});
