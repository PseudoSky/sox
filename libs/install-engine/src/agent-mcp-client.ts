/**
 * libs/install-engine/src/agent-mcp-client.ts
 *
 * Minimal MCP-over-stdio client for the agent-mcp catalog.
 *
 * WHY THIS EXISTS (the sanctioned write path): a CLI process has no MCP client
 * attached, so the install engine cannot "just call" the catalog the way an
 * agent host does. The agent-mcp package exposes NO non-interactive write
 * subcommand (`agent-mcp-install` only registers the server into a host's
 * config; the main bin is a stdio MCP server). The sanctioned path is therefore
 * to SPAWN the package's own MCP server (`npx -y @adhd/agent-mcp@latest`, or an
 * override) and speak its public tool contract over stdio JSON-RPC — exactly
 * what a host does. This never touches `agents.db` directly.
 *
 * Transport: newline-delimited JSON-RPC 2.0 on the child's stdin/stdout. The
 * server logs to stderr (pino → fd 2); stdout is the protocol stream (a few
 * dotenvx banner lines also land on stdout and are skipped by JSON-parse).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface AgentMcpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Split a shell-ish command string into argv, honouring single/double quotes. */
export function splitCommand(raw: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of raw) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else cur += ch;
      has = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === ' ' || ch === '\t') {
      if (has) { out.push(cur); cur = ''; has = false; }
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

/**
 * Resolve the agent-mcp server launch.
 *
 * Priority: SOX_AGENT_MCP_BIN (full command string, e.g.
 * `node /path/to/agent-mcp/dist/src/index.js` or `npx -y @adhd/agent-mcp@latest`)
 * → default `npx -y @adhd/agent-mcp@latest`.
 *
 * Catalog DB / registry DB env refs pass through so the spawned server writes
 * the SAME catalog the live hosts read. Resolution (SOX_AGENT_MCP_DATABASE_PATH →
 * ambient ADHD_AGENT_DATABASE_PATH → the agent-mcp registration in
 * ~/.config/opencode/opencode.json → existing global catalog → server zero-config)
 * lives in host-registry ([ref:host-keyed-target]) and is loaded lazily here so
 * no opencode/host path literal appears in this package.
 */
export function resolveAgentMcpLaunch(overrides?: Partial<AgentMcpLaunch>): AgentMcpLaunch {
  const raw = overrides?.command !== undefined && overrides.args !== undefined
    ? [overrides.command, ...overrides.args].join(' ')
    : (process.env['SOX_AGENT_MCP_BIN'] ?? 'npx -y @adhd/agent-mcp@latest');
  const argv = splitCommand(raw);
  const command = argv[0] ?? 'npx';
  const args = argv.slice(1);

  const env: Record<string, string> = { ...(overrides?.env ?? {}) };

  // Resolve the catalog env via host-registry (lazy require — same pattern
  // install.ts uses so the [host-keyed-target] literal gate stays satisfied).
  let databasePath: string | undefined;
  let registryDbPath: string | undefined;
  try {
    const hr = require('@adhd/sox-host-registry') as {
      resolveAgentMcpEnv?: () => { databasePath?: string; registryDbPath?: string };
    };
    if (typeof hr.resolveAgentMcpEnv === 'function') {
      const resolved = hr.resolveAgentMcpEnv();
      databasePath = resolved.databasePath;
      registryDbPath = resolved.registryDbPath;
    }
  } catch {
    // host-registry unavailable — fall back to process env only.
    databasePath = process.env['SOX_AGENT_MCP_DATABASE_PATH'] ?? process.env['ADHD_AGENT_DATABASE_PATH'];
    registryDbPath = process.env['SOX_AGENT_MCP_REGISTRY_DB_PATH'] ?? process.env['ADHD_AGENT_REGISTRY_DB_PATH'];
  }

  if (databasePath !== undefined && databasePath !== '') env['ADHD_AGENT_DATABASE_PATH'] = databasePath;
  if (registryDbPath !== undefined && registryDbPath !== '') env['ADHD_AGENT_REGISTRY_DB_PATH'] = registryDbPath;
  // Keep the protocol stream clean — logs go to stderr regardless, but silence
  // the SSE/gateway side server the package starts by default.
  env['ADHD_AGENT_LOG_LEVEL'] = process.env['SOX_AGENT_MCP_LOG_LEVEL'] ?? 'warn';
  env['ADHD_AGENT_TRANSPORT'] = 'stdio';

  return { command, args, env };
}

export interface CallToolOptions {
  timeoutMs?: number;
  launch?: AgentMcpLaunch;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** Parse a `tools/call` result envelope into its decoded JSON payload. */
function decodeToolResult(result: unknown): unknown {
  const r = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | undefined;
  const text = r?.content?.[0]?.text;
  if (r?.isError === true) {
    throw new Error(text !== undefined && text !== '' ? text : 'agent-mcp tool returned isError');
  }
  if (typeof text !== 'string') return result;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Spawn the agent-mcp server, run the MCP handshake, call one tool, and return
 * the decoded result. The child is always killed before returning.
 */
export async function callAgentMcpTool(
  tool: string,
  args: Record<string, unknown> = {},
  opts?: CallToolOptions,
): Promise<unknown> {
  const launch = opts?.launch ?? resolveAgentMcpLaunch();
  const timeoutMs = opts?.timeoutMs ?? 120_000;

  const child: ChildProcessWithoutNullStreams = spawn(launch.command, launch.args, {
    env: { ...process.env, ...launch.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  const pending = new Map<number, { resolve: (m: JsonRpcMessage) => void; reject: (e: Error) => void }>();
  let nextId = 1;

  const onLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      return; // non-protocol stdout line (e.g. dotenvx banner) — skip
    }
    if (msg.id === undefined) return; // notification
    const waiter = pending.get(Number(msg.id));
    if (waiter !== undefined) {
      pending.delete(Number(msg.id));
      waiter.resolve(msg);
    }
  };

  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      onLine(line);
    }
  });

  let stderrTail = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
  });

  const send = (msg: Record<string, unknown>): void => {
    child.stdin.write(JSON.stringify(msg) + '\n');
  };

  const request = (method: string, params: Record<string, unknown>): Promise<JsonRpcMessage> => {
    const id = nextId++;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ jsonrpc: '2.0', id, method, params });
    });
  };

  const timer = setTimeout(() => {
    for (const [, waiter] of pending) waiter.reject(new Error(`agent-mcp call '${tool}' timed out after ${timeoutMs}ms`));
    pending.clear();
    child.kill('SIGKILL');
  }, timeoutMs);

  try {
    const init = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'soxe', version: '0.0.0' },
    });
    if (init.error !== undefined) {
      throw new Error(`agent-mcp initialize failed: ${init.error.message ?? JSON.stringify(init.error)}`);
    }
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const res = await request('tools/call', { name: tool, arguments: args });
    if (res.error !== undefined) {
      throw new Error(
        `agent-mcp tool '${tool}' failed: ${res.error.message ?? JSON.stringify(res.error)}` +
          (stderrTail !== '' ? `\n[agent-mcp stderr] ${stderrTail}` : ''),
      );
    }
    return decodeToolResult(res.result);
  } finally {
    clearTimeout(timer);
    pending.clear();
    child.stdin.end();
    child.kill('SIGTERM');
    // Best-effort hard kill if it ignores SIGTERM.
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 2000).unref?.();
  }
}

// ── Typed catalog operations ──────────────────────────────────────────────────

export interface CatalogAgentDefinition {
  name: string;
  description?: string;
  provider?: Record<string, unknown>;
  systemPrompt?: string;
  mcpServers?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  [key: string]: unknown;
}

/** `agent_list` — every stored agent definition. */
export async function catalogList(opts?: CallToolOptions): Promise<CatalogAgentDefinition[]> {
  const out = await callAgentMcpTool('agent_list', {}, opts);
  return Array.isArray(out) ? (out as CatalogAgentDefinition[]) : [];
}

/** `agent_read` — one stored agent by name, or null when absent. */
export async function catalogRead(name: string, opts?: CallToolOptions): Promise<CatalogAgentDefinition | null> {
  try {
    const out = await callAgentMcpTool('agent_read', { name }, opts);
    if (out !== null && typeof out === 'object' && !Array.isArray(out) && (out as Record<string, unknown>)['name'] !== undefined) {
      return out as CatalogAgentDefinition;
    }
    return null;
  } catch {
    // agent_read throws when the row does not exist — treat as absent.
    return null;
  }
}

/**
 * Idempotent upsert: `agent_update` when the row exists, else `agent_create`.
 * Returns the stored definition.
 */
export async function catalogUpsert(
  payload: CatalogAgentDefinition,
  opts?: CallToolOptions,
): Promise<CatalogAgentDefinition> {
  const existing = await catalogRead(payload.name, opts);
  if (existing !== null) {
    const { name, ...patch } = payload;
    const out = await callAgentMcpTool('agent_update', { name, patch }, opts);
    return out as CatalogAgentDefinition;
  }
  const out = await callAgentMcpTool('agent_create', payload as unknown as Record<string, unknown>, opts);
  return out as CatalogAgentDefinition;
}

/** `agent_delete` — retire the agent (idempotent: absent is success). */
export async function catalogDelete(name: string, opts?: CallToolOptions): Promise<void> {
  try {
    await callAgentMcpTool('agent_delete', { name }, opts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Absent row (already retired) is not an error for uninstall idempotency.
    if (/not\s*found|NOT_FOUND|no such agent/i.test(msg)) return;
    throw e;
  }
}
