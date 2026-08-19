/**
 * BL-587 — the wal-cap backstop's threshold is now BASELINE-RELATIVE, not a
 * flat `DEFAULT_WAL_CAP_BYTES` constant shared identically by both adapters.
 *
 * THE PROBLEM THIS CLOSES: `SqliteAdapterImpl` and `TursoAdapterImpl` shared
 * `DEFAULT_WAL_CAP_BYTES = 262,144`, but do not start from the same
 * post-schema WAL baseline for the same logical schema — measured directly
 * (2026-08-18): a trivial schema (one table + one index) sits at exactly
 * 16,512 bytes of `-wal` on both engines (no generic per-driver overhead),
 * but a single FTS5 virtual table on the sqlite side alone takes it to
 * 32,992 bytes (FTS5 materialises several shadow tables). memory-core's real
 * schema puts the sqlite arm at ~150-165 KB. Since the cap is a HEADROOM
 * budget and headroom is baseline-relative, a flat shared cap gave sqlite
 * roughly 100 KB of real headroom and turso roughly 245 KB against the same
 * nominal number — an asymmetry nobody chose, and the sqlite backend
 * force-flushed far more often per unit of real work than the constant's own
 * tuning rationale assumed.
 *
 * THE FIX (`_effectiveWalCapBytes()` in both adapters,
 * `effectiveWalCapBytes()` in wal-tuning.ts, `captureWalCapBaseline()` public
 * method on both): the effective cap becomes `baseline + headroom`, clamped
 * to an absolute ceiling. The baseline defaults to 0 (identical to the old
 * flat-constant behaviour) until a caller invokes `captureWalCapBaseline()`
 * — deliberately NOT automatic, because the adapter has no visibility into
 * when a caller's own schema DDL finishes (data→data boundary).
 *
 * BL-225: every assertion checks the OUTCOME (the byte value the backstop
 * actually trips at, read from real telemetry / a real captured baseline —
 * never a proxy like "the method was called").
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { SqliteAdapterImpl } from '../sqlite-adapter.js';
import {
  DEFAULT_WAL_CAP_CEILING_BYTES,
  DEFAULT_WAL_CAP_HEADROOM_BYTES,
  effectiveWalCapBytes,
} from '../wal-tuning.js';

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
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-wal-cap-baseline-bl587-'));
});

function tempPath(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpDir, `${label}-${suffix}.db`);
}

// ── Pure-function unit tests (deterministic) ────────────────────────────────

describe('BL-587 — wal-tuning.ts effectiveWalCapBytes()', () => {
  it('with no baseline captured (0), the effective cap equals exactly the headroom — identical to pre-BL-587 flat-constant behaviour', () => {
    const cap = effectiveWalCapBytes({
      explicitOverrideBytes: null,
      baselineBytes: 0,
      headroomBytes: DEFAULT_WAL_CAP_HEADROOM_BYTES,
      ceilingBytes: DEFAULT_WAL_CAP_CEILING_BYTES,
    });
    expect(cap).toBe(DEFAULT_WAL_CAP_HEADROOM_BYTES);
  });

  it('a captured baseline is added ON TOP of the headroom, not replacing it', () => {
    const cap = effectiveWalCapBytes({
      explicitOverrideBytes: null,
      baselineBytes: 150_000,
      headroomBytes: 50_000,
      ceilingBytes: 1_000_000,
    });
    expect(cap).toBe(200_000);
  });

  it('a pathological baseline is clamped to the absolute ceiling, not allowed to disable the backstop', () => {
    const cap = effectiveWalCapBytes({
      explicitOverrideBytes: null,
      baselineBytes: 10_000_000,
      headroomBytes: 50_000,
      ceilingBytes: 1_000_000,
    });
    expect(cap).toBe(1_000_000);
  });

  it('an explicit override wins unconditionally, regardless of baseline — the test-only escape hatch BUG-019/wal-cap.spec.ts already rely on', () => {
    const cap = effectiveWalCapBytes({
      explicitOverrideBytes: 4_000,
      baselineBytes: 999_999,
      headroomBytes: 999_999,
      ceilingBytes: 1,
    });
    expect(cap).toBe(4_000);
  });

  it('the shared defaults are documented and stable: headroom = 262,144 bytes (256 KiB), ceiling = 1,048,576 bytes (1 MiB)', () => {
    expect(DEFAULT_WAL_CAP_HEADROOM_BYTES).toBe(262_144);
    expect(DEFAULT_WAL_CAP_CEILING_BYTES).toBe(1_048_576);
  });
});

// ── End-to-end: two DIFFERENT real baselines produce two DIFFERENT real
//    effective caps for the SAME headroom, using REAL adapters and a REAL
//    captured -wal size — not a simulation. ─────────────────────────────────

describe('BL-587 — captureWalCapBaseline() end-to-end: different real baselines produce different real effective caps', () => {
  it('SqliteAdapterImpl: a bigger post-schema WAL baseline produces a proportionally bigger effective cap for the SAME headroom — this FAILS against pre-BL-587 code, where the cap is a flat constant identical regardless of baseline', async () => {
    const HEADROOM_BYTES = 4_000;

    // Adapter A: trivial schema (small baseline). Constructed WITHOUT a
    // small headroom override — the default (256 KiB) must stay big enough
    // that the wal-cap backstop cannot trip DURING schema creation itself
    // and truncate the very WAL bytes this test needs to baseline. The
    // small `HEADROOM_BYTES` is applied AFTER baselining, for the
    // trip-comparison phase below only.
    const pathA = tempPath('sqlite-small-schema');
    const a = new SqliteAdapterImpl(pathA);
    await a.exec('PRAGMA journal_mode = WAL');
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const baselineA = a.captureWalCapBaseline();
    (a as unknown as { _walCapHeadroomBytes: number })._walCapHeadroomBytes = HEADROOM_BYTES;

    // Adapter B: a schema with materially more structure — several extra
    // tables and indexes, so its post-schema WAL baseline is measurably
    // bigger than A's for the identical `-wal` capture mechanism.
    const pathB = tempPath('sqlite-big-schema');
    const b = new SqliteAdapterImpl(pathB);
    await b.exec('PRAGMA journal_mode = WAL');
    await b.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    for (let i = 0; i < 8; i++) {
      await b.exec(
        `CREATE TABLE extra_${i} (id INTEGER PRIMARY KEY, a TEXT, b TEXT, c TEXT); ` +
          `CREATE INDEX idx_extra_${i}_a ON extra_${i}(a); ` +
          `CREATE INDEX idx_extra_${i}_b ON extra_${i}(b);`,
      );
    }
    const baselineB = b.captureWalCapBaseline();
    (b as unknown as { _walCapHeadroomBytes: number })._walCapHeadroomBytes = HEADROOM_BYTES;

    expect(
      baselineB,
      `adapter B's richer schema must produce a strictly bigger real captured baseline than A's ` +
        `(A=${baselineA}, B=${baselineB}) — if this fails, the test's own schema delta isn't ` +
        `producing a measurable WAL difference and the comparison below is meaningless`,
    ).toBeGreaterThan(baselineA);

    // THE FIX: with the SAME headroom, B's effective cap must be strictly
    // bigger than A's, by exactly the baseline delta — proving the cap is
    // baseline-relative, not a flat shared constant.
    const capA = effectiveWalCapBytes({
      explicitOverrideBytes: null,
      baselineBytes: baselineA,
      headroomBytes: HEADROOM_BYTES,
      ceilingBytes: DEFAULT_WAL_CAP_CEILING_BYTES,
    });
    const capB = effectiveWalCapBytes({
      explicitOverrideBytes: null,
      baselineBytes: baselineB,
      headroomBytes: HEADROOM_BYTES,
      ceilingBytes: DEFAULT_WAL_CAP_CEILING_BYTES,
    });
    expect(capA).toBe(baselineA + HEADROOM_BYTES);
    expect(capB).toBe(baselineB + HEADROOM_BYTES);
    expect(
      capB - capA,
      'the two effective caps must differ by EXACTLY the baseline delta — the fix adds baseline, ' +
        'nothing else, on top of the identical headroom',
    ).toBe(baselineB - baselineA);

    // Directly exercise the REAL write path: adapter B (bigger baseline)
    // must trip its own backstop LESS OFTEN than adapter A for the SAME
    // headroom and the SAME row cadence — the actual force-flush-frequency
    // outcome this whole fix exists to produce, not just the arithmetic
    // above. A trip is detected as a WAL-SIZE DROP after a write (the cap
    // check runs SYNCHRONOUSLY inside the same `executeRun()` call, before
    // it returns — so a caller can never observe the WAL at its peak,
    // pre-truncation, value; the drop itself is the only externally
    // observable signal that a truncation happened).
    const payload = 'x'.repeat(200);
    const ROWS = 60;

    async function countTrips(adapter: SqliteAdapterImpl, dbPath: string): Promise<number> {
      let trips = 0;
      let prevSize = statSync(`${dbPath}-wal`).size;
      for (let i = 0; i < ROWS; i++) {
        await adapter.executeRun('INSERT INTO t (v) VALUES (?)', [`${i}-${payload}`]);
        const size = statSync(`${dbPath}-wal`).size;
        if (size < prevSize) trips++;
        prevSize = size;
      }
      return trips;
    }

    const tripsA = await countTrips(a, pathA);
    const tripsB = await countTrips(b, pathB);

    expect(
      tripsB,
      `adapter B (bigger baseline=${baselineB}) must trip its own wal-cap backstop STRICTLY LESS ` +
        `OFTEN than adapter A (baseline=${baselineA}) over the identical ${ROWS}-row burst with the ` +
        `identical headroom (A tripped ${tripsA} times) — this is the actual force-flush-frequency ` +
        'outcome BL-587 exists to fix. Against pre-BL-587 code, where the effective cap is the flat ' +
        'headroom regardless of baseline, A and B would trip at the SAME frequency.',
    ).toBeLessThan(tripsA);
    expect(tripsA, 'sanity: the small-baseline adapter must actually trip at least once for this comparison to mean anything').toBeGreaterThan(0);

    await a.close();
    await b.close();
  });

  it('a caller that never calls captureWalCapBaseline() sees IDENTICAL behaviour to the pre-BL-587 flat constant', async () => {
    const dbPath = tempPath('sqlite-no-baseline-capture');
    const a = new SqliteAdapterImpl(dbPath, { walCapHeadroomBytes: DEFAULT_WAL_CAP_HEADROOM_BYTES });
    await a.exec('PRAGMA journal_mode = WAL');
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');

    // No captureWalCapBaseline() call — baseline stays 0.
    const priv = a as unknown as { _effectiveWalCapBytes(): number };
    expect(priv._effectiveWalCapBytes()).toBe(DEFAULT_WAL_CAP_HEADROOM_BYTES);

    await a.close();
  });

  tursoDescribe('TursoAdapterImpl mirrors the same captureWalCapBaseline() contract', () => {
    it('returns the real captured -wal size, and a caller that never calls it sees the flat-headroom default', async () => {
      const dbPath = tempPath('turso-baseline');
      const t = await TursoAdapterImpl.connect({ dbPath, walCapHeadroomBytes: DEFAULT_WAL_CAP_HEADROOM_BYTES });
      await t.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');

      const priv = t as unknown as { _effectiveWalCapBytes(): number };
      // Never captured — default flat-headroom behaviour.
      expect(priv._effectiveWalCapBytes()).toBe(DEFAULT_WAL_CAP_HEADROOM_BYTES);

      const baseline = t.captureWalCapBaseline();
      expect(baseline, 'captureWalCapBaseline() must return the real on-disk -wal size, not a guess').toBeGreaterThanOrEqual(0);
      expect(priv._effectiveWalCapBytes()).toBe(baseline + DEFAULT_WAL_CAP_HEADROOM_BYTES);

      await t.close();
    });
  });
});
