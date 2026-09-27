/**
 * (BL-fc5ab895) Host process for the deep-verify self-reaper tests.
 *
 * Usage: node --import tsx deep-verify-reaper-host.ts <parentPid> <hardDeadlineMs>
 *
 * Starts the REAL off-thread reaper, prints READY=<pid>, then parks its main
 * thread in a synchronous `Atomics.wait` — the shape of a native
 * `integrity_check` step. Nothing on the main thread can run after that line,
 * so if this process dies it was the reaper's worker thread that killed it.
 */
import { startDeepVerifyReaper } from '../../deep-verify-reaper.js';

const parentPid = Number(process.argv[2]);
const hardDeadlineMs = Number(process.argv[3]);
startDeepVerifyReaper({ parentPid, hardDeadlineMs, pollMs: 50 });
process.stdout.write(`READY=${process.pid}\n`, () => {
  const block = new Int32Array(new SharedArrayBuffer(4));
  for (;;) Atomics.wait(block, 0, 0, 600_000);
});
