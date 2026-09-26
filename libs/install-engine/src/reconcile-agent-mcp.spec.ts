/**
 * reconcile-agent-mcp.spec.ts — one-shot agent-mcp catalog reconcile (bug eb1ab168).
 *
 * Drives `reconcileAgentMcpCatalog` with a fake catalog client and a fake install
 * seam, so the catalog server is never spawned. The fake install performs the
 * REAL render pipeline — `readAgentRenderInputs` (providerFrom inheritance) plus
 * the REAL agent-mcp host renderer, loaded from host-registry's built dist — and
 * upserts into the fake client. That is the same transform the production
 * `declarativeInstall` agent-catalog branch applies.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Module from 'node:module';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentNotRenderableError, declarativeInstall, readAgentRenderInputs } from './install.js';
import {
  reconcileAgentMcpCatalog,
  type ReconcileCatalogClient,
  type ReconcileInstallFn,
} from './reconcile-agent-mcp.js';
import type { AgentCatalogPayload } from './capabilities/agent-catalog.js';
import type { CatalogAgentDefinition } from './agent-mcp-client.js';

// host-registry's built dist — the same artifact install.ts requires at runtime.
// Loaded by a RUNTIME-computed path so it is a dynamic require (not a static
// cross-project import the nx boundary rule would reject); this is exactly how
// install.ts's own `require('@adhd/sox-host-registry')` resolves after build.
declare const __dirname: string;
const hostRegistryPath = path.resolve(__dirname, '../../host-registry/dist/index.js');
const hostRegistry = require(hostRegistryPath) as {
  agentMcpHost: { render: { providerFrom?: string; render(ir: unknown, prose: string, overrides?: unknown): { kind: string; value?: unknown } } };
};

// ── Drive the REAL declarativeInstall in source-mode ─────────────────────────
// install.ts's host loop lazily `require('@adhd/sox-host-registry')`. That bare
// specifier is rewritten to a relative dist path only by the post-tsc build
// (scripts/rewrite-paths.cjs), so under source-mode vitest it does NOT resolve
// (documented in data-paths.ts and mcp-project-sync.spec.ts). The f775d10c
// regression must exercise the REAL install branch — not a fake — so redirect
// just that one specifier to the built sibling dist for the duration of this
// spec. `vi.mock`/`resolve.alias` do not intercept a native require; a
// resolution hook does. Isolated + restored, never a node_modules mutation.
const M = Module as unknown as {
  _resolveFilename: (request: string, parent: unknown, isMain: boolean, options?: unknown) => string;
};
const originalResolveFilename = M._resolveFilename;
M._resolveFilename = function patchedResolveFilename(
  request: string,
  parent: unknown,
  isMain: boolean,
  options?: unknown,
): string {
  if (request === '@adhd/sox-host-registry') return hostRegistryPath;
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

afterAll(() => {
  M._resolveFilename = originalResolveFilename;
});

class FakeCatalogClient implements ReconcileCatalogClient {
  readonly rows = new Map<string, CatalogAgentDefinition>();
  readonly upserts: AgentCatalogPayload[] = [];
  constructor(initial: CatalogAgentDefinition[] = []) {
    for (const r of initial) this.rows.set(r.name, r);
  }
  list = async (): Promise<CatalogAgentDefinition[]> => [...this.rows.values()];
  read = async (name: string): Promise<CatalogAgentDefinition | null> => this.rows.get(name) ?? null;
  upsert = async (payload: AgentCatalogPayload): Promise<CatalogAgentDefinition> => {
    const row = payload as unknown as CatalogAgentDefinition;
    this.rows.set(row.name, row);
    this.upserts.push(payload);
    return row;
  };
  delete = async (name: string): Promise<void> => {
    this.rows.delete(name);
  };
}

const agentRow = (name: string, provider: Record<string, unknown>): CatalogAgentDefinition => ({ name, provider });

let workspace: string;
let scopeRoot: string;
let client: FakeCatalogClient;

/** Faithful fake of declarativeInstall's agent-catalog branch (no server spawn). */
const fakeInstall: ReconcileInstallFn = async (descriptor, _scope, _workspaceRoot, _scopeRoot, opts) => {
  const srcPath = descriptor.srcPath;
  if (srcPath === undefined) throw new Error('descriptor.srcPath required');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(srcPath, 'extension.json'), 'utf8'),
  ) as { entrypoint?: string };
  const entry = manifest.entrypoint ?? 'agent.md';
  const inputs = readAgentRenderInputs(srcPath, 'agent-mcp', hostRegistry.agentMcpHost.render);
  if (inputs === null) throw new Error('no render inputs');
  // Mirror install.ts's guard (f775d10c): a raw passthrough is not renderable.
  if (!inputs.renderable) throw new AgentNotRenderableError(descriptor.ext);
  const prose = fs.readFileSync(path.join(srcPath, entry), 'utf8');
  const rendered = hostRegistry.agentMcpHost.render.render(inputs.ir, prose, inputs.override);
  // Honor --dry-run like the real install: render in-memory, mutate nothing.
  if (opts?.dryRun === true) {
    return [{ host: 'agent-mcp', scope: 'user', capability: 'agent-catalog', target: `row '${descriptor.ext}'`, applied: false, dryRun: true }];
  }
  const target = opts?.catalogClient ?? client;
  await target.upsert(rendered.value as AgentCatalogPayload);
  return [{ host: 'agent-mcp', scope: 'user', capability: 'agent-catalog', target: `row '${descriptor.ext}'`, applied: true }];
};

function writeAgent(id: string, manifest: Record<string, unknown>): void {
  const dir = path.join(workspace, 'extensions', 'agents', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'agent.md'), `---\nname: ${id}\n---\n# ${id}\n`, 'utf8');
}

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-reconcile-mcp-'));
  workspace = path.join(base, 'ws');
  scopeRoot = path.join(base, 'data');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(scopeRoot, { recursive: true });
  // A real-shaped agent: IR model 'opus' (logical tier), opencode host model deepseek.
  writeAgent('researcher', {
    id: 'researcher',
    type: 'agent',
    agent: { name: 'researcher', model: 'opus' },
    render: { opencode: { model: 'deepseek/deepseek-flash' } },
    install: { type: 'agent', hosts: ['claude', 'opencode'] },
    entrypoint: 'agent.md',
  });
  client = new FakeCatalogClient([
    agentRow('researcher', { type: 'anthropic', model: 'claude-sonnet-4-5', env: { secret: 'ADHD_AGENT_ANTHROPIC_SECRET' } }),
    agentRow('researcher-deepseek', { type: 'openai', env: { secret: 'ADHD_AGENT_DEEPSEEK_SECRET' } }),
    agentRow('ghost-agent', { type: 'anthropic', model: 'claude-opus-4-1', env: { secret: 'ADHD_AGENT_ANTHROPIC_SECRET' } }),
  ]);
});

afterEach(() => {
  try { fs.rmSync(path.dirname(workspace), { recursive: true, force: true }); } catch { /* ignore */ }
});

const opts = (over: Partial<Parameters<typeof reconcileAgentMcpCatalog>[1]> = {}) => ({
  scope: 'project' as const,
  scopeRoot,
  workspaceRoot: workspace,
  client,
  install: fakeInstall,
  ...over,
});

describe('reconcileAgentMcpCatalog (bug eb1ab168)', () => {
  it('rewrites an anthropic row from local source; leaves openai rows; reports manifestless rows', async () => {
    const summary = await reconcileAgentMcpCatalog(workspace, opts());

    expect(summary.changed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.skipped).toBe(2);

    const researcher = summary.rows.find((r) => r.name === 'researcher')!;
    expect(researcher.outcome).toBe('rewritten');
    expect(researcher.before?.type).toBe('anthropic');
    expect(researcher.after?.type).toBe('openai');
    expect(researcher.after?.secret).toBe('ADHD_AGENT_DEEPSEEK_SECRET');
    expect(researcher.after?.type).not.toBe('anthropic');

    const openai = summary.rows.find((r) => r.name === 'researcher-deepseek')!;
    expect(openai.outcome).toBe('skipped: non-anthropic');

    const ghost = summary.rows.find((r) => r.name === 'ghost-agent')!;
    expect(ghost.outcome).toBe('skipped: no-local-manifest');
    // The manifestless row is NOT deleted.
    expect(await client.read('ghost-agent')).not.toBeNull();
  });

  it('is idempotent: a second pass reports 0 changed', async () => {
    await reconcileAgentMcpCatalog(workspace, opts());
    // --all so the now-openai row is re-processed rather than filtered out.
    const second = await reconcileAgentMcpCatalog(workspace, opts({ onlyAnthropic: false }));
    expect(second.changed).toBe(0);
    const researcher = second.rows.find((r) => r.name === 'researcher')!;
    expect(researcher.outcome).toBe('unchanged');
    expect(researcher.after?.type).toBe('openai');
  });

  it('--all (onlyAnthropic:false) processes every row, but manifestless ones are still skipped', async () => {
    const summary = await reconcileAgentMcpCatalog(workspace, opts({ onlyAnthropic: false }));
    // researcher rewritten; researcher-deepseek has no local manifest → skipped.
    expect(summary.rows.find((r) => r.name === 'researcher-deepseek')!.outcome).toBe('skipped: no-local-manifest');
    expect(summary.rows.find((r) => r.name === 'researcher')!.outcome).toBe('rewritten');
  });

  it('dry-run mutates nothing and plans the rewrite', async () => {
    const summary = await reconcileAgentMcpCatalog(workspace, opts({ dryRun: true }));
    expect(summary.changed).toBe(0);
    expect(summary.rows.find((r) => r.name === 'researcher')!.outcome).toBe('planned');
    expect(client.upserts).toHaveLength(0);
    expect((await client.read('researcher'))!.provider).toEqual({
      type: 'anthropic',
      model: 'claude-sonnet-4-5',
      env: { secret: 'ADHD_AGENT_ANTHROPIC_SECRET' },
    });
  });

  // ── f775d10c ───────────────────────────────────────────────────────────────
  // The blocking finding: a raw-passthrough agent (no `agent` IR, no `render`)
  // reached the renderer as `ir={}` and threw AgentProviderUnderivableError,
  // which reconcile caught as `failed` → cmdReconcileAgentMcp exit(1). The heal
  // could not complete. These cases drive the REAL declarativeInstall (not the
  // fake), which is exactly the path the earlier spec claimed to cover but
  // bypassed (152a6903).

  /** Write a raw-passthrough agent: install id `test-runner`, no IR, no render. */
  function writePassthrough(): void {
    writeAgent('test-agent', {
      id: 'test-runner',
      type: 'agent',
      install: { type: 'agent' },
      entrypoint: 'agent.md',
    });
  }

  it('[f775d10c] REAL declarativeInstall: a non-renderable agent is skipped, not failed', async () => {
    writePassthrough();
    // Isolated client: only test-runner is listed, so the shared researcher
    // fixture cannot contaminate the upsert assertion.
    const isolated = new FakeCatalogClient([
      agentRow('test-runner', {
        type: 'anthropic',
        model: 'claude-opus-4-1',
        env: { secret: 'ADHD_AGENT_ANTHROPIC_SECRET' },
      }),
    ]);

    const summary = await reconcileAgentMcpCatalog(
      workspace,
      opts({ client: isolated, install: declarativeInstall }),
    );

    expect(summary.failed).toBe(0);
    const row = summary.rows.find((r) => r.name === 'test-runner')!;
    expect(row.outcome).toBe('skipped: not-renderable');
    // The guard fires before the renderer: no throw escaped, no row written.
    expect(isolated.upserts).toHaveLength(0);
    // The row survives untouched (never deleted).
    expect((await isolated.read('test-runner'))!.provider).toMatchObject({ type: 'anthropic' });
  });

  it('[f775d10c] REAL declarativeInstall dry-run makes the SAME decision: skipped: not-renderable', async () => {
    writePassthrough();
    const isolated = new FakeCatalogClient([
      agentRow('test-runner', { type: 'anthropic', env: { secret: 'ADHD_AGENT_ANTHROPIC_SECRET' } }),
    ]);

    const summary = await reconcileAgentMcpCatalog(
      workspace,
      opts({ client: isolated, install: declarativeInstall, dryRun: true }),
    );

    expect(summary.failed).toBe(0);
    const row = summary.rows.find((r) => r.name === 'test-runner')!;
    // The dry-run renders in-memory and reaches the SAME verdict as apply — it
    // does not promise a `planned` rewrite that apply would reject.
    expect(row.outcome).toBe('skipped: not-renderable');
    expect(isolated.upserts).toHaveLength(0);
  });

  it('[f775d10c] renderAgentCatalogPayload guard is named + typed (no AgentProviderUnderivableError)', async () => {
    writePassthrough();
    const srcPath = path.join(workspace, 'extensions', 'agents', 'test-agent');
    await expect(
      declarativeInstall(
        { ext: 'test-runner', type: 'agent', hosts: ['agent-mcp'], srcPath },
        'project',
        workspace,
        scopeRoot,
        { catalogClient: client },
      ),
    ).rejects.toBeInstanceOf(AgentNotRenderableError);
  });
});
