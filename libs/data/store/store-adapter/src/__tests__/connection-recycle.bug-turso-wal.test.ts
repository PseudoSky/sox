/**
 * BUG-TURSO-WAL-SHORTREAD-WEDGES-BACKEND-001 — connection recycling.
 *
 * `TursoAdapterImpl` holds one shared native connection (`this.db`) for the
 * process lifetime. Before SPEC-CONN-RECYCLE, no query method ever noticed
 * when the driver reported a fatal, connection-level fault (e.g. the
 * incident's own `I/O error: short read on WAL frame …`) — the same poisoned
 * handle kept being handed to every subsequent caller, including reads that
 * shared no state with the call that failed. Recovery required killing the
 * process. See SPEC-CONN-RECYCLE.md for the full root-cause writeup and the
 * ruling behind each design decision below.
 *
 * Fault injection: every AC below monkey-patches methods on the object
 * `adapter.unwrap()` returns — the SAME object reference `this.db` holds
 * internally (see `unwrap()`'s doc comment), so no new production test-hooks
 * are required to exercise the exact call path a real fault would take.
 *
 * Data-destructive risk: none. Every store used here is a fresh
 * `mkdtempSync` temp file, never `~/.memory/*`.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { isFatalConnectionError } from '../errors.js';

const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();

const tursoDescribe = hasTurso ? describe : describe.skip;

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-conn-recycle-'));
});

function tempPath(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpDir, `${label}-${suffix}.db`);
}

const openAdapters: TursoAdapterImpl[] = [];

async function connect(dbPath: string): Promise<TursoAdapterImpl> {
  const adapter = await TursoAdapterImpl.connect({ dbPath });
  openAdapters.push(adapter);
  return adapter;
}

afterEach(async () => {
  while (openAdapters.length > 0) {
    const a = openAdapters.pop()!;
    try {
      await a.close();
    } catch {
      // already closed / reconnect left a stale handle we don't own anymore
    }
  }
});

/** The incident's own text, verbatim, from the BL item body. */
const FATAL_IO_ERROR = {
  code: 'GenericFailure',
  message: 'reset failed: I/O error: short read on WAL frame at offset 4152: expected 4096 bytes, got 0',
};

/** Makes `fabricated` reject the way the real driver's native errors are
 *  shaped: an Error instance carrying a `.code`, so `isErrorWithCode` (and
 *  therefore `isFatalConnectionError`) sees it correctly. */
function fatalError(): Error & { code: string } {
  return Object.assign(new Error(FATAL_IO_ERROR.message), { code: FATAL_IO_ERROR.code });
}

tursoDescribe('TursoAdapterImpl — connection recycling (BUG-TURSO-WAL-SHORTREAD-WEDGES-BACKEND-001)', () => {
  it('AC-1: a fatal fault does not wedge a later unrelated read', async () => {
    const dbPath = tempPath('ac1');
    const adapter = await connect(dbPath);
    await adapter.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    await adapter.executeRun('INSERT INTO t (name) VALUES (?)', ['a']);

    const rawBefore = adapter.unwrap() as unknown as {
      all: (...args: unknown[]) => Promise<unknown>;
      get: (...args: unknown[]) => Promise<unknown>;
      run: (...args: unknown[]) => Promise<unknown>;
      exec: (...args: unknown[]) => Promise<unknown>;
    };

    // Sharpened fault injection (per SPEC-CONN-RECYCLE AC-1 RED-arm note):
    // the incident showed EVERY operation on the poisoned connection fails,
    // not just the one the drain happened to issue — patch all four so the
    // test is unambiguous on `main` (only patching `.all` would leave `.get`
    // working by accident, since it's a different db method).
    let allCalls = 0;
    let getCalls = 0;
    let runCalls = 0;
    let execCalls = 0;
    const realAll = rawBefore.all.bind(rawBefore);
    const realGet = rawBefore.get.bind(rawBefore);
    const realRun = rawBefore.run.bind(rawBefore);
    const realExec = rawBefore.exec.bind(rawBefore);
    rawBefore.all = async (...args: unknown[]) => {
      allCalls++;
      if (allCalls === 1) throw fatalError();
      return realAll(...args);
    };
    rawBefore.get = async (...args: unknown[]) => {
      getCalls++;
      if (getCalls === 1) throw fatalError();
      return realGet(...args);
    };
    rawBefore.run = async (...args: unknown[]) => {
      runCalls++;
      if (runCalls === 1) throw fatalError();
      return realRun(...args);
    };
    rawBefore.exec = async (...args: unknown[]) => {
      execCalls++;
      if (execCalls === 1) throw fatalError();
      return realExec(...args);
    };

    // Step 3: the failing call itself must reject with the exact original
    // error — the classifier must never swallow or transform it.
    await expect(adapter.executeAll('SELECT * FROM t')).rejects.toMatchObject({
      message: FATAL_IO_ERROR.message,
    });

    // Step 4: a later, unrelated read (stands in for memory_ping) resolves.
    const pingResult = await adapter.executeGet<{ x: number }>('SELECT 1 AS x');
    expect(pingResult).toEqual({ x: 1 });

    // Step 5: the handle actually changed — proves a real reconnect
    // happened, not that the same handle happened to recover. Compared as
    // a plain boolean (not `.not.toBe()`) deliberately: vitest's matcher
    // diff-renderer calls into the native driver object's own inspect path
    // on a FAILING comparison, and the stale handle here is (by design,
    // see `_reconnect()`) already closed in the background by the time this
    // line runs — inspecting a closed native handle throws `database must
    // be connected`, which would mask the real assertion failure with a
    // confusing secondary error. A boolean comparison never touches the
    // object's own inspect path.
    const reconnected = adapter.unwrap() !== rawBefore;
    expect(reconnected).toBe(true);

    // Step 6: adapter reports healthy again.
    expect(adapter.connectionHealth).toBe('healthy');
  });

  it('AC-2: a statement-local fault (UNIQUE violation) never triggers a reconnect', async () => {
    const dbPath = tempPath('ac2');
    const adapter = await connect(dbPath);
    await adapter.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE)');
    await adapter.executeRun('INSERT INTO t (name) VALUES (?)', ['dup']);

    const rawBefore = adapter.unwrap();

    // Genuine duplicate insert — no monkey-patching, let the real driver
    // raise it. This also re-confirms the §2 probe is still accurate against
    // whatever driver version is actually installed.
    await expect(adapter.executeRun('INSERT INTO t (name) VALUES (?)', ['dup'])).rejects.toThrow(
      /UNIQUE constraint failed/i,
    );

    // See AC-1's comment above on why this is a boolean compare, not
    // `.toBe()`, on the raw native handle.
    expect(adapter.unwrap() === rawBefore).toBe(true);
    expect(adapter.connectionHealth).toBe('healthy');
  });

  it('AC-2b: a statement-local fault (bad-SQL shape, monkey-patched) never triggers a reconnect', async () => {
    const dbPath = tempPath('ac2b');
    const adapter = await connect(dbPath);
    await adapter.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');

    const raw = adapter.unwrap() as unknown as {
      all: (...args: unknown[]) => Promise<unknown>;
    };
    const realAll = raw.all.bind(raw);
    let calls = 0;
    raw.all = async (...args: unknown[]) => {
      calls++;
      if (calls === 1) {
        throw Object.assign(new Error('failed to consume stmt: near "SELEKT": syntax error'), {
          code: 'GenericFailure',
        });
      }
      return realAll(...args);
    };

    const rawBefore = adapter.unwrap();
    await expect(adapter.executeAll('SELECT * FROM t')).rejects.toThrow(/syntax error/i);

    expect(adapter.unwrap() === rawBefore).toBe(true);
    expect(adapter.connectionHealth).toBe('healthy');
  });

  it('AC-3: two concurrent callers that both observe the poisoned state share exactly one reconnect', async () => {
    const dbPath = tempPath('ac3');
    const adapter = await connect(dbPath);
    await adapter.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    await adapter.executeRun('INSERT INTO t (name) VALUES (?)', ['a']);

    const raw = adapter.unwrap() as unknown as {
      all: (...args: unknown[]) => Promise<unknown>;
    };
    const realAll = raw.all.bind(raw);
    let allCalls = 0;
    raw.all = async (...args: unknown[]) => {
      allCalls++;
      if (allCalls === 1) throw fatalError();
      return realAll(...args);
    };

    // Poison the adapter with a single failing call, awaited to completion —
    // `_poisoned` is now true and no reconnect has started yet.
    await expect(adapter.executeAll('SELECT * FROM t')).rejects.toMatchObject({
      message: FATAL_IO_ERROR.message,
    });
    expect(adapter.connectionHealth).toBe('poisoned');

    // (DEBT-003, lazy-connect) `_reconnect()` now calls the private
    // `_openReal()` directly, not the public `connect()` — `connect()` is
    // the lazy entry point and replaying it would hand back a second
    // never-opened shell instead of ever actually reconnecting (see
    // `_reconnect()`'s doc comment). `_openReal()` is the one real-open
    // implementation both a genuine reconnect and the public `connect()`'s
    // eventual first-op deferral route through, so it is the correct spy
    // target for "how many real reopens happened."
    const tursoAdapterImplInternal = TursoAdapterImpl as unknown as {
      _openReal: (...args: unknown[]) => Promise<TursoAdapterImpl>;
    };
    const openRealSpy = vi.spyOn(tursoAdapterImplInternal, '_openReal');

    // Fire two concurrent calls in the SAME synchronous dispatch — both must
    // observe `_poisoned === true` and race to start a reconnect; only the
    // first should actually call `_openReal()`, the second must await the
    // same in-flight promise.
    const [a, b] = await Promise.all([
      adapter.executeGet<{ x: number }>('SELECT 1 AS x'),
      adapter.executeGet<{ x: number }>('SELECT 1 AS x'),
    ]);

    expect(a).toEqual({ x: 1 });
    expect(b).toEqual({ x: 1 });
    expect(openRealSpy).toHaveBeenCalledTimes(1);
    expect(adapter.connectionHealth).toBe('healthy');

    openRealSpy.mockRestore();
  });

  it('AC-5: pragmaSet/pragmaGet are wired into the same health/reconnect machinery as the other direct db.* call sites', async () => {
    const dbPath = tempPath('ac5');
    const adapter = await connect(dbPath);
    await adapter.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');

    const rawBefore = adapter.unwrap() as unknown as {
      exec: (...args: unknown[]) => Promise<unknown>;
      pragma: (...args: unknown[]) => Promise<unknown>;
    };
    const realExec = rawBefore.exec.bind(rawBefore);
    const realPragma = rawBefore.pragma.bind(rawBefore);
    let execCalls = 0;
    let pragmaCalls = 0;
    rawBefore.exec = async (...args: unknown[]) => {
      execCalls++;
      // Only fault the PRAGMA-shaped exec call — the CREATE TABLE above and
      // any driver housekeeping already ran through the real exec.
      if (execCalls === 1 && typeof args[0] === 'string' && (args[0] as string).startsWith('PRAGMA')) {
        throw fatalError();
      }
      return realExec(...args);
    };
    rawBefore.pragma = async (...args: unknown[]) => {
      pragmaCalls++;
      if (pragmaCalls === 1) throw fatalError();
      return realPragma(...args);
    };

    // pragmaSet: the fatal fault must reject with the original error, poison
    // the adapter, and a subsequent call must reconnect rather than
    // silently querying the dead handle.
    await expect(adapter.pragmaSet('busy_timeout', 3000)).rejects.toMatchObject({
      message: FATAL_IO_ERROR.message,
    });
    expect(adapter.connectionHealth).toBe('poisoned');

    const afterPragmaSetReconnect = await adapter.pragmaGet('busy_timeout');
    expect(afterPragmaSetReconnect).not.toBeUndefined();
    expect(adapter.unwrap() !== rawBefore).toBe(true);
    expect(adapter.connectionHealth).toBe('healthy');

    // pragmaGet on a freshly-healthy handle: fault it directly and confirm
    // the same reconnect-then-recover path fires from pragmaGet itself.
    const rawAfterFirstReconnect = adapter.unwrap() as unknown as {
      pragma: (...args: unknown[]) => Promise<unknown>;
    };
    const realPragma2 = rawAfterFirstReconnect.pragma.bind(rawAfterFirstReconnect);
    let pragmaCalls2 = 0;
    rawAfterFirstReconnect.pragma = async (...args: unknown[]) => {
      pragmaCalls2++;
      if (pragmaCalls2 === 1) throw fatalError();
      return realPragma2(...args);
    };

    await expect(adapter.pragmaGet('busy_timeout')).rejects.toMatchObject({
      message: FATAL_IO_ERROR.message,
    });
    expect(adapter.connectionHealth).toBe('poisoned');

    const value = await adapter.pragmaGet('busy_timeout');
    expect(value).not.toBeUndefined();
    expect(adapter.connectionHealth).toBe('healthy');
  });

  it('AC-4 sibling: isFatalConnectionError itself matches the incident text and rejects ordinary faults', () => {
    expect(isFatalConnectionError(fatalError())).toBe(true);
    expect(
      isFatalConnectionError({ code: 'GenericFailure', message: 'database disk image is malformed' }),
    ).toBe(true);
    expect(
      isFatalConnectionError({
        code: 'GenericFailure',
        message: 'step failed: Runtime error: UNIQUE constraint failed: t.name (19)',
      }),
    ).toBe(false);
    expect(
      isFatalConnectionError({
        code: 'GenericFailure',
        message: 'failed to consume stmt: near "SELEKT": syntax error',
      }),
    ).toBe(false);
    expect(isFatalConnectionError(new Error('no code at all'))).toBe(false);
    expect(isFatalConnectionError(null)).toBe(false);
  });
});
