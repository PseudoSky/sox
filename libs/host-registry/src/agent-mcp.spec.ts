/**
 * libs/host-registry/src/agent-mcp.spec.ts
 *
 * Tests for the agent-mcp host module + its agent renderer.
 * Follows the host-registry spec conventions (vitest, real fs fixtures,
 * save/restore SOX_SANDBOX_ROOT, no mocking).
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { agentMcpHost, resolveAgentMcpEnv, defaultCatalogDbPath } from './agent-mcp.js';
import type { AgentCatalogPayload } from './agent-mcp.js';

const ENV_KEYS = ['SOX_AGENT_MCP_DATABASE_PATH', 'SOX_AGENT_MCP_REGISTRY_DB_PATH', 'ADHD_AGENT_DATABASE_PATH', 'ADHD_AGENT_REGISTRY_DB_PATH', 'SOX_SANDBOX_ROOT'];
let saved: Record<string, string | undefined>;
let sandbox: string;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-agent-mcp-'));
  process.env['SOX_SANDBOX_ROOT'] = sandbox;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('agent-mcp — host module', () => {
  it('exports host name "agent-mcp"', () => {
    expect(agentMcpHost.host).toBe('agent-mcp');
  });

  it('agent surface uses the agent-catalog capability', () => {
    expect(agentMcpHost.surfaces['agent']?.capability).toBe('agent-catalog');
  });

  it('has no surface for non-agent types', () => {
    expect(agentMcpHost.surfaces['skill']).toBeUndefined();
    expect(agentMcpHost.surfaces['mcp-server']).toBeUndefined();
  });

  it('detect() is true when ADHD_AGENT_DATABASE_PATH is pinned', () => {
    process.env['ADHD_AGENT_DATABASE_PATH'] = path.join(sandbox, 'agents.db');
    expect(agentMcpHost.detect(sandbox)).toBe(true);
  });

  it('detect() is false on a bare sandbox', () => {
    expect(agentMcpHost.detect(sandbox)).toBe(false);
  });
});

describe('agent-mcp — renderer', () => {
  const ir = {
    name: 'researcher',
    description: 'Discovery researcher',
    model: 'sonnet',
    steps: 30,
  };
  const prose = '---\nname: researcher\n---\nYou are the researcher.\n';

  it('renders a config-value create payload with the IR mapping', () => {
    const result = agentMcpHost.render!.render(ir, prose);
    expect(result.kind).toBe('config-value');
    const payload = result.value as AgentCatalogPayload;
    expect(payload.name).toBe('researcher');
    expect(payload.description).toBe('Discovery researcher');
    expect(payload.systemPrompt).toBe('You are the researcher.\n'); // frontmatter stripped
    expect(payload.mcpServers).toEqual({});
    expect(payload.permissions).toEqual({});
    expect(payload.maxToolLoops).toBe(30);
  });

  it('derives an anthropic provider from the logical "sonnet" tier', () => {
    const payload = agentMcpHost.render!.render(ir, prose).value as AgentCatalogPayload;
    expect(payload.provider.type).toBe('anthropic');
    expect(payload.provider.model).toBe('claude-sonnet-4-5');
    expect(payload.provider.env?.['secret']).toBe('ADHD_AGENT_ANTHROPIC_SECRET');
  });

  it('derives an openai provider from a deepseek model override', () => {
    const payload = agentMcpHost.render!.render(ir, prose, { model: 'deepseek-v4-flash' }).value as AgentCatalogPayload;
    expect(payload.provider.type).toBe('openai');
    expect(payload.provider.env?.['secret']).toBe('ADHD_AGENT_DEEPSEEK_SECRET');
  });

  it('honours an explicit render.agent-mcp provider override', () => {
    const provider = { type: 'claudecli', model: 'sonnet' };
    const payload = agentMcpHost.render!.render(ir, prose, { provider }).value as AgentCatalogPayload;
    expect(payload.provider).toEqual(provider);
  });

  it('honours mcpServers / permissions overrides', () => {
    const payload = agentMcpHost.render!.render(ir, prose, {
      mcpServers: { search: { transport: 'stdio' } },
      permissions: { allowedAgents: ['researcher'] },
    }).value as AgentCatalogPayload;
    expect(payload.mcpServers).toEqual({ search: { transport: 'stdio' } });
    expect(payload.permissions).toEqual({ allowedAgents: ['researcher'] });
  });

  it('throws when the IR has no name', () => {
    expect(() => agentMcpHost.render!.render({}, 'body')).toThrow(/missing the required `name`/);
  });
});

describe('agent-mcp — catalog env resolution', () => {
  it('SOX_AGENT_MCP_DATABASE_PATH wins over everything', () => {
    process.env['SOX_AGENT_MCP_DATABASE_PATH'] = '/tmp/explicit/agents.db';
    process.env['ADHD_AGENT_DATABASE_PATH'] = '/tmp/ambient/agents.db';
    const env = resolveAgentMcpEnv();
    expect(env.databasePath).toBe('/tmp/explicit/agents.db');
    expect(env.source).toBe('SOX_AGENT_MCP_DATABASE_PATH');
  });

  it('discovers the catalog from the agent-mcp registration in opencode.json', () => {
    const cfgDir = path.join(sandbox, '.config', 'opencode');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfgDir, 'opencode.json'),
      JSON.stringify({
        mcp: {
          agent: {
            type: 'local',
            command: ['npx', '-y', '@adhd/agent-mcp@latest'],
            environment: { ADHD_AGENT_DATABASE_PATH: '/srv/catalog/agents.db' },
          },
        },
      }),
      'utf8',
    );
    const env = resolveAgentMcpEnv();
    expect(env.databasePath).toBe('/srv/catalog/agents.db');
    expect(env.source).toBe('opencode.json');
  });

  it('falls back to the server zero-config when nothing is discovered', () => {
    const env = resolveAgentMcpEnv();
    expect(env.source).toBe('server-zero-config');
    expect(defaultCatalogDbPath()).toBe(path.join(sandbox, '.adhd', 'agent-mcp', 'production', 'data', 'agents.db'));
  });
});
