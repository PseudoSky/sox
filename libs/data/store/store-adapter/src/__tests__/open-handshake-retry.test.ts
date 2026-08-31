/**
 * (BL-512 follow-on) Bounded connect-level retry for the Turso driver's own
 * open-handshake race.
 *
 * Empirically (2026-08-12, @tursodatabase/database 0.7.1, raw-driver control
 * under barrier-synced maximal simultaneous opens) the residual concurrent-
 * writer failure — "Database is already open without experimental multiprocess
 * WAL in another process" — is the driver's OWN transient open-handshake race:
 * the engine classifies an in-progress sibling multiprocess open as a legacy
 * opener and refuses the connect with a HARD error (not busy, so the driver's
 * busy timeout cannot absorb it). The adapter's connect previously had no
 * retry for this class, and `isBusyError`/`isConcurrentConflict` deliberately
 * do not match it — so the residual 2/20 live failure (18/20 concurrent
 * writers) was unrecoverable at the adapter layer.
 *
 * The fix (architect-decision verdict ses_00b0bb304ffeum9pQUrTYHNXo0,
 * adopt-retry): `TursoAdapterImpl.connect()`'s `openOnce` retries the driver
 * `connect()` up to 3 total attempts (1 initial + 2 retries — ADR-0012 §4's
 * ceiling, the same 3 the transaction and write-queue loops use) with linear
 * 100ms → 200ms backoff, retrying ONLY when the thrown error matches the
 * exact-text predicate `isAlreadyOpenWithoutMultiprocessWal` — a scalpel,
 * never a net. Exhaustion surfaces the ORIGINAL driver error with
 * `retryable: true` (the caller decides beyond the adapter's bound); any other
 * open failure propagates immediately. No config toggle (ADR-0013).
 *
 * RED→GREEN discipline (BL-225): with the retry loop removed from
 * `openOnce`, the "retries and succeeds on the second attempt" and "bounded
 * to 3 attempts" tests fail deterministically (connect rejects after exactly
 * ONE driver call, no `retryable` marker on exhaustion); with it restored
 * they pass. The "different error text is never retried" and "SQLite adapter
 * never retries" tests verify the GUARD, not a no-op — they must pass on
 * both sides of the fix.
 *
 * ADR-0012 §5 (both adapters): the SQLite adapter cannot produce this error
 * class (better-sqlite3 opens are synchronous and never emit it), so the
 * SQLite leg of this suite proves a real better-sqlite3 open failure
 * propagates immediately — raw, unmarked, unre-tried.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { SqliteAdapterImpl } from '../sqlite-adapter.js';
import { isAlreadyOpenWithoutMultiprocessWal } from '../errors.js';

// ── Driver mock ──────────────────────────────────────────────────────────────
//
// `TursoAdapterImpl.connect()` dynamically imports '@tursodatabase/database'
// and destructures `connect` from it. Mock the module so the retry loop can be
// driven with synthetic open failures — no real driver, no real files. The
// `mockDriverConnect` vi.fn() is referenced by the hoisted `vi.mock` factory
// (the `mock` prefix is what vitest's hoisting transform permits).
const mockDriverConnect = vi.fn();

vi.mock('@tursodatabase/database', () => ({
  connect: (...args: unknown[]) => {
    // (BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001) Mimic the REAL driver:
    // a writable local open creates the -tshm coordinator sidecar — the
    // filesystem proof the multiprocess-WAL mandate is live. The adapter's
    // post-open verification polls for it; without this the mock falsely
    // trips E_WAL_MODE_UNVERIFIED.
    const url = args[0];
    if (typeof url === 'string' && !url.includes('://')) {
      writeFileSync(url + '-tshm', '');
    }
    return mockDriverConnect(...args);
  },
}));

/** A driver handle shaped like @tursodatabase/database's Database that
 *  satisfies the post-open connect ceremony (recursive-CTE probe, engine
 *  marker, adapter-meta stamps, open-time integrity — all of which treat the
 *  handle as opaque and tolerate empty reads). */
function makeFakeDb(): any {
  return {
    run: async () => ({ changes: 1, lastInsertRowid: 1 }),
    get: async () => null,
    all: async () => [],
    exec: async () => undefined,
    close: async () => undefined,
    pragma: async () => [],
  };
}

/** The exact driver refusal text from the live 2026-08-12 incident, shaped
 *  like the real `LibsqlError` — `code: 'GenericFailure'` on every error
 *  (@tursodatabase/database@0.7.1), message carries the discriminating text. */
function openHandshakeError(dbPath: string): Error {
  return Object.assign(
    new Error(
      `Locking error: Failed opening database '${dbPath}'. Database is already open without ` +
        'experimental multiprocess WAL in another process',
    ),
    { code: 'GenericFailure' },
  );
}

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-open-retry-'));
});

beforeEach(() => {
  mockDriverConnect.mockReset();
});

const openAdapters: TursoAdapterImpl[] = [];

async function connect(dbPath: string): Promise<TursoAdapterImpl> {
  const adapter = await TursoAdapterImpl.connect({ dbPath });
  openAdapters.push(adapter);
  // (DEBT-003, lazy-connect) `TursoAdapterImpl.connect()` no longer opens the
  // mocked driver eagerly — the open-handshake retry loop this whole file
  // pins now runs on the first real operation, via `_ensureHealthy()` →
  // `_reconnect()` → `_openReal()`. Force it here so every existing
  // `mockDriverConnect` call-count/timing/error assertion still observes the
  // real open sequence, and a rejection propagates exactly as a rejecting
  // `connect()` used to.
  await adapter.executeGet('SELECT 1');
  return adapter;
}

afterEach(async () => {
  while (openAdapters.length > 0) {
    const a = openAdapters.pop()!;
    try {
      await a.close();
    } catch {
      // already closed / best-effort on the fake handle
    }
  }
});

function tempPath(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpDir, `${label}-${suffix}.db`);
}

describe('TursoAdapterImpl.connect — bounded open-handshake retry (BL-512 follow-on)', () => {
  it('baseline: a clean driver open connects once and the ceremony survives the mocked handle', async () => {
    mockDriverConnect.mockResolvedValue(makeFakeDb());
    const adapter = await connect(tempPath('baseline'));
    expect(mockDriverConnect).toHaveBeenCalledTimes(1);
    expect(adapter).toBeInstanceOf(TursoAdapterImpl);
  });

  it('(a) retries the open-handshake race and succeeds on the second attempt, honoring the 100ms backoff', async () => {
    const dbPath = tempPath('retry-success');
    mockDriverConnect
      .mockRejectedValueOnce(openHandshakeError(dbPath))
      .mockResolvedValueOnce(makeFakeDb());

    const t0 = Date.now();
    const adapter = await connect(dbPath);
    const elapsed = Date.now() - t0;

    expect(mockDriverConnect).toHaveBeenCalledTimes(2);
    expect(adapter).toBeInstanceOf(TursoAdapterImpl);
    // (d) backoff: exactly one linear backoff (100ms) between attempts.
    expect(elapsed).toBeGreaterThanOrEqual(100);
  });

  it('(b) bounds retries to 3 total attempts and surfaces the original error with retryable: true on exhaustion', async () => {
    const dbPath = tempPath('retry-exhaust');
    const original = openHandshakeError(dbPath);
    mockDriverConnect.mockRejectedValue(original);

    const t0 = Date.now();
    let thrown: unknown;
    try {
      await connect(dbPath);
    } catch (err) {
      thrown = err;
    }
    const elapsed = Date.now() - t0;

    expect(mockDriverConnect).toHaveBeenCalledTimes(3);
    expect(thrown).toBeDefined();
    // The ORIGINAL driver error, not a wrapper — with retryable: true so the
    // CALLER decides beyond the adapter's bound (ADR-0012 §4). Never silent.
    expect((thrown as { retryable?: boolean }).retryable).toBe(true);
    expect(thrown instanceof Error && (thrown as Error).message).toBe(original.message);
    // (d) backoff: two linear backoffs (100ms + 200ms) across the 3 attempts.
    expect(elapsed).toBeGreaterThanOrEqual(300);
  });

  it('(c) a DIFFERENT error text is never retried — propagates immediately, unchanged, unmarked', async () => {
    const dbPath = tempPath('retry-different');
    // SAME driver error shape (`code: 'GenericFailure'`) but a different
    // message — proves the text is the discriminator, not the code.
    const different = Object.assign(new Error('unable to open database file'), {
      code: 'GenericFailure',
    });
    mockDriverConnect.mockRejectedValue(different);

    const t0 = Date.now();
    let thrown: unknown;
    try {
      await connect(dbPath);
    } catch (err) {
      thrown = err;
    }
    const elapsed = Date.now() - t0;

    expect(mockDriverConnect).toHaveBeenCalledTimes(1);
    expect(thrown).toBe(different); // the original error object, identity-preserved
    expect((thrown as { retryable?: boolean }).retryable).toBeUndefined();
    // No backoff was awaited — the failure propagated on the first attempt.
    expect(elapsed).toBeLessThan(100);
  });
});

describe('SqliteAdapterImpl — the SQLite adapter never retries (BL-512 follow-on guard)', () => {
  it('a real better-sqlite3 open failure propagates synchronously, raw and unmarked (verifies the guard, not a no-op)', () => {
    // better-sqlite3 cannot create a database under a missing parent
    // directory — this is a genuine open failure, not a shape coincidence.
    const badPath = join(tmpDir, 'no-such-dir', 'x.db');

    let thrown: unknown;
    try {
      new SqliteAdapterImpl(badPath);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    // The raw better-sqlite3 failure surfaces verbatim (native binding text —
    // "Cannot open database because the directory does not exist" on
    // better-sqlite3 12.x for a missing parent directory; "unable to open
    // database file" is the same class on other versions).
    expect(
      thrown instanceof Error &&
        /cannot open database|unable to open database/i.test((thrown as Error).message),
    ).toBe(true);
    // The guard: a real better-sqlite3 SqliteError never matches the Turso
    // open-handshake predicate — there is no retry loop on this path and the
    // raw driver error is what surfaces, with no `retryable` marker.
    expect(isAlreadyOpenWithoutMultiprocessWal(thrown)).toBe(false);
    expect((thrown as { retryable?: boolean }).retryable).toBeUndefined();
  });
});
