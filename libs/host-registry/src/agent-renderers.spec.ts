/**
 * agent-renderers.spec.ts — per-host agent renderer tests.
 *
 * Verifies the "author once, install everywhere" contract
 * (docs/spec/cross-platform-install-rendering.md): one host-agnostic IR + prose
 * renders to valid claude/opencode frontmatter and a codex TOML config value,
 * with correct quoting of adversarial strings.
 */
import { describe, expect, it } from 'vitest';
import { agentRenderers, stripFrontmatter, yamlScalar, yamlStringify } from './agent-renderers.js';
import type { AgentIr } from './internal.js';

const researcherIr: AgentIr = {
  name: 'researcher',
  description: 'Discovery researcher for third-party tools, patterns, and use cases before you build.',
  model: 'sonnet',
  temperature: 0.4,
  mode: 'all',
  tools: [
    'read',
    'bash',
    'write',
    'edit',
    'webfetch',
    'websearch',
    { logical: 'search', server: 'search' },
    { logical: 'memory', server: 'memory-server' },
  ],
  permission: {
    read: 'allow',
    edit: 'allow',
    websearch: 'deny',
    bash: { '*': 'allow', 'git stash*': 'deny', 'rm -rf *': 'deny' },
  },
};

const prose = '# researcher\n\nYou are a research agent.\n';

describe('claude renderer', () => {
  it('emits valid frontmatter with claude tool naming (builtins capitalized, mcp__ wildcards)', () => {
    const r = agentRenderers.claude.render(researcherIr, prose);
    expect(r.kind).toBe('file-body');
    const content = (r as { content: string }).content;
    expect(content.startsWith('---\n')).toBe(true);
    expect(content).toContain('name: researcher');
    expect(content).toContain('tools: Read, Bash, Write, Edit, WebFetch, WebSearch, mcp__search__*, mcp__memory-server__*');
    expect(content).toContain('model: sonnet');
    // no mode/temperature/permission in claude frontmatter
    expect(content).not.toContain('mode:');
    expect(content).not.toContain('temperature:');
    expect(content).not.toContain('permission:');
    expect(content).toContain('# researcher');
    // generated tool-names block
    expect(content).toContain('## Resolved tool names (Claude Code)');
    expect(content).toContain('`search` → `mcp__search__*`');
  });

  it('honours override tools + toolMap server key', () => {
    const r = agentRenderers.claude.render(researcherIr, prose, {
      tools: ['Read', 'Bash', 'mcp__search__*'],
      toolMap: { search: 'agent_browser_search_mcp_source' },
      version: 'v1.0.1',
    });
    const content = (r as { content: string }).content;
    expect(content).toContain('tools: Read, Bash, mcp__search__*');
    expect(content).toContain('version: v1.0.1');
  });
});

describe('opencode renderer', () => {
  it('emits valid frontmatter with mode/temperature/permission (no tools field)', () => {
    const r = agentRenderers.opencode.render(researcherIr, prose);
    expect(r.kind).toBe('file-body');
    const content = (r as { content: string }).content;
    expect(content.startsWith('---\n')).toBe(true);
    expect(content).toContain('name: researcher');
    expect(content).toContain('mode: all');
    expect(content).toContain('temperature: 0.4');
    expect(content).toContain('permission:');
    expect(content).toContain('  read: allow');
    expect(content).toContain('  websearch: deny');
    expect(content).toContain('    \'*\': allow');
    expect(content).toContain("    'git stash*': deny");
    // opencode frontmatter has no tools/version; the IR model is a logical tier
    // opencode cannot resolve, so it is NOT emitted without a host override
    expect(content).not.toContain('tools:');
    expect(content).not.toContain('model:');
    expect(content).toContain('# researcher');
  });

  it('pins model from the opencode render override (host model id, never the IR tier)', () => {
    const r = agentRenderers.opencode.render(researcherIr, prose, { model: 'deepseek/deepseek-v4-flash' });
    const content = (r as { content: string }).content;
    expect(content).toContain('model: deepseek/deepseek-v4-flash');
    expect(content).not.toContain('model: sonnet');
    // model sits inside the frontmatter block, before the prose
    const fm = content.slice(0, content.indexOf('\n---', 4));
    expect(fm).toContain('model: deepseek/deepseek-v4-flash');
  });

  it('generates opencode resolved tool-names block', () => {
    const r = agentRenderers.opencode.render(researcherIr, prose);
    const content = (r as { content: string }).content;
    expect(content).toContain('## Resolved tool names (OpenCode)');
    expect(content).toContain('`memory` → `tools["memory-server"].*`');
  });
});

describe('codex renderer', () => {
  it('returns a config-value with description/model/prompt (prose in prompt field)', () => {
    const r = agentRenderers.codex.render(researcherIr, prose);
    expect(r.kind).toBe('config-value');
    const v = (r as { value: Record<string, unknown> }).value;
    expect(v.description).toBe(researcherIr.description);
    expect(v.model).toBe('sonnet');
    expect(v.prompt).toBe(prose);
  });
});

describe('determinism', () => {
  it('renders identical bytes across two calls (claude + opencode)', () => {
    const a = agentRenderers.claude.render(researcherIr, prose);
    const b = agentRenderers.claude.render(researcherIr, prose);
    expect((a as { content: string }).content).toBe((b as { content: string }).content);
    const c = agentRenderers.opencode.render(researcherIr, prose);
    const d = agentRenderers.opencode.render(researcherIr, prose);
    expect((c as { content: string }).content).toBe((d as { content: string }).content);
  });
});

describe('yamlScalar (serialization mandate — adversarial strings)', () => {
  it('quotes strings with ": " / leading dash / ambiguity', () => {
    expect(yamlScalar('Discovery: tools')).toBe("'Discovery: tools'");
    expect(yamlScalar('- leading dash')).toBe("'- leading dash'");
    expect(yamlScalar('true')).toBe("'true'");
    expect(yamlScalar('123')).toBe("'123'");
    expect(yamlScalar('plain word')).toBe('plain word');
  });

  it('doubles embedded single quotes when a string needs quoting', () => {
    // contains ": " so it must be quoted; the apostrophe doubles inside the quote
    expect(yamlScalar("it's: here")).toBe("'it''s: here'");
    // a bare mid-string apostrophe is a valid plain scalar — no quote needed
    expect(yamlScalar("it's")).toBe("it's");
  });

  it('a description with a newline is quoted (single-line-safe)', () => {
    const out = yamlStringify({ description: 'line1\nline2' });
    expect(out).toBe("description: 'line1\nline2'");
  });
});

describe('stripFrontmatter', () => {
  it('strips a leading YAML fence', () => {
    expect(stripFrontmatter('---\nname: x\n---\n# body\n')).toBe('# body\n');
  });
  it('leaves prose-only markdown untouched', () => {
    expect(stripFrontmatter('# body\n')).toBe('# body\n');
  });
});
