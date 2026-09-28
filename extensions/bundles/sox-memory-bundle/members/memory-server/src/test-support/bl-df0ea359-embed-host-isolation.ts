/**
 * test-support/bl-df0ea359-embed-host-isolation.ts — BL-df0ea359.
 *
 * `bl404-telemetry-composition-root.spec.ts` and `bl401-stages-declared-live.spec.ts`
 * spawn the REAL `src/index.ts` entrypoint via `tsx` (never `dist/`, never in-process —
 * that is the whole point of those two specs: exercising `require.main === module` for
 * real). The entrypoint unconditionally fires `warmupEmbed()` on startup
 * (`index.ts`'s `setImmediate(() => void warmupEmbed()...)`, right after
 * `initTelemetry()` — see BL-89), which resolves the real fastembed backend and spawns
 * a shared, DETACHED embedding-host process (`embedHostMain`) if one isn't already
 * running for the resolved `(model, ep, cacheDir, buildId)` singleton key.
 *
 * Two defects this module closes:
 *
 * 1. ENV LEAK. Both specs used to spread the calling process's `process.env` verbatim
 *    (overriding only `SOX_ECOSYSTEM_HOME`). `resolveConfig()` in
 *    `libs/memory-core/src/embed.ts` falls back to
 *    `join(process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache'), 'sox', 'models')`,
 *    so every spec run spawned a real embedding host with the OPERATOR's HOME and
 *    `--cache-dir=<home>/.cache/sox/models`. `buildEmbedHostEnv()` (`embedHostConfig.ts`)
 *    forwards `HOME`/`XDG_CACHE_HOME`/`TMPDIR` from the spawner's env, so overriding them on
 *    the spawned entrypoint isolates the whole chain. `buildScratchEmbedEnv()` does that and
 *    also strips `SOX_CONFIG_DB_PATH`/`SOX_PROXY_BACKEND`: the entrypoint's SIGTERM handler
 *    VACUUM-INTO-backs-up whatever store `SOX_CONFIG_DB_PATH` names, and a test must never
 *    touch the operator's store (the specs pass `db_path` explicitly on every call).
 *
 * 2. ORPHANED SERVER. `node_modules/.bin/tsx` runs `index.ts` in a separate node
 *    GRANDCHILD. The specs used to `child.kill('SIGKILL')` the wrapper only: SIGKILL is not
 *    relayed, `index.ts` has no stdin-EOF exit, so the real memory-server was reparented to
 *    ppid 1 and kept running (measured alive at t+90s) while the spec `rmSync`'d its scratch
 *    dir. `spawnRealEntrypoint()` now spawns `detached: true` (its own process group) and
 *    tags the argv with a scratch-root sentinel; `teardownRealEntrypoint()` signals the whole
 *    group (SIGTERM → poll for ESRCH → SIGKILL), then reaps every process whose argv carries
 *    the scratch root (the detached embed host carries it via `--socket=`/`--cache-dir=`),
 *    and waits for a stable, empty process table before returning a report the spec ASSERTS.
 *
 * Never signals a process this module did not start: the group id is the pid of a child it
 * spawned with `detached: true`, and every other target carries this run's unique
 * `mkdtemp` scratch root in its argv.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { log } from '@adhd/sox-telemetry';

/** The on-disk model dir name embedding-provider's fastembed carrier resolves to. */
const MODEL_DIR_NAME = 'fast-bge-base-en-v1.5';
const MODEL_MARKER_FILE = 'model_optimized.onnx';

/** argv sentinel carrying the scratch root, so the server (and an orphan of it) is findable by argv. */
export const SCRATCH_ROOT_ARG_PREFIX = '--bl-df0ea359-scratch-root=';

/**
 * Resolve where THIS (calling, un-overridden) process would find its own cached
 * model — mirrors `resolveConfig()` in `libs/memory-core/src/embed.ts`.
 */
function resolveOperatorModelCacheDir(): string {
  return (
    process.env['SOX_EMBED_CACHE_DIR'] ??
    path.join(process.env['XDG_CACHE_HOME'] ?? path.join(os.homedir(), '.cache'), 'sox', 'models')
  );
}

/**
 * Best-effort: seed the scratch cache dir with a COPY of the model bytes already
 * cached for the operator's real backend, so the spawned host's FIRST real-embed
 * attempt succeeds without a network fetch — avoiding funnelClient's multi-attempt
 * ensure()/cooldown retry storm (ENSURE_FAILURE_THRESHOLD=3,
 * ENSURE_CIRCUIT_COOLDOWN_MS=10_000) that a network-denied sandbox would otherwise
 * hit on every single spec run. This is a one-time file COPY performed by THIS
 * process, before the scratch env is ever handed to a spawned child — the spawned
 * embed host's own `cacheDir` argv is always the scratch path; it is never pointed
 * at, and never touches, the operator's real cache directory. No-ops (and lets the
 * real backend fall back to a network fetch) if no cached model is found.
 */
function seedScratchModelCache(destCacheDir: string): boolean {
  const srcModelDir = path.join(resolveOperatorModelCacheDir(), MODEL_DIR_NAME);
  if (!fs.existsSync(path.join(srcModelDir, MODEL_MARKER_FILE))) return false;
  try {
    fs.mkdirSync(destCacheDir, { recursive: true });
    fs.cpSync(srcModelDir, path.join(destCacheDir, MODEL_DIR_NAME), { recursive: true });
    return true;
  } catch (err) {
    log.warn('bl_df0ea359_model_cache_seed_failed', { destCacheDir, error: String(err) });
    return false;
  }
}

export interface ScratchEmbedEnv {
  env: NodeJS.ProcessEnv;
  cacheDir: string;
  home: string;
}

/**
 * Build a spawn env for a real memory-server entrypoint test that never shares the
 * operator's HOME, model cache, XDG cache dir, tmp dir, embed socket dir, or store.
 */
export function buildScratchEmbedEnv(scratchRoot: string, baseEnv: NodeJS.ProcessEnv = process.env): ScratchEmbedEnv {
  const home = path.join(scratchRoot, 'home');
  const xdgCache = path.join(scratchRoot, 'xdg-cache');
  const cacheDir = path.join(xdgCache, 'sox', 'models');
  const tmp = path.join(scratchRoot, 'tmp');
  const sandboxEcosystemHome = path.join(scratchRoot, 'home');

  seedScratchModelCache(cacheDir);

  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    HOME: home,
    XDG_CACHE_HOME: xdgCache,
    SOX_EMBED_CACHE_DIR: cacheDir,
    TMPDIR: tmp,
    SOX_ECOSYSTEM_HOME: sandboxEcosystemHome,
  };
  // The entrypoint's SIGTERM handler backs up the store SOX_CONFIG_DB_PATH names, and
  // SOX_PROXY_BACKEND=1 would switch it into backend mode. Neither may leak in from the
  // operator's env: the specs always pass `db_path` explicitly.
  delete env['SOX_CONFIG_DB_PATH'];
  delete env['SOX_PROXY_BACKEND'];

  return { env, cacheDir, home };
}

// ── process table ────────────────────────────────────────────────────────────

export interface ProcRow {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

/**
 * Snapshot the process table. `-axww` (every process, unlimited width) is accepted by both
 * BSD and procps `ps`. Throws if `ps` cannot run or exits non-zero — an unreadable process
 * table must never read as "nothing survived".
 */
export function readProcessTable(): ProcRow[] {
  const out = spawnSync('ps', ['-axww', '-o', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' });
  if (out.error !== undefined) {
    throw new Error(`BL-df0ea359: ps failed to run: ${String(out.error)}`);
  }
  if (out.status !== 0) {
    throw new Error(`BL-df0ea359: ps exited ${String(out.status)} (signal ${String(out.signal)}): ${out.stderr}`);
  }
  const rows: ProcRow[] = [];
  for (const line of out.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m === null) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4] ?? '' });
  }
  if (rows.length === 0) {
    throw new Error(`BL-df0ea359: ps returned no parsable rows:\n${out.stdout}`);
  }
  return rows;
}

/** Both spellings of the scratch root (macOS tmp paths may surface as `/private/var/...`). */
function scratchRootNeedles(scratchRoot: string): string[] {
  const needles = new Set<string>([scratchRoot]);
  try {
    needles.add(fs.realpathSync(scratchRoot));
  } catch (err) {
    log.warn('bl_df0ea359_scratch_realpath_failed', { scratchRoot, error: String(err) });
  }
  return [...needles];
}

function argvCarries(command: string, needles: readonly string[]): boolean {
  return needles.some((n) => command.includes(n));
}

function argValue(command: string, flag: string): string | null {
  const m = new RegExp(`(?:^|\\s)${flag}=(\\S+)`).exec(command);
  return m?.[1] ?? null;
}

// ── spawn + teardown ─────────────────────────────────────────────────────────

export interface RealEntrypointRun {
  child: ChildProcessWithoutNullStreams;
  scratchRoot: string;
  /** Every process observed as part of this run: pid -> last seen command. */
  seen: Map<number, string>;
  /** Stops the background sampler; idempotent. */
  stopSampler: () => void;
  /** Take one sample now (also called by the sampler on an interval). */
  sample: () => void;
}

export interface SpawnRealEntrypointOptions {
  tsxBin: string;
  entry: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  scratchRoot: string;
  sampleIntervalMs?: number;
}

/**
 * Spawn the real entrypoint through the tsx wrapper as the leader of its OWN process group
 * (`detached: true`), tagged with the scratch-root argv sentinel, and start a process-table
 * sampler that records the run's whole tree while it is still attributable by ppid (once the
 * server dies its children reparent to ppid 1 and a tree walk can no longer find them).
 */
export function spawnRealEntrypoint(opts: SpawnRealEntrypointOptions): RealEntrypointRun {
  const child = spawn(opts.tsxBin, [opts.entry, `${SCRATCH_ROOT_ARG_PREFIX}${opts.scratchRoot}`], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  const needles = scratchRootNeedles(opts.scratchRoot);
  const seen = new Map<number, string>();

  const sample = (): void => {
    const rootPid = child.pid;
    if (rootPid === undefined) return;
    const rows = readProcessTable();
    // Seed only from pids still running the SAME command first recorded for them: a pid the
    // kernel reused for an unrelated process must never be adopted (nor its children).
    const members = new Set<number>([rootPid]);
    for (const r of rows) {
      if (seen.get(r.pid) === r.command) members.add(r.pid);
    }
    // Fixpoint: descendants of any known member, plus anything carrying the scratch root,
    // plus any embed host whose --spawner-pid is a member (the host is detached and may be
    // reparented before a ppid walk sees it).
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of rows) {
        if (members.has(r.pid)) continue;
        const spawner = argValue(r.command, '--spawner-pid');
        if (
          members.has(r.ppid) ||
          r.pgid === rootPid ||
          argvCarries(r.command, needles) ||
          (spawner !== null && members.has(Number(spawner)))
        ) {
          members.add(r.pid);
          grew = true;
        }
      }
    }
    for (const r of rows) {
      // First sighting wins: never overwrite a recorded command (pid-reuse safety).
      if (members.has(r.pid) && !seen.has(r.pid)) seen.set(r.pid, r.command);
    }
  };

  let timer: NodeJS.Timeout | null = setInterval(() => {
    try {
      sample();
    } catch (err) {
      log.warn('bl_df0ea359_sampler_failed', { scratchRoot: opts.scratchRoot, error: String(err) });
    }
  }, opts.sampleIntervalMs ?? 250);
  timer.unref();
  const stopSampler = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  return { child, scratchRoot: opts.scratchRoot, seen, stopSampler, sample };
}

export interface EmbedHostSighting {
  pid: number;
  cacheDir: string | null;
  command: string;
}

export interface TeardownReport {
  /** True iff `kill(-pgid, 0)` reached ESRCH (every process in the spawned group is gone). */
  groupGone: boolean;
  /** True iff SIGTERM was not enough and the group needed SIGKILL. */
  groupEscalatedToKill: boolean;
  /**
   * Non-embed-host processes of this run (scratch root in argv, or in the spawned process
   * group) still alive right AFTER the group stop, before any reap. Must be empty: a
   * non-empty list is an orphaned memory-server the tree kill failed to take down.
   */
  aliveAfterTreeStop: ProcRow[];
  /** Every pid observed as part of the run. */
  seenPids: number[];
  /** Every embed host observed during the run, attributed by scratch argv or --spawner-pid. */
  embedHosts: EmbedHostSighting[];
  /** Embed hosts whose --cache-dir is NOT under the scratch root (must be empty). */
  foreignCacheEmbedHosts: EmbedHostSighting[];
  /** Pids that needed a reap signal after the group kill. */
  reaped: number[];
  /** Processes still alive after teardown that carry the scratch root or were seen in the run (must be empty). */
  survivors: ProcRow[];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    // EPERM: exists but not ours — still alive.
    log.warn('bl_df0ea359_liveness_probe_error', { pid, error: String(err) });
    return true;
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    log.warn('bl_df0ea359_group_probe_error', { pgid, error: String(err) });
    return true;
  }
}

function signalGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
      log.warn('bl_df0ea359_group_signal_failed', { pgid, sig, error: String(err) });
    }
  }
}

function signalPid(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
      log.warn('bl_df0ea359_pid_signal_failed', { pid, sig, error: String(err) });
    }
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(pred: () => boolean, timeoutMs: number, stepMs = 100): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await sleep(stepMs);
  }
  return pred();
}

export interface TeardownOptions {
  /** SIGTERM → SIGKILL grace for the spawned group and for each reap round. */
  termGraceMs?: number;
  /** Consecutive empty process-table samples required before declaring the run clean. */
  stableSamples?: number;
  /** Gap between stable-table samples. */
  stableIntervalMs?: number;
  /** Hard ceiling on the reap/stabilise phase. */
  reapDeadlineMs?: number;
}

/** Worst-case wall time of {@link teardownRealEntrypoint} with default options (for test timeouts). */
export const TEARDOWN_WORST_CASE_MS = 5_000 + 2_000 + 12_000 + 1_000 + 2_000;

/**
 * Verified-stop the whole run: group SIGTERM → poll ESRCH → group SIGKILL; then reap every
 * remaining process that carries the scratch root in argv or was seen in the run (the
 * detached embed host lives in its own group), and wait for `stableSamples` consecutive
 * process-table samples with no such process. Returns a report; the caller ASSERTS on it.
 */
export async function teardownRealEntrypoint(run: RealEntrypointRun, opts: TeardownOptions = {}): Promise<TeardownReport> {
  const termGraceMs = opts.termGraceMs ?? 5_000;
  const stableSamples = opts.stableSamples ?? 3;
  const stableIntervalMs = opts.stableIntervalMs ?? 250;
  const reapDeadlineMs = opts.reapDeadlineMs ?? 12_000;
  const needles = scratchRootNeedles(run.scratchRoot);

  // Final attribution sample while the tree is still intact (ppid links not yet broken).
  try {
    run.sample();
  } catch (err) {
    log.warn('bl_df0ea359_final_sample_failed', { scratchRoot: run.scratchRoot, error: String(err) });
  }
  run.stopSampler();

  const pgid = run.child.pid;
  let groupGone = true;
  let groupEscalatedToKill = false;
  if (pgid !== undefined && pgid > 1) {
    run.child.stdin.end();
    signalGroup(pgid, 'SIGTERM');
    groupGone = await waitUntil(() => !groupAlive(pgid), termGraceMs);
    if (!groupGone) {
      groupEscalatedToKill = true;
      signalGroup(pgid, 'SIGKILL');
      groupGone = await waitUntil(() => !groupAlive(pgid), 2_000);
    }
  }

  const aliveAfterTreeStop = readProcessTable().filter(
    (r) =>
      r.pid !== process.pid &&
      !r.command.includes('embedHostMain') &&
      (argvCarries(r.command, needles) || (pgid !== undefined && r.pgid === pgid)),
  );

  const seenPids = [...run.seen.keys()];
  const isOurs = (r: ProcRow): boolean => argvCarries(r.command, needles) || (run.seen.has(r.pid) && run.seen.get(r.pid) === r.command);

  const reaped = new Set<number>();
  const termedAt = new Map<number, number>();
  let clean = 0;
  let survivors: ProcRow[] = [];
  const reapStart = Date.now();
  while (Date.now() - reapStart < reapDeadlineMs) {
    const rows = readProcessTable();
    survivors = rows.filter((r) => r.pid !== process.pid && isOurs(r));
    for (const r of survivors) {
      if (!run.seen.has(r.pid)) run.seen.set(r.pid, r.command);
      const t = termedAt.get(r.pid);
      if (t === undefined) {
        reaped.add(r.pid);
        termedAt.set(r.pid, Date.now());
        signalPid(r.pid, 'SIGTERM');
      } else if (Date.now() - t > termGraceMs) {
        signalPid(r.pid, 'SIGKILL');
      }
    }
    clean = survivors.length === 0 ? clean + 1 : 0;
    if (clean >= stableSamples) break;
    await sleep(stableIntervalMs);
  }
  // Deadline hit with processes still standing: SIGKILL every one we SIGTERM'd that is still
  // running the command we signalled, so a late-seen process never escapes its escalation.
  if (clean < stableSamples) {
    const rows = readProcessTable();
    for (const r of rows) {
      if (termedAt.has(r.pid) && isOurs(r)) signalPid(r.pid, 'SIGKILL');
    }
    await sleep(500);
  }
  // Last word comes from the process table, never from the loop's bookkeeping.
  survivors = readProcessTable().filter((r) => r.pid !== process.pid && isOurs(r) && isAlive(r.pid));

  const embedHosts: EmbedHostSighting[] = [...run.seen.entries()]
    .filter(([, command]) => command.includes('embedHostMain'))
    .map(([pid, command]) => ({ pid, cacheDir: argValue(command, '--cache-dir'), command }));
  const foreignCacheEmbedHosts = embedHosts.filter(
    (h) => h.cacheDir === null || !needles.some((n) => h.cacheDir!.startsWith(n + path.sep)),
  );

  return {
    groupGone,
    groupEscalatedToKill,
    aliveAfterTreeStop,
    seenPids,
    embedHosts,
    foreignCacheEmbedHosts,
    reaped: [...reaped],
    survivors,
  };
}

/**
 * BL-df0ea359 teardown contract, asserted (never merely logged) by both real-entrypoint specs:
 * the spawned tree died to the group stop with no orphaned server, nothing carrying the
 * scratch root survived the reap, and every embed host the run used had its `--cache-dir`
 * under the scratch root.
 */
export function assertCleanTeardown(report: TeardownReport): void {
  const fmt = (rows: ProcRow[]): string => rows.map((r) => `${r.pid} (ppid ${r.ppid}, pgid ${r.pgid}): ${r.command}`).join('\n');
  assert.deepEqual(report.aliveAfterTreeStop, [], `orphaned run processes after the tree stop:\n${fmt(report.aliveAfterTreeStop)}`);
  assert.equal(report.groupGone, true, 'spawned process group still has live members');
  assert.deepEqual(report.survivors, [], `scratch-root processes alive after teardown:\n${fmt(report.survivors)}`);
  assert.deepEqual(report.foreignCacheEmbedHosts, [], 'embed hosts seen this run with a --cache-dir outside the scratch root');
}
