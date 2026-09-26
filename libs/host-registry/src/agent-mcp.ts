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

export interface CatalogProvider {
  type: 'anthropic' | 'openai' | 'claudecli' | string;
  model?: string;
  env?: Record<string, string>;
}

/**
 * Thrown when the agent-mcp renderer cannot derive a provider because no
 * explicit render model/provider was supplied. This is deliberate: the agent IR
 * `model` is a logical Claude tier and deriving "anthropic" from it silently
 * binds a host surface to a vendor it may not speak (bug eb1ab168). The throw
 * names the agent so the fix — a `render.<host>.model`/`.provider`, or a
 * `providerFrom` host-renderer link — is obvious.
 */
export class AgentProviderUnderivableError extends Error {
  constructor(agentName: string) {
    super(
      `[agent-mcp] cannot derive a provider for agent "${agentName}": ` +
        `no render.agent-mcp.model or render.agent-mcp.provider was supplied, and the ` +
        `agent IR's logical Claude tier is deliberately not a provider source. Declare ` +
        `render.agent-mcp.model (a deepseek/gpt/qwen/openai or vendor/model slug) or ` +
        `render.agent-mcp.provider, or wire providerFrom on the host renderer.`,
    );
    this.name = 'AgentProviderUnderivableError';
  }
}

/** True when `v` is a well-formed catalog provider object (object with string `type`). */
function isProviderObject(v: unknown): v is CatalogProvider {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as { type?: unknown }).type === 'string'
  );
}

/**
 * Derive the agent-mcp provider block from the per-host override.
 *
 * Precedence:
 *   1. an explicit, well-formed `render.agent-mcp.provider` (passed through verbatim);
 *   2. a `model` containing `deepseek`  → openai, ADHD_AGENT_DEEPSEEK_* env refs;
 *   3. a `model` containing `gpt|qwen|openai` → openai, ADHD_AGENT_OPENAI_* env refs;
 *   4. a vendor-slugged `model` (contains `/`, e.g. `deepseek/deepseek-flash` /
 *      `anthropic/claude-...`) → openai passthrough;
 *   5. otherwise → THROW {@link AgentProviderUnderivableError}.
 *
 * The agent IR `model` is deliberately NOT consulted — it is a logical Claude
 * tier, and neither claude-ish nor any other string may mint a vendor default
 * here (the deleted CLAUDE_MODEL_ALIASES table was exactly that defect). In a
 * real install the engine synthesizes `override.model` from the host's
 * `providerFrom` sibling render (see install.ts readAgentRenderInputs).
 *
 * Env refs MUST be ADHD_AGENT_-prefixed: the server rejects any other name at
 * create time (BUG-ORCH-011 / assertEnvNamesAllowed).
 */
function deriveProvider(ir: AgentIr, override?: AgentOverride): CatalogProvider {
  if (isProviderObject(override?.provider)) {
    return override.provider;
  }
  const hostModel = typeof override?.model === 'string' ? override.model : undefined;
  const model = (hostModel ?? '').toLowerCase();

  if (model.includes('deepseek')) {
    return {
      type: 'openai',
      env: {
        secret: 'ADHD_AGENT_DEEPSEEK_SECRET',
        base_url: 'ADHD_AGENT_DEEPSEEK_BASE_URL',
        model: 'ADHD_AGENT_DEEPSEEK_MODEL',
      },
    };
  }
  if (model.includes('gpt') || model.includes('qwen') || model.includes('openai')) {
    return {
      type: 'openai',
      env: {
        secret: 'ADHD_AGENT_OPENAI_SECRET',
        base_url: 'ADHD_AGENT_OPENAI_BASE_URL',
        model: 'ADHD_AGENT_OPENAI_MODEL',
      },
    };
  }
  // Vendor-slugged model (e.g. "deepseek/deepseek-flash") the catalog can pass through.
  if (hostModel !== undefined && hostModel.includes('/')) {
    return {
      type: 'openai',
      model: hostModel,
      env: { secret: 'ADHD_AGENT_OPENAI_SECRET', base_url: 'ADHD_AGENT_OPENAI_BASE_URL' },
    };
  }
  const agentName =
    typeof ir.name === 'string' && ir.name !== ''
      ? ir.name
      : typeof override?.name === 'string' && override.name !== ''
        ? override.name
        : '<unnamed>';
  throw new AgentProviderUnderivableError(agentName);
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/** The create/update payload the `agent-catalog` capability sends to the catalog. */
export interface AgentCatalogPayload {
  name: string;
  description?: string;
  systemPrompt: string;
  provider: CatalogProvider;
  mcpServers: Record<string, unknown>;
  permissions: Record<string, unknown>;
  maxToolLoops?: number;
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
    header['provider'] = deriveProvider(ir, override);
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
    const payload: AgentCatalogPayload = {
      name,
      systemPrompt: stripFrontmatter(prose),
      provider: deriveProvider(ir, override),
      mcpServers: override?.mcpServers ?? {},
      permissions: override?.permissions ?? {},
    };
    const description = override?.description ?? ir.description;
    if (description !== undefined) payload.description = description;
    const steps = override?.steps ?? ir.steps;
    if (steps !== undefined) payload.maxToolLoops = steps;
    return { kind: 'config-value', value: payload };
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
