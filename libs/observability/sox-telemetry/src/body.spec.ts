/**
 * body.spec.ts — c536ce29 L1-AC-A: BodyCapture / captureBody accounting.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BodyCapture, captureBody } from './body.js';

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

describe('c536ce29 L1-AC-A captureBody', () => {
  it('c536ce29 L1-AC-A under the cap: verbatim text, exact bytes, not truncated', () => {
    const r = captureBody('héllo', { maxBytes: 100 });
    expect(r).toEqual({ body: 'héllo', body_bytes: 6, body_sha256: sha('héllo'), truncated: false });
  });

  it('c536ce29 L1-AC-A exactly at the cap is not truncated', () => {
    const r = captureBody('abcd', { maxBytes: 4 });
    expect(r.truncated).toBe(false);
    expect(r.body).toBe('abcd');
  });

  it('c536ce29 L1-AC-A truncated: sha256 and body_bytes cover ALL bytes, text capped', () => {
    const input = 'x'.repeat(10_000);
    const r = captureBody(input, { maxBytes: 1024 });
    expect(r.truncated).toBe(true);
    expect(r.body).toBe('x'.repeat(1024));
    expect(r.body_bytes).toBe(10_000);
    expect(r.body_sha256).toBe(sha(input));
  });

  it('c536ce29 L1-AC-A multibyte-safe: never splits a character at the cut, at every cut offset', () => {
    const input = 'a€b😀c漢d'; // 1,3,1,4,1,3,1 bytes
    const full = Buffer.from(input);
    for (let max = 1; max < full.length; max++) {
      const r = captureBody(input, { maxBytes: max });
      expect(r.body).not.toContain('�');
      expect(input.startsWith(r.body as string)).toBe(true);
      expect(Buffer.byteLength(r.body as string)).toBeLessThanOrEqual(max);
      expect(r.truncated).toBe(true);
      expect(r.body_bytes).toBe(full.length);
      expect(r.body_sha256).toBe(sha(full));
    }
  });

  it('c536ce29 L1-AC-A Uint8Array input (incl. a view with byteOffset) is hashed and counted exactly', () => {
    const big = Buffer.from('0123456789');
    const view = new Uint8Array(big.buffer, big.byteOffset + 2, 5); // "23456"
    const r = captureBody(view, { maxBytes: 3 });
    expect(r.body).toBe('234');
    expect(r.body_bytes).toBe(5);
    expect(r.body_sha256).toBe(sha('23456'));
  });

  it('c536ce29 L1-AC-A maxBytes 0 (or invalid) is digest-only: body null, hash and count exact', () => {
    for (const maxBytes of [0, -5, Number.NaN]) {
      const r = captureBody('secret-ish', { maxBytes });
      expect(r.body).toBeNull();
      expect(r.truncated).toBe(true);
      expect(r.body_bytes).toBe(10);
      expect(r.body_sha256).toBe(sha('secret-ish'));
    }
  });

  it('c536ce29 L1-AC-A empty input', () => {
    expect(captureBody('', { maxBytes: 8 })).toEqual({ body: '', body_bytes: 0, body_sha256: sha(''), truncated: false });
  });
});

describe('c536ce29 L1-AC-A BodyCapture streaming', () => {
  it('c536ce29 L1-AC-A a multibyte char split across chunks is reassembled; hash equals the one-shot hash', () => {
    const bytes = Buffer.from('€€€€'); // 12 bytes
    const c = new BodyCapture({ maxBytes: 7 });
    c.append(bytes.subarray(0, 2));
    c.append(bytes.subarray(2, 5));
    c.append(bytes.subarray(5));
    const r = c.finish();
    expect(r.body).toBe('€€'); // 7 bytes kept -> 6 whole bytes
    expect(r.body_bytes).toBe(12);
    expect(r.body_sha256).toBe(sha(bytes));
    expect(r.truncated).toBe(true);
  });

  it('c536ce29 L1-AC-A finish() is idempotent and append may continue afterwards', () => {
    const c = new BodyCapture({ maxBytes: 100 });
    c.append('ab');
    const first = c.finish();
    expect(c.finish()).toEqual(first);
    c.append('cd');
    expect(c.finish()).toEqual({ body: 'abcd', body_bytes: 4, body_sha256: sha('abcd'), truncated: false });
  });

  it('c536ce29 L1-AC-A many small chunks past the cap match the one-shot result; bad chunks never throw', () => {
    const c = new BodyCapture({ maxBytes: 50 });
    const parts: string[] = [];
    for (let i = 0; i < 100; i++) {
      parts.push(`chunk${i};`);
      c.append(`chunk${i};`);
    }
    expect(() => c.append(undefined as unknown as string)).not.toThrow();
    const all = parts.join('');
    expect(c.finish()).toEqual(captureBody(all, { maxBytes: 50 }));
    expect(c.finish().body_sha256).toBe(sha(all));
  });
});
