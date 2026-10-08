/**
 * libs/host-registry/src/agent-manifests.shell-policy.spec.ts
 *
 * Ticket faa8064b, segment S3: the tiered `render.agent-mcp.nativeTooling.shell`
 * allowlist in the real `extensions/agents/<name>/extension.json` manifests
 * (ADR-0008 D5: the gate matches tool NAMES only; hard enforcement is the server
 * argv allowlist + srt). Wrapper names (`sox-git-ro|impl|merge`, `sox-rm`) are
 * shipped by libs/agent-shell-wrappers. Reads the real manifests, no fixtures.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

import { agentMcpHost } from './agent-mcp.js';
import type { AgentCatalogPayload } from './agent-mcp.js';
import type { AgentRenderReport, RenderedArtifact } from './internal.js';

const AGENTS_DIR = resolve(__dirname, '../../../extensions/agents');

type Tier = 'read-only' | 'implementer' | 'git-merge' | 'backlog-ops' | 'orchestrator';

/** The 17 agents that carry a shell block, with the tier the spec (section 1.2) assigns. */
const SHELL_AGENTS: Record<string, Tier> = {
  'agent-manager': 'implementer',
  architect: 'read-only',
  'architect-decision': 'read-only',
  'backlog-operator': 'backlog-ops',
  debug: 'implementer',
  devops: 'implementer',
  dispatcher: 'orchestrator',
  'doc-steward': 'implementer',
  'git-manager': 'git-merge',
  performance: 'implementer',
  'performance-engineer': 'implementer',
  product: 'read-only',
  qa: 'implementer',
  researcher: 'read-only',
  security: 'read-only',
  typescript: 'implementer',
  ui: 'implementer',
};

/** The 4 agents whose IR has no shell; they must stay free of a shell block. */
const NO_SHELL_AGENTS = ['doc-cartographer', 'doc-consumer', 'doc-evangelist', 'doc-reviewer'];

const WRAPPERS = ['sox-git-ro', 'sox-git-impl', 'sox-git-merge', 'sox-rm'] as const;

/** Per-tier wrapper grants. Plain `git` and plain `rm` are in no list. */
const TIER_WRAPPERS: Record<Tier, readonly string[]> = {
  'read-only': ['sox-git-ro'],
  orchestrator: ['sox-git-ro'],
  'backlog-ops': ['sox-git-ro'],
  implementer: ['sox-git-impl', 'sox-git-ro', 'sox-rm'],
  'git-merge': ['sox-git-impl', 'sox-git-merge', 'sox-git-ro', 'sox-rm'],
};

/** Names the server default policy rejects (F-C) or that escalate beyond the tier model. */
const BLOCKED = [
  'git', 'rm', 'sh', 'bash', 'zsh', 'node', 'python', 'python3', 'perl', 'ruby', 'php', 'env', 'sed',
  'sqlite3', 'timeout', 'xargs', 'nice', 'nohup', 'time', 'ssh', 'rsync', 'zip', 'vim', 'less',
  'find', 'curl', 'wget', 'gh', 'opencode', 'awk', 'tar', 'npm', 'yarn', 'sudo', 'chmod', 'chown', 'dd', 'eval', 'exec',
] as const;

const WRITE_CMDS = ['mkdir', 'touch', 'cp', 'mv', 'tee'] as const;
const READ_ONLY_SAFE = new Set([
  'rg', 'gx', 'ls', 'cat', 'head', 'tail', 'wc', 'sort', 'uniq', 'diff', 'stat', 'basename', 'dirname', 'which',
  'nx', 'npx', 'pnpm', 'scratch-agent-search', 'adhd-backlog', 'sox-git-ro',
]);

interface IManifest {
  agent: Record<string, unknown>;
  render: { 'agent-mcp': Record<string, any> };
}

function readManifest(name: string): IManifest {
  return JSON.parse(readFileSync(join(AGENTS_DIR, name, 'extension.json'), 'utf8')) as IManifest;
}

function shellOf(name: string): { allowCommands: string[]; timeoutMs: number } {
  return readManifest(name).render['agent-mcp'].nativeTooling.shell;
}

function render(name: string): { payload: AgentCatalogPayload; report: AgentRenderReport } {
  const m = readManifest(name);
  const r: RenderedArtifact = agentMcpHost.render!.render(m.agent, `---\nname: ${name}\n---\nbody\n`, m.render['agent-mcp']);
  if (r.kind !== 'config-value') throw new Error(`expected config-value, got ${r.kind}`);
  if (r.report === undefined) throw new Error('renderer returned no report');
  return { payload: r.value as AgentCatalogPayload, report: r.report };
}

describe('faa8064b AC1: tiered shell allowlist in the 17 agent manifests', () => {
  it('faa8064b AC1: every manifest in extensions/agents is covered (17 shell + 4 no-shell = 21)', () => {
    const dirs = readdirSync(AGENTS_DIR).filter((d) => existsSync(join(AGENTS_DIR, d, 'extension.json'))).sort();
    expect(dirs).toEqual([...Object.keys(SHELL_AGENTS), ...NO_SHELL_AGENTS].sort());
    expect(Object.keys(SHELL_AGENTS)).toHaveLength(17);
  });

  it.each(Object.entries(SHELL_AGENTS))('faa8064b AC1: %s (%s) renders its manifest shell block verbatim, no shell disabled by loss', (name) => {
    const declared = shellOf(name);
    const { payload, report } = render(name);
    expect(payload.nativeTooling.shell).toEqual(declared);
    expect(report.shellDisabledByLoss).toBe(false);
    expect(report.lost.filter((l) => l.source === 'bash').every((l) => l.disposition === 'covered-by-override')).toBe(true);
  });

  it.each(Object.entries(SHELL_AGENTS))('faa8064b AC1: %s (%s) carries exactly its tier wrapper set', (name, tier) => {
    const cmds = shellOf(name).allowCommands;
    expect(cmds.filter((c) => c.startsWith('sox-')).sort()).toEqual([...TIER_WRAPPERS[tier]].sort());
    expect(cmds.filter((c) => c.startsWith('sox-')).every((c) => (WRAPPERS as readonly string[]).includes(c))).toBe(true);
    // sox-git-merge is git-manager only
    expect(cmds.includes('sox-git-merge')).toBe(name === 'git-manager');
  });

  it.each(Object.keys(SHELL_AGENTS))('faa8064b AC1: %s allows no interpreter, plain git/rm, or blocked command', (name) => {
    const cmds = shellOf(name).allowCommands;
    for (const b of BLOCKED) expect(cmds, `${name} must not allow ${b}`).not.toContain(b);
    // sorted, unique, plain command names only (no globs, whitespace, or shell metacharacters)
    expect([...cmds]).toEqual([...new Set(cmds)].sort());
    for (const c of cmds) expect(c).toMatch(/^[A-Za-z0-9._+-]+$/);
  });

  it.each(Object.entries(SHELL_AGENTS).filter(([, t]) => t !== 'implementer' && t !== 'git-merge'))(
    'faa8064b AC1: non-writing tier %s (%s) has no write commands',
    (name, tier) => {
      const cmds = shellOf(name).allowCommands;
      for (const w of WRITE_CMDS) expect(cmds).not.toContain(w);
      expect(cmds).not.toContain('sox-rm');
      expect(cmds).not.toContain('sox-git-impl');
      for (const c of cmds) expect(READ_ONLY_SAFE.has(c), `${tier} ${name}: unexpected ${c}`).toBe(true);
    },
  );

  it('faa8064b AC1: only backlog-operator and agent-manager get adhd-backlog; only researcher gets scratch-agent-search', () => {
    const holders = (cmd: string) => Object.keys(SHELL_AGENTS).filter((n) => shellOf(n).allowCommands.includes(cmd)).sort();
    expect(holders('adhd-backlog')).toEqual(['agent-manager', 'backlog-operator']);
    expect(holders('scratch-agent-search')).toEqual(['researcher']);
  });

  it('faa8064b AC1: timeoutMs per tier (read-only/backlog/git-merge 300000, implementers and dispatcher 900000, architect-decision 60000)', () => {
    for (const [name, tier] of Object.entries(SHELL_AGENTS)) {
      const t = shellOf(name).timeoutMs;
      if (name === 'architect-decision') expect(t).toBe(60000);
      else if (name === 'doc-steward' || tier === 'read-only' || tier === 'backlog-ops' || tier === 'git-merge') expect(t).toBe(300000);
      else expect(t).toBe(900000);
    }
  });

  it('faa8064b AC1: the four no-shell agents have no shell block and render shell:false', () => {
    for (const name of NO_SHELL_AGENTS) {
      expect(readManifest(name).render['agent-mcp'].nativeTooling?.shell).toBeUndefined();
      expect(render(name).payload.nativeTooling.shell).toBe(false);
    }
  });
});

describe('faa8064b AC2: no manifest accepts loss', () => {
  it.each([...Object.keys(SHELL_AGENTS), ...NO_SHELL_AGENTS])('faa8064b AC2: %s has no acceptLoss', (name) => {
    expect(readFileSync(join(AGENTS_DIR, name, 'extension.json'), 'utf8')).not.toMatch(/"acceptLoss"/);
    expect(readManifest(name).render['agent-mcp']).not.toHaveProperty('acceptLoss');
  });
});
