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
 *  1. A mtime-PROVEN stale sidecar is moved over a NON-EMPTY WAL — and only
 *     the `-tshm` moves, never the `-shm`; the store then opens and the data
 *     survives (the exact incident shape, unblocked).
 *  2. The 60 s mtime boundary: backdated 30 s → declined untouched; 90 s →
 *     moved.
 *  3. Shape B (mid-frame truncated WAL): `probeWalFrames` reports truncated;
 *     with `SOX_ALLOW_AUTO_WAL_ASIDE=1` the WAL is renamed `.corrupt-<stamp>`
 *     (preserved) and the store reopens from the last checkpoint; without the
 *     opt-in the operator gets a typed action error. A frame-ALIGNED truncated
 *     WAL is NOT classified as corruption — sidecar moves, WAL stays.
 *  4. The `sidecar_stale` startup warning fires with mtime evidence — including
 *     on a store whose open SUCCEEDS (the masked case).
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
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { TursoAdapterImpl } from '../turso-adapter.js';
import {
  probeWalFrames,
  recoverStaleWalIndex,
  recoverTruncatedWal,
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
// (1) A mtime-PROVEN stale sidecar is reconciled over a NON-EMPTY WAL
// ═══════════════════════════════════════════════════════════════════════════

tursoDescribe('BL-373 — mtime-proven stale -tshm over a non-empty WAL is reconciled (third-recurrence shape)', () => {
  it('moves ONLY the -tshm aside, leaves -shm untouched, and the store opens with data intact', async () => {
    const dbPath = tempPath('bl373-nonempty-wal');
    await seedStore(dbPath);
    const walPath = dbPath + '-wal';
    const tshmPath = dbPath + '-tshm';
    // Precondition: the fixture really is the incident shape — non-empty WAL.
    expect(statSync(walPath).size, 'precondition: WAL must be non-empty').toBeGreaterThan(0);
    expect(existsSync(tshmPath), 'precondition: -tshm must exist').toBe(true);
    // Turso does not create an ordinary -shm under multiprocess WAL, so the
    // only way to assert "never touches -shm on this path" is an
    // empty-but-present fixture (BL-361).
    writeFileSync(dbPath + '-shm', '');
    // Backdate the sidecar 7 days — the incident's mtime gap.
    backdate(tshmPath, WEEK_MS);

    const recovery = recoverStaleWalIndex(dbPath);
    expect(recovery.attempted).toBe(true);
    expect(recovery.movedAside.length).toBe(1);
    expect(recovery.movedAside[0]!.from).toBe(tshmPath);
    expect(recovery.movedAside[0]!.to).toMatch(/-tshm\.stale-\d{4}-\d{2}-\d{2}-\d{4}/);
    expect(
      existsSync(tshmPath),
      'the stale -tshm must be RENAMED (forensics), never deleted — and its original path vacated',
    ).toBe(false);
    expect(existsSync(recovery.movedAside[0]!.to)).toBe(true);
    expect(existsSync(dbPath + '-shm'), 'the -shm must be UNTOUCHED on the mtime path').toBe(true);

    // The fabricated -shm is fixture collateral; remove it before the real
    // open so it cannot artificially perturb the driver.
    unlinkSync(dbPath + '-shm');

    // Full adapter open against the WAL as-is: recovery must have healed it.
    const adapter = track(await TursoAdapterImpl.connect({ dbPath }));
    const rows = await adapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM t');
    expect(rows!.c, 'every row must survive sidecar reconciliation').toBe(SEED_ROWS);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (2) The 60 s mtime boundary
// ═══════════════════════════════════════════════════════════════════════════

tursoDescribe('BL-373 — sidecar staleness is judged against the fixed 60 s threshold', () => {
  it('backdated 30 s (< threshold) → declined untouched; 90 s (> threshold) → moved', () => {
    const dbPath = tempPath('bl373-boundary');
    writeFileSync(dbPath, '');
    writeFileSync(dbPath + '-wal', 'x'.repeat(4096));
    writeFileSync(dbPath + '-tshm', 'y'.repeat(32));

    // 30 s: ambiguous — within the threshold, decline with evidence, no move.
    backdate(dbPath + '-tshm', 30_000);
    const ambiguous = recoverStaleWalIndex(dbPath);
    expect(ambiguous.attempted).toBe(false);
    expect(ambiguous.movedAside).toEqual([]);
    expect(ambiguous.declined).toMatch(/not provably stale/);
    expect(ambiguous.declined).toMatch(/age diff .* ms is within the .* ms staleness threshold/);
    expect(ambiguous.declined).toMatch(/WAL frame probe/);
    expect(existsSync(dbPath + '-tshm'), '30 s backdate must leave the sidecar in place').toBe(true);

    // 90 s: provably stale — moved aside.
    backdate(dbPath + '-tshm', 90_000);
    const stale = recoverStaleWalIndex(dbPath);
    expect(stale.attempted).toBe(true);
    expect(stale.movedAside.length).toBe(1);
    expect(stale.movedAside[0]!.from).toBe(dbPath + '-tshm');
    expect(existsSync(dbPath + '-tshm'), '90 s backdate must move the sidecar').toBe(false);
  });

  it('the threshold is env-tunable and fixed, not proportional', () => {
    const dbPath = tempPath('bl373-threshold-env');
    writeFileSync(dbPath, '');
    writeFileSync(dbPath + '-wal', 'x'.repeat(4096));
    writeFileSync(dbPath + '-tshm', 'y'.repeat(32));
    const prev = process.env.SOX_WAL_SIDECAR_STALE_THRESHOLD_MS;
    try {
      process.env.SOX_WAL_SIDECAR_STALE_THRESHOLD_MS = '10000';
      // 30 s > a 10 s threshold → stale, moved.
      backdate(dbPath + '-tshm', 30_000);
      const moved = recoverStaleWalIndex(dbPath);
      expect(moved.attempted).toBe(true);
      expect(moved.movedAside.length).toBe(1);
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

  it('with SOX_ALLOW_AUTO_WAL_ASIDE=1 the truncated WAL is renamed .corrupt-<stamp> (preserved) and the store reopens from the last checkpoint', async () => {
    const dbPath = tempPath('bl373-shapeb-aside');
    await seedStore(dbPath);
    const walPath = dbPath + '-wal';
    const tshmPath = dbPath + '-tshm';

    // Ground truth: what the database alone holds (the checkpointed state) —
    // read with both WAL and sidecar out of the way first.
    renameSync(walPath, walPath + '.saved');
    renameSync(tshmPath, tshmPath + '.saved');
    const truth = await rawConnect(dbPath);
    const truthCount = (await truth.all('SELECT COUNT(*) AS c FROM t'))[0]!.c as number;
    await truth.close();
    // The truth read re-created a fresh empty sidecar; remove it and restore
    // the WAL so the fixture is exactly "real WAL, no sidecar".
    unlinkSync(tshmPath);
    renameSync(walPath + '.saved', walPath);

    // Shape B: mid-frame truncation, then make the WAL an ORPHAN (older than
    // the database it no longer serves).
    const probe = probeWalFrames(walPath);
    truncateSync(walPath, 32 + 100 * (24 + probe.pageSize!) + 100);
    backdate(walPath, WEEK_MS);
    expect(probeWalFrames(walPath).truncated).toBe(true);

    const prev = process.env.SOX_ALLOW_AUTO_WAL_ASIDE;
    try {
      process.env.SOX_ALLOW_AUTO_WAL_ASIDE = '1';
      const recovery = recoverTruncatedWal(dbPath);
      expect(recovery.attempted).toBe(true);
      expect(recovery.declined).toBeNull();
      expect(recovery.movedAside.length).toBe(1);
      expect(recovery.movedAside[0]!.from).toBe(walPath);
      expect(recovery.movedAside[0]!.to).toMatch(/-wal\.corrupt-\d{4}-\d{2}-\d{2}-\d{4}/);
      expect(existsSync(recovery.movedAside[0]!.to), 'the WAL must be preserved for forensics').toBe(true);
      expect(existsSync(walPath), 'the original WAL path must be vacated').toBe(false);
    } finally {
      if (prev === undefined) delete process.env.SOX_ALLOW_AUTO_WAL_ASIDE;
      else process.env.SOX_ALLOW_AUTO_WAL_ASIDE = prev;
    }

    // Reopen: with the WAL gone, the store reads from the last checkpoint.
    const adapter = track(await TursoAdapterImpl.connect({ dbPath }));
    const rows = await adapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM t');
    expect(rows!.c, 'reopen must return exactly the checkpointed state').toBe(truthCount);
  });

  it('without the opt-in the WAL is NOT moved and the operator gets the typed action', async () => {
    const dbPath = tempPath('bl373-shapeb-noaside');
    await seedStore(dbPath);
    const walPath = dbPath + '-wal';
    // Remove the sidecar (post-sidecar-move state) and truncate mid-frame.
    renameSync(dbPath + '-tshm', dbPath + '-tshm.gone');
    const probe = probeWalFrames(walPath);
    truncateSync(walPath, 32 + 100 * (24 + probe.pageSize!) + 100);
    backdate(walPath, WEEK_MS);

    const recovery = recoverTruncatedWal(dbPath);
    expect(recovery.attempted).toBe(false);
    expect(recovery.movedAside).toEqual([]);
    expect(recovery.declined).toMatch(/SOX_ALLOW_AUTO_WAL_ASIDE/);
    expect(recovery.declined).toMatch(/mv .*\.corrupt-<stamp>/);
    expect(existsSync(walPath), 'the WAL must stay put without the opt-in').toBe(true);
  });

  it('a truncated WAL with a FRESH sidecar is genuinely ambiguous → declined, and the adapter error names both the evidence and the operator action', async () => {
    const dbPath = tempPath('bl373-shapeb-ambiguous');
    await seedStore(dbPath);
    // Fresh sidecar (unchanged mtime) + mid-frame truncated WAL.
    const walPath = dbPath + '-wal';
    const probe = probeWalFrames(walPath);
    truncateSync(walPath, 32 + 100 * (24 + probe.pageSize!) + 100);

    let errorMessage = '';
    try {
      await TursoAdapterImpl.connect({ dbPath });
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }
    expect(errorMessage, 'the ambiguous Shape B must decline to the operator').not.toBe('');
    expect(errorMessage).toMatch(/-tshm/);
    expect(errorMessage).toMatch(/not provably stale/);
    expect(errorMessage).toMatch(/TRUNCATED/);
    expect(errorMessage).toMatch(/SOX_ALLOW_AUTO_WAL_ASIDE/);
    expect(errorMessage).toMatch(/\.corrupt-<stamp>/);
    expect(existsSync(walPath), 'the WAL must not be moved without the opt-in').toBe(true);
    expect(existsSync(dbPath + '-tshm'), 'a fresh sidecar must not be moved either').toBe(true);
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

    // Backdate the sidecar: recovery must still move ONLY the -tshm and never
    // touch the frame-aligned WAL (Shape A is not evidence of corruption).
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
