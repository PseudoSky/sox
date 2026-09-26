/**
 * libs/install-engine/src/capabilities/agent-catalog.spec.ts
 *
 * Unit tests for the agent-catalog capability (agent-mcp host). The real client
 * spawns the MCP server over stdio; these tests inject a fake so the capability
 * logic — idempotent upsert, portable ledger action, reverse — is exercised
 * without a live catalog.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Ledger } from '../ledger.js';
import {
  apply,
  reverse,
  AGENT_CATALOG_LEDGER_FILE,
  type AgentCatalogClient,
  type AgentCatalogPayload,
} from './agent-catalog.js';
import type { CatalogAgentDefinition } from '../agent-mcp-client.js';

const PAYLOAD: AgentCatalogPayload = {
  name: 'researcher',
  description: 'Discovery researcher',
  systemPrompt: 'You are the researcher.',
  provider: { type: 'anthropic', model: 'claude-sonnet-4-5', env: { secret: 'ADHD_AGENT_ANTHROPIC_SECRET' } },
  mcpServers: {},
  permissions: {},
};

function fakeClient(overrides?: Partial<AgentCatalogClient>): {
  client: AgentCatalogClient;
  calls: { upserts: AgentCatalogPayload[]; deletes: string[]; reads: string[] };
} {
  const calls = { upserts: [] as AgentCatalogPayload[], deletes: [] as string[], reads: [] as string[] };
  const client: AgentCatalogClient = {
    upsert: async (p) => {
      calls.upserts.push(p);
      return p as unknown as CatalogAgentDefinition;
    },
    delete: async (n) => {
      calls.deletes.push(n);
    },
    read: async (n) => {
      calls.reads.push(n);
      return null;
    },
    ...overrides,
  };
  return { client, calls };
}

let dataDir: string;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-agent-catalog-'));
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('agent-catalog capability', () => {
  it('upserts the payload and records a portable ledger action', async () => {
    const { client, calls } = fakeClient();
    const res = await apply({
      host: 'agent-mcp',
      scope: 'project',
      scopeRoot: dataDir,
      isProject: true,
      ext: 'researcher',
      target: { filePath: path.join(dataDir, 'agents.db') },
      payload: { value: PAYLOAD },
      client,
    });
    expect(res.applied).toBe(true);
    expect(calls.upserts).toHaveLength(1);
    expect(calls.upserts[0]!.name).toBe('researcher');

    const ledger = Ledger.load(dataDir, { isProject: true });
    const actions = ledger.actionsFor('researcher', 'agent-mcp', 'project');
    expect(actions).toHaveLength(1);
    expect(actions[0]!.cap).toBe('agent-catalog');
    // Portable invariant: the ledger file is a pseudo-path, never absolute.
    expect(actions[0]!.file).toBe(AGENT_CATALOG_LEDGER_FILE);
    expect(path.isAbsolute(actions[0]!.file)).toBe(false);
    expect(() => ledger.assertAllPortable()).not.toThrow();
  });

  it('is idempotent — a second apply does not accumulate ledger actions', async () => {
    const { client, calls } = fakeClient();
    const base = {
      host: 'agent-mcp',
      scope: 'project',
      scopeRoot: dataDir,
      isProject: true,
      ext: 'researcher',
      target: { filePath: path.join(dataDir, 'agents.db') },
      payload: { value: PAYLOAD },
      client,
    } as const;
    await apply(base);
    await apply(base);

    expect(calls.upserts).toHaveLength(2); // upsert (read→update-or-create) each time
    const ledger = Ledger.load(dataDir, { isProject: true });
    expect(ledger.actionsFor('researcher', 'agent-mcp', 'project')).toHaveLength(1);
  });

  it('reverse retires the row by name', async () => {
    const { client, calls } = fakeClient();
    await reverse({ ext: 'researcher', client });
    expect(calls.deletes).toEqual(['researcher']);
  });

  it('rejects a payload with no name', async () => {
    const { client } = fakeClient();
    await expect(
      apply({
        host: 'agent-mcp',
        scope: 'project',
        scopeRoot: dataDir,
        ext: 'researcher',
        target: { filePath: 'x' },
        // Build an invalid payload (empty name) to assert the capability's guard.
        payload: { value: { ...PAYLOAD, name: '' } as unknown as AgentCatalogPayload },
        client,
      }),
    ).rejects.toThrow(/name is required/);
  });
});
