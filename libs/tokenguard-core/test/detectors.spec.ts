/**
 * detectors.spec.ts — detector pipeline invariants
 *
 * Covers:
 *   - email / fqdn / ipv4 / ipv6 / mac / phone detection
 *   - case-insensitive detection
 *   - longest-first ordering (known reals)
 *   - NEVER-set exclusion (loopback, unspecified, custom)
 *   - fqdn-vs-path disambiguation (file extensions not tokenized)
 *   - identifierGroupVariants: specific labels kept, generic labels dropped
 */

import { describe, it, expect } from 'vitest';
import {
  Mapper,
  NEVER,
  detectEmail,
  detectFqdn,
  detectIpv4,
  detectIpv6,
  detectMac,
  detectPhone,
  detectKnown,
  tokenizeStr,
  identifierGroupVariants,
} from '../src/index';

// ── email ─────────────────────────────────────────────────────────────────────

describe('detectEmail', () => {
  it('tokenizes a plain email address', () => {
    const m = new Mapper();
    const r = detectEmail('Contact admin@target.internal for access', m, null);
    expect(r).toContain('<EMAIL_1>');
    expect(r).not.toContain('admin@target.internal');
  });

  it('is case-insensitive: ADMIN@TARGET.INTERNAL maps to same token as lowercase', () => {
    const m = new Mapper();
    detectEmail('admin@target.internal', m, null); // <EMAIL_1>
    const r = detectEmail('ADMIN@TARGET.INTERNAL second mention', m, null);
    // should reuse <EMAIL_1>, not allocate <EMAIL_2>
    expect(r).toContain('<EMAIL_1>');
    expect(m.entries().filter(e => e.type === 'email').length).toBe(1);
  });

  it('does not tokenize partial patterns (no @-sign)', () => {
    const m = new Mapper();
    const r = detectEmail('plain-word-no-at', m, null);
    expect(r).toBe('plain-word-no-at');
    expect(m.entries().length).toBe(0);
  });

  it('tokenizes multiple distinct emails in one string', () => {
    const m = new Mapper();
    const r = detectEmail('a@one.corp and b@two.corp', m, null);
    expect(r).not.toContain('@');
    expect(m.entries().filter(e => e.type === 'email').length).toBe(2);
  });
});

// ── fqdn ──────────────────────────────────────────────────────────────────────

describe('detectFqdn', () => {
  it('tokenizes a dotted hostname', () => {
    const m = new Mapper();
    const r = detectFqdn('Connect to webapp.internal.corp now', m, null);
    expect(r).not.toContain('webapp.internal.corp');
    expect(m.entries().some(e => e.type === 'host')).toBe(true);
  });

  it('does NOT tokenize file-path extensions (e.g. config.json)', () => {
    const m = new Mapper();
    const r = detectFqdn('Read config.json and output.log', m, null);
    // file extensions are in EXT_STOPLIST — should pass verbatim
    expect(r).toContain('config.json');
    expect(r).toContain('output.log');
    expect(m.entries().length).toBe(0);
  });

  it('does NOT tokenize localhost (NEVER set)', () => {
    const m = new Mapper();
    const r = detectFqdn('Running on localhost:8080', m, null);
    expect(r).toContain('localhost');
    expect(m.entries().length).toBe(0);
  });

  it('is case-insensitive: repeated FQDN in different case maps to same token', () => {
    const m = new Mapper();
    detectFqdn('target.corp', m, null);            // <HOST_1>
    const r = detectFqdn('TARGET.CORP elsewhere', m, null);
    expect(r).toContain('<HOST_1>');
    expect(m.entries().filter(e => e.type === 'host').length).toBe(1);
  });
});

// ── ipv4 ──────────────────────────────────────────────────────────────────────

describe('detectIpv4', () => {
  it('tokenizes a routable IPv4 address', () => {
    const m = new Mapper();
    const r = detectIpv4('Server at 10.0.0.42 is up', m, null);
    expect(r).not.toContain('10.0.0.42');
    expect(r).toContain('<IP_1>');
  });

  it('does NOT tokenize loopback (127.0.0.1 is in NEVER)', () => {
    const m = new Mapper();
    const r = detectIpv4('Loopback is 127.0.0.1', m, null);
    expect(r).toContain('127.0.0.1');
    expect(m.entries().length).toBe(0);
  });

  it('does NOT tokenize 0.0.0.0 (unspecified, in NEVER)', () => {
    const m = new Mapper();
    const r = detectIpv4('Bind to 0.0.0.0', m, null);
    expect(r).toContain('0.0.0.0');
    expect(m.entries().length).toBe(0);
  });

  it('tokenizes multiple distinct IPs', () => {
    const m = new Mapper();
    detectIpv4('10.0.0.1 and 10.0.0.2', m, null);
    expect(m.entries().filter(e => e.type === 'ip').length).toBe(2);
  });
});

// ── ipv6 ──────────────────────────────────────────────────────────────────────

describe('detectIpv6', () => {
  it('tokenizes a full IPv6 address', () => {
    const m = new Mapper();
    const r = detectIpv6('Host 2001:db8::1 is reachable', m, null);
    expect(r).not.toContain('2001:db8::1');
    expect(m.entries().some(e => e.type === 'ip6')).toBe(true);
  });

  it('does NOT tokenize ::1 (loopback, in NEVER)', () => {
    const m = new Mapper();
    const r = detectIpv6('IPv6 loopback is ::1', m, null);
    expect(r).toContain('::1');
    expect(m.entries().length).toBe(0);
  });
});

// ── mac ───────────────────────────────────────────────────────────────────────

describe('detectMac', () => {
  it('tokenizes a colon-separated MAC address', () => {
    const m = new Mapper();
    const r = detectMac('Interface MAC: aa:bb:cc:dd:ee:ff', m, null);
    expect(r).not.toContain('aa:bb:cc:dd:ee:ff');
    expect(m.entries().some(e => e.type === 'mac')).toBe(true);
  });

  it('tokenizes a hyphen-separated MAC address', () => {
    const m = new Mapper();
    const r = detectMac('HW: 11-22-33-44-55-66', m, null);
    expect(r).not.toContain('11-22-33-44-55-66');
    expect(m.entries().length).toBeGreaterThan(0);
  });

  it('is case-insensitive for hex digits', () => {
    const m = new Mapper();
    detectMac('AA:BB:CC:DD:EE:FF', m, null);
    const r = detectMac('aa:bb:cc:dd:ee:ff second mention', m, null);
    // both cases must resolve to the same entry
    expect(m.entries().filter(e => e.type === 'mac').length).toBe(1);
    expect(r).toContain('<MAC_1>');
  });
});

// ── phone ─────────────────────────────────────────────────────────────────────

describe('detectPhone', () => {
  it('tokenizes an E.164 phone number', () => {
    const m = new Mapper();
    const r = detectPhone('Call us at +1-800-555-1234', m, null);
    expect(r).not.toContain('+1-800-555-1234');
    expect(m.entries().some(e => e.type === 'phone')).toBe(true);
  });

  it('does NOT tokenize a bare integer (no separator)', () => {
    const m = new Mapper();
    const r = detectPhone('Count: 18005551234', m, null);
    // no separator or + prefix → must not be tokenized
    expect(r).toContain('18005551234');
    expect(m.entries().length).toBe(0);
  });
});

// ── NEVER set (global) ────────────────────────────────────────────────────────

describe('NEVER set', () => {
  it('NEVER contains the canonical loopback + unspecified addresses', () => {
    expect(NEVER.has('127.0.0.1')).toBe(true);
    expect(NEVER.has('0.0.0.0')).toBe(true);
    expect(NEVER.has('::1')).toBe(true);
    expect(NEVER.has('localhost')).toBe(true);
  });

  it('per-instance mapper.never excludes a user-added real from tokenization via tokenizeStr', () => {
    const m = new Mapper();
    m.never.add('safe.internal');
    const r = tokenizeStr('Host: safe.internal is exempt', m, null);
    expect(r).toContain('safe.internal');
    expect(m.entries().length).toBe(0);
  });
});

// ── longest-first (known reals) ───────────────────────────────────────────────

describe('detectKnown — longest-first ordering', () => {
  it('tokenizes the longer of two overlapping reals first', () => {
    const m = new Mapper();
    // seed both, the longer one must replace entirely without partial replacement
    m.getOrCreate('corp.internal', 'host', 'seed');          // <HOST_1>
    m.getOrCreate('webapp.corp.internal', 'host', 'seed');   // <HOST_2>

    const r = detectKnown('Connecting to webapp.corp.internal', m, null);
    // The longer match wins; result should contain <HOST_2>, not a partial replacement
    expect(r).toContain('<HOST_2>');
    expect(r).not.toContain('webapp.corp.internal');
    // <HOST_1> should NOT appear embedded inside <HOST_2> replacement
    expect(r).not.toContain('<HOST_1>');
  });
});

// ── identifierGroupVariants ───────────────────────────────────────────────────

describe('identifierGroupVariants', () => {
  it('keeps specific labels from the label and member hostnames', () => {
    const variants = identifierGroupVariants('vulntarget', ['webapp.vulntarget.internal']);
    // 'vulntarget' and 'webapp' are specific (length >= 4, not in stoplist)
    expect(variants).toContain('vulntarget');
    expect(variants).toContain('webapp');
  });

  it('drops generic labels in the stoplist (e.g. "api", "www", "admin")', () => {
    const variants = identifierGroupVariants('api', ['www.example.corp']);
    // 'api' is < 4 chars or in stoplist → dropped
    // 'www' is in stoplist → dropped
    expect(variants).not.toContain('api');
    expect(variants).not.toContain('www');
    // 'example' and 'corp' may remain if they are specific
    // 'corp' is 4 chars but it is actually in the stoplist... check that it does not appear
    // (corp is in LABEL_STOPLIST in the engine source)
    expect(variants.every(v => v !== 'api' && v !== 'www')).toBe(true);
  });

  it('drops labels shorter than 4 characters', () => {
    const variants = identifierGroupVariants('abc', []);
    expect(variants).not.toContain('abc');
  });

  it('returns de-duplicated lower-cased results', () => {
    const variants = identifierGroupVariants('vulntarget', [
      'vulntarget.corp',
      'VULNTARGET.internal',
    ]);
    const occurrences = variants.filter(v => v === 'vulntarget').length;
    expect(occurrences).toBe(1);
  });

  it('excludes values in NEVER', () => {
    // NEVER contains 'localhost'
    const variants = identifierGroupVariants('localhost', ['localhost.example.corp']);
    expect(variants).not.toContain('localhost');
  });
});
