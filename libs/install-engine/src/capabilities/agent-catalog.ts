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
  type CatalogAgentDefinition,
} from '../agent-mcp-client.js';

/**
 * Structural mirror of host-registry's AgentCatalogPayload (kept local so this
 * module carries no static cross-package import — same pattern install.ts uses
 * for HostModuleLocal).
 */
export interface AgentCatalogPayload {
  name: string;
  description?: string;
  systemPrompt: string;
  provider: { type: string; model?: string; env?: Record<string, string> };
  mcpServers: Record<string, unknown>;
  permissions: Record<string, unknown>;
  maxToolLoops?: number;
}

/** Stable, portable ledger identifier for the catalog row (never absolute). */
export const AGENT_CATALOG_LEDGER_FILE = 'agent-mcp:catalog';

/**
 * Injectable catalog client — the real one talks MCP-over-stdio; tests inject a
 * fake so the capability can be exercised without spawning the server.
 */
export interface AgentCatalogClient {
  upsert(payload: AgentCatalogPayload): Promise<CatalogAgentDefinition>;
  delete(name: string): Promise<void>;
  read(name: string): Promise<CatalogAgentDefinition | null>;
}

export const defaultAgentCatalogClient: AgentCatalogClient = {
  upsert: (payload) => catalogUpsert(payload as unknown as CatalogAgentDefinition),
  delete: (name) => catalogDelete(name),
  read: (name) => catalogRead(name),
};

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

/**
 * Upsert the agent into the catalog and record the reversible ledger action.
 * Idempotent: a second apply updates the existing row (no duplicate).
 */
export async function apply(ctx: AgentCatalogCtx): Promise<{ applied: true }> {
  const payload = ctx.payload.value;
  if (payload === undefined || payload === null || typeof payload.name !== 'string' || payload.name === '') {
    throw new Error(`[agent-catalog] payload.value.name is required for ext=${ctx.ext}`);
  }

  const client = ctx.client ?? defaultAgentCatalogClient;
  await client.upsert(payload);

  const ledger = ctx.ledger ?? Ledger.load(ctx.scopeRoot, { isProject: ctx.isProject ?? false });
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
    },
  });
  ledger.save();
  return { applied: true };
}

/**
 * Reverse the row ([inv:ledger-reversible]): retire the agent. Idempotent —
 * a missing row is success.
 */
export async function reverse(ctx: {
  ext: string;
  client?: AgentCatalogClient;
}): Promise<void> {
  const client = ctx.client ?? defaultAgentCatalogClient;
  await client.delete(ctx.ext);
}
