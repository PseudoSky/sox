/**
 * libs/host-runtime/src/reconcile.ts — Slice 4 of docs/spec/service-lifecycle.md.
 *
 * The SAFE-BY-CONSTRUCTION stray-classification core of the universal doctor
 * reconcile (`soxe doctor --reconcile`, §10.2/§14 Slice 4). It answers ONE
 * question for a set of identity-token-matched processes: *which of these may
 * the reconcile pass reap, and which must it skip?*
 *
 * Safety rules (in order — the spec's "prefer report + skip over guess + kill"):
 *
 *   1. NEVER touch an ACCOUNTED pid — one a live GC-verified supervisor, an OS
 *      unit, or the runtime record claims ([auth:supervisor-then-os-then-os-reality]).
 *   2. NEVER touch the process actually holding the store's live writer socket
 *      (the singleton writer, [def:singleton-key]).
 *   3. If the socket is LIVE but the holder cannot be POSITIVELY attributed
 *      (lsof unavailable / no holder parsed), reap NOTHING for that store —
 *      report + skip everything.
 *   4. With a live, attributed socket: a token-matched process that does NOT
 *      hold the socket is a zero-fd zombie (the exact BL-170 spawn-race-loser
 *      class) → REAP.
 *   5. With NO live socket: never guess-kill a single unaccounted process (it
 *      may be legitimately starting or a healthy M2 daemon whose record lost
 *      its pid) → report-only. A ≥2 duplicate set is a §5.3 singleton violation
 *      → the caller heals it with the EXISTING `chooseSurvivor`/
 *      `healSingletonDuplicates` primitives (oldest survives) — this module
 *      only classifies, it never re-implements the reap.
 *
 * Socket-holder attribution uses `lsof -nP -U -F pn` (BSD/macOS + Linux
 * portable), funneled through an injectable exec so tests never touch the real
 * process table. Leaf module: node builtins only.
 */

import { execFileSync } from 'node:child_process';

// ─── Injectable lsof seam ─────────────────────────────────────────────────────────

export interface LsofResult {
  code: number;
  stdout: string;
}

export type LsofExec = (cmd: string, args: string[]) => LsofResult;

/** The default real exec — never throws (non-zero code + captured stdout instead). */
export const realLsofExec: LsofExec = (cmd, args) => {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { code: 0, stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string };
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout?.toString() ?? '',
    };
  }
};

/**
 * Pids that hold the given Unix domain socket open (listener AND connected
 * endpoints — anything with the socket path in an fd NAME field).
 *
 * Returns:
 *   - number[]  — positively attributed holders (possibly empty).
 *   - null      — ATTRIBUTION FAILED (lsof missing/errored with no output).
 *                 Callers MUST treat null as "reap nothing" (rule 3 above).
 *
 * Parses `lsof -F pn` machine-readable output: `p<pid>` starts a process
 * section; each `n<name>` line names one fd. A holder is any pid with an
 * n-line exactly equal to (or prefixed by) the socket path — the prefix case
 * covers Linux's `n/path type=STREAM` decoration.
 */
export function socketOwnerPids(
  socketPath: string,
  opts: { exec?: LsofExec | undefined } = {},
): number[] | null {
  if (!socketPath) return null;
  const exec = opts.exec ?? realLsofExec;
  const r = exec('lsof', ['-nP', '-U', '-F', 'pn']);
  // lsof exits 1 when SOME fds could not be read even on an overall-useful run;
  // only a run with NO output at all is an attribution failure.
  if (r.stdout.trim() === '') return null;

  const holders = new Set<number>();
  let currentPid: number | null = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('p')) {
      const pid = Number(line.slice(1));
      currentPid = Number.isInteger(pid) && pid > 0 ? pid : null;
      continue;
    }
    if (line.startsWith('n') && currentPid !== null) {
      const name = line.slice(1);
      if (name === socketPath || name.startsWith(`${socketPath} `)) {
        holders.add(currentPid);
      }
    }
  }
  return [...holders];
}

// ─── Classification (pure) ────────────────────────────────────────────────────────

export interface ReconcileMatch {
  pid: number;
  ppid: number;
  /** True when reparented to init (PPID 1). */
  orphaned: boolean;
}

export type ReconcileSkipReason =
  | 'accounted'                     // rule 1 — a live owner claims this pid
  | 'writer-socket-holder'          // rule 2 — it holds the live store socket
  | 'unattributable-socket-holder'  // rule 3 — live socket, holder unknown ⇒ skip all
  | 'single-unaccounted-report-only'; // rule 5 — never guess-kill a lone process

export interface ReconcilePlan {
  /** Positively-attributed zombies safe to verified-stop (rule 4). */
  reap: ReconcileMatch[];
  /** Everything skipped, with the reason (report surface). */
  skip: Array<{ match: ReconcileMatch; reason: ReconcileSkipReason }>;
  /**
   * Rule 5: unaccounted matches with NO live socket. The CALLER applies the
   * §5.3 duplicate heal (chooseSurvivor → killAndVerify) when length ≥ 2, and
   * report-only when length == 1 (already emitted into `skip` for that case).
   */
  duplicateSetNoSocket: ReconcileMatch[];
}

/**
 * Classify identity-matched processes for the reconcile pass. Pure over its
 * inputs — the caller resolves matches (reaper scan), the accounted-pid set
 * (live supervisors + OS-unit pids + runtime records), the socket liveness
 * probe, and the socket-holder attribution, and passes them in.
 */
export function classifyReconcileTargets(opts: {
  matches: ReconcileMatch[];
  /** Pids claimed by a live owner (supervisor/OS unit/runtime record + self). */
  accountedPids: Set<number>;
  /** Is the store's writer socket answering? */
  socketLive: boolean;
  /** Socket holders (socketOwnerPids result). Ignored when !socketLive. */
  socketPids: number[] | null;
}): ReconcilePlan {
  const plan: ReconcilePlan = { reap: [], skip: [], duplicateSetNoSocket: [] };

  const unaccounted: ReconcileMatch[] = [];
  for (const m of opts.matches) {
    if (opts.accountedPids.has(m.pid)) {
      plan.skip.push({ match: m, reason: 'accounted' });
    } else {
      unaccounted.push(m);
    }
  }
  if (unaccounted.length === 0) return plan;

  if (opts.socketLive) {
    const holders = opts.socketPids;
    if (holders === null || holders.length === 0) {
      // Rule 3: a live socket we cannot attribute ⇒ reap NOTHING for this store.
      for (const m of unaccounted) {
        plan.skip.push({ match: m, reason: 'unattributable-socket-holder' });
      }
      return plan;
    }
    const holderSet = new Set(holders);
    for (const m of unaccounted) {
      if (holderSet.has(m.pid)) {
        // Rule 2: the live writer (or a connected endpoint) — never touched.
        plan.skip.push({ match: m, reason: 'writer-socket-holder' });
      } else {
        // Rule 4: token-matched, zero fds on the live store socket ⇒ the BL-170
        // spawn-race-loser zombie. Safe to verified-stop.
        plan.reap.push(m);
      }
    }
    return plan;
  }

  // No live socket.
  if (unaccounted.length === 1) {
    // Rule 5: report-only — could be a starting instance or a pid-less M2 record.
    plan.skip.push({ match: unaccounted[0]!, reason: 'single-unaccounted-report-only' });
    return plan;
  }
  // ≥2 ⇒ §5.3 singleton violation; the caller heals with chooseSurvivor.
  plan.duplicateSetNoSocket = unaccounted;
  return plan;
}
