import { describe, it, expect } from 'vitest';
import {
  isUniqueConstraintError,
  isForeignKeyError,
  isBusyError,
  isConcurrentConflict,
  isDatabaseError,
  isFatalConnectionError,
  isAlreadyOpenWithoutMultiprocessWal,
  isTshmCoordinationInitRace,
} from './errors.js';

describe('errors.ts — SQLITE_*-code helpers vs the live Turso driver', () => {
  /**
   * BUG-ERRORS-TS-CODE-HELPERS-NEVER-MATCH-TURSO-001 — resolved by
   * BUG-MEMORY-001's §2.1 (2026-08-08): `isUniqueConstraintError`,
   * `isForeignKeyError`, `isBusyError`, `isConcurrentConflict`, and
   * `isDatabaseError` are now widened to OR a Turso message-marker check
   * (following `isFatalConnectionError`'s established precedent — match
   * driver TEXT, never `err.code`, since `@tursodatabase/database@0.7.1`
   * emits `code: 'GenericFailure'` on every error) alongside the original
   * SQLite `code`-based check. The widening is strict: nothing that was
   * `true` on the SQLite/code-based check becomes `false`.
   */
  it('BUG-ERRORS-TS-CODE-HELPERS-NEVER-MATCH-TURSO-001: isUniqueConstraintError now matches a real Turso UNIQUE violation', () => {
    const realTursoUniqueViolation = {
      code: 'GenericFailure',
      message: 'step failed: Runtime error: UNIQUE constraint failed: t.name (19)',
    };
    expect(isUniqueConstraintError(realTursoUniqueViolation)).toBe(true);
  });

  it('isForeignKeyError matches a real Turso FOREIGN KEY violation', () => {
    const realTursoForeignKeyViolation = {
      code: 'GenericFailure',
      message: 'step failed: Runtime error: FOREIGN KEY constraint failed',
    };
    expect(isForeignKeyError(realTursoForeignKeyViolation)).toBe(true);
  });

  it('isBusyError matches the BUG-MEMORY-001 incident text verbatim ("database is locked", no phase prefix)', () => {
    expect(isBusyError({ code: 'GenericFailure', message: 'database is locked' })).toBe(true);
  });

  it('isConcurrentConflict matches the BUG-MEMORY-001 incident text verbatim', () => {
    expect(isConcurrentConflict({ code: 'GenericFailure', message: 'database is locked' })).toBe(true);
  });

  it('isBusyError matches a phase-prefixed Turso busy message', () => {
    expect(isBusyError({ code: 'GenericFailure', message: 'step failed: database table is locked' })).toBe(
      true,
    );
  });

  it('isDatabaseError matches any phase-prefixed Turso GenericFailure', () => {
    expect(
      isDatabaseError({
        code: 'GenericFailure',
        message: 'step failed: Runtime error: UNIQUE constraint failed: t.name (19)',
      }),
    ).toBe(true);
  });

  it('isDatabaseError does NOT match a Turso GenericFailure with no phase-prefix marker', () => {
    expect(isDatabaseError({ code: 'GenericFailure', message: 'database is locked' })).toBe(false);
  });

  it('SQLite code-based checks are unchanged (strict widening, not a rewrite)', () => {
    expect(isUniqueConstraintError({ code: 'SQLITE_CONSTRAINT_UNIQUE', message: 'UNIQUE failed' })).toBe(
      true,
    );
    expect(isForeignKeyError({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY', message: 'FK failed' })).toBe(true);
    expect(isBusyError({ code: 'SQLITE_BUSY', message: 'database is locked' })).toBe(true);
    expect(isConcurrentConflict({ code: 'SQLITE_BUSY_SNAPSHOT', message: 'snapshot conflict' })).toBe(true);
    expect(isDatabaseError({ code: 'SQLITE_IOERR', message: 'disk I/O error' })).toBe(true);
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

  describe('isAlreadyOpenWithoutMultiprocessWal (BL-512 follow-on)', () => {
    it('matches the live driver refusal text verbatim (open-handshake race)', () => {
      expect(
        isAlreadyOpenWithoutMultiprocessWal({
          code: 'GenericFailure',
          message:
            "Locking error: Failed opening database '/tmp/backlog.db'. Database is already open " +
              'without experimental multiprocess WAL in another process',
        }),
      ).toBe(true);
    });

    it('matches case-insensitively', () => {
      expect(
        isAlreadyOpenWithoutMultiprocessWal({
          code: 'GenericFailure',
          message: 'Database is ALREADY OPEN WITHOUT EXPERIMENTAL MULTIPROCESS WAL in another process',
        }),
      ).toBe(true);
    });

    it('does NOT match a busy/lock contention message (isBusyError class) — the retry is a scalpel', () => {
      expect(
        isAlreadyOpenWithoutMultiprocessWal({ code: 'GenericFailure', message: 'database is locked' }),
      ).toBe(false);
      expect(
        isAlreadyOpenWithoutMultiprocessWal({
          code: 'GenericFailure',
          message: 'step failed: database table is locked',
        }),
      ).toBe(false);
    });

    it('does NOT match a better-sqlite3 SqliteError shape — the SQLite adapter never produces this class', () => {
      expect(
        isAlreadyOpenWithoutMultiprocessWal({
          code: 'SQLITE_CANTOPEN',
          message: 'unable to open database file',
        }),
      ).toBe(false);
      expect(
        isAlreadyOpenWithoutMultiprocessWal({ code: 'SQLITE_BUSY', message: 'database is locked' }),
      ).toBe(false);
    });

    it('does NOT match a stale-WAL-sidecar open failure (BL-373 class stays on its own path)', () => {
      expect(
        isAlreadyOpenWithoutMultiprocessWal({
          code: 'GenericFailure',
          message:
            'I/O error: short read on WAL frame at offset 4152: expected 4096 bytes, got 0',
        }),
      ).toBe(false);
    });

    it('returns false for non-error-shaped input', () => {
      expect(isAlreadyOpenWithoutMultiprocessWal(null)).toBe(false);
      expect(isAlreadyOpenWithoutMultiprocessWal(undefined)).toBe(false);
      expect(isAlreadyOpenWithoutMultiprocessWal('plain string')).toBe(false);
      expect(isAlreadyOpenWithoutMultiprocessWal(new Error('no code property'))).toBe(false);
    });
  });

  describe('isTshmCoordinationInitRace (BL-TSHM-INIT-RACE)', () => {
    it('matches the "magic mismatch" variant verbatim', () => {
      expect(
        isTshmCoordinationInitRace({
          code: 'GenericFailure',
          message:
            "failed to open database '/tmp/store.db': Corrupt database: shared WAL " +
              'coordination map magic mismatch',
        }),
      ).toBe(true);
    });

    it('matches the "smaller than the coordination header" variant verbatim', () => {
      expect(
        isTshmCoordinationInitRace({
          code: 'GenericFailure',
          message:
            "failed to open database '/tmp/store.db': Corrupt database: shared WAL " +
              'coordination file is smaller than the coordination header: got 0, minimum 4096',
        }),
      ).toBe(true);
    });

    it('matches case-insensitively', () => {
      expect(
        isTshmCoordinationInitRace({
          code: 'GenericFailure',
          message: 'CORRUPT DATABASE: SHARED WAL COORDINATION MAP MAGIC MISMATCH',
        }),
      ).toBe(true);
    });

    it('does NOT match a genuinely different "Corrupt database" message — never a generic retry-any-corruption net', () => {
      expect(
        isTshmCoordinationInitRace({
          code: 'GenericFailure',
          message: 'Corrupt database: page 42 has an invalid page type: 0',
        }),
      ).toBe(false);
    });

    it('does NOT match the multiprocess-WAL open-handshake race (its own scalpel, own retry path)', () => {
      expect(
        isTshmCoordinationInitRace({
          code: 'GenericFailure',
          message:
            'Database is already open without experimental multiprocess WAL in another process',
        }),
      ).toBe(false);
    });

    it('does NOT match a stale-WAL-sidecar-after-TRUNCATE failure (BUG-STOREADAPTER-ADAPTER-NOT-ENGINE-FIASCO-RECORD-001 stays on its own path)', () => {
      expect(
        isTshmCoordinationInitRace({
          code: 'GenericFailure',
          message: 'I/O error: short read on WAL frame at offset 2101232: expected 4096 bytes, got 0',
        }),
      ).toBe(false);
    });

    it('does NOT match a busy/lock contention message', () => {
      expect(isTshmCoordinationInitRace({ code: 'GenericFailure', message: 'database is locked' })).toBe(
        false,
      );
    });

    it('returns false for non-error-shaped input', () => {
      expect(isTshmCoordinationInitRace(null)).toBe(false);
      expect(isTshmCoordinationInitRace(undefined)).toBe(false);
      expect(isTshmCoordinationInitRace('plain string')).toBe(false);
      expect(isTshmCoordinationInitRace(new Error('no code property'))).toBe(false);
    });
  });
});
