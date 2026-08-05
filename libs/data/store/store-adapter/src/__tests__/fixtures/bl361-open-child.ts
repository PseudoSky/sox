/**
 * (BL-361) Child-process opener for the panic-on-open regression test.
 *
 * This file MUST run in its own process. The failure it exercises is a Rust
 * `panic!` inside the driver's `connect()` that aborts the host process with
 * SIGABRT — an in-process test cannot observe its own red arm, and would take
 * the whole vitest worker down with it (BL-225: a test that cannot be watched
 * fail proves nothing).
 *
 * Usage: `node --import tsx bl361-open-child.ts <dbPath> <raw|adapter>`
 *
 * - `raw`     — opens with `@tursodatabase/database` directly and runs one
 *               `fts_match`, which is what any consumer (and the adapter's own
 *               open-time FTS probe) does. On a store whose FTS index has no
 *               Tantivy backing objects that query never returns: the process
 *               dies with signal SIGABRT.
 *
 *               **Measured 2026-08-05, correcting BL-361's own description:**
 *               `connect()` itself does NOT panic. Nor does `SELECT 1`, a base
 *               table read, a `sqlite_master` read, an `INSERT`, a
 *               `CREATE INDEX IF NOT EXISTS … USING fts`, or even
 *               `DROP INDEX`. Exactly one statement aborts the process —
 *               `fts_match` against the orphaned index. The consequence is
 *               unchanged, because `TursoAdapterImpl.connect()` reaches that
 *               statement by itself through `runOpenTimeIntegrity` →
 *               `probeFtsIndexes`.
 * - `adapter` — opens through `TursoAdapterImpl.connect()`, which runs the
 *               out-of-process pre-flight first, then re-applies the ordinary
 *               consumer DDL and reports whether full-text search came back.
 *
 * Exit codes: 0 success, 2 a catchable error (message on stdout as JSON).
 * Anything else (notably 134 / SIGABRT) is the unrepaired panic.
 */
import { connect } from '@tursodatabase/database';
import { TursoAdapterImpl } from '../../turso-adapter.js';

const [, , dbPath, mode] = process.argv;

async function main(): Promise<void> {
  if (!dbPath) throw new Error('usage: bl361-open-child <dbPath> <raw|adapter>');

  if (mode === 'raw') {
    const db = await connect(dbPath, { experimental: ['index_method', 'multiprocess_wal'] });
    process.stdout.write(JSON.stringify({ connected: true, mode: 'raw' }) + '\n');
    const rows = (await db.all(
      'SELECT id FROM node WHERE fts_match(content, ?)',
      'hello',
    )) as { id: number }[];
    await db.close();
    process.stdout.write(
      JSON.stringify({ opened: true, mode: 'raw', ftsRowIds: rows.map((r) => Number(r.id)) }) + '\n',
    );
    return;
  }

  const adapter = await TursoAdapterImpl.connect({ dbPath });
  try {
    // Ordinary consumer schema DDL — NOT repair DDL. The pre-flight only makes
    // the store openable; rebuilding the index is the normal path's job.
    await adapter.exec('CREATE INDEX IF NOT EXISTS idx_fts_node ON "node" USING fts ("content")');
    const rows = await adapter.executeAll<{ id: number }>(
      'SELECT id FROM node WHERE fts_match(content, ?)',
      ['hello'],
    );
    const master = await adapter.executeAll<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE name LIKE '%fts%'`,
    );
    process.stdout.write(
      JSON.stringify({
        opened: true,
        mode: 'adapter',
        ftsRowIds: rows.rows.map((r) => Number(r.id)),
        schemaObjects: master.rows.map((r) => r.name).sort(),
      }) + '\n',
    );
  } finally {
    await adapter.close();
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stdout.write(
      JSON.stringify({ opened: false, error: err instanceof Error ? err.message : String(err) }) +
        '\n',
    );
    process.exit(2);
  },
);
