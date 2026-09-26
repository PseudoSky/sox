/**
 * libs/install-engine/src/reconcile-agent-mcp.ts
 *
 * One-shot reconcile for the agent-mcp catalog (bug eb1ab168).
 *
 * WHY A DEDICATED ONE-SHOT (and not `upgrade --all`): the agent-catalog install
 * path writes NO lockfile entry — install.ts gates lockfile/install-registry sync
 * to `mcp-server|service` — and the catalog row lives outside the ledger's file
 * targets. `upgrade --all`'s consumer pass therefore never sees these rows. This
 * module re-renders each existing catalog row from the current repo source and
 * re-upserts it through the SAME `declarativeInstall` path a fresh install uses.
 *
 * DEFAULT POLICY: only rows whose `provider.type === 'anthropic'` are touched.
 * That is the set that is provably wrong — every sox row silently inherited the
 * deleted Claude alias table's default — while a correctly-derived openai row
 * (e.g. `researcher-deepseek`) is already right and is left alone. Passing
 * `onlyAnthropic: false` (CLI `--all`) processes every row.
 *
 * Rows with no local extension manifest are reported `skipped: no-local-manifest`
 * and NEVER deleted: the catalog is global and may hold rows this repo does not
 * own. The pass is idempotent — a second run reports `unchanged` for every row.
 */

import {
  declarativeInstall,
  findLocalExtension,
  type DeclarativeInstallResult,
  type InstallDescriptor,
  type RegistryHostScope,
} from './install.js';
import {
  catalogDelete,
  catalogList,
  catalogRead,
  catalogUpsert,
  type CatalogAgentDefinition,
} from './agent-mcp-client.js';
import type { AgentCatalogClient } from './capabilities/agent-catalog.js';

/**
 * The catalog surface reconcile needs: the `AgentCatalogClient` upsert/read/delete
 * plus a LIST (which the install capability itself never needs). The default is
 * the MCP-over-stdio client; tests inject a fake.
 */
export interface ReconcileCatalogClient extends AgentCatalogClient {
  list(): Promise<CatalogAgentDefinition[]>;
}

/** The per-extension re-install seam. Defaults to the real `declarativeInstall`. */
export type ReconcileInstallFn = (
  descriptor: InstallDescriptor,
  scope: RegistryHostScope,
  workspaceRoot: string,
  scopeRoot: string,
  opts?: { isProject?: boolean; catalogClient?: AgentCatalogClient },
) => Promise<DeclarativeInstallResult[]>;

/** A minimal, comparable slice of a catalog provider block. */
export interface ReconcileProviderSummary {
  type?: string;
  model?: string;
  secret?: string;
}

export type ReconcileOutcome =
  | 'rewritten'
  | 'unchanged'
  | 'planned'
  | 'skipped: non-anthropic'
  | 'skipped: no-local-manifest'
  | 'failed';

export interface ReconcileRowResult {
  name: string;
  before: ReconcileProviderSummary | null;
  after: ReconcileProviderSummary | null;
  outcome: ReconcileOutcome;
  detail?: string;
}

export interface ReconcileSummary {
  rows: ReconcileRowResult[];
  considered: number;
  changed: number;
  unchanged: number;
  skipped: number;
  failed: number;
}

export interface ReconcileAgentMcpOpts {
  /** Plan only — list and classify rows, mutate nothing. */
  dryRun?: boolean;
  /** Default true: only process rows whose provider.type === 'anthropic'. */
  onlyAnthropic?: boolean;
  scope: RegistryHostScope;
  scopeRoot: string;
  workspaceRoot: string;
  /** Injection seam (tests) — defaults to the MCP-over-stdio catalog client. */
  client?: ReconcileCatalogClient;
  /** Injection seam (tests) — defaults to the real `declarativeInstall`. */
  install?: ReconcileInstallFn;
}

/** Real catalog client, backed by the MCP-over-stdio agent-mcp client. */
export function defaultReconcileClient(): ReconcileCatalogClient {
  return {
    list: () => catalogList(),
    read: (name) => catalogRead(name),
    upsert: (payload) => catalogUpsert(payload as unknown as CatalogAgentDefinition),
    delete: (name) => catalogDelete(name),
  };
}

/** Extract the comparable provider slice from a catalog row, or null. */
function summarizeProvider(row: CatalogAgentDefinition | null): ReconcileProviderSummary | null {
  if (row === null) return null;
  const provider = row.provider;
  if (provider === null || typeof provider !== 'object' || Array.isArray(provider)) return null;
  const out: ReconcileProviderSummary = {};
  const type = (provider as Record<string, unknown>)['type'];
  if (typeof type === 'string') out.type = type;
  const model = (provider as Record<string, unknown>)['model'];
  if (typeof model === 'string') out.model = model;
  const env = (provider as Record<string, unknown>)['env'];
  if (env !== null && typeof env === 'object' && !Array.isArray(env)) {
    const secret = (env as Record<string, unknown>)['secret'];
    if (typeof secret === 'string') out.secret = secret;
  }
  return out;
}

function summarize(
  rows: ReconcileRowResult[],
): ReconcileSummary {
  let changed = 0;
  let unchanged = 0;
  let skipped = 0;
  let failed = 0;
  for (const r of rows) {
    switch (r.outcome) {
      case 'rewritten':
        changed++;
        break;
      case 'unchanged':
      case 'planned':
        unchanged++;
        break;
      case 'skipped: non-anthropic':
      case 'skipped: no-local-manifest':
        skipped++;
        break;
      case 'failed':
        failed++;
        break;
    }
  }
  return { rows, considered: rows.length, changed, unchanged, skipped, failed };
}

/**
 * Reconcile every (eligible) agent-mcp catalog row from the local repo source.
 *
 * Idempotent: a row whose re-rendered provider equals its current provider is
 * reported `unchanged`. A row with no local manifest is reported
 * `skipped: no-local-manifest` and never deleted.
 */
export async function reconcileAgentMcpCatalog(
  root: string,
  opts: ReconcileAgentMcpOpts,
): Promise<ReconcileSummary> {
  const client = opts.client ?? defaultReconcileClient();
  const install = opts.install ?? declarativeInstall;
  const onlyAnthropic = opts.onlyAnthropic ?? true;

  const rows = await client.list();
  const results: ReconcileRowResult[] = [];

  for (const row of rows) {
    const name = typeof row.name === 'string' ? row.name : '';
    const before = summarizeProvider(row);

    if (name === '') {
      results.push({
        name,
        before,
        after: before,
        outcome: 'failed',
        detail: 'catalog row has no name',
      });
      continue;
    }

    if (onlyAnthropic && before?.type !== 'anthropic') {
      results.push({
        name,
        before,
        after: before,
        outcome: 'skipped: non-anthropic',
      });
      continue;
    }

    const srcPath = findLocalExtension(root, name);
    if (srcPath === null) {
      results.push({
        name,
        before,
        after: before,
        outcome: 'skipped: no-local-manifest',
      });
      continue;
    }

    if (opts.dryRun === true) {
      results.push({ name, before, after: before, outcome: 'planned' });
      continue;
    }

    try {
      await install(
        { ext: name, type: 'agent', hosts: ['agent-mcp'], srcPath },
        opts.scope,
        opts.workspaceRoot,
        opts.scopeRoot,
        { isProject: opts.scope === 'project', catalogClient: client },
      );
      const afterRow = await client.read(name);
      const after = summarizeProvider(afterRow);
      const changed = JSON.stringify(before) !== JSON.stringify(after);
      results.push({
        name,
        before,
        after,
        outcome: changed ? 'rewritten' : 'unchanged',
      });
    } catch (e) {
      results.push({
        name,
        before,
        after: before,
        outcome: 'failed',
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return summarize(results);
}
