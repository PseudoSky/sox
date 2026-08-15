/**
 * BL-471: single shared definition of the BL-331 advisory fastembed-host
 * lock file's path convention and payload shape, imported by BOTH the
 * WRITER (`fastembedProcessHost.ts`, running in the forked child) and the
 * READER (`sharedFastembedProcess.ts`'s `detectCompetingFastembedHost`,
 * running in the parent).
 *
 * Before this module existed, `resolveFastembedLockPath()` and the
 * `{ pid, startedAt }` shape were spelled out independently in both files.
 * Nothing failed when they drifted: renaming the lock path or the
 * `startedAt` field in one file would silently make BL-432's
 * `competing_host_pid` telemetry field permanently `null` — indistinguishable
 * from "no competing host was ever present". See BL-471.
 *
 * This module is deliberately NOT `fastembedProcessHost.ts` itself — that
 * file registers `process.on('message')` and calls
 * `checkAndClaimFastembedLock()` at MODULE SCOPE, both meant only for the
 * forked child process and unsafe to run in the parent. This module has
 * zero module-scope side effects (no I/O, no listeners) so it is safe for
 * the parent process (`sharedFastembedProcess.ts`) to import directly.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Shape of the advisory lock file's JSON contents. */
export interface FastembedLockInfo {
  pid: number;
  startedAt: string;
  /**
   * (BUG-MEMORY-EMBED-HEAD-OF-LINE-BLOCKING-001) Present when the writer is
   * one member of a `FastembedProcessPool` — all members of the same pool
   * share one `poolGroup` id, generated once by the pool and passed to every
   * forked member via `SOX_FASTEMBED_POOL_GROUP`. This lets both the writer
   * (`checkAndClaimFastembedLock`) and the reader
   * (`detectCompetingFastembedHost`) distinguish "another member of MY OWN
   * pool just wrote this lock" (expected, not a bug — a 4-member pool
   * legitimately has 4 live fastembed hosts) from "a genuinely unrelated
   * fastembed host process is running" (the real BL-331 signal this lock
   * exists to catch). Without this, every pool member would warn about every
   * OTHER pool member on every model load — the exact false-positive noise
   * BL-331's own postmortem already warns against over-trusting.
   */
  poolGroup?: string;
}

/**
 * Resolved fresh on every call (not a module-level constant) so tests can
 * point it at an isolated temp path via `SOX_FASTEMBED_LOCK_PATH` without
 * needing `vi.resetModules()`.
 */
export function resolveFastembedLockPath(): string {
  return process.env['SOX_FASTEMBED_LOCK_PATH'] ?? join(tmpdir(), 'sox-fastembed-host.lock');
}
