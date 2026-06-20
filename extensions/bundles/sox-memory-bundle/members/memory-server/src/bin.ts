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
 *   R3: All LLM calls are delegated to memory-organizer (organizeItems).
 *       Uses deterministic fallback unless MEMORY_PROVIDER_URL is set.
 */

import { MemoryDaemon } from './memoryd.js';
import type { OrganizerItem, OrganizerResult } from './memoryd.js';
import Database from 'better-sqlite3';

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
  console.error('[memoryd] Error: --db-path is required');
  process.exit(1);
}

// ── Deterministic organizer fallback ─────────────────────────────────────────
//
// When MEMORY_PROVIDER_URL is not set, use the deterministic fallback:
// importance stays 1.0, no entity extraction, no LLM calls (R1, R3).
// This is what tests use.

async function deterministicOrganizer(
  items: OrganizerItem[],
  _db: Database.Database,
): Promise<OrganizerResult[]> {
  return items.map((item) => ({
    uid: item.uid,
    importance: 1.0,
    entities: [],
    relations: [],
  }));
}

// ── Start daemon ─────────────────────────────────────────────────────────────

const daemon = new MemoryDaemon(dbPath, deterministicOrganizer);

daemon.start().then(() => {
  console.log(`[memoryd] started — db: ${dbPath}, scope: ${scope}`);
}).catch((err: unknown) => {
  console.error('[memoryd] startup error:', err);
  process.exit(1);
});
