/**
 * BL-TSHM-INIT-RACE — two REAL OS processes racing to open+write the SAME
 * cold turso store must both succeed.
 *
 * THE DEFECT (confirmed live, 2026-09-06): `createStoreAdapter({ dbPath })`
 * called concurrently by two processes against a never-before-opened store,
 * followed immediately by a write (schema DDL — the `applySchema()` shape),
 * intermittently throws one of:
 *
 *   failed to open database <path>: Corrupt database: shared WAL
 *     coordination map magic mismatch
 *   failed to open database <path>: Corrupt database: shared WAL
 *     coordination file is smaller than the coordination header: got 0,
 *     minimum 4096
 *
 * Despite the wording this is NOT corruption — a minimal repro (zero
 * write-layer code beyond `createStoreAdapter` + `applySchema()`) measured
 * 40 two-process cold-open races: adapter 0.9.0 failed 1/10, the published
 * 0.7.0 failed 2/10 (both message variants observed), and retrying the SAME
 * dbPath in a brand-new process after a failure succeeded 5/5 with 0 sticky
 * failures. It is a transient init race on the `-tshm` coordination file:
 * process A creates it, process B stats/reads it before A has written the
 * 4096-byte header. `isTshmCoordinationInitRace` (errors.ts) + the bounded
 * retry in `TursoAdapterImpl.connect()`'s `openOnce` (turso-adapter.ts)
 * fix this by absorbing ONLY these two exact message signatures.
 *
 * This is a DISTINCT window from the documented stale-`-tshm`-after-TRUNCATE
 * case (`BUG-STOREADAPTER-ADAPTER-NOT-ENGINE-FIASCO-RECORD-001`): that bug is
 * a PRE-EXISTING store whose `-tshm` survives a close()-TRUNCATE and then
 * indexes dead frames on a LATER open. This one only exists the very first
 * time a store is created — it is a COLD-store INITIALIZATION race, not a
 * stale-sidecar-reconcile race, and this fix does not touch that other path.
 *
 * Also distinct from the raw turso engine's own open-handshake race
 * ("Database is already open without experimental multiprocess WAL...",
 * "database is locked") — a raw-driver control (no adapter in the path, same
 * two-process cold-store shape, 20 iterations) reproduced THOSE signatures
 * 5/20 but never once produced either tshm-coordination message. The two
 * signatures this suite targets are only observed through the adapter's own
 * open path.
 *
 * METHOD: this must be a genuine two-OS-process race, not worker_threads and
 * not mocks — see `tshm-init-race-child.ts` for why, and for why this
 * fixture deliberately does NOT use a READY/GO barrier (measured: the
 * barrier suppresses this specific race to 0/180; naive concurrent spawn
 * reproduces it).
 *
 * The race is probabilistic (~1.5-3% per PROCESS in this environment, i.e.
 * a couple of percent per race pair), so a handful of races proves nothing
 * either way — this suite runs enough pairs (150) that a regression is
 * statistically unmissable (>99% chance of observing at least one failure at
 * the measured base rate) while keeping total runtime bounded (a
 * `testTimeout` deadline, never a sleep for correctness).
 *
 * NEGATIVE CONTROL (mandatory per the verification standard, run manually and
 * reported alongside this suite — not automated in CI, since it requires a
 * temporary local edit to the production retry): with the tshm-signature
 * check in `openOnce`'s guard forced to `false` (retry disabled for this
 * signature only), the SAME workload reproduced the original "Corrupt
 * database" errors surfacing uncaught, failing this suite — see the task
 * report for the exact counts from that run.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();
const tursoDescribe = hasTurso ? describe : describe.skip;

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const CHILD = resolve(HERE, 'fixtures', 'tshm-init-race-child.ts');

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-tshm-init-race-'));
});

function coldPath(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpDir, `${label}-${suffix}.db`);
}

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * stderr and the exit SIGNAL are both captured deliberately. An earlier version
 * of this harness piped stderr and never read it, and reported only `code`.
 * A child killed by a native abort therefore surfaced as a bare
 * `exit=null` with empty output -- diagnosable only by guessing, and a wrong
 * guess (blaming an upstream driver panic) is exactly what happened and cost
 * real time. A crash must name itself.
 */
function spawnChild(dbPath: string): Promise<ChildResult> {
  return new Promise((resolvePromise) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', CHILD, dbPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => {
      out += String(d);
    });
    proc.stderr.on('data', (d) => {
      err += String(d);
    });
    proc.on('exit', (code, signal) => resolvePromise({ code, signal, stdout: out, stderr: err }));
  });
}

/**
 * Run ONE two-process cold-open race. Both children are spawned back to
 * back with NO synchronization barrier — see `tshm-init-race-child.ts`'s
 * method note for why a barrier was measured to suppress this specific race.
 */
async function raceOnce(dbPath: string): Promise<[ChildResult, ChildResult]> {
  return Promise.all([spawnChild(dbPath), spawnChild(dbPath)]);
}

tursoDescribe('BL-TSHM-INIT-RACE — concurrent cold-open of a turso store', () => {
  it(
    'N two-process races against a never-before-opened store: every process opens and writes successfully',
    async () => {
      const RACES = 150;
      let totalProcesses = 0;
      let failures = 0;
      const failureDetails: string[] = [];

      // Two DIFFERENT defects can fail a child here, and conflating them sends
      // the next reader after the wrong one. Classify, never lump:
      //  - a tshm-coordination signature is THIS fix regressing (the property
      //    under test): the retry classifier stopped matching, or the attempt
      //    budget is now too small for the observed window.
      //  - a signal death (`code === null`, e.g. SIGABRT) is a turso 0.7.2
      //    Rust panic at shared_wal_coordination.rs:1644:9 ("shared owner slot
      //    released by non-owner"), BELOW the adapter and uncurable by any
      //    open-retry policy. WHAT PROVOKES IT IS NOT KNOWN. Do not read a
      //    cause into this classification -- an earlier version of this file
      //    asserted the in-process retry was the trigger, and a powered A/B
      //    (8 runs x 300 processes per arm) refuted it: 0 SIGABRT/2400 WITH
      //    the retry, 4 SIGABRT/2400 WITHOUT it. The rate is low either way
      //    (0-0.2% of processes) and the two arms are not distinguishable at
      //    that sample (Fisher p ~ 0.12). It is named here only so nobody
      //    debugs the retry classifier for it.
      const tshmDetails: string[] = [];
      const crashDetails: string[] = [];
      // Full, UNTRUNCATED child output for annotation matching. `detail` above
      // is deliberately sliced for readable failure output, and the annotation
      // is appended to the END of the driver message -- matching against the
      // truncated copy silently never matches, which cost a debugging cycle.
      const tshmRaw: string[] = [];

      for (let i = 0; i < RACES; i++) {
        const dbPath = coldPath(`race-${i}`);
        const [ra, rb] = await raceOnce(dbPath);
        for (const [label, r] of [
          ['A', ra],
          ['B', rb],
        ] as const) {
          totalProcesses++;
          if (r.code !== 0) {
            failures++;
            const out = r.stdout.replace(/\n/g, ' ').slice(0, 300);
            const detail =
              `race ${i} side ${label}: exit=${r.code} signal=${r.signal} :: ${out}` +
              (r.stderr.trim() ? ` :: STDERR ${r.stderr.replace(/\n/g, ' ').trim().slice(-400)}` : '');
            failureDetails.push(detail);
            if (/shared WAL coordination/i.test(out)) {
              tshmDetails.push(detail);
              tshmRaw.push(r.stdout);
            }
            else if (r.code === null) crashDetails.push(detail);
            else crashDetails.push(detail);
          }
        }
      }

      console.log(
        `[tshm-init-race] ${totalProcesses - failures}/${totalProcesses} processes opened+wrote successfully across ${RACES} races`,
      );

      // WHAT THIS FIX OWNS: the adapter retries the transient cold-init race
      // within a bounded budget, so a cold-open race must not surface to the
      // caller at all; and if it ever does escape that bound, the error must
      // say plainly that it is transient and not corruption.

      // 1. NO PROCESS MAY FAIL. The retry is expected to absorb the race
      //    entirely -- it did, across 2400 processes.
      expect(
        failures,
        `${failures}/${totalProcesses} cold-open processes failed ` +
          `(${tshmDetails.length} -tshm coordination, ${crashDetails.length} other/signal ` +
          `-- see the classification comment above before diagnosing):\n${failureDetails.join('\n')}`,
      ).toBe(0);

      // 2. IF the race ever escapes the retry bound, the error must be
      //    actionable: the driver's bare "Corrupt database:" text sends
      //    readers hunting for a recovery procedure that does not exist (a
      //    fresh process succeeded 5/5 against the same path). Vacuous while
      //    assertion 1 holds; it is the guard for the day it does not.
      const unannotated = tshmRaw.filter((raw) => !/NOT database corruption/i.test(raw));
      expect(
        unannotated.length,
        `${unannotated.length}/${tshmRaw.length} -tshm cold-init failures surfaced WITHOUT the ` +
          `clarifying annotation. Every one must state that it is transient and not corruption, ` +
          `otherwise the next reader hunts for a nonexistent recovery ` +
          `procedure.\n${unannotated.join('\n')}`,
      ).toBe(0);

      // Visibility: the race rate is real and worth seeing on every run, even
      // green ones. Silence here would hide the defect this file exists to
      // document.
      console.log(
        `[tshm-init-race] cold-init races surfaced as clean errors: ${tshmDetails.length}/${totalProcesses} ` +
          `(the retry should absorb these; must be 0); other/signal deaths: ${crashDetails.length} (must be 0)`,
      );
    },
    // 150 races × 2 tsx-cold-start children each, sequential to keep the host
    // from being oversubscribed. Generous but bounded — never an unbounded
    // wait.
    180_000,
  );
});
