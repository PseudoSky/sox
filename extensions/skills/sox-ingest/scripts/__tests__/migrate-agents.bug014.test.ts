// @ts-nocheck
/**
 * BUG-014 regression coverage — extensions/skills/sox-ingest/scripts/migrate-agents.mjs
 *
 * Two defects in the agent-migration generator, both discovered by re-reading
 * the tool after commit d2d22364 hand-patched its 14 generated
 * extensions/agents/*\/extension.json outputs without ever touching the
 * generator itself:
 *
 *   Defect 1 — manifest() never set the `invocation` field that P3 makes an
 *              error for type:'agent'.
 *   Defect 2 — parseFrontmatter()'s scalar() regex matched only the `key:`
 *              line, so a YAML block scalar (`description: >-` + indented
 *              body) captured the two-character indicator token `>-` instead
 *              of the content beneath it.
 *
 * These tests exercise the real exported functions from the (fixed) script.
 * To see them go RED against the pre-fix generator, temporarily revert the
 * script to its state at commit 9248e799 (or before this fix) and re-run —
 * both `invocation-field` and every folded-scalar case fail; the plain-scalar
 * and `agent-manager`-style placeholder cases were never broken and stay
 * green either way (confirming the fix is additive, not a rewrite of correct
 * behavior).
 */
import { describe, expect, it } from 'vitest';
import { manifest, parseFrontmatter, readBlockScalar } from '../migrate-agents.mjs';

describe('BUG-014 defect 1 — manifest() invocation field', () => {
  it('always sets invocation for type:agent, matching the d2d22364 hand-patch shape', () => {
    const m = manifest('debug', 'some description', '/some/path.md');
    expect(m.type).toBe('agent');
    expect(m.invocation).toEqual({
      protocol: 'function-export',
      handler: 'run',
      description: 'Declarative agent — host reads the .md definition file directly.',
    });
  });
});

describe('BUG-014 defect 2 — folded/literal YAML block-scalar extraction', () => {
  it('extracts the content beneath `description: >-` (folded, strip) instead of the ">-" indicator', () => {
    const content = `---
description: >-
  FACTS subagent for the documentation trio. Given a scope (a directory with a
  manifest), it classifies the scope type, recalls the best-in-class doc
  frameworks from memory.
mode: subagent
model: deepseek/deepseek-v4-flash
---
body
`;
    const { meta } = parseFrontmatter(content);
    // The pre-fix regex captured literally ">-" here — the exact CAUSE 2 shape
    // from d2d22364's commit message.
    expect(meta.description).not.toBe('>-');
    expect(meta.description).toBe(
      'FACTS subagent for the documentation trio. Given a scope (a directory with a ' +
        'manifest), it classifies the scope type, recalls the best-in-class doc ' +
        'frameworks from memory.',
    );
  });

  it('folds a blank line inside the block into a single newline (YAML folding rule)', () => {
    const content = `---
description: >-
  First paragraph line one
  continues here.

  Second paragraph.
mode: subagent
---
body
`;
    const { meta } = parseFrontmatter(content);
    expect(meta.description).toBe(
      'First paragraph line one continues here.\nSecond paragraph.',
    );
  });

  it('preserves newlines for a literal block scalar (`|`)', () => {
    const content = `---
description: |
  line one
  line two
mode: subagent
---
body
`;
    const { meta } = parseFrontmatter(content);
    expect(meta.description).toBe('line one\nline two\n');
  });

  it('handles `|-` (literal, strip chomping)', () => {
    const content = `---
description: |-
  line one
  line two
mode: subagent
---
body
`;
    const { meta } = parseFrontmatter(content);
    expect(meta.description).toBe('line one\nline two');
  });

  it('leaves a plain scalar description untouched (no regression on the common case)', () => {
    const content = `---
name: agent-manager
description: Crafts, tests, and manages agents, skills, and plugins.
tools:
  read: true
---
body
`;
    const { meta } = parseFrontmatter(content);
    expect(meta.description).toBe('Crafts, tests, and manages agents, skills, and plugins.');
  });

  it('extracts a plain scalar description containing embedded double quotes (agent-manager.md live shape)', () => {
    // Found while diffing the fixed generator's output against the d2d22364
    // hand-patch: the OLD plain-scalar capture group `[^"'\n]+` excluded every
    // quote character from the value, so this line failed to match at all and
    // silently fell through to the `${id} agent` fallback — exactly why the
    // repair commit had to hand-write "agent-manager agent" as a full
    // replacement rather than a prefix rewrite.
    const content = `---
description: Crafts, tests, and manages agents. Use for "create an agent", "build a skill".
mode: primary
---
body
`;
    const { meta } = parseFrontmatter(content);
    expect(meta.description).toBe(
      'Crafts, tests, and manages agents. Use for "create an agent", "build a skill".',
    );
  });

  it('extracts a fully-quoted plain scalar description containing an internal apostrophe (debug.md live shape)', () => {
    const content = `---
description: "Senior debugging specialist. Differentiate from \`review\`: code that isn't (yet) known to be broken."
mode: all
---
body
`;
    const { meta } = parseFrontmatter(content);
    expect(meta.description).toBe(
      "Senior debugging specialist. Differentiate from `review`: code that isn't (yet) known to be broken.",
    );
  });

  it('readBlockScalar is exported and directly reproduces the doc-cartographer live source shape', () => {
    const raw = `description: >-
  Use this when you need the FACTS subagent.
  Second line joins with a space.
mode: subagent
`;
    const afterIdx = raw.indexOf('\n') + 1;
    const value = readBlockScalar(raw, afterIdx, '>', '-');
    expect(value).toBe('Use this when you need the FACTS subagent. Second line joins with a space.');
  });
});
