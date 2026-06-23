#!/usr/bin/env node
/**
 * memoryd binary entry point.
 *
 * Lifecycle contract (design.md §2.4, architecture-v2.md §G-A):
 *   - HOST spawns this process (lifecycle.background:true, lifecycle.singleton:true).
 *   - HOST holds the per-(id,scope) singleton lock — NO OS advisory lock here.
 *   - HOST probes health via the Unix socket at ~/.memory/memoryd.sock.
 *   - On SIGTERM: graceful drain then exit; host SIGKILL after stop_timeout_ms (5000ms).
 *
 * Usage: node dist/bin.js --db-path <path> [--scope <scope>]
 *   --db-path   Path to the .db file (required)
 *   --scope     Scope (project|user|org|local) for priority decisions (default: project)
 *
 * Invariants:
 *   R6: NO ~/.memory/memoryd.lock advisory lock file is ever created.
 *   Enrichment: fully deterministic via @sox/memory-enrich — no LLM, no provider.
 */

import { MemoryDaemon } from './memoryd.js';

// ── CLI arg parsing ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let dbPath: string | null = null;
let scope = 'project';

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const next = args[i + 1];
  if (arg === '--db-path' && next) {
    dbPath = next;
    i++;
  } else if (arg === '--scope' && next) {
    scope = next;
    i++;
  }
}

if (!dbPath) {
  // Fall back to SOX_CONFIG_DB_PATH injected by sox serve/start at launch time.
  dbPath = process.env['SOX_CONFIG_DB_PATH'] ?? null;
}
if (!dbPath) {
  console.error('[memoryd] Error: --db-path is required (or set via: sox config set memory-daemon db_path <path>)');
  process.exit(1);
}

// ── Start daemon ─────────────────────────────────────────────────────────────

const daemon = new MemoryDaemon(dbPath);

daemon.start().then(() => {
  console.log(`[memoryd] started — db: ${dbPath}, scope: ${scope}, enrichment: deterministic (no provider)`);
}).catch((err: unknown) => {
  console.error('[memoryd] startup error:', err);
  process.exit(1);
});
