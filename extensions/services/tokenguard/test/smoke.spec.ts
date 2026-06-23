/**
 * smoke.spec.ts — tokenguard service unit tests
 *
 * Covers:
 *   - resolveConfig() produces the correct shape from SOX_CONFIG_* env vars
 *   - genericAdapter.scopeRequest splits body into tokenizable + verbatim correctly
 *   - genericAdapter.reverseStream applies the reverse fn to the full body
 */

import { detokenizeText, Mapper, tokenizeStr } from '@adhd/sox-tokenguard-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { genericAdapter } from '../src/adapters/generic';
import { resolveConfig } from '../src/config';

// ── resolveConfig — env-driven config shape ──────────────────────────────────

describe('resolveConfig — env-driven config resolution', () => {
  let saved: Record<string, string | undefined> = {};

  const VARS = [
    'SOX_CONFIG_PORT',
    'SOX_CONFIG_UPSTREAM',
    'SOX_CONFIG_CAPTURE',
    'SOX_CONFIG_CAPTURE_MAX_BYTES',
    'SOX_CONFIG_PROVIDER',
    'SOX_CONFIG_MAP_PATH',
    'SOX_CONFIG_CAPTURE_DIR',
    'SOX_CONFIG_SEEDS',
    'SOX_CONFIG_NEVER',
    'SOX_CONFIG_DETECT_PHONE',
    'SOX_CONFIG_DETECT_IPV6',
  ];

  beforeEach(() => {
    for (const v of VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const v of VARS) {
      if (saved[v] === undefined) {
        delete process.env[v];
      } else {
        process.env[v] = saved[v];
      }
    }
  });

  it('returns correct defaults when no SOX_CONFIG_* vars are set', () => {
    const cfg = resolveConfig();
    expect(cfg.port).toBe(9099);
    expect(cfg.upstream).toBe('https://api.anthropic.com');
    expect(cfg.capture).toBe('truncated');
    expect(cfg.captureMaxBytes).toBe(4096);
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.seeds).toEqual([]);
    expect(cfg.never).toEqual([]);
    expect(cfg.detectPhone).toBe(false);
    expect(cfg.detectIpv6).toBe(true);
  });

  it('picks up SOX_CONFIG_PORT and SOX_CONFIG_UPSTREAM overrides', () => {
    process.env['SOX_CONFIG_PORT'] = '8080';
    process.env['SOX_CONFIG_UPSTREAM'] = 'https://api.openai.com';
    const cfg = resolveConfig();
    expect(cfg.port).toBe(8080);
    expect(cfg.upstream).toBe('https://api.openai.com');
  });

  it('parses SOX_CONFIG_SEEDS JSON array correctly', () => {
    process.env['SOX_CONFIG_SEEDS'] = JSON.stringify([
      { real: 'internal.host', type: 'host' },
      { real: 'admin@corp.com', type: 'email' },
    ]);
    const cfg = resolveConfig();
    expect(cfg.seeds).toHaveLength(2);
    expect(cfg.seeds[0]).toMatchObject({ real: 'internal.host', type: 'host' });
    expect(cfg.seeds[1]).toMatchObject({ real: 'admin@corp.com', type: 'email' });
  });

  it('sets provider to generic when SOX_CONFIG_PROVIDER=generic', () => {
    process.env['SOX_CONFIG_PROVIDER'] = 'generic';
    const cfg = resolveConfig();
    expect(cfg.provider).toBe('generic');
  });

  it('sets capture to full when SOX_CONFIG_CAPTURE=full', () => {
    process.env['SOX_CONFIG_CAPTURE'] = 'full';
    const cfg = resolveConfig();
    expect(cfg.capture).toBe('full');
  });

  it('falls back to truncated for an unrecognised capture value', () => {
    process.env['SOX_CONFIG_CAPTURE'] = 'invalid-mode';
    const cfg = resolveConfig();
    expect(cfg.capture).toBe('truncated');
  });
});

// ── genericAdapter — scopeRequest + reverseStream ────────────────────────────

describe('genericAdapter — scopeRequest', () => {
  it('puts the entire body into tokenizable and an empty object into verbatim', () => {
    const body = { system: 'You are an assistant.', messages: [{ role: 'user', content: 'Hello' }] };
    const { tokenizable, verbatim } = genericAdapter.scopeRequest(body);
    expect(tokenizable).toBe(body);
    expect(verbatim).toEqual({});
  });

  it('passes through any shape (string, array, nested object)', () => {
    for (const input of ['plain string', [1, 2, 3], { a: { b: 'c' } }]) {
      const { tokenizable } = genericAdapter.scopeRequest(input);
      expect(tokenizable).toBe(input);
    }
  });
});

describe('genericAdapter — reverseStream', () => {
  it('applies the reverse fn to the full raw string', () => {
    const m = new Mapper();
    const tok = m.getOrCreate('secure.internal', 'host', 'seed');
    const raw = `{"content": "${tok} responded."}`;

    const reverse = (s: string) => detokenizeText(s, m, null);
    const result = genericAdapter.reverseStream(raw, reverse);

    expect(result).toContain('secure.internal');
    expect(result).not.toContain(tok);
  });

  it('round-trips a seeded real through tokenizeStr + genericAdapter.reverseStream', () => {
    const m = new Mapper();
    m.getOrCreate('roundtrip.corp.internal', 'host', 'seed');

    const original = 'Host roundtrip.corp.internal is the target.';
    const tokenized = tokenizeStr(original, m, null);
    expect(tokenized).not.toContain('roundtrip.corp.internal');

    const reverse = (s: string) => detokenizeText(s, m, null);
    const restored = genericAdapter.reverseStream(tokenized, reverse);
    expect(restored).toBe(original);
  });
});
