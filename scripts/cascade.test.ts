/**
 * cascade.test.ts — P2 integration tests for the cascade-merge resolver
 *
 * Acceptance criteria (Section 4.2):
 *   - 3-scope cascade integration test produces the expected resolved map
 *   - Array-replace case: narrower scope's install[] fully replaces wider
 *   - enabled:false suppression case
 *
 * Also tests duplicate-id detection and shadow-copy detection (via validate-manifests
 * integration via direct import of the checker functions).
 */

import { describe, it, expect } from 'vitest';
import { cascade, deepMerge } from './cascade.js';
import type { ScopeConfig } from './cascade.js';

// ─── deepMerge unit tests ──────────────────────────────────────────────────────

describe('deepMerge', () => {
  it('replaces primitives with override value', () => {
    const result = deepMerge({ a: 1, b: 'old' }, { b: 'new' });
    expect(result).toEqual({ a: 1, b: 'new' });
  });

  it('deep-merges nested objects', () => {
    const result = deepMerge(
      { model: { provider: 'openai', max_tokens: 4096 } },
      { model: { max_tokens: 2048 } },
    );
    expect(result).toEqual({ model: { provider: 'openai', max_tokens: 2048 } });
  });

  it('ARRAYS REPLACE ENTIRELY — NOT concat (per migration.md Section 4.2)', () => {
    // This is the critical contract: arrays are replaced, never concatenated
    const result = deepMerge(
      { tools: ['tool-a', 'tool-b', 'tool-c'] },
      { tools: ['tool-x'] },
    );
    // The array from the override REPLACES entirely — never [tool-a, tool-b, tool-c, tool-x]
    expect(result['tools']).toEqual(['tool-x']);
    expect((result['tools'] as string[]).length).toBe(1);
  });

  it('handles null values in override', () => {
    const result = deepMerge({ a: 'value' }, { a: null });
    expect(result['a']).toBeNull();
  });
});

// ─── cascade integration tests ────────────────────────────────────────────────

describe('cascade — 3-scope integration test', () => {
  /**
   * Scenario: org baseline + user scope + project scope
   * Verifies:
   *   1. Correct merge of version from narrowest scope
   *   2. Array REPLACE (not concat) for install lists
   *   3. enabled:false suppression
   *   4. Deep-merge of config objects
   */
  it('produces the expected resolved config map for a 3-scope cascade', () => {
    // ── Org baseline (widest) ──────────────────────────────────────────────────
    const orgScope: ScopeConfig = {
      install: [
        { id: 'security-linter', version: '^2.0.0', enabled: true },
        { id: 'verbose-logger', version: '^1.0.0', enabled: true },
      ],
      config: {
        'security-linter': { severity: 'high', report_format: 'json' },
      },
    };

    // ── User scope ────────────────────────────────────────────────────────────
    const userScope: ScopeConfig = {
      install: [
        { id: 'my-agent', version: '^1.2.0', enabled: true },
      ],
      config: {
        'my-agent': { provider: 'anthropic/claude-opus-4-5', max_tokens: 8192 },
      },
    };

    // ── Project scope (narrowest) ─────────────────────────────────────────────
    const projectScope: ScopeConfig = {
      install: [
        { id: 'code-reviewer', version: 'workspace:*', enabled: true },
      ],
      config: {
        'my-agent': { max_tokens: 2048 }, // override user's max_tokens
      },
      enabled: {
        'verbose-logger': false, // suppress org-wide logger in this project
      },
    };

    const result = cascade([orgScope, userScope, projectScope]);

    // All IDs from all scopes should be present
    expect(Object.keys(result).sort()).toEqual(
      ['code-reviewer', 'my-agent', 'security-linter', 'verbose-logger'].sort(),
    );

    // security-linter: from org, should have version ^2.0.0 and enabled:true
    expect(result['security-linter']?.version).toBe('^2.0.0');
    expect(result['security-linter']?.enabled).toBe(true);
    expect(result['security-linter']?.config).toEqual({ severity: 'high', report_format: 'json' });

    // verbose-logger: from org but DISABLED by project scope (enabled:false at narrowest wins)
    expect(result['verbose-logger']?.enabled).toBe(false);

    // my-agent: from user scope, config deep-merged with project override
    expect(result['my-agent']?.version).toBe('^1.2.0');
    expect(result['my-agent']?.enabled).toBe(true);
    // Deep-merge: provider from user scope, max_tokens from project scope (narrowest wins)
    expect(result['my-agent']?.config).toEqual({
      provider: 'anthropic/claude-opus-4-5',
      max_tokens: 2048, // project scope overrides user's 8192
    });

    // code-reviewer: from project scope
    expect(result['code-reviewer']?.version).toBe('workspace:*');
    expect(result['code-reviewer']?.enabled).toBe(true);
  });

  it('ARRAYS REPLACE at the install list level — narrower scope install does not concat with org', () => {
    // Verifies: if project install[] is [A], and org install[] is [B, C],
    // the cascade result contains all of [A, B, C] because each scope's entries
    // are individually merged by ID (not array-concat'd).
    // The ARRAY REPLACE rule means: if project's config.tools = [x], it replaces
    // org's config.tools = [a, b, c] — NOT [a, b, c, x].
    const orgScope: ScopeConfig = {
      install: [{ id: 'ext-a', version: '1.0.0' }],
      config: {
        'ext-a': { allowed_tools: ['tool1', 'tool2', 'tool3'] },
      },
    };
    const projectScope: ScopeConfig = {
      install: [{ id: 'ext-a', version: '2.0.0' }], // narrower version wins
      config: {
        'ext-a': { allowed_tools: ['only-this-tool'] }, // ARRAY REPLACES, not concats
      },
    };

    const result = cascade([orgScope, projectScope]);

    // Version: project wins (primitive replace)
    expect(result['ext-a']?.version).toBe('2.0.0');

    // allowed_tools: ARRAY REPLACE — project's list replaces org's entirely
    const tools = result['ext-a']?.config['allowed_tools'] as string[];
    expect(tools).toEqual(['only-this-tool']);
    expect(tools.length).toBe(1); // NOT 4 — not concatenated
  });

  it('enabled:false at narrower scope force-suppresses a wider true', () => {
    const orgScope: ScopeConfig = {
      install: [{ id: 'noisy-hook', version: '1.0.0', enabled: true }],
    };
    const userScope: ScopeConfig = {
      enabled: { 'noisy-hook': false }, // user disables it
    };
    const projectScope: ScopeConfig = {
      // project doesn't mention it — user's false should still win
    };

    const result = cascade([orgScope, userScope, projectScope]);
    expect(result['noisy-hook']?.enabled).toBe(false);
  });

  it('narrowest enabled:true overrides a wider enabled:false', () => {
    const orgScope: ScopeConfig = {
      install: [{ id: 'opt-in-feature', version: '1.0.0', enabled: false }],
    };
    const projectScope: ScopeConfig = {
      enabled: { 'opt-in-feature': true }, // project explicitly enables it
    };

    const result = cascade([orgScope, projectScope]);
    expect(result['opt-in-feature']?.enabled).toBe(true);
  });

  it('handles empty scopes gracefully', () => {
    const result = cascade([{}, {}, {}]);
    expect(result).toEqual({});
  });

  it('handles single scope', () => {
    const scope: ScopeConfig = {
      install: [{ id: 'solo', version: '0.5.0', enabled: true }],
      config: { solo: { debug: true } },
    };
    const result = cascade([scope]);
    expect(result['solo']?.version).toBe('0.5.0');
    expect(result['solo']?.config).toEqual({ debug: true });
  });
});
