/**
 * libs/install-engine/src/capabilities/agent-catalog.ts
 *
 * agent-catalog capability — write an agent definition into a remote agent
 * catalog over that catalog's own MCP surface (the agent-mcp host).
 * [def:capability], [inv:ledger-reversible].
 *
 * Unlike every file-based capability this targets no filesystem path: the
 * artifact is a ROW in the agent-mcp catalog. Apply is an idempotent upsert
 * (`agent_read` → `agent_update` or `agent_create`); reverse is `agent_delete`.
 * The SANCTIONED write path is the package's own MCP server spoken over stdio
 * (see ../agent-mcp-client.ts) — never a direct `agents.db` write.
 *
 * The ledger records a stable, portable pseudo-path (`agent-mcp:catalog`) so
 * project-scope ledgers stay repo-relative ([inv:ledger-reversible]); the agent
 * NAME is the extension id, which is what reverse needs.
 */

import { Ledger, sha256 } from '../ledger.js';
import {
  catalogDelete,
  catalogRead,
  catalogUpsert,
  digestOf,
  LEGACY_SOX_MCP_KEYS,
  type CatalogAgentDefinition,
  type CatalogUpsertOptions,
  type CatalogUpsertOutcome,
  type CatalogUpsertResult,
} from '../agent-mcp-client.js';

/**
 * The create/update payload for an agent-catalog row. This is the install-engine
 * side of the ONE payload contract: it is structurally identical to
 * host-registry's `AgentCatalogPayload` (the renderer's output) and is kept as a
 * type here only because this package reaches host-registry through a lazy
 * runtime `require` (no static cross-package import; rootDir/lint boundary).
 * Every field is explicit — nothing the catalog owns is left to server defaults.
 */
export interface AgentCatalogPayload {
  name: string;
  description?: string;
  systemPrompt: string;
  /** Absent only for a deliberately unbound row (`render.agent-mcp.provider: null`). */
  provider?: Record<string, unknown> & { type: string };
  mcpServers: Record<string, unknown>;
  permissions: Record<string, unknown>;
  nativeTooling: {
    fs: boolean | Record<string, unknown>;
    shell: boolean | Record<string, unknown>;
    dispatch: boolean | Record<string, unknown>;
    hitl: boolean;
  };
  maxToolLoops?: number;
  sanitization?: 'none' | 'prefix' | 'wrap';
  toolAdvertisement?: 'names' | 'full';
  nativeWebTools?: boolean;
}

/** Stable, portable ledger identifier for the catalog row (never absolute). */
export const AGENT_CATALOG_LEDGER_FILE = 'agent-mcp:catalog';

/** The payload fields soxe owns on a catalog row (recorded in the ledger `meta.managedFields`). */
export function managedFieldsOf(payload: AgentCatalogPayload): string[] {
  return Object.keys(payload).filter((k) => k !== 'name' && (payload as unknown as Record<string, unknown>)[k] !== undefined).sort();
}

/**
 * Injectable catalog client — the real one talks MCP-over-stdio; tests inject a
 * fake so the capability can be exercised without spawning the server.
 */
export interface AgentCatalogClient {
  upsert(payload: AgentCatalogPayload, opts?: CatalogUpsertOptions): Promise<CatalogUpsertResult | CatalogAgentDefinition>;
  delete(name: string): Promise<void>;
  read(name: string): Promise<CatalogAgentDefinition | null>;
}

export const defaultAgentCatalogClient: AgentCatalogClient = {
  upsert: (payload, opts) => catalogUpsert(payload as unknown as CatalogAgentDefinition, opts),
  delete: (name) => catalogDelete(name),
  read: (name) => catalogRead(name),
};

/** Normalize a client's upsert return (legacy fakes return the bare definition). */
function asUpsertResult(out: CatalogUpsertResult | CatalogAgentDefinition): CatalogUpsertResult {
  const o = out as Partial<CatalogUpsertResult>;
  if (typeof o.outcome === 'string' && o.row !== undefined) return o as CatalogUpsertResult;
  return { outcome: 'updated', row: out as CatalogAgentDefinition, nulledMcpKeys: [] };
}

export interface AgentCatalogTarget {
  /** The resolved surface path (informative; the catalog is addressed by name, not path). */
  filePath: string;
}

export interface AgentCatalogCtx {
  host: string;
  scope: string;
  scopeRoot: string;
  workspaceRoot?: string;
  isProject?: boolean;
  ext: string;
  target: AgentCatalogTarget;
  payload: { value: AgentCatalogPayload };
  ledger?: Ledger;
  /** Test injection — defaults to the MCP-over-stdio client. */
  client?: AgentCatalogClient;
}

/** What `apply` reports back so the installer can surface the outcome. */
export interface AgentCatalogApplyResult {
  applied: true;
  outcome: CatalogUpsertOutcome;
  /** mcpServers keys nulled on the row (stale owned / welded agent-mcp launchers). */
  nulledMcpKeys: string[];
  /** sha256 of the canonical managed payload (recorded as `meta.rowDigest`). */
  rowDigest: string;
}

/**
 * Upsert the agent into the catalog and record the reversible ledger action.
 * Idempotent: a second apply of an unchanged payload makes NO write call
 * (`outcome: 'unchanged'`); a changed one nulls the owned mcpServers keys it no
 * longer renders. The ledger records `rowName`, `ownedMcpKeys`, `managedFields`
 * and `rowDigest` (the digest reconcile compares against a fresh render).
 */
export async function apply(ctx: AgentCatalogCtx): Promise<AgentCatalogApplyResult> {
  const payload = ctx.payload.value;
  if (payload === undefined || payload === null || typeof payload.name !== 'string' || payload.name === '') {
    throw new Error(`[agent-catalog] payload.value.name is required for ext=${ctx.ext}`);
  }

  const ledger = ctx.ledger ?? Ledger.load(ctx.scopeRoot, { isProject: ctx.isProject ?? false });
  const previous = ledger
    .actionsFor(ctx.ext, ctx.host, ctx.scope)
    .find((a) => a.cap === 'agent-catalog');
  const prevOwned = previous?.meta?.['ownedMcpKeys'];
  // Owned = what the ledger recorded on the previous apply UNION the legacy sox key
  // set. The legacy set is always included because the ledger is per-scope, not
  // per-catalog: a row written by an older manifest (or into another catalog) still
  // carries the welded `agent` entry and the servers its agent no longer mounts, and
  // an entry that predates ownership tracking records nothing at all.
  const ownedMcpKeys = [...new Set([...(Array.isArray(prevOwned) ? (prevOwned as string[]) : []), ...LEGACY_SOX_MCP_KEYS])];

  const client = ctx.client ?? defaultAgentCatalogClient;
  const result = asUpsertResult(await client.upsert(payload, { ownedMcpKeys }));

  const rowDigest = digestOf(payload);
  // Replace any prior action for this (ext, host, scope) so repeated applies do
  // not accumulate ledger rows — the catalog holds exactly one row per name.
  ledger.remove(ctx.ext, ctx.host, ctx.scope);
  ledger.record({
    ext: ctx.ext,
    host: ctx.host,
    scope: ctx.scope,
    action: {
      cap: 'agent-catalog',
      file: AGENT_CATALOG_LEDGER_FILE,
      keyPath: '',
      appliedHash: sha256(payload),
      // 6a10f744: the catalog row is named from the rendered payload name
      // (`override.name ?? ir.name`), which may differ from the extension id
      // (e.g. ext `memory-org` -> row `org-agent`). Record the row name so
      // reverse deletes the row it actually created, not `ctx.ext`.
      meta: {
        rowName: payload.name,
        ownedMcpKeys: Object.keys(payload.mcpServers ?? {}).sort(),
        managedFields: managedFieldsOf(payload),
        rowDigest,
      },
    },
  });
  ledger.save();
  return { applied: true, outcome: result.outcome, nulledMcpKeys: result.nulledMcpKeys, rowDigest };
}

/**
 * Reverse the row ([inv:ledger-reversible]): retire the agent. Idempotent —
 * a missing row is success.
 */
export async function reverse(ctx: {
  ext: string;
  /** The catalog row name recorded at apply time (6a10f744); defaults to `ext`. */
  name?: string;
  client?: AgentCatalogClient;
}): Promise<void> {
  const client = ctx.client ?? defaultAgentCatalogClient;
  await client.delete(ctx.name ?? ctx.ext);
}
