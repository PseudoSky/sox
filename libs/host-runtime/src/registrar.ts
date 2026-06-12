/**
 * libs/host-runtime/src/registrar.ts — MCP host-side registrar.
 *
 * Ported from scripts/host/registrar.ts. No logic changes.
 */

import { type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';

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
  live: boolean;
}

export interface McpCallResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean | undefined;
}

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
        // Non-JSON line — ignore
      }
    });
    _proc.on('exit', () => {
      for (const [id, pending] of this._pendingCalls) {
        pending.reject(new Error('[mcp-client] Process exited before response received'));
        this._pendingCalls.delete(id);
      }
    });
  }

  call(method: string, params?: unknown, timeoutMs = 10000): Promise<unknown> {
    const id = this._idCounter++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pendingCalls.has(id)) {
          this._pendingCalls.delete(id);
          reject(new Error(`[mcp-client] Timeout waiting for "${method}" response (${timeoutMs}ms)`));
        }
      }, timeoutMs);

      this._pendingCalls.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
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

export class McpRegistrar {
  private readonly _registrations = new Map<string, McpRegistration>();
  private readonly _clients = new Map<string, McpClient>();

  async register(serverKey: string, proc: ChildProcess, timeoutMs = 10000): Promise<McpRegistration> {
    const client = new McpClient(proc);
    this._clients.set(serverKey, client);

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

    let tools: McpToolDescriptor[] = [];
    try {
      const listResult = await client.call('tools/list', undefined, timeoutMs) as { tools: McpToolDescriptor[] };
      tools = listResult.tools ?? [];
      console.log(
        `[mcp-registrar] "${serverKey}" exposes ${tools.length} tool(s): ${tools.map((t) => t.name).join(', ')}`,
      );
    } catch (e) {
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

  registrations(): McpRegistration[] {
    return [...this._registrations.values()];
  }

  tools(serverKey: string): McpToolDescriptor[] {
    return this._registrations.get(serverKey)?.tools ?? [];
  }

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

  deregister(serverKey: string): void {
    const client = this._clients.get(serverKey);
    if (client) {
      client.close();
      this._clients.delete(serverKey);
    }
    this._registrations.delete(serverKey);
  }

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
