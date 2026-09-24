/**
 * grace-ms.spec.ts
 *
 * Fast, no-subprocess unit coverage for `parseGraceMsFlag`
 * (apps/sox/src/grace-ms.ts) — the shared `--grace-ms`/`SOX_STOP_GRACE_MS`
 * resolver used by `cmdStop`, `cmdService`, and `cmdServe` in `main.ts`.
 */
import { describe, expect, it } from 'vitest';

import { parseGraceMsFlag, resolveGraceMs } from './grace-ms.js';

describe('parseGraceMsFlag', () => {
  it('returns undefined when the value is absent', () => {
    expect(parseGraceMsFlag(undefined)).toBeUndefined();
  });

  it('returns undefined for an empty string (regression: --grace-ms= must NOT resolve to 0/immediate SIGKILL)', () => {
    // Number('') === 0, and 0 is a valid non-negative grace value — without
    // an explicit blank check, an empty `--grace-ms=` silently selected
    // immediate SIGKILL instead of falling back to the caller's default.
    expect(parseGraceMsFlag('')).toBeUndefined();
  });

  it('returns undefined for a whitespace-only string', () => {
    expect(parseGraceMsFlag('   ')).toBeUndefined();
    expect(parseGraceMsFlag('\t\n')).toBeUndefined();
  });

  it('parses "0" as a valid, non-negative override (immediate SIGKILL)', () => {
    expect(parseGraceMsFlag('0')).toBe(0);
  });

  it('parses a positive integer string', () => {
    expect(parseGraceMsFlag('3000')).toBe(3000);
  });

  it('trims surrounding whitespace on an otherwise valid value', () => {
    expect(parseGraceMsFlag('  1500  ')).toBe(1500);
  });

  it('returns undefined for a negative number', () => {
    expect(parseGraceMsFlag('-1')).toBeUndefined();
  });

  it('returns undefined for a non-numeric string', () => {
    expect(parseGraceMsFlag('not-a-number')).toBeUndefined();
  });

  it('returns undefined for Infinity/NaN-producing input', () => {
    expect(parseGraceMsFlag('Infinity')).toBeUndefined();
    expect(parseGraceMsFlag('NaN')).toBeUndefined();
  });
});

describe('resolveGraceMs', () => {
  it('a blank flag falls through to a valid env var (regression: `flag ?? env` treats "" as present)', () => {
    expect(resolveGraceMs('', '3000')).toBe(3000);
  });

  it('a whitespace-only flag with no env var resolves to undefined', () => {
    expect(resolveGraceMs('  ', undefined)).toBeUndefined();
  });

  it('a present, valid flag ("0") wins over the env var', () => {
    expect(resolveGraceMs('0', '3000')).toBe(0);
  });

  it('an absent flag with a blank env var resolves to undefined', () => {
    expect(resolveGraceMs(undefined, '')).toBeUndefined();
  });

  it('a present but INVALID flag does NOT fall through to the env var — it resolves to undefined (caller applies its default)', () => {
    expect(resolveGraceMs('not-a-number', '3000')).toBeUndefined();
    expect(resolveGraceMs('-5', '3000')).toBeUndefined();
  });

  it('an absent flag falls through to a valid env var', () => {
    expect(resolveGraceMs(undefined, '2500')).toBe(2500);
  });

  it('both absent resolves to undefined', () => {
    expect(resolveGraceMs(undefined, undefined)).toBeUndefined();
  });
});
