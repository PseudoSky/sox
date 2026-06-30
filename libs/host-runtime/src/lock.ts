/**
 * libs/host-runtime/src/lock.ts — concurrent-start lock (R3).
 *
 * Prevents two concurrent `soxe start` invocations for the same scope+root from
 * racing during the brief window between process launch and `writeRuntimeRecord`
 * writing the `execSocketPath`. Uses O_EXCL-create with the holder PID written
 * inside the file so stale locks (from crashed processes) are auto-detected.
 *
 * Lock file location: ~/.sox/locks/<supervisorId>.lock
 * The lock is acquired as the very first action of startRuntime() and released
 * after writeRuntimeRecord writes the final runtime record with execSocketPath set.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runDir } from './data-paths.js';

/**
 * Compute the stable supervisor ID for a given scope+root combination.
 * Returns the first 12 hex characters of sha256(scope + ":" + root).
 * Deterministic: a restarted supervisor for the same scope+root gets the same ID.
 */
export function computeSupervisorId(scope: string, root: string): string {
  const input = `${scope}:${root}`;
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 12);
}

function readLockPid(lockPath: string): number | null {
  try {
    const contents = fs.readFileSync(lockPath, 'utf8').trim();
    const pid = parseInt(contents, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Acquire the start lock for a given supervisorId.
 *
 * - If no lock file exists, creates one with O_EXCL and writes process.pid inside.
 * - If a lock file exists but the holder PID is dead, removes it and retries immediately.
 * - If a lock file exists and the holder is alive, spins with 50ms sleep until either
 *   the lock is released or timeoutMs elapses.
 *
 * Returns a `release()` function that removes the lock file.
 * Throws if the timeout elapses while a live holder holds the lock.
 */
export function acquireStartLock(
  supervisorId: string,
  opts: { timeoutMs?: number } = {},
): { release: () => void } {
  // ADR-0004 §D2: locks live under the user data root's run/ dir.
  const lockDir = path.join(runDir(), 'locks');
  fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, `${supervisorId}.lock`);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      // O_EXCL: fails with EEXIST if the file already exists.
      const fd = fs.openSync(
        lockPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      );
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return {
        release: () => {
          try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
        },
      };
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;

      // Lock exists — check if the holder is still alive.
      const holderPid = readLockPid(lockPath);
      if (holderPid !== null) {
        const holderAlive = (() => {
          try { process.kill(holderPid, 0); return true; }
          catch { return false; }
        })();
        if (!holderAlive) {
          // Stale lock from a crashed process — remove and retry immediately.
          try { fs.unlinkSync(lockPath); } catch { /* lost the race, try again */ }
          continue;
        }
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `[runtime] Cannot start: another soxe start is already running for this ` +
          `scope+root (lock held for ${timeoutMs}ms). ` +
          `If you are sure no other start is running, delete: ${lockPath}`,
        );
      }
      // Spin-wait with 50ms sleep.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}
