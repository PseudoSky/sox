/**
 * libs/authoring — scaffold() tests.
 *
 * Covers:
 *   [generators.2] — init emits the hybrid install descriptor (serves/profiles/config)
 *   [generators.3] — --content @source fills the body + stamps source: provenance
 *   [generators.4] — output is born-conformant + byte-identical (sox init path)
 *   [generators.5] — all six type templates produce a FileSet (existence check)
 *   [ref:host-keyed-target] — no hardcoded ~/.claude/ in emitted extension.json
 */

import { describe, it, expect } from 'vitest';
import { scaffold, validateId, ACTIVE_TYPES } from './index.js';
import type { ActiveType } from './index.js';

// ─── [generators.5] All six type templates produce a FileSet ─────────────────

describe('[generators.5] all active type templates scaffold without error', () => {
  const ids: Record<ActiveType, string> = {
    agent: 'gen5-echo',
    skill: 'gen5-greet',
    'mcp-server': 'gen5-tools',
    hook: 'gen5-audit',
    command: 'gen5-run',
    bundle: 'gen5-pack',
  };

  for (const type of ACTIVE_TYPES) {
    it(`type=${type}: scaffold() returns a non-empty FileSet`, () => {
      const id = ids[type] ?? `gen5-test`;
      const fs = scaffold({ type, id, title: `Gen5 ${type}`, description: `gen5 test for ${type}` });
      expect(Object.keys(fs).length).toBeGreaterThan(0);
      expect(fs['extension.json']).toBeDefined();
    });
  }
});

// ─── [generators.2] Hybrid install descriptor (serves/profiles/config) ───────

describe('[generators.2] emitted extension.json carries install descriptor', () => {
  it('agent: extension.json has install.type = agent', () => {
    const fs = scaffold({ type: 'agent', id: 'gen2-echo', description: 'gen2 test' });
    const manifest = JSON.parse(fs['extension.json'] ?? '{}') as Record<string, unknown>;
    const install = manifest['install'] as Record<string, unknown> | undefined;
    expect(install).toBeDefined();
    expect(install?.['type']).toBe('agent');
  });

  it('mcp-server: extension.json has install.serves and install.profiles', () => {
    const fs = scaffold({
      type: 'mcp-server',
      id: 'gen2-tools',
      description: 'gen2 mcp test',
      transports: ['stdio', 'sse'],
    });
    const manifest = JSON.parse(fs['extension.json'] ?? '{}') as Record<string, unknown>;
    const install = manifest['install'] as Record<string, unknown> | undefined;
    expect(install).toBeDefined();
    expect(install?.['type']).toBe('mcp-server');
    expect(install?.['serves']).toContain('stdio');
    expect(install?.['serves']).toContain('sse');
    expect(install?.['profiles']).toBeDefined();
  });

  it('mcp-server: install.profiles ⊆ install.serves (default)', () => {
    const fs = scaffold({ type: 'mcp-server', id: 'gen2-mcp', description: 'gen2 mcp default' });
    const manifest = JSON.parse(fs['extension.json'] ?? '{}') as Record<string, unknown>;
    const install = manifest['install'] as Record<string, unknown>;
    const serves = install['serves'] as string[];
    const profiles = install['profiles'] as Record<string, unknown>;
    // Every profile transport must be in serves
    for (const [_name, def] of Object.entries(profiles)) {
      const profileDef = def as { transport?: string };
      if (profileDef.transport !== undefined) {
        expect(serves).toContain(profileDef.transport);
      }
    }
  });

  it('command: extension.json has install.type = command', () => {
    const fs = scaffold({ type: 'command', id: 'gen2-run', description: 'gen2 command test' });
    const manifest = JSON.parse(fs['extension.json'] ?? '{}') as Record<string, unknown>;
    const install = manifest['install'] as Record<string, unknown> | undefined;
    expect(install?.['type']).toBe('command');
  });

  it('skill: extension.json has install.type = skill', () => {
    const fs = scaffold({ type: 'skill', id: 'gen2-greet', description: 'gen2 skill test' });
    const manifest = JSON.parse(fs['extension.json'] ?? '{}') as Record<string, unknown>;
    expect((manifest['install'] as Record<string, unknown> | undefined)?.['type']).toBe('skill');
  });

  it('hook: extension.json has install.type = hook', () => {
    const fs = scaffold({ type: 'hook', id: 'gen2-audit', description: 'gen2 hook test' });
    const manifest = JSON.parse(fs['extension.json'] ?? '{}') as Record<string, unknown>;
    expect((manifest['install'] as Record<string, unknown> | undefined)?.['type']).toBe('hook');
  });

  it('bundle: extension.json has install.type = bundle', () => {
    const fs = scaffold({ type: 'bundle', id: 'gen2-pack', description: 'gen2 bundle test' });
    const manifest = JSON.parse(fs['extension.json'] ?? '{}') as Record<string, unknown>;
    expect((manifest['install'] as Record<string, unknown> | undefined)?.['type']).toBe('bundle');
  });

  it('mcp-server with --profile standalone: install.profiles.standalone exists', () => {
    const fs = scaffold({
      type: 'mcp-server',
      id: 'gen2-profiled',
      description: 'gen2 mcp with profile',
      profile: 'standalone',
    });
    const manifest = JSON.parse(fs['extension.json'] ?? '{}') as Record<string, unknown>;
    const install = manifest['install'] as Record<string, unknown>;
    const profiles = install['profiles'] as Record<string, unknown> | undefined;
    expect(profiles?.['standalone']).toBeDefined();
  });
});

// ─── [generators.3] --content @source stamps source: provenance ──────────────

describe('[generators.3] --content @path stamps install.source provenance', () => {
  it('source is stamped in install block when --source is set', () => {
    const fs = scaffold({
      type: 'skill',
      id: 'gen3-ingest',
      description: 'gen3 source test',
      source: '@/path/to/swarm-cost.md',
    });
    const manifest = JSON.parse(fs['extension.json'] ?? '{}') as Record<string, unknown>;
    const install = manifest['install'] as Record<string, unknown> | undefined;
    expect(install?.['source']).toBe('@/path/to/swarm-cost.md');
  });

  it('source is stamped in agent install block', () => {
    const fs = scaffold({
      type: 'agent',
      id: 'gen3-delegator',
      description: 'gen3 agent with source',
      source: '/abs/path/to/agent-def.md',
    });
    const manifest = JSON.parse(fs['extension.json'] ?? '{}') as Record<string, unknown>;
    const install = manifest['install'] as Record<string, unknown> | undefined;
    expect(install?.['source']).toBe('/abs/path/to/agent-def.md');
  });

  it('source is absent when not provided', () => {
    const fs = scaffold({ type: 'skill', id: 'gen3-plain', description: 'no source' });
    const manifest = JSON.parse(fs['extension.json'] ?? '{}') as Record<string, unknown>;
    const install = manifest['install'] as Record<string, unknown> | undefined;
    expect(install?.['source']).toBeUndefined();
  });

  it('mcp-server stamps source provenance', () => {
    const fs = scaffold({
      type: 'mcp-server',
      id: 'gen3-tools',
      description: 'gen3 mcp with source',
      source: '@~/projects/my-mcp/',
    });
    const manifest = JSON.parse(fs['extension.json'] ?? '{}') as Record<string, unknown>;
    const install = manifest['install'] as Record<string, unknown> | undefined;
    expect(install?.['source']).toBe('@~/projects/my-mcp/');
  });
});

// ─── [ref:host-keyed-target] No hardcoded ~/.claude paths in output ───────────

describe('[ref:host-keyed-target] no hardcoded host paths in emitted manifests', () => {
  const FORBIDDEN = ['.claude/', '~/.claude', '.codex/', '~/.codex'];

  // Fixed ids per type — none end with the type name
  const hktIds: Record<ActiveType, string> = {
    agent: 'hostkey-check',
    skill: 'hostkey-check',
    'mcp-server': 'hostkey-check',
    hook: 'hostkey-check',
    command: 'hostkey-check',
    bundle: 'hostkey-check',
  };

  for (const type of ACTIVE_TYPES) {
    it(`type=${type}: extension.json has no hardcoded host paths`, () => {
      const id = hktIds[type] ?? 'hostkey-check';
      const fs = scaffold({ type, id, description: `hkt ${type}` });
      const json = fs['extension.json'] ?? '';
      for (const forbidden of FORBIDDEN) {
        expect(json, `${type}/extension.json must not contain "${forbidden}"`).not.toContain(forbidden);
      }
    });
  }
});

// ─── [generators.4] Born-conformant: manifest has required fields ─────────────

describe('[generators.4] born-conformant: emitted manifests have required fields', () => {
  const REQUIRED = ['id', 'version', 'type', 'title', 'description', 'compatibility', 'license'] as const;

  // Valid test ids that don't end with the type name
  const bcIds: Record<ActiveType, string> = {
    agent: 'born-conformant',
    skill: 'born-conformant',
    'mcp-server': 'born-conformant',
    hook: 'born-conformant',
    command: 'born-conformant',
    bundle: 'born-conformant',
  };

  for (const type of ACTIVE_TYPES) {
    it(`type=${type}: extension.json has all required manifest fields`, () => {
      const id = bcIds[type] ?? 'born-conformant';
      const fs = scaffold({ type, id, title: `BC ${type}`, description: `born-conformant ${type}` });
      const manifest = JSON.parse(fs['extension.json'] ?? '{}') as Record<string, unknown>;
      for (const field of REQUIRED) {
        expect(manifest[field], `${type}/extension.json missing ${field}`).toBeDefined();
      }
      expect(manifest['id']).toBe(id);
      expect(manifest['type']).toBe(type);
    });
  }
});

// ─── validateId ───────────────────────────────────────────────────────────────

describe('validateId()', () => {
  it('accepts valid kebab-case id', () => {
    expect(validateId('my-tool', 'command')).toBeNull();
  });
  it('rejects id ending with type name (dash-prefixed)', () => {
    expect(validateId('my-command', 'command')).not.toBeNull();
  });
  it('rejects id that IS the type name', () => {
    expect(validateId('agent', 'agent')).not.toBeNull();
  });
  it('rejects id with uppercase', () => {
    expect(validateId('MyTool', 'command')).not.toBeNull();
  });
  it('rejects id starting with digit', () => {
    expect(validateId('1tool', 'command')).not.toBeNull();
  });
});
