/**
 * provider-capabilities.test.ts — P3 acceptance tests
 *
 * Acceptance criteria (Section 2, Gap 5):
 *   - A tool-calling extension pointed at ollama/llama3 (no tool support)
 *     returns ok:false with warnings — the install client emits a warning, not
 *     a hard error (default advisory-warn behavior)
 *   - Same with strict_capabilities:true → install client hard-blocks
 *   - Switching provider to ollama/llama3.1 (tool-calling capable) passes
 *     with no warning and no code change to the extension
 */

import { describe, it, expect } from 'vitest';
import { checkProviderCapabilities } from './provider-capabilities.js';

describe('provider-capabilities — static capability matrix query', () => {
  // ── Tool calling checks ───────────────────────────────────────────────────

  it('returns ok:true for a tool-capable model (anthropic/claude-opus-4-5)', () => {
    const result = checkProviderCapabilities('anthropic/claude-opus-4-5', {
      tool_calling: true,
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('returns ok:false with warning for ollama/llama3 which lacks tool calling', () => {
    // ollama/llama3 is in the vendored capability table with supports_function_calling: false
    // This is the Gap 5 acceptance test: tool-calling extension on no-tool model → warning
    const result = checkProviderCapabilities('ollama/llama3', {
      tool_calling: true,
    });
    expect(result.ok).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    const warning = result.warnings[0] ?? '';
    // The warning should mention tool calling and the model
    expect(warning).toMatch(/tool/i);
    expect(warning).toMatch(/ollama\/llama3/i);
  });

  it('returns ok:true for ollama/llama3.1 which supports tool calling', () => {
    // Gap 5: switching provider from ollama/llama3 to ollama/llama3.1 should pass
    // without any code change to the extension
    const result = checkProviderCapabilities('ollama/llama3.1', {
      tool_calling: true,
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('returns ok:true for a model with no tool_calling requirement', () => {
    const result = checkProviderCapabilities('ollama/llama3', {
      tool_calling: false,
    });
    expect(result.ok).toBe(true);
  });

  it('returns ok:true when requires block is empty', () => {
    const result = checkProviderCapabilities('ollama/llama3', {});
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  // ── Structured output checks ─────────────────────────────────────────────

  it('warns for ollama/llama3 with structured_output requirement', () => {
    const result = checkProviderCapabilities('ollama/llama3', {
      structured_output: true,
    });
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.match(/structured/i))).toBe(true);
  });

  it('passes structured_output for anthropic/claude-opus-4-5', () => {
    const result = checkProviderCapabilities('anthropic/claude-opus-4-5', {
      structured_output: true,
    });
    expect(result.ok).toBe(true);
  });

  // ── Context token checks ─────────────────────────────────────────────────

  it('warns when model context window is smaller than min_context_tokens', () => {
    // ollama/llama3 has max_input_tokens: 8192
    const result = checkProviderCapabilities('ollama/llama3', {
      min_context_tokens: 100000, // requires 100k but llama3 only has 8k
    });
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.match(/tokens/i))).toBe(true);
  });

  it('passes context token check when model has sufficient context', () => {
    // anthropic/claude-opus-4-5 has max_input_tokens: 200000
    const result = checkProviderCapabilities('anthropic/claude-opus-4-5', {
      min_context_tokens: 100000,
    });
    expect(result.ok).toBe(true);
  });

  // ── Unknown model ─────────────────────────────────────────────────────────

  it('returns ok:true with a warning for an unknown model (conservative)', () => {
    const result = checkProviderCapabilities('unknown/model-x', {
      tool_calling: true,
    });
    // Unknown models should NOT hard-fail (conservative: assume capable)
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.match(/unknown/i))).toBe(true);
  });

  // ── Provider format ───────────────────────────────────────────────────────

  it('handles both provider/model and bare model name lookup', () => {
    // Full qualified name
    const r1 = checkProviderCapabilities('anthropic/claude-opus-4-5', { tool_calling: true });
    expect(r1.ok).toBe(true);

    // openai/o1 is in the table and does NOT have tool calling
    const r2 = checkProviderCapabilities('openai/o1', { tool_calling: true });
    expect(r2.ok).toBe(false);
  });
});

describe('Gap 5 acceptance: advisory-warn default, hard-block opt-in', () => {
  it('documents the Gap 5 contract: capability check returns { ok, warnings } not an exception', () => {
    // The checkProviderCapabilities function is NEVER the authority on blocking
    // It returns a result; the install client decides based on strict_capabilities
    // This test verifies the function is pure and never throws
    expect(() => {
      checkProviderCapabilities('ollama/llama3', { tool_calling: true });
    }).not.toThrow();

    expect(() => {
      checkProviderCapabilities('anthropic/claude-opus-4-5', {
        tool_calling: true,
        structured_output: true,
        min_context_tokens: 200000,
      });
    }).not.toThrow();
  });
});
