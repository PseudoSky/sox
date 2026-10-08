/**
 * libs/host-registry/src/agent-mcp.ts
 *
 * agent-mcp host module — [def:host-registry], [ref:host-keyed-target].
 *
 * Unlike claude / codex / opencode (file-drop + config-merge against discovery
 * PATHS), the agent-mcp host has no discovery directory: agent definitions live
 * as ROWS in a SQLite catalog served over the agent-mcp MCP server
 * (`@adhd/agent-mcp`, launched `npx -y @adhd/agent-mcp@latest`). Its only
 * installable extension type is `agent`, and its surface uses the dedicated
 * `agent-catalog` capability (see internal.ts) which calls the catalog's own
 * `agent_read` / `agent_create` / `agent_update` / `agent_delete` MCP tools —
 * the SANCTIONED write path (an MCP client speaking the server's public tool
 * contract), never a direct `agents.db` write.
 *
 * Mapping (agent extension → catalog row), verified against
 * `@adhd/agent-engine-orchestrator`'s agentCreateInputSchema:
 *   agent.name             → name            (required)
 *   agent.description      → description
 *   <entrypoint>.md        → systemPrompt    (frontmatter stripped)
 *   render.agent-mcp.model → provider        (via deriveProvider; falls back to
 *                                             the host's providerFrom sibling —
 *                                             see readAgentRenderInputs)
 *   agent.steps            → maxToolLoops    (host-mapped, like claude's maxTurns)
 *   render.agent-mcp       → per-field override (provider / mcpServers / permissions / model)
 *
 * The agent IR's `model` is a logical Claude tier (opus/sonnet/haiku) and is NEVER
 * read as a provider source: agent-mcp serves whatever host surface installed the
 * row, so an absent explicit model is a hard error, not a Claude default (bug
 * eb1ab168).
 *
 * The catalog is GLOBAL — the operational DB path is shared across scopes
 * (ADHD_AGENT_DATABASE_PATH, default ~/.adhd/agent-mcp/agents.db). Scope still
 * governs the ledger/ownership bookkeeping, but every scope writes the same
 * catalog, which is exactly what makes a synced agent dispatchable from any host.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  AgentIr,
  AgentOverride,
  AgentRenderLoss,
  AgentRenderReport,
  HostModule,
  HostRenderer,
  HostScope,
  RenderedArtifact,
  ScopePathMap,
  SurfaceMap,
} from './internal.js';
import { stripFrontmatter } from './serialize.js';

// ---------------------------------------------------------------------------
// Catalog location
// ---------------------------------------------------------------------------

/**
 * [inv:sandbox-isolation]: the effective home base — SOX_SANDBOX_ROOT when set
 * (probe/test), else the real home. Read at call time.
 */
function getBase(): string {
  const sandbox = process.env['SOX_SANDBOX_ROOT'];
  return sandbox !== undefined && sandbox !== '' ? sandbox : os.homedir();
}

/**
 * The zero-config operational catalog DB (agent-mcp's own default,
 * `env.files.db` under its global data root).
 */
function serverZeroConfigDbPath(): string {
  return path.join(getBase(), '.adhd', 'agent-mcp', 'production', 'data', 'agents.db');
}

/** The global catalog the documented live agent-mcp registration uses. */
function globalCatalogDbPath(): string {
  return path.join(getBase(), '.adhd', 'agent-mcp', 'agents.db');
}

/** Path to the opencode config that registers the agent-mcp MCP server. */
function opencodeConfigPath(): string {
  return path.join(getBase(), '.config', 'opencode', 'opencode.json');
}

export interface AgentMcpEnv {
  databasePath?: string;
  registryDbPath?: string;
  /** Where the resolution came from — surfaced in status/diagnostics. */
  source: 'SOX_AGENT_MCP_DATABASE_PATH' | 'ADHD_AGENT_DATABASE_PATH' | 'opencode.json' | 'existing-global-catalog' | 'server-zero-config';
}

/**
 * Walk an arbitrary config tree for an object that registers the agent-mcp
 * MCP server (its `command` mentions `agent-mcp`) carrying an environment block
 * with ADHD_AGENT_DATABASE_PATH / ADHD_AGENT_REGISTRY_DB_PATH.
 */
function findAgentMcpEnvInConfig(node: unknown): { databasePath?: string; registryDbPath?: string } | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const r = findAgentMcpEnvInConfig(child);
      if (r !== null) return r;
    }
    return null;
  }
  if (node === null || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  const cmd = obj['command'];
  const cmdStr = Array.isArray(cmd) ? cmd.join(' ') : typeof cmd === 'string' ? cmd : '';
  if (cmdStr.includes('agent-mcp')) {
    const environment = (obj['environment'] ?? obj['env']) as Record<string, unknown> | undefined;
    if (environment !== undefined && environment !== null && typeof environment === 'object') {
      const db = typeof environment['ADHD_AGENT_DATABASE_PATH'] === 'string' ? (environment['ADHD_AGENT_DATABASE_PATH'] as string) : undefined;
      const reg = typeof environment['ADHD_AGENT_REGISTRY_DB_PATH'] === 'string' ? (environment['ADHD_AGENT_REGISTRY_DB_PATH'] as string) : undefined;
      if (db !== undefined || reg !== undefined) {
        const out: { databasePath?: string; registryDbPath?: string } = {};
        if (db !== undefined) out.databasePath = db;
        if (reg !== undefined) out.registryDbPath = reg;
        return out;
      }
    }
  }
  for (const value of Object.values(obj)) {
    const r = findAgentMcpEnvInConfig(value);
    if (r !== null) return r;
  }
  return null;
}

/**
 * Resolve which catalog the agent-mcp server actually serves, so soxe writes the
 * SAME rows the live hosts read. Priority:
 *   1. SOX_AGENT_MCP_DATABASE_PATH (explicit soxe override)
 *   2. ADHD_AGENT_DATABASE_PATH     (already exported in this process)
 *   3. the agent-mcp registration's env in ~/.config/opencode/opencode.json
 *   4. an existing global catalog at ~/.adhd/agent-mcp/agents.db
 *   5. the server's own zero-config default (fresh machine)
 *
 * The literal `~/.config/opencode/` path lives HERE because host-registry is the
 * only package permitted host-discovery paths ([ref:host-keyed-target]).
 */
export function resolveAgentMcpEnv(): AgentMcpEnv {
  const explicit = process.env['SOX_AGENT_MCP_DATABASE_PATH'];
  const explicitReg = process.env['SOX_AGENT_MCP_REGISTRY_DB_PATH'];
  if (explicit !== undefined && explicit !== '') {
    const out: AgentMcpEnv = { databasePath: explicit, source: 'SOX_AGENT_MCP_DATABASE_PATH' };
    const reg = explicitReg ?? process.env['ADHD_AGENT_REGISTRY_DB_PATH'];
    if (reg !== undefined && reg !== '') out.registryDbPath = reg;
    return out;
  }
  const ambient = process.env['ADHD_AGENT_DATABASE_PATH'];
  if (ambient !== undefined && ambient !== '') {
    const out: AgentMcpEnv = { databasePath: ambient, source: 'ADHD_AGENT_DATABASE_PATH' };
    const reg = process.env['ADHD_AGENT_REGISTRY_DB_PATH'];
    if (reg !== undefined && reg !== '') out.registryDbPath = reg;
    return out;
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(opencodeConfigPath(), 'utf8')) as unknown;
    const found = findAgentMcpEnvInConfig(cfg);
    if (found !== null) return { ...found, source: 'opencode.json' };
  } catch {
    // No opencode config (or unreadable) — fall through to filesystem defaults.
  }
  const globalDb = globalCatalogDbPath();
  if (fs.existsSync(globalDb)) return { databasePath: globalDb, source: 'existing-global-catalog' };
  return { source: 'server-zero-config' };
}

/** The catalog DB path soxe targets by default. */
export function defaultCatalogDbPath(): string {
  const env = resolveAgentMcpEnv();
  return env.databasePath ?? serverZeroConfigDbPath();
}

/** The catalog DB directory (root discovery dir for this host). */
function catalogDir(): string {
  return path.dirname(defaultCatalogDbPath());
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect the agent-mcp host.
 *
 * The catalog is GLOBAL and leaves no workspace footprint (no `.agent-mcp/`
 * marker to look for), so presence cannot be inferred from the workspace the way
 * `.claude/`/`.codex/`/opencode configs can. Detection therefore keys on an
 * EXPLICIT catalog pin — `SOX_AGENT_MCP_DATABASE_PATH` or `ADHD_AGENT_DATABASE_PATH`
 * — and is otherwise false (the user passes `--host agent-mcp` explicitly).
 * Deliberately NOT based on the filesystem: keying on a home-dir DB would make
 * `detectHosts()` report agent-mcp for every workspace on a machine that happens
 * to have an agent-mcp catalog, which is not a workspace signal.
 */
function detect(workspaceRoot: string): boolean {
  void workspaceRoot;
  const pinned = process.env['SOX_AGENT_MCP_DATABASE_PATH'] ?? process.env['ADHD_AGENT_DATABASE_PATH'];
  return pinned !== undefined && pinned !== '';
}

// ---------------------------------------------------------------------------
// Scope roots
// ---------------------------------------------------------------------------

/**
 * The catalog is global — every scope resolves to the same discovery dir. Scope
 * still selects the ledger/ownership data root (handled by declarativeInstall),
 * not the catalog target. The 'org' scope is intentionally empty: soxe never
 * writes a managed tier ([inv:never-managed]).
 */
function scopePaths(scope: HostScope): ScopePathMap {
  switch (scope) {
    case 'project':
    case 'user':
    case 'local':
      return { [scope]: catalogDir() };
    case 'org':
      return {};
    default: {
      const _exhaustive: never = scope;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Provider derivation
// ---------------------------------------------------------------------------

/**
 * The catalog `provider` block. Mirrors the server's strict provider union
 * (`@adhd/agent-engine-orchestrator` `providerConfigSchema`): per-type key sets
 * are enforced by {@link validateProvider}; a key outside the set is a render
 * error, never a silently stripped field.
 */
export interface CatalogProvider {
  type: 'anthropic' | 'openai' | 'claudecli' | string;
  model?: string;
  env?: Record<string, string>;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  baseURL?: string;
  retryConfig?: Record<string, unknown>;
  models?: string[];
  billingScope?: string;
  tripwire?: Record<string, unknown>;
  claudePath?: string;
  allowedBuiltinTools?: string[];
  systemPromptIsAgentSpec?: boolean;
}

/** Native-tooling member as emitted to the catalog (`true` | `false` | overrides object). */
export type CatalogNativeMember = boolean | Record<string, unknown>;

/** The `nativeTooling` block — every member is emitted explicitly (never absent). */
export interface CatalogNativeTooling {
  fs: CatalogNativeMember;
  shell: CatalogNativeMember;
  dispatch: CatalogNativeMember;
  hitl: boolean;
}

/**
 * Thrown when the agent-mcp renderer cannot derive a provider because no
 * explicit render model/provider was supplied (or its vendor prefix is not in
 * the {@link PROVIDER_PROFILES} table). This is deliberate: the agent IR
 * `model` is a logical Claude tier and deriving "anthropic" from it silently
 * binds a host surface to a vendor it may not speak (bug eb1ab168). The throw
 * names the agent so the fix — a `render.<host>.model`/`.provider`, or a
 * `providerFrom` host-renderer link — is obvious.
 */
export class AgentProviderUnderivableError extends Error {
  constructor(agentName: string, detail?: string) {
    super(
      `[agent-mcp] cannot derive a provider for agent "${agentName}": ` +
        (detail ??
          `no render.agent-mcp.model or render.agent-mcp.provider was supplied, and the ` +
            `agent IR's logical Claude tier is deliberately not a provider source. `) +
        `Declare render.agent-mcp.model as a "<vendor>/<model>" slug with a vendor in ` +
        `{${Object.keys(PROVIDER_PROFILES).join(', ')}}, or render.agent-mcp.provider (object), ` +
        `or render.agent-mcp.provider: null for a deliberately unbound row, or wire providerFrom ` +
        `on the host renderer.`,
    );
    this.name = 'AgentProviderUnderivableError';
  }
}

/**
 * Thrown when a `render.agent-mcp` field fails fidelity validation (provider
 * key/env/temperature, mcpServers secrets, enum fields). Always names the agent.
 */
export class AgentRenderError extends Error {
  constructor(
    public readonly agentName: string,
    message: string,
  ) {
    super(`[agent-mcp] agent "${agentName}": ${message}`);
    this.name = 'AgentRenderError';
  }
}

/** `ADHD_AGENT_`-prefixed env-var NAME pointer — the only shape the server accepts. */
const ENV_POINTER_RE = /^ADHD_AGENT_[A-Z0-9_]+$/;

interface ProviderProfile {
  type: 'anthropic' | 'openai';
  env: Record<string, string>;
  /**
   * Emit the slug's model segment inline (`model`). Never an `env.model` pointer:
   * the server resolves an env pointer BEFORE the inline model (agent-mcp
   * config.ts), so a stale `ADHD_AGENT_*_MODEL` value in the operator's environment
   * would silently override the model the manifest declares.
   */
  inlineModel: boolean;
}

/**
 * Typed vendor-prefix → provider profile table (replaces the old substring
 * heuristic). Keyed by the `<vendor>/` prefix of the render model slug.
 * Env refs are `ADHD_AGENT_`-prefixed (BUG-ORCH-011 / assertEnvNamesAllowed).
 */
export const PROVIDER_PROFILES: Readonly<Record<string, ProviderProfile>> = Object.freeze({
  deepseek: {
    type: 'openai',
    inlineModel: true,
    env: {
      secret: 'ADHD_AGENT_DEEPSEEK_SECRET',
      base_url: 'ADHD_AGENT_DEEPSEEK_BASE_URL',
    },
  },
  openai: {
    type: 'openai',
    inlineModel: true,
    env: {
      secret: 'ADHD_AGENT_OPENAI_SECRET',
      base_url: 'ADHD_AGENT_OPENAI_BASE_URL',
    },
  },
  anthropic: {
    type: 'anthropic',
    inlineModel: true,
    env: { secret: 'ADHD_AGENT_ANTHROPIC_SECRET' },
  },
});

/** Keys each provider variant accepts (mirrors the server's strict union). */
const PROVIDER_KEYS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['type', 'model', 'env', 'temperature', 'maxTokens', 'timeoutMs', 'retryConfig', 'models', 'billingScope', 'tripwire'],
  openai: ['type', 'model', 'env', 'baseURL', 'temperature', 'maxTokens', 'timeoutMs', 'retryConfig', 'models', 'billingScope', 'tripwire'],
  claudecli: ['type', 'model', 'claudePath', 'timeoutMs', 'allowedBuiltinTools', 'systemPromptIsAgentSpec', 'models', 'billingScope', 'tripwire'],
};

/** IR built-in → Claude Code built-in name, for `claudecli.allowedBuiltinTools`. */
const CLAUDE_BUILTIN_NAMES: Readonly<Record<string, string>> = {
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  glob: 'Glob',
  grep: 'Grep',
  bash: 'Bash',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
};

/** True when `v` is a well-formed catalog provider object (object with string `type`). */
function isProviderObject(v: unknown): v is CatalogProvider {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as { type?: unknown }).type === 'string'
  );
}

function agentNameOf(ir: AgentIr, override?: AgentOverride): string {
  return typeof override?.name === 'string' && override.name !== ''
    ? override.name
    : typeof ir.name === 'string' && ir.name !== ''
      ? ir.name
      : '<unnamed>';
}

/** Validate a temperature and return it (AC7: outside [0,1] fails the render). */
function checkTemperature(agent: string, t: unknown): number {
  if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 1) {
    throw new AgentRenderError(agent, `temperature ${String(t)} must be a number in [0, 1]`);
  }
  return t;
}

/**
 * Validate an explicit provider object against the server's strict per-type key
 * set and the env-pointer rule (AC4/AC8/AC13). Returns a shallow copy.
 */
function validateProvider(agent: string, raw: Record<string, unknown>): CatalogProvider {
  const type = raw['type'] as string;
  const allowed = PROVIDER_KEYS[type];
  if (allowed === undefined) {
    throw new AgentRenderError(agent, `provider.type "${type}" must be one of: ${Object.keys(PROVIDER_KEYS).join(', ')}`);
  }
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new AgentRenderError(
        agent,
        `provider.${key} is not a valid key for provider type "${type}" (allowed: ${allowed.join(', ')})`,
      );
    }
  }
  const env = raw['env'];
  if (env !== undefined) {
    if (type === 'claudecli') {
      throw new AgentRenderError(agent, `provider.env is not valid for type "claudecli" (no credential pointers are emitted)`);
    }
    if (env === null || typeof env !== 'object' || Array.isArray(env)) {
      throw new AgentRenderError(agent, `provider.env must be an object of env-var NAME pointers`);
    }
    for (const [field, value] of Object.entries(env as Record<string, unknown>)) {
      if (field !== 'secret' && field !== 'base_url' && field !== 'model') {
        throw new AgentRenderError(agent, `provider.env.${field} is not allowed (secret | base_url | model)`);
      }
      if (typeof value !== 'string' || !ENV_POINTER_RE.test(value)) {
        throw new AgentRenderError(
          agent,
          `provider.env.${field} must be an ADHD_AGENT_-prefixed env-var NAME pointer matching ${String(ENV_POINTER_RE)} — a literal credential is never emitted`,
        );
      }
    }
  }
  if (raw['temperature'] !== undefined) {
    if (type === 'claudecli') throw new AgentRenderError(agent, `provider.temperature is not valid for type "claudecli"`);
    checkTemperature(agent, raw['temperature']);
  }
  const models = raw['models'];
  if (models !== undefined && (!Array.isArray(models) || models.some((m) => typeof m !== 'string' || m === ''))) {
    throw new AgentRenderError(agent, `provider.models must be an array of non-empty strings`);
  }
  const billing = raw['billingScope'];
  if (billing !== undefined && (typeof billing !== 'string' || billing === '')) {
    throw new AgentRenderError(agent, `provider.billingScope must be a non-empty string`);
  }
  const tripwire = raw['tripwire'];
  if (tripwire !== undefined) {
    if (tripwire === null || typeof tripwire !== 'object' || Array.isArray(tripwire)) {
      throw new AgentRenderError(agent, `provider.tripwire must be an object`);
    }
    for (const [k, v] of Object.entries(tripwire as Record<string, unknown>)) {
      if (!['baseMs', 'maxMs', 'probeLeaseMs'].includes(k) || typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
        throw new AgentRenderError(agent, `provider.tripwire.${k} must be one of baseMs|maxMs|probeLeaseMs with a positive integer value`);
      }
    }
  }
  const retry = raw['retryConfig'];
  if (retry !== undefined) {
    if (retry === null || typeof retry !== 'object' || Array.isArray(retry)) {
      throw new AgentRenderError(agent, `provider.retryConfig must be an object`);
    }
    for (const k of Object.keys(retry as Record<string, unknown>)) {
      if (!['retries', 'minTimeout', 'maxTimeout', 'factor', 'retryWindowMs'].includes(k)) {
        throw new AgentRenderError(agent, `provider.retryConfig.${k} is not valid (retries|minTimeout|maxTimeout|factor|retryWindowMs)`);
      }
    }
  }
  return { ...(raw as unknown as CatalogProvider) };
}

/** IR built-in tool names (strings and logical names), lower-cased. */
function irToolNames(ir: AgentIr, override?: AgentOverride): Set<string> | null {
  const tools = ir.tools;
  if (tools === undefined) return null;
  void override;
  const out = new Set<string>();
  for (const t of tools) out.add((typeof t === 'string' ? t : t.logical).toLowerCase());
  return out;
}

/**
 * Derive the agent-mcp provider block (or `null` for a deliberately unbound row).
 *
 * Precedence:
 *   1. `render.agent-mcp.provider: null` -> unbound row (O1; resolved from the
 *      session/task/global binding tiers at dispatch time);
 *   2. an explicit, well-formed `render.agent-mcp.provider` object (validated:
 *      strict per-type keys, ADHD_AGENT_ env pointers only, temperature in [0,1]);
 *   3. a `<vendor>/<model>` slug whose vendor is in {@link PROVIDER_PROFILES};
 *   4. otherwise THROW {@link AgentProviderUnderivableError}.
 *
 * `temperature` (override.provider.temperature, then override.temperature, then
 * the IR's) is emitted for anthropic/openai and never for claudecli. A
 * claudecli provider without `allowedBuiltinTools` gets them from the IR tools.
 *
 * The agent IR `model` is deliberately NOT consulted — it is a logical Claude
 * tier. In a real install the engine synthesizes `override.model` from the host's
 * `providerFrom` sibling render (see install.ts readAgentRenderInputs).
 */
function deriveProvider(ir: AgentIr, override: AgentOverride | undefined, report: AgentRenderReport): CatalogProvider | null {
  const agent = agentNameOf(ir, override);
  if (override !== undefined && override.provider === null) {
    report.unbound = true;
    return null;
  }
  let provider: CatalogProvider;
  const explicit = override?.provider;
  if (isProviderObject(explicit)) {
    provider = validateProvider(agent, explicit as unknown as Record<string, unknown>);
  } else {
    const slug = typeof override?.model === 'string' ? override.model : undefined;
    if (slug === undefined || !slug.includes('/')) {
      throw new AgentProviderUnderivableError(
        agent,
        slug === undefined
          ? undefined
          : `the model "${slug}" is not a "<vendor>/<model>" slug, so no provider profile applies. `,
      );
    }
    const slash = slug.indexOf('/');
    const vendor = slug.slice(0, slash).toLowerCase();
    const modelId = slug.slice(slash + 1);
    const profile = PROVIDER_PROFILES[vendor];
    if (profile === undefined || modelId === '') {
      throw new AgentProviderUnderivableError(agent, `the model "${slug}" has no provider profile for vendor "${vendor}". `);
    }
    provider = { type: profile.type, env: { ...profile.env } };
    if (profile.inlineModel) provider.model = modelId;
  }

  if (provider.type === 'claudecli') {
    if (provider.allowedBuiltinTools === undefined) {
      const names = irToolNames(ir, override);
      if (names !== null) {
        const mapped = [...names].filter((n) => CLAUDE_BUILTIN_NAMES[n] !== undefined).map((n) => CLAUDE_BUILTIN_NAMES[n] as string);
        provider.allowedBuiltinTools = mapped;
      }
    }
    return provider;
  }

  if (provider.temperature === undefined) {
    const t = override?.temperature ?? ir.temperature;
    if (t !== undefined) provider.temperature = checkTemperature(agent, t);
  }
  return provider;
}

// ---------------------------------------------------------------------------
// Native tooling / permissions / mcpServers derivation
// ---------------------------------------------------------------------------

type PermAction = 'allow' | 'ask' | 'deny';
type PermissionMap = Record<string, string | Record<string, string>>;

/** The fs server's tool names (the pinned `@modelcontextprotocol/server-filesystem`). */
const FS_READ_TOOLS = ['read_file', 'read_text_file', 'read_media_file', 'read_multiple_files', 'get_file_info', 'list_allowed_directories'];
const FS_LIST_TOOLS = ['list_directory', 'list_directory_with_sizes', 'directory_tree'];
const FS_SEARCH_TOOLS = ['search_files'];
const FS_WRITE_TOOLS = ['write_file', 'edit_file', 'create_directory', 'move_file'];

/** IR permission key -> the fs tool names it owns. A name's effective action is its owners' most permissive. */
const FS_OWNERS: ReadonlyArray<{ key: string; tools: readonly string[] }> = [
  { key: 'read', tools: FS_READ_TOOLS },
  { key: 'glob', tools: [...FS_LIST_TOOLS, ...FS_SEARCH_TOOLS] },
  { key: 'grep', tools: FS_SEARCH_TOOLS },
  { key: 'edit', tools: FS_WRITE_TOOLS },
  { key: 'write', tools: FS_WRITE_TOOLS },
];

/** Server-qualified gate keys (`<server>.<tool>`) for the native members. */
const SHELL_GATE_KEY = 'shell.shell_execute';
const DISPATCH_GATE_KEY = 'agent-mcp.task';

/** IR permission keys that are built-in tools (not logical MCP capabilities). */
const CORE_PERMISSION_KEYS = new Set([
  'read', 'edit', 'write', 'glob', 'grep', 'bash', 'task', 'webfetch', 'websearch',
  'todowrite', 'question', 'skill', 'external_directory', 'github',
]);

const ACTION_RANK: Record<PermAction, number> = { allow: 2, ask: 1, deny: 0 };

function asAction(v: unknown): PermAction | undefined {
  return v === 'allow' || v === 'ask' || v === 'deny' ? v : undefined;
}

function mostPermissive(actions: PermAction[]): PermAction {
  return actions.reduce((best, a) => (ACTION_RANK[a] > ACTION_RANK[best] ? a : best), 'deny' as PermAction);
}

/** Expand a leading `~/` and `${HOME}` against the effective home base. */
function expandHomeTokens(value: string): string {
  const base = getBase();
  let out = value;
  if (out === '~') out = base;
  else if (out.startsWith('~/')) out = base + out.slice(1);
  return out.split('${HOME}').join(base);
}

/** True when a stdio entry launches the agent-mcp server itself. */
function launchesAgentMcp(cfg: Record<string, unknown>): boolean {
  if (cfg['transport'] !== 'stdio') return false;
  const parts = [cfg['command'], ...(Array.isArray(cfg['args']) ? (cfg['args'] as unknown[]) : [])];
  return parts.some((p) => typeof p === 'string' && /(^|[/@\s])agent-mcp(\b|$)/.test(p));
}

const SECRET_KEY_RE = /secret|token|key|password/i;
const ENV_REF_RE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}|^\$[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate and normalize one mcpServers launch entry: expand home tokens in
 * command/args/cwd and reject literal secrets in env/headers (AC6).
 */
function normalizeServer(agent: string, key: string, raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AgentRenderError(agent, `mcpServers.${key} must be an object`);
  }
  const cfg: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const block of ['env', 'headers'] as const) {
    const m = cfg[block];
    if (m === undefined) continue;
    if (m === null || typeof m !== 'object' || Array.isArray(m)) {
      throw new AgentRenderError(agent, `mcpServers.${key}.${block} must be an object`);
    }
    for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k) && (typeof v !== 'string' || !ENV_REF_RE.test(v))) {
        throw new AgentRenderError(
          agent,
          `mcpServers.${key}.${block}.${k} looks like a credential with a literal value — use an env reference ("\${NAME}") instead`,
        );
      }
    }
  }
  if (typeof cfg['command'] === 'string') cfg['command'] = expandHomeTokens(cfg['command']);
  if (Array.isArray(cfg['args'])) cfg['args'] = (cfg['args'] as unknown[]).map((a) => (typeof a === 'string' ? expandHomeTokens(a) : a));
  if (typeof cfg['cwd'] === 'string') cfg['cwd'] = expandHomeTokens(cfg['cwd']);
  return cfg;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_');

interface ToolingPlan {
  nativeTooling: CatalogNativeTooling;
  mcpServers: Record<string, unknown>;
  permissions: Record<string, unknown>;
  nativeWebTools?: boolean;
}

/**
 * Derive nativeTooling + mcpServers + permissions from the IR `tools` /
 * `permission` and the per-host override. Records every un-representable rule in
 * `report.lost` (AC9) and every adjustment in `report.warnings`.
 */
function deriveTooling(ir: AgentIr, override: AgentOverride | undefined, report: AgentRenderReport): ToolingPlan {
  const agent = agentNameOf(ir, override);
  const permission: PermissionMap = (override?.permission ?? ir.permission ?? {}) as PermissionMap;
  const toolMap: Record<string, string> = override?.toolMap ?? {};
  const names = irToolNames(ir, override); // null => IR declares no tools (unspecified)
  const acceptLoss = override?.acceptLoss === true;
  const explicitNative = (override?.nativeTooling ?? {}) as Record<string, unknown>;

  const scalar = (k: string): PermAction | undefined => asAction(permission[k]);
  /** A built-in is available when listed (or tools unspecified) and not scalar-denied. */
  const available = (k: string): boolean => (names === null || names.has(k)) && scalar(k) !== 'deny';

  // ── fs ───────────────────────────────────────────────────────────────────
  const fsRules: Record<string, PermAction> = {};
  const fsAvailable = ['read', 'edit', 'write', 'glob', 'grep'].some(available);
  const ownerAction = (k: string): PermAction => (available(k) ? (scalar(k) ?? 'allow') : 'deny');
  if (fsAvailable) {
    const byTool = new Map<string, PermAction[]>();
    for (const { key, tools } of FS_OWNERS) {
      for (const t of tools) {
        const list = byTool.get(t) ?? [];
        list.push(ownerAction(key));
        byTool.set(t, list);
      }
    }
    for (const [t, actions] of byTool) {
      const effective = mostPermissive(actions);
      if (effective !== 'allow') fsRules[`fs.${t}`] = effective;
    }
  }
  const writeBlocked = !available('edit') && !available('write');

  // ── shell (O2) ────────────────────────────────────────────────────────────
  let shell: CatalogNativeMember = false;
  const bash = permission['bash'];
  const bashAvail = available('bash');
  const shellRules: Record<string, PermAction> = {};
  if (explicitNative['shell'] !== undefined) {
    shell = explicitNative['shell'] as CatalogNativeMember;
  } else if (bashAvail) {
    if (typeof bash === 'string' || bash === undefined) {
      shell = true;
      if (bash === 'ask') {
        shell = { permissions: { [SHELL_GATE_KEY]: 'ask' } };
      }
    } else {
      const entries = Object.entries(bash);
      const wildcard = asAction(bash['*']);
      const distinct = new Set(entries.map(([, a]) => a));
      if (distinct.size <= 1) {
        const only = (entries[0]?.[1] ?? 'allow') as string;
        shell = only === 'deny' ? false : only === 'ask' ? { permissions: { [SHELL_GATE_KEY]: 'ask' } } : true;
      } else {
        // Un-representable: command text is never matched by the gate (ADR-0008 D5).
        const baseline = wildcard ?? 'ask';
        const disposition: AgentRenderLoss['disposition'] =
          acceptLoss ? 'accepted' : 'dropped';
        for (const [pat, act] of entries) {
          if (pat === '*' || act === baseline) continue;
          report.lost.push({
            source: 'bash',
            pattern: pat,
            action: act,
            reason: 'command-text patterns cannot be enforced: the gate matches tool names only (ADR-0008 D5) and the shell server is allowlist-only',
            disposition,
          });
        }
        if (acceptLoss) {
          if (baseline === 'allow') shell = true;
          else if (baseline === 'ask') shell = { permissions: { [SHELL_GATE_KEY]: 'ask' } };
          else {
            const cmds = new Set<string>();
            for (const [pat, act] of entries) {
              if (act !== 'allow') continue;
              const head = pat.trim().split(/\s+/)[0] ?? '';
              if (/^[A-Za-z0-9._+-]+$/.test(head)) cmds.add(head);
            }
            shell = cmds.size > 0 ? { allowCommands: [...cmds].sort() } : false;
          }
        } else {
          shell = false;
          report.shellDisabledByLoss = true;
          report.warnings.push(
            `shell disabled (fail-closed, O2): bash permission has ${entries.length} command-pattern rule(s) the catalog cannot enforce; ` +
              `declare render.agent-mcp.nativeTooling.shell or render.agent-mcp.acceptLoss to keep it`,
          );
        }
      }
    }
  }
  if (explicitNative['shell'] !== undefined && bashAvail && typeof bash === 'object' && bash !== null) {
    const baseline = asAction(bash['*']) ?? 'ask';
    for (const [pat, act] of Object.entries(bash)) {
      if (pat === '*' || act === baseline) continue;
      report.lost.push({
        source: 'bash',
        pattern: pat,
        action: act,
        reason: 'command-text patterns cannot be enforced (ADR-0008 D5); an explicit nativeTooling.shell member replaces the derived one',
        disposition: 'covered-by-override',
      });
    }
  }
  void shellRules;

  // ── dispatch ──────────────────────────────────────────────────────────────
  let dispatch: CatalogNativeMember = false;
  const agentCatalogLogical = names !== null && names.has('agent-catalog');
  const task = permission['task'];
  const allowedAgents: string[] = [];
  if (explicitNative['dispatch'] !== undefined) {
    dispatch = explicitNative['dispatch'] as CatalogNativeMember;
  } else if (available('task') || agentCatalogLogical) {
    dispatch = true;
    if (typeof task === 'string' && task === 'ask') {
      dispatch = { permissions: { [DISPATCH_GATE_KEY]: 'ask' } };
    } else if (typeof task === 'object' && task !== null) {
      const entries = Object.entries(task);
      const wildcard = asAction(task['*']);
      if (wildcard === 'deny') {
        for (const [pat, act] of entries) {
          if (pat === '*') continue;
          if (act === 'allow' && !pat.includes('*')) allowedAgents.push(pat);
          else if (act === 'allow' || act === 'ask') {
            report.lost.push({
              source: 'task',
              pattern: pat,
              action: act,
              reason: act === 'ask' ? 'per-agent ask cannot be expressed in allowedAgents' : 'glob agent-name patterns cannot be expressed in allowedAgents',
              disposition: 'dropped',
            });
          }
        }
        if (allowedAgents.length === 0) dispatch = false;
      } else {
        for (const [pat, act] of entries) {
          if (pat === '*' || act === wildcard) continue;
          report.lost.push({
            source: 'task',
            pattern: pat,
            action: act,
            reason: 'allowedAgents is an allowlist; a deny/ask list over an allow-all baseline cannot be expressed',
            disposition: 'dropped',
          });
        }
      }
    }
  }

  // ── hitl: always explicit ───────────────────────────────────────────────
  const hitl = typeof explicitNative['hitl'] === 'boolean' ? (explicitNative['hitl'] as boolean) : available('question');

  // ── fs member ─────────────────────────────────────────────────────────────
  let fs: CatalogNativeMember = false;
  if (explicitNative['fs'] !== undefined) fs = explicitNative['fs'] as CatalogNativeMember;
  else if (fsAvailable) {
    const members: Record<string, unknown> = {};
    if (Object.keys(fsRules).length > 0) members['permissions'] = { ...fsRules };
    if (writeBlocked) members['readOnly'] = true;
    fs = Object.keys(members).length > 0 ? members : true;
  }

  // ── mcpServers: select by IR tools, via toolMap ──────────────────────────
  const launch = (override?.mcpServers ?? {}) as Record<string, unknown>;
  const mcpServers: Record<string, unknown> = {};
  const selectedKeys = new Set<string>();
  if (names === null) {
    for (const k of Object.keys(launch)) selectedKeys.add(k);
  } else {
    for (const t of ir.tools ?? []) {
      if (typeof t === 'string') {
        const mapped = toolMap[t];
        if (mapped !== undefined) selectedKeys.add(mapped);
      } else {
        selectedKeys.add(toolMap[t.logical] ?? t.server);
      }
    }
  }
  /** Scalar logical-capability rules: `X_*` / `mcp__X__*` keyed by server key or logical name. */
  const serverRules: Record<string, PermAction> = {};
  const denied = new Set<string>();
  for (const [pk, pv] of Object.entries(permission)) {
    if (CORE_PERMISSION_KEYS.has(pk)) continue;
    const act = asAction(pv);
    if (act === undefined) continue;
    let ident: string | undefined;
    const mcpForm = /^mcp__(.+?)__\*$/.exec(pk);
    if (mcpForm !== null) ident = mcpForm[1];
    else if (pk.endsWith('_*')) ident = pk.slice(0, -2);
    if (ident === undefined) continue;
    const id = norm(ident);
    const target = [...new Set([...selectedKeys, ...Object.keys(launch)])].find(
      (k) => norm(k) === id || norm(toolMap[ident as string] ?? '') === norm(k) || Object.entries(toolMap).some(([l, s]) => norm(l) === id && s === k),
    );
    if (target === undefined) continue; // capability not bound here: absent means unavailable (ADR-0026 D6)
    if (act === 'deny') denied.add(target);
    else if (act === 'ask') serverRules[`${target}.*`] = 'ask';
  }
  for (const k of selectedKeys) {
    if (denied.has(k)) {
      report.warnings.push(`mcpServers.${k} not mounted: IR permission denies its tools`);
      continue;
    }
    // The builtin dispatch server key is mounted by nativeTooling.dispatch (ADR-0008 D1),
    // never by an mcpServers entry: skip silently — no "not mounted" warning, no entry.
    if (k === 'agent-mcp' && dispatch !== false) continue;
    const cfg = launch[k];
    if (cfg === undefined) {
      report.warnings.push(`mcpServers.${k}: the IR references it but render.agent-mcp.mcpServers declares no launch config — not mounted`);
      continue;
    }
    const norm1 = normalizeServer(agent, k, cfg);
    if (launchesAgentMcp(norm1)) {
      report.warnings.push(`mcpServers.${k}: stdio entry launches agent-mcp itself — dropped; nativeTooling.dispatch carries the dispatch surface`);
      continue;
    }
    mcpServers[k] = norm1;
  }
  // Launch entries never selected are simply not mounted (least privilege).
  for (const [k, cfg] of Object.entries(launch)) {
    if (!(k in mcpServers) && !selectedKeys.has(k) && cfg !== undefined) {
      // validate even when unselected so a hostile manifest cannot hide a literal secret
      normalizeServer(agent, k, cfg);
    }
  }

  // ── external_directory & unmapped keys ───────────────────────────────────
  const ext = permission['external_directory'];
  if (ext !== undefined) {
    if (typeof ext === 'string') {
      report.lost.push({ source: 'external_directory', pattern: '', action: ext, reason: 'opencode-only path policy; the fs member scopes by root hints, not per-path rules', disposition: 'dropped' });
    } else {
      for (const [pat, act] of Object.entries(ext)) {
        report.lost.push({ source: 'external_directory', pattern: pat, action: act, reason: 'opencode-only path policy; the fs member scopes by root hints, not per-path rules', disposition: 'dropped' });
      }
    }
  }

  // ── server-level ask rules need a carrier member ──────────────────────────
  if (Object.keys(serverRules).length > 0) {
    const carrierOrder: Array<'fs' | 'shell' | 'dispatch'> = ['fs', 'shell', 'dispatch'];
    const members = { fs, shell, dispatch };
    const carrier = carrierOrder.find((m) => members[m] !== false && !(typeof members[m] === 'object' && 'transport' in (members[m] as object)));
    if (carrier === undefined) {
      for (const [pat, act] of Object.entries(serverRules)) {
        report.lost.push({ source: 'mcp', pattern: pat, action: act, reason: 'no enabled native member can carry gate rules', disposition: 'dropped' });
      }
    } else {
      const cur = members[carrier];
      const base = typeof cur === 'object' ? { ...(cur as Record<string, unknown>) } : {};
      base['permissions'] = { ...((base['permissions'] as Record<string, unknown> | undefined) ?? {}), ...serverRules };
      if (carrier === 'fs') fs = base;
      else if (carrier === 'shell') shell = base;
      else dispatch = base;
    }
  }

  // ── nativeWebTools (provider default otherwise) ──────────────────────────
  const plan: ToolingPlan = {
    nativeTooling: { fs, shell, dispatch, hitl },
    mcpServers,
    permissions: allowedAgents.length > 0 ? { allowedAgents } : {},
  };
  // `nativeWebTools` is ONE flag covering both fetch and search, so it can express "all web off" or "provider
  // default" but never "fetch denied, search allowed" (or the reverse). e00c47bb:
  //   - every web tool denied/unlisted (and at least one explicitly denied) => false, nothing lost. This holds when
  //     `tools` is unspecified too (names === null): an explicit deny of both is a full deny, never provider default.
  //   - exactly one denied while the other stays available (listed, or `tools` unspecified, and not denied) =>
  //     un-representable: fail closed (false, the deny is enforced at the cost of the allowed sibling) unless
  //     `acceptLoss`/an explicit override says otherwise; always recorded in report.lost (same disposition model as
  //     the bash pattern loss, O2).
  //   - one denied and the sibling UNLISTED (names !== null) => the sibling was never available, so this is the
  //     all-off case: false, nothing lost.
  const fetchDenied = scalar('webfetch') === 'deny';
  const searchDenied = scalar('websearch') === 'deny';
  const fetchAvail = available('webfetch');
  const searchAvail = available('websearch');
  const partialWebDeny = (fetchDenied && searchAvail) || (searchDenied && fetchAvail);
  if (partialWebDeny) {
    const deniedTool = fetchDenied ? 'webfetch' : 'websearch';
    const survivor = fetchDenied ? 'websearch' : 'webfetch';
    const overridden = override?.nativeWebTools !== undefined;
    const prefix = `nativeWebTools is a single flag for webfetch and websearch: a ${deniedTool} deny with ${survivor} available cannot be expressed; `;
    let outcome: string;
    if (override?.nativeWebTools === false) {
      outcome = `render.agent-mcp.nativeWebTools:false disables web, so the ${deniedTool} deny is enforced and ${survivor} is lost too`;
    } else if (override?.nativeWebTools === true) {
      outcome = `render.agent-mcp.nativeWebTools:true enables web, so the ${deniedTool} deny is not enforced`;
    } else if (acceptLoss) {
      outcome = `render.agent-mcp.acceptLoss keeps web at the provider default, so the ${deniedTool} deny is not enforced`;
    } else {
      outcome = `web tools are disabled (fail-closed), so ${survivor} is lost too`;
    }
    report.lost.push({
      source: deniedTool,
      pattern: '',
      action: 'deny',
      reason: prefix + outcome,
      disposition: overridden ? 'covered-by-override' : acceptLoss ? 'accepted' : 'dropped',
    });
  }
  if (override?.nativeWebTools !== undefined) plan.nativeWebTools = override.nativeWebTools;
  else if (partialWebDeny) {
    if (!acceptLoss) plan.nativeWebTools = false;
  } else if ((fetchDenied || searchDenied) && !fetchAvail && !searchAvail) plan.nativeWebTools = false;
  return plan;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/** The create/update payload the `agent-catalog` capability sends to the catalog. */
export interface AgentCatalogPayload {
  name: string;
  description?: string;
  systemPrompt: string;
  /** Absent only for a deliberately unbound row (`render.agent-mcp.provider: null`). */
  provider?: CatalogProvider;
  mcpServers: Record<string, unknown>;
  permissions: Record<string, unknown>;
  nativeTooling: CatalogNativeTooling;
  maxToolLoops?: number;
  sanitization?: 'none' | 'prefix' | 'wrap';
  toolAdvertisement?: 'names' | 'full';
  nativeWebTools?: boolean;
}

function newReport(): AgentRenderReport {
  return { lost: [], warnings: [], unbound: false, shellDisabledByLoss: false };
}

function checkEnum<T extends string>(agent: string, field: string, v: unknown, allowed: readonly T[]): T | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw new AgentRenderError(agent, `${field} must be one of: ${allowed.join(' | ')}`);
  }
  return v as T;
}

const agentMcpRenderer: HostRenderer = {
  // [bug eb1ab168]: agent-mcp serves the host surface that installed the row, so
  // when the manifest has no render.agent-mcp model/provider the engine inherits
  // the opencode render's model — the same model the opencode host runs the agent
  // with — instead of minting a Claude default.
  providerFrom: 'opencode',

  renderHeader(ir, override) {
    const header: Record<string, unknown> = {};
    const name = override?.name ?? ir.name;
    const description = override?.description ?? ir.description;
    if (name !== undefined) header['name'] = name;
    if (description !== undefined) header['description'] = description;
    const provider = deriveProvider(ir, override, newReport());
    if (provider !== null) header['provider'] = provider;
    return header;
  },

  // agent-mcp stores no "resolved tool names" block — tool advertisement is a
  // catalog config concern, not prose.
  renderToolNames() {
    return null;
  },

  render(ir, prose, override): RenderedArtifact {
    const name = override?.name ?? ir.name;
    if (name === undefined || name === '') {
      throw new Error('[agent-mcp] agent IR is missing the required `name` field');
    }
    const report = newReport();
    const provider = deriveProvider(ir, override, report);
    const tooling = deriveTooling(ir, override, report);
    const payload: AgentCatalogPayload = {
      name,
      systemPrompt: stripFrontmatter(prose),
      ...(provider !== null ? { provider } : {}),
      mcpServers: tooling.mcpServers,
      // Explicit render.agent-mcp.permissions (e.g. allowedAgents) win over derived ones.
      permissions: { ...tooling.permissions, ...(override?.permissions ?? {}) },
      nativeTooling: tooling.nativeTooling,
    };
    const description = override?.description ?? ir.description;
    if (description !== undefined) payload.description = description;
    const steps = override?.steps ?? ir.steps;
    if (steps !== undefined) payload.maxToolLoops = steps;
    const sanitization = checkEnum(name, 'sanitization', override?.sanitization, ['none', 'prefix', 'wrap'] as const);
    if (sanitization !== undefined) payload.sanitization = sanitization;
    const advertisement = checkEnum(name, 'toolAdvertisement', override?.toolAdvertisement, ['names', 'full'] as const);
    if (advertisement !== undefined) payload.toolAdvertisement = advertisement;
    if (tooling.nativeWebTools !== undefined) payload.nativeWebTools = tooling.nativeWebTools;
    return { kind: 'config-value', value: payload, report };
  },
};

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

function buildSurfaces(): SurfaceMap {
  // The catalog DB path is the recorded target (informative for dry-run / status);
  // the `agent-catalog` capability resolves the effective launch + env itself.
  const target = defaultCatalogDbPath();
  return {
    agent: {
      capability: 'agent-catalog',
      paths: {
        project: target,
        user: target,
        local: target,
      },
      postInstallHint:
        'agent-mcp: the agent is now dispatchable via the agent-mcp `task` MCP tool ' +
        '(agent_name mode) from any host connected to the same catalog DB.',
    },
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const agentMcpHost: HostModule = {
  host: 'agent-mcp',
  detect,
  scopePaths,
  render: agentMcpRenderer,
  get surfaces(): SurfaceMap {
    return buildSurfaces();
  },
};
