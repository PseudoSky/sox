/**
 * errors-turso.spec.ts — Turso-mode sibling of errors.spec.ts (BUG-MEMORY-001 §2.2).
 *
 * errors.spec.ts pins `process.env.STORE_ADAPTER = 'sqlite'` explicitly, with a
 * comment acknowledging the live default is now Turso — i.e. the ONLY existing
 * regression coverage for the entire storage error taxonomy deliberately opted
 * OUT of the backend production actually uses. `wrapDbError`'s classification was
 * never once run, in any test, against the backend the live service takes.
 *
 * This is the sibling test that should have existed the day the default flipped
 * (docs/decisions/0012-….md §5). No real Turso lock-contention harness exists
 * (unlike the SQLite test's `BEGIN EXCLUSIVE` second-connection trick), so this
 * uses a synthetic fixture instead — the same pattern already established in
 * store-adapter's errors.spec.ts: call `wrapDbError` directly against a literal
 * `{code:'GenericFailure', message:'…'}` object shaped exactly like what the real
 * `@tursodatabase/database@0.7.1` driver emits.
 *
 * AC4's RED arm: run this file against PRE-fix `wrapDbError` (before §2.1/§2.2
 * land) and confirm every assertion below fails — the pre-fix classifier hits its
 * generic `E_IO`/`retryable:false` fallback tier for every one of these, because
 * `isSqliteError`/the SQLITE_*-prefix switch never matches `GenericFailure`.
 * Post-fix, all pass.
 */
import { describe, it, expect } from 'vitest';
import { wrapDbError } from './errors.js';

describe('wrapDbError — Turso GenericFailure classification (BUG-MEMORY-001 §2.2, AC4)', () => {
  it('the literal BUG-MEMORY-001 incident text ("database is locked", no phase prefix) → E_BUSY, retryable', () => {
    const wrapped = wrapDbError({ code: 'GenericFailure', message: 'database is locked' });
    expect(wrapped).toEqual({
      code: 'E_BUSY',
      message: 'database is locked',
      retryable: true,
      retry_after_ms: 250,
    });
  });

  it('a phase-prefixed Turso busy message → E_BUSY, retryable', () => {
    const wrapped = wrapDbError({
      code: 'GenericFailure',
      message: 'step failed: database table is locked',
    });
    expect(wrapped.code).toBe('E_BUSY');
    expect(wrapped.retryable).toBe(true);
    expect(wrapped.retry_after_ms).toBe(250);
  });

  it('a real captured Turso UNIQUE-constraint violation → E_DEDUP, not retryable', () => {
    const wrapped = wrapDbError({
      code: 'GenericFailure',
      message: 'step failed: Runtime error: UNIQUE constraint failed: t.name (19)',
    });
    expect(wrapped.code).toBe('E_DEDUP');
    expect(wrapped.retryable).toBe(false);
  });

  it('a Turso FOREIGN KEY-constraint violation classifies as a database error, not busy/fatal', () => {
    const wrapped = wrapDbError({
      code: 'GenericFailure',
      message: 'step failed: Runtime error: FOREIGN KEY constraint failed',
    });
    // Not a dedup case (isUniqueConstraintError doesn't match FK text) — falls
    // to the generic driver-originated E_IO tier inside the isDatabaseError branch.
    expect(wrapped.code).toBe('E_IO');
    expect(wrapped.retryable).toBe(false);
  });

  it('a Turso I/O connection-fatal fault → E_IO, not retryable (adapter recycles the connection itself)', () => {
    const wrapped = wrapDbError({
      code: 'GenericFailure',
      message: 'reset failed: I/O error: short read on WAL frame at offset 4152: expected 4096 bytes, got 0',
    });
    expect(wrapped.code).toBe('E_IO');
    expect(wrapped.retryable).toBe(false);
  });

  it('a malformed-disk-image Turso fault → E_IO, not retryable', () => {
    const wrapped = wrapDbError({ code: 'GenericFailure', message: 'database disk image is malformed' });
    expect(wrapped.code).toBe('E_IO');
    expect(wrapped.retryable).toBe(false);
  });

  it('a benign GenericFailure with no recognized marker → generic E_IO fallback, message preserved', () => {
    const wrapped = wrapDbError({ code: 'GenericFailure', message: 'datatype mismatch' });
    expect(wrapped.code).toBe('E_IO');
    expect(wrapped.retryable).toBe(false);
    expect(wrapped.message).toBe('datatype mismatch');
  });

  it('no raw GenericFailure/code text leaks into the wrapped shape\'s own field names', () => {
    const wrapped = wrapDbError({ code: 'GenericFailure', message: 'database is locked' });
    const keys = Object.keys(wrapped).sort();
    expect(keys).toEqual(['code', 'message', 'retry_after_ms', 'retryable'].sort());
  });
});
