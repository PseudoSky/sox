/**
 * skill-renderers.spec.ts — host-agnostic skill header renderer tests.
 *
 * The renderer makes extension.json the single source of truth for a skill's
 * header (bug aace3faa): name/description are derived from the manifest and
 * emitted through yamlStringify, so the 1ceffdbf colon-in-scalar class (a
 * `description` containing "backlog: product prioritizes") can never produce
 * invalid YAML — the same guarantee agent-renderers.ts gives agents.
 */

import { describe, expect, it } from 'vitest';
import {
  renderSkillFile,
  renderSkillHeader,
  skillManifestToInput,
  SKILL_ALLOWED_KEYS,
} from './skill-renderers.js';
import type { SkillHeaderInput, SkillManifestLike } from './skill-renderers.js';

/**
 * Minimal YAML frontmatter parser for the CONSTRAINED shape the renderer emits
 * (scalars, single-quoted strings with '' escapes, string arrays, nested maps).
 * It is not a general YAML implementation — it exists to prove the emitted
 * description actually parses back to the input value, since the workspace has
 * no js-yaml/yaml dependency (see serialize.ts's own header note).
 */
function parseFrontmatterDescription(content: string): string | null {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(content);
  if (!m) return null;
  const block = m[1];
  if (block === undefined) return null;
  const line = block.split('\n').find((l) => l.startsWith('description:'));
  if (!line) return null;
  const raw = line.slice('description:'.length).trim();
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    // Single-quoted scalar: '' is an escaped single quote.
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

describe('renderSkillFile — colon-in-scalar immunity (the 1ceffdbf class)', () => {
  const preFixDescription =
    'The dispatcher plays back plans: product prioritizes, architect returns the structured items';

  it('renders a description containing ": " as a quoted scalar that parses back exactly', () => {
    const manifest: SkillManifestLike = { id: 'dispatch-plan', description: preFixDescription };
    const r = renderSkillFile(manifest, '# dispatch-plan\n');
    expect(r).not.toBeNull();
    const content = (r as { content: string }).content;
    // The ": " must be single-quoted so a YAML parser does not read a mapping.
    expect(content).toContain(`description: '${preFixDescription}'`);
    // Round-trip: the emitted description parses back to the exact input.
    expect(parseFrontmatterDescription(content)).toBe(preFixDescription);
  });

  it('round-trips the authentic pre-fix text "backlog: product prioritizes"', () => {
    const manifest: SkillManifestLike = {
      id: 'dispatch-plan',
      description: 'backlog: product prioritizes',
    };
    const r = renderSkillFile(manifest, '# dispatch-plan\n');
    const content = (r as { content: string }).content;
    expect(content).toContain("description: 'backlog: product prioritizes'");
    expect(parseFrontmatterDescription(content)).toBe('backlog: product prioritizes');
  });
});

describe('renderSkillFile — adversarial descriptions stay parseable', () => {
  const cases: Array<[string, string]> = [
    ['- leading dash', "'- leading dash'"],
    ['# leading hash', "'# leading hash'"],
    [' # leading space-hash', "' # leading space-hash'"],
    ['quotes " and apostrophes \' mixed', 'quotes " and apostrophes \' mixed'],
    ['yes', "'yes'"],
    ['true', "'true'"],
    ['null', "'null'"],
    ['123', "'123'"],
    ['3.14', "'3.14'"],
  ];
  for (const [desc, expectedLine] of cases) {
    it(`quotes ${JSON.stringify(desc)}`, () => {
      const r = renderSkillFile({ id: 's', description: desc }, '# s\n');
      const content = (r as { content: string }).content;
      expect(content).toContain(`description: ${expectedLine}`);
      // And the quoted scalar unquotes back to the exact input.
      expect(parseFrontmatterDescription(content)).toBe(desc);
    });
  }

  it('folds an embedded newline to a single space so the header round-trips', () => {
    const r = renderSkillFile({ id: 's', description: 'line1\nline2' }, '# s\n');
    const content = (r as { content: string }).content;
    // A description is a single-line header field: the renderer normalises the
    // line break to a space rather than emitting a multi-line scalar, so the
    // surfaced header matches the (single-line) manifest description exactly.
    expect(content).toContain('description: line1 line2');
    expect(parseFrontmatterDescription(content)).toBe('line1 line2');
  });

  it('normalises CRLF and surrounding whitespace to a single space', () => {
    const input = skillManifestToInput({ id: 's', description: 'a\r\n  b\n\tc' });
    expect(input?.description).toBe('a b c');
  });

  it('a plain description needs no quoting and still round-trips', () => {
    const r = renderSkillFile({ id: 's', description: 'plain description' }, '# s\n');
    const content = (r as { content: string }).content;
    expect(content).toContain('description: plain description');
    expect(parseFrontmatterDescription(content)).toBe('plain description');
  });
});

describe('renderSkillHeader — name == id and only allowed keys', () => {
  it('emits name then description', () => {
    expect(renderSkillHeader({ id: 'demo', description: 'do the thing' })).toEqual({
      name: 'demo',
      description: 'do the thing',
    });
  });

  it('emits license / allowed-tools / metadata only when present', () => {
    const input: SkillHeaderInput = {
      id: 'demo',
      description: 'd',
      license: 'MIT',
      allowedTools: ['Read', 'Bash'],
      metadata: { source: 'https://example.com', 'source-version': 'v1' },
    };
    const header = renderSkillHeader(input);
    expect(header).toEqual({
      name: 'demo',
      description: 'd',
      license: 'MIT',
      'allowed-tools': ['Read', 'Bash'],
      metadata: { source: 'https://example.com', 'source-version': 'v1' },
    });
    expect(Object.keys(header).sort()).toEqual([...SKILL_ALLOWED_KEYS].sort());
  });

  it('omits empty allowed-tools and empty metadata', () => {
    expect(renderSkillHeader({ id: 'x', description: 'y', allowedTools: [], metadata: {} })).toEqual({
      name: 'x',
      description: 'y',
    });
  });
});

describe('skillManifestToInput — folding source/sourceVersion into metadata', () => {
  it('folds source/sourceVersion into metadata as { source, source-version }', () => {
    const input = skillManifestToInput({
      id: 'tui-design',
      description: 'design TUIs',
      source: 'https://github.com/gfargo/skills',
      sourceVersion: 'v1.4.0',
    });
    expect(input).toEqual({
      id: 'tui-design',
      description: 'design TUIs',
      metadata: { source: 'https://github.com/gfargo/skills', 'source-version': 'v1.4.0' },
    });
  });

  it('merges a manifest metadata object with the provenance fold', () => {
    const input = skillManifestToInput({
      id: 's',
      description: 'd',
      metadata: { author: 'sox' },
      source: 'https://example.com',
    });
    expect(input?.metadata).toEqual({ author: 'sox', source: 'https://example.com' });
  });

  it('returns null when id or description is missing/empty/non-string', () => {
    expect(skillManifestToInput({ description: 'd' })).toBeNull();
    expect(skillManifestToInput({ id: 'x' })).toBeNull();
    expect(skillManifestToInput({ id: '', description: 'd' })).toBeNull();
    expect(skillManifestToInput({ id: 'x', description: '   ' })).toBeNull();
    expect(skillManifestToInput({ id: 42, description: 'd' })).toBeNull();
  });
});

describe('renderSkillFile — prose still carrying frontmatter yields one header', () => {
  it('strips a source frontmatter and emits only the generated header', () => {
    const prose = '---\nname: stale\n---\n# body\n';
    const r = renderSkillFile({ id: 'fresh', description: 'generated' }, prose);
    const content = (r as { content: string }).content;
    expect(content.startsWith('---\nname: fresh\ndescription: generated\n---\n')).toBe(true);
    // Exactly one header fence pair: the stale name never survives.
    expect(content.match(/^---$/gm)).toHaveLength(2);
    expect(content).not.toContain('name: stale');
  });

  it('returns null for a manifest with no usable id/description', () => {
    expect(renderSkillFile({ id: 'x' }, '# body\n')).toBeNull();
    expect(renderSkillFile({ description: 'd' }, '# body\n')).toBeNull();
  });
});

describe('determinism', () => {
  it('renders identical bytes across two calls', () => {
    const manifest: SkillManifestLike = { id: 's', description: 'backlog: product prioritizes' };
    const a = renderSkillFile(manifest, '# body\n');
    const b = renderSkillFile(manifest, '# body\n');
    expect((a as { content: string }).content).toBe((b as { content: string }).content);
  });
});
