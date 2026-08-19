/**
 * BL-373 family — the PERMANENT stale-WAL-sidecar solve.
 *
 * The live store hit the THIRD recurrence of the stale-`-tshm` permanent
 * outage on 2026-08-11: `memory.db-tshm` mtime Aug 4 beside a 206 032-byte
 * `memory.db-wal` → every fresh open failed with
 * `short read on WAL frame at offset 61832: expected 4096 bytes, got 0`, and
 * `recoverStaleWalIndex()` DECLINED because `walBytes > 0` with no staleness
 * test at all (integrity.ts:335-340). 61832 = 32 + 15 × 4120 — the WAL ends
 * EXACTLY on a frame boundary (Shape A: stale sidecar over a healthy WAL).
 *
 * What this file pins (each with a real engine, no mocks, no env gates on the
 * core assertions):
 *  1. A CONTENT-dead -tshm (index extent beyond the WAL EOF) is moved over a
 *     NON-EMPTY WAL — and only the `-tshm` moves, never the `-shm`; the store
 *     then opens and the checkpointed data survives (the exact incident shape,
 *     unblocked). An mtime-BACKDATED but content-live sidecar is NEVER moved
 *     (BUG014.T3 — the mtime heuristic's false positive is gone).
 *  2. mtime skew is never a rename trigger (BUG014.T3): backdated 30 s or 90 s →
 *     declined untouched; the env-tunable threshold drives ONLY the log-only
 *     `warnIfStaleSidecar` mtime-skew report.
 *  3. Shape B (mid-frame truncated WAL): `probeWalFrames` reports truncated;
 *     REFUSAL-ONLY (ADR-0013) — the typed operator-action error names the
 *     manual step (`mv …-wal …-wal.corrupt-<stamp>`, or restore from backup)
 *     with the data-loss disclosure, and the WAL is never auto-renamed. A
 *     CONTENT-dead sidecar over a truncated WAL is reconciled (the -tshm
 *     moves, the WAL stays), and the store opens with checkpointed data.
 *  4. The `sidecar_stale` startup warning fires with mtime-skew evidence —
 *     including on a store whose open SUCCEEDS (the masked case).
 *
 * Fixture rule (BL-361): every damage fixture is present-but-damaged, never
 * absent.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import {
  mkdtempSync,
  statSync,
  existsSync,
  writeFileSync,
  readdirSync,
  truncateSync,
  utimesSync,
  unlinkSync,
} from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { TursoAdapterImpl } from '../turso-adapter.js';
import {
  probeWalFrames,
  recoverStaleWalIndex,
  describeStaleWalIndexFailure,
  warnIfStaleSidecar,
  setIntegrityReportSink,
  DEFAULT_WAL_SIDECAR_STALE_THRESHOLD_MS,
} from '../integrity.js';
import type { IntegrityReportEvent } from '../integrity.js';

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

async function rawConnect(dbPath: string): Promise<RawDb> {
  const mod = (await import('@tursodatabase/database')) as {
    connect: (p: string, o?: unknown) => Promise<RawDb>;
  };
  return mod.connect(dbPath, { experimental: ['index_method', 'multiprocess_wal'] });
}

const SEED_ROWS = 1200;
const DAY_MS = 24 * 3600 * 1000;
const WEEK_MS = 7 * DAY_MS;
/** Backdate a file's mtime (and atime) to `msAgo` ms in the past. */
function backdate(path: string, msAgo: number): void {
  const t = new Date(Date.now() - msAgo);
  utimesSync(path, t, t);
}

/** Seed a real store whose WAL retains frames after close. */
async function seedStore(dbPath: string, rows = SEED_ROWS): Promise<void> {
  const seed = await rawConnect(dbPath);
  await seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  for (let i = 0; i < rows; i++) {
    await seed.run('INSERT INTO t (v) VALUES (?)', 'v'.repeat(400) + i);
  }
  await seed.all('PRAGMA wal_checkpoint(PASSIVE)');
  await seed.close();
}

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-wal-stale-'));
});

function tempPath(label: string): string {
  return join(tmpDir, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}

const open: TursoAdapterImpl[] = [];
afterEach(async () => {
  while (open.length > 0) {
    try {
      await open.pop()!.close();
    } catch {
      // already closed
    }
  }
});

function track<T extends TursoAdapterImpl>(a: T): T {
  open.push(a);
  return a;
}

function asideFiles(dbPath: string, pattern: string): string[] {
  return readdirSync(dirname(dbPath)).filter(
    (f) => f.startsWith(basename(dbPath) + pattern),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// (1) CONTENT-dead -tshm over a non-empty WAL is reconciled (third-recurrence
//     shape); an mtime-backdated but content-LIVE sidecar is NOT (BUG014.T3)
// ═══════════════════════════════════════════════════════════════════════════

tursoDescribe('BL-373/BUG014.T3 — the -tshm trigger is CONTENT-deadness, never mtime', () => {
  it('an mtime-backdated but content-live -tshm is DECLINED untouched (the false positive is gone); making it content-dead moves ONLY the -tshm and the store opens with data intact', async () => {
    const dbPath = tempPath('bl373-nonempty-wal');
    await seedStore(dbPath);
    const walPath = dbPath + '-wal';
    const tshmPath = dbPath + '-tshm';
    // Precondition: the fixture really is the incident shape — non-empty WAL.
    expect(statSync(walPath).size, 'precondition: WAL must be non-empty').toBeGreaterThan(0);
    expect(existsSync(tshmPath), 'precondition: -tshm must exist').toBe(true);

    // Backdate the sidecar 7 days — mtime ONLY; the content stays consistent
    // with the WAL. Pre-fix (BUG014.T3) this healthy sidecar was renamed by the
    // mtime heuristic (the 08:28–08:46 false-positive churn); the content
    // gate must decline.
    backdate(tshmPath, WEEK_MS);
    const live = recoverStaleWalIndex(dbPath);
    expect(live.attempted).toBe(false);
    expect(live.movedAside).toEqual([]);
    expect(live.declined).toMatch(/NOT content-proven dead/);
    expect(existsSync(tshmPath), 'a content-live sidecar must never be renamed').toBe(true);

    // Now make it CONTENT-dead: truncate the WAL below the frames the tshm
    // indexes (the Aug-11 beyond-EOF shape — the tshm claims a frame offset
    // past the WAL EOF). The incident shape still moves.
    const probe = probeWalFrames(walPath);
    expect(probe.readable).toBe(true);
    truncateSync(walPath, 32 + 100 * (24 + probe.pageSize!));
    // Turso does not create an ordinary -shm under multiprocess WAL, so the
    // only way to assert "never touches -shm on this path" is an
    // empty-but-present fixture (BL-361).
    writeFileSync(dbPath + '-shm', '');

    const recovery = recoverStaleWalIndex(dbPath);
    expect(recovery.attempted).toBe(true);
    expect(recovery.movedAside.length).toBe(1);
    expect(recovery.movedAside[0]!.from).toBe(tshmPath);
    expect(recovery.movedAside[0]!.to).toMatch(/-tshm\.stale-\d{4}-\d{2}-\d{2}-\d{4}/);
    expect(
      existsSync(tshmPath),
      'the content-dead -tshm must be RENAMED (forensics), never deleted — and its original path vacated',
    ).toBe(false);
    expect(existsSync(recovery.movedAside[0]!.to)).toBe(true);
    expect(existsSync(dbPath + '-shm'), 'the -shm must be UNTOUCHED on the content-dead path').toBe(true);

    // The fabricated -shm is fixture collateral; remove it before the real
    // open so it cannot artificially perturb the driver.
    unlinkSync(dbPath + '-shm');

    // Full adapter open against the WAL as-is: recovery must have healed it.
    const adapter = track(await TursoAdapterImpl.connect({ dbPath }));
    const rows = await adapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM t');
    expect(rows!.c, 'every checkpointed row must survive sidecar reconciliation').toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (2) mtime skew is NEVER a rename trigger — content-deadness is (BUG014.T3)
// ═══════════════════════════════════════════════════════════════════════════

tursoDescribe('BUG014.T3 — mtime skew alone never moves a sidecar, at any backdate', () => {
  it('backdated 30 s AND 90 s both decline untouched (content unprovable) — pre-fix the 90 s case moved', () => {
    const dbPath = tempPath('bl373-boundary');
    writeFileSync(dbPath, '');
    writeFileSync(dbPath + '-wal', 'x'.repeat(4096));
    writeFileSync(dbPath + '-tshm', 'y'.repeat(32));

    // 30 s: content unprovable (garbage WAL header) — decline with evidence.
    backdate(dbPath + '-tshm', 30_000);
    const ambiguous = recoverStaleWalIndex(dbPath);
    expect(ambiguous.attempted).toBe(false);
    expect(ambiguous.movedAside).toEqual([]);
    expect(ambiguous.declined).toMatch(/NOT content-proven dead/);
    expect(ambiguous.declined).toMatch(/WAL frame probe/);
    expect(existsSync(dbPath + '-tshm'), '30 s backdate must leave the sidecar in place').toBe(true);

    // 90 s: STILL declines — mtime skew beyond the threshold is not evidence
    // of staleness (the tshm mtime freezes at creation under multiprocess
    // WAL; BUG014.T3). Pre-fix the mtime heuristic moved this.
    backdate(dbPath + '-tshm', 90_000);
    const notStale = recoverStaleWalIndex(dbPath);
    expect(notStale.attempted).toBe(false);
    expect(notStale.movedAside).toEqual([]);
    expect(notStale.declined).toMatch(/NOT content-proven dead/);
    expect(existsSync(dbPath + '-tshm'), '90 s backdate must ALSO leave the sidecar in place').toBe(true);
  });

  it('the threshold env drives ONLY the log-only warnIfStaleSidecar report, never a rename', () => {
    const dbPath = tempPath('bl373-threshold-env');
    writeFileSync(dbPath, '');
    writeFileSync(dbPath + '-wal', 'x'.repeat(4096));
    writeFileSync(dbPath + '-tshm', 'y'.repeat(32));
    const prev = process.env.SOX_WAL_SIDECAR_STALE_THRESHOLD_MS;
    try {
      process.env.SOX_WAL_SIDECAR_STALE_THRESHOLD_MS = '10000';
      // 30 s > a 10 s threshold — the OLD code called this provably stale and
      // renamed. The content gate refuses regardless of the env.
      backdate(dbPath + '-tshm', 30_000);
      const declined = recoverStaleWalIndex(dbPath);
      expect(declined.attempted).toBe(false);
      expect(declined.movedAside).toEqual([]);
      expect(existsSync(dbPath + '-tshm'), 'the env threshold must not enable a rename').toBe(true);

      // The env still tunes the informational mtime-skew REPORT.
      let emitted = 0;
      setIntegrityReportSink(() => emitted++);
      try {
        warnIfStaleSidecar(dbPath);
        expect(emitted, '30 s skew > 10 s threshold → the mtime-skew report fires').toBe(1);
        process.env.SOX_WAL_SIDECAR_STALE_THRESHOLD_MS = '120000';
        emitted = 0;
        warnIfStaleSidecar(dbPath);
        expect(emitted, '30 s skew < 120 s threshold → no report').toBe(0);
      } finally {
        setIntegrityReportSink(null);
      }
    } finally {
      if (prev === undefined) delete process.env.SOX_WAL_SIDECAR_STALE_THRESHOLD_MS;
      else process.env.SOX_WAL_SIDECAR_STALE_THRESHOLD_MS = prev;
    }
    expect(DEFAULT_WAL_SIDECAR_STALE_THRESHOLD_MS).toBe(60_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (3) Shape B — a mid-frame truncated WAL
// ═══════════════════════════════════════════════════════════════════════════

tursoDescribe('BL-373 — Shape B: a mid-frame truncated WAL is probed, and moved only with the opt-in', () => {
  /** Build a store, then truncate its WAL to `32 + K*(24+pageSize) + extra`. */
  async function truncateWal(dbPath: string, K: number, extra: number): Promise<number> {
    await seedStore(dbPath);
    const walPath = dbPath + '-wal';
    const probe = probeWalFrames(walPath);
    expect(probe.readable).toBe(true);
    const target = 32 + K * (24 + probe.pageSize!) + extra;
    truncateSync(walPath, target);
    return target;
  }

  it('probeWalFrames classifies the mid-frame fixture as truncated:true (Shape B)', async () => {
    const dbPath = tempPath('bl373-shapeb-probe');
    await truncateWal(dbPath, 100, 100);
    const probe = probeWalFrames(dbPath + '-wal');
    expect(probe.readable).toBe(true);
    expect(probe.truncated).toBe(true);
    expect(probe.leftover).toBe(100);
  });

  it('REFUSAL-ONLY (ADR-0013): a truncated WAL is never auto-moved — the typed operator-action error names the manual step with the data-loss disclosure, and no WAL file is renamed', async () => {
    const dbPath = tempPath('bl373-shapeb-refusal');
    await seedStore(dbPath);
    const walPath = dbPath + '-wal';
    const probe = probeWalFrames(walPath);
    truncateSync(walPath, 32 + 100 * (24 + probe.pageSize!) + 100);
    const truncatedProbe = probeWalFrames(walPath);
    expect(truncatedProbe.truncated).toBe(true);
    const before = statSync(walPath).size;

    // The exact typed error the adapter throws when the reopen still fails on
    // a probe-truncated WAL: evidence + manual operator step + data-loss
    // disclosure. Moving the WAL is a HUMAN decision — no env gate exists.
    const err = describeStaleWalIndexFailure(
      dbPath,
      {
        attempted: true,
        movedAside: [{ from: dbPath + '-tshm', to: dbPath + '-tshm.stale-2026-08-11-0000' }],
        declined: null,
      },
      new Error('failed to open database /x/memory.db: I/O error: short read on WAL frame at offset 774592'),
      truncatedProbe,
    );
    expect(err.message).toMatch(/truncated mid-frame/);
    expect(err.message).toMatch(/\.corrupt-<stamp>/);
    expect(err.message).toMatch(/DISCARDS/);
    expect(err.message).toMatch(/restore from backup/);
    expect(err.message).not.toMatch(/SOX_ALLOW_AUTO_WAL_ASIDE/);

    // No frames discarded, no WAL renamed — the store waits for the operator.
    expect(statSync(walPath).size).toBe(before);
    expect(existsSync(walPath), 'the WAL must never be auto-renamed').toBe(true);
    expect(asideFiles(dbPath, '-wal.corrupt-').length).toBe(0);
  });

  it('a truncated WAL with a CONTENT-dead sidecar heals: ONLY the -tshm moves, the WAL never does, and the store opens with checkpointed data (BUG014.T3)', async () => {
    const dbPath = tempPath('bl373-shapeb-ambiguous');
    await seedStore(dbPath);
    // Mid-frame truncation (Shape B): the WAL ends 100 bytes into a frame.
    // The seeded -tshm still indexes frames beyond the truncated EOF ⇒ it is
    // CONTENT-dead (BUG014.T3) — the pre-open proactive reconcile moves ONLY
    // the -tshm. The WAL itself is never auto-moved: ADR-0013's refusal-only
    // rule governs the WAL, and with a rebuilt index the driver opens the
    // truncated WAL (the torn tail is not read as a frame).
    const walPath = dbPath + '-wal';
    const probe = probeWalFrames(walPath);
    truncateSync(walPath, 32 + 100 * (24 + probe.pageSize!) + 100);

    const adapter = track(await TursoAdapterImpl.connect({ dbPath }));
    const rows = await adapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM t');
    expect(rows!.c, 'checkpointed data must survive the heal').toBeGreaterThan(0);
    expect(existsSync(walPath), 'the WAL must never be auto-moved (refusal-only, ADR-0013)').toBe(true);
    expect(asideFiles(dbPath, '-wal.corrupt-').length).toBe(0);
    expect(
      asideFiles(dbPath, '-tshm.stale-').length,
      'the content-dead -tshm must have been reconciled (moved aside, never deleted)',
    ).toBe(1);
  });

  it('a frame-ALIGNED truncated WAL (leftover 0) is NOT classified as corruption — the sidecar moves, the WAL stays', async () => {
    const dbPath = tempPath('bl373-shapea-clean');
    await seedStore(dbPath);
    const walPath = dbPath + '-wal';

    // Probe first: truncate to EXACTLY 32 + K*(24+pageSize) — frame-aligned.
    const probe = probeWalFrames(walPath);
    const target = 32 + 100 * (24 + probe.pageSize!);
    truncateSync(walPath, target);
    const alignedProbe = probeWalFrames(walPath);
    expect(alignedProbe.truncated, 'frame-aligned truncation must NOT read as truncated').toBe(false);
    expect(alignedProbe.leftover).toBe(0);

    // The seeded -tshm still indexes frames beyond the frame-aligned
    // truncation ⇒ CONTENT-dead (BUG014.T3): recovery must move ONLY the -tshm
    // and never touch the frame-aligned WAL (Shape A is not evidence of
    // corruption).
    backdate(dbPath + '-tshm', WEEK_MS);
    const sidecar = recoverStaleWalIndex(dbPath);
    expect(sidecar.attempted).toBe(true);
    expect(sidecar.movedAside.length).toBe(1);
    expect(sidecar.movedAside[0]!.from).toBe(dbPath + '-tshm');
    expect(existsSync(walPath), 'the WAL must stay in place for a frame-aligned fixture').toBe(true);
    expect(asideFiles(dbPath, '-wal.corrupt-').length).toBe(0);

    // And the store opens with the checkpointed data intact.
    const adapter = track(await TursoAdapterImpl.connect({ dbPath }));
    const rows = await adapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM t');
    expect(rows!.c, 'checkpointed data must survive').toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (5) PROACTIVE reconciliation — content-deadness is the trigger (BUG014.T3)
// ═══════════════════════════════════════════════════════════════════════════

tursoDescribe('BUG014.T3 — the pre-open proactive reconcile is content-gated', () => {
  it('an mtime-backdated but CONTENT-LIVE sidecar + non-empty WAL ⇒ NO rename; the FIRST open attempt succeeds (pre-fix renamed it — the false positive)', async () => {
    const dbPath = tempPath('bl373-proactive');
    await seedStore(dbPath);
    const tshmPath = dbPath + '-tshm';
    expect(statSync(dbPath + '-wal').size, 'precondition: non-empty WAL').toBeGreaterThan(0);
    // Backdate ONLY the mtime — the content stays consistent with the WAL.
    // This is the healthy-but-skewed state BUG014.T3 removes: pre-fix the
    // proactive reconcile renamed the sidecar during the next quiescent open
    // (the 08:28–08:46 churn).
    backdate(tshmPath, WEEK_MS);

    const events: { event: string; detail: string }[] = [];
    setIntegrityReportSink((event, detail) => events.push({ event, detail }));
    try {
      const adapter = track(await TursoAdapterImpl.connect({ dbPath }));
      const rows = await adapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM t');
      expect(rows!.c, 'the healthy store must open and answer with all rows').toBe(SEED_ROWS);
    } finally {
      setIntegrityReportSink(null);
    }

    // The false positive is gone: nothing renamed, no repaired-before-open,
    // no damaged event — the open simply succeeded.
    expect(
      events.some((e) => e.event === 'repaired' && /BEFORE the open/.test(e.detail)),
      'a healthy content-live sidecar must NOT be reconciled: ' + JSON.stringify(events),
    ).toBe(false);
    expect(events.some((e) => e.event === 'damaged'), 'the open must not have failed').toBe(false);
    expect(asideFiles(dbPath, '-tshm.stale-').length, 'no false-positive rename').toBe(0);
    expect(existsSync(tshmPath), 'the healthy sidecar must survive untouched').toBe(true);
  });

  it('ROOT-CAUSE MECHANISM: a better-sqlite3 writer moves the WAL without touching -tshm; the next Turso open reconciles the frozen sidecar proactively and succeeds with all data', async () => {
    // The confirmed mechanism (scratch repro, 2026-08-11): the -tshm is
    // maintained only while a Turso connection holds the store. A stock-SQLite
    // (better-sqlite3) writer maintains the classic -shm and never the -tshm;
    // its clean close checkpoints and DELETES the WAL, freezing the -tshm
    // beside a WAL that no longer exists. The next Turso open then dies with
    // "short read on WAL frame" — the incident, reproduced. The live forensic
    // smoking gun: memory.db-shm is FRESH at 19:31:29 while the -tshm froze
    // Aug 4 — Turso under multiprocess WAL never creates -shm; only a
    // stock-SQLite opener does.
    const dbPath = tempPath('bl373-root-mechanism');
    await seedStore(dbPath); // Turso session 1: sidecar maintained, WAL non-empty
    const tshmPath = dbPath + '-tshm';

    // The live shape: the sidecar is already frozen (7 d old) when the
    // mixed-engine writer arrives — exactly the Aug-4-frozen / Aug-11-touched
    // forensic timeline. Baseline captured AFTER the backdate: better-sqlite3
    // must not advance it.
    backdate(tshmPath, WEEK_MS);
    const tshmMtimeBefore = statSync(tshmPath).mtimeMs;

    // Mixed-engine writer: better-sqlite3 opens the SAME store in WAL mode.
    const Database = require('better-sqlite3') as new (p: string) => BetterSqlite3Database;
    const bdb = new Database(dbPath);
    bdb.pragma('journal_mode = WAL');
    bdb.exec('CREATE TABLE IF NOT EXISTS b (id INTEGER PRIMARY KEY, v TEXT)');
    const ins = bdb.prepare('INSERT INTO b (v) VALUES (?)');
    for (let i = 0; i < 200; i++) ins.run('v'.repeat(400) + i);
    bdb.close();

    // The mechanism, asserted: the WAL was moved (deleted by the clean close)
    // while the -tshm survived untouched — still frozen at its backdated mtime.
    expect(existsSync(dbPath + '-wal'), 'better-sqlite3 close checkpoints and removes the WAL').toBe(false);
    expect(existsSync(tshmPath), 'the -tshm must survive the better-sqlite3 session (never maintained)').toBe(true);
    expect(
      statSync(tshmPath).mtimeMs,
      'the better-sqlite3 writer must NOT have touched the -tshm',
    ).toBe(tshmMtimeBefore);
    expect(existsSync(dbPath + '-shm'), 'a stock-SQLite session leaves the classic -shm behind').toBe(false);

    // Without the proactive fix this open is the incident: frozen sidecar
    // over a deleted WAL → short read. With it, the sidecar is reconciled
    // before the driver tries and the open succeeds with ALL data.
    const events: { event: string; detail: string }[] = [];
    setIntegrityReportSink((event, detail) => events.push({ event, detail }));
    try {
      const adapter = track(await TursoAdapterImpl.connect({ dbPath }));
      const rows = await adapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM t');
      const extra = await adapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM b');
      expect(rows!.c, 'Turso-seeded rows must survive').toBe(SEED_ROWS);
      expect(extra!.c, 'better-sqlite3-written rows must survive (checkpointed into the db)').toBe(200);
    } finally {
      setIntegrityReportSink(null);
    }
    expect(events.some((e) => e.event === 'damaged' && /blocked the open/.test(e.detail))).toBe(false);
    expect(events.some((e) => e.event === 'repaired' && /BEFORE the open/.test(e.detail))).toBe(true);
    expect(asideFiles(dbPath, '-tshm.stale-').length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (4) sidecar_stale startup warning, including the masked (open-succeeds) case
// ═══════════════════════════════════════════════════════════════════════════

tursoDescribe('BL-373 — sidecar_stale startup warning carries mtime evidence', () => {
  it('fires during a connect against a backdated sidecar — even when the open SUCCEEDS (masked case)', async () => {
    const dbPath = tempPath('bl373-masked-warn');
    await seedStore(dbPath);
    const tshmPath = dbPath + '-tshm';
    expect(statSync(dbPath + '-wal').size, 'precondition: non-empty WAL').toBeGreaterThan(0);

    // Backdate the mtime ONLY — content stays consistent with the WAL, which
    // is exactly the masked state: the open succeeds, but the sidecar is
    // decaying and must be surfaced.
    backdate(tshmPath, WEEK_MS);

    const events: { event: IntegrityReportEvent; detail: string; dbPath: string | undefined }[] = [];
    setIntegrityReportSink((event, detail, ctx) => events.push({ event, detail, dbPath: ctx.dbPath }));
    try {
      const adapter = track(await TursoAdapterImpl.connect({ dbPath }));
      const rows = await adapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM t');
      expect(rows!.c, 'the masked open must have succeeded').toBe(SEED_ROWS);

      const stale = events.filter((e) => e.event === 'sidecar_stale');
      expect(
        stale.length,
        'a backdated sidecar must emit sidecar_stale during connect, masked or not',
      ).toBeGreaterThan(0);
      const detail = stale.map((s) => s.detail).join('\n');
      expect(detail).toMatch(/mtime/);
      expect(detail).toMatch(/threshold/);
      expect(detail).toMatch(/stale: \d+s/);
      expect(detail).toMatch(/tshm mtime .+wal mtime/);
    } finally {
      setIntegrityReportSink(null);
    }
    expect(existsSync(tshmPath), 'a masked open must not have moved the sidecar').toBe(true);
  });

  it('warnIfStaleSidecar is informational — never throws, silent on healthy sidecars', () => {
    const dbPath = tempPath('bl373-warn-healthy');
    writeFileSync(dbPath, '');
    writeFileSync(dbPath + '-wal', 'x'.repeat(4096));
    writeFileSync(dbPath + '-tshm', 'y'.repeat(32));

    let emitted = 0;
    setIntegrityReportSink(() => emitted++);
    try {
      // Fresh sidecar: no event, no throw.
      expect(() => warnIfStaleSidecar(dbPath)).not.toThrow();
      // Absent files: no event, no throw.
      expect(() => warnIfStaleSidecar(tempPath('bl373-warn-absent'))).not.toThrow();
      expect(() => warnIfStaleSidecar(undefined)).not.toThrow();
      expect(emitted).toBe(0);

      // Backdated 7 d: one event with evidence.
      backdate(dbPath + '-tshm', WEEK_MS);
      warnIfStaleSidecar(dbPath);
      expect(emitted).toBe(1);
    } finally {
      setIntegrityReportSink(null);
    }
  });
});
