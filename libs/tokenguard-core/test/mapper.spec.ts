/**
 * mapper.spec.ts — bijective cache invariants
 *
 * Covers:
 *   - idempotent getOrCreate (same token returned, source NOT rewritten)
 *   - bijective: a token never reverses to two reals
 *   - reload-stable IDs + per-type counter continues post-reload
 *   - every entry satisfies [shape:token-map]
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Mapper } from '../src/index';

// ── helpers ──────────────────────────────────────────────────────────────────

function tmpFile(): string {
  return path.join(os.tmpdir(), `tg-mapper-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
}

function isoRe(): RegExp {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
}

// ── getOrCreate idempotency ───────────────────────────────────────────────────

describe('Mapper.getOrCreate — idempotency', () => {
  it('returns the same token on repeated calls for the same real', () => {
    const m = new Mapper();
    const t1 = m.getOrCreate('vulntarget.internal', 'host', 'seed');
    const t2 = m.getOrCreate('vulntarget.internal', 'host', 'seed');
    expect(t1).toBe(t2);
  });

  it('preserves the original source even when a different source is supplied on a repeated call', () => {
    const m = new Mapper();
    m.getOrCreate('admin@vulntarget.internal', 'email', 'seed');
    m.getOrCreate('admin@vulntarget.internal', 'email', 'proxy'); // should not overwrite
    const entry = m.entries().find(e => e.real === 'admin@vulntarget.internal');
    expect(entry?.source).toBe('seed');
  });

  it('allocates distinct tokens for distinct reals of the same type', () => {
    const m = new Mapper();
    const t1 = m.getOrCreate('host-a.internal', 'host', 'seed');
    const t2 = m.getOrCreate('host-b.internal', 'host', 'seed');
    expect(t1).not.toBe(t2);
  });

  it('increments the per-type counter monotonically', () => {
    const m = new Mapper();
    const t1 = m.getOrCreate('10.0.0.1', 'ip', 'seed');
    const t2 = m.getOrCreate('10.0.0.2', 'ip', 'seed');
    const t3 = m.getOrCreate('10.0.0.3', 'ip', 'seed');
    // tokens should be <IP_1>, <IP_2>, <IP_3>
    expect(t1).toBe('<IP_1>');
    expect(t2).toBe('<IP_2>');
    expect(t3).toBe('<IP_3>');
  });

  // NEGATIVE CONTROL: mutating expected idempotency behaviour should cause failure.
  it('[neg-ctrl] a second getOrCreate for the same real must NOT allocate a new token', () => {
    const m = new Mapper();
    m.getOrCreate('target.corp', 'host', 'seed');
    // If idempotency broke (returned a fresh token), entries().length would be 2
    m.getOrCreate('target.corp', 'host', 'proxy');
    expect(m.entries().length).toBe(1);
  });
});

// ── bijective guarantee ────────────────────────────────────────────────────────

describe('Mapper — bijectivity', () => {
  it('a token never reverses to two different reals', () => {
    const m = new Mapper();
    const t1 = m.getOrCreate('webapp.internal', 'host', 'seed');
    // Attempt to create a second entry that would reverse to the same token
    // (this is an explicit-register conflict; should throw)
    expect(() =>
      m.registerExplicit('OTHER-host.internal', 'host', t1, 'custom'),
    ).toThrow();
  });

  it('realOf(tokenOf(real)) === real for every entry', () => {
    const m = new Mapper();
    const reals = ['alpha.internal', 'beta.internal', 'gamma.internal'];
    for (const r of reals) m.getOrCreate(r, 'host', 'seed');
    for (const r of reals) {
      const tok = m.tokenOf(r);
      expect(tok).toBeDefined();
      expect(m.realOf(tok!)).toBe(r);
    }
  });

  it('tokenOf(realOf(token)) === token for every entry', () => {
    const m = new Mapper();
    const reals = ['192.168.1.1', '10.10.0.5', '172.16.3.4'];
    for (const r of reals) m.getOrCreate(r, 'ip', 'seed');
    for (const e of m.entries()) {
      expect(m.tokenOf(m.realOf(e.token)!)).toBe(e.token);
    }
  });
});

// ── reload-stable IDs ──────────────────────────────────────────────────────────

describe('Mapper — reload stability', () => {
  let p: string;

  beforeEach(() => { p = tmpFile(); });
  afterEach(() => { try { fs.unlinkSync(p); } catch { /* ignore */ } });

  it('the same real maps to the same token after reload', () => {
    const m1 = new Mapper(p);
    const tok = m1.getOrCreate('internal.target', 'host', 'seed');

    const m2 = new Mapper(p);
    expect(m2.tokenOf('internal.target')).toBe(tok);
  });

  it('the per-type counter continues above the highest loaded index (no collision)', () => {
    const m1 = new Mapper(p);
    m1.getOrCreate('host-a.corp', 'host', 'seed'); // <HOST_1>
    m1.getOrCreate('host-b.corp', 'host', 'seed'); // <HOST_2>

    const m2 = new Mapper(p);
    const tok = m2.getOrCreate('host-c.corp', 'host', 'seed'); // must be <HOST_3>
    expect(tok).toBe('<HOST_3>');
  });

  it('IDs are never reassigned across restarts (existing entries untouched)', () => {
    const m1 = new Mapper(p);
    m1.getOrCreate('stable.corp', 'host', 'seed');

    const m2 = new Mapper(p);
    m2.getOrCreate('new-entry.corp', 'host', 'seed');

    // stable.corp must still map to <HOST_1> in m2
    expect(m2.tokenOf('stable.corp')).toBe('<HOST_1>');
    // and the new entry to <HOST_2>
    expect(m2.tokenOf('new-entry.corp')).toBe('<HOST_2>');
  });

  it('serialize() produces a valid v2 token-mapping.json', () => {
    const m = new Mapper();
    m.getOrCreate('serialize.test', 'host', 'seed');
    const doc = m.serialize();
    expect(doc.version).toBe(2);
    expect(Array.isArray(doc.entries)).toBe(true);
  });
});

// ── [shape:token-map] compliance ───────────────────────────────────────────────

describe('Mapper — [shape:token-map] entry shape', () => {
  it('every entry has token, real, type, source (valid), and created_ts (ISO-8601)', () => {
    const m = new Mapper();
    m.getOrCreate('shape-test.internal', 'host', 'seed');
    m.getOrCreate('user@shape-test.internal', 'email', 'proxy');
    m.getOrCreate('192.168.99.1', 'ip', 'tooling');

    const validSources = new Set(['seed', 'proxy', 'tooling', 'custom']);

    for (const entry of m.entries()) {
      // token field
      expect(typeof entry.token).toBe('string');
      expect(entry.token).toMatch(/^<[A-Z0-9]+_\d+>$/);
      // real field
      expect(typeof entry.real).toBe('string');
      expect(entry.real.length).toBeGreaterThan(0);
      // type field
      expect(typeof entry.type).toBe('string');
      // source must be one of the four valid values
      expect(validSources.has(entry.source as string)).toBe(true);
      // created_ts must be ISO-8601 without milliseconds (per engine output format)
      expect(entry.created_ts).toMatch(isoRe());
    }
  });

  it('getOrCreate with an invalid source throws', () => {
    const m = new Mapper();
    expect(() => m.getOrCreate('bad-source.test', 'host', 'invalid' as never)).toThrow();
  });
});

// ── never set ────────────────────────────────────────────────────────────────

describe('Mapper — never set', () => {
  it('never set prevents identifier-group variants from being seeded', () => {
    // The never set guards derived variants produced from label+host seeds,
    // not the explicitly listed seed items themselves.
    const m = new Mapper();
    // 'webapp' would normally be derived as a variant from this label+host combo.
    // Adding it to never ensures it is skipped during the variant derivation pass.
    m.never.add('webapp');
    m.seed([
      { real: 'acmecorp', type: 'id' },           // label — triggers variant derivation
      { real: 'webapp.acmecorp.internal', type: 'host' },
    ]);
    // 'webapp' must not appear as a derived id entry
    const reals = m.entries().map(e => e.real);
    expect(reals).not.toContain('webapp');
    // 'acmecorp' IS a specific variant (>= 4 chars, not in stoplist) and should be seeded
    expect(reals).toContain('acmecorp');
  });
});
