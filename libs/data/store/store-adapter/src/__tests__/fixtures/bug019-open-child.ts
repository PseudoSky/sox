/**
 * (BUG014.T5) Child-process holder for the kill -9 open-marker arm.
 *
 * Connects to `<dbPath>` through the REAL adapter — which writes the
 * per-connection `<leaseDir>/<token>.openmark` carrying THIS process's pid —
 * then prints `READY=<pid>` and idles holding the connection until killed.
 * The parent SIGKILLs it, leaving its marker (and lease entry) behind with a
 * dead pid: the unclean-shutdown signal whose survival under a sibling's
 * orderly close is the invariant under test.
 *
 * Usage: `node --import tsx bug019-open-child.ts <dbPath>`
 * Stays alive until killed; the setInterval is the event-loop keep-alive
 * (a pending Promise alone does NOT hold Node's loop — BUG-017 harness note).
 */
import { TursoAdapterImpl } from '../../turso-adapter.js';

const dbPath = process.argv[2];

async function main(): Promise<void> {
  if (!dbPath) throw new Error('usage: bug019-open-child <dbPath>');
  const adapter = await TursoAdapterImpl.connect({ dbPath });
  try {
    await adapter.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
    process.stdout.write(`READY=${process.pid}\n`);
    const keepAlive = setInterval(() => {}, 1000);
    try {
      await new Promise<never>(() => {});
    } finally {
      clearInterval(keepAlive);
    }
  } finally {
    await adapter.close().catch(() => {});
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stdout.write(`ERR=${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  },
);
