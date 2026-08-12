/**
 * (BL-461) Child-process opener for the in-process FTS orphan guard.
 *
 * Runs in its own process for the same reason `bl361-open-child.ts` does: the
 * failure under test is a Rust `panic!` that aborts the host with SIGABRT, not
 * an exception. An in-process arm would take the vitest worker down with it and
 * could never be *watched* failing (BL-225).
 *
 * Usage: `node --import tsx bl461-open-child.ts <dbPath> <mode>`
 *
 * - `guarded`    — opens through `TursoAdapterImpl.connect()` with NO marker
 *                  file present, so the out-of-band pre-flight is skipped and
 *                  only the in-process guard can save the process. Then it
 *                  replays memory-core's schema DDL path — resolve the FTS index
 *                  name, create only if the table has none — and reports whether
 *                  full-text search came back and how many FTS indexes exist.
 * - `hardcoded`  — the same, but issuing `CREATE INDEX IF NOT EXISTS
 *                  idx_fts_node …` blindly, which is what the name-resolving
 *                  lookup replaced. Exists to demonstrate the duplicate index
 *                  that lookup prevents.
 * - `readonly`   — opens read-only: the guard must detect and report, and must
 *                  NOT write.
 * - `concurrent` — opens while another process already holds the store open.
 *
 * Exit codes: 0 success, 2 a catchable error (JSON on stdout).
 * Anything else (notably 134 / SIGABRT) is the unguarded panic.
 */
import { readdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { TursoAdapterImpl } from '../../turso-adapter.js';
import { canonicalFtsIndexName, resolveExistingFtsIndexName } from '../../fts-dialect.js';
import type { StoreAdapter } from '../../types.js';

const [, , dbPath, mode] = process.argv;

async function report(adapter: StoreAdapter, extra: Record<string, unknown>): Promise<void> {
  const master = await adapter.executeAll<{ name: string; sql: string | null }>(
    `SELECT name, sql FROM sqlite_master ORDER BY name`,
  );
  const ftsIndexes = master.rows
    .filter((r) => r.sql !== null && /\busing\s+fts\s*\(/i.test(r.sql))
    .map((r) => r.name);
  process.stdout.write(
    JSON.stringify({
      opened: true,
      mode,
      ftsIndexes,
      schemaObjects: master.rows.map((r) => r.name).filter((n) => n.includes('fts')),
      sidecars: readdirSync(dirname(dbPath as string))
        // The `<db>.sox-lease.d` directory (adapter-race-fix §4 lease registry)
        // is ADAPTER bookkeeping, not an engine WAL sidecar — excluded so the
        // sidecar list keeps pinning exactly what BL-461's concurrency arm is
        // about: the `-shm` the marker-gated pre-flight creates beside the
        // `-tshm`/`-wal` Turso coordinates through.
        .filter(
          (f) =>
            f.startsWith(basename(dbPath as string)) &&
            f !== basename(dbPath as string) &&
            f !== `${basename(dbPath as string)}.sox-lease.d`,
        )
        .sort(),
      ...extra,
    }) + '\n',
  );
}

async function main(): Promise<void> {
  if (!dbPath) throw new Error('usage: bl461-open-child <dbPath> <mode>');

  if (mode === 'readonly') {
    const adapter = await TursoAdapterImpl.connect({ dbPath, readonly: true });
    try {
      await report(adapter, { resolved: await resolveExistingFtsIndexName(adapter, 'node') });
    } finally {
      await adapter.close();
    }
    return;
  }

  const adapter = await TursoAdapterImpl.connect({ dbPath });
  try {
    // memory-core's own schema DDL path, in both shapes.
    const resolved = await resolveExistingFtsIndexName(adapter, 'node');
    if (mode === 'hardcoded' || resolved === null || resolved === canonicalFtsIndexName('node')) {
      await adapter.exec(
        `CREATE INDEX IF NOT EXISTS ${canonicalFtsIndexName('node')} ON "node" USING fts ("content")`,
      );
    }
    const rows = await adapter.executeAll<{ id: number }>(
      'SELECT id FROM node WHERE fts_match(content, ?)',
      ['zebra7'],
    );
    const all = await adapter.executeAll<{ id: number }>(
      'SELECT id FROM node WHERE fts_match(content, ?)',
      ['hello'],
    );
    await report(adapter, {
      resolved,
      ftsRowIds: rows.rows.map((r) => Number(r.id)),
      ftsHelloCount: all.rows.length,
    });
  } finally {
    await adapter.close();
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stdout.write(
      JSON.stringify({ opened: false, mode, error: err instanceof Error ? err.message : String(err) }) +
        '\n',
    );
    process.exit(2);
  },
);
