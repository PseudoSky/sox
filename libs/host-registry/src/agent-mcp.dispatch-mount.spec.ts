/**
 * libs/host-registry/src/agent-mcp.dispatch-mount.spec.ts
 *
 * The builtin dispatch server key `agent-mcp` is mounted by
 * `nativeTooling.dispatch` (ADR-0008 D1), never by an `mcpServers` entry. The
 * renderer must not warn "not mounted" for it while dispatch is on, must not
 * weld an `agent-mcp` entry, and must still drop any self-referential stdio
 * entry that launches agent-mcp.
 */

import { describe, it, expect } from 'vitest';

import { agentMcpHost } from './agent-mcp.js';
import type { AgentCatalogPayload } from './agent-mcp.js';
import type { RenderedArtifact } from './internal.js';

const prose = '---\nname: dispatcher\n---\nYou dispatch.\n';
const ir = {
  name: 'dispatcher',
  model: 'opus',
  tools: [{ logical: 'agent-catalog', server: 'agent-mcp' }, 'read'],
};
const baseOverride = {
  model: 'deepseek/deepseek-flash',
  mcpServers: { search: { transport: 'stdio', command: 'node', args: ['s.mjs'] } },
};

function render(
  override: Record<string, unknown>,
  irIn: Record<string, unknown> = ir,
): { payload: AgentCatalogPayload; warnings: string[] } {
  const r: RenderedArtifact = agentMcpHost.render!.render(irIn, prose, override);
  if (r.kind !== 'config-value') throw new Error(`expected config-value, got ${r.kind}`);
  return { payload: r.value as AgentCatalogPayload, warnings: r.report?.warnings ?? [] };
}

describe('agent-mcp renderer — dispatch server key is mounted natively', () => {
  it('faa8064b SHELL-AC3: dispatcher render has no "not mounted" warning, dispatch on, no agent-mcp mcpServers key', () => {
    const { payload, warnings } = render(baseOverride);
    expect(warnings.filter((w) => /not mounted/.test(w))).toEqual([]);
    expect(payload.nativeTooling.dispatch).toBeTruthy();
    expect(Object.keys(payload.mcpServers)).not.toContain('agent-mcp');
  });

  it('faa8064b SHELL-AC3: a fixture IR with agent-catalog referenced and dispatch:false still warns not mounted', () => {
    const { payload, warnings } = render({ ...baseOverride, nativeTooling: { dispatch: false } });
    expect(payload.nativeTooling.dispatch).toBe(false);
    expect(warnings.filter((w) => /mcpServers\.agent-mcp.*not mounted/.test(w))).toHaveLength(1);
    expect(Object.keys(payload.mcpServers)).not.toContain('agent-mcp');
  });

  it('faa8064b MOUNT-AC1: a self-referential stdio agent-mcp launch entry is dropped, never rendered', () => {
    const selfRef = {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@adhd/agent-mcp@latest'],
      env: { ADHD_AGENT_DATABASE_PATH: '/x/agents.db' },
    };
    const { payload, warnings } = render(
      { ...baseOverride, toolMap: { loop: 'agent' }, mcpServers: { ...baseOverride.mcpServers, agent: selfRef } },
      { name: 'performance', model: 'opus', tools: ['read', { logical: 'loop', server: 'agent' }] },
    );
    expect(Object.keys(payload.mcpServers)).not.toContain('agent');
    expect(JSON.stringify(payload.mcpServers)).not.toContain('agent-mcp');
    expect(warnings.some((w) => /mcpServers\.agent: stdio entry launches agent-mcp itself — dropped/.test(w))).toBe(true);
  });
});
