/**
 * libs/host-registry/src/e00c47bb-shipped-agents-web.spec.ts
 *
 * e00c47bb MIG1: the seven shipped agents that deny exactly one web tool
 * (webfetch allowed, websearch denied) carry the explicit typed override
 * `render.agent-mcp.nativeWebTools: true`, so the single-tool web deny renders
 * as `covered-by-override` instead of silently flipping web off (the fail-closed
 * default introduced by e00c47bb AC1). Every OTHER shipped agent is unchanged.
 *
 * Renders the REAL manifests through the real agent-mcp renderer (same
 * ir + render.agent-mcp override that install.ts readAgentRenderInputs feeds it).
 * The agents root is overridable via E00C47BB_AGENTS_ROOT so the RED proof can
 * run the identical assertions against a scratch copy with an override removed.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { describe, it, expect } from 'vitest';
import type { AgentIr, AgentOverride, AgentRenderReport } from './internal.js';
import { agentMcpHost } from './agent-mcp.js';
import type { AgentCatalogPayload } from './agent-mcp.js';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const AGENTS_ROOT = process.env['E00C47BB_AGENTS_ROOT'] ?? path.join(REPO_ROOT, 'extensions/agents');
/**
 * Ref the pre-change expectations are derived from: main's tip dd8a8639, which already carries the
 * faa8064b tiered `nativeTooling.shell` blocks but not the nativeWebTools override. (The earlier
 * f22b1b12 baseline predates faa8064b, so its manifests lack the shell block.)
 */
const BASELINE_REF = 'dd8a8639';
const MIGRATED = ['architect', 'architect-decision', 'debug', 'performance', 'product', 'researcher', 'typescript'] as const;

interface Manifest {
  entrypoint?: string;
  agent?: AgentIr;
  render?: Record<string, AgentOverride>;
}

interface Rendered {
  payload: AgentCatalogPayload;
  report: AgentRenderReport;
}

function readManifest(dir: string): Manifest {
  return JSON.parse(fs.readFileSync(path.join(dir, 'extension.json'), 'utf8')) as Manifest;
}

function renderManifest(manifest: Manifest, prose: string): Rendered {
  const rendered = agentMcpHost.render!.render(manifest.agent ?? {}, prose, manifest.render?.['agent-mcp']);
  if (rendered.kind !== 'config-value') throw new Error(`expected config-value, got ${rendered.kind}`);
  if (rendered.report === undefined) throw new Error('agent-mcp render must return a report');
  return { payload: rendered.value as AgentCatalogPayload, report: rendered.report };
}

function renderAgent(id: string): Rendered {
  const dir = path.join(AGENTS_ROOT, id);
  const manifest = readManifest(dir);
  const prose = fs.readFileSync(path.join(dir, manifest.entrypoint ?? `${id}.md`), 'utf8');
  return renderManifest(manifest, prose);
}

/** The manifest as it was before this change: same bytes minus the nativeWebTools override. */
function withoutOverride(id: string): Manifest {
  const m = readManifest(path.join(AGENTS_ROOT, id));
  const override = { ...(m.render?.['agent-mcp'] ?? {}) };
  delete override.nativeWebTools;
  return { ...m, render: { ...m.render, 'agent-mcp': override } };
}

function renderWithout(id: string): Rendered {
  const dir = path.join(AGENTS_ROOT, id);
  const manifest = withoutOverride(id);
  const prose = fs.readFileSync(path.join(dir, manifest.entrypoint ?? `${id}.md`), 'utf8');
  return renderManifest(manifest, prose);
}

const bashLosses = (r: AgentRenderReport) => r.lost.filter((l) => l.source === 'bash');
const webLosses = (r: AgentRenderReport) => r.lost.filter((l) => l.source === 'websearch' || l.source === 'webfetch');

describe('e00c47bb MIG1 — migrated agents carry the explicit nativeWebTools override', () => {
  for (const id of MIGRATED) {
    describe(id, () => {
      it('e00c47bb MIG1 manifest declares render.agent-mcp.nativeWebTools === true and no acceptLoss', () => {
        const override = readManifest(path.join(AGENTS_ROOT, id)).render?.['agent-mcp'];
        expect(override?.nativeWebTools).toBe(true);
        expect(override?.acceptLoss).toBeUndefined();
      });

      it('e00c47bb MIG1 renders nativeWebTools === true and a websearch loss with disposition covered-by-override', () => {
        const { payload, report } = renderAgent(id);
        expect(payload.nativeWebTools).toBe(true);
        const web = webLosses(report);
        expect(web).toHaveLength(1);
        expect(web[0]).toMatchObject({ source: 'websearch', action: 'deny', disposition: 'covered-by-override' });
        expect(web[0]?.reason).toMatch(/nativeWebTools:true enables web, so the websearch deny is not enforced/);
      });

      it('e00c47bb MIG1 the only payload change vs the pre-override render is nativeWebTools (false -> true)', () => {
        const before = renderWithout(id);
        const after = renderAgent(id);
        // Pre-override state is the fail-closed default: the exact behaviour this migration replaces.
        expect(before.payload.nativeWebTools).toBe(false);
        expect(webLosses(before.report)[0]?.disposition).toBe('dropped');
        const { nativeWebTools: _b, ...beforeRest } = before.payload;
        const { nativeWebTools: _a, ...afterRest } = after.payload;
        expect(afterRest).toEqual(beforeRest);
      });

      // faa8064b gave every one of these manifests an explicit `nativeTooling.shell` allowlist, so the
      // bash command-pattern losses are `covered-by-override` (the explicit member replaces the derived
      // one) and shell is NOT disabled by loss. The nativeWebTools override must not change any of it.
      it('e00c47bb MIG1 bash losses (covered-by-override by the manifest shell allowlist), shell and warnings are UNCHANGED', () => {
        const before = renderWithout(id);
        const after = renderAgent(id);
        expect(bashLosses(after.report)).toEqual(bashLosses(before.report));
        expect(bashLosses(after.report).length).toBeGreaterThan(0);
        for (const l of bashLosses(after.report)) expect(l.disposition).toBe('covered-by-override');
        expect(after.report.shellDisabledByLoss).toBe(false);
        expect(after.report.shellDisabledByLoss).toBe(before.report.shellDisabledByLoss);
        // Never fail-open: shell is exactly the manifest's declared allowlist, not `true` and not unrestricted.
        const declared = readManifest(path.join(AGENTS_ROOT, id)).render?.['agent-mcp']?.nativeTooling as
          | { shell?: { allowCommands: string[]; timeoutMs: number } }
          | undefined;
        expect(declared?.shell?.allowCommands.length).toBeGreaterThan(0);
        expect(after.payload.nativeTooling.shell).toEqual(declared?.shell);
        expect(after.payload.nativeTooling.shell).toEqual(before.payload.nativeTooling.shell);
        expect(after.report.warnings).toEqual(before.report.warnings);
        expect(after.report.unbound).toBe(before.report.unbound);
      });
    });
  }

  it('e00c47bb MIG1 pre-change expectations match the baseline ref manifests (git show)', () => {
    let available = true;
    try {
      execFileSync('git', ['cat-file', '-e', `${BASELINE_REF}^{commit}`], { cwd: REPO_ROOT, stdio: 'ignore' });
    } catch {
      available = false; // shallow clone / ref pruned: the stripped-override derivation above still holds
    }
    if (!available) return;
    for (const id of MIGRATED) {
      const old = JSON.parse(
        execFileSync('git', ['show', `${BASELINE_REF}:extensions/agents/${id}/extension.json`], { cwd: REPO_ROOT, encoding: 'utf8' }),
      ) as Manifest;
      expect(old.render?.['agent-mcp']?.nativeWebTools).toBeUndefined();
      const now = withoutOverride(id);
      expect(now.agent).toEqual(old.agent);
      expect(now.render?.['agent-mcp']).toEqual(old.render?.['agent-mcp']);
    }
  });
});

describe('e00c47bb MIG1 — no other shipped agent changed nativeWebTools', () => {
  const others = fs
    .readdirSync(AGENTS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !(MIGRATED as readonly string[]).includes(d.name) && fs.existsSync(path.join(AGENTS_ROOT, d.name, 'extension.json')))
    .map((d) => d.name);

  it('e00c47bb MIG1 sanity: the sweep covers a non-trivial set of other agents', () => {
    expect(others.length).toBeGreaterThan(5);
  });

  for (const id of others) {
    it(`e00c47bb MIG1 ${id}: render.agent-mcp.nativeWebTools is not declared`, () => {
      expect(readManifest(path.join(AGENTS_ROOT, id)).render?.['agent-mcp']?.nativeWebTools).toBeUndefined();
    });
  }
});
