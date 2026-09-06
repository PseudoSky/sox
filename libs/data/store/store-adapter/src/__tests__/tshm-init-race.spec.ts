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
  stdout: string;
}

function spawnChild(dbPath: string): Promise<ChildResult> {
  return new Promise((resolvePromise) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', CHILD, dbPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', (d) => {
      out += String(d);
    });
    proc.on('exit', (code) => resolvePromise({ code, stdout: out }));
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
            failureDetails.push(
              `race ${i} side ${label}: exit=${r.code} :: ${r.stdout.replace(/\n/g, ' ').slice(0, 300)}`,
            );
          }
        }
      }

      console.log(
        `[tshm-init-race] ${totalProcesses - failures}/${totalProcesses} processes opened+wrote successfully across ${RACES} races`,
      );
      expect(
        failures,
        `${failures}/${totalProcesses} cold-open processes failed:\n${failureDetails.join('\n')}`,
      ).toBe(0);
    },
    // 150 races × 2 tsx-cold-start children each, sequential to keep the host
    // from being oversubscribed. Generous but bounded — never an unbounded
    // wait.
    180_000,
  );
});
