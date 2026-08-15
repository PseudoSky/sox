/**
 * BUG-STOREADAPTER-QUIESCENCE-TOCTOU — child-process peer, BARRIER-SYNCHRONIZED.
 *
 * Opens the store in a SEPARATE PROCESS and reads through the WAL. The gate
 * under test is a cross-PROCESS mechanism (a lease directory keyed on pid), so
 * an in-process arm cannot exercise it — only independent OS-scheduled
 * processes can. It also must be a child for the same reason the BL-461 fixture
 * is: the failure mode is a turso Rust panic aborting the host with SIGABRT,
 * which in-process would take the vitest worker down and could never be watched
 * failing (BL-225).
 *
 * ## Why the barrier exists (this is the whole point)
 *
 * A naive `spawn(child); parent.close()` does NOT race. Booting a `tsx` child
 * costs ~100ms while the parent's close path is single-digit ms, so the parent
 * has finished truncating long before the child issues its first syscall. A
 * green result from that arrangement measures nothing at all — it looks like
 * "the window is unreachable" when in fact the two never overlapped.
 *
 * So the child pays its entire startup cost FIRST, prints `READY`, and then
 * blocks on stdin. The parent waits for `READY` — at which point the child is
 * warm, its module graph loaded — and only then writes `GO` and starts its own
 * close in the same tick. Both sides are now doing the contended work within
 * microseconds of each other, which is the shape that actually exercises the
 * gap between the quiescence read and the TRUNCATE.
 *
 * Usage: `node --import tsx toctou-peer-child.ts <dbPath> <expectedRowCount>`
 *
 * Exit codes:
 *   0   opened and read the expected rows — the peer survived
 *   2   a CATCHABLE error (JSON on stdout carries the message)
 *   3   opened but rows were MISSING — silent loss, the worst outcome
 *   134 SIGABRT — the native panic (turso #7833 `Invalid page type: 0` class)
 */
import { TursoAdapterImpl } from '../../turso-adapter.js';

const [, , dbPathArg, expectedRaw] = process.argv;
const expected = Number(expectedRaw ?? '0');

// argv entries are `string | undefined`, and `connect()` is declared under
// exactOptionalPropertyTypes — passing a possibly-undefined dbPath would be a
// type error AND would silently become a URL-mode connect at runtime, which is
// not what this fixture tests. Fail loudly instead.
if (dbPathArg === undefined || dbPathArg.length === 0) {
  process.stdout.write(JSON.stringify({ opened: false, error: 'missing dbPath argv[2]' }) + '\n');
  process.exit(2);
}
const dbPath: string = dbPathArg;

/** Block until the parent releases us, so both sides collide on the same tick. */
function waitForGo(): Promise<void> {
  return new Promise((resolve) => {
    const onData = (chunk: Buffer): void => {
      if (String(chunk).includes('GO')) {
        process.stdin.off('data', onData);
        // pause() alone is NOT enough — a resumed stdin keeps a referenced
        // handle on the event loop, so the child completes its work and then
        // hangs forever instead of exiting, and the parent blocks on 'exit'.
        // Measured: the child produced correct output and never exited.
        process.stdin.pause();
        process.stdin.unref();
        resolve();
      }
    };
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

async function main(): Promise<void> {
  // Pay ALL startup cost before announcing readiness: the import graph above is
  // already resolved by the time this line runs.
  process.stdout.write('READY\n');
  await waitForGo();

  const adapter = await TursoAdapterImpl.connect({ dbPath });
  try {
    // Read immediately — the point is to be mid-WAL-read when the closing
    // peer's TRUNCATE lands.
    const rows = await adapter.executeAll<{ v: string }>('SELECT v FROM t ORDER BY id');
    const got = rows.rows.length;
    process.stdout.write(JSON.stringify({ opened: true, rows: got, expected }) + '\n');
    process.exitCode = got < expected ? 3 : 0;
  } finally {
    await adapter.close().catch((err: unknown) => {
      // Never an empty catch: a close failure is itself signal, but it must not
      // overwrite the read verdict the exit code already carries.
      process.stdout.write(
        JSON.stringify({ closeError: err instanceof Error ? err.message : String(err) }) + '\n',
      );
    });
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
    // Exit DECISIVELY. The adapter/driver and telemetry can leave referenced
    // handles behind, and a child that lingers turns this whole suite into a
    // timeout rather than a measurement. stdout is flushed first so the verdict
    // JSON above is never truncated by the exit.
    const code = process.exitCode ?? 0;
    process.stdout.write('', () => process.exit(code));
  });
