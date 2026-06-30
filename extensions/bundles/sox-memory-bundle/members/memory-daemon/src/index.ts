#!/usr/bin/env node
/**
 * memory-daemon — supervised Unix-socket writer daemon entry point.
 *
 * Config (injected as SOX_CONFIG_* env vars by soxe start at launch):
 *   SOX_CONFIG_DB_PATH        — path to SQLite database file (required)
 *   SOX_CONFIG_SOCK_PATH      — Unix socket path (default: ~/.memory/memoryd.sock)
 *
 * CLI args (optional, override env):
 *   --db-path <path>   Path to .db file
 *   --scope <scope>    Scope for priority decisions (default: project)
 *
 * Enrichment is fully deterministic via @adhd/sox-analysis — no LLM, no provider required.
 */

import { enqueueIngest, MemoryDaemon, nudgeDaemon, SOCKET_PATH } from './memoryd.js';

export { FTS_TRIGGERS, PRAGMAS } from '@adhd/sox-graph-store';
export { DDL } from '@adhd/sox-memory-core';
export { reembed, SqliteVectorBackend } from '@adhd/sox-vector-store';
export { enqueueIngest, MemoryDaemon, nudgeDaemon, SOCKET_PATH };

