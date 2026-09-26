/**
 * 6fd60658 child: one process performing ONE real cold open of `argv[2]` —
 * `createStoreAdapter` is lazy, so a non-writing `SELECT 1` forces the real
 * driver open + shared-WAL coordination init — then a clean close. No DDL:
 * a write would add transaction-level conflicts ("snapshot is stale") that
 * are unrelated to the open-path panic this fixture exists to surface.
 *
 * Exit 0 = opened+closed. Exit 1 = a JS-level open error (message on stdout).
 * A Rust panic aborts the process before either line runs; the parent reads
 * `panicked at` from stderr and the abort signal/exit code.
 */
import { createStoreAdapter } from '../../factory.js';

const dbPath = process.argv[2];

async function main(): Promise<void> {
  if (dbPath === undefined || dbPath.length === 0) throw new Error('missing dbPath argv[2]');
  const adapter = await createStoreAdapter({ dbPath, concurrencyMode: 'multiprocess-wal' });
  await adapter.exec('SELECT 1');
  await adapter.close();
}

main().then(
  () => {
    process.stdout.write(JSON.stringify({ opened: true }) + '\n', () => process.exit(0));
  },
  (err: unknown) => {
    const error = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify({ opened: false, error }) + '\n', () => process.exit(1));
  },
);
