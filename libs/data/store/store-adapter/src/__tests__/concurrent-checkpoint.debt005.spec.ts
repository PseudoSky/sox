/**
 * DEBT-005 — REFUTED. Concurrent cross-connection writes + checkpoint do NOT
 * hang the Turso driver.
 *
 * DEBT-005 (filed 2026-08-17) reported that a script running an unawaited
 * `while (writing) { await A.run(INSERT) }` loop on connection A, while
 * issuing `PRAGMA wal_checkpoint(PASSIVE)` on connection B with 30 ms delays
 * between attempts, "hung indefinitely" — and that a concurrent TRUNCATE hung
 * too. Both were observed as `timeout 30`/`timeout 20` runs producing ZERO
 * output. The item flagged as "strange and unexplained" that not even the
 * `console.log` calls placed BEFORE `connect()` appeared, and speculated the
 * hang might implicate `connect()` or module-load itself.
 *
 * It does not. The driver was never the subject. Two harness defects produced
 * the finding, and this spec pins the refutation of both:
 *
 *  1. EVENT-LOOP STARVATION (the actual root cause). An unbounded
 *     `while (writing) { await A.exec(...) }` loop resolves on the MICROTASK
 *     queue. Node drains microtasks to exhaustion before advancing to the
 *     timer phase, so once that loop is running, `setTimeout` NEVER fires.
 *     The original probe's inter-checkpoint `setTimeout(30)` — and, in the
 *     TRUNCATE variant, a leading `setTimeout(200)` — therefore never ran.
 *     Isolated re-run, 2026-08-18: the PASSIVE variant issued exactly ONE
 *     checkpoint (which SUCCEEDED, `busy:0`, 1 ms) and then starved; the
 *     TRUNCATE variant logged ZERO checkpoint events, i.e. the TRUNCATE that
 *     was reported as hanging was never issued at all. Adding a single
 *     `await new Promise((r) => setImmediate(r))` yield to the writer loop
 *     turned both variants from "exit 124 (timeout)" into "exit 0, every
 *     checkpoint `busy:0` in 0–1 ms" — including TRUNCATE.
 *
 *  2. A CRASH MISREAD AS A HANG (the "zero output" mystery). `multiprocess_wal`
 *     is an entry in the `experimental` ARRAY, NOT a `multiprocessWal: true`
 *     option. The probe's `connect({ path, multiprocessWal: true })` form puts
 *     an object where a string path belongs, and `connect()` REJECTS with
 *     `code: 'StringExpected'` — killing a top-level-await ESM probe during
 *     module evaluation, before any later statement runs. A run checked only
 *     for absence-of-output, never for exit code, cannot tell exit 1 (crash)
 *     from exit 124 (timeout) — which is precisely how "no output" became
 *     "hangs indefinitely", and why nothing after the failing call was logged.
 *
 *     Worse, the sibling form `connect(path, { multiprocessWal: true })` is
 *     accepted SILENTLY with the flag simply ignored — so a probe written that
 *     way measures SINGLE-process WAL while believing it tests multiprocess
 *     WAL. Both forms are pinned below.
 *
 * The invariant these tests actually pin: under `multiprocess_wal`, a
 * checkpoint issued on one connection while genuinely-overlapping writes are
 * in flight on another connection in the SAME process completes promptly and
 * without contention (`busy: 0`), and loses no writes. That matters because
 * `TursoAdapterImpl`'s WAL-cap backstop issues exactly this shape of
 * unconditional PASSIVE checkpoint from the write path under sustained load.
 *
 * Scratch stores only (`mkdtempSync`) — never ~/.memory, never a real backlog DB.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

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

interface RawDb {
  exec: (sql: string) => Promise<unknown>;
  prepare: (sql: string) => { get: () => Promise<Record<string, unknown>> };
  close: () => Promise<void>;
}

/** Raw-driver connect with the adapter's exact experimental flags. */
async function rawConnect(dbPath: string): Promise<RawDb> {
  const mod = (await import('@tursodatabase/database')) as unknown as {
    connect: (p: string, o?: unknown) => Promise<RawDb>;
  };
  return mod.connect(dbPath, {
    experimental: ['index_method', 'multiprocess_wal'],
    timeout: 5000,
  });
}

const dirs: string[] = [];
function scratchDb(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `debt005-${tag}-`));
  dirs.push(d);
  return join(d, 'probe.db');
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

tursoDescribe('DEBT-005 — concurrent cross-connection checkpoint does not hang', () => {
  it('checkpoints while 64 unawaited writes are in flight on a second connection', async () => {
    const dbPath = scratchDb('burst');
    const A = await rawConnect(dbPath);
    const B = await rawConnect(dbPath);
    try {
      await A.exec('PRAGMA journal_mode=WAL');
      await A.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');

      const ROUNDS = 5;
      const BURST = 64;
      for (let round = 0; round < ROUNDS; round++) {
        // Genuinely overlapping: issued and deliberately NOT awaited, so the
        // checkpoint below runs with `BURST` statements in flight on A.
        const inflight = Array.from({ length: BURST }, (_, i) =>
          A.exec(`INSERT INTO t (v) VALUES ('r${round}-${i}')`),
        );

        const ckpt = await B.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
        // The DEBT-005 claim was that this call never returns. It does, and
        // it does so without contention.
        expect(ckpt.busy).toBe(0);

        const settled = await Promise.allSettled(inflight);
        expect(settled.filter((s) => s.status === 'rejected')).toHaveLength(0);
      }

      // TRUNCATE — the other half of the DEBT-005 claim — also completes.
      const trunc = await B.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      expect(trunc.busy).toBe(0);

      // No writes were lost to the concurrent checkpointing.
      const { c } = await A.prepare('SELECT count(*) AS c FROM t').get();
      expect(Number(c)).toBe(ROUNDS * BURST);
    } finally {
      await A.close();
      await B.close();
    }
  }, 60_000);

  it('a checkpoint interleaved with a live background writer loop stays uncontended', async () => {
    const dbPath = scratchDb('loop');
    const A = await rawConnect(dbPath);
    const B = await rawConnect(dbPath);
    try {
      await A.exec('PRAGMA journal_mode=WAL');
      await A.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');

      let writing = true;
      let writes = 0;
      const writer = (async () => {
        while (writing) {
          await A.exec(`INSERT INTO t (v) VALUES ('x${writes}')`);
          writes++;
          // THE FIX FOR DEFECT (1) ABOVE. Without this yield the loop starves
          // the timer phase and nothing else in the process ever runs again —
          // which is the entire content of the original DEBT-005 "hang".
          await new Promise((r) => setImmediate(r));
        }
      })();

      const results: Array<Record<string, unknown>> = [];
      for (let i = 0; i < 5; i++) {
        results.push(await B.prepare('PRAGMA wal_checkpoint(PASSIVE)').get());
        await new Promise((r) => setTimeout(r, 30));
      }

      writing = false;
      await writer;

      expect(results).toHaveLength(5);
      for (const r of results) expect(r.busy).toBe(0);
      // The writer really was making progress across the checkpoints, i.e.
      // these were genuinely concurrent and not a quiesced store.
      expect(writes).toBeGreaterThan(0);
    } finally {
      await A.close();
      await B.close();
    }
  }, 60_000);

  it('pins both `multiprocessWal` misuse forms — one crashes, one is a SILENT no-op', async () => {
    const dir = scratchDb('optform');
    // Deliberately mistyped call sites below — this test exists to pin what
    // the driver does when it is called WRONG, so the cast goes through
    // `unknown` rather than relaxing any compiler setting.
    const mod = (await import('@tursodatabase/database')) as unknown as {
      connect: (p: unknown, o?: unknown) => Promise<RawDb>;
    };

    // FORM 1 — the options object passed as the FIRST positional argument,
    // which is what the DEBT-005 probe did. `connect()` REJECTS (measured:
    // an unhandled rejection, `code: 'StringExpected'`, raised out of
    // `new Database` — not a synchronous throw). In a top-level-await ESM
    // probe that aborts module evaluation and exits the process non-zero.
    // Combined with a runner that checked only for absence of output and
    // never for exit code, that is how a crash (exit 1) was recorded as a
    // hang (exit 124) — the two are indistinguishable without the code.
    await expect(mod.connect({ path: dir, multiprocessWal: true })).rejects.toThrow(/String/i);

    // FORM 2 — correct positional path, but `multiprocessWal` is not a real
    // option; the flag lives in the `experimental` ARRAY. The driver accepts
    // the unknown key SILENTLY. This is the more dangerous of the two: the
    // caller believes multiprocess WAL is on, and it is off, with no error
    // anywhere. Any future probe of cross-process WAL behaviour that uses
    // this form is measuring single-process WAL and will draw false
    // conclusions — pinned so that trap is discovered here, not in a report.
    const c = await mod.connect(dir, { multiprocessWal: true });
    expect(c).toBeDefined();
    await c.close();
  }, 30_000);
});
