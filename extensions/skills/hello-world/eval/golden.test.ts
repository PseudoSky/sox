/**
 * hello-world/eval/golden.test.ts — Layer 2 deterministic golden-assertion fixture
 *
 * Grounding: eval-harness-for-llm-extensions.md (P5.5 finding), Layer 2:
 *   "Deterministic behavioral assertions — exact/near-exact match on structured
 *    outputs, binary pass/fail on tool-call correctness. Runs on every PR
 *    (affected extensions only). No LLM call."
 * Finding path:
 *   ~/.claude/plugins/workflow/memory/research/extension-ecosystem-design/eval-harness-for-llm-extensions.md
 *
 * This file is colocated per the finding's §6 colocation principle:
 *   "eval fixtures live inside the extension's own package directory"
 *
 * Goldens defined inline (mirrors goldens.json). No LLM calls are made.
 * All assertions are deterministic (exact-match, shape, idempotency).
 */

import { describe, it, expect } from 'vitest';
import { run } from '../src/index.js';
import type { SkillInput } from '../src/index.js';

// ── Layer 2 golden cases (exact-match; mirrors goldens.json) ─────────────────

interface Golden {
  id: string;
  description: string;
  input: SkillInput;
  expected?: { result: string };
  expectedKeyCount?: number;
  expectedKeys?: string[];
}

const GOLDENS: Golden[] = [
  {
    id: 'happy-path-basic',
    description: 'Basic input produces expected output prefix',
    input: { input: 'hello' },
    expected: { result: 'Processed: hello' },
  },
  {
    id: 'happy-path-empty',
    description: 'Empty string input produces expected output',
    input: { input: '' },
    expected: { result: 'Processed: ' },
  },
  {
    id: 'happy-path-unicode',
    description: 'Unicode input is preserved verbatim',
    input: { input: 'こんにちは' },
    expected: { result: 'Processed: こんにちは' },
  },
  {
    id: 'output-shape',
    description: 'Output must have exactly { result: string } with no extra keys',
    input: { input: 'shape-test' },
    expectedKeys: ['result'],
    expectedKeyCount: 1,
  },
  {
    id: 'result-type',
    description: 'result field must always be a string',
    input: { input: 'type-test' },
  },
];

// ── Layer 2: deterministic exact-match assertions ────────────────────────────
//
// Rule: only Layer 2 goldens (no LLM judge) may run at PR gate.
// Layer 3 (LLM-judge) goldens run nightly only — not present in this fixture.

describe('hello-world skill — Layer 2 golden assertions (deterministic, no LLM)', () => {
  for (const golden of GOLDENS) {
    it(`[${golden.id}] ${golden.description}`, async () => {
      const output = await run(golden.input);

      // Invariant: result must always be a string
      expect(typeof output.result).toBe('string');

      // Exact-match on expected output (if provided)
      if (golden.expected !== undefined) {
        expect(output).toEqual(golden.expected);
      }

      // Output shape assertion (if provided)
      if (golden.expectedKeyCount !== undefined) {
        expect(Object.keys(output)).toHaveLength(golden.expectedKeyCount);
      }
      if (golden.expectedKeys !== undefined) {
        for (const key of golden.expectedKeys) {
          expect(output).toHaveProperty(key);
        }
      }
    });
  }

  it('run is idempotent: same input → same output across two calls', async () => {
    const input: SkillInput = { input: 'idempotency-test' };
    const [a, b] = await Promise.all([run(input), run(input)]);
    expect(a).toEqual(b);
  });
});
