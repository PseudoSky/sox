/**
 * redact.spec.ts — c536ce29 TRC-AC8 (canary suite + negative control), L1-AC-B (never throws).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_REDACTION_RULES, createRedactor, identityRedactor } from './redact.js';

const CANARY = 'sk-ant-api03-CANARY0123456789abcdef';
const CORE = 'CANARY0123456789abcdef';
const DEEPSEEK = 'ds-unfamiliar-format-9f8e7d6c5b4a';

function marker(s: string): string {
  return `[REDACTED:${createHash('sha256').update(s).digest('hex').slice(0, 8)}:len=${s.length}]`;
}

function record(): Record<string, unknown> {
  return {
    event: 'api.request',
    url: `https://api.example.test/v1/messages?key=${CANARY}`,
    headers: {
      Authorization: `Bearer ${CANARY}`,
      'X-Api-Key': CANARY,
      'x-custom-token': 'short1',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'Set-Cookie': ['a=1234567890', 'b=abcdefghij'],
    },
    body: JSON.stringify({ api_key: CANARY, max_tokens: 4096, messages: [{ role: 'user', content: `use ${CANARY} now` }] }),
    nested: { tool_result: `leaked ${CANARY}`, password: 'hunter2hunter2', usage: { input_tokens: 12 } },
    argv: ['--key', CANARY],
    env: { PROVIDER_KEY: DEEPSEEK },
    max_tokens: 4096,
    token: 'abcdefgh',
    shorttoken: 'x',
  };
}

describe('c536ce29 TRC-AC8 canary suite: createRedactor scrubs every secret shape', () => {
  const r = createRedactor({ knownSecrets: [DEEPSEEK] });

  it('c536ce29 TRC-AC8 redactValue leaves no canary or known secret anywhere', () => {
    const out = JSON.stringify(r.redactValue(record()));
    expect(out).not.toContain(CORE);
    expect(out).not.toContain(DEEPSEEK);
    expect(out).not.toContain('hunter2hunter2');
    expect(out).not.toContain('abcdefgh');
    expect(out).not.toContain('a=1234567890');
  });

  it('c536ce29 TRC-AC8 redactLine leaves no canary in a serialized record, escaped payloads included', () => {
    const out = r.redactLine(JSON.stringify(record()));
    expect(out).not.toContain(CORE);
    expect(out).not.toContain(DEEPSEEK);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('c536ce29 TRC-AC8 redactLine scrubs non-JSON text lines', () => {
    const out = r.redactLine(`spawn claude --api-key ${CANARY} && echo ${DEEPSEEK}`);
    expect(out).not.toContain(CORE);
    expect(out).not.toContain(DEEPSEEK);
  });

  it('c536ce29 TRC-AC8 R1 headers: names redacted (marker has hash + len), allowlist and non-secret headers preserved', () => {
    const h = (r.redactValue(record()) as { headers: Record<string, unknown> }).headers;
    expect(h.Authorization).toMatch(/^\[REDACTED:[0-9a-f]{8}:len=\d+\]$/);
    expect(h['X-Api-Key']).toMatch(/^\[REDACTED:[0-9a-f]{8}:len=\d+\]$/);
    expect(h['x-custom-token']).toMatch(/^\[REDACTED:/); // pattern rule, any length
    expect(h['anthropic-version']).toBe('2023-06-01');
    expect(h['content-type']).toBe('application/json');
    expect((h['Set-Cookie'] as string[]).every((c) => c.startsWith('[REDACTED:'))).toBe(true);
  });

  it('c536ce29 TRC-AC8 R3 keeps token COUNTS and short values; redacts secret-named strings >= 8 chars', () => {
    const v = r.redactValue(record()) as Record<string, unknown>;
    expect(v.max_tokens).toBe(4096);
    expect((v.nested as { usage: { input_tokens: number } }).usage.input_tokens).toBe(12);
    expect(v.shorttoken).toBe('x');
    expect(v.token).toMatch(/^\[REDACTED:/);
    const shortKey = r.redactValue({ token: 'abc1234' }) as { token: string }; // 7 chars
    expect(shortKey.token).toBe('abc1234');
  });

  it.each([
    ['sk-ant', 'sk-ant-api03-ABCDEFGHIJKLMNOP1234'],
    ['sk-or-v1', 'sk-or-v1-ABCDEFGHIJKLMNOP1234'],
    ['sk-proj', 'sk-proj-ABCDEFGHIJKLMNOP1234'],
    ['sk generic', 'sk-ABCDEFGHIJKLMNOPQRSTUVWX'],
    ['Bearer', 'Bearer abcdefghijklmnop12345678'],
    ['AIza', `AIza${'a'.repeat(35)}`],
    ['github', `ghp_${'A'.repeat(36)}`],
    ['slack', 'xoxb-1234567890-abcdef'],
    ['aws', 'AKIAABCDEFGHIJKLMNOP'],
    ['jwt', 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4'],
    ['private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----'],
  ])('c536ce29 TRC-AC8 R2 %s shape is scrubbed from free text', (_n, secret) => {
    const out = r.redactLine(`prefix ${secret} suffix`);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED:');
    expect(out.startsWith('prefix ') && out.endsWith(' suffix')).toBe(true);
  });

  it('c536ce29 TRC-AC8 R4 registerSecret scrubs later occurrences; secrets under 8 chars are ignored', () => {
    const rr = createRedactor();
    const late = 'late-registered-secret-value';
    expect(rr.redactLine(`x ${late}`)).toContain(late);
    rr.registerSecret(late);
    rr.registerSecret('short');
    expect(rr.redactLine(`x ${late} short`)).toBe(`x ${marker(late)} short`);
  });

  it('c536ce29 TRC-AC8 extraRules run after the defaults; a throwing rule is skipped', () => {
    const rr = createRedactor({
      extraRules: [
        {
          id: 'boom',
          apply: () => {
            throw new Error('x');
          },
        },
        { id: 'zap', apply: ({ text }) => (text.includes('ZAP') ? text.replace(/ZAP/g, '[zapped]') : undefined) },
      ],
    });
    expect(rr.redactLine(`a ZAP ${CANARY}`)).not.toContain(CORE);
    expect(rr.redactLine('a ZAP')).toBe('a [zapped]');
    expect(DEFAULT_REDACTION_RULES.map((x) => x.id)).toEqual(['R1-header', 'R2-key-shaped', 'R3-json-key', 'R4-known-secret']);
  });
});

describe('c536ce29 TRC-AC8 negative control: identityRedactor does NOT scrub the same canaries', () => {
  it('c536ce29 TRC-AC8 identity leaves canary and known secret in both line and value paths', () => {
    identityRedactor.registerSecret(DEEPSEEK);
    const line = identityRedactor.redactLine(JSON.stringify(record()));
    const value = JSON.stringify(identityRedactor.redactValue(record()));
    for (const out of [line, value]) {
      expect(out).toContain(CORE);
      expect(out).toContain(DEEPSEEK);
    }
  });
});

describe('c536ce29 L1-AC-B redactor never throws', () => {
  const r = createRedactor();
  it('c536ce29 L1-AC-B circular references become [Circular]', () => {
    const a: Record<string, unknown> = { name: 'a', token: CANARY };
    a.self = a;
    a.list = [a];
    const out = r.redactValue(a) as Record<string, unknown>;
    expect(out.self).toBe('[Circular]');
    expect(JSON.stringify(out)).not.toContain(CORE);
  });
  it('c536ce29 L1-AC-B shared (non-circular) references are preserved', () => {
    const shared = { v: 1 };
    expect(r.redactValue({ a: shared, b: shared })).toEqual({ a: { v: 1 }, b: { v: 1 } });
  });
  it('c536ce29 L1-AC-B BigInt values do not throw', () => {
    expect(() => r.redactValue({ n: 10n, nested: [1n] })).not.toThrow();
    expect((r.redactValue({ n: 10n }) as { n: bigint }).n).toBe(10n);
  });
  it('c536ce29 L1-AC-B hostile inputs (throwing getter, toJSON, depth bomb, non-string line) never throw', () => {
    const hostile = {
      get boom(): string {
        throw new Error('getter');
      },
    };
    expect(() => r.redactValue(hostile)).not.toThrow();
    expect(r.redactValue(hostile)).toBe('[REDACT_ERROR]');
    expect(() =>
      r.redactValue({
        toJSON() {
          throw new Error('t');
        },
      }),
    ).not.toThrow();
    let deep: Record<string, unknown> = { leaf: CANARY };
    for (let i = 0; i < 500; i++) deep = { d: deep };
    expect(() => r.redactValue(deep)).not.toThrow();
    expect(r.redactLine(undefined as unknown as string)).toBe('{"event":"log.redact_error"}');
    expect(() => r.registerSecret(undefined as unknown as string)).not.toThrow();
  });
  it('c536ce29 L1-AC-B Error objects, Map and Set are redacted structurally', () => {
    const out = JSON.stringify(r.redactValue({ e: new Error(`bad ${CANARY}`), m: new Map([['k', CANARY]]), s: new Set([CANARY]) }));
    expect(out).not.toContain(CORE);
  });
});
