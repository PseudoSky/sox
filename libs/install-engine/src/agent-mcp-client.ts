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
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

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
 * One live agent-mcp stdio server: spawned LAZILY on the first `call`, handshaken
 * once, and reused for every subsequent call until `close()`. A command that
 * touches the catalog N times therefore pays ONE spawn + `initialize` instead of
 * N (the old shape spawned a fresh `npx` server per tool call: ~1 + 3×rows
 * processes for a reconcile).
 */
export class AgentMcpSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private buffer = '';
  private stderrTail = '';
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (m: JsonRpcMessage) => void; reject: (e: Error) => void }>();
  private closed = false;
  /** Number of tool calls made (diagnostics / perf accounting). */
  public calls = 0;
  /** Number of server processes spawned by this session (0 or 1). */
  public spawns = 0;

  constructor(
    private readonly launch: AgentMcpLaunch,
    private readonly timeoutMs: number = 120_000,
  ) {}

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      return; // non-protocol stdout line (e.g. dotenvx banner) — skip
    }
    if (msg.id === undefined) return; // notification
    const waiter = this.pending.get(Number(msg.id));
    if (waiter !== undefined) {
      this.pending.delete(Number(msg.id));
      waiter.resolve(msg);
    }
  }

  private send(msg: Record<string, unknown>): void {
    this.child?.stdin.write(JSON.stringify(msg) + '\n');
  }

  private request(method: string, params: Record<string, unknown>, label: string): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`agent-mcp call '${label}' timed out after ${this.timeoutMs}ms`));
        this.child?.kill('SIGKILL');
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (m) => { clearTimeout(timer); resolve(m); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private start(): Promise<void> {
    if (this.ready !== null) return this.ready;
    const child = spawn(this.launch.command, this.launch.args, {
      env: { ...process.env, ...this.launch.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.spawns += 1;
    // setEncoding installs a streaming UTF-8 decoder: a multi-byte character (an
    // em dash in a 60KB systemPrompt) split across two pipe chunks must not decode
    // to U+FFFD — per-chunk `Buffer#toString()` did, which corrupted every large
    // `agent_list`/`agent_read` response and made unchanged rows look drifted.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        this.onLine(line);
      }
    });
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    child.on('exit', () => {
      for (const [, waiter] of this.pending) {
        waiter.reject(new Error(`agent-mcp server exited before replying${this.stderrTail !== '' ? `\n[agent-mcp stderr] ${this.stderrTail}` : ''}`));
      }
      this.pending.clear();
    });
    this.ready = (async () => {
      const init = await this.request(
        'initialize',
        { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'soxe', version: '0.0.0' } },
        'initialize',
      );
      if (init.error !== undefined) {
        throw new Error(`agent-mcp initialize failed: ${init.error.message ?? JSON.stringify(init.error)}`);
      }
      this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    })();
    return this.ready;
  }

  /** Call one tool on the (lazily started) shared server and return the decoded result. */
  async call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) throw new Error('agent-mcp session is closed');
    await this.start();
    this.calls += 1;
    const res = await this.request('tools/call', { name: tool, arguments: args }, tool);
    if (res.error !== undefined) {
      throw new Error(
        `agent-mcp tool '${tool}' failed: ${res.error.message ?? JSON.stringify(res.error)}` +
          (this.stderrTail !== '' ? `\n[agent-mcp stderr] ${this.stderrTail}` : ''),
      );
    }
    return decodeToolResult(res.result);
  }

  /** Stop the server (idempotent). Always called by {@link withAgentMcpSession}. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    this.pending.clear();
    if (child === null) return;
    child.stdin.end();
    child.kill('SIGTERM');
    // Best-effort hard kill if it ignores SIGTERM.
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 2000).unref?.();
  }
}

/** The ambient session of the enclosing {@link withAgentMcpSession} scope, if any. */
const sessionStore = new AsyncLocalStorage<AgentMcpSession>();

/** The ambient session (or undefined) — exposed for diagnostics and tests. */
export function currentAgentMcpSession(): AgentMcpSession | undefined {
  return sessionStore.getStore();
}

/**
 * Run `fn` with ONE shared agent-mcp server: every catalog call made inside
 * (directly or transitively, including the install engine's default client)
 * reuses it. The server is spawned on the first call and ALWAYS stopped on exit.
 * Nesting reuses the outer session.
 */
export async function withAgentMcpSession<T>(
  fn: (session: AgentMcpSession) => Promise<T>,
  opts?: CallToolOptions,
): Promise<T> {
  const outer = sessionStore.getStore();
  if (outer !== undefined) return fn(outer);
  const session = new AgentMcpSession(opts?.launch ?? resolveAgentMcpLaunch(), opts?.timeoutMs);
  try {
    return await sessionStore.run(session, () => fn(session));
  } finally {
    session.close();
  }
}

/**
 * Call one agent-mcp tool. Uses the ambient {@link withAgentMcpSession} server
 * when there is one (and no explicit `launch`), else spawns a one-shot server
 * that is always killed before returning.
 */
export async function callAgentMcpTool(
  tool: string,
  args: Record<string, unknown> = {},
  opts?: CallToolOptions,
): Promise<unknown> {
  const ambient = opts?.launch === undefined ? sessionStore.getStore() : undefined;
  if (ambient !== undefined) return ambient.call(tool, args);
  const session = new AgentMcpSession(opts?.launch ?? resolveAgentMcpLaunch(), opts?.timeoutMs);
  try {
    return await session.call(tool, args);
  } finally {
    session.close();
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
  nativeTooling?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CatalogReadOptions extends CallToolOptions {
  /** Return the FULL definition including `systemPrompt` (default: a summary without it). */
  fullDefinition?: boolean;
}

/** `agent_list` — every stored agent definition (full definitions on request). */
export async function catalogList(opts?: CatalogReadOptions): Promise<CatalogAgentDefinition[]> {
  const args = opts?.fullDefinition === true ? { fullDefinition: true } : {};
  const out = await callAgentMcpTool('agent_list', args, opts);
  return Array.isArray(out) ? (out as CatalogAgentDefinition[]) : [];
}

/** `agent_read` — one stored agent by name, or null when absent. */
export async function catalogRead(name: string, opts?: CatalogReadOptions): Promise<CatalogAgentDefinition | null> {
  try {
    const args = opts?.fullDefinition === true ? { name, fullDefinition: true } : { name };
    const out = await callAgentMcpTool('agent_read', args, opts);
    if (out !== null && typeof out === 'object' && !Array.isArray(out) && (out as Record<string, unknown>)['name'] !== undefined) {
      return out as CatalogAgentDefinition;
    }
    return null;
  } catch {
    // agent_read throws when the row does not exist — treat as absent.
    return null;
  }
}

// ── Managed-field comparison + stale-key bookkeeping ─────────────────────────

/** Stable JSON (sorted keys) so structurally-equal values compare equal. */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => [k, walk(o[k])]));
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

/** sha256 hex of the canonical JSON of `value`. */
export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** True when an mcpServers entry is a stdio launcher of the agent-mcp server itself. */
export function isAgentMcpLauncher(cfg: unknown): boolean {
  if (cfg === null || typeof cfg !== 'object') return false;
  const c = cfg as Record<string, unknown>;
  if (c['transport'] !== 'stdio') return false;
  const parts = [c['command'], ...(Array.isArray(c['args']) ? (c['args'] as unknown[]) : [])];
  return parts.some((p) => typeof p === 'string' && /(^|[/@\s])agent-mcp(\b|$)/.test(p));
}

/** Fields whose value the renderer owns wholesale (replaced by `agent_update`). */
const REPLACED_FIELDS = [
  'description',
  'systemPrompt',
  'provider',
  'nativeTooling',
  'maxToolLoops',
  'sanitization',
  'toolAdvertisement',
  'nativeWebTools',
] as const;

/**
 * mcpServers keys a patch must null so the stored map ends up equal to the
 * rendered one: keys soxe recorded as owned (`ownedMcpKeys`, from the ledger)
 * that are no longer rendered, plus any stored stdio entry that launches
 * agent-mcp itself (the welded `agent` entry older rows carry — older ledger
 * entries recorded no ownership, so this is detected structurally). Keys soxe
 * does not own are never touched.
 */
export function staleMcpKeys(
  existing: CatalogAgentDefinition,
  rendered: Record<string, unknown> | undefined,
  ownedMcpKeys: readonly string[] | undefined,
): string[] {
  const stored = existing.mcpServers ?? {};
  const keep = new Set(Object.keys(rendered ?? {}));
  const owned = new Set(ownedMcpKeys ?? []);
  return Object.keys(stored)
    .filter((k) => !keep.has(k) && (owned.has(k) || isAgentMcpLauncher(stored[k])))
    .sort();
}

/**
 * The managed fields whose stored value differs from what the payload renders
 * (plus `mcpServers` when a stale owned key must be nulled). Compares the MANAGED
 * subset only — server-added defaults and keys soxe does not render never count —
 * so an empty result means an `agent_update` would be a no-op.
 */
export function changedManagedFields(
  existing: CatalogAgentDefinition,
  payload: CatalogAgentDefinition,
  stale: readonly string[],
): string[] {
  const changed: string[] = [];
  for (const f of REPLACED_FIELDS) {
    if (payload[f] === undefined) continue; // not rendered: left untouched by the patch
    if (canonicalJson(payload[f]) !== canonicalJson(existing[f])) changed.push(f);
  }
  const serversDiffer =
    stale.length > 0 ||
    Object.entries(payload.mcpServers ?? {}).some(
      ([k, v]) => canonicalJson(v) !== canonicalJson((existing.mcpServers ?? {})[k]),
    );
  if (serversDiffer) changed.push('mcpServers');
  const permsDiffer = Object.entries(payload.permissions ?? {}).some(
    ([k, v]) => canonicalJson(v) !== canonicalJson((existing.permissions ?? {})[k]),
  );
  if (permsDiffer) changed.push('permissions');
  return changed;
}

/** True when the stored row already carries every managed field the payload renders. */
export function rowMatchesPayload(
  existing: CatalogAgentDefinition,
  payload: CatalogAgentDefinition,
  stale: readonly string[],
): boolean {
  return changedManagedFields(existing, payload, stale).length === 0;
}

/**
 * mcpServers keys the pre-ownership sox manifests wrote on every agent row. An
 * older ledger entry (or none) records no `ownedMcpKeys`, so these are treated as
 * soxe-owned when deciding which keys to null on a re-render — otherwise a row
 * keeps the servers its agent no longer mounts (and the welded `agent` entry).
 */
export const LEGACY_SOX_MCP_KEYS: readonly string[] = ['agent', 'search', 'memory-server', 'gitnexus', 'backlog'];

export type CatalogUpsertOutcome = 'created' | 'updated' | 'unchanged';

export interface CatalogUpsertResult {
  outcome: CatalogUpsertOutcome;
  /** The stored definition after the call (the pre-existing row when unchanged). */
  row: CatalogAgentDefinition;
  /** mcpServers keys sent as `null` (stale owned / welded agent-mcp launchers). */
  nulledMcpKeys: string[];
}

export interface CatalogUpsertOptions extends CallToolOptions {
  /** mcpServers keys the ledger recorded as soxe-owned on the previous apply. */
  ownedMcpKeys?: readonly string[];
  /** A pre-read FULL row (e.g. from one `agent_list`), saving the per-row read. */
  existing?: CatalogAgentDefinition | null;
}

/**
 * Idempotent upsert: `agent_create` when absent; otherwise `agent_update` with a
 * patch that nulls stale owned mcpServers keys — or NO call at all when the
 * stored row already equals the rendered managed fields (unchanged).
 */
export async function catalogUpsert(
  payload: CatalogAgentDefinition,
  opts?: CatalogUpsertOptions,
): Promise<CatalogUpsertResult> {
  const existing =
    opts?.existing !== undefined ? opts.existing : await catalogRead(payload.name, { ...opts, fullDefinition: true });
  if (existing !== null) {
    const stale = staleMcpKeys(existing, payload.mcpServers, opts?.ownedMcpKeys);
    if (rowMatchesPayload(existing, payload, stale)) {
      return { outcome: 'unchanged', row: existing, nulledMcpKeys: [] };
    }
    const { name, ...rest } = payload;
    const patch: Record<string, unknown> = { ...rest };
    if (stale.length > 0 || payload.mcpServers !== undefined) {
      patch['mcpServers'] = { ...(payload.mcpServers ?? {}), ...Object.fromEntries(stale.map((k) => [k, null])) };
    }
    const out = await callAgentMcpTool('agent_update', { name, patch }, opts);
    return { outcome: 'updated', row: out as CatalogAgentDefinition, nulledMcpKeys: stale };
  }
  const out = await callAgentMcpTool('agent_create', payload as unknown as Record<string, unknown>, opts);
  return { outcome: 'created', row: out as CatalogAgentDefinition, nulledMcpKeys: [] };
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
