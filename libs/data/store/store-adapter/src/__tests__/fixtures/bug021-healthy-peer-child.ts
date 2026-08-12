/**
 * (BUG-021) Child-process turso multiprocess peer for the healthy-store
 * regression fixture (`wal-contentdead-all-sites.bug021.spec.ts`).
 *
 * Connects to `<dbPath>` through the RAW driver (deliberately NOT the
 * adapter: no lease entry in `<dbPath>.sox-lease.d/`, so `storeQuiescence`
 * reports the store quiescent from a fresh opener's perspective — the shape
 * that makes a pre-open proactive reconcile RUN, which is exactly the surface
 * the BUG-021 false positive lived on). It creates a table and writes rows on
 * a PACE (one row every `WRITE_INTERVAL_MS`), so the `-wal` mtime advances
 * with every insert while the `-tshm` mtime stays frozen at file creation —
 * the BUG-021-documented freeze ("live production tshm mtime already 2 min
 * behind wal during healthy operation"). After `ROWS` rows it prints
 * `READY=<pid>` and idles HOLDING the connection.
 *
 * While idle it serves the same one-line stdin query protocol as
 * `debt003-exp8-child.ts`:
 *   `COUNT\n` → `COUNT=<n>\n` on stdout (n = rows visible to the child's own
 *   connection), or `ERR=<message>\n` on query failure.
 *
 * The parent then performs a FRESH adapter open against the same TEMP store.
 * The assertion under test: with the sidecar CONTENT-live (its index still
 * describes frames the WAL holds) the fresh open must NOT rename it, however
 * large the accumulated mtime skew — the false positive BUG-021 removes.
 *
 * Usage: `node --import tsx bug021-healthy-peer-child.ts <dbPath>`
 * Stays alive until killed; the setInterval is the event-loop keep-alive.
 */
const dbPath = process.argv[2];
const ROWS = 20;
const WRITE_INTERVAL_MS = 400;

interface RawDb {
  exec: (sql: string) => Promise<void>;
  run: (sql: string, ...a: unknown[]) => Promise<unknown>;
  all: (sql: string) => Promise<Array<Record<string, unknown>>>;
  close: () => Promise<void>;
}

async function main(): Promise<void> {
  if (!dbPath) throw new Error('usage: bug021-healthy-peer-child <dbPath>');
  const mod = (await import('@tursodatabase/database')) as {
    connect: (p: string, o?: unknown) => Promise<RawDb>;
  };
  const db = await mod.connect(dbPath, {
    experimental: ['index_method', 'multiprocess_wal'],
    timeout: 5000,
  });
  try {
    await db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
    for (let i = 0; i < ROWS; i++) {
      await db.run('INSERT INTO t (v) VALUES (?)', `healthy-${i}`);
      await new Promise((r) => setTimeout(r, WRITE_INTERVAL_MS));
    }
    process.stdout.write(`READY=${process.pid}\n`);

    const keepAlive = setInterval(() => {}, 1000);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk: string) => {
        const line = chunk.toString().trim();
        if (line === 'COUNT') {
          db.all('SELECT COUNT(*) AS c FROM t')
            .then((rows: Array<Record<string, unknown>>) =>
              process.stdout.write(`COUNT=${String(rows[0]?.c ?? 0)}\n`),
            )
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
    await db.close().catch(() => {});
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stdout.write(`ERR=${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  },
);
