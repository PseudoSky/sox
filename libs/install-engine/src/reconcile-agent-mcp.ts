/**
 * libs/install-engine/src/reconcile-agent-mcp.ts
 *
 * One-shot reconcile for the agent-mcp catalog (bug eb1ab168; fidelity rework per
 * docs/spec/agent-mcp-renderer-fidelity.md AC15-AC18).
 *
 * WHY A DEDICATED ONE-SHOT (and not `upgrade --all`): the agent-catalog install
 * path writes NO lockfile entry — install.ts gates lockfile/install-registry sync
 * to `mcp-server|service` — and the catalog row lives outside the ledger's file
 * targets. `upgrade --all`'s consumer pass therefore never sees these rows. This
 * module re-renders each catalog row from the current repo source and re-upserts
 * it through the SAME `declarativeInstall` path a fresh install uses.
 *
 * ONE SESSION, ONE READ: the whole pass runs inside a single agent-mcp server
 * (`withAgentMcpSession`) and a single `agent_list fullDefinition:true` supplies
 * BOTH the drift diff and the pre-apply snapshots; a row whose managed fields
 * already equal the render makes no write call.
 *
 * DEFAULT POLICY: every catalog row with a LOCAL manifest is compared (the old
 * anthropic-only default is retired — the diff now covers every managed field, not
 * just `{type, model, secret}`). `--dry-run` (AC17) lists per row the changed
 * managed fields and the loss report and mutates nothing. Applying over a lossy
 * row (IR permission rules the catalog cannot represent) needs `acceptLoss`
 * (`--accept-loss`, AC18), else the row is `skipped: lossy`. Rows with no local
 * manifest are `skipped: no-local-manifest` and NEVER deleted. `includeMissing`
 * also creates rows for local agent extensions that are not in the catalog yet.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AgentNotRenderableError,
  declarativeInstall,
  findLocalExtension,
  listLocalAgentMcpExtensions,
  renderAgentMcpRow,
  type AgentRenderReportLocal,
  type DeclarativeInstallResult,
  type InstallDescriptor,
  type RegistryHostScope,
} from './install.js';
import {
  catalogDelete,
  catalogList,
  catalogRead,
  catalogUpsert,
  changedManagedFields,
  staleMcpKeys,
  withAgentMcpSession,
  LEGACY_SOX_MCP_KEYS,
  type CatalogAgentDefinition,
  type CatalogUpsertOptions,
} from './agent-mcp-client.js';
import type { AgentCatalogClient } from './capabilities/agent-catalog.js';

/**
 * The catalog surface reconcile needs: the `AgentCatalogClient` upsert/read/delete
 * plus a LIST (which the install capability itself never needs). The default is
 * the MCP-over-stdio client; tests inject a fake.
 */
export interface ReconcileCatalogClient extends AgentCatalogClient {
  list(opts?: { fullDefinition?: boolean }): Promise<CatalogAgentDefinition[]>;
}

/** The per-extension re-install seam. Defaults to the real `declarativeInstall`. */
export type ReconcileInstallFn = (
  descriptor: InstallDescriptor,
  scope: RegistryHostScope,
  workspaceRoot: string,
  scopeRoot: string,
  opts?: { isProject?: boolean; catalogClient?: AgentCatalogClient; dryRun?: boolean },
) => Promise<DeclarativeInstallResult[]>;

/** A minimal, comparable slice of a catalog provider block. */
export interface ReconcileProviderSummary {
  type?: string;
  model?: string;
  secret?: string;
}

export type ReconcileOutcome =
  | 'rewritten'
  | 'created'
  | 'unchanged'
  | 'drift'
  | 'would-create'
  | 'skipped: lossy'
  | 'skipped: no-local-manifest'
  | 'skipped: not-renderable'
  | 'failed';

export interface ReconcileRowResult {
  name: string;
  before: ReconcileProviderSummary | null;
  after: ReconcileProviderSummary | null;
  outcome: ReconcileOutcome;
  detail?: string;
  /** Managed fields whose stored value differs from the render (drift / rewritten). */
  changedFields?: string[];
  /** IR permission rules the catalog cannot represent (the renderer's loss report). */
  lost?: AgentRenderReportLocal['lost'];
  /** Renderer warnings (shell disabled by loss, unmounted servers, dropped launchers). */
  warnings?: string[];
  /** mcpServers keys nulled (or that would be) on the row. */
  nulledMcpKeys?: string[];
  /** True when the rendered row carries no provider (`provider: null`). */
  unbound?: boolean;
  /** Pre-apply snapshot of the stored row (rollback = `agent_update` with it). */
  snapshot?: string;
}

export interface ReconcileSummary {
  rows: ReconcileRowResult[];
  considered: number;
  /** Rows rewritten or created (apply) — or that WOULD change (dry-run drift/would-create). */
  changed: number;
  unchanged: number;
  skipped: number;
  failed: number;
  /** Directory the pre-apply row snapshots were written to, when any were. */
  snapshotDir?: string;
}

export interface ReconcileAgentMcpOpts {
  /** Plan only — diff and classify rows, mutate nothing. */
  dryRun?: boolean;
  /** Legacy filter: only process rows whose provider.type === 'anthropic'. Default false. */
  onlyAnthropic?: boolean;
  /** Allow writing rows whose render dropped IR permission rules (`--accept-loss`). */
  acceptLoss?: boolean;
  /** Also create rows for local agent extensions (install.hosts includes agent-mcp) absent from the catalog. */
  includeMissing?: boolean;
  /** Where pre-apply snapshots go. Default `<root>/tmp/agent-mcp-reconcile/<timestamp>`. */
  snapshotDir?: string;
  scope: RegistryHostScope;
  scopeRoot: string;
  workspaceRoot: string;
  /** Injection seam (tests) — defaults to the MCP-over-stdio catalog client. */
  client?: ReconcileCatalogClient;
  /** Injection seam (tests) — defaults to the real `declarativeInstall`. */
  install?: ReconcileInstallFn;
}

/** Real catalog client, backed by the MCP-over-stdio agent-mcp client (ambient session). */
export function defaultReconcileClient(): ReconcileCatalogClient {
  return {
    list: (opts) => catalogList(opts),
    read: (name) => catalogRead(name),
    upsert: (payload, opts) => catalogUpsert(payload as unknown as CatalogAgentDefinition, opts),
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

function summarize(rows: ReconcileRowResult[], snapshotDir: string | undefined): ReconcileSummary {
  let changed = 0;
  let unchanged = 0;
  let skipped = 0;
  let failed = 0;
  for (const r of rows) {
    switch (r.outcome) {
      case 'rewritten':
      case 'created':
      case 'drift':
      case 'would-create':
        changed++;
        break;
      case 'unchanged':
        unchanged++;
        break;
      case 'skipped: lossy':
      case 'skipped: no-local-manifest':
      case 'skipped: not-renderable':
        skipped++;
        break;
      case 'failed':
        failed++;
        break;
    }
  }
  return { rows, considered: rows.length, changed, unchanged, skipped, failed, ...(snapshotDir !== undefined ? { snapshotDir } : {}) };
}

/**
 * Reconcile every catalog row (and, with `includeMissing`, every missing local
 * agent) from the local repo source.
 *
 * Idempotent: a row whose managed fields already equal the render is
 * `unchanged` and costs no write. A row with no local manifest is
 * `skipped: no-local-manifest` and never deleted.
 */
export async function reconcileAgentMcpCatalog(
  root: string,
  opts: ReconcileAgentMcpOpts,
): Promise<ReconcileSummary> {
  // One agent-mcp server for the whole pass (a no-op wrapper when the caller —
  // e.g. the CLI — already opened one, or when a fake client never spawns).
  return withAgentMcpSession(() => reconcileInSession(root, opts));
}

async function reconcileInSession(root: string, opts: ReconcileAgentMcpOpts): Promise<ReconcileSummary> {
  const client = opts.client ?? defaultReconcileClient();
  const install = opts.install ?? declarativeInstall;
  const onlyAnthropic = opts.onlyAnthropic ?? false;
  const dryRun = opts.dryRun === true;

  // ONE read: full definitions feed the diff, the snapshots, and the upsert's
  // `existing` (so a changed row costs one write call and no re-read).
  const rows = await client.list({ fullDefinition: true });
  const byName = new Map<string, CatalogAgentDefinition>();
  for (const r of rows) if (typeof r.name === 'string' && r.name !== '') byName.set(r.name, r);

  // Hand the install seam a client that reuses the list result as `existing`.
  const sessionClient: AgentCatalogClient = {
    read: (n) => client.read(n),
    delete: (n) => client.delete(n),
    upsert: (payload, o?: CatalogUpsertOptions) =>
      client.upsert(payload, { ...(o ?? {}), existing: byName.get(payload.name) ?? null }),
  };

  const results: ReconcileRowResult[] = [];
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotDir = opts.snapshotDir ?? path.join(root, 'tmp', 'agent-mcp-reconcile', ts);
  let wroteSnapshots = false;

  const snapshot = (name: string, row: CatalogAgentDefinition): string => {
    fs.mkdirSync(snapshotDir, { recursive: true });
    const file = path.join(snapshotDir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(row, null, 2) + '\n');
    wroteSnapshots = true;
    return file;
  };

  // Catalog rows first, then (optionally) local-only agents.
  const targets: Array<{ name: string; row: CatalogAgentDefinition | null }> = rows.map((row) => ({
    name: typeof row.name === 'string' ? row.name : '',
    row,
  }));
  if (opts.includeMissing === true) {
    for (const local of listLocalAgentMcpExtensions(root)) {
      if (!byName.has(local.rowName)) targets.push({ name: local.rowName, row: null });
    }
  }

  for (const { name, row } of targets) {
    const before = summarizeProvider(row);
    const base = { name, before, after: before };

    if (name === '') {
      results.push({ ...base, outcome: 'failed', detail: 'catalog row has no name' });
      continue;
    }
    if (row !== null && onlyAnthropic && before?.type !== 'anthropic') {
      results.push({ ...base, outcome: 'unchanged', detail: 'filtered: non-anthropic (--only-anthropic)' });
      continue;
    }
    const srcPath = findLocalExtension(root, name);
    if (srcPath === null) {
      results.push({ ...base, outcome: 'skipped: no-local-manifest' });
      continue;
    }

    // Pure render: the exact agent_create payload + loss report, no store touch.
    let rendered: ReturnType<typeof renderAgentMcpRow>;
    try {
      rendered = renderAgentMcpRow(name, srcPath);
    } catch (e) {
      // A raw-passthrough agent (no agent IR, no render.<host>) is not
      // renderable: an explicit skip, never a failure (bug f775d10c).
      if (e instanceof AgentNotRenderableError) {
        results.push({ ...base, outcome: 'skipped: not-renderable', detail: e.message });
      } else {
        results.push({ ...base, outcome: 'failed', detail: e instanceof Error ? e.message : String(e) });
      }
      continue;
    }
    const { payload, report } = rendered;
    const after = summarizeProvider(payload as unknown as CatalogAgentDefinition);
    const common = {
      name,
      before,
      after,
      lost: report.lost,
      warnings: report.warnings,
      unbound: report.unbound,
    };

    let changedFields: string[];
    let nulled: string[] = [];
    if (row === null) {
      changedFields = ['(new row)'];
    } else {
      nulled = staleMcpKeys(row, payload.mcpServers, LEGACY_SOX_MCP_KEYS);
      changedFields = changedManagedFields(row, payload as unknown as CatalogAgentDefinition, nulled);
      if (changedFields.length === 0) {
        results.push({ ...common, outcome: 'unchanged' });
        continue;
      }
    }

    if (dryRun) {
      results.push({
        ...common,
        outcome: row === null ? 'would-create' : 'drift',
        changedFields,
        nulledMcpKeys: nulled,
      });
      continue;
    }

    const lossy = report.lost.some((l) => l.disposition === 'dropped');
    if (lossy && opts.acceptLoss !== true) {
      results.push({
        ...common,
        outcome: 'skipped: lossy',
        changedFields,
        nulledMcpKeys: nulled,
        detail: `${report.lost.filter((l) => l.disposition === 'dropped').length} IR permission rule(s) cannot be represented; re-run with --accept-loss`,
      });
      continue;
    }

    try {
      const snap = row !== null ? snapshot(name, row) : undefined;
      // f775d10c: the real install path re-renders and upserts (ledger + ownership).
      const installed = await install(
        { ext: name, type: 'agent', hosts: ['agent-mcp'], srcPath },
        opts.scope,
        opts.workspaceRoot,
        opts.scopeRoot,
        { isProject: opts.scope === 'project', catalogClient: sessionClient },
      );
      const hit = installed.find((r) => r.capability === 'agent-catalog');
      results.push({
        ...common,
        outcome: row === null ? 'created' : 'rewritten',
        changedFields,
        nulledMcpKeys: hit?.nulledMcpKeys ?? nulled,
        ...(snap !== undefined ? { snapshot: snap } : {}),
      });
    } catch (e) {
      results.push({ ...common, outcome: 'failed', detail: e instanceof Error ? e.message : String(e) });
    }
  }

  return summarize(results, wroteSnapshots ? snapshotDir : undefined);
}
