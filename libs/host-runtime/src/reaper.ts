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
import * as fs from 'node:fs';
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
 * Snapshot the OS process table as a `pid → ppid` map via ONE `ps` scan.
 *
 * The ancestry primitive behind BL-621's ancestry-rooted reconcile
 * classification: a process is reapable only if its kernel parentage chain
 * reaches NO live tracked-instance root and NO live writer-socket holder.
 * `descendantOf` (reconcile.ts) walks this map; an EMPTY map on failure makes
 * every candidate "no ancestry data", which degrades to report-only — never to
 * a kill. Uses the same `-A -ww` portable flags as snapshotProcesses().
 */
export function snapshotProcessTable(): Map<number, number> {
  const table = new Map<number, number>();
  let out: string;
  try {
    out = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,ppid='], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return table;
  }
  for (const line of out.split('\n')) {
    const m = /^(\d+)\s+(\d+)/.exec(line.trimStart());
    if (!m) continue;
    table.set(Number(m[1]), Number(m[2]));
  }
  return table;
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

// ─── PI-1: identity-based matching by SOX_SERVICE_ID env ──────────────────────

/**
 * Read the environment block for a given PID via `ps -o env`.
 * Returns null on failure or if the platform doesn't support ps -o env.
 */
/**
 * Memoized `ps -o env` capability. `env` is a procps (Linux) keyword; BSD/macOS
 * ps rejects it on EVERY invocation — and findOrphansByServiceId probes every
 * process in the snapshot, so without this memo each reconcile pass runs
 * hundreds of doomed execs whose inherited stderr floods the caller's log
 * (observed: 2.5 MB/day of `ps: env: keyword not found` in the doctor-tick
 * os-unit log, 2026-07-04). First failure latches `false`; later calls skip
 * straight to the argv fallback. null = not yet probed.
 */
let psEnvSupported: boolean | null = null;

export function readProcessEnv(pid: number): Record<string, string> | null {
  if (psEnvSupported === false) return null;
  try {
    const out = execFileSync('ps', ['-o', 'env=', '-p', String(pid)], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      timeout: 2000,
      // Capture the child's stderr instead of inheriting it — a failing probe
      // must never spam the supervisor/tick log.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    psEnvSupported = true;
    const env: Record<string, string> = {};
    for (const line of out.split('\0')) {
      const eq = line.indexOf('=');
      if (eq > 0) {
        const k = line.slice(0, eq);
        const v = line.slice(eq + 1);
        if (k) env[k] = v;
      }
    }
    return env;
  } catch (e) {
    // Latch "unsupported" ONLY on the keyword error — a dead/foreign pid also
    // throws (ps exits 1) on platforms where the keyword IS valid, and that
    // must not disable env matching for the rest of the process lifetime.
    const msg = `${String((e as { stderr?: unknown }).stderr ?? '')} ${String((e as Error).message ?? '')}`;
    if (msg.includes('keyword')) psEnvSupported = false;
    return null;
  }
}

/** TEST-ONLY: reset the memoized `ps -o env` capability probe. */
export function _resetPsEnvProbeForTest(): void {
  psEnvSupported = null;
}

/**
 * Find every live process whose env contains `SOX_SERVICE_ID=<serviceId>`.
 * Falls back to argv-based token matching when the env probe is unavailable
 * (e.g. permissions, platform without ps -o env).
 */
export function findOrphansByServiceId(
  serviceId: string,
  token: string,
  opts: { excludePids?: number[] | undefined } = {},
): OrphanMatch[] {
  if (!serviceId && !token) return [];
  const exclude = new Set<number>([process.pid, ...(opts.excludePids ?? [])]);

  // Prefer env-based matching (cross-build safe).
  const envMatches: OrphanMatch[] = [];
  if (serviceId && process.platform === 'darwin') {
    // BL-177: BSD/macOS ps has no `env` output keyword — env matching was
    // silently INERT here (every per-pid `ps -o env` probe failed). BSD ps
    // DOES support `-E` (append the environment to each command line), so a
    // single whole-table scan restores SOX_SERVICE_ID matching AND replaces
    // the O(N)-subprocess per-pid probing. Values with spaces are ambiguous
    // in the -E format, but SOX_SERVICE_ID values are space-free identifiers
    // — an exact whitespace-delimited token match is precise.
    try {
      const out = execFileSync('ps', ['-E', '-A', '-ww', '-o', 'pid=,ppid=,args='], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024, // env blocks inflate lines well past argv size
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const needle = `SOX_SERVICE_ID=${serviceId}`;
      for (const line of out.split('\n')) {
        const m = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line.trimStart());
        if (!m) continue;
        const pid = Number(m[1]);
        const ppid = Number(m[2]);
        const argsAndEnv = m[3] ?? '';
        if (exclude.has(pid)) continue;
        if (argsAndEnv.split(/\s+/).includes(needle)) {
          envMatches.push({ pid, ppid, args: argsAndEnv, orphaned: ppid === 1 });
        }
      }
    } catch {
      /* -E unavailable or ps failed — fall through to the argv fallback */
    }
  } else if (serviceId) {
    // procps (Linux): per-pid `ps -o env=` probes, memoized off after the
    // first keyword failure (readProcessEnv).
    for (const p of snapshotProcesses()) {
      if (exclude.has(p.pid)) continue;
      const env = readProcessEnv(p.pid);
      if (env && env['SOX_SERVICE_ID'] === serviceId) {
        envMatches.push({ ...p, orphaned: p.ppid === 1 });
      }
    }
  }
  if (envMatches.length > 0) return envMatches;

  // Fall back to argv-based token matching (pre-PI-1 compatibility).
  if (token) {
    return findOrphansByIdentity(token, opts);
  }
  return [];
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

// ─── PI-4: Process snapshot (soxe ps) ───────────────────────────────────────

/**
 * Provenance of a process row in the `soxe ps` merged table.
 */
export type ProcessRowSource =
  | 'supervisor-registry'  // Tracked by the global supervisor registry
  | 'os-unit'              // Managed by launchd/systemd (OS supervisor)
  | 'proxy-backend'        // Auto-spawned backend (in-proc singleton)
  | 'ps-scan'              // Found by OS process table scan (unmanaged/stray)
  | 'stale-socket';        // Orphaned socket file with no live pid

export interface ProcessSnapshotRow {
  /** Unique row id (pid or socket-path-hash). */
  id: string;
  /** OS pid (0 for socket-only rows). */
  pid: number;
  /** Source of this row. */
  source: ProcessRowSource;
  /** Extension id, when identifiable. */
  extId: string;
  /** Scope (user/project/local). */
  scope: string;
  /** Process status: 'alive' | 'dead' | 'unmanaged' | 'stale'. */
  status: 'alive' | 'dead' | 'unmanaged' | 'stale';
  /** Build hash or SHA from the artifact, when available. */
  buildHash?: string;
  /** Version string from the extension manifest, when available. */
  version?: string;
  /** PID of the owner process (proxy registry, etc.), or 0. */
  ownerPid?: number;
  /** UDS socket path, when applicable. */
  socketPath?: string;
  /** Human-readable detail. */
  detail?: string;
}

/**
 * Gather a complete process snapshot by merging:
 * 1. Global supervisor registry — tracked supervisor processes.
 * 2. OS-unit states (launchd/systemctl) — daemon services.
 * 3. Proxy backend lock files — auto-spawned backends.
 * 4. OS-truth ps/lsof scan — unmanaged/stray processes.
 *
 * @param supervisorRegistryEntries Live supervisor registry entries (from readGlobalRegistry).
 * @param socketDir The socket directory path.
 * @param logDir The runtime log directory path.
 * @param scope Optional scope filter.
 */
export function gatherProcessSnapshot(
  supervisorRegistryEntries: Array<{ supervisorId: string; scope: string; pid: number; logDir: string; execSocketPath: string; root: string; startedAt: string; hostname: string; runtimeFilePath: string }>,
  socketDirPath: string,
  _logDirPath: string,
  scope?: string,
): ProcessSnapshotRow[] {
  const rows: ProcessSnapshotRow[] = [];

  // 1. Supervisor registry entries.
  for (const entry of supervisorRegistryEntries) {
    if (scope && entry.scope !== scope) continue;
    rows.push({
      id: `sup-${entry.supervisorId}`,
      pid: entry.pid,
      source: 'supervisor-registry',
      extId: entry.supervisorId, // supervisor id
      scope: entry.scope,
      status: pidAlive(entry.pid) ? 'alive' : 'dead',
      socketPath: entry.execSocketPath,
      detail: `runtime=${entry.runtimeFilePath}`,
    });
  }

  // 2. OS-unit scan: discover plist/service files under user-scope dirs.
  // On macOS: scan ~/Library/LaunchAgents for com.sox.*.plist.
  // On Linux: scan ~/.config/systemd/user for sox-*.service.
  const osSupervisor = require('./os-unit.js') as typeof import('./os-unit.js');
  const platform = osSupervisor.getOsUnitPlatform();
  try {
    const unitDir = platform.defaultUnitDir();
    if (fs.existsSync(unitDir)) {
      const files = fs.readdirSync(unitDir);
      const soxUnits = files.filter((f) =>
        f.includes('sox') || f.startsWith('com.sox.'),
      );
      for (const unitFile of soxUnits) {
        // Extract label from filename: com.sox.<scope>.<extId>.plist
        let label = unitFile.replace(/\.(plist|service)$/, '');
        if (label.startsWith('sox-')) {
          // systemd naming: sox-<scope>-<extId>.service
          label = 'com.sox.' + label.slice(4).replace(/-/g, '.');
        }
        const loaded = platform.isLoaded(label, osSupervisor.realOsExec);
        const match = label.match(/^com\.sox\.([^.]+)\.(.+)$/);
        const extId = match?.[2] ?? label;
        const unitScope = match?.[1] ?? '?';
        if (scope && unitScope !== scope) continue;
        rows.push({
          id: `os-${label}`,
          pid: 0, // OS supervisor manages the pid
          source: 'os-unit',
          extId,
          scope: unitScope,
          status: loaded ? 'alive' : 'dead',
          detail: loaded ? `loaded:${unitFile}` : `unloaded:${unitFile}`,
        });
      }
    }
  } catch {
    // OS-unit scan best-effort
  }

  // 3. Proxy backend lock files under socketDir.
  try {
    if (fs.existsSync(socketDirPath)) {
      const files = fs.readdirSync(socketDirPath);
      const proxyLocks = files.filter((f) => f.startsWith('proxy-backend-') && f.endsWith('.lock'));
      for (const lockFile of proxyLocks) {
        const lockPath = path.join(socketDirPath, lockFile);
        try {
          const payload = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
            pid: number; t: number; key: string;
          };
          const live = pidAlive(payload.pid);
          // Try to extract extId from the singleton key.
          const extId = payload.key.includes(':')
            ? payload.key.split(':')[0] ?? '?'
            : '?';
          rows.push({
            id: `proxy-${lockFile}`,
            pid: payload.pid,
            source: 'proxy-backend',
            extId,
            scope: scope ?? '?',
            status: live ? 'alive' : 'stale',
            ownerPid: payload.pid,
            detail: `lock:${lockFile} key:${payload.key}`,
          });
        } catch {
          // Corrupt lock file — skip
        }
      }
      // Also scan for .sock files matching proxy pattern.
      const proxySocks = files.filter((f) => f.startsWith('proxy-') && f.endsWith('.sock'));
      for (const sockFile of proxySocks) {
        const sockPath = path.join(socketDirPath, sockFile);
        const alreadyListed = rows.some((r) => r.socketPath === sockPath);
        if (!alreadyListed) {
          rows.push({
            id: `sock-${sockFile}`,
            pid: 0,
            source: 'stale-socket',
            extId: '?',
            scope: scope ?? '?',
            status: 'stale',
            socketPath: sockPath,
            detail: `orphan-socket:${sockFile}`,
          });
        }
      }
    }
  } catch {
    // Socket scan best-effort
  }

  // 4. OS-truth pass: scan ps for processes with SOX_SERVICE_ID env var.
  // This catches unmanaged/stray processes that are not in any registry.
  const allProcs = snapshotProcesses();
  for (const p of allProcs) {
    if (p.pid === process.pid) continue;
    const env = readProcessEnv(p.pid);
    if (env && env['SOX_SERVICE_ID']) {
      const svcId = env['SOX_SERVICE_ID'];
      // Skip if already tracked (dedup by pid).
      const tracked = rows.some((r) => r.pid === p.pid && r.source !== 'ps-scan');
      if (tracked) continue;
      rows.push({
        id: `ps-${p.pid}`,
        pid: p.pid,
        source: 'ps-scan',
        extId: svcId,
        scope: scope ?? '?',
        status: 'unmanaged',
        detail: `SOX_SERVICE_ID=${svcId} ppid=${p.ppid}`,
      });
    }
  }

  return rows;
}
