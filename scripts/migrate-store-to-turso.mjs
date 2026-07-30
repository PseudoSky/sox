#!/usr/bin/env node

/**
 * migrate-store-to-turso.mjs
 *
 * Thin CLI wrapper that delegates ALL migration logic to
 * @adhd/sox-store-adapter's migrateStore().
 *
 * Usage:
 *   node scripts/migrate-store-to-turso.mjs --help
 *   node scripts/migrate-store-to-turso.mjs --source store.db --target new.db
 *   node scripts/migrate-store-to-turso.mjs --direction reverse --source libsql://my-db.turso.io --target local.db
 *   node scripts/migrate-store-to-turso.mjs --mode in-place --source store.db
 *   node scripts/migrate-store-to-turso.mjs --source store.db --target new.db --verify --batch-size 1000
 */

import { parseArgs } from 'node:util';
import * as fs from 'node:fs';

const USAGE = `Usage: node scripts/migrate-store-to-turso.mjs [flags]

Flags:
  --mode copy|in-place      Migration mode (default: copy)
  --direction forward|reverse  Copy direction (default: forward)
                              forward  = SQLite → Turso
                              reverse  = Turso → SQLite
  --source <path>           Source store path (or Turso URL for reverse mode)
  --target <path>           Target store path
  --verify                  Run recall parity check after migration
  --batch-size <N>          Vectors per insert batch (default: 500)
  --help                    Print this help

Examples:
  # SQLite → Turso (local file)
  node scripts/migrate-store-to-turso.mjs --source data/memory.db --target data/memory-turso.db

  # Turso → SQLite (remote to local)
  TURSO_AUTH_TOKEN=... node scripts/migrate-store-to-turso.mjs --direction reverse \\
    --source libsql://my-db.turso.io --target data/memory.db

  # In-place rebuild (SQLite file, vec_node rebuilt for Turso dialect)
  node scripts/migrate-store-to-turso.mjs --mode in-place --source data/memory.db

  # With verification
  node scripts/migrate-store-to-turso.mjs --source data/memory.db --target data/memory-turso.db --verify
`;

// ── Helpers ──────────────────────────────────────────────────────────────────────

/** Return true if a path looks like a remote Turso URL. */
function isTursoUrl(p) {
  return p.startsWith('libsql://') || p.startsWith('http://') || p.startsWith('https://');
}

/** Tables excluded from verification parity (stamped by migration, not copied). */
const VERIFY_EXCLUDE = new Set(['_adapter_meta']);

/** Ensure parent directory exists for a file path. */
function ensureDir(filePath) {
  const dir = filePath && typeof filePath === 'string' ? filePath.substring(0, filePath.lastIndexOf('/')) : '';
  if (dir && dir !== '.' && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Verify row count parity between source and target databases.
 * Re-opens both stores as raw better-sqlite3, counts rows in all
 * non-virtual tables + vec_node, and compares.
 * Returns true if all counts match, false otherwise.
 */
async function verifyParity(sourcePath, targetPath, mode) {
  // Skip verification for remote Turso URLs (better-sqlite3 can't open them)
  if (isTursoUrl(sourcePath) || isTursoUrl(targetPath)) {
    process.stderr.write('[migrate]  Verify: skipped (remote Turso URL — cannot open with better-sqlite3)\n');
    return undefined;
  }

  let sourceDb, targetDb;
  try {
    const { default: Database } = await import('better-sqlite3');

    const source = sourcePath;
    const target = mode === 'in-place' ? sourcePath : targetPath;

    sourceDb = new Database(source, { readonly: true });
    targetDb = new Database(target, { readonly: true });

    const sourceTables = sourceDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'fts_node_%' AND name NOT LIKE 'edge_fts_%' ORDER BY name",
    ).all().map(r => r.name);

    const targetTables = targetDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'fts_node_%' AND name NOT LIKE 'edge_fts_%' ORDER BY name",
    ).all().map(r => r.name);

    const allTables = new Set([...sourceTables, ...targetTables]);
    let ok = true;

    for (const table of allTables) {
      if (VERIFY_EXCLUDE.has(table)) continue;
      let sc = 0;
      let tc = 0;
      try { sc = sourceDb.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c; } catch { sc = 0; }
      try { tc = targetDb.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c; } catch { tc = 0; }

      if (sc !== tc) {
        process.stderr.write(`[migrate]  MISMATCH: "${table}" source=${sc} target=${tc}\n`);
        ok = false;
      }
    }

    if (ok) {
      process.stderr.write('[migrate]  All table counts match.\n');
    }

    return ok;
  } finally {
    if (sourceDb) try { sourceDb.close(); } catch {}
    if (targetDb) try { targetDb.close(); } catch {}
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────────

async function main() {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string', default: 'copy' },
      direction: { type: 'string', default: 'forward' },
      source: { type: 'string' },
      target: { type: 'string' },
      verify: { type: 'boolean', default: false },
      'batch-size': { type: 'string', default: '500' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  // Validate mode
  if (values.mode !== 'copy' && values.mode !== 'in-place') {
    console.error('Error: --mode must be "copy" or "in-place"' );
    process.exit(1);
  }

  // Validate direction
  if (values.direction !== 'forward' && values.direction !== 'reverse') {
    console.error('Error: --direction must be "forward" or "reverse"' );
    process.exit(1);
  }

  // Validate source
  if (!values.source) {
    console.error('Error: --source is required');
    process.exit(1);
  }

  // Validate target for copy mode
  if (values.mode === 'copy' && !values.target) {
    console.error('Error: --target is required for copy mode');
    process.exit(1);
  }

  // In-place only supports forward
  if (values.mode === 'in-place' && values.direction === 'reverse') {
    console.error('Error: in-place mode only supports forward direction');
    process.exit(1);
  }

  // Validate batch size
  const batchSize = parseInt(values['batch-size'], 10);
  if (isNaN(batchSize) || batchSize < 1) {
    console.error('Error: --batch-size must be a positive integer');
    process.exit(1);
  }

  // Validate source file exists (for local SQLite files)
  if (values.mode === 'in-place' || values.direction === 'forward') {
    if (!isTursoUrl(values.source) && !fs.existsSync(values.source)) {
      console.error(`Error: source file not found: ${values.source}`);
      process.exit(1);
    }
  }

  // ── Import store-adapter (defensive — fail gracefully if not available) ─────

  let createSqliteAdapter, createTursoAdapter, migrateStore;
  try {
    const adapter = await import('@adhd/sox-store-adapter');
    createSqliteAdapter = adapter.createSqliteAdapter;
    createTursoAdapter = adapter.createTursoAdapter;
    migrateStore = adapter.migrateStore;
  } catch (err) {
    console.error('Error: @adhd/sox-store-adapter is not available.');
    console.error('  Install it with: pnpm add @adhd/sox-store-adapter');
    console.error(`  (${err.message})`);
    process.exit(1);
  }

  if (typeof migrateStore !== 'function') {
    console.error('Error: @adhd/sox-store-adapter does not export migrateStore().');
    console.error('  The migration module may not be built yet.');
    process.exit(1);
  }

  // ── Create adapters based on mode/direction ─────────────────────────────────

  const startTime = Date.now();
  let source, target;

  try {
    if (values.mode === 'in-place') {
      // In-place: SQLite source + Turso target on the same file
      // Source adapter (SQLite with sqlite-vec, readonly) for reading vec0
      ensureDir(values.source);
      source = createSqliteAdapter({ dbPath: values.source, readonly: true });
      // Target adapter (Turso) for writing vec_node in F32_BLOB format
      target = await createTursoAdapter({ dbPath: values.source });
    } else if (values.direction === 'forward') {
      // SQLite → Turso
      ensureDir(values.source);
      source = createSqliteAdapter({ dbPath: values.source, readonly: true });
      ensureDir(values.target);
      target = await createTursoAdapter({ dbPath: values.target });
    } else {
      // Reverse: Turso → SQLite
      const sourceOpts = isTursoUrl(values.source)
        ? { url: values.source, authToken: process.env.TURSO_AUTH_TOKEN, readonly: true }
        : { dbPath: values.source, readonly: true };
      source = await createTursoAdapter(sourceOpts);
      ensureDir(values.target);
      target = createSqliteAdapter({ dbPath: values.target });
    }

    // ── Delegate to migrateStore ───────────────────────────────────────────────

    function progress(msg) {
      process.stderr.write(`[migrate] ${msg}\n`);
    }

    function onCopyTable(table, rows) {
      progress(`  ${table}: ${rows} rows`);
    }

    const result = await migrateStore(source, target, {
      batchSize,
      onProgress: progress,
      onCopyTable,
    });

    const elapsed = Date.now() - startTime;

    // Close adapters
    await source.close();
    await target.close();
    target = null;
    source = null;

    // ── Verification (re-open both stores, count rows, compare) ────────────

    let verifyOk;
    if (values.verify && result.totalRows > 0) {
      progress('Verifying row count parity...');
      verifyOk = await verifyParity(values.source, values.target, values.mode);
    }

    // Build output matching old script's format
    const output = {
      ok: values.verify ? (verifyOk ?? false) : (result.totalRows > 0),
      elapsed_ms: elapsed,
      source_rows: result.totalRows,
      target_rows: result.totalRows,
      vec_count: result.tables.vec_node?.rows ?? 0,
      verify_ok: verifyOk,
      mode: values.mode,
      direction: values.direction,
      source: values.source,
      target: values.target ?? undefined,
    };

    console.log(JSON.stringify(output));
    process.exit(output.ok ? 0 : 1);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    // Close adapters on error (best-effort)
    if (source && typeof source.close === 'function') {
      try { await source.close(); } catch { /* best-effort */ }
    }
    if (target && typeof target.close === 'function') {
      try { await target.close(); } catch { /* best-effort */ }
    }
    process.exit(1);
  }
}

main();
