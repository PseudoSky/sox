/**
 * (BUG-017) Child-process turso multiprocess peer for the graph-store
 * quiescence gate (`quiescence-gate.bug017.spec.ts`).
 *
 * Connects to `<dbPath>` through the REAL adapter (acquiring a lease entry),
 * writes one row into the fixture's `node` table, then signals `READY=<pid>`
 * and idles HOLDING the connection until the parent kills it — the live-peer
 * shape that makes a writable better-sqlite3 repair the BUG-014 exp9 poisoner.
 *
 * Usage: `node --import tsx quiescence-child.bug017.ts <dbPath>`
 * Stays alive until killed; prints `READY=<pid>` on stdout once seeded.
 */
import { TursoAdapterImpl } from '@adhd/sox-store-adapter';

const dbPath = process.argv[2];

async function main(): Promise<void> {
  if (!dbPath) throw new Error('usage: quiescence-child.bug017 <dbPath>');
  const adapter = await TursoAdapterImpl.connect({ dbPath });
  try {
    // The fixture's `node` table carries the live-backlog column set.
    await adapter.executeRun(
      `INSERT INTO node (uid, kind, content, name, t_created) VALUES (?, 'episode', ?, ?, ?)`,
      ['live-peer', 'live peer probe', 'live peer', new Date().toISOString()],
    );
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
    process.stdout.write(`ERR=${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  },
);
