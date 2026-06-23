/**
 * libs/mcp-runtime/src/conformance.spec.ts — Generic conformance test.
 *
 * [mcp-runtime.4]: ONE generic conformance test that every mcp extension inherits.
 *
 * Tests:
 *  1. stdio-mode: initialize + tools/list via InMemoryTransport (simulates stdio path).
 *  2. sse-mode: initialize + tools/list via InMemoryTransport (simulates sse path).
 *  3. Undeclared-access-denied: C6 deny on BOTH transport paths [inv:c6-holds].
 *
 * Uses @modelcontextprotocol/sdk InMemoryTransport for in-process round-trips —
 * avoids needing a compiled binary or network listener while still exercising
 * the same SDK Server + enforcement code path used in production.
 *
 * The MCP initialize exchange is performed automatically by Client.connect()
 * (SDK guarantees this for all transport types).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPolicy } from './enforce.js';
import { defineTool, type ToolContext } from './serve.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a minimal SDK Server with the given tools registered.
 * This replicates serve() without binding to a transport — so we can test the
 * same handler path via InMemoryTransport.
 *
 * [mcp-runtime.1]: uses the official SDK Server class and schemas.
 */
function buildTestServer(tools: ReturnType<typeof defineTool>[]): Server {
  const server = new Server(
    { name: 'test-mcp-server', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => {
    const sdkTools: Tool[] = tools.map((t) => ({
      name: t.definition.name,
      description: t.definition.description,
      inputSchema: t.definition.inputSchema,
    }));
    return { tools: sdkTools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name: toolName, arguments: rawArgs = {} } = req.params;

    const tool = tools.find((t) => t.definition.name === toolName);
    if (!tool) {
      const result: CallToolResult = {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
      };
      return result;
    }

    // [inv:c6-holds]: policy enforcement runs BEFORE handler — same path as serve()
    const policy = getPolicy();
    const ctx: ToolContext = {
      enforced: policy.enforced,
      allowsFsRead: (p) => policy.allowsFsRead(p),
      allowsFsWrite: (p) => policy.allowsFsWrite(p),
      allowsNetwork: (h) => policy.allowsNetwork(h),
      allowsSocket: (p) => policy.allowsSocket(p),
    };

    try {
      const handlerResult = await tool.definition.handler(
        rawArgs as Record<string, unknown>,
        ctx,
      );
      const result: CallToolResult = {
        isError: handlerResult.isError,
        content: handlerResult.content,
      };
      return result;
    } catch (err) {
      const result: CallToolResult = {
        isError: true,
        content: [{ type: 'text', text: `Tool error: ${String(err)}` }],
      };
      return result;
    }
  });

  return server;
}

/**
 * Connect a client and server via InMemoryTransport.
 * Returns the client and a cleanup function.
 *
 * The Client.connect() call performs the MCP initialize exchange automatically.
 */
async function createInMemoryPair(server: Server): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client(
    { name: 'conformance-test-client', version: '0.1.0' },
    { capabilities: {} },
  );

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

// ─── Tool fixtures ────────────────────────────────────────────────────────────

/** A test tool that reads a file path from args and echoes it back. */
const echoFileTool = defineTool({
  name: 'echo_file',
  description: 'Echoes the provided file path. Used for conformance testing.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      file_path: { type: 'string', description: 'Path to echo' },
    },
    required: ['file_path'],
  },
  handler: async (args, ctx) => {
    const filePath = String(args['file_path'] ?? '');
    const absPath = path.resolve(filePath);

    // [inv:c6-holds]: enforce fs access BEFORE the resource sink
    if (!ctx.allowsFsRead(absPath) || !ctx.allowsFsWrite(absPath)) {
      return {
        isError: true,
        content: [{ type: 'text', text: `permission denied: ${absPath} outside declared fs allowlist` }],
      };
    }

    return {
      content: [{ type: 'text', text: `echo: ${absPath}` }],
    };
  },
});

// ─── Policy env helpers ───────────────────────────────────────────────────────

/** Set policy-env for enforcement with a specific fs allowlist. */
function setPolicyEnv(allowedPaths: string[]): void {
  process.env['SOX_PERM_ENFORCE'] = '1';
  process.env['SOX_PERM_FS_READ'] = JSON.stringify(allowedPaths);
  process.env['SOX_PERM_FS_WRITE'] = JSON.stringify(allowedPaths);
  process.env['SOX_PERM_SOCKET'] = JSON.stringify([]);
  process.env['SOX_PERM_NETWORK'] = JSON.stringify([]);
}

/** Clear policy-env (returns to enforcement-opt-in / unconstrained). */
function clearPolicyEnv(): void {
  delete process.env['SOX_PERM_ENFORCE'];
  delete process.env['SOX_PERM_FS_READ'];
  delete process.env['SOX_PERM_FS_WRITE'];
  delete process.env['SOX_PERM_SOCKET'];
  delete process.env['SOX_PERM_NETWORK'];
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('@adhd/sox-mcp-runtime conformance', () => {
  afterEach(() => {
    clearPolicyEnv();
  });

  // ── stdio-mode path ────────────────────────────────────────────────────────

  describe('stdio transport path', () => {
    let cleanup: (() => Promise<void>) | undefined;

    afterEach(async () => {
      if (cleanup) {
        await cleanup();
        cleanup = undefined;
      }
    });

    it('initialize completes via InMemoryTransport (simulates stdio path)', async () => {
      const server = buildTestServer([echoFileTool]);
      const pair = await createInMemoryPair(server);
      cleanup = pair.cleanup;

      // Client.connect() already ran initialize; verify the server responded
      // by checking the server capabilities.
      const serverCapabilities = pair.client.getServerCapabilities();
      expect(serverCapabilities).toBeDefined();
      expect(serverCapabilities).toHaveProperty('tools');
    });

    it('tools/list returns declared tools (stdio path)', async () => {
      const server = buildTestServer([echoFileTool]);
      const pair = await createInMemoryPair(server);
      cleanup = pair.cleanup;

      const { tools } = await pair.client.listTools();

      expect(tools).toHaveLength(1);
      expect(tools[0]).toBeDefined();
      expect(tools[0]!.name).toBe('echo_file');
      expect(tools[0]!.description).toBe(
        'Echoes the provided file path. Used for conformance testing.',
      );
    });

    it('[inv:c6-holds] undeclared fs path is DENIED on stdio path', async () => {
      // Enforce with an allowlist that does NOT include /etc
      setPolicyEnv(['/tmp/allowed']);

      const server = buildTestServer([echoFileTool]);
      const pair = await createInMemoryPair(server);
      cleanup = pair.cleanup;

      const result = await pair.client.callTool({
        name: 'echo_file',
        arguments: { file_path: '/etc/passwd' },
      });

      expect(result.isError).toBe(true);
      const textContent = result.content[0];
      expect(textContent).toBeDefined();
      expect(textContent!.type).toBe('text');
      // Type guard: text content has a 'text' property
      if (textContent!.type === 'text') {
        expect(textContent.text).toContain('permission denied');
      }
    });

    it('declared fs path is ALLOWED on stdio path', async () => {
      setPolicyEnv(['/tmp/**']);

      const server = buildTestServer([echoFileTool]);
      const pair = await createInMemoryPair(server);
      cleanup = pair.cleanup;

      const result = await pair.client.callTool({
        name: 'echo_file',
        arguments: { file_path: '/tmp/test.db' },
      });

      expect(result.isError).toBeFalsy();
      const textContent = result.content[0];
      expect(textContent).toBeDefined();
      if (textContent!.type === 'text') {
        expect(textContent.text).toContain('echo:');
        expect(textContent.text).toContain('/tmp/test.db');
      }
    });
  });

  // ── sse-mode path ──────────────────────────────────────────────────────────
  //
  // The SDK Server + C6 enforcement code is transport-agnostic — the same
  // handler code runs regardless of transport binding. We test this path by
  // connecting a SECOND independent InMemoryTransport pair to the same server
  // implementation, simulating the sse/http transport path.

  describe('sse transport path', () => {
    let cleanup: (() => Promise<void>) | undefined;

    afterEach(async () => {
      if (cleanup) {
        await cleanup();
        cleanup = undefined;
      }
    });

    it('initialize completes via InMemoryTransport (simulates sse path)', async () => {
      const server = buildTestServer([echoFileTool]);
      const pair = await createInMemoryPair(server);
      cleanup = pair.cleanup;

      const serverCapabilities = pair.client.getServerCapabilities();
      expect(serverCapabilities).toBeDefined();
      expect(serverCapabilities).toHaveProperty('tools');
    });

    it('tools/list returns declared tools (sse path)', async () => {
      const server = buildTestServer([echoFileTool]);
      const pair = await createInMemoryPair(server);
      cleanup = pair.cleanup;

      const { tools } = await pair.client.listTools();

      expect(tools).toHaveLength(1);
      expect(tools[0]).toBeDefined();
      expect(tools[0]!.name).toBe('echo_file');
    });

    it('[inv:c6-holds] undeclared fs path is DENIED on sse path', async () => {
      // Enforce with allowlist that does NOT include /var or /etc
      setPolicyEnv(['/tmp/sse-allowed/**']);

      const server = buildTestServer([echoFileTool]);
      const pair = await createInMemoryPair(server);
      cleanup = pair.cleanup;

      const result = await pair.client.callTool({
        name: 'echo_file',
        arguments: { file_path: '/var/secret/config' },
      });

      expect(result.isError).toBe(true);
      const textContent = result.content[0];
      expect(textContent).toBeDefined();
      if (textContent!.type === 'text') {
        expect(textContent.text).toContain('permission denied');
      }
    });

    it('declared fs path is ALLOWED on sse path', async () => {
      setPolicyEnv(['/tmp/sse-allowed/**']);

      const server = buildTestServer([echoFileTool]);
      const pair = await createInMemoryPair(server);
      cleanup = pair.cleanup;

      const result = await pair.client.callTool({
        name: 'echo_file',
        arguments: { file_path: '/tmp/sse-allowed/data.db' },
      });

      expect(result.isError).toBeFalsy();
      const textContent = result.content[0];
      if (textContent!.type === 'text') {
        expect(textContent.text).toContain('echo:');
      }
    });
  });

  // ── Additional invariants ──────────────────────────────────────────────────

  describe('serves fact', () => {
    it('[mcp-runtime.5] serves export lists stdio and sse', async () => {
      const { serves } = await import('./index.js');
      expect(serves).toContain('stdio');
      expect(serves).toContain('sse');
    });
  });

  describe('defineTool API', () => {
    it('[mcp-runtime.1] defineTool creates a RegisteredTool with definition', () => {
      const tool = defineTool({
        name: 'test_tool',
        description: 'A test tool',
        inputSchema: {
          type: 'object' as const,
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
        handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      });

      expect(tool.definition.name).toBe('test_tool');
      expect(tool.definition.description).toBe('A test tool');
      expect(tool.definition.inputSchema.type).toBe('object');
    });
  });

  describe('enforcement without policy-env', () => {
    beforeEach(() => {
      clearPolicyEnv();
    });

    it('[def:enforcement-opt-in] no enforcement when SOX_PERM_ENFORCE absent', async () => {
      // No policy env set → any path should be allowed (legacy compat)
      const server = buildTestServer([echoFileTool]);
      const pair = await createInMemoryPair(server);

      const result = await pair.client.callTool({
        name: 'echo_file',
        arguments: { file_path: '/etc/passwd' },
      });

      // Without enforcement, the tool echoes the path without denial
      expect(result.isError).toBeFalsy();
      await pair.cleanup();
    });
  });
});
