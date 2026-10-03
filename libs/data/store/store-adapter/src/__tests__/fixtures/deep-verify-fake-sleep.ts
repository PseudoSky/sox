// (BL-fc5ab895) Fake deep verifier: blocks its MAIN THREAD synchronously — the
// shape of a native `integrity_check` parked in `pread` — and never replies.
//
// Unlike the original bare busy-loop, it now carries the SAME off-thread
// self-reaper the real verifier child starts (see deep-verify-child.ts), wired
// from the `--payload` `parentPid`/`hardDeadlineMs` the adapter already passes
// to every verifier. That is what stops a hard-killed parent from stranding
// this process: when the parent dies the child is reparented to PID 1 and the
// reaper SIGKILLs it; when the parent wedges, the hard deadline does. While the
// parent is ALIVE its own timer fires at `timeoutMs`, a full
// DEEP_VERIFY_REAPER_GRACE_MS (10s) before this child's hard deadline, so the
// parent's kill paths remain the thing under test.
//
// The fixture still never replies, so the adapter's own timeout/cancellation
// handling is exercised exactly as before. Writes nothing to stdout.

import { startDeepVerifyReaper } from '../../deep-verify-reaper.js';

interface FakeSleepPayload {
  parentPid?: unknown;
  hardDeadlineMs?: unknown;
}

function parsePayload(argv: readonly string[]): FakeSleepPayload {
  const flag = argv.indexOf('--payload');
  if (flag === -1) return {};
  const raw = argv[flag + 1];
  if (raw === undefined) return {};
  try {
    return JSON.parse(raw) as FakeSleepPayload;
  } catch (err) {
    throw new Error(
      `[deep-verify-fake-sleep] unparseable --payload: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

const { parentPid, hardDeadlineMs } = parsePayload(process.argv);
if (
  typeof parentPid !== 'number' ||
  !Number.isInteger(parentPid) ||
  parentPid <= 0 ||
  typeof hardDeadlineMs !== 'number' ||
  !Number.isFinite(hardDeadlineMs) ||
  hardDeadlineMs <= 0
) {
  throw new Error(
    '[deep-verify-fake-sleep] missing/invalid --payload (parentPid and ' +
      'hardDeadlineMs must be positive numbers); refusing to block forever ' +
      'without a self-reaper',
  );
}

startDeepVerifyReaper({ parentPid, hardDeadlineMs });

const block = new Int32Array(new SharedArrayBuffer(4));
for (;;) Atomics.wait(block, 0, 0, 600_000);
