/**
 * (BUG-017) Child-process turso multiprocess peer for the cross-engine
 * quiescence gate (`cross-engine-quiescence-gate.bug017.spec.ts`).
 *
 * Connects to `<dbPath>` through the REAL adapter (which acquires a lease
 * entry for this process in `<dbPath>.sox-lease.d/`), seeds a populated WAL
 * (400 rows into the fixture's `node` table), then signals `READY=<pid>` and
 * idles HOLDING the connection until the parent kills it. This is exactly the
 * live-peer shape that makes a WRITABLE better-sqlite3 open+close the BUG-014
 * poisoner (exp9): classic SQLite cannot see `-tshm` clients, believes it is
 * the last connection, and checkpoints/deletes the WAL at close-time.
 *
 * Usage: `node --import tsx bug017-quiescence-child.ts <dbPath>`
 * Stays alive until killed; prints `READY=<pid>` on stdout once seeded.
 */
import { TursoAdapterImpl } from '../../turso-adapter.js';

const dbPath = process.argv[2];

async function main(): Promise<void> {
  if (!dbPath) throw new Error('usage: bug017-quiescence-child <dbPath>');
  const adapter = await TursoAdapterImpl.connect({ dbPath });
  try {
    // The fixture store's `node` table exists (built by the parent); keep the
    // CREATE as an idempotent guard. 400 rows populate the WAL so the parent's
    // byte-identical WAL assertion is meaningful.
    await adapter.exec('CREATE TABLE IF NOT EXISTS node (rowid INTEGER PRIMARY KEY, uid TEXT, content TEXT)');
    for (let i = 0; i < 400; i++) {
      await adapter.executeRun('INSERT INTO node (uid, content) VALUES (?, ?)', [
        `peer${i}`,
        `live peer content ${i}`,
      ]);
    }
    process.stdout.write(`READY=${process.pid}\n`);
    // Hold the connection (and the lease entry) until the parent kills us. A
    // pending Promise alone does NOT keep Node's event loop alive — and
    // neither does an idle native turso connection — so without the interval
    // the process would exit right after flushing stdout (measured), taking
    // the live-peer lease with it. The interval is the keep-alive.
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
    process.stdout.write(
      `ERR=${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  },
);
