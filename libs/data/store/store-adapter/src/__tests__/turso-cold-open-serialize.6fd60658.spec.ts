/**
 * 6fd60658 — concurrent multiprocess cold opens of ONE turso store must never
 * panic.
 *
 * THE DEFECT: `@tursodatabase/database` 0.7.1/0.7.2 aborts in Rust with
 *   panicked at core/storage/shared_wal_coordination.rs:1644:9
 * when many processes perform the real open of the same never-before-opened
 * store at once. The panic is uncatchable (it aborts the process), so the
 * adapter's bounded open retry cannot help. Measured on this tree before the
 * fix, 16–24 simultaneous cold opens per path: 4/1920 and 2/960 processes
 * died with that panic, and this suite with the lock disabled saw 7 panics
 * (15 nonzero exits) in 1536 processes. With the lock: 0/1536. 0.7.2's 14 commits do not touch the
 * coordination code, and 0.8.0 is prerelease only.
 *
 * THE FIX: `acquireColdOpenLock` (cold-open-lock.ts) serializes the adapter's
 * real open + open-time WAL-coordination init of a path across processes.
 *
 * METHOD: genuine OS processes (a Rust panic cannot be observed in-process),
 * spawned without a barrier, WAVE_SIZE at a time against one fresh path per
 * wave. The panic rate is ~0.1–0.3 % per process, so the suite runs WAVES ×
 * WAVE_SIZE ≈ 1500 processes: at the measured base rate the chance of an
 * unfixed tree producing zero panics is well under 5 %.
 *
 * NEGATIVE CONTROL (run manually, reported with the change — not automated,
 * since it needs a temporary production edit and an env toggle is banned by
 * ADR-0013): with the `acquireColdOpenLock` call in `_openReal` removed, this
 * suite fails with `shared_wal_coordination.rs:1644` panics.
 *
 * The second block covers the lock's own contract: a dead holder never wedges
 * an open, a live holder is waited for with a bound, and release never
 * deletes a successor's lock.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { log } from '@adhd/sox-telemetry';
import { acquireColdOpenLock, coldOpenLockPath, COLD_OPEN_LOCK_STALE_MS } from '../cold-open-lock.js';
import { leaseDirPath } from '../store-lease.js';

const hasTurso = (() => {
  try {
    createRequire(import.meta.url).resolve('@tursodatabase/database');
    return true;
  } catch (err) {
    log.warn('store_adapter.test.6fd60658.turso_unresolvable', {
      error: err instanceof Error ? err.message : String(err),
      reason: 'optional native driver absent; the multiprocess block is skipped',
    });
    return false;
  }
})();
const tursoDescribe = hasTurso ? describe : describe.skip;

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const CHILD = resolve(HERE, 'fixtures', 'cold-open-serialize-child.ts');

const WAVE_SIZE = 24;
const WAVES = 64;

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-6fd60658-'));
});

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function spawnChild(dbPath: string): Promise<ChildResult> {
  return new Promise((done) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', CHILD, dbPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('exit', (code, signal) => done({ code, signal, stdout, stderr }));
  });
}

tursoDescribe('6fd60658 — concurrent multiprocess cold open of one turso store', () => {
  it(
    `${WAVES} waves × ${WAVE_SIZE} simultaneous cold opens: zero panics, zero nonzero exits`,
    async () => {
      let total = 0;
      const panics: string[] = [];
      const walPanics: string[] = [];
      const failures: string[] = [];

      for (let w = 0; w < WAVES; w++) {
        const dbPath = join(tmpDir, `wave-${w}.db`);
        const results = await Promise.all(Array.from({ length: WAVE_SIZE }, () => spawnChild(dbPath)));
        for (const [i, r] of results.entries()) {
          total++;
          if (r.code === 0) continue;
          const panic = /panicked at [^\n]*/.exec(r.stderr)?.[0];
          const detail =
            `wave ${w} proc ${i}: exit=${r.code} signal=${r.signal} :: ` +
            (panic ?? `${r.stdout.trim().slice(0, 300)} ${r.stderr.trim().slice(-300)}`);
          if (panic !== undefined) panics.push(detail);
          // c6b2f19d candidate — counted separately, never folded into 6fd60658.
          if (panic !== undefined && /wal\.rs:4288/.test(panic)) walPanics.push(detail);
          failures.push(detail);
        }
      }

      console.log(
        `[6fd60658] ${total - failures.length}/${total} cold opens clean; ` +
          `panics=${panics.length} (wal.rs:4288=${walPanics.length}); nonzero exits=${failures.length}` +
          failures.filter((f) => !panics.includes(f)).map((f) => `\n  non-panic: ${f}`).join(''),
      );
      expect(panics, `Rust panics during cold open:\n${panics.join('\n')}`).toEqual([]);
      expect(failures, `nonzero exits during cold open:\n${failures.join('\n')}`).toEqual([]);
    },
    420_000,
  );
});

describe('6fd60658 — cold-open lock contract', () => {
  function freshDb(label: string): string {
    const db = join(tmpDir, `${label}-${Math.random().toString(36).slice(2, 8)}.db`);
    mkdirSync(leaseDirPath(db), { recursive: true });
    return db;
  }

  function deadPid(): number {
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
    return Number(String(r.stdout));
  }

  it('sweeps a lock left by a DEAD holder instead of wedging the open', async () => {
    const db = freshDb('dead');
    writeFileSync(coldOpenLockPath(db), `${deadPid()}\n${new Date().toISOString()}\nnonce\n`);
    const lock = await acquireColdOpenLock(db, { maxWaitMs: 2_000 });
    expect(lock.acquired).toBe(true);
    expect(lock.waitedMs).toBeLessThan(1_000);
    lock.release();
    expect(existsSync(coldOpenLockPath(db))).toBe(false);
  });

  it('sweeps an aged-out lock even when its pid reads as live (pid-reuse guard)', async () => {
    const db = freshDb('aged');
    const path = coldOpenLockPath(db);
    writeFileSync(path, `${process.pid}\n${new Date().toISOString()}\nnonce\n`);
    const past = (Date.now() - COLD_OPEN_LOCK_STALE_MS - 5_000) / 1000;
    utimesSync(path, past, past);
    const lock = await acquireColdOpenLock(db, { maxWaitMs: 2_000 });
    expect(lock.acquired).toBe(true);
    lock.release();
  });

  it('waits for a LIVE holder, then proceeds unlocked once the bound expires', async () => {
    const db = freshDb('live');
    const holder = await acquireColdOpenLock(db);
    expect(holder.acquired).toBe(true);
    const waiter = await acquireColdOpenLock(db, { maxWaitMs: 300 });
    expect(waiter.acquired).toBe(false);
    expect(waiter.waitedMs).toBeGreaterThanOrEqual(300);
    waiter.release(); // no-op: must not remove the holder's lock
    expect(existsSync(coldOpenLockPath(db))).toBe(true);
    holder.release();
    expect(existsSync(coldOpenLockPath(db))).toBe(false);
  });

  it('acquires as soon as a live holder releases', async () => {
    const db = freshDb('handoff');
    const holder = await acquireColdOpenLock(db);
    setTimeout(() => holder.release(), 100);
    const next = await acquireColdOpenLock(db, { maxWaitMs: 5_000 });
    expect(next.acquired).toBe(true);
    expect(next.waitedMs).toBeGreaterThanOrEqual(50);
    next.release();
  });

  it("release never deletes a successor's lock", async () => {
    const db = freshDb('successor');
    const first = await acquireColdOpenLock(db);
    const successor = `${process.pid}\n${new Date().toISOString()}\nsuccessor\n`;
    writeFileSync(coldOpenLockPath(db), successor); // lock replaced under the first holder
    first.release();
    expect(readFileSync(coldOpenLockPath(db), 'utf8')).toBe(successor);
  });
});
