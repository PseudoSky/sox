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
  /**
   * (BL-432) The service label of the process that OWNS this fastembed host
   * (e.g. `memory-server`, `backlog`), threaded from the parent via
   * `SOX_FASTEMBED_SERVICE` — the same env-threading shape as `poolGroup`.
   *
   * Two jobs:
   *   1. IDENTITY in the BL-331 warning: "another fastembed host process
   *      (pid N, service X, started …)" names WHO the competing host belongs
   *      to, not just a bare pid an agent has to `ps` for.
   *   2. SAME-SERVICE SUPPRESSION: a lock whose `service` equals our own is the
   *      sequential-CLI false positive (one service's own host, still named by
   *      the lock from an earlier run, or a second instance of the SAME
   *      service) and must NOT warn. Genuine CROSS-service contention still
   *      does.
   *
   * `undefined` when the owner declared no service identity (an
   * uninitialised/`'unlabeled'` telemetry process), in which case neither
   * suppression nor identity applies — the pre-BL-432 behaviour, unchanged.
   */
  service?: string;
}

/**
 * Resolved fresh on every call (not a module-level constant) so tests can
 * point it at an isolated temp path via `SOX_FASTEMBED_LOCK_PATH` without
 * needing `vi.resetModules()`.
 */
export function resolveFastembedLockPath(): string {
  return process.env['SOX_FASTEMBED_LOCK_PATH'] ?? join(tmpdir(), 'sox-fastembed-host.lock');
}

/**
 * BL-432: the env key a parent writes and a forked host reads to label the
 * lock with the OWNING service's identity. Mirrors `SOX_FASTEMBED_POOL_GROUP`
 * (see `poolGroup` above) — set on the child's env by
 * `SharedFastembedProcessClient.ensureProcess()`, read by the writer
 * (`checkAndClaimFastembedLock`) and the parent-side reader alike.
 */
export const SOX_FASTEMBED_SERVICE = 'SOX_FASTEMBED_SERVICE';

/**
 * Normalize a candidate service identity. An empty string, or the telemetry
 * "never configured" sentinel `'unlabeled'`, carries no identity and must
 * NEVER drive same-service suppression — otherwise every process that never
 * called `initTelemetry()` would suppress every other, including genuine
 * cross-service contention. Returns `undefined` for those cases.
 */
export function normalizeFastembedService(service: string | undefined): string | undefined {
  if (service === undefined || service === '' || service === 'unlabeled') return undefined;
  return service;
}

/**
 * THIS process's own service identity for lock purposes.
 *
 * A forked host reads the owner's label from `SOX_FASTEMBED_SERVICE` (the
 * parent set it on this child's env). The PARENT itself has no such env var for
 * its own process, so it passes its telemetry service explicitly as
 * `telemetryService` (from `currentRuntimeState().service`). Env wins when both
 * are present, so a propagated owner label is never overwritten by a child's
 * own (different) telemetry service.
 */
export function resolveFastembedServiceLabel(telemetryService?: string): string | undefined {
  const fromEnv = process.env[SOX_FASTEMBED_SERVICE];
  const candidate = fromEnv !== undefined && fromEnv !== '' ? fromEnv : telemetryService;
  return normalizeFastembedService(candidate);
}
