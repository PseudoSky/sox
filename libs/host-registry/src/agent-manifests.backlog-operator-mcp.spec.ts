/**
 * libs/host-registry/src/agent-manifests.backlog-operator-mcp.spec.ts
 *
 * Ticket 515a2b50: backlog-operator on the sox-only agent-mcp server rendered
 * with `mcpServers: {}` because its IR `agent.tools` carried no
 * `{logical:'backlog', server:'backlog'}` entry. The renderer selects MCP servers
 * ONLY from `ir.tools` (least privilege), so the launch block under
 * `render.agent-mcp.mcpServers.backlog` was defined but never mounted, and the
 * operator fell back to the srt-sandboxed CLI (lease EPERM). Reads the real
 * manifests, no fixtures.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

import { agentMcpHost } from './agent-mcp.js';
import type { AgentCatalogPayload } from './agent-mcp.js';
import type { RenderedArtifact } from './internal.js';

const AGENTS_DIR = resolve(__dirname, '../../../extensions/agents');

interface IManifest {
  agent: Record<string, unknown>;
  render: { 'agent-mcp': Record<string, any>; claude?: Record<string, unknown> };
  version: string;
}

function readManifest(name: string): IManifest {
  return JSON.parse(readFileSync(join(AGENTS_DIR, name, 'extension.json'), 'utf8')) as IManifest;
}

function renderPayload(name: string): AgentCatalogPayload {
  const m = readManifest(name);
  const r: RenderedArtifact = agentMcpHost.render!.render(m.agent, `---\nname: ${name}\n---\nbody\n`, m.render['agent-mcp']);
  if (r.kind !== 'config-value') throw new Error(`expected config-value, got ${r.kind}`);
  return r.value as AgentCatalogPayload;
}

describe('515a2b50: backlog-operator mounts the backlog MCP server', () => {
  it('515a2b50 AC1: rendered agent-mcp config for backlog-operator has mcpServers containing backlog', () => {
    const payload = renderPayload('backlog-operator');
    expect(Object.keys(payload.mcpServers)).toContain('backlog');
    expect(payload.mcpServers['backlog']).toMatchObject({ transport: 'stdio', command: 'npx' });
  });

  it('515a2b50 AC1: only the backlog server is mounted (memory/gitnexus/search stay unselected, least privilege)', () => {
    expect(Object.keys(renderPayload('backlog-operator').mcpServers)).toEqual(['backlog']);
  });

  it('515a2b50 AC1: backlog-operator agent.tools declares the backlog capability object', () => {
    const tools = readManifest('backlog-operator').agent['tools'] as unknown[];
    expect(tools).toContainEqual({ logical: 'backlog', server: 'backlog' });
  });

  it('515a2b50 AC2: backlog-operator version is 0.6.4 in extension.json, package.json and CHANGELOG', () => {
    const dir = join(AGENTS_DIR, 'backlog-operator');
    expect(readManifest('backlog-operator').version).toBe('0.6.4');
    expect(readManifest('backlog-operator').render['claude']?.['version']).toBe('v0.6.4');
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version).toBe('0.6.4');
    const changelog = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toMatch(/^## 0\.6\.4$/m);
    expect(changelog.indexOf('## 0.6.4')).toBeLessThan(changelog.indexOf('## 0.6.3'));
  });

  it('515a2b50 AC3: adhd-backlog stays in the backlog-operator shell allowlist and renders into the payload', () => {
    const declared = readManifest('backlog-operator').render['agent-mcp']['nativeTooling'].shell.allowCommands as string[];
    expect(declared).toContain('adhd-backlog');
    expect(renderPayload('backlog-operator').nativeTooling.shell).toMatchObject({ allowCommands: expect.arrayContaining(['adhd-backlog']) });
  });

  it('515a2b50 AC4: every other agent mounts backlog exactly when its own tools declare it (no cross-agent change)', () => {
    const others = readdirSync(AGENTS_DIR).filter((x) => x !== 'backlog-operator' && existsSync(join(AGENTS_DIR, x, 'extension.json')));
    expect(others.length).toBeGreaterThan(0);
    for (const d of others) {
      const declaresBacklog = ((readManifest(d).agent['tools'] as unknown[] | undefined) ?? []).some(
        (t) => typeof t === 'object' && t !== null && (t as { logical?: string }).logical === 'backlog',
      );
      expect(Object.keys(renderPayload(d).mcpServers).includes('backlog'), `${d}: backlog mount must equal its tools declaration`).toBe(declaresBacklog);
    }
  });
});
