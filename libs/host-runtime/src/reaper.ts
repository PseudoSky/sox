/**
 * libs/host-runtime/src/reaper.ts — BL-31: verified kill + orphan reaper.
 *
 * Fixes the two gaps that let an orphaned daemon survive a `soxe stop`:
 *
 *   (1) `stop` was fire-and-forget SIGTERM with no post-signal liveness check
 *       and no SIGTERM→SIGKILL escalation. A process whose shutdown path hangs
 *       (in-flight requests) or that ignores SIGTERM would be reported "stop
 *       complete" while still running.
 *
 *   (2) Once a supervisor exited the daemon it spawned was reparented to init
 *       (PPID 1) and could fall out of `runtime.json`. The runtime could then
 *       only signal a *tracked* pid — it had no way to find a detached process
 *       *by what it is* (its extension store path / entrypoint).
 *
 * This module provides:
 *
 *   killAndVerify(pid, opts)         — SIGTERM → poll for ESRCH over a bounded
 *                                      grace period → SIGKILL → re-verify.
 *                                      Honest result: 'already-dead' | 'term' |
 *                                      'kill' | 'undead' (could not kill).
 *
 *   findOrphansByIdentity(storeTok)  — scan the OS process table (`ps`) for node
 *                                      processes whose argv contains the
 *                                      extension entrypoint / store path token,
 *                                      excluding our own pid + the supervisor.
 *
 *   reapByIdentity(token, opts)      — kill+verify every matched orphan.
 *
 * All process-table access goes through `ps` (BSD/macOS + Linux compatible flags)
 * so the matcher works for PPID-1 detached processes that `runtime.json` never
 * knew about. Matching is by a precise, caller-supplied token (the entrypoint
 * path or store dir) so an unrelated `node` process is never killed.
 */

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── pid liveness ──────────────────────────────────────────────────────────────

/** True iff `pid` exists in the OS process table (signal 0 probe). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but we can't signal it — still alive.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── verified kill + escalation ─────────────────────────────────────────────────

export type KillOutcome =
  | 'already-dead' // pid was not alive when we started
  | 'term'         // exited after SIGTERM within the grace period
  | 'kill'         // survived SIGTERM, exited after SIGKILL
  | 'undead';      // still alive even after SIGKILL (D-state / EPERM)

export interface KillOptions {
  /** Grace period to wait for a clean SIGTERM exit before escalating. Default 5000ms. */
  graceMs?: number | undefined;
  /** Poll interval while waiting for exit. Default 100ms. */
  pollMs?: number | undefined;
  /** Time to wait for the process to die after SIGKILL. Default 2000ms. */
  killWaitMs?: number | undefined;
  /**
   * Signal the whole process group (negative pid) in addition to the pid.
   * Detached children are spawned with their own process group (setsid), so
   * signalling -pid reaches the child AND all of its descendants. Default true.
   */
  group?: boolean | undefined;
  /** Optional logger for human-readable progress. Default: no-op. */
  log?: ((msg: string) => void) | undefined;
}

/** Send `signal` to `pid` and, when `group`, to the process group `-pid`. Best-effort. */
function signal(pid: number, sig: NodeJS.Signals, group: boolean): void {
  if (group) {
    try { process.kill(-pid, sig); } catch { /* group may be gone */ }
  }
  try { process.kill(pid, sig); } catch { /* pid may be gone */ }
}

/** Poll `pidAlive(pid)` until it is dead or `deadline` passes. Returns true if dead. */
async function waitForDeath(pid: number, deadline: number, pollMs: number): Promise<boolean> {
  // Fast path: already dead.
  if (!pidAlive(pid)) return true;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    if (!pidAlive(pid)) return true;
  }
  return !pidAlive(pid);
}

/**
 * Kill `pid` and VERIFY it is actually gone.
 *
 * SIGTERM → poll for exit over `graceMs` → if still alive, SIGKILL → re-verify
 * over `killWaitMs`. Returns an honest outcome; never reports success for a
 * process it could not confirm dead.
 *
 * Idempotent: a pid that is already dead returns 'already-dead' with no signals.
 */
export async function killAndVerify(pid: number, opts: KillOptions = {}): Promise<KillOutcome> {
  const graceMs = opts.graceMs ?? 5000;
  const pollMs = opts.pollMs ?? 100;
  const killWaitMs = opts.killWaitMs ?? 2000;
  const group = opts.group ?? true;
  const log = opts.log ?? (() => { /* no-op */ });

  if (!pidAlive(pid)) return 'already-dead';

  // Phase 1 — SIGTERM, then poll for a clean exit.
  log(`SIGTERM → pid ${pid} (grace ${graceMs}ms)`);
  signal(pid, 'SIGTERM', group);
  if (await waitForDeath(pid, Date.now() + graceMs, pollMs)) {
    return 'term';
  }

  // Phase 2 — escalate to SIGKILL.
  log(`pid ${pid} survived SIGTERM after ${graceMs}ms → SIGKILL`);
  signal(pid, 'SIGKILL', group);
  if (await waitForDeath(pid, Date.now() + killWaitMs, pollMs)) {
    return 'kill';
  }

  // Phase 3 — could not confirm death. Honest failure.
  log(`CRITICAL: pid ${pid} still alive after SIGKILL (D-state or EPERM)`);
  return 'undead';
}

// ─── identity-matched orphan discovery ──────────────────────────────────────────

export interface PsProcess {
  pid: number;
  ppid: number;
  /** The full command line as reported by `ps -o args`. */
  args: string;
}

/**
 * Snapshot the OS process table via `ps`. Returns one record per process with
 * pid, ppid and the full argv string.
 *
 * Uses `ps -axww -o pid=,ppid=,args=` which is portable across macOS (BSD) and
 * Linux: -a (all users' processes with a controlling terminal is BSD; -A/-e is
 * "all"), so we use -A for "every process" plus -ww to avoid argv truncation.
 */
export function snapshotProcesses(): PsProcess[] {
  let out: string;
  try {
    out = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,args='], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const procs: PsProcess[] = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trimStart();
    if (!trimmed) continue;
    // pid<ws>ppid<ws>args...
    const m = /^(\d+)\s+(\d+)\s+(.*)$/.exec(trimmed);
    if (!m) continue;
    procs.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] ?? '' });
  }
  return procs;
}

/**
 * Normalize an extension `source` (which may be a `file://` URL or a plain path)
 * into a precise process-table match token.
 *
 * For an entrypoint like
 *   file:///…/sox-memory-bundle/members/memory-server/dist/index.js
 * the returned token is the absolute filesystem path
 *   /…/sox-memory-bundle/members/memory-server/dist/index.js
 * which appears verbatim in the spawned child's argv (the runtime spawns
 * `node --enable-source-maps <entrypointPath> …`). This is specific enough that
 * it cannot collide with an unrelated `node` process.
 */
export function identityToken(source: string): string {
  if (!source) return '';
  if (source.startsWith('file://')) {
    try { return fileURLToPath(source); } catch { return source; }
  }
  return source;
}

export interface OrphanMatch extends PsProcess {
  /** True when the process has been reparented to init (PPID 1) — a true orphan. */
  orphaned: boolean;
}

/**
 * Find every live process whose argv contains `token`, excluding:
 *   - our own pid (the running CLI),
 *   - any pid in `excludePids` (e.g. the live supervisor),
 *   - any process whose argv does not include the node runtime invocation for
 *     the token as an actual file argument (guards against e.g. a `grep token`
 *     or an editor having the file open — we require the token to appear as a
 *     standalone argv token, not merely a substring of an unrelated word).
 *
 * `token` MUST be a precise entrypoint/store path (see identityToken). Matching
 * requires the token to be bounded by whitespace or string edges in the argv so
 * `…/memory-server/dist/index.js` never matches `…/memory-server-extra/…`.
 */
export function findOrphansByIdentity(
  token: string,
  opts: { excludePids?: number[] | undefined } = {},
): OrphanMatch[] {
  if (!token) return [];
  const exclude = new Set<number>([process.pid, ...(opts.excludePids ?? [])]);
  const matches: OrphanMatch[] = [];
  for (const p of snapshotProcesses()) {
    if (exclude.has(p.pid)) continue;
    if (!argvContainsToken(p.args, token)) continue;
    matches.push({ ...p, orphaned: p.ppid === 1 });
  }
  return matches;
}

/**
 * True iff `token` appears in `argv` as a whitespace-bounded token (a real
 * argv element), not merely as a substring. This is the precision guard that
 * prevents killing an unrelated process.
 */
export function argvContainsToken(argv: string, token: string): boolean {
  if (!token) return false;
  let from = 0;
  for (; ;) {
    const idx = argv.indexOf(token, from);
    if (idx === -1) return false;
    const before = idx === 0 ? ' ' : argv[idx - 1];
    const afterIdx = idx + token.length;
    const after = afterIdx >= argv.length ? ' ' : argv[afterIdx];
    // Token must be bounded by whitespace (a distinct argv element). A path
    // separator following would mean it's a parent-dir prefix of a longer path.
    if (/\s/.test(before ?? ' ') && /\s/.test(after ?? ' ')) return true;
    from = idx + token.length;
  }
}

export interface ReapResult {
  token: string;
  /** Per-process outcomes for everything that matched the identity token. */
  killed: Array<{ pid: number; ppid: number; orphaned: boolean; outcome: KillOutcome }>;
}

/**
 * Find every process matching `token` and kill+verify each one. Returns a
 * structured result so the caller can report honestly (including any 'undead').
 */
export async function reapByIdentity(
  token: string,
  opts: KillOptions & { excludePids?: number[] | undefined } = {},
): Promise<ReapResult> {
  const matches = findOrphansByIdentity(token, { excludePids: opts.excludePids });
  const killed: ReapResult['killed'] = [];
  for (const m of matches) {
    const outcome = await killAndVerify(m.pid, opts);
    killed.push({ pid: m.pid, ppid: m.ppid, orphaned: m.orphaned, outcome });
  }
  return { token, killed };
}

/** Convenience: derive the identity token from an extension `source` then reap. */
export async function reapBySource(
  source: string,
  opts: KillOptions & { excludePids?: number[] | undefined } = {},
): Promise<ReapResult> {
  return reapByIdentity(identityToken(source), opts);
}

/** Resolve the directory that contains an extension entrypoint (its store dir). */
export function storeDirFromSource(source: string): string {
  const tok = identityToken(source);
  return tok ? path.dirname(tok) : '';
}
