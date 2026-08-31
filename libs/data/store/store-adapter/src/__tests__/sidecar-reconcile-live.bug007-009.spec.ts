/**
 * BUG-007 / BUG-009 — sidecar reconciliation and open-time recovery against a
 * LIVE store (adapter-race-fix plan §10C).
 *
 * BUG-007: the pre-open proactive reconcile (`proactivelyReconcileStaleSidecar`)
 * renames a mtime-stale `-tshm` with no regard for whether another connection
 * holds the store — under concurrency the first opener renames a LIVE store's
 * coordination sidecar and every sibling open short-reads (or fails outright).
 * BUG-009: the open-time catch classified ANY stale-WAL-index failure as
 * corruption and ran `recoverStaleWalIndex` — renaming sidecars — even when a
 * live peer existed; a transient close()-TRUNCATE race read as a corrupt store.
 *
 * The fix (plan §6c/§6d): every destructive sidecar decision is gated on
 * `storeQuiescence` (the §4 lease registry). A live peer ⇒ the reconcile is a
 * `log.debug`-only skip, and the open-time catch NEVER calls
 * `recoverStaleWalIndex`/`describeStaleWalIndexFailure` — instead it retries
 * the open with the same bounded budget as the handshake race
 * (`OPEN_RETRY_MAX_ATTEMPTS − 1` extra attempts) and, on exhaustion, surfaces
 * the ORIGINAL driver error with `retryable: true` — never the
 * `STALE WAL-INDEX SIDECAR` wrapper. Quiescent ⇒ the sidecar reconcile still
 * runs: a PRE-EXISTING deleted-WAL/orphaned-sidecar shape is reconciled by the
 * pre-open proactive site (content-deadness is the trigger, and an absent WAL
 * proves it — BUG014.T3/SPEC §T3); a WAL that empties BETWEEN the proactive
 * probe and the open (the close()-TRUNCATE / out-of-band-zero race) still
 * reaches the open-time catch's quiescent empty-WAL branch, which is
 * exercised end-to-end below.
 *
 * Harness: real fs + mocked driver. The scratch store is SEEDED with the REAL
 * `@tursodatabase/database` driver (`vi.importActual` — the `vi.mock` shim is
 * file-scoped, so the seed bypasses it), producing a genuine `-tshm` beside a
 * genuine WAL. The adapter under test opens with the driver MOCKED, so the
 * open-time catch can be driven with synthetic short-read errors while every
 * fs side effect (renames, `.stale-*` files) happens for real.
 *
 * RED→GREEN (BL-225): against the pre-fix code these fail as follows —
 * (1) the stale `-tshm` of a live store is renamed (`.stale-*` appears);
 * (2) recovery runs immediately while the peer is live — `.stale-*` appears
 *     and no retry happens (2 driver calls, not 3);
 * (3) the `STALE WAL-INDEX SIDECAR` wrapper is thrown with no `retryable`
 *     marker after ONE driver call;
 * (4) the quiescent path must keep working (guard — passes on both sides).
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { mkdtempSync, readdirSync, utimesSync, unlinkSync, statSync, existsSync, truncateSync, writeFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { acquireStoreLease } from '../store-lease.js';

const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();
const tursoDescribe = hasTurso ? describe : describe.skip;

// ── Driver mock ──────────────────────────────────────────────────────────────
const mockDriverConnect = vi.fn();

vi.mock('@tursodatabase/database', () => ({
  connect: (...args: unknown[]) => {
    // (BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001) Mimic the REAL driver:
    // a writable local open creates the -tshm coordinator sidecar — the
    // filesystem proof the multiprocess-WAL mandate is live. The adapter's
    // post-open verification polls for it; without this the mock falsely
    // trips E_WAL_MODE_UNVERIFIED. (`-tshm` is distinct from the foreign
    // `-shm` this suite reconciles, so it never perturbs those assertions.)
    const url = args[0];
    if (typeof url === 'string' && !url.includes('://')) {
      writeFileSync(url + '-tshm', '');
    }
    return mockDriverConnect(...args);
  },
}));

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

/** The exact short-read text of the BL-373 incident / BUG-009 race. */
function shortReadError(): Error {
  return Object.assign(
    new Error(
      "failed to open database: I/O error: short read on WAL frame at offset 4096: expected 4096 bytes, got 0",
    ),
    { code: 'GenericFailure' },
  );
}

interface RawDb {
  exec: (sql: string) => Promise<void>;
  run: (sql: string, ...a: unknown[]) => Promise<unknown>;
  all: (sql: string) => Promise<Array<Record<string, unknown>>>;
  close: () => Promise<void>;
}

/** Seed a REAL scratch store through the REAL driver (bypassing the mock via
 *  `vi.importActual`), so the fixture carries a genuine WAL and `-tshm`. */
async function rawSeed(dbPath: string): Promise<void> {
  const mod = (await vi.importActual('@tursodatabase/database')) as {
    connect: (p: string, o?: unknown) => Promise<RawDb>;
  };
  const db = await mod.connect(dbPath, { experimental: ['index_method', 'multiprocess_wal'] });
  await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  await db.run('INSERT INTO t (v) VALUES (?)', 'seed-row');
  await db.all('PRAGMA wal_checkpoint(PASSIVE)');
  await db.close();
}

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-sidecar-live-'));
});

function tempPath(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpDir, `${label}-${suffix}.db`);
}

/** Backdate a file's mtime (and atime) to `msAgo` ms in the past. */
function backdate(path: string, msAgo: number): void {
  const t = new Date(Date.now() - msAgo);
  utimesSync(path, t, t);
}

/** Every `-tshm.stale-*` / `-shm.stale-*` sidecar rename under the store. */
function staleSidecars(dbPath: string): string[] {
  return readdirSync(dirname(dbPath)).filter((f) => f.startsWith(basename(dbPath)) && f.includes('.stale-'));
}

const openAdapters: TursoAdapterImpl[] = [];

beforeEach(() => {
  mockDriverConnect.mockReset();
});

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

async function connect(dbPath: string): Promise<TursoAdapterImpl> {
  const adapter = await TursoAdapterImpl.connect({ dbPath });
  openAdapters.push(adapter);
  // (DEBT-003, lazy-connect) `TursoAdapterImpl.connect()` no longer opens the
  // mocked driver eagerly — every real-open effect this whole file pins
  // (mockDriverConnect call count, proactive/catch sidecar reconcile,
  // retry-then-throw on exhaustion) now happens on the first real operation.
  // This helper is this file's ONLY entry point for "get a live adapter", so
  // forcing the real open here — and letting a rejection propagate exactly
  // as a rejecting `connect()` used to — preserves every existing test's
  // intent without touching its assertions.
  await adapter.executeGet('SELECT 1');
  return adapter;
}

// ═══════════════════════════════════════════════════════════════════════════
// BUG-007 — the pre-open reconcile must never rename a LIVE store's sidecar
// ═══════════════════════════════════════════════════════════════════════════

tursoDescribe('BUG-007 — pre-open proactive reconcile with a live peer renames NOTHING', () => {
  it('a mtime-stale -tshm beside a live peer lease is left in place, and the store still opens', async () => {
    const dbPath = tempPath('bug007-live-peer');
    await rawSeed(dbPath);
    const tshmPath = dbPath + '-tshm';
    expect(statSync(dbPath + '-wal').size, 'precondition: non-empty WAL').toBeGreaterThan(0);
    expect(existsSync(tshmPath), 'precondition: -tshm exists').toBe(true);
    backdate(tshmPath, 120_000); // 2 min > the 60 s staleness threshold — provably stale

    // A live peer holds the store — exactly the BUG-007 contention shape.
    const peer = await acquireStoreLease(dbPath);
    try {
      mockDriverConnect.mockResolvedValue(makeFakeDb());
      const adapter = await connect(dbPath);

      // Pinned: NOTHING renamed. Pre-fix, the proactive reconcile moved the
      // live store's stale -tshm aside and the sibling opens short-read.
      expect(staleSidecars(dbPath), 'a live store must never be reconciled').toHaveLength(0);
      expect(statSync(tshmPath), 'the live -tshm must survive the open untouched').toBeTruthy();
      expect(adapter).toBeInstanceOf(TursoAdapterImpl);
    } finally {
      await peer.release();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BUG-009 — the open-time catch with a live peer retries and never classifies
// ═══════════════════════════════════════════════════════════════════════════

tursoDescribe('BUG-009 — open-time catch with a live peer retries and never classifies as corruption', () => {
  it('transient short-read with a live peer: connect retries (1 + 2) and succeeds; no sidecar renamed', async () => {
    const dbPath = tempPath('bug009-live-retry');
    await rawSeed(dbPath);
    backdate(dbPath + '-tshm', 120_000);

    const peer = await acquireStoreLease(dbPath);
    try {
      // The close()-TRUNCATE race shape: the frame pread short-reads twice,
      // then the sibling has let go and the open lands.
      mockDriverConnect
        .mockRejectedValueOnce(shortReadError())
        .mockRejectedValueOnce(shortReadError())
        .mockResolvedValueOnce(makeFakeDb());

      const adapter = await connect(dbPath); // must NOT throw

      expect(
        mockDriverConnect,
        'BUG-009: the LIVE branch must retry the open (1 initial + 2 retries), never recover',
      ).toHaveBeenCalledTimes(3);
      expect(staleSidecars(dbPath), 'recovery must never rename sidecars while a peer is live').toHaveLength(0);
      expect(adapter).toBeInstanceOf(TursoAdapterImpl);
    } finally {
      await peer.release();
    }
  });

  it('persistent short-read with a live peer: throws the ORIGINAL error retryable:true, never the STALE WAL-INDEX SIDECAR wrapper', async () => {
    const dbPath = tempPath('bug009-live-exhaust');
    await rawSeed(dbPath);
    backdate(dbPath + '-tshm', 120_000);

    const peer = await acquireStoreLease(dbPath);
    try {
      const original = shortReadError();
      mockDriverConnect.mockRejectedValue(original);

      let thrown: unknown;
      try {
        await connect(dbPath);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeDefined();
      expect(
        mockDriverConnect,
        'exhaustion after the bounded budget: 1 initial + 2 retries = 3 driver attempts',
      ).toHaveBeenCalledTimes(3);
      // The ORIGINAL driver error, marked retryable — the caller decides
      // beyond the adapter's bound (ADR-0012 §4). Never the
      // describeStaleWalIndexFailure wrapper (that wrapper IS the BUG-009
      // misclassification).
      expect(thrown instanceof Error && (thrown as Error).message).toBe(original.message);
      expect((thrown as { retryable?: boolean }).retryable).toBe(true);
      expect((thrown as Error).message).not.toMatch(/STALE WAL-INDEX SIDECAR/);
      expect(staleSidecars(dbPath), 'recovery must never rename sidecars while a peer is live').toHaveLength(0);
    } finally {
      await peer.release();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Quiescent — the orphaned-sidecar reconcile must not regress (pre-existing
// deleted-WAL shapes now fire proactively via the BUG014.T3 content-dead trigger;
// a WAL emptied mid-open still reaches the catch's quiescent empty-WAL branch)
// ═══════════════════════════════════════════════════════════════════════════

tursoDescribe('BUG-009 — open-time catch with NO peer: the orphaned sidecar is still reconciled', () => {
  it('quiescent deleted-WAL: the orphaned -tshm is reconciled (now proactively, content-dead — BUG014.T3) and the open succeeds', async () => {
    const dbPath = tempPath('bug009-no-peer');
    await rawSeed(dbPath);

    // Deleted-WAL variant: remove the WAL (the mixed-engine clean-close
    // shape). With content-deadness as the trigger (BUG014.T3, SPEC §T3), the
    // pre-open proactive reconcile sees the WAL absent ⇒ the surviving -tshm
    // is content-proven dead ⇒ moves it BEFORE the first openOnce — the
    // deleted-WAL recovery that previously waited for the open-time catch's
    // empty-WAL branch. The reconcile must still happen (the observable is
    // the same: one orphaned sidecar moved aside, store opens), only the site
    // that performs it moved earlier.
    unlinkSync(dbPath + '-wal');

    mockDriverConnect.mockResolvedValue(makeFakeDb());

    const adapter = await connect(dbPath);

    expect(
      staleSidecars(dbPath),
      'the orphaned sidecar must still be reconciled (proactively, content-dead)',
    ).toHaveLength(1);
    expect(adapter).toBeInstanceOf(TursoAdapterImpl);
  });

  it('quiescent WAL emptied mid-open: the open-time catch empty-WAL branch still recovers the orphaned -tshm (BUG014.T3 backstop)', async () => {
    const dbPath = tempPath('bug009-no-peer-catch');
    await rawSeed(dbPath);

    // The WAL is non-empty and the -tshm CONTENT-LIVE here (rawSeed's real
    // driver wrote + checkpointed frames), so the pre-open proactive
    // reconcile (content-deadness gate, BUG014.T3) sees a live index, DECLINES,
    // and renames NOTHING — the proactive site cannot fire.
    expect(statSync(dbPath + '-wal').size, 'precondition: non-empty content-live WAL').toBeGreaterThan(0);

    // The first driver open then fails with the short read AND the WAL is
    // emptied (0 bytes) in the same instant — the close()-TRUNCATE /
    // out-of-band-zero race shape. The proactive probe already passed (index
    // was live), so the open-time catch is the only reconcile site left; it is
    // quiescent (no peer), so recoverStaleWalIndex's empty-WAL branch moves the
    // orphaned -tshm aside and the reopen lands. RED pre-T3: the old test
    // removed the WAL BEFORE the open, so the proactive site — not the catch —
    // performed the recovery and this branch was no longer exercised
    // end-to-end.
    mockDriverConnect
      .mockImplementationOnce(async (path: string) => {
        truncateSync(path + '-wal', 0);
        throw shortReadError();
      })
      .mockResolvedValueOnce(makeFakeDb()); // the reopen after recovery

    const adapter = await connect(dbPath);

    expect(
      mockDriverConnect,
      'the catch ran: 1 initial failed open + 1 reopen after the recovery (the proactive path would be a single call)',
    ).toHaveBeenCalledTimes(2);
    expect(
      statSync(dbPath + '-wal').size,
      'the catch saw a 0-byte WAL — the empty-WAL branch, not the beyond-EOF branch',
    ).toBe(0);
    expect(
      staleSidecars(dbPath),
      'the quiescent catch must still move the orphaned -tshm aside (empty-WAL reconcile preserved)',
    ).toHaveLength(1);
    expect(adapter).toBeInstanceOf(TursoAdapterImpl);
  });
});
