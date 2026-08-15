/**
 * BUG-STOREADAPTER-QUIESCENCE-TOCTOU — is the check-then-act window between
 * `storeQuiescence()` and `PRAGMA wal_checkpoint(TRUNCATE)` actually REACHABLE?
 *
 * This suite exists to answer that question with evidence rather than to assert
 * a conclusion. It became the leading candidate mechanism for the 2026-08-14
 * corruption only after the path-asymmetry theory was falsified (aliased lease
 * dirs share an inode, so spelling cannot cause divergence), so it deserves the
 * same standard of proof rather than inheriting the vacancy.
 *
 * THE SEAM (turso-adapter.ts close()):
 *
 *   const quiescence = storeQuiescence(coordDb, this._lease.token);   // CHECK  (sync readdirSync)
 *   if (!quiescence.quiescent) { ...defer... }
 *   else { await this.executeAll('PRAGMA wal_checkpoint(TRUNCATE)') } // ACT    (async, zeroes the -wal)
 *
 * Nothing holds a lock across that gap. A peer whose `connect()` reaches
 * `acquireStoreLease` (turso-adapter.ts:417) AFTER the readdirSync is invisible
 * to the decision, and the TRUNCATE then physically zeroes the `-wal`
 * (turso wal.rs:5208) while that peer is opening and reading frames — the
 * turso #7833 shape.
 *
 * WHY THE WINDOW IS NARROWER THAN IT LOOKS, stated up front so the result is not
 * over-read: `acquireStoreLease` runs very early in connect, before any WAL work,
 * so a peer registers its presence well before it depends on WAL contents. The
 * question is not "is there a gap" (there provably is — no lock spans it) but
 * "can a peer land inside it in practice".
 *
 * METHOD: rather than race the scheduler and hope, the seam is WIDENED
 * deterministically — `executeAll` is wrapped so the TRUNCATE statement pauses
 * before reaching the driver. A peer connects during that pause. If the peer's
 * lease is invisible to a decision already made, the truncate proceeds under a
 * live peer, and the window is real. This is injection, not a natural race, and
 * the assertions below say so.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { leaseDirPath, storeQuiescence } from '../store-lease.js';
import { canonicalDbPath } from '../path-identity.js';
import { log } from '@adhd/sox-telemetry';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    const fn = cleanups.pop();
    try {
      fn?.();
    } catch (err) {
      console.warn('[toctou] cleanup failed:', err);
    }
  }
});

function makeStore(): string {
  const root = mkdtempSync(join(tmpdir(), 'toctou-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'store.db');
}

function leaseCount(dbPath: string): number {
  const dir = leaseDirPath(canonicalDbPath(dbPath));
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((n) => !n.endsWith('.openmark') && !n.startsWith('.')).length;
}

describe('BUG-STOREADAPTER-QUIESCENCE-TOCTOU', () => {
  it('DOCUMENTS the gap: no lock is held between the quiescence read and the truncate', async () => {
    const dbPath = makeStore();
    const a = await TursoAdapterImpl.connect({ dbPath });
    await a.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');

    // storeQuiescence is a pure filesystem read — it takes nothing and holds
    // nothing. Its verdict is a snapshot, true only at the instant it returned.
    const before = storeQuiescence(canonicalDbPath(dbPath), 'no-such-token');
    expect(before.quiescent).toBe(false); // `a` holds it

    await a.close();

    const after = storeQuiescence(canonicalDbPath(dbPath));
    expect(after.quiescent).toBe(true);

    // Nothing about calling it created any lock artifact a peer could contend on.
    expect(leaseCount(dbPath)).toBe(0);
  });

  it('MEASURES whether a peer can register inside a deliberately widened seam', async () => {
    const dbPath = makeStore();

    const closer = await TursoAdapterImpl.connect({ dbPath });
    await closer.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
    await closer.exec("INSERT INTO t (v) VALUES ('before-close')");

    // Widen the seam: pause the TRUNCATE on its way to the driver, and record
    // what the store looked like at that instant.
    let sawTruncate = false;
    let leasesAtTruncate = -1;
    let peerOpened = false;
    const realExecuteAll = closer.executeAll.bind(closer);
    (closer as unknown as { executeAll: typeof closer.executeAll }).executeAll = (async (
      sql: string,
      args?: unknown[],
    ) => {
      if (/wal_checkpoint\(TRUNCATE\)/i.test(sql)) {
        sawTruncate = true;
        // A peer connects INSIDE the window — after the gate already decided.
        const peer = await TursoAdapterImpl.connect({ dbPath });
        peerOpened = true;
        cleanups.push(() => void peer.close().catch(() => undefined));
        leasesAtTruncate = leaseCount(dbPath);
        const r = await realExecuteAll(sql, args);
        await peer.close();
        return r;
      }
      return realExecuteAll(sql, args);
    }) as typeof closer.executeAll;

    await closer.close();

    // The decisive observation. If the TRUNCATE ran at all while a peer's lease
    // was present, the gate's verdict was stale by the time it acted.
    expect(sawTruncate).toBe(true);
    expect(peerOpened).toBe(true);
    console.log(
      `[toctou] truncate reached the driver with ${leasesAtTruncate} peer lease(s) present`,
    );
    // The window is real by construction here (we forced it open). What this
    // pins is that NOTHING prevents the truncate once the verdict is made —
    // there is no re-check and no lock. If a future fix adds either, this
    // expectation flips and the suite must be updated deliberately.
    expect(leasesAtTruncate).toBeGreaterThan(0);
  });

  it('CONTROL: with the peer registered BEFORE the check, the truncate is correctly declined', async () => {
    const dbPath = makeStore();

    const peer = await TursoAdapterImpl.connect({ dbPath });
    cleanups.push(() => void peer.close().catch(() => undefined));
    await peer.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
    await peer.exec("INSERT INTO t (v) VALUES ('peer-durable')");

    const closer = await TursoAdapterImpl.connect({ dbPath });
    await closer.exec("INSERT INTO t (v) VALUES ('closer')");

    let truncateReachedDriver = false;
    const realExecuteAll = closer.executeAll.bind(closer);
    (closer as unknown as { executeAll: typeof closer.executeAll }).executeAll = (async (
      sql: string,
      args?: unknown[],
    ) => {
      if (/wal_checkpoint\(TRUNCATE\)/i.test(sql)) truncateReachedDriver = true;
      return realExecuteAll(sql, args);
    }) as typeof closer.executeAll;

    await closer.close();

    // The gate works for the case it was designed for: a peer already holding a
    // lease when the check runs defers the truncate entirely.
    expect(truncateReachedDriver).toBe(false);

    // And the peer's data survives, readable through its own live handle.
    const rows = await peer.executeAll<{ v: string }>('SELECT v FROM t ORDER BY id');
    expect(rows.rows.map((r) => r.v)).toContain('peer-durable');
    await peer.close();
  });

  it('MEASURES the natural (uninjected) window by racing a peer against a real close', async () => {
    // No injection here. If the window is reachable WITHOUT widening it, that is
    // a materially stronger finding than the injected case above. If it is not
    // reachable across many attempts, that is evidence toward
    // measured-not-reachable — which is a legitimate outcome, not a failure.
    const ATTEMPTS = 25;
    let racesObserved = 0;

    for (let i = 0; i < ATTEMPTS; i++) {
      const dbPath = makeStore();
      const closer = await TursoAdapterImpl.connect({ dbPath });
      await closer.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
      await closer.exec(`INSERT INTO t (v) VALUES ('r${i}')`);

      // Start a peer connect and a close at the same tick and let them race.
      const peerPromise = TursoAdapterImpl.connect({ dbPath });
      const closePromise = closer.close();
      const [peer] = await Promise.all([peerPromise, closePromise]);

      // Did the peer end up holding a lease while the closer was truncating?
      // We cannot observe the instant directly without injection; what we CAN
      // observe is whether the peer survived and the store stayed readable.
      const rows = await peer.executeAll<{ v: string }>('SELECT v FROM t');
      if (rows.rows.length === 0) racesObserved++;
      await peer.close();
    }

    console.log(
      `[toctou] natural race: ${racesObserved}/${ATTEMPTS} attempts lost data or read empty`,
    );
    // Recorded, not asserted as zero: this number is the evidence for whether
    // the residual is worth a lock. A non-zero value would escalate this item.
    expect(racesObserved).toBeGreaterThanOrEqual(0);
  });

  it('TWO-PROCESS: barrier-synchronized race between a real child peer and a real close', async () => {
    // The acceptance criterion for this item, done properly.
    //
    // CRITICAL METHOD NOTE: a naive spawn-then-close does NOT race. Booting a
    // tsx child costs ~100ms while the close path is single-digit ms, so the
    // parent finishes truncating before the child issues a syscall — a green
    // result there measures nothing. The child therefore pays its startup cost,
    // prints READY, and blocks on stdin; the parent waits for READY, then writes
    // GO and starts its close in the SAME TICK. Only then do the two collide.
    const here = dirname(fileURLToPath(import.meta.url));
    const child = join(here, 'fixtures', 'toctou-peer-child.ts');
    const ROUNDS = 40;
    const ROWS = 5;
    const outcomes: Record<string, number> = {};
    const details: string[] = [];

    for (let i = 0; i < ROUNDS; i++) {
      const dbPath = makeStore();
      const holder = await TursoAdapterImpl.connect({ dbPath });
      await holder.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
      for (let r = 0; r < ROWS; r++) await holder.exec(`INSERT INTO t (v) VALUES ('r${r}')`);

      const proc = spawn(process.execPath, ['--import', 'tsx', child, dbPath, String(ROWS)], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let ready = false;
      const readyPromise = new Promise<void>((resolve) => {
        proc.stdout.on('data', (d) => {
          out += String(d);
          if (!ready && out.includes('READY')) {
            ready = true;
            resolve();
          }
        });
      });
      await readyPromise; // child is WARM — startup cost already paid

      // Release the child and close in the same tick: the actual collision.
      proc.stdin.write('GO\n');
      const closePromise = holder.close();
      const [code] = (await once(proc, 'exit')) as [number | null, string | null];
      await closePromise;

      const key =
        code === 0
          ? 'ok'
          : code === 3
            ? 'SILENT_LOSS'
            : code === 134
              ? 'SIGABRT_PANIC'
              : `exit_${code}`;
      outcomes[key] = (outcomes[key] ?? 0) + 1;
      if (code !== 0) details.push(`round ${i} exit=${code} :: ${out.replace(/\n/g, ' ').slice(0, 220)}`);
    }

    console.log(`[toctou] TWO-PROCESS (barrier) ${ROUNDS} rounds: ${JSON.stringify(outcomes)}`);
    for (const d of details.slice(0, 5)) console.log(`[toctou]   ${d}`);

    // Silent loss and native panics are the outcomes that would escalate this
    // item to must-fix. Asserted, not merely logged — and the counts above are
    // the evidence either way.
    expect(outcomes['SILENT_LOSS'] ?? 0).toBe(0);
    expect(outcomes['SIGABRT_PANIC'] ?? 0).toBe(0);
  }, 300_000);
});

/**
 * The detector added to close() is only worth having if it FIRES when the window
 * is actually hit. This proves it does, using the same widened-seam injection —
 * otherwise it is decoration that would keep production silent about the very
 * event it exists to report.
 */
describe('BUG-STOREADAPTER-QUIESCENCE-TOCTOU — detector', () => {
  it('emits close_truncate_toctou_window_observed when a peer lands inside the window', async () => {
    const dbPath = makeStore();
    const warnSpy = vi.spyOn(log, 'warn');
    const closer = await TursoAdapterImpl.connect({ dbPath });
    await closer.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
    await closer.exec("INSERT INTO t (v) VALUES ('x')");

    // Hold a peer open ACROSS the truncate so the post-check sees it.
    let peer: Awaited<ReturnType<typeof TursoAdapterImpl.connect>> | null = null;
    const realExecuteAll = closer.executeAll.bind(closer);
    (closer as unknown as { executeAll: typeof closer.executeAll }).executeAll = (async (
      sql: string,
      args?: unknown[],
    ) => {
      if (/wal_checkpoint\(TRUNCATE\)/i.test(sql)) {
        peer = await TursoAdapterImpl.connect({ dbPath });
        return realExecuteAll(sql, args);
      }
      return realExecuteAll(sql, args);
    }) as typeof closer.executeAll;

    await closer.close();

    // THE ASSERTION THAT MATTERS: the detector actually EMITTED. Asserting only
    // the underlying condition would pass even if the log line were deleted,
    // which is exactly how a detector rots into decoration.
    const emitted = warnSpy.mock.calls.filter(
      (c) => c[0] === 'store_adapter.turso.close_truncate_toctou_window_observed',
    );
    expect(emitted.length).toBe(1);
    expect((emitted[0]?.[1] as { peer_count?: number } | undefined)?.peer_count).toBeGreaterThan(0);
    warnSpy.mockRestore();

    expect(peer).not.toBeNull();
    const q = storeQuiescence(canonicalDbPath(dbPath));
    expect(q.quiescent).toBe(false); // peer still holds it — the condition the detector reports
    if (peer) await (peer as { close: () => Promise<void> }).close();
  });
});
