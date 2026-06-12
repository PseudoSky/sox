/**
 * scripts/host/registrar.ts — MCP host-side registrar.
 *
 * CONTRACT GAP CLOSED (audit Gap C2):
 *   Discovers tools from a running MCP server (spawned by the supervisor in mcp.ts)
 *   and exposes them to the agent surface. This is the CLIENT counterpart to the
 *   server-side stdio transport in extensions/mcp-servers/memory-server/src/index.ts.
 *
 * Protocol: MCP stdio JSON-RPC 2.0.
 *   Step 1: send `initialize` → get serverInfo + capabilities
 *   Step 2: send `tools/list`  → get tool descriptors
 *   Tools are then accessible via `McpRegistrar.tools(serverKey)` and
 *   `McpRegistrar.call(serverKey, toolName, args)`.
 *
 * Security (Gap F5 / PB handoff):
 *   The registrar does NOT expose the unsandboxed caller-supplied `db_path` to multiple
 *   clients without the permission contract. Tool calls pass through args as-is from the
 *   caller — the caller must supply `db_path` explicitly. This is the conservative-default
 *   gating posture the plan specifies: no automatic injection of caller env into args.
 *
 * Design: integrates ON TOP of P4's supervisor. The supervisor owns the process lifecycle;
 *   the registrar owns the protocol negotiation and tool surface exposure.
 */

import { type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface McpToolDescriptor {
  name: string;
  description?: string | undefined;
  inputSchema?: Record<string, unknown> | undefined;
}

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpRegistration {
  serverKey: string;
  serverInfo: McpServerInfo;
  tools: McpToolDescriptor[];
  /** Whether the registration is live (process alive). */
  live: boolean;
}

export interface McpCallResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean | undefined;
}

// ─── JSON-RPC helpers ─────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

// ─── McpClient ────────────────────────────────────────────────────────────────

/**
 * Lightweight MCP stdio JSON-RPC client.
 * Wraps a spawned process's stdio streams to perform protocol calls.
 */
export class McpClient {
  private _idCounter = 1;
  private readonly _pendingCalls = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  private readonly _rl: readline.Interface;

  constructor(private readonly _proc: ChildProcess) {
    if (!_proc.stdout) {
      throw new Error('[mcp-client] Process has no stdout stream');
    }
    this._rl = readline.createInterface({ input: _proc.stdout, crlfDelay: Infinity });
    this._rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        const pending = this._pendingCalls.get(msg.id);
        if (!pending) return;
        this._pendingCalls.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          pending.resolve(msg.result);
        }
      } catch {
        // Non-JSON line — ignore (server may emit startup logs)
      }
    });
    _proc.on('exit', () => {
      for (const [id, pending] of this._pendingCalls) {
        pending.reject(new Error('[mcp-client] Process exited before response received'));
        this._pendingCalls.delete(id);
      }
    });
  }

  /** Send a JSON-RPC request and await its response. */
  call(method: string, params?: unknown, timeoutMs = 10000): Promise<unknown> {
    const id = this._idCounter++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };

    return new Promise((resolve, reject) => {
      this._pendingCalls.set(id, { resolve, reject });

      const timer = setTimeout(() => {
        if (this._pendingCalls.has(id)) {
          this._pendingCalls.delete(id);
          reject(new Error(`[mcp-client] Timeout waiting for "${method}" response (${timeoutMs}ms)`));
        }
      }, timeoutMs);

      // Clear timer when resolved/rejected
      const origResolve = resolve;
      const origReject = reject;
      this._pendingCalls.set(id, {
        resolve: (v) => { clearTimeout(timer); origResolve(v); },
        reject: (e) => { clearTimeout(timer); origReject(e); },
      });

      if (!this._proc.stdin) {
        this._pendingCalls.delete(id);
        reject(new Error('[mcp-client] Process has no stdin stream'));
        return;
      }

      this._proc.stdin.write(JSON.stringify(req) + '\n');
    });
  }

  close(): void {
    this._rl.close();
  }
}

// ─── McpRegistrar ─────────────────────────────────────────────────────────────

/**
 * McpRegistrar — host-side MCP client registry.
 *
 * Discovers tools from spawned MCP servers and exposes them to the agent surface.
 * Closes audit Gap C2: `runtime → delivered to consumer` for mcp type.
 *
 * Security (Gap F5 conservative default):
 *   Tool call args are forwarded as-is from the caller — no automatic db_path injection.
 *   Callers must supply db_path (or any sensitive param) explicitly. This is the
 *   conservative gating posture for pre-PB-enforcement environments.
 */
export class McpRegistrar {
  private readonly _registrations = new Map<string, McpRegistration>();
  private readonly _clients = new Map<string, McpClient>();

  /**
   * Register an MCP server by performing `initialize` + `tools/list` over its stdio.
   *
   * @param serverKey  The activation key (e.g. "memory-server@0.1.0")
   * @param proc       The supervised child process (must have stdin/stdout)
   * @param timeoutMs  Per-call timeout for the protocol handshake
   */
  async register(serverKey: string, proc: ChildProcess, timeoutMs = 10000): Promise<McpRegistration> {
    const client = new McpClient(proc);
    this._clients.set(serverKey, client);

    // Step 1: initialize
    let serverInfo: McpServerInfo;
    try {
      const initResult = await client.call(
        'initialize',
        {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'sox-host', version: '1.0.0' },
        },
        timeoutMs,
      ) as { serverInfo: McpServerInfo };
      serverInfo = initResult.serverInfo ?? { name: serverKey, version: '0.0.0' };
      console.log(`[mcp-registrar] "${serverKey}" initialized: ${serverInfo.name} v${serverInfo.version}`);
    } catch (e) {
      client.close();
      this._clients.delete(serverKey);
      throw new Error(`[mcp-registrar] initialize failed for "${serverKey}": ${String(e)}`);
    }

    // Step 2: tools/list
    let tools: McpToolDescriptor[] = [];
    try {
      const listResult = await client.call('tools/list', undefined, timeoutMs) as { tools: McpToolDescriptor[] };
      tools = listResult.tools ?? [];
      console.log(
        `[mcp-registrar] "${serverKey}" exposes ${tools.length} tool(s): ${tools.map((t) => t.name).join(', ')}`,
      );
    } catch (e) {
      // tools/list failure is non-fatal — server may have 0 tools
      console.warn(`[mcp-registrar] tools/list failed for "${serverKey}": ${String(e)}`);
    }

    const registration: McpRegistration = {
      serverKey,
      serverInfo,
      tools,
      live: true,
    };

    this._registrations.set(serverKey, registration);
    proc.on('exit', () => {
      const reg = this._registrations.get(serverKey);
      if (reg) reg.live = false;
    });

    return registration;
  }

  /**
   * List all registered servers and their tools.
   * This is the "agent surface" exposure — what the agent can see.
   */
  registrations(): McpRegistration[] {
    return [...this._registrations.values()];
  }

  /**
   * Get the tool descriptors for a specific server.
   */
  tools(serverKey: string): McpToolDescriptor[] {
    return this._registrations.get(serverKey)?.tools ?? [];
  }

  /**
   * Call a tool on a registered MCP server.
   *
   * Security (Gap F5 conservative default):
   *   Args are passed through as-is. No automatic db_path injection.
   *   The caller must supply all required params including db_path.
   */
  async call(serverKey: string, toolName: string, args: Record<string, unknown>, timeoutMs = 30000): Promise<McpCallResult> {
    const client = this._clients.get(serverKey);
    if (!client) {
      throw new Error(`[mcp-registrar] No client found for server "${serverKey}". Was it registered?`);
    }

    const result = await client.call(
      'tools/call',
      { name: toolName, arguments: args },
      timeoutMs,
    ) as McpCallResult;

    return result;
  }

  /**
   * Deregister a server and close its client.
   */
  deregister(serverKey: string): void {
    const client = this._clients.get(serverKey);
    if (client) {
      client.close();
      this._clients.delete(serverKey);
    }
    this._registrations.delete(serverKey);
  }

  /** All tool names across all registered servers (for agent surface enumeration). */
  allToolNames(): Array<{ serverKey: string; toolName: string }> {
    const result: Array<{ serverKey: string; toolName: string }> = [];
    for (const [serverKey, reg] of this._registrations) {
      for (const tool of reg.tools) {
        result.push({ serverKey, toolName: tool.name });
      }
    }
    return result;
  }
}
