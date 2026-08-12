/**
 * BUG-007 / BUG-008 / BUG-009 — the REAL-engine 8-way WAL-contention integration
 * (adapter-race-fix plan §10D, ships in 0.5.7).
 *
 * Where the mock-driver specs (§10B/§10C) prove the decision logic, this file
 * proves the FIXED ADAPTER against the REAL `@tursodatabase/database` engine,
 * end to end, in-process:
 *
 *   Leg 1 — BUG-007: 8 concurrent opens against a LIVE store whose `-tshm`
 *   is mtime-stale (the exact trigger shape of the live-store incident). With
 *   the lease gate the first opener sees writer W's live lease and defers the
 *   sidecar reconcile — ZERO renames, ZERO short-reads, W's row still visible.
 *   RED pre-fix: the first opener's proactive reconcile renames the live
 *   `-tshm` (a `.stale-*` file appears beside a store another connection is
 *   holding) and siblings short-read / fail.
 *
 *   Leg 2 — 8-way connect+write+close against a fresh aged-tshm fixture:
 *   every write durably persists (count check on a final fresh open), zero
 *   connect failures. Renames happen only while the store is provably
 *   unheld, never per-sibling under contention: (1) the first opener's
 *   quiescent cold-start reconcile of the aged sidecar (the intended BL-373
 *   behavior), plus (2) the FINAL quiescent close's BUG-014 tshm-reset (the
 *   close()-TRUNCATE moves the -tshm it just orphaned). 8 concurrent
 *   connects leave exactly ONE quiescent close window (the last closer), so
 *   the pin is `.stale-* ≤ 2` — anything beyond the cold-start reconcile +
 *   the final close-reset means renames ran under sibling contention (the
 *   BUG-007 damage).
 *
 *   Leg 3 — BUG-008: a contended close DEFERS the TRUNCATE deterministically.
 *   R closes while W's lease is live → the close logs `close_checkpoint_busy`
 *   with the lease-deferral marker ("another connection holds the store"),
 *   the WAL survives (frames durable), W can still read its row. W's
 *   subsequent close is quiescent → TRUNCATE → the row survives a fresh open
 *   and the final `-wal` is ~0 bytes. RED pre-fix: R's close attempts the
 *   TRUNCATE anyway (probabilistic busy=1 reported AFTER, or a silent
 *   truncate of a live store) — the lease-deferral marker never fires.
 *
 * Harness rules (non-negotiable, from the plan):
 *  - SCRATCH COPY only: `mkdtempSync` under `tmpdir()` — never the live store,
 *    never `~/.memory`, never a real backlog DB.
 *  - `tursoDescribe` gate — skipped (never fails) when the driver is absent.
 *  - `backdate` copied from wal-sidecar-staleness.bl373.test.ts; `jitter`
 *    copied from turso-concurrent-writes.test.ts.
 *  - `ADHD_BACKLOG_DATABASE_PATH` is DEAD config (BUG-002, external repo) —
 *    this harness never touches it; every store is an explicit adapter dbPath.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, statSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { log } from '@adhd/sox-telemetry';

const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();
const tursoDescribe = hasTurso ? describe : describe.skip;

interface RawDb {
  exec: (sql: string) => Promise<void>;
  run: (sql: string, ...a: unknown[]) => Promise<unknown>;
  all: (sql: string) => Promise<Array<Record<string, unknown>>>;
  close: () => Promise<void>;
}

/** Raw-driver connect with the adapter's exact experimental flags — the same
 *  ceremony the adapter itself uses (multiprocess WAL + index_method). */
async function rawConnect(dbPath: string): Promise<RawDb> {
  const mod = (await import('@tursodatabase/database')) as {
    connect: (p: string, o?: unknown) => Promise<RawDb>;
  };
  return mod.connect(dbPath, { experimental: ['index_method', 'multiprocess_wal'] });
}

/** Seed a real scratch store: one table, a few rows, PASSIVE checkpoint, close.
 *  The PASSIVE (non-truncating) close is deliberate — it leaves a NON-EMPTY
 *  `-wal` and a `-tshm` beside it, the exact BL-373 fixture shape. */
async function seedStore(dbPath: string, rows = 5): Promise<void> {
  const seed = await rawConnect(dbPath);
  try {
    await seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    for (let i = 0; i < rows; i++) {
      await seed.run('INSERT INTO t (v) VALUES (?)', `seed-${i}`);
    }
    await seed.all('PRAGMA wal_checkpoint(PASSIVE)');
  } finally {
    await seed.close();
  }
}

/** Backdate a file's mtime (and atime) to `msAgo` ms in the past. */
function backdate(path: string, msAgo: number): void {
  const t = new Date(Date.now() - msAgo);
  utimesSync(path, t, t);
}

/** Widens the interleaving window so concurrent callers actually overlap. */
function jitter(maxMs = 8): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.random() * maxMs));
}

/** Every `.stale-*` sidecar rename under the store (excludes the lease dir). */
function staleSidecars(dbPath: string): string[] {
  return readdirSync(dirname(dbPath)).filter(
    (f) =>
      f.startsWith(basename(dbPath)) &&
      f.includes('.stale-') &&
      !f.includes('.sox-lease.d'),
  );
}

/** The BL-373 staleness threshold the adapter compares against (60 s default). */
const STALE_THRESHOLD_MS = 60_000;

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-8way-'));
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
      // already closed / best-effort
    }
  }
});

tursoDescribe('BUG-007/008/009 — 8-way WAL contention against the real engine (adapter-race-fix §10D)', () => {
  it('LEG 1 — 8 concurrent opens against a live aged-tshm store: zero renames, zero short-reads, W row visible', async () => {
    const dbPath = tempPath('8way-leg1');
    await seedStore(dbPath);

    // Long-lived writer W — its lease is live from connect() on.
    const W = await connect(dbPath);
    await W.executeRun('INSERT INTO t (v) VALUES (?)', ['w-row']);
    expect(existsSync(dbPath + '-tshm'), 'precondition: -tshm exists').toBe(true);
    expect(
      statSync(dbPath + '-wal').size,
      'precondition: the WAL must hold uncheckpointed frames',
    ).toBeGreaterThan(0);

    // Freeze the -tshm 2 min in the PAST AFTER W's write (the driver's own
    // sidecar maintenance during W's open/write is real and would refresh the
    // mtime — the plan's trigger shape is "fresh WAL, frozen -tshm", and
    // freezing last makes it deterministic).
    backdate(dbPath + '-tshm', 120_000);
    const ageDiff = statSync(dbPath + '-wal').mtimeMs - statSync(dbPath + '-tshm').mtimeMs;
    expect(
      ageDiff,
      'precondition: the aged-tshm trigger shape (ageDiff > 60 s threshold) must hold',
    ).toBeGreaterThan(STALE_THRESHOLD_MS);

    // 8 concurrent connect → insert → overlap → close against the LIVE store.
    const failures: string[] = [];
    await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        try {
          const a = await TursoAdapterImpl.connect({ dbPath });
          await a.executeRun('INSERT INTO t (v) VALUES (?)', [`s${i}`]);
          await jitter(16); // hold the connection long enough to overlap siblings + W
          await a.close();
        } catch (err) {
          failures.push(`${i}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );

    expect(failures, `connect/write/close failures: ${failures.join(' | ')}`).toEqual([]);
    expect(
      failures.join(' '),
      'BUG-007: no error text may name a WAL-frame short read',
    ).not.toMatch(/short read/i);
    expect(
      failures.join(' '),
      'BUG-007: no error text may carry the STALE WAL-INDEX SIDECAR corruption wrapper',
    ).not.toMatch(/STALE WAL-INDEX SIDECAR/);
    expect(
      staleSidecars(dbPath),
      'BUG-007: a LIVE store must never be reconciled — zero sidecar renames',
    ).toHaveLength(0);

    // W's row survives the 8-way churn, and so do all 8 sibling writes.
    const wRow = await W.executeGet<{ v: string }>('SELECT v FROM t WHERE v = ?', ['w-row']);
    expect(wRow, 'BUG-007: W must still see its own row after 8 concurrent opens').not.toBeNull();
    for (let i = 0; i < 8; i++) {
      const sRow = await W.executeGet<{ v: string }>('SELECT v FROM t WHERE v = ?', [`s${i}`]);
      expect(sRow, `sibling write s${i} must be committed and visible to W`).not.toBeNull();
    }
    const cnt = await W.executeGet<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM t');
    expect(cnt!.cnt, 'seed 5 + w-row + 8 siblings').toBe(14);
  });

  it('LEG 2 — 8-way connect+write+close on a fresh aged-tshm store: all writes persist, zero failures', async () => {
    const dbPath = tempPath('8way-leg2');
    await seedStore(dbPath);
    backdate(dbPath + '-tshm', 120_000);

    const failures: string[] = [];
    await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        try {
          const a = await TursoAdapterImpl.connect({ dbPath });
          await a.executeRun('INSERT INTO t (v) VALUES (?)', [`l2-${i}`]);
          await jitter(16);
          await a.close();
        } catch (err) {
          failures.push(`${i}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );

    expect(failures, `connect/write/close failures: ${failures.join(' | ')}`).toEqual([]);
    // The FIRST opener starts cold (no peer yet) — its quiescent reconcile of
    // the aged sidecar is the intended BL-373 behavior. The LAST closer is the
    // only quiescent close (8 concurrent connects leave one quiescent window),
    // and its BUG-014 close-reset moves the -tshm it just TRUNCATEd. So two
    // `.stale-*` renames are legal, BOTH quiescence-gated; more than two means
    // renames ran under sibling contention (the BUG-007 damage, this leg's RED
    // shape) or per-sibling closes.
    expect(
      staleSidecars(dbPath).length,
      'BUG-007: at most the cold-start reconcile + the final quiescent close-reset may rename a sidecar — never per-sibling under contention',
    ).toBeLessThanOrEqual(2);

    // Durability: a final fresh open sees every one of the 8 writes.
    const v = await connect(dbPath);
    try {
      const cnt = await v.executeGet<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM t');
      expect(cnt!.cnt, 'seed 5 + 8 leg-2 writes').toBe(13);
      for (let i = 0; i < 8; i++) {
        const row = await v.executeGet<{ v: string }>('SELECT v FROM t WHERE v = ?', [`l2-${i}`]);
        expect(row, `leg-2 write l2-${i} must be durably present`).not.toBeNull();
      }
    } finally {
      await v.close();
    }
  });

  it('LEG 3 — contended close defers TRUNCATE (R closes with W live), then W quiescent close truncates; row survives, -wal ~0', async () => {
    const dbPath = tempPath('8way-leg3');
    const W = await connect(dbPath);
    await W.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await W.exec('INSERT INTO t (v) VALUES (\'leg3-row\')');

    // R — a second live connection holding an open read tx (real WAL reader).
    const R = await connect(dbPath);
    await R.exec('BEGIN');
    await R.executeGet('SELECT count(*) AS c FROM t');

    const warnSpy = vi.spyOn(log, 'warn');
    try {
      // R closes FIRST while W's lease is still live → the TRUNCATE must be
      // DEFERRED deterministically (the lease check runs BEFORE the truncate),
      // and the WAL must survive so W's live reads keep working.
      await R.close();

      const busyCalls = warnSpy.mock.calls.filter((c) => c[0] === 'store_adapter.turso.close_checkpoint_busy');
      expect(
        busyCalls,
        'BUG-008: R close with W live must log the lease-deferral busy event exactly once',
      ).toHaveLength(1);
      const busyPayload = busyCalls[0]?.[1];
      expect(
        busyPayload !== null &&
          typeof busyPayload === 'object' &&
          typeof (busyPayload as { detail?: unknown }).detail === 'string' &&
          (busyPayload as { detail: string }).detail.includes('another connection holds the store'),
        'BUG-008: the deferral marker (lease decision BEFORE the truncate) must be the logged detail — ' +
          'not the post-hoc busy=1 report of the old code',
      ).toBe(true);

      const walPath = dbPath + '-wal';
      expect(
        existsSync(walPath) && statSync(walPath).size > 0,
        'BUG-008: the deferred close must leave the WAL non-empty — frames stay durable for W',
      ).toBe(true);

      // W is still open and must still see its row after R's deferred close.
      const wRow = await W.executeGet<{ v: string }>('SELECT v FROM t WHERE v = ?', ['leg3-row']);
      expect(wRow, 'BUG-008: W must read its row after R closed with the TRUNCATE deferred').not.toBeNull();
    } finally {
      warnSpy.mockRestore();
    }

    // W closes now-quiescent → the single TRUNCATE runs → -wal ~0 bytes.
    await W.close();

    const walPath = dbPath + '-wal';
    const walSize = existsSync(walPath) ? statSync(walPath).size : 0;
    expect(
      walSize,
      'BUG-008: the final quiescent close must TRUNCATE the WAL to ~0 bytes',
    ).toBe(0);

    // The row is in the MAIN db file — a fresh open with no WAL replay sees it.
    const b = await TursoAdapterImpl.connect({ dbPath });
    try {
      const row = await b.executeGet<{ v: string }>('SELECT v FROM t WHERE v = ?', ['leg3-row']);
      expect(row, 'the row must survive the deferred-TRUNCATE sequence in the main db file').not.toBeNull();
      expect(row!.v).toBe('leg3-row');
    } finally {
      await b.close();
    }
  });
});
