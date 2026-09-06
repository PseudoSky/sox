/**
 * BL-TSHM-INIT-RACE — child-process peer, real cold open, naive concurrent
 * spawn (deliberately NOT barrier-synchronized — see method note below).
 *
 * Opens a COLD (never-before-created) turso store in a SEPARATE PROCESS and
 * writes to it. The defect this races is the `-tshm` coordination-file
 * INITIALIZATION race: two OS processes opening/writing the same cold store
 * at once can have one process stat/read the `-tshm` sidecar before the other
 * has finished writing its 4096-byte header, which the driver reports as
 * either
 *
 *   Corrupt database: shared WAL coordination map magic mismatch
 *   Corrupt database: shared WAL coordination file is smaller than the
 *     coordination header: got 0, minimum 4096
 *
 * This must be a genuinely separate OS process (not a worker_thread, not an
 * in-process race): the race is over an actual file-descriptor-level init
 * sequence on disk between two independent driver instances — an in-process
 * arm shares the module cache/driver singleton state and cannot reproduce two
 * competing COLD opens of the same physical `-tshm` file.
 *
 * The `-tshm` coordination sidecar is created by the FIRST WRITE, not by
 * connect() alone (concurrency-mode.ts's `verifyMultiprocessWalSidecar`
 * polls for it appearing post-open) — so this fixture issues a real DDL
 * write immediately after connect, mirroring the decisive repro
 * (`createStoreAdapter` + `applySchema()`-shaped write, zero other
 * write-layer code) rather than a bare connect+close.
 *
 * METHOD NOTE (measured 2026-09-06): a `READY`-then-`GO` stdin barrier — the
 * pattern this repo's other cross-process races use (see
 * `toctou-peer-child.ts`) — was tried FIRST here and measured 0/180 failures
 * even with the retry fix disabled. A naive concurrent spawn with no
 * synchronization at all reproduced the race at ~1.5-3% per process in the
 * SAME run. The barrier apparently narrows rather than widens this specific
 * window (plausibly: both children reach the driver's file-create syscall at
 * such a precisely identical instant that the OS/driver's own create-time
 * serialization absorbs it, whereas natural process-boot jitter lands one
 * process mid-write while the other reads). This fixture therefore
 * deliberately does NOT synchronize — two processes are simply spawned back
 * to back and left to race on their own OS scheduling.
 *
 * Usage: `node --import tsx tshm-init-race-child.ts <dbPath>`
 *
 * Exit codes:
 *   0  opened, wrote, and closed successfully
 *   1  threw an error (message + whether it matches one of the two known
 *      race signatures is reported on stdout as JSON) — any OTHER error text
 *      here is a genuine regression, not the race
 *   2  a process-level error (missing argv, etc.)
 */
import { createStoreAdapter } from '../../factory.js';

const [, , dbPathArg] = process.argv;
if (dbPathArg === undefined || dbPathArg.length === 0) {
  process.stdout.write(JSON.stringify({ opened: false, error: 'missing dbPath argv[2]' }) + '\n');
  process.exit(2);
}
const dbPath: string = dbPathArg;

async function main(): Promise<void> {
  try {
    const adapter = await createStoreAdapter({ dbPath, concurrencyMode: 'multiprocess-wal' });
    await adapter.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
    process.stdout.write(JSON.stringify({ opened: true }) + '\n');
    await adapter.close();
    process.exitCode = 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isKnownRaceSignature =
      /shared WAL coordination map magic mismatch/i.test(message) ||
      /shared WAL coordination file is smaller than the coordination header/i.test(message);
    process.stdout.write(
      JSON.stringify({ opened: false, error: message, isKnownRaceSignature }) + '\n',
    );
    process.exitCode = 1;
  }
}

main()
  .catch((err: unknown) => {
    process.stdout.write(
      JSON.stringify({ opened: false, error: err instanceof Error ? err.message : String(err) }) +
        '\n',
    );
    process.exitCode = 2;
  })
  .finally(() => {
    const code = process.exitCode ?? 0;
    process.stdout.write('', () => process.exit(code));
  });
