/**
 * (DEBT-003/BUG-014) Child-process turso multiprocess peer for the exp8 heal
 * fixture (`wal-contentdead-reconcile.debt003-bug014.spec.ts`).
 *
 * Connects to `<dbPath>` through the REAL adapter (acquires a lease entry in
 * `<dbPath>.sox-lease.d/`), creates a table and seeds `ROWS` rows into a
 * POPULATED WAL (the `-tshm` beside it indexes those frames), then signals
 * `READY=<pid>` and idles HOLDING the connection. While idle it serves a
 * one-line stdin query protocol so the parent can prove the peer still
 * answers AFTER the parent's out-of-band WAL zero + content-dead reconcile
 * (Probe D — the peer's in-memory handle is unaffected by the sidecar
 * rename; the MCP-server incident signature).
 *
 * Protocol (parent writes to stdin):
 *   `COUNT\n` → child replies `COUNT=<n>\n` on stdout (n = rows visible to
 *   the child's own connection), or `ERR=<message>\n` on query failure.
 *
 * Usage: `node --import tsx debt003-exp8-child.ts <dbPath>`
 * Stays alive until killed; the setInterval is the event-loop keep-alive
 * (a pending Promise alone does NOT hold Node's loop — BUG-017 harness note).
 */
import { TursoAdapterImpl } from '../../turso-adapter.js';

const dbPath = process.argv[2];
const ROWS = 50;

async function main(): Promise<void> {
  if (!dbPath) throw new Error('usage: debt003-exp8-child <dbPath>');
  const adapter = await TursoAdapterImpl.connect({ dbPath });
  try {
    await adapter.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
    for (let i = 0; i < ROWS; i++) {
      await adapter.executeRun('INSERT INTO t (v) VALUES (?)', [`exp8-${i}`]);
    }
    process.stdout.write(`READY=${process.pid}\n`);

    const keepAlive = setInterval(() => {}, 1000);
    try {
      // Serve the query protocol until killed. Reading stdin keeps the loop
      // alive as well; the interval is belt-and-braces.
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk: string) => {
        const line = chunk.toString().trim();
        if (line === 'COUNT') {
          adapter
            .executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM t')
            .then((row) => process.stdout.write(`COUNT=${row?.c ?? 0}\n`))
            .catch((err: unknown) =>
              process.stdout.write(`ERR=${err instanceof Error ? err.message : String(err)}\n`),
            );
        }
      });
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
