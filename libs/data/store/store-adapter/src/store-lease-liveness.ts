/**
 * store-lease-liveness — pid-reuse detection for `pid\nISO\n` registry entries
 * (opener registry, lease, cold-open lock, open marker, deep-verify; backlog
 * 8ca41f1d / 813348a6).
 *
 * `process.kill(pid, 0)` proves only that SOME process owns the pid. After the
 * real holder dies the OS may recycle its pid for an unrelated process, and the
 * entry would then read as live forever. The discriminator needs no writer
 * change: a genuine holder wrote its entry AFTER its own process started,
 * while a recycled pid's current process started AFTER the dead holder wrote
 * (the pid is only reusable once the holder is gone). So an entry timestamped
 * earlier than its live pid's start time is stale.
 *
 * Wall-clock steps can invert that ordering for a live holder, so the rule
 * only fires when the entry predates the process start by MORE than
 * {@link START_SKEW_MARGIN_MS}. Every failure to establish the facts (ps
 * missing, ps output unparseable, entry timestamp unparseable) fails toward
 * LIVE: a possibly-live holder is never swept.
 *
 * This file is a leaf: node built-ins only, no imports from the rest of the
 * package, so `store-lease.ts` can call it without a cycle.
 */
import { execFileSync } from 'node:child_process';

/** An entry may predate its pid's start by up to this much (clock skew / steps)
 *  and still count as a live holder. */
export const START_SKEW_MARGIN_MS = 5 * 60 * 1000;

const PS_TIMEOUT_MS = 2000;

/** Returns the raw `ps -o lstart=` text for `pid` (as printed under TZ=UTC), or
 *  null when it cannot be read. Injectable for tests. */
export type ProcessStartReader = (pid: number) => string | null;

/** Production reader: `ps -o lstart= -p <pid>` under `TZ=UTC LC_ALL=C` so the
 *  text is locale-independent and parses as UTC. null on win32 or any failure. */
export const readProcessStartText: ProcessStartReader = (pid) => {
  if (process.platform === 'win32') return null;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: PS_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
    });
    const text = out.trim();
    return text === '' ? null : text;
  } catch {
    return null;
  }
};

/** Parse `ps -o lstart=` text (`Tue Oct 20 13:24:35 2026`, UTC) to epoch ms;
 *  NaN when unparseable. */
export function parseProcessStart(text: string): number {
  const collapsed = text.trim().replace(/\s+/g, ' ');
  if (!/^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(collapsed)) return NaN;
  return Date.parse(`${collapsed} UTC`);
}

export interface PidReuseDeps {
  /** Reads the start-time text of a pid. Default: {@link readProcessStartText}. */
  readStart?: ProcessStartReader;
  /** Skew margin in ms. Default: {@link START_SKEW_MARGIN_MS}. */
  marginMs?: number;
  /** The calling process's pid, never subject to the rule. Default: `process.pid`. */
  selfPid?: number;
}

/**
 * True iff the entry written at `openedAt` by `pid` (a pid already proven
 * alive) cannot have been written by the process that now owns the pid: that
 * process started more than the margin AFTER the entry was written. False on
 * every uncertainty.
 */
export function isRecycledPid(pid: number, openedAt: number, deps: PidReuseDeps = {}): boolean {
  if (!Number.isFinite(openedAt)) return false;
  if (pid === (deps.selfPid ?? process.pid)) return false;
  let text: string | null;
  try {
    text = (deps.readStart ?? readProcessStartText)(pid);
  } catch {
    return false; // an unreadable start time never proves reuse
  }
  if (text === null) return false;
  const startedAt = parseProcessStart(text);
  if (!Number.isFinite(startedAt)) return false;
  return startedAt - openedAt > (deps.marginMs ?? START_SKEW_MARGIN_MS);
}
