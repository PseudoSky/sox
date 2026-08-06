/**
 * libs/host-registry/src/opencode.spec.ts
 *
 * Tests for the OpenCode host module.
 * Follows the EXACT patterns from host-registry.spec.ts:
 *   - vitest with no globals, node environment
 *   - real filesystem temp dir fixtures (mkdtempSync / rmSync)
 *   - save/restore SOX_SANDBOX_ROOT env var
 *   - NO mocking
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { opencodeHost } from './opencode.js';

const HOME = os.homedir();

// ─── HostModule interface ─────────────────────────────────────────────────────

describe('opencode — host module', () => {
  it('exports host name "opencode"', () => {
    expect(opencodeHost.host).toBe('opencode');
  });

  it('exports detect, scopePaths, surfaces', () => {
    expect(typeof opencodeHost.detect).toBe('function');
    expect(typeof opencodeHost.scopePaths).toBe('function');
    expect(typeof opencodeHost.surfaces).toBe('object');
  });
});

// ─── detect() — real filesystem fixtures ──────────────────────────────────────

describe('opencode.detect()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-opencode-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns true when opencode.json exists', () => {
    fs.writeFileSync(path.join(tmpDir, 'opencode.json'), '{}');
    expect(opencodeHost.detect(tmpDir)).toBe(true);
  });

  it('returns true when .opencode/ dir exists', () => {
    fs.mkdirSync(path.join(tmpDir, '.opencode'));
    expect(opencodeHost.detect(tmpDir)).toBe(true);
  });

  it('returns false for empty workspace', () => {
    expect(opencodeHost.detect(tmpDir)).toBe(false);
  });
});

// ─── scopePaths() — without SOX_SANDBOX_ROOT ──────────────────────────────────

describe('opencode.scopePaths()', () => {
  let savedSandbox: string | undefined;

  beforeEach(() => {
    savedSandbox = process.env['SOX_SANDBOX_ROOT'];
    delete process.env['SOX_SANDBOX_ROOT'];
  });

  afterEach(() => {
    if (savedSandbox === undefined) {
      delete process.env['SOX_SANDBOX_ROOT'];
    } else {
      process.env['SOX_SANDBOX_ROOT'] = savedSandbox;
    }
  });

  it('project scope returns { project: ".opencode" }', () => {
    expect(opencodeHost.scopePaths('project')).toEqual({ project: '.opencode' });
  });

  it('user scope returns { user: "$HOME/.config/opencode" }', () => {
    const paths = opencodeHost.scopePaths('user');
    expect(paths.user).toBe(path.join(HOME, '.config', 'opencode'));
    expect(path.isAbsolute(paths.user as string)).toBe(true);
  });

  it('local scope returns { local: ".opencode" }', () => {
    expect(opencodeHost.scopePaths('local')).toEqual({ local: '.opencode' });
  });

  it('org scope returns {}', () => {
    expect(opencodeHost.scopePaths('org')).toEqual({});
  });
});

// ─── surfaces ─────────────────────────────────────────────────────────────────

describe('opencode.surfaces', () => {
  let savedSandbox: string | undefined;

  beforeEach(() => {
    savedSandbox = process.env['SOX_SANDBOX_ROOT'];
    delete process.env['SOX_SANDBOX_ROOT'];
  });

  afterEach(() => {
    if (savedSandbox === undefined) {
      delete process.env['SOX_SANDBOX_ROOT'];
    } else {
      process.env['SOX_SANDBOX_ROOT'] = savedSandbox;
    }
  });

  it('has agent surface with file-drop capability', () => {
    expect(opencodeHost.surfaces.agent.capability).toBe('file-drop');
  });

  it('agent surface paths point to .opencode/agents', () => {
    const s = opencodeHost.surfaces.agent;
    expect(s.paths.project).toBe('.opencode/agents');
    expect(s.paths.user).toBe(path.join(HOME, '.config', 'opencode', 'agents'));
  });

  it('has skill surface with file-drop capability', () => {
    expect(opencodeHost.surfaces.skill.capability).toBe('file-drop');
  });

  it('skill surface paths point to .opencode/skills', () => {
    const s = opencodeHost.surfaces.skill;
    expect(s.paths.project).toBe('.opencode/skills');
    expect(s.paths.user).toBe(path.join(HOME, '.config', 'opencode', 'skills'));
  });

  it('has command surface with file-drop capability', () => {
    expect(opencodeHost.surfaces.command.capability).toBe('file-drop');
  });

  it('command surface paths point to .opencode/tools', () => {
    const s = opencodeHost.surfaces.command;
    expect(s.paths.project).toBe('.opencode/tools');
    expect(s.paths.user).toBe(path.join(HOME, '.config', 'opencode', 'tools'));
    expect(s.paths.local).toBe('.opencode/tools');
  });

  it('has mcp-server surface with config-merge capability', () => {
    const s = opencodeHost.surfaces['mcp-server'];
    expect(s.capability).toBe('config-merge');
    expect(s.format).toBe('json');
  });

  it('mcp-server surface has mcpConfig defined', () => {
    const s = opencodeHost.surfaces['mcp-server'];
    expect(s.mcpConfig).toBeDefined();
  });

  it('mcpConfig.keyPath returns mcp.{extId}', () => {
    const s = opencodeHost.surfaces['mcp-server'];
    expect(s.mcpConfig!.keyPath('memory-server')).toBe('mcp.memory-server');
  });

  it('mcpConfig.keyPath returns mcp.{extId} for other extensions', () => {
    const s = opencodeHost.surfaces['mcp-server'];
    expect(s.mcpConfig!.keyPath('foo-bar')).toBe('mcp.foo-bar');
  });

  it('mcpConfig.value stdio returns local type with command array', () => {
    const s = opencodeHost.surfaces['mcp-server'];
    const val = s.mcpConfig!.value('stdio', 'soxe', 'memory-server');
    expect(val).toEqual({ type: 'local', command: ['soxe', 'serve', 'memory-server'] });
  });

  it('mcpConfig.value sse returns remote type with default port 3000', () => {
    const s = opencodeHost.surfaces['mcp-server'];
    const val = s.mcpConfig!.value('sse', 'soxe', 'memory-server');
    expect(val).toEqual({ type: 'remote', url: 'http://localhost:3000/sse' });
  });

  it('mcpConfig.value http returns remote type with default port 3000', () => {
    const s = opencodeHost.surfaces['mcp-server'];
    const val = s.mcpConfig!.value('http', 'soxe', 'memory-server');
    expect(val).toEqual({ type: 'remote', url: 'http://localhost:3000/sse' });
  });

  it('mcpConfig.value http uses port parameter (TR-3)', () => {
    const s = opencodeHost.surfaces['mcp-server'];
    const val = s.mcpConfig!.value('http', 'soxe', 'memory-server', 4111);
    expect(val).toEqual({ type: 'remote', url: 'http://localhost:4111/sse' });
  });

  it('mcpConfig.value http uses bindAddress parameter (TR-4)', () => {
    const s = opencodeHost.surfaces['mcp-server'];
    const val = s.mcpConfig!.value('http', 'soxe', 'memory-server', 3099, '0.0.0.0');
    expect(val).toEqual({ type: 'remote', url: 'http://0.0.0.0:3099/sse' });
  });

  it('mcpConfig.value http displays localhost for 127.0.0.1 bind (TR-4)', () => {
    const s = opencodeHost.surfaces['mcp-server'];
    // 127.0.0.1 should be displayed as localhost for portability
    const val = s.mcpConfig!.value('http', 'soxe', 'memory-server', 3099, '127.0.0.1');
    expect(val).toEqual({ type: 'remote', url: 'http://localhost:3099/sse' });
  });

  it('mcpConfig.value http displays localhost for ::1 bind (TR-4)', () => {
    const s = opencodeHost.surfaces['mcp-server'];
    const val = s.mcpConfig!.value('http', 'soxe', 'memory-server', 3099, '::1');
    expect(val).toEqual({ type: 'remote', url: 'http://localhost:3099/sse' });
  });

  // The six expectations above pin a COSMETIC choice, and that is why they went
  // stale silently: `0453979` deliberately moved the emitted path from `/mcp` to
  // `/sse` and did not update them, so this suite has been red on `main` for two
  // weeks. What is NOT cosmetic — and what nothing here asserted — is that `sse`
  // and `http` must resolve to the SAME endpoint, because OpenCode POSTs
  // StreamableHTTP JSON-RPC to whatever URL it is given regardless of path, and
  // the shim accepts both (`libs/service-proxy/src/shim.ts`:546 —
  // `req.url === '/mcp' || req.url === '/sse'`). Pinning the equivalence rather
  // than only the literal means a future path change breaks one test with an
  // obvious cause, instead of six with none.
  it('mcpConfig.value sse and http resolve to the same endpoint (the choice is cosmetic)', () => {
    const s = opencodeHost.surfaces['mcp-server'];
    const sse = s.mcpConfig!.value('sse', 'soxe', 'memory-server', 3099, '127.0.0.1');
    const http = s.mcpConfig!.value('http', 'soxe', 'memory-server', 3099, '127.0.0.1');
    expect(sse).toEqual(http);
    // …and the path is one the shim actually serves. If this list and shim.ts's
    // POST guard ever diverge, the host config points somewhere nothing answers.
    const { url } = http as { url: string };
    expect(['/mcp', '/sse']).toContain(new URL(url).pathname);
  });

  it('has service surface with run-service capability', () => {
    expect(opencodeHost.surfaces.service.capability).toBe('run-service');
  });

  it('service surface paths point to .sox', () => {
    const s = opencodeHost.surfaces.service;
    expect(s.paths.project).toBe('.sox');
    expect(s.paths.user).toBe(path.join(HOME, '.sox'));
  });
});

// ─── SOX_SANDBOX_ROOT sandbox isolation — [inv:sandbox-isolation] ─────────────

describe('opencode.scopePaths() with SOX_SANDBOX_ROOT', () => {
  let savedSandbox: string | undefined;

  beforeEach(() => {
    savedSandbox = process.env['SOX_SANDBOX_ROOT'];
    process.env['SOX_SANDBOX_ROOT'] = '/tmp/sandbox';
  });

  afterEach(() => {
    if (savedSandbox === undefined) {
      delete process.env['SOX_SANDBOX_ROOT'];
    } else {
      process.env['SOX_SANDBOX_ROOT'] = savedSandbox;
    }
  });

  it('user scope reroots to sandbox', () => {
    const paths = opencodeHost.scopePaths('user');
    expect(paths.user).toBe(path.join('/tmp/sandbox', '.config', 'opencode'));
    // Must NOT be the real home
    expect(paths.user).not.toBe(path.join(HOME, '.config', 'opencode'));
  });

  it('surfaces reroot to sandbox', () => {
    const s = opencodeHost.surfaces.skill;
    expect(s.paths.user).toBe(path.join('/tmp/sandbox', '.config', 'opencode', 'skills'));
    expect(s.paths.user).not.toContain(HOME);
  });

  it('project and local scopes are unaffected by SOX_SANDBOX_ROOT (relative paths)', () => {
    expect(opencodeHost.scopePaths('project').project).toBe('.opencode');
    expect(opencodeHost.scopePaths('local').local).toBe('.opencode');
  });

  it('mcp-server surface user path reroots to sandbox', () => {
    const s = opencodeHost.surfaces['mcp-server'];
    expect(s.paths.user).toBe(path.join('/tmp/sandbox', '.config', 'opencode', 'opencode.json'));
    expect(s.paths.user).not.toContain(HOME);
  });

  it('paths restore to HOME-based values when SOX_SANDBOX_ROOT is unset', () => {
    // verify sandboxed
    expect(opencodeHost.scopePaths('user').user).toBe(path.join('/tmp/sandbox', '.config', 'opencode'));
    // unset
    delete process.env['SOX_SANDBOX_ROOT'];
    // verify restored
    expect(opencodeHost.scopePaths('user').user).toBe(path.join(HOME, '.config', 'opencode'));
  });
});

// ─── [inv:never-managed] — org scope always empty ─────────────────────────────

describe('opencode — [inv:never-managed]', () => {
  it('scopePaths("org") returns an empty object — no managed-tier path emitted', () => {
    expect(Object.keys(opencodeHost.scopePaths('org'))).toHaveLength(0);
  });

  it('no surface has an org-scoped path', () => {
    for (const [surfaceName, surface] of Object.entries(opencodeHost.surfaces)) {
      expect(
        surface.paths['org'],
        `surface "${surfaceName}" must not have an org-scoped path (managed tier)`
      ).toBeUndefined();
    }
  });

  it('scopePaths never returns a path containing "managed" for any scope', () => {
    const ALL_SCOPES: Array<'project' | 'user' | 'local' | 'org'> = [
      'project',
      'user',
      'local',
      'org',
    ];
    for (const scope of ALL_SCOPES) {
      const result = opencodeHost.scopePaths(scope);
      const paths = Object.values(result).filter(Boolean) as string[];
      for (const p of paths) {
        expect(p.toLowerCase()).not.toContain('managed');
      }
    }
  });
});
