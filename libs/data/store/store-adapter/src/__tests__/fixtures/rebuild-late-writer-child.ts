/**
 * BL-e92196e2 — a SEPARATE-PROCESS writer that lands inside the rebuild's
 * snapshot→swap window: it opens the store, commits one row, closes (the
 * adapter's close checkpoints with TRUNCATE, so the row ends up in the main
 * file and the `-wal` is empty) and exits. By the time the rebuild swaps, this
 * process is dead and its lease/opener entries are gone — the swap-time
 * peers/openers re-check cannot see it. Only a comparison of the source file
 * against what was snapshotted can.
 *
 * Usage: `node --import tsx rebuild-late-writer-child.ts <dbPath> <value>`
 *
 * Exit codes: 0 committed and closed; 2 a catchable error (JSON on stdout).
 */
import { TursoAdapterImpl } from '../../turso-adapter.js';

const [, , dbPathArg, valueArg] = process.argv;

async function main(): Promise<void> {
  if (dbPathArg === undefined || dbPathArg.length === 0 || valueArg === undefined) {
    throw new Error('usage: rebuild-late-writer-child.ts <dbPath> <value>');
  }
  const adapter = await TursoAdapterImpl.connect({ dbPath: dbPathArg });
  try {
    await adapter.executeRun('INSERT INTO t (v) VALUES (?)', [valueArg]);
  } finally {
    await adapter.close();
  }
  process.stdout.write(JSON.stringify({ written: true }) + '\n');
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stdout.write(JSON.stringify({ written: false, error: err instanceof Error ? err.message : String(err) }) + '\n');
    process.exit(2);
  },
);
