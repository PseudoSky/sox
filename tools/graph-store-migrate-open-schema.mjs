#!/usr/bin/env node
/**
 * tools/graph-store-migrate-open-schema.mjs — PKT-61 (BL-442) operator CLI.
 *
 * Removes the closed `CHECK (kind IN (...))` / `CHECK (rel IN (...))` constraints from an
 * EXISTING graph-store `node`/`edge` schema — the one thing `applySchema()` deliberately never
 * does automatically (BL-447), per ADR-0010 D3. See SPEC-PKT-61.md for the full design.
 *
 * A `tools/*.mjs` script, NOT a `sox` verb (SPEC-PKT-61.md Decision D-6, Rejected alternative B)
 * — `apps/sox/src/main.ts` is out of this packet's scope and this is a single-operator,
 * single-shot, offline command.
 *
 * Usage:
 *   node tools/graph-store-migrate-open-schema.mjs --db <path>            # dry-run: prints the
 *                                                                         # resolved path, confirms
 *                                                                         # it exists, touches
 *                                                                         # nothing, exits 0.
 *   node tools/graph-store-migrate-open-schema.mjs --db <path> --confirm  # runs the migration.
 *
 * Requires `npx nx build graph-store` to have been run first — this script imports the built
 * artifact directly, never through the package's public `exports` map (Decision D-6).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GRAPH_STORE_DIST = path.join(
  ROOT,
  'libs',
  'data',
  'graph',
  'graph-store',
  'dist',
  'open-schema-migration.js',
);

function parseArgs(argv) {
  let db;
  let confirm = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') {
      db = argv[++i];
    } else if (a.startsWith('--db=')) {
      db = a.slice('--db='.length);
    } else if (a === '--confirm') {
      confirm = true;
    } else {
      console.error(`Unrecognized argument: "${a}"`);
      console.error('Usage: node tools/graph-store-migrate-open-schema.mjs --db <path> [--confirm]');
      process.exit(1);
    }
  }
  if (!db) {
    console.error('Missing required --db <path>.');
    console.error('Usage: node tools/graph-store-migrate-open-schema.mjs --db <path> [--confirm]');
    process.exit(1);
  }
  return { db: path.resolve(db), confirm };
}

async function main() {
  const { db, confirm } = parseArgs(process.argv.slice(2));

  console.log(`graph-store-migrate-open-schema: resolved --db => "${db}"`);

  if (!fs.existsSync(db)) {
    console.error(`ERROR: "${db}" does not exist. Nothing to do.`);
    process.exit(1);
  }

  if (!confirm) {
    console.log('Dry run (no --confirm passed): the file exists. Nothing has been touched.');
    console.log('Re-run with --confirm to actually perform the migration.');
    process.exit(0);
  }

  if (!fs.existsSync(GRAPH_STORE_DIST)) {
    console.error(
      'ERROR: built artifact not found at\n' +
        `  ${GRAPH_STORE_DIST}\n` +
        'Build graph-store first: npx nx build graph-store',
    );
    process.exit(1);
  }

  // Never through the package's public `exports` map (Decision D-6) — a direct relative import
  // of the built dist file.
  const { migrateToOpenSchema } = await import(GRAPH_STORE_DIST);

  console.log(`Migrating "${db}" — this will back up the store before touching anything...`);
  try {
    const result = await migrateToOpenSchema(db);
    console.log('SUCCESS:');
    console.log(`  status:      ${result.status}`);
    console.log(`  backupPath:  ${result.backupPath}`);
    console.log(`  before:      nodeCount=${result.before.nodeCount} edgeCount=${result.before.edgeCount}`);
    console.log(`               perRelation=${JSON.stringify(result.before.perRelation)}`);
    console.log(`  after:       nodeCount=${result.after.nodeCount} edgeCount=${result.after.edgeCount}`);
    console.log(`               perRelation=${JSON.stringify(result.after.perRelation)}`);
    process.exit(0);
  } catch (err) {
    // Every typed error's message is operator-readable on its own — no stack-trace spelunking
    // required (SPEC-PKT-61.md §2.5).
    console.error(`FAILED: ${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`);
    process.exit(1);
  }
}

main();
