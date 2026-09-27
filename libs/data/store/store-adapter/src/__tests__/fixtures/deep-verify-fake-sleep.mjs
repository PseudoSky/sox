/**
 * (BL-deepverify) Fake deep verifier: blocks its MAIN THREAD synchronously —
 * the shape of a native `integrity_check` parked in `pread` — and never
 * replies. Only SIGKILL ends it; it has no self-reaper, so the parent's kill
 * paths are the only thing under test. Writes nothing to stdout.
 */
const block = new Int32Array(new SharedArrayBuffer(4));
for (;;) Atomics.wait(block, 0, 0, 600_000);
