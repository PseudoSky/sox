import { describe, it, expect } from 'vitest';
import { isUniqueConstraintError, isFatalConnectionError } from './errors.js';

describe('errors.ts — SQLITE_*-code helpers vs the live Turso driver', () => {
  /**
   * BUG-ERRORS-TS-CODE-HELPERS-NEVER-MATCH-TURSO-001 — documents a
   * pre-existing, separate defect found while building SPEC-CONN-RECYCLE
   * (2026-08-08): probing the real `@tursodatabase/database@0.7.1` driver
   * directly shows every error it raises carries `code: 'GenericFailure'`,
   * including a genuine UNIQUE constraint violation
   * (`step failed: Runtime error: UNIQUE constraint failed: t.name (19)`).
   * `isUniqueConstraintError`/`isForeignKeyError`/`isBusyError`/
   * `isDatabaseError` are all keyed on an `SQLITE_*`-prefixed `code` — a
   * shape that is real for `SqliteAdapterImpl`'s better-sqlite3 driver but
   * NEVER produced by the live Turso driver. This test is deliberately
   * RED-as-shipped: it documents the gap so the next reader doesn't have to
   * rediscover it. Do not mark it `it.skip` and do not resolve the filed
   * backlog item from this assertion alone — see SPEC-CONN-RECYCLE.md §2.
   */
  it('BUG-ERRORS-TS-CODE-HELPERS-NEVER-MATCH-TURSO-001: isUniqueConstraintError never matches a real Turso UNIQUE violation', () => {
    const realTursoUniqueViolation = {
      code: 'GenericFailure',
      message: 'step failed: Runtime error: UNIQUE constraint failed: t.name (19)',
    };
    expect(isUniqueConstraintError(realTursoUniqueViolation)).toBe(false);
  });

  describe('isFatalConnectionError', () => {
    it('matches the incident I/O error text', () => {
      expect(
        isFatalConnectionError({
          code: 'GenericFailure',
          message:
            'reset failed: I/O error: short read on WAL frame at offset 4152: expected 4096 bytes, got 0',
        }),
      ).toBe(true);
    });

    it('matches a malformed-disk-image message', () => {
      expect(
        isFatalConnectionError({ code: 'GenericFailure', message: 'database disk image is malformed' }),
      ).toBe(true);
    });

    it('does not match a UNIQUE constraint violation (statement-local, not fatal)', () => {
      expect(
        isFatalConnectionError({
          code: 'GenericFailure',
          message: 'step failed: Runtime error: UNIQUE constraint failed: t.name (19)',
        }),
      ).toBe(false);
    });

    it('does not match a bad-SQL parse error (statement-local, not fatal)', () => {
      expect(
        isFatalConnectionError({
          code: 'GenericFailure',
          message: 'failed to consume stmt: near "SELEKT": syntax error',
        }),
      ).toBe(false);
    });

    it('does not classify by code alone — GenericFailure with a benign message is not fatal', () => {
      expect(isFatalConnectionError({ code: 'GenericFailure', message: 'datatype mismatch' })).toBe(false);
    });

    it('returns false for non-error-shaped input', () => {
      expect(isFatalConnectionError(null)).toBe(false);
      expect(isFatalConnectionError(undefined)).toBe(false);
      expect(isFatalConnectionError('plain string')).toBe(false);
      expect(isFatalConnectionError(new Error('no code property'))).toBe(false);
    });
  });
});
