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

import { execFileSync } from 'node:child_process';
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
  /**
   * cfe12302: the claimant's parent pid. Every member of one host's pools —
   * across an `embedding.reset`, which starts a new pool group — shares it, so a
   * lock naming a sibling of our own parent is never a competing host.
   */
  ppid?: number;
  /**
   * cfe12302: the claimant's process start time (epoch ms). A live pid whose
   * actual start time differs is a REUSED pid, not the claimant.
   */
  procStartMs?: number;
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


// ── cfe12302: who actually holds the lock? ───────────────────────────────────

/** What the OS says about a lock holder's pid right now. */
export interface LockHolderProbe {
  alive: boolean;
  zombie: boolean;
  ppid: number | null;
  /** Process start time (epoch ms, 1 s resolution), or null when unknown. */
  startMs: number | null;
}

/** `ps` tolerance: `lstart` has 1 s resolution and truncates. */
const START_TOLERANCE_MS = 2_000;

/** This process's start time (epoch ms). */
export function ownProcessStartMs(): number {
  return Math.round(Date.now() - process.uptime() * 1000);
}

/**
 * Probe `pid` with one `ps` call. A pid `ps` cannot report is dead. Only a
 * missing `ps` binary (or a platform without `-o lstart`) degrades to
 * `kill(pid, 0)` liveness with unknown identity.
 */
export function probeLockHolder(pid: number): LockHolderProbe {
  if (!Number.isInteger(pid) || pid <= 0) return { alive: false, zombie: false, ppid: null, startMs: null };
  let out: string;
  try {
    out = execFileSync('ps', ['-o', 'ppid=,stat=,lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2_000,
    });
  } catch (e) {
    // `ps -p <dead pid>` exits 1 with empty output — the common, expected case.
    const status = (e as { status?: unknown }).status;
    if (status === 1) return { alive: false, zombie: false, ppid: null, startMs: null };
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (killErr) {
      alive = (killErr as NodeJS.ErrnoException).code === 'EPERM';
    }
    process.stderr.write(`[fastembed] lock-holder probe via ps failed (${e instanceof Error ? e.message : String(e)}); liveness only\n`);
    return { alive, zombie: false, ppid: null, startMs: null };
  }
  const m = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(out.trim().split('\n')[0] ?? '');
  if (!m) return { alive: false, zombie: false, ppid: null, startMs: null };
  const started = Date.parse(m[3] ?? '');
  return {
    alive: true,
    zombie: (m[2] ?? '').startsWith('Z'),
    ppid: Number(m[1]),
    startMs: Number.isFinite(started) ? started : null,
  };
}

/** Why a lock holder is (or is not) a competing fastembed host. */
export type LockHolderVerdict =
  | 'self'
  | 'dead'
  | 'zombie'
  | 'pid_reused'
  | 'own_parent'
  | 'pool_sibling'
  | 'same_service'
  | 'competing';

/**
 * cfe12302: classify the process a lock names. Only `'competing'` warrants the
 * BL-331 warning. Pure — the OS facts come in as `probe`.
 *
 *   - `dead` / `zombie`: the pid is gone (a zombie answers `kill(pid, 0)`).
 *   - `pid_reused`: the lock recorded its claimant's start time and the live
 *     pid started at a different time — a different process now owns the pid.
 *   - `own_parent`: the holder is a child of OUR parent — another member of the
 *     same host's pool, including a pool replaced by `embedding.reset`.
 *   - `pool_sibling` / `same_service`: the existing BL-432 suppressions.
 */
export function classifyLockHolder(
  prev: Partial<FastembedLockInfo>,
  own: { pid: number | undefined; ppid: number; poolGroup?: string | undefined; service?: string | undefined },
  probe: LockHolderProbe,
): LockHolderVerdict {
  if (prev.pid === own.pid) return 'self';
  if (!probe.alive) return 'dead';
  if (probe.zombie) return 'zombie';
  if (
    typeof prev.procStartMs === 'number' &&
    probe.startMs !== null &&
    Math.abs(probe.startMs - prev.procStartMs) > START_TOLERANCE_MS
  ) {
    return 'pid_reused';
  }
  if (probe.ppid !== null && probe.ppid === own.ppid) return 'own_parent';
  if (typeof prev.poolGroup === 'string' && own.poolGroup !== undefined && prev.poolGroup === own.poolGroup) {
    return 'pool_sibling';
  }
  if (typeof prev.service === 'string' && own.service !== undefined && prev.service === own.service) {
    return 'same_service';
  }
  return 'competing';
}
