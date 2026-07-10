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
 *
 * BL-201: `sweepProxyBackendLocks` — dead-holder spawn-lock debris sweep.
 *
 *   The O_EXCL spawn lock used by libs/service-proxy/src/ensure-backend.ts
 *   (`proxy-backend-*.lock`, payload `{pid, t, key}`) is released in a
 *   `finally` block, but a shim that is killed between acquire and release
 *   leaves the file behind. Correctness is unaffected — `tryAcquireLock`
 *   reclaims on `pidAlive` failure or the 30s TTL — but the file misleads
 *   forensics. This sweep is the periodic cleanup.
 *
 *   Sweep condition (AND of a OR b, AND c):
 *     a. holder pid is dead (pidAlive false); OR
 *     b. payload is unparseable (can never be validated as live); AND
 *     c. file mtime is older than LOCK_DEBRIS_TTL_MS (30 000 ms — the same
 *        default TTL used by ensure-backend.ts `lockTtlMs ?? 30_000`).
 *
 *   A live pid always keeps the lock regardless of age (the holder is still
 *   running — it may be in a slow spawn path or waiting on its `finally`).
 *   A dead pid but a fresh file (< TTL) is also kept: another
 *   `tryAcquireLock` caller may be mid-reclaim (racy unlink + recreate window).
 *   Dry-run: logs "WOULD sweep" and counts without calling unlink.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readGlobalRegistry } from './gc.js';
import { findOrphansByIdentity, identityToken, pidAlive } from './reaper.js';
import type { SupervisorRegistryEntry } from './registry.js';
import { getRuntimeFilePath, getScopePaths, type RuntimeRecord } from './runtime.js';

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

// ─── BL-201: proxy-backend spawn-lock debris sweep ───────────────────────────────

/**
 * TTL (ms) for proxy-backend lock debris sweep.
 *
 * Matches the `lockTtlMs ?? 30_000` default in
 * libs/service-proxy/src/ensure-backend.ts `ensureBackend`.
 */
export const LOCK_DEBRIS_TTL_MS = 30_000;

/** Parsed payload of a `proxy-backend-*.lock` file. */
interface LockPayload {
  pid: number;
  t: number;
  key: string;
}

/** Result returned by `sweepProxyBackendLocks`. */
export interface LockSweepResult {
  /** Lock files inspected (pattern `proxy-backend-*.lock`). */
  scanned: number;
  /** Files removed (or that WOULD be removed in dry-run). */
  swept: number;
  /** Files kept (live holder or within TTL). */
  kept: number;
  /** Per-file disposition records. */
  entries: LockSweepEntry[];
}

/** Disposition record for a single lock file. */
export interface LockSweepEntry {
  file: string;
  action: 'swept' | 'would-sweep' | 'kept';
  reason: string;
}

/**
 * Injectable seam for fs operations in the lock sweep — lets specs use a
 * fully in-memory sandbox without touching the real filesystem.
 */
export interface LockSweepFs {
  readdirSync(dir: string): string[];
  statSync(filePath: string): { mtimeMs: number };
  readFileSync(filePath: string, encoding: 'utf8'): string;
  unlinkSync(filePath: string): void;
  existsSync(dir: string): boolean;
}

/**
 * Injectable pid-liveness check for the lock sweep — decoupled from the real
 * process table so tests can synthesize dead/live pids without spawning real
 * processes.
 */
export type PidAliveCheck = (pid: number) => boolean;

/** The real pid-liveness check (kill(pid, 0) — same technique as reaper.ts). */
export const realPidAlive: PidAliveCheck = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but is owned by another user — treat as alive.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** The real filesystem seam — delegates to node:fs. */
export const realLockSweepFs: LockSweepFs = {
  readdirSync: (dir) => fs.readdirSync(dir) as string[],
  statSync: (filePath) => fs.statSync(filePath),
  readFileSync: (filePath, encoding) => fs.readFileSync(filePath, encoding),
  unlinkSync: (filePath) => fs.unlinkSync(filePath),
  existsSync: (dir) => fs.existsSync(dir),
};

/**
 * Sweep dead-holder `proxy-backend-*.lock` debris from the supervisors run dir
 * (BL-201).
 *
 * For each `proxy-backend-*.lock` file found in `lockDir`:
 *   - Parse the JSON payload `{pid, t, key}`.
 *   - KEEP if the holder pid is alive (regardless of age — the holder is still
 *     running and will release in its `finally` block).
 *   - KEEP if the file is newer than `ttlMs` (< TTL) even when pid is dead:
 *     another `tryAcquireLock` caller may be mid-reclaim (racy unlink+recreate).
 *   - SWEEP if pid is dead (or payload is unparseable) AND mtime >= ttlMs old.
 *   - In dry-run mode, logs "WOULD sweep" and skips the actual unlink.
 *
 * All actions are reported through the `log` callback (same signature as the
 * doctorReconcile pass logger so lines land in the durable doctor-reconcile log).
 *
 * @param lockDir  Directory to scan — typically `socketDir()` from data-paths.ts
 *                 (`$userDataRoot/run/supervisors/`), which is where
 *                 ensure-backend.ts writes lock files when `lockDir` is not
 *                 overridden by the caller.
 * @param opts.dryRun    When true, report "WOULD sweep" without unlinking.
 * @param opts.ttlMs     Staleness threshold in ms (default LOCK_DEBRIS_TTL_MS).
 * @param opts.log       Line logger (default: no-op).
 * @param opts.fsSeal    Injectable fs seam for tests (default: realLockSweepFs).
 * @param opts.pidAlive  Injectable pid-liveness check (default: realPidAlive).
 */
export function sweepProxyBackendLocks(
  lockDir: string,
  opts: {
    dryRun?: boolean;
    ttlMs?: number;
    log?: (msg: string) => void;
    fsSeal?: LockSweepFs;
    pidAlive?: PidAliveCheck;
  } = {},
): LockSweepResult {
  const dryRun = opts.dryRun ?? false;
  const ttlMs = opts.ttlMs ?? LOCK_DEBRIS_TTL_MS;
  const log = opts.log ?? (() => undefined);
  const fsSeal = opts.fsSeal ?? realLockSweepFs;
  const pidAliveCheck = opts.pidAlive ?? realPidAlive;

  const result: LockSweepResult = { scanned: 0, swept: 0, kept: 0, entries: [] };

  if (!fsSeal.existsSync(lockDir)) {
    return result;
  }

  let files: string[];
  try {
    files = fsSeal.readdirSync(lockDir);
  } catch {
    return result;
  }

  const lockFiles = files.filter((f) => /^proxy-backend-[0-9a-f]+\.lock$/.test(f));

  const now = Date.now();

  for (const filename of lockFiles) {
    result.scanned++;
    const filePath = path.join(lockDir, filename);

    // Determine file age via mtime.
    let mtimeMs: number;
    try {
      mtimeMs = fsSeal.statSync(filePath).mtimeMs;
    } catch {
      // File vanished between readdir and stat — a concurrent reclaim won. Skip.
      result.kept++;
      result.entries.push({ file: filePath, action: 'kept', reason: 'stat failed (race: file gone)' });
      continue;
    }
    const ageMs = now - mtimeMs;

    // Parse the payload.
    let payload: LockPayload | null = null;
    try {
      payload = JSON.parse(fsSeal.readFileSync(filePath, 'utf8')) as LockPayload;
    } catch {
      payload = null;
    }

    // Safety gate 1: live pid → always keep (holder is still running).
    if (
      payload !== null &&
      typeof payload.pid === 'number' &&
      payload.pid > 0 &&
      pidAliveCheck(payload.pid)
    ) {
      result.kept++;
      const reason = `holder pid ${payload.pid} is alive`;
      result.entries.push({ file: filePath, action: 'kept', reason });
      log(`[reconcile] lock-debris KEEP ${filename}: ${reason}`);
      continue;
    }

    // Safety gate 2: fresh file (< TTL) → keep even if pid is dead.
    // Another tryAcquireLock caller may be mid-reclaim (racy unlink+recreate).
    if (ageMs < ttlMs) {
      result.kept++;
      const deadPid = payload !== null && typeof payload.pid === 'number' ? payload.pid : 'unknown';
      const reason = `dead pid ${String(deadPid)}, but file age ${Math.round(ageMs)}ms < TTL ${ttlMs}ms — possible mid-reclaim`;
      result.entries.push({ file: filePath, action: 'kept', reason });
      log(`[reconcile] lock-debris KEEP ${filename}: ${reason}`);
      continue;
    }

    // Sweep: dead (or unparseable) pid AND older than TTL.
    const deadPid = payload !== null && typeof payload.pid === 'number' ? String(payload.pid) : 'unparseable';
    const reason = `dead holder pid ${deadPid}, age ${Math.round(ageMs)}ms >= TTL ${ttlMs}ms`;

    if (dryRun) {
      result.swept++;
      result.entries.push({ file: filePath, action: 'would-sweep', reason });
      log(`[reconcile] lock-debris WOULD sweep ${filename}: ${reason}`);
      continue;
    }

    try {
      fsSeal.unlinkSync(filePath);
      result.swept++;
      result.entries.push({ file: filePath, action: 'swept', reason });
      log(`[reconcile] lock-debris swept ${filename}: ${reason}`);
    } catch {
      // Concurrent reclaim (another tryAcquireLock unlinked it first) — not an error.
      result.kept++;
      result.entries.push({ file: filePath, action: 'kept', reason: 'unlink raced (already reclaimed)' });
      log(`[reconcile] lock-debris KEEP ${filename}: unlink raced (already reclaimed by tryAcquireLock)`);
    }
  }

  return result;
}

// ─── BL-176: quickReconcile — fast-path GC + split-brain heal for list/status ────
//
// Extracted from apps/sox/src/main.ts's `doctorReconcile()` (phases 0 and 3 ONLY —
// docs/spec/service-lifecycle.md §10.2). This is the subset that is SAFE to run as
// an automatic pre-step of a READ command (`soxe list`, `soxe status`):
//
//   Phase 0 — `readGlobalRegistry()` (gc.ts): probes every registered supervisor
//     (pid + exec-socket) and prunes DEAD ones, marking every entry in a dead
//     supervisor's runtime.json running:false as it goes (`cleanUpDeadEntry`).
//   Phase 3 — for every OTHER runtime.json across the requested scopes (one NOT
//     owned by a still-live supervisor — authority rule 1, §3.3), mark any entry
//     still claiming running:true with NO process reality (dead pid AND no
//     identity-token match anywhere in the process table) as running:false,
//     persisted to disk.
//
// Deliberately EXCLUDES doctorReconcile's phase 1/2 (identity-token stray scan +
// SAFE heal, which can call `killAndVerify` and terminate a live zombie process)
// and phases 4-6 (OS-unit reconcile, crash-loop markers, proxy-lock-debris sweep)
// — those are report-only or process-killing and stay exclusively behind the
// explicit operator action `soxe doctor --reconcile`. quickReconcile NEVER signals
// a process; it only rewrites a JSON bookkeeping file.
//
// Idempotent: a clean second pass over the same state finds nothing left to heal
// (mirrors the doctorReconcile "0 healed" no-op proven by
// apps/sox/src/doctor-reconcile.spec.ts). Never touches a runtime.json whose
// `supervisorPid` is still alive — an actively-owned record is never rewritten
// out from under its live supervisor.

/** A single split-brain entry healed (persisted running:false) by phase 3. */
export interface QuickReconcileHealedEntry {
  scope: string;
  id: string;
  pid: number | null;
  detail: string;
}

export interface QuickReconcileResult {
  /** Live, GC-verified supervisors — same shape/semantics as `readGlobalRegistry()`. */
  liveSupervisors: SupervisorRegistryEntry[];
  /** Split-brain entries healed (persisted running:false) by this pass. */
  healed: QuickReconcileHealedEntry[];
}

/**
 * Fast-path reconcile: GC dead supervisors (phase 0) + heal split-brain
 * runtime.json records (phase 3). Intended to run on every `soxe list` and
 * `soxe status` invocation so `[inv:list-never-lies]` holds without requiring an
 * explicit `soxe doctor --reconcile` first.
 *
 * @param opts.root            Workspace/scope root (for project/local scope
 *                              resolution — same `root` cmdList/cmdStatus already
 *                              compute from `--root`/`process.cwd()`).
 * @param opts.scopes           Scopes to sweep for phase 3. Default: the full
 *                              `['org', 'user', 'project', 'local']` (matches
 *                              doctorReconcile's own `scopes` constant).
 * @param opts.filterId         Only heal entries for this extension id.
 * @param opts.socketTimeoutMs  Per-supervisor socket probe timeout for phase 0
 *                              (passed straight to `readGlobalRegistry`). Default:
 *                              gc.ts's own default (1000ms).
 */
export async function quickReconcile(opts: {
  root: string;
  scopes?: readonly string[];
  filterId?: string;
  socketTimeoutMs?: number;
}): Promise<QuickReconcileResult> {
  const scopes = opts.scopes ?? (['org', 'user', 'project', 'local'] as const);
  const healed: QuickReconcileHealedEntry[] = [];

  // ── Phase 0: GC dead supervisors (prunes supervisors.json + marks their own
  //    runtime.json entries running:false — gc.ts `cleanUpDeadEntry`). ─────────
  const liveSupervisors = await readGlobalRegistry(
    opts.socketTimeoutMs !== undefined ? { socketTimeoutMs: opts.socketTimeoutMs } : {},
  );

  // ── Phase 3: split-brain heal — any OTHER runtime.json (not owned by a still-
  //    live supervisor) still claiming running:true for a dead process. ────────
  for (const sc of scopes) {
    let scopePaths: { config: string; lockfile: string };
    try {
      scopePaths = getScopePaths(sc, opts.root);
    } catch {
      continue;
    }
    const runtimeFilePath = getRuntimeFilePath(scopePaths.lockfile);
    if (!fs.existsSync(runtimeFilePath)) continue;
    let recRt: RuntimeRecord;
    try {
      recRt = JSON.parse(fs.readFileSync(runtimeFilePath, 'utf8')) as RuntimeRecord;
    } catch {
      continue;
    }
    // Authority rule 1 (§3.3): a LIVE supervisor owns its record — never rewritten here.
    if (typeof recRt.supervisorPid === 'number' && pidAlive(recRt.supervisorPid)) continue;

    let changed = false;
    for (const e of recRt.entries ?? []) {
      if (e.running !== true) continue;
      if (opts.filterId !== undefined && e.id !== opts.filterId) continue;
      const pidLive = typeof e.pid === 'number' && e.pid > 0 && pidAlive(e.pid);
      // Short-circuits before the (relatively) expensive `ps` snapshot when the
      // pid check alone already proves liveness.
      const tokenLive = pidLive
        ? false
        : (e.source ? findOrphansByIdentity(identityToken(e.source), { excludePids: [process.pid] }).length > 0 : false);
      if (pidLive || tokenLive) continue;

      const detail = `runtime.json ${sc}: '${e.id}' running:true with NO process reality (pid=${String(e.pid)})`;
      e.running = false;
      e.pid = null;
      changed = true;
      healed.push({ scope: sc, id: e.id, pid: 0, detail: `${detail} → running:false` });
    }
    if (changed) {
      const tmp = `${runtimeFilePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(recRt, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, runtimeFilePath);
    }
  }

  return { liveSupervisors, healed };
}
