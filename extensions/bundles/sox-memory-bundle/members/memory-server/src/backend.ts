/**
 * memory-server/src/backend.ts — UDS backend mode (spec §9.5, M3→M4 bridge).
 *
 * The DEFAULT execution model for memory-server is now the front-shim service-proxy
 * (§9.5): the MCP client spawns a thin stdio shim (`soxe serve memory-server`),
 * which proxies tools/call to THIS persistent, sox-owned backend over a Unix domain
 * socket. The backend holds the real tool implementation (the SQLite store, the
 * embed worker, the in-process enrich loop). Because the backend's lifetime is the
 * STORE — not the client's stdio pipe — a behaviour/code upgrade of memory-server is
 * a rolling restart of the backend BEHIND the shim, with NO client reconnect.
 *
 * This module wraps the existing in-process tool dispatcher (`TOOLS` +
 * `handleToolCall`) with `serveBackend` from @adhd/sox-service-proxy. It speaks the
 * same JSON-RPC surface the MCP `serve()` path does — `initialize`, `tools/list`,
 * `tools/call` — so the shim's cached schema and the backend's live schema match
 * byte-for-byte (the [contract:schema-hash] handshake, §9.5.3).
 *
 * [inv:no-stdout-diagnostics]: the backend is a DETACHED daemon, not the client's
 * pipe — it NEVER writes to stdout. All diagnostics go to stderr.
 *
 * The C6 permission guard is unchanged: `handleToolCall` runs the policy-env guard
 * before any db_path is opened, exactly as it does on the direct-stdio path. The
 * backend is spawned by the shim with the SAME policy-env + SOX_CONFIG_* the direct
 * serve path injects, so enforcement parity holds.
 */

import type { ToolDefinition, ToolResult } from '@adhd/sox-mcp-runtime';
import type { JsonRpcRequest, JsonRpcResponse } from '@adhd/sox-service-proxy';
import { serveBackend } from '@adhd/sox-service-proxy';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { closeAllAdapters } from '@adhd/sox-memory-core';
import { getContentAddress, handleToolCall, TOOLS } from './index.js';

/**
 * Build the canonical `tools/list` result — the EXACT shape the MCP `serve()` path
 * returns ({ tools: [{ name, description, inputSchema }] }). The shim hashes this
 * (computeSchemaHash) and serves it to the client; publishing it to schema.json
 * lets the shim answer initialize/tools/list instantly during a backend restart.
 */
export function buildToolsListResult(): { tools: Array<Omit<ToolDefinition, 'handler'>> } {
  return {
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
}

/** The MCP serverInfo the backend reports on initialize (content-addressed). */
function serverInfo(): { name: string; version: string } {
  return { name: 'memory-server', version: getContentAddress().short };
}

/**
 * Publish the canonical tools/list to `schemaPath` so the shim can seed its cache
 * (lifecycle.schema_path). Atomic write (tmp + rename) so a mid-restart shim never
 * reads a half-written file. Best-effort: a failure only loses the instant-cache
 * optimization (the shim falls back to reading the schema from the live backend).
 */
export function publishSchema(schemaPath: string): void {
  try {
    fs.mkdirSync(path.dirname(schemaPath), { recursive: true });
    const tmp = `${schemaPath}.tmp-${String(process.pid)}`;
    fs.writeFileSync(tmp, JSON.stringify(buildToolsListResult()), 'utf8');
    fs.renameSync(tmp, schemaPath);
  } catch (e) {
    process.stderr.write(`[memory-server backend] publishSchema failed: ${(e as Error).message}\n`);
  }
}

/**
 * The JSON-RPC handler the backend serves. Mirrors mcp-runtime serve():
 *   - initialize → serverInfo + tools capability
 *   - tools/list → the canonical tools list
 *   - tools/call → handleToolCall(name, args) (which runs the C6 guard)
 * Notifications (no id) get no response.
 *
 * BL-62 (RESOLVED 2026-07-18): tool call arguments are passed through UNMODIFIED —
 * no `client_context.project_path` injection. That injection (removed) used to
 * override ANY omitted `arguments.project_path` with the shim's spawn-time
 * `process.cwd()` (no worktree canonicalization, computed once and frozen for the
 * shim's whole lifetime) — which silently broke `memory_topics`/`memory_list_entities`
 * /`memory_stats` (they read the top-level `project_path` key the injection targeted)
 * whenever the shim happened to be spawned from a directory with no episodes (a git
 * worktree, in the incident that surfaced this). `memory_recall` was only ever
 * accidentally immune, because its filter lives at `arguments.filters.project_path`,
 * a different key the injection never touched.
 *
 * There is no server-side inference of `project_path` anywhere anymore, for any
 * tool: a WRITE (`memory_write`/`memory_write_batch`) with no explicit
 * `project_path` is now rejected outright by memory-core
 * (`E_MISSING_PROJECT_PATH` — see write.ts) rather than silently guessing, since a
 * bad guess there permanently mis-attributes the episode. A READ omitting
 * `project_path` is a deliberate, valid "no filter / every project" request —
 * exactly `memory_recall`'s existing behavior — never something to silently
 * override with a guess about which directory the server happened to start in.
 */
export async function handleBackendRequest(
  req: JsonRpcRequest,
): Promise<JsonRpcResponse | undefined> {
  const id = req.id ?? null;

  if (req.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: serverInfo(),
        capabilities: { tools: {} },
      },
    };
  }

  if (req.method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: buildToolsListResult() };
  }

  if (req.method === 'tools/call') {
    const params = (req.params ?? {}) as {
      name?: string;
      arguments?: Record<string, unknown>;
    };
    const toolName = params.name ?? '';
    const args: Record<string, unknown> = params.arguments ?? {};
    let result: ToolResult;
    try {
      result = await handleToolCall(toolName, args);
    } catch (err) {
      result = {
        isError: true,
        content: [{ type: 'text', text: `Tool error: ${String(err)}` }],
      };
    }
    // Shape the CallToolResult exactly as serve() does.
    return {
      jsonrpc: '2.0',
      id,
      result: { content: result.content, ...(result.isError !== undefined ? { isError: result.isError } : {}) },
    };
  }

  // Notifications (no id) — best-effort, no response.
  if (req.id === undefined) return undefined;

  // Any other method (ping, etc.) — return an empty success rather than hang.
  return { jsonrpc: '2.0', id, result: {} };
}

/**
 * Run memory-server as a persistent UDS backend (§9.5.4). Binds `socketPath`,
 * publishes the schema (if `schemaPath` given), and serves until SIGTERM/SIGINT.
 * Resolves when the listener is bound (for tests); in production it runs forever.
 *
 * BL-170: a singleton racer that LOSES the bind (E_LIVE_SOCKET from serveBackend's
 * SA-4 probe, or a raw EADDRINUSE race) MUST exit — never idle as an orphaned
 * zombie holding a warmed model and ignoring SIGTERM. Two hardenings here:
 *   1. SIGTERM/SIGINT handlers are wired BEFORE the async bind, so even a backend
 *      stuck pre-bind drains on signal ([contract:signal]).
 *   2. A serveBackend rejection is caught, logged to stderr
 *      ([inv:no-stdout-diagnostics]), and the process exits 1 so the winning
 *      singleton self-heals without a manual reap.
 * `exit` is an injectable seam so the regression test can assert the exit path
 * without killing the test runner; production callers omit it (process.exit).
 */
export async function runBackend(opts: {
  socketPath: string;
  schemaPath?: string;
  /** Test seam: invoked instead of process.exit on a fatal bind failure. */
  exit?: (code: number) => never;
}): Promise<{ close: () => Promise<void> }> {
  const exit: (code: number) => never =
    opts.exit ?? ((code: number): never => process.exit(code));

  if (opts.schemaPath) publishSchema(opts.schemaPath);

  // BL-170 (2): wire signal handlers BEFORE the bind — a backend stuck pre-bind
  // must still honour SIGTERM instead of requiring a SIGKILL escalation.
  let handle: { socketPath: string; close: () => Promise<void> } | null = null;
  const shutdown = (sig: string): void => {
    process.stderr.write(`[memory-server backend] ${sig} — shutting down\n`);
    // SA-8 / BL-128: close all DB connections with lease release so the lock
    // file is cleaned up before process exit.
    closeAllAdapters();
    if (handle) {
      void handle.close().finally(() => process.exit(0));
    } else {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    handle = await serveBackend({
      socketPath: opts.socketPath,
      handler: handleBackendRequest,
      onDiagnostic: (l) => process.stderr.write(l + '\n'),
    });
  } catch (err) {
    // BL-170 (1): the losing singleton racer dies loudly instead of idling.
    const code = (err as { code?: string }).code ?? 'E_BIND_FAILED';
    process.stderr.write(
      `[memory-server backend] FATAL (${code}): ${(err as Error).message} — ` +
        `losing singleton racer exiting (BL-170)\n`,
    );
    return exit(1);
  }

  process.stderr.write(
    `[memory-server backend] listening on ${handle.socketPath} ` +
      `(version ${serverInfo().version})\n`,
  );

  const bound = handle;
  return { close: () => bound.close() };
}
