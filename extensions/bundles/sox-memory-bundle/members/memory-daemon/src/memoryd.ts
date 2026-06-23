/**
 * memoryd — thin re-export from @adhd/sox-memory-core.
 *
 * The canonical `MemoryDaemon` implementation lives in `libs/memory-core/src/memoryd.ts`
 * (C7 single-source pattern). All callers import from there via this re-export so
 * the daemon process uses the canonical implementation — including the reembed-on-reindex
 * path that member-local forks were missing (BL-25).
 *
 * Do NOT carry daemon logic here. Edit `libs/memory-core/src/memoryd.ts` instead.
 */

export {
  enqueueEnrich, enqueueIngest,
  enqueueReindex, MemoryDaemon, nudgeDaemon,
  SOCKET_PATH
} from '@adhd/sox-memory-core';

