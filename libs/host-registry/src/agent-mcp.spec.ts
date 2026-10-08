/**
 * libs/host-registry/src/agent-mcp.spec.ts
 *
 * Tests for the agent-mcp host module + its agent renderer.
 * Follows the host-registry spec conventions (vitest, real fs fixtures,
 * save/restore SOX_SANDBOX_ROOT, no mocking).
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AgentIr, AgentOverride } from './internal.js';

import { agentMcpHost, resolveAgentMcpEnv, defaultCatalogDbPath, AgentProviderUnderivableError } from './agent-mcp.js';
import type { AgentCatalogPayload } from './agent-mcp.js';

const ENV_KEYS = ['SOX_AGENT_MCP_DATABASE_PATH', 'SOX_AGENT_MCP_REGISTRY_DB_PATH', 'ADHD_AGENT_DATABASE_PATH', 'ADHD_AGENT_REGISTRY_DB_PATH', 'SOX_SANDBOX_ROOT'];
let saved: Record<string, string | undefined>;
let sandbox: string;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-agent-mcp-'));
  process.env['SOX_SANDBOX_ROOT'] = sandbox;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('agent-mcp — host module', () => {
  it('exports host name "agent-mcp"', () => {
    expect(agentMcpHost.host).toBe('agent-mcp');
  });

  it('agent surface uses the agent-catalog capability', () => {
    expect(agentMcpHost.surfaces['agent']?.capability).toBe('agent-catalog');
  });

  it('has no surface for non-agent types', () => {
    expect(agentMcpHost.surfaces['skill']).toBeUndefined();
    expect(agentMcpHost.surfaces['mcp-server']).toBeUndefined();
  });

  it('detect() is true when ADHD_AGENT_DATABASE_PATH is pinned', () => {
    process.env['ADHD_AGENT_DATABASE_PATH'] = path.join(sandbox, 'agents.db');
    expect(agentMcpHost.detect(sandbox)).toBe(true);
  });

  it('detect() is false on a bare sandbox', () => {
    expect(agentMcpHost.detect(sandbox)).toBe(false);
  });
});

describe('agent-mcp — renderer', () => {
  const ir = {
    name: 'researcher',
    description: 'Discovery researcher',
    model: 'sonnet',
    steps: 30,
  };
  const prose = '---\nname: researcher\n---\nYou are the researcher.\n';

  /** Narrow a rendered artifact to its config-value payload (type-safe). */
  function payloadOf(rendered: import('./internal.js').RenderedArtifact): AgentCatalogPayload {
    if (rendered.kind !== 'config-value') throw new Error(`expected config-value, got ${rendered.kind}`);
    return rendered.value as AgentCatalogPayload;
  }

  it('renders a config-value create payload with the IR mapping', () => {
    // An explicit host model is supplied because the IR `model` is a logical
    // Claude tier and is deliberately NOT a provider source (bug eb1ab168).
    const result = agentMcpHost.render!.render(ir, prose, { model: 'deepseek/deepseek-flash' });
    expect(result.kind).toBe('config-value');
    const payload = payloadOf(result);
    expect(payload.name).toBe('researcher');
    expect(payload.description).toBe('Discovery researcher');
    expect(payload.systemPrompt).toBe('You are the researcher.\n'); // frontmatter stripped
    expect(payload.mcpServers).toEqual({});
    expect(payload.permissions).toEqual({});
    expect(payload.maxToolLoops).toBe(30);
  });

  // Regression for bug eb1ab168: the renderer used to read the logical Claude
  // tier (ir.model) and mint an anthropic default via a CLAUDE_MODEL_ALIASES
  // table. Both are deleted — an explicit host model is now the only source.
  it('derives an openai provider from the host model override, never from the logical IR tier', () => {
    const payload = payloadOf(
      agentMcpHost.render!.render({ name: 'dispatcher', model: 'opus' }, prose, { model: 'deepseek/deepseek-flash' }),
    );
    expect(payload.provider?.type).toBe('openai');
    expect(payload.provider?.type).not.toBe('anthropic');
    expect(payload.provider?.env?.['secret']).toBe('ADHD_AGENT_DEEPSEEK_SECRET');
    expect(payload.provider?.model).not.toBe('claude-sonnet-4-5');
  });

  // NEGATIVE CONTROL: no host model/provider ⇒ hard error, no payload. This must
  // NEVER silently yield the old 'claude-sonnet-4-5' anthropic default.
  it('throws AgentProviderUnderivableError (no payload) when no host model is supplied', () => {
    const renderNoOverride = (): AgentCatalogPayload =>
      payloadOf(agentMcpHost.render!.render({ name: 'dispatcher', model: 'opus' }, prose));
    expect(renderNoOverride).toThrow(AgentProviderUnderivableError);
    let payload: AgentCatalogPayload | undefined;
    try {
      payload = renderNoOverride();
    } catch (e) {
      expect(e).toBeInstanceOf(AgentProviderUnderivableError);
      expect((e as Error).message).toContain('[agent-mcp] cannot derive a provider for agent "dispatcher"');
      expect((e as Error).message).toContain('render.agent-mcp');
    }
    expect(payload).toBeUndefined();
  });

  it('derives an openai provider from a deepseek model override', () => {
    const payload = payloadOf(agentMcpHost.render!.render(ir, prose, { model: 'deepseek/deepseek-v4-flash' }));
    expect(payload.provider?.type).toBe('openai');
    expect(payload.provider?.env?.['secret']).toBe('ADHD_AGENT_DEEPSEEK_SECRET');
  });

  // NC companion to render-override.spec.ts: a bare logical tier inherited from a
  // sibling render reaches the renderer verbatim and must THROW — never anthropic.
  it('NC: a bare logical tier as the override model throws (never anthropic)', () => {
    expect(() => agentMcpHost.render!.render(ir, prose, { model: 'opus' })).toThrow(
      AgentProviderUnderivableError,
    );
  });

  it('honours an explicit render.agent-mcp provider override', () => {
    const provider = { type: 'claudecli', model: 'sonnet' };
    const payload = payloadOf(agentMcpHost.render!.render(ir, prose, { provider }));
    expect(payload.provider).toEqual(provider);
  });

  it('honours mcpServers / permissions overrides', () => {
    const payload = payloadOf(
      agentMcpHost.render!.render(ir, prose, {
        model: 'deepseek/deepseek-flash',
        mcpServers: { search: { transport: 'stdio' } },
        permissions: { allowedAgents: ['researcher'] },
      }),
    );
    expect(payload.mcpServers).toEqual({ search: { transport: 'stdio' } });
    expect(payload.permissions).toEqual({ allowedAgents: ['researcher'] });
  });

  // cac771f8 AC4 companion: agent-mcp appends nothing — systemPrompt is the stripped body verbatim (one "\n" in, one out).
  it('cac771f8 AC4 systemPrompt keeps the source trailing newline verbatim (no append, no normalize)', () => {
    const render = (p: string) => payloadOf(agentMcpHost.render!.render(ir, p, { model: 'deepseek/deepseek-flash' })).systemPrompt;
    expect(render('---\nname: researcher\n---\nBody.\n')).toBe('Body.\n');
    expect(render('---\nname: researcher\n---\nBody.')).toBe('Body.');
  });

  it('throws when the IR has no name', () => {
    expect(() => agentMcpHost.render!.render({}, 'body')).toThrow(/missing the required `name`/);
  });
});

describe('agent-mcp — real review manifest golden render (cac771f8)', () => {
  const reviewDir = path.resolve(__dirname, '../../../extensions/agents/review');
  const manifest = JSON.parse(fs.readFileSync(path.join(reviewDir, 'extension.json'), 'utf8')) as {
    agent: AgentIr;
    render: Record<string, AgentOverride>;
  };
  const reviewProse = fs.readFileSync(path.join(reviewDir, 'review.md'), 'utf8');
  const WRITE_DENIES = {
    'fs.write_file': 'deny',
    'fs.edit_file': 'deny',
    'fs.create_directory': 'deny',
    'fs.move_file': 'deny',
  };

  function renderReview(ir: AgentIr = manifest.agent, override: AgentOverride | undefined = manifest.render['agent-mcp']) {
    const rendered = agentMcpHost.render!.render(ir, reviewProse, override);
    if (rendered.kind !== 'config-value') throw new Error(`expected config-value, got ${rendered.kind}`);
    if (rendered.report === undefined) throw new Error('agent-mcp render must return a report');
    return { payload: rendered.value as AgentCatalogPayload, report: rendered.report };
  }

  it('cac771f8 AC1 the shipped review manifest renders a read-only, no-shell, no-dispatch, no-hitl, no-web payload', () => {
    const { payload, report } = renderReview();
    expect(payload.nativeTooling.fs).toEqual({ permissions: WRITE_DENIES, readOnly: true });
    expect(payload.nativeTooling.shell).toBe(false);
    expect(payload.nativeTooling.dispatch).toBe(false);
    expect(payload.nativeTooling.hitl).toBe(false);
    expect(payload.nativeWebTools).toBe(false);
    expect(payload.mcpServers).toEqual({});
    expect(report).toEqual({ lost: [], warnings: [], unbound: false, shellDisabledByLoss: false });
  });

  it('cac771f8 AC1 negative control: loosening edit (tool listed + permission allow) makes the fs deny rules disappear', () => {
    const ir: AgentIr = {
      ...manifest.agent,
      tools: [...(manifest.agent.tools ?? []), 'edit'],
      permission: { ...manifest.agent.permission, edit: 'allow' },
    };
    const { payload } = renderReview(ir);
    // edit owns the same fs tools as write; the effective action is the most permissive owner => no deny rules, not readOnly.
    expect(payload.nativeTooling.fs).toBe(true);
    expect(payload.nativeTooling.fs).not.toEqual({ permissions: WRITE_DENIES, readOnly: true });
  });

  it('cac771f8 AC1 negative control: bash / task / question / websearch granted flips shell, dispatch, hitl and nativeWebTools', () => {
    const ir: AgentIr = {
      ...manifest.agent,
      tools: [...(manifest.agent.tools ?? []), 'bash', 'task', 'question', 'websearch', 'webfetch'],
      permission: { ...manifest.agent.permission, bash: 'allow', task: 'allow', question: 'allow', websearch: 'allow', webfetch: 'allow' },
    };
    const { payload } = renderReview(ir);
    expect(payload.nativeTooling.shell).toBe(true);
    expect(payload.nativeTooling.dispatch).toBe(true);
    expect(payload.nativeTooling.hitl).toBe(true);
    expect(payload.nativeWebTools).toBeUndefined();
  });

  it('cac771f8 AC1 an explicit render.agent-mcp.nativeTooling.shell:true wins over the derived deny (why check-readonly guards it)', () => {
    const { payload } = renderReview(manifest.agent, { ...manifest.render['agent-mcp'], nativeTooling: { shell: true } } as AgentOverride);
    expect(payload.nativeTooling.shell).toBe(true);
  });

  // AC3 (disposition: documented N/A, not report.lost). agent-mcp exposes exactly fs/shell/dispatch/hitl native members,
  // mounted mcpServers and nativeWebTools. `skill` and `todowrite` name no agent-mcp capability, so a deny on them is
  // satisfied vacuously and nothing can be lost; `question` is mapped to nativeTooling.hitl.
  it('cac771f8 AC3 skill/todowrite denies change nothing in the payload and lose nothing (nothing in agent-mcp to deny)', () => {
    const base = renderReview();
    const permission = { ...manifest.agent.permission } as Record<string, unknown>;
    delete permission['skill'];
    delete permission['todowrite'];
    const stripped = renderReview({ ...manifest.agent, permission } as AgentIr);
    expect(stripped.payload).toEqual(base.payload);
    expect(stripped.report).toEqual(base.report);
    expect(base.report.lost).toEqual([]);
  });

  it('cac771f8 AC3 question deny IS mapped (hitl:false); allowing it flips hitl', () => {
    const { payload } = renderReview();
    expect(payload.nativeTooling.hitl).toBe(false);
    const allowed = renderReview({
      ...manifest.agent,
      tools: [...(manifest.agent.tools ?? []), 'question'],
      permission: { ...manifest.agent.permission, question: 'allow' },
    });
    expect(allowed.payload.nativeTooling.hitl).toBe(true);
  });

  describe('e00c47bb webfetch/websearch single-tool deny', () => {
    const web = (permission: Record<string, string>, override: AgentOverride | undefined = manifest.render['agent-mcp']) =>
      renderReview(
        { ...manifest.agent, tools: [...(manifest.agent.tools ?? []), 'webfetch', 'websearch'], permission: { ...manifest.agent.permission, ...permission } } as AgentIr,
        override,
      );

    it('e00c47bb AC1 webfetch denied + websearch allowed: web disabled fail-closed AND the deny is reported', () => {
      const { payload, report } = web({ webfetch: 'deny', websearch: 'allow' });
      expect(payload.nativeWebTools).toBe(false);
      expect(report.lost).toHaveLength(1);
      expect(report.lost[0]).toMatchObject({ source: 'webfetch', action: 'deny', disposition: 'dropped' });
    });

    it('e00c47bb AC1 reverse (websearch denied + webfetch allowed) is reported too', () => {
      const { payload, report } = web({ webfetch: 'allow', websearch: 'deny' });
      expect(payload.nativeWebTools).toBe(false);
      expect(report.lost).toMatchObject([{ source: 'websearch', action: 'deny', disposition: 'dropped' }]);
    });

    it('e00c47bb AC1 acceptLoss keeps web on but still reports the unenforced deny as accepted', () => {
      const { payload, report } = web({ webfetch: 'deny', websearch: 'allow' }, { ...manifest.render['agent-mcp'], acceptLoss: true } as AgentOverride);
      expect(payload.nativeWebTools).toBeUndefined();
      expect(report.lost).toMatchObject([{ source: 'webfetch', disposition: 'accepted' }]);
    });

    it('e00c47bb AC1 an explicit nativeWebTools override wins and is recorded as covered-by-override', () => {
      const { payload, report } = web({ webfetch: 'deny', websearch: 'allow' }, { ...manifest.render['agent-mcp'], nativeWebTools: true } as AgentOverride);
      expect(payload.nativeWebTools).toBe(true);
      expect(report.lost).toMatchObject([{ source: 'webfetch', disposition: 'covered-by-override' }]);
    });

    it('e00c47bb AC2 control: both denied => nativeWebTools:false and report.lost empty', () => {
      const { payload, report } = web({ webfetch: 'deny', websearch: 'deny' });
      expect(payload.nativeWebTools).toBe(false);
      expect(report.lost).toEqual([]);
    });

    it('e00c47bb control: both allowed => provider default, nothing lost', () => {
      const { payload, report } = web({ webfetch: 'allow', websearch: 'allow' });
      expect(payload.nativeWebTools).toBeUndefined();
      expect(report.lost).toEqual([]);
    });

    // `tools` unspecified (irToolNames() === null): every web tool counts as available unless denied.
    const noTools = (permission: Record<string, string>, override: AgentOverride | undefined = manifest.render['agent-mcp']) => {
      const { tools: _tools, ...rest } = manifest.agent;
      void _tools;
      return renderReview({ ...rest, permission } as AgentIr, override);
    };

    it('e00c47bb AC2 tools unspecified + BOTH denied => nativeWebTools:false, nothing lost (never the provider default)', () => {
      const { payload, report } = noTools({ webfetch: 'deny', websearch: 'deny' });
      expect(payload.nativeWebTools).toBe(false);
      expect(report.lost).toEqual([]);
    });

    it('e00c47bb AC1 tools unspecified + a single deny reports the loss and fails closed (sibling counts as available)', () => {
      const f = noTools({ webfetch: 'deny' });
      expect(f.payload.nativeWebTools).toBe(false);
      expect(f.report.lost).toMatchObject([{ source: 'webfetch', action: 'deny', disposition: 'dropped' }]);
      const s = noTools({ websearch: 'deny' });
      expect(s.payload.nativeWebTools).toBe(false);
      expect(s.report.lost).toMatchObject([{ source: 'websearch', action: 'deny', disposition: 'dropped' }]);
    });

    it('e00c47bb AC2 tools unspecified + nothing denied => provider default, nothing lost', () => {
      const { payload, report } = noTools({ webfetch: 'allow', websearch: 'allow' });
      expect(payload.nativeWebTools).toBeUndefined();
      expect(report.lost).toEqual([]);
    });

    // A deny whose sibling is UNLISTED is the all-off branch: the sibling was never available, so nothing is lost.
    const unlistedSibling = (denied: 'webfetch' | 'websearch') => {
      const permission: Record<string, string> = { ...(manifest.agent.permission as Record<string, string>) };
      delete permission['webfetch'];
      delete permission['websearch'];
      permission[denied] = 'deny';
      return renderReview({ ...manifest.agent, tools: [...(manifest.agent.tools ?? []), denied], permission } as AgentIr);
    };

    it('e00c47bb AC2 single deny with the sibling UNLISTED => nativeWebTools:false and report.lost empty (documented all-off branch)', () => {
      for (const denied of ['webfetch', 'websearch'] as const) {
        const { payload, report } = unlistedSibling(denied);
        expect(payload.nativeWebTools).toBe(false);
        expect(report.lost).toEqual([]);
      }
    });

    it('e00c47bb AC1 override nativeWebTools:false + partial deny: web off, deny ENFORCED, recorded as covered-by-override', () => {
      const { payload, report } = web({ webfetch: 'deny', websearch: 'allow' }, { ...manifest.render['agent-mcp'], nativeWebTools: false } as AgentOverride);
      expect(payload.nativeWebTools).toBe(false);
      expect(report.lost).toHaveLength(1);
      expect(report.lost[0]).toMatchObject({ source: 'webfetch', disposition: 'covered-by-override' });
      expect(report.lost[0]?.reason).toMatch(/webfetch deny is enforced/);
      expect(report.lost[0]?.reason).not.toMatch(/not enforced/);
    });

    it('e00c47bb AC1 reason text matches the case: override:true and acceptLoss say "not enforced"; the default says fail-closed', () => {
      const base = manifest.render['agent-mcp'];
      const on = web({ webfetch: 'deny', websearch: 'allow' }, { ...base, nativeWebTools: true } as AgentOverride).report.lost[0]?.reason;
      expect(on).toMatch(/nativeWebTools:true enables web, so the webfetch deny is not enforced/);
      const accepted = web({ webfetch: 'deny', websearch: 'allow' }, { ...base, acceptLoss: true } as AgentOverride).report.lost[0]?.reason;
      expect(accepted).toMatch(/acceptLoss keeps web at the provider default, so the webfetch deny is not enforced/);
      const dflt = web({ webfetch: 'deny', websearch: 'allow' }).report.lost[0]?.reason;
      expect(dflt).toMatch(/fail-closed/);
      expect(dflt).not.toMatch(/not enforced/);
    });

    it('e00c47bb AC1 acceptLoss + override:false => the override wins (web off) and the entry is covered-by-override', () => {
      const { payload, report } = web({ webfetch: 'deny', websearch: 'allow' }, { ...manifest.render['agent-mcp'], acceptLoss: true, nativeWebTools: false } as AgentOverride);
      expect(payload.nativeWebTools).toBe(false);
      expect(report.lost).toMatchObject([{ source: 'webfetch', disposition: 'covered-by-override' }]);
    });

    it('e00c47bb AC1 acceptLoss with both tools denied is a no-op: web off, nothing lost', () => {
      const { payload, report } = web({ webfetch: 'deny', websearch: 'deny' }, { ...manifest.render['agent-mcp'], acceptLoss: true } as AgentOverride);
      expect(payload.nativeWebTools).toBe(false);
      expect(report.lost).toEqual([]);
    });
  });

  it('e00c47bb AC3 the fidelity spec carries the migration note and separates the manifest acceptLoss key from the CLI flag', () => {
    const doc = fs.readFileSync(path.resolve(__dirname, '../../../docs/spec/agent-mcp-renderer-fidelity.md'), 'utf8');
    expect(doc).toMatch(/Migration: single-tool web deny/);
    expect(doc).toMatch(/render\.agent-mcp\.acceptLoss/);
    expect(doc).toMatch(/reconcile --accept-loss/);
    expect(doc).toMatch(/DIFFERENT from/);
  });

  it('e00c47bb AC3 the fidelity spec documents the single-tool web deny disposition', () => {
    const doc = fs.readFileSync(path.resolve(__dirname, '../../../docs/spec/agent-mcp-renderer-fidelity.md'), 'utf8');
    const row = doc.split('\n').find((l) => /^\| IR `tools` webfetch\/websearch/.test(l));
    expect(row).toBeDefined();
    expect(row).toMatch(/report\.lost/);
    expect(row).toMatch(/fails closed/);
    const without = doc.split('\n').filter((l) => l !== row).join('\n');
    expect(/^\| IR `tools` webfetch\/websearch/m.test(without)).toBe(false);
  });

  it('cac771f8 AC3 the fidelity spec documents the skill/todowrite disposition as N/A', () => {
    const doc = fs.readFileSync(path.resolve(__dirname, '../../../docs/spec/agent-mcp-renderer-fidelity.md'), 'utf8');
    const row = doc.split('\n').find((l) => /^\| IR `permission` `skill` \/ `todowrite`/.test(l));
    expect(row).toBeDefined();
    expect(row).toMatch(/N\/A/);
    expect(row).toMatch(/report\.lost/);
    // negative control: the matcher rejects a doc with that row removed.
    const without = doc.split('\n').filter((l) => l !== row).join('\n');
    expect(/^\| IR `permission` `skill` \/ `todowrite`/m.test(without)).toBe(false);
  });
});

describe('agent-mcp — catalog env resolution', () => {
  it('SOX_AGENT_MCP_DATABASE_PATH wins over everything', () => {
    process.env['SOX_AGENT_MCP_DATABASE_PATH'] = '/tmp/explicit/agents.db';
    process.env['ADHD_AGENT_DATABASE_PATH'] = '/tmp/ambient/agents.db';
    const env = resolveAgentMcpEnv();
    expect(env.databasePath).toBe('/tmp/explicit/agents.db');
    expect(env.source).toBe('SOX_AGENT_MCP_DATABASE_PATH');
  });

  it('discovers the catalog from the agent-mcp registration in opencode.json', () => {
    const cfgDir = path.join(sandbox, '.config', 'opencode');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfgDir, 'opencode.json'),
      JSON.stringify({
        mcp: {
          agent: {
            type: 'local',
            command: ['npx', '-y', '@adhd/agent-mcp@latest'],
            environment: { ADHD_AGENT_DATABASE_PATH: '/srv/catalog/agents.db' },
          },
        },
      }),
      'utf8',
    );
    const env = resolveAgentMcpEnv();
    expect(env.databasePath).toBe('/srv/catalog/agents.db');
    expect(env.source).toBe('opencode.json');
  });

  it('falls back to the server zero-config when nothing is discovered', () => {
    const env = resolveAgentMcpEnv();
    expect(env.source).toBe('server-zero-config');
    expect(defaultCatalogDbPath()).toBe(path.join(sandbox, '.adhd', 'agent-mcp', 'production', 'data', 'agents.db'));
  });
});
