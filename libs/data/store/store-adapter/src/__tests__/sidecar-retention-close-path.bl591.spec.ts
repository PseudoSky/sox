/**
 * sidecar-retention-close-path.bl591.spec.ts — BL-591 (second fix).
 *
 * The first BL-591 fix attached the retention sweep to `_openReal()`'s
 * pre-open proactive reconcile branch (later hoisted by a follow-up commit
 * to run unconditionally on every open, not just when that open's own
 * reconcile moved something). Live memory-server telemetry for 2026-08-18
 * showed the sweep NEVER ran in production even after that hoist — the
 * marker file `~/.memory/memory.db.sidecar-sweep-marker` did not exist after
 * a restart onto the fixed artifact, and zero `sidecar_sweep` events of any
 * kind appeared, while `close_tshm_reset` (the close()-TRUNCATE path,
 * `resetTshmAfterTruncate()` — the actual debris producer) fired 543 times.
 * Whatever gates a long-lived server's real reopens from ever reaching
 * `_openReal()`'s pre-open block in practice, `close()` itself is
 * unambiguously reached every time (that's what `close_tshm_reset` proves).
 *
 * This spec therefore hooks the sweep DIRECTLY into `resetTshmAfterTruncate()`
 * — the confirmed producer — so it fires exactly when new debris is created,
 * with no dependency on whether any subsequent open ever happens or reaches
 * the pre-open block at all.
 *
 * ISOLATION: an EARLIER version of this spec seeded old debris BEFORE the
 * store's first open and asserted it was gone after a single connect/write/
 * close cycle — and that version passed even with the close-path hook
 * temporarily disabled, because the (already unconditional) pre-open hook
 * caught the pre-seeded debris on that very first open, before the close
 * path ever got involved. That was a false-positive test — exactly the
 * "green gates, inert production" shape this fix exists to rule out. This
 * version seeds the old debris AFTER the only open in the test and performs
 * no further open before asserting — so nothing but `close()` can be
 * responsible for what gets pruned.
 *
 * RED (confirmed by temporarily removing the sweep call from
 * `resetTshmAfterTruncate()` — see the paired manual verification recorded
 * on the BL-591 backlog item): the post-open-seeded old debris survives
 * untouched and no `sidecar_sweep_pruned` event fires, because `close()` is
 * the only code path exercised after seeding and it did not sweep.
 * GREEN (this file, run against the current turso-adapter.ts): the old
 * debris is pruned by that same `close()` call and the event fires.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { log } from '@adhd/sox-telemetry';
import { TursoAdapterImpl } from '../turso-adapter.js';

const require = createRequire(import.meta.url);

const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();

const tursoDescribe = hasTurso ? describe : describe.skip;

function staleSidecars(dbPath: string): string[] {
  const dir = dbPath.slice(0, dbPath.lastIndexOf('/'));
  const base = dbPath.slice(dbPath.lastIndexOf('/') + 1);
  try {
    return readdirSync(dir).filter((f) => f.startsWith(`${base}-tshm.stale-`));
  } catch {
    return [];
  }
}

/** Seed a synthetic OLD `.stale-*` sidecar with a valid, genuinely old rename stamp. */
function seedOldStaleSidecar(dbPath: string, daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  const stamp = d.toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const p = `${dbPath}-tshm.stale-${stamp}`;
  writeFileSync(p, 'synthetic-old-sidecar');
  return p;
}

let tmpDir: string;
let prevThrottle: string | undefined;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-bl591-closepath-'));
  prevThrottle = process.env['SOX_SIDECAR_SWEEP_THROTTLE_MS'];
  // Test-only: run the sweep on this close instead of waiting out the real
  // 10-minute production throttle. staleSidecarSweepThrottleMs() reads this
  // at CALL time, so it's safe to set once here.
  process.env['SOX_SIDECAR_SWEEP_THROTTLE_MS'] = '0';
});

afterAll(() => {
  if (prevThrottle === undefined) delete process.env['SOX_SIDECAR_SWEEP_THROTTLE_MS'];
  else process.env['SOX_SIDECAR_SWEEP_THROTTLE_MS'] = prevThrottle;
  rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function tempPath(label: string): string {
  return join(tmpDir, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}

tursoDescribe(
  'BL-591 (second fix) — the close()-TRUNCATE path is the real producer, and now also the collector',
  () => {
    it(
      'RED→GREEN: debris seeded AFTER the only open is pruned by close() alone, with no subsequent open to attribute it to',
      async () => {
        const dbPath = tempPath('bl591-closepath');

        // Step 1: the ONLY open in this test. Nothing to reconcile yet (no
        // sidecar debris exists at all) — this establishes the live db/-wal/
        // -tshm and writes one row, nothing more.
        const adapter = await TursoAdapterImpl.connect({ dbPath });
        await adapter.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
        await adapter.executeRun('INSERT INTO t (v) VALUES (?)', ['row-1']);

        // Step 2: seed 25 synthetic OLD sidecars AFTER the open above —
        // simulating debris that accumulated from unrelated prior activity
        // (other processes, earlier sessions) while THIS adapter instance
        // has been live the whole time, exactly the long-lived-server shape.
        // Spread across distinct real days so every filename is unique
        // (production's rename stamp has minute granularity; two seeds
        // landing in the same minute would collide on the identical
        // filename and silently overwrite each other — an unrelated,
        // pre-existing property of the stamp format, not of the policy
        // under test) and every one is WAY beyond the 3-day default age cap.
        const seeded: string[] = [];
        for (let i = 0; i < 25; i++) {
          seeded.push(seedOldStaleSidecar(dbPath, 10 + i));
        }
        expect(staleSidecars(dbPath).length, 'precondition: 25 old sidecars seeded').toBe(25);

        const infoSpy = vi.spyOn(log, 'info');

        // Step 3: close(). No open of ANY kind happens between the seeding
        // above and this call, and none happens between this call and the
        // assertions below — so `_openReal()`'s pre-open reconcile
        // structurally CANNOT be what touches the seeded debris. Only
        // `close()` -> `resetTshmAfterTruncate()` can.
        await adapter.close();

        // GROUND TRUTH #1: the seeded old debris is gone — pruned by
        // close() alone.
        for (const old of seeded) {
          expect(existsSync(old), `pre-seeded old sidecar ${old} must have been pruned by close()`).toBe(
            false,
          );
        }
        const survivors = staleSidecars(dbPath);
        expect(
          survivors.length,
          `only the fresh artefact from this close's own TRUNCATE should survive; found: ${JSON.stringify(survivors)}`,
        ).toBe(1);

        // GROUND TRUTH #2: the collector observably ran — a real
        // sidecar_sweep_pruned log event, not an inference from file counts.
        const pruneCalls = infoSpy.mock.calls.filter(
          ([event]) => event === 'store_adapter.turso.sidecar_sweep_pruned',
        );
        expect(
          pruneCalls.length,
          `expected a sidecar_sweep_pruned event from close(); log.info events seen: ` +
            JSON.stringify(infoSpy.mock.calls.map((c) => c[0])),
        ).toBeGreaterThan(0);
        const detail = String((pruneCalls[0]?.[1] as { detail?: unknown } | undefined)?.detail ?? '');
        expect(detail).toMatch(/pruned 25 stale WAL-index sidecar/);

        // GROUND TRUTH #3: the store is fully intact and functional — the
        // sweep must never touch the live db/-wal/-shm/-tshm files. A fresh
        // open now (AFTER all assertions above, so it cannot contaminate
        // them) proves the data survived.
        const finalAdapter = await TursoAdapterImpl.connect({ dbPath });
        try {
          const cnt = await finalAdapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM t');
          expect(cnt!.c, 'the row written before close() must have survived').toBe(1);
        } finally {
          await finalAdapter.close();
        }
        expect(existsSync(dbPath), 'the live db file must never be touched by the sweep').toBe(true);
      },
      30_000,
    );
  },
);
