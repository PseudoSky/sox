/**
 * libs/service-proxy/src/process-identity.ts — pid-reuse-safe process identity.
 *
 * `kill(pid, 0)` only says "some process owns this pid number". After a reboot or
 * pid wrap the number can belong to an unrelated process, so a stale spawn lock
 * would be honored forever. A process START TOKEN (the text `ps -o lstart=` prints
 * for it) is stable for the life of a process and differs for a recycled pid.
 *
 * The token is opaque: callers compare it for string equality only. It is read
 * with `LC_ALL=C` and `TZ=UTC` so the text does not vary with the caller's locale
 * or timezone (the same process read by two callers must produce the same token).
 *
 * Node builtins only (leaf rule). Never throws: every failure degrades toward the
 * 0.5.0 behavior (alive-only), never toward reclaiming a possibly-live lock.
 */
import { execFileSync as nodeExecFileSync } from 'node:child_process';

/** Injection seams (tests only). */
export interface ProcessIdentityDeps {
  execFileSync?: (
    cmd: string,
    args: string[],
    o: { encoding: 'utf8'; timeout: number; env: NodeJS.ProcessEnv },
  ) => string;
  pidAlive?: (pid: number) => boolean;
}

/** ms to allow `ps` before giving up (a hung ps must not wedge ensureBackend). */
const PS_TIMEOUT_MS = 1000;

/** Default liveness check: kill(pid,0); EPERM means alive (another user's process). */
function defaultPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The process start token for `pid` (`ps -o lstart= -p <pid>`, LC_ALL=C, trimmed),
 * or null on any failure, empty output, a non-positive pid, or a non-POSIX
 * platform. Never throws.
 */
export function readProcessStartToken(pid: number, deps?: ProcessIdentityDeps): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') return null;
  const run = deps?.execFileSync ?? (nodeExecFileSync as NonNullable<ProcessIdentityDeps['execFileSync']>);
  try {
    const out = run('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: PS_TIMEOUT_MS,
      // LC_ALL=C pins month/day names; TZ=UTC pins the wall-clock zone. Measured on
      // darwin: lstart varies with both, so two processes with different TZ would
      // otherwise disagree about the SAME process and wrongly steal a live lock.
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    });
    const token = typeof out === 'string' ? out.trim() : '';
    return token === '' ? null : token;
  } catch {
    return null;
  }
}

/**
 * Is `pid` still the same process that produced `startToken`?
 *  - pid dead                      -> false
 *  - token null/undefined          -> alive-only (0.5.0 behavior)
 *  - alive + tokens equal          -> true
 *  - alive + tokens differ         -> false (pid was recycled)
 *  - ps failure at check time      -> true (fail toward keeping the lock = 0.5.0)
 */
export function isSameProcess(pid: number, startToken: string | null | undefined, deps?: ProcessIdentityDeps): boolean {
  const alive = deps?.pidAlive ?? defaultPidAlive;
  if (!alive(pid)) return false;
  if (startToken === null || startToken === undefined) return true;
  const current = readProcessStartToken(pid, deps);
  if (current === null) return true;
  return current === startToken;
}
