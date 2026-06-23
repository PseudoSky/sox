#!/usr/bin/env node
/**
 * memory-daemon — supervised Unix-socket writer daemon entry point.
 *
 * Config (injected as SOX_CONFIG_* env vars by sox start at launch):
 *   SOX_CONFIG_DB_PATH        — path to SQLite database file (required)
 *   SOX_CONFIG_SOCK_PATH      — Unix socket path (default: ~/.memory/memoryd.sock)
 *
 * CLI args (optional, override env):
 *   --db-path <path>   Path to .db file
 *   --scope <scope>    Scope for priority decisions (default: project)
 *
 * Enrichment is fully deterministic via @sox/memory-enrich — no LLM, no provider required.
 */

import { MemoryDaemon, enqueueIngest, nudgeDaemon, SOCKET_PATH } from './memoryd.js';

export { MemoryDaemon, enqueueIngest, nudgeDaemon, SOCKET_PATH };
export { PRAGMAS, DDL, FTS_TRIGGERS } from './schema.js';
