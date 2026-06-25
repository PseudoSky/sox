#!/usr/bin/env node
/**
 * tools/reap-memory-sidecars.cjs — BL-53 one-shot reaper
 *
 * Deletes orphaned SQLite WAL/SHM sidecars in ~/.memory whose base .db file
 * is ABSENT. These accumulate when test processes are SIGKILLed before their
 * SQLite connections are closed (WAL/SHM files are left dangling).
 *
 * Safety contract:
 *   - NEVER touches memory.db / memory.db-wal / memory.db-shm (canonical store).
 *   - NEVER removes a .db-wal or .db-shm whose base .db exists (live or hot standby).
 *   - Only removes *.db-wal and *.db-shm where the corresponding *.db is absent.
 *   - Dry-run by default (--dry-run flag or DRY_RUN=1 env). Pass --execute to delete.
 *
 * Usage:
 *   node tools/reap-memory-sidecars.cjs               # dry-run (prints what would be deleted)
 *   node tools/reap-memory-sidecars.cjs --execute      # actually delete
 *   DRY_RUN=0 node tools/reap-memory-sidecars.cjs      # same as --execute
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ── Config ─────────────────────────────────────────────────────────────────────

const MEMORY_DIR = path.join(os.homedir(), '.memory');

// These base names are NEVER touched regardless of sidecar presence.
const PROTECTED_BASES = new Set(['memory.db']);

const args = process.argv.slice(2);
const dryRun = process.env['DRY_RUN'] !== '0' && !args.includes('--execute');

// ── Main ───────────────────────────────────────────────────────────────────────

if (!fs.existsSync(MEMORY_DIR)) {
  process.stdout.write(`[reap-memory-sidecars] ${MEMORY_DIR} does not exist — nothing to do.\n`);
  process.exit(0);
}

/** @type {string[]} */
let entries;
try {
  entries = fs.readdirSync(MEMORY_DIR);
} catch (/** @type {unknown} */ e) {
  process.stderr.write(`[reap-memory-sidecars] Cannot read ${MEMORY_DIR}: ${String(e)}\n`);
  process.exit(1);
}

const orphanedSidecars = [];

for (const name of entries) {
  // Only handle .db-wal and .db-shm
  const isWal = name.endsWith('.db-wal');
  const isShm = name.endsWith('.db-shm');
  if (!isWal && !isShm) continue;

  // Derive the base .db name
  const baseName = isWal ? name.slice(0, -4) : name.slice(0, -4); // strip '-wal' or '-shm'
  // Both .db-wal and .db-shm are 4 chars after the dot: '.db-wal' = 7 chars, '-wal'=4
  // Actually: name ends in '-wal' (4 chars) or '-shm' (4 chars)
  const base = name.endsWith('-wal')
    ? name.slice(0, name.length - 4) // e.g. 'foo.db-wal' → 'foo.db'
    : name.slice(0, name.length - 4); // e.g. 'foo.db-shm' → 'foo.db'

  // Safety: never touch protected bases
  if (PROTECTED_BASES.has(base)) continue;

  // Only orphan if the base .db does NOT exist
  const basePath = path.join(MEMORY_DIR, base);
  if (!fs.existsSync(basePath)) {
    orphanedSidecars.push(path.join(MEMORY_DIR, name));
  }
}

if (orphanedSidecars.length === 0) {
  process.stdout.write(`[reap-memory-sidecars] No orphaned sidecars found in ${MEMORY_DIR}.\n`);
  process.exit(0);
}

const verb = dryRun ? '[DRY RUN] would delete' : 'deleting';
process.stdout.write(
  `[reap-memory-sidecars] Found ${orphanedSidecars.length} orphaned sidecar(s) in ${MEMORY_DIR}` +
  `${dryRun ? ' (dry-run — pass --execute to delete)' : ''}:\n`,
);

let deleted = 0;
let errors = 0;

for (const filePath of orphanedSidecars) {
  process.stdout.write(`  ${verb}: ${filePath}\n`);
  if (!dryRun) {
    try {
      fs.rmSync(filePath, { force: true });
      deleted++;
    } catch (/** @type {unknown} */ e) {
      process.stderr.write(`  ERROR deleting ${filePath}: ${String(e)}\n`);
      errors++;
    }
  }
}

if (!dryRun) {
  process.stdout.write(
    `[reap-memory-sidecars] Done: ${deleted} deleted, ${errors} error(s).\n`,
  );
}

process.exit(errors > 0 ? 1 : 0);
