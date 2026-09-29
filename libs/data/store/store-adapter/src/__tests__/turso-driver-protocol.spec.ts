/**
 * turso-driver-protocol.spec.ts — unit spec for the off-thread driver
 * marshalling primitives (packet TUR-A, plan `862129b5`).
 *
 * The decisive case is the PREDICATE PARITY test: an error raised in the worker
 * realm must, after `serializeDriverError` → `reviveDriverError`, be classified
 * by `store-adapter/src/errors.ts` EXACTLY as the native in-thread error is
 * (ADR-0012 §5). If a future edit to the serialization loses `code`/`name`, the
 * adapter would start classifying a worker error differently from a native one
 * — the precise silent-parity failure this plan exists to prevent.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  TURSO_DRIVER_PROTOCOL_VERSION,
  serializeDriverError,
  reviveDriverError,
  reviveBuffers,
  assertCloneableOpts,
  type DriverRequest,
  type DriverResponse,
} from '../turso-driver-protocol.js';
import {
  isUniqueConstraintError,
  isForeignKeyError,
  isBusyError,
  isConcurrentConflict,
  isDatabaseError,
  isFatalConnectionError,
  isAlreadyOpenWithoutMultiprocessWal,
  isTshmCoordinationInitRace,
  dbErrorCode,
} from '../errors.js';

type RevivedError = Error & { code?: string; rawCode?: unknown };

/** A native driver error with the real `LibsqlError` shape (name + code). */
function nativeLibsqlError(
  message: string,
  opts?: { code?: string; rawCode?: unknown },
): Error {
  const err = new Error(message);
  err.name = 'LibsqlError';
  const carrier = err as RevivedError;
  if (opts?.code !== undefined) carrier.code = opts.code;
  if (opts?.rawCode !== undefined) carrier.rawCode = opts.rawCode;
  return err;
}

/** Every `errors.ts` predicate the adapter uses to classify a driver error. */
const PREDICATES = [
  ['isUniqueConstraintError', isUniqueConstraintError],
  ['isForeignKeyError', isForeignKeyError],
  ['isBusyError', isBusyError],
  ['isConcurrentConflict', isConcurrentConflict],
  ['isDatabaseError', isDatabaseError],
  ['isFatalConnectionError', isFatalConnectionError],
  ['isAlreadyOpenWithoutMultiprocessWal', isAlreadyOpenWithoutMultiprocessWal],
  ['isTshmCoordinationInitRace', isTshmCoordinationInitRace],
] as const;

describe('turso-driver-protocol — envelope shape', () => {
  it('exposes protocol version 1 and the discriminated request/response unions', () => {
    expect(TURSO_DRIVER_PROTOCOL_VERSION).toBe(1);

    const open: DriverRequest = { kind: 'open', id: 1, connId: 7, url: 'file:/tmp/x.db', opts: {} };
    const call: DriverRequest = {
      kind: 'call',
      id: 2,
      connId: 7,
      method: 'get',
      sql: 'SELECT 1',
      args: [],
      label: 'probe',
    };
    const close: DriverRequest = { kind: 'close', id: 3, connId: 7 };
    const ok: DriverResponse = { kind: 'ok', id: 2, value: [{ one: 1 }] };
    const err: DriverResponse = { kind: 'err', id: 2, error: serializeDriverError(new Error('x')) };
    const ready: DriverResponse = { kind: 'ready', protocol: TURSO_DRIVER_PROTOCOL_VERSION };

    expect([open.kind, call.kind, close.kind]).toEqual(['open', 'call', 'close']);
    expect([ok.kind, err.kind, ready.kind]).toEqual(['ok', 'err', 'ready']);
    expect(ok.kind === 'ok' && ok.value).toEqual([{ one: 1 }]);
  });
});

describe('module purity (acceptance criteria 1 & 5)', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../turso-driver-protocol.ts', import.meta.url)),
    'utf8',
  );

  it('is a pure module: no worker_threads, no telemetry, no @tursodatabase/database', () => {
    // Scan import SPECIFIERS, not raw text — the module's own header doc
    // deliberately names the three forbidden modules to explain why they are
    // excluded, and a raw substring scan would flag its own documentation.
    const specifiers = [
      ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
      ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((m) => m[1]!);

    for (const spec of specifiers) {
      expect(spec).not.toMatch(/worker_threads/);
      expect(spec).not.toMatch(/@adhd\/sox-telemetry/);
      expect(spec).not.toMatch(/@tursodatabase\/database/);
    }
    // Every import is a Node builtin; no `require()` escape hatch either.
    expect(specifiers.every((s) => s.startsWith('node:'))).toBe(true);
    expect(source).not.toMatch(/\brequire\s*\(/);
  });

  it('contains no empty catch blocks', () => {
    expect(source).not.toMatch(/catch\s*(?:\([^)]*\))?\s*\{\s*\}/);
  });
});

describe('serializeDriverError / reviveDriverError', () => {
  it('round-trips name + message + code', () => {
    const native = nativeLibsqlError('step failed: Runtime error: UNIQUE constraint failed: t.name (19)', {
      code: 'GenericFailure',
    });
    const revived = reviveDriverError(serializeDriverError(native)) as RevivedError;

    expect(revived).toBeInstanceOf(Error);
    expect(revived.name).toBe('LibsqlError');
    expect(revived.message).toBe(native.message);
    expect(revived.code).toBe('GenericFailure');
  });

  it('restores rawCode and appends the main-thread call-site stack after the worker stack', () => {
    const native = nativeLibsqlError('step failed: Runtime error: UNIQUE constraint failed: t.name (19)', {
      code: 'GenericFailure',
      rawCode: 2067,
    });
    const serialized = serializeDriverError(native);
    expect(serialized.rawCode).toBe(2067);

    const callSite = 'Error: at TursoDriverConnection.run (/main-thread.ts:10:5)';
    const revived = reviveDriverError(serialized, callSite) as RevivedError;

    expect(revived.rawCode).toBe(2067);
    // Worker-realm stack first, main-thread call-site appended after it.
    expect(revived.stack).toContain('LibsqlError');
    expect(revived.stack).toContain('/main-thread.ts:10:5');
    expect(revived.stack!.indexOf('LibsqlError')).toBeLessThan(revived.stack!.indexOf('/main-thread.ts'));
  });

  it('serializes a non-Error thrown value without losing the message', () => {
    const serialized = serializeDriverError('kaboom');
    expect(serialized.name).toBe('Error');
    expect(serialized.message).toBe('kaboom');

    const revived = reviveDriverError(serialized);
    expect(revived).toBeInstanceOf(Error);
    expect(revived.message).toBe('kaboom');
  });

  it('never throws for a hostile value and still names the throwable kind', () => {
    const hostile = {
      name: 'Weird',
      get message(): string {
        throw new Error('getter exploded');
      },
    };
    expect(() => serializeDriverError(hostile)).not.toThrow();
    const serialized = serializeDriverError(hostile);
    expect(serialized.name).toBe('Weird');
    expect(typeof serialized.message).toBe('string');
  });

  /**
   * ADR-0012 §5 — the adapter must classify a REVIVED error identically to the
   * native one. Each row mirrors real driver text captured in `errors.spec.ts`.
   */
  describe('predicate parity (ADR-0012 §5)', () => {
    const cases = [
      {
        label: 'UNIQUE violation',
        message: 'step failed: Runtime error: UNIQUE constraint failed: t.name (19)',
        code: 'GenericFailure',
      },
      {
        label: 'FOREIGN KEY violation',
        message: 'step failed: Runtime error: FOREIGN KEY constraint failed',
        code: 'GenericFailure',
      },
      { label: 'busy/locked', message: 'database is locked', code: 'GenericFailure' },
      {
        label: 'fatal I/O',
        message: 'step failed: I/O error: short read on WAL frame -- got 0',
        code: 'GenericFailure',
      },
      {
        label: 'multiprocess-WAL open race',
        message:
          "Locking error: Failed opening database '/tmp/x.db'. Database is already open without " +
          'experimental multiprocess WAL in another process',
        code: 'GenericFailure',
      },
      {
        label: '-tshm init race',
        message: 'failed to open database /tmp/x.db: Corrupt database: shared WAL coordination map magic mismatch',
        code: 'GenericFailure',
      },
      { label: 'benign GenericFailure', message: 'datatype mismatch', code: 'GenericFailure' },
      { label: 'SQLITE_BUSY code', message: 'database is locked', code: 'SQLITE_BUSY' },
    ];

    for (const c of cases) {
      it(`revived ${c.label} classifies identically to the native driver error`, () => {
        const native = nativeLibsqlError(c.message, { code: c.code });
        const revived = reviveDriverError(serializeDriverError(native)) as RevivedError;

        for (const [name, predicate] of PREDICATES) {
          expect(predicate(revived), `${name} parity for "${c.label}"`).toBe(predicate(native));
        }
        expect(dbErrorCode(revived)).toBe(dbErrorCode(native));
      });
    }

    it('keeps the oracle non-trivial: exact verdicts for representative driver errors', () => {
      const unique = nativeLibsqlError(
        'step failed: Runtime error: UNIQUE constraint failed: t.name (19)',
        { code: 'GenericFailure' },
      );
      const revivedUnique = reviveDriverError(serializeDriverError(unique));
      expect(isUniqueConstraintError(revivedUnique)).toBe(true);
      expect(isDatabaseError(revivedUnique)).toBe(true);
      expect(isBusyError(revivedUnique)).toBe(false);

      const busy = nativeLibsqlError('database is locked', { code: 'GenericFailure' });
      const revivedBusy = reviveDriverError(serializeDriverError(busy));
      expect(isBusyError(revivedBusy)).toBe(true);
      expect(isConcurrentConflict(revivedBusy)).toBe(true);
      // A phase-less GenericFailure is a DB error but not locked-busy-unique.
      expect(isUniqueConstraintError(revivedBusy)).toBe(false);

      const fatal = nativeLibsqlError('step failed: I/O error: disk fault', { code: 'GenericFailure' });
      expect(isFatalConnectionError(reviveDriverError(serializeDriverError(fatal)))).toBe(true);
    });
  });
});

describe('reviveBuffers', () => {
  it('maps a non-Buffer Uint8Array to a zero-copy Buffer', () => {
    const blob = new TextEncoder().encode('hello');
    const revived = reviveBuffers(blob);

    expect(Buffer.isBuffer(revived)).toBe(true);
    // Zero-copy: the Buffer shares the clone's backing ArrayBuffer...
    expect(revived.buffer).toBe(blob.buffer);
    // ...proven by a write through the Buffer being visible on the original view.
    revived[0] = 0x41; // 'A'
    expect(blob[0]).toBe(0x41);
  });

  it('recurses a nested row with a blob and preserves a bigint lastInsertRowid', () => {
    const blob = new TextEncoder().encode('blob-bytes');
    const row = {
      id: 1,
      data: blob,
      nested: { deeper: [blob] },
      lastInsertRowid: 9007199254740993n, // > Number.MAX_SAFE_INTEGER
    };

    const revived = reviveBuffers(row);

    expect(Buffer.isBuffer(revived.data)).toBe(true);
    expect(revived.data.buffer).toBe(blob.buffer);
    expect(Buffer.isBuffer(revived.nested.deeper[0])).toBe(true);
    expect(revived.nested.deeper[0]!.buffer).toBe(blob.buffer);

    // bigint survives untouched — not coerced to a lossy Number.
    expect(typeof revived.lastInsertRowid).toBe('bigint');
    expect(revived.lastInsertRowid).toBe(9007199254740993n);
  });

  it('leaves an already-Buffer value by identity and passes primitives through', () => {
    const buf = Buffer.from([1, 2, 3]);
    expect(reviveBuffers(buf)).toBe(buf);
    expect(reviveBuffers(null)).toBeNull();
    expect(reviveBuffers(7n)).toBe(7n);
    expect(reviveBuffers('str')).toBe('str');
    expect(reviveBuffers(undefined)).toBeUndefined();
  });

  it('revives Uint8Arrays inside result arrays and leaves Date instances untouched', () => {
    const blob = new Uint8Array([9, 8, 7]);
    const when = new Date(0);

    const revivedRow = reviveBuffers({ blob });
    const revivedArr = reviveBuffers([blob]);
    const revivedDate = reviveBuffers(when);

    expect(Buffer.isBuffer(revivedRow.blob)).toBe(true);
    expect(revivedRow.blob.buffer).toBe(blob.buffer);
    expect(Buffer.isBuffer(revivedArr[0])).toBe(true);
    expect(revivedDate).toBe(when);
  });

  it('does not recurse into Map/Set (non-row data stays as-is)', () => {
    const m = new Map([['k', new Uint8Array([1])]]);
    expect(reviveBuffers(m)).toBe(m);
  });
});

describe('assertCloneableOpts', () => {
  it('throws an error whose message names the offending key for a function value', () => {
    expect(() => assertCloneableOpts({ path: '/tmp/x.db', onOpStart: (): void => {} })).toThrowError(
      /onOpStart/,
    );
  });

  it('names the offending key for a symbol value', () => {
    expect(() => assertCloneableOpts({ readOnly: Symbol('ro') })).toThrowError(/readOnly/);
  });

  it('names the full path for a nested function option', () => {
    expect(() => assertCloneableOpts({ wal: { onCheckpoint: (): void => {} } })).toThrowError(
      /wal\.onCheckpoint/,
    );
  });

  it('names the index for a function inside an array option', () => {
    expect(() => assertCloneableOpts({ hooks: [1, (): void => {}, 3] })).toThrowError(/hooks\[1\]/);
  });

  it('is a no-op for plain serializable options (including bigint, Buffer, Date, nested arrays)', () => {
    expect(() =>
      assertCloneableOpts({
        path: '/tmp/x.db',
        readOnly: true,
        timeoutMs: 5000,
        retryAfter: 9007199254740993n,
        flags: ['a', 'b'],
        nested: { mode: 'wal', counts: [1, 2, 3] },
        blob: new Uint8Array([1, 2, 3]),
        buf: Buffer.from([4, 5]),
        when: new Date(0),
        nothing: null,
        missing: undefined,
      }),
    ).not.toThrow();
  });

  it('is cycle-safe (does not hang or overflow on a self-referential option)', () => {
    const opts: Record<string, unknown> = { name: 'ok' };
    opts.self = opts;
    expect(() => assertCloneableOpts(opts)).not.toThrow();
  });
});
