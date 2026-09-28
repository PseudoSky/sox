/**
 * scripts/lib/embed-host-isolation.mjs — the smoke harness's embedding-host
 * isolation audit and verified-stop reap (backlog 26121495, 97e7f214).
 *
 * WHY THIS LIVES IN THE HARNESS, NOT IN PRODUCT CODE
 * ADR-0022 §5 (docs/decisions/0022-embedding-funnel-is-a-work-driven-drainer.md)
 * makes the embedding host a detached, box-wide peer: it is spawned in its own
 * process group, inherits HOME/TMPDIR/XDG_CACHE_HOME from its spawner, appears
 * in no service's reap set, and self-retirement after an idle window is its
 * ONLY lifecycle. Every one of those properties is intended. A test harness
 * that spawns embedding consumers is therefore the party responsible for
 * (a) giving those consumers an environment that cannot resolve to the
 * operator's model cache or a shared temp-dir socket, (b) proving that it did,
 * and (c) verified-stopping the hosts its own run created instead of leaving
 * them to idle out (docs/spec/service-lifecycle.md §8.3 verified stop).
 *
 * 26121495 — the old isolation check compared only live data-root FILES, so an
 * embedding host that ran with the operator's HOME, the operator's model cache
 * or a socket under the OS temp dir passed as "isolation OK". The audit here is
 * POSITIVE CONTAINMENT: for every host attributed to the smoke run, HOME,
 * `--cache-dir` and `--socket` must each resolve inside a smoke-owned root.
 * Anything else is a violation, which the harness turns into a failed run.
 *
 * 97e7f214 — the no-proxy leg's teardown signalled only the `soxe` process
 * group. The embedding host is spawned detached (its own group leader, ppid 1
 * once its spawner exits), so a group kill can never reach it and it lingered
 * until its idle window elapsed. {@link reapEmbedHosts} stops each attributed
 * host (and its fastembed child) individually with SIGTERM → poll → SIGKILL →
 * re-verify, and reports any survivor as undead.
 *
 * Attribution is by LINEAGE, never by "any embed host on the box": concurrent
 * agents and the production memory-server legitimately run hosts with the
 * operator's HOME. A host is the smoke run's when its argv or environment names
 * a smoke root, or its `--spawner-pid` is a pid the run spawned and it started
 * no earlier than the run did. Hosts that are not the run's are reported as
 * foreign and are NEVER signalled.
 *
 * Pure module (node builtins only, all process I/O injected) so it can be
 * pinned by tools/test-26121495-*.mjs and tools/test-97e7f214-*.mjs without a
 * build.
 */

import * as path from 'node:path';

/** Basenames of the two embedding-host processes (ADR-0022). */
export const EMBED_HOST_MAIN = 'embedHostMain.js';
export const FASTEMBED_CHILD = 'fastembedProcessHost.js';

const PROC_RE = /(?:^|[\s/])(embedHostMain|fastembedProcessHost)\.js(?=\s|$)/;

/** The `ps` invocation whose output {@link parsePsLines} understands. */
export const PS_ARGS = ['-axEww', '-o', 'pid=,ppid=,pgid=,etime=,command='];

/** `[[dd-]hh:]mm:ss` → seconds (NaN when unparseable). */
export function parseEtime(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(s).trim());
  if (!m) return Number.NaN;
  return (Number(m[1] ?? 0) * 86400) + (Number(m[2] ?? 0) * 3600) + (Number(m[3]) * 60) + Number(m[4]);
}

/** Pull `KEY=value` (whitespace-bounded) out of a `ps -E` line. */
function envValue(line, key) {
  const m = new RegExp(`(?:^|\\s)${key}=(\\S*)`).exec(line);
  return m ? m[1] : null;
}

/** Pull `--flag=value` out of the host argv (ADR-0022 §5 uses the `=` form). */
function flagValue(line, flag) {
  const m = new RegExp(`(?:^|\\s)--${flag}=(\\S+)`).exec(line);
  return m ? m[1] : null;
}

/**
 * Parse `ps -axEww -o pid=,ppid=,pgid=,etime=,command=` output into embedding
 * host records. Lines for any other process are skipped.
 *
 * @param {string} raw
 * @param {number} nowMs  wall clock at capture time (to derive a start time from etime)
 */
export function parsePsLines(raw, nowMs) {
  const out = [];
  for (const line of String(raw ?? '').split('\n')) {
    const pm = PROC_RE.exec(line);
    if (!pm) continue;
    const t = line.trim().split(/\s+/);
    const pid = Number(t[0]);
    if (!(pid > 0)) continue;
    const etimeS = parseEtime(t[3]);
    out.push({
      pid,
      ppid: Number(t[1]),
      pgid: Number(t[2]),
      startedMs: Number.isFinite(etimeS) ? nowMs - etimeS * 1000 : Number.NaN,
      kind: pm[1] === 'embedHostMain' ? 'host' : 'child',
      home: envValue(line, 'HOME'),
      tmpdir: envValue(line, 'TMPDIR'),
      xdgCacheHome: envValue(line, 'XDG_CACHE_HOME'),
      dataRoot: envValue(line, 'SOX_ECOSYSTEM_HOME'),
      socket: flagValue(line, 'socket'),
      cacheDir: flagValue(line, 'cache-dir'),
      spawnerPid: Number(flagValue(line, 'spawner-pid') ?? Number.NaN),
      line,
    });
  }
  return out;
}

/**
 * macOS reaches /tmp and /var through /private. Compare every path in both
 * spellings so a realpath'd and an un-realpath'd form of one directory agree.
 */
function spellings(p) {
  const n = path.resolve(String(p));
  const out = new Set([n]);
  if (n.startsWith('/private/')) out.add(n.slice('/private'.length));
  else if (/^\/(?:tmp|var)(?:\/|$)/.test(n)) out.add(`/private${n}`);
  return [...out];
}

/** True when `p` is `root` or lies beneath it (in any /private spelling). */
export function isInsideRoot(p, root) {
  if (typeof p !== 'string' || p === '' || typeof root !== 'string' || root === '') return false;
  for (const a of spellings(p)) {
    for (const r of spellings(root)) {
      if (a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep)) return true;
    }
  }
  return false;
}

function insideAny(p, roots) {
  return roots.some((r) => isInsideRoot(p, r));
}

/**
 * Is this host record the smoke run's? Lineage only (see the module header).
 *
 * @param {object} proc  a {@link parsePsLines} record
 * @param {{ smokeRoots: string[], spawnedPids: Set<number>, runStartedMs: number, hostPids?: Set<number> }} ctx
 */
export function isSmokeOwned(proc, ctx) {
  if (ctx.smokeRoots.some((r) => r && proc.line.includes(r))) return true;
  if (ctx.hostPids && ctx.hostPids.has(proc.ppid)) return true; // fastembed child of a smoke host
  if (Number.isFinite(proc.spawnerPid) && ctx.spawnedPids.has(proc.spawnerPid)) {
    // A recycled pid cannot make a pre-existing host the run's: it must have
    // started no earlier than the run (1 s slack for etime's resolution).
    return Number.isFinite(proc.startedMs) && proc.startedMs >= ctx.runStartedMs - 1000;
  }
  return false;
}

/**
 * Positive containment for one smoke-owned host (26121495): HOME, the model
 * cache and the socket must each resolve inside a smoke root. Returns the list
 * of violations (empty = contained).
 */
export function containmentViolations(proc, smokeRoots) {
  const v = [];
  if (proc.home === null) v.push('HOME unset (os.homedir() would resolve to the operator home)');
  else if (!insideAny(proc.home, smokeRoots)) v.push(`HOME=${proc.home} is outside the smoke root`);
  if (proc.kind === 'host') {
    if (proc.cacheDir === null) v.push('--cache-dir missing');
    else if (!insideAny(proc.cacheDir, smokeRoots)) v.push(`--cache-dir=${proc.cacheDir} is outside the smoke root (shared model cache)`);
    if (proc.socket === null) v.push('--socket missing');
    else if (!insideAny(proc.socket, smokeRoots)) v.push(`--socket=${proc.socket} is outside the smoke root (shared socket path class)`);
  }
  return v;
}

/**
 * Classify every embedding-host record. Children are attributed through their
 * parent host so a fastembed child is never reaped without its host's lineage.
 *
 * @returns {{ smoke: object[], foreign: object[], violations: {pid:number, kind:string, reasons:string[]}[] }}
 */
export function auditEmbedHosts(procs, ctx) {
  const hostPids = new Set();
  for (const p of procs) if (p.kind === 'host' && isSmokeOwned(p, ctx)) hostPids.add(p.pid);
  const withHosts = { ...ctx, hostPids };
  const smoke = [];
  const foreign = [];
  const violations = [];
  for (const p of procs) {
    if (!isSmokeOwned(p, withHosts)) { foreign.push(p); continue; }
    smoke.push(p);
    const reasons = containmentViolations(p, ctx.smokeRoots);
    if (reasons.length > 0) violations.push({ pid: p.pid, kind: p.kind, reasons });
  }
  return { smoke, foreign, violations };
}

/** One-line human description of a host record. */
export function describeHost(p) {
  return `pid=${p.pid} ${p.kind} ppid=${p.ppid} pgid=${p.pgid} HOME=${p.home ?? '-'} TMPDIR=${p.tmpdir ?? '-'} ` +
    `SOX_ECOSYSTEM_HOME=${p.dataRoot ?? '-'} socket=${p.socket ?? '-'} cache-dir=${p.cacheDir ?? '-'} spawner-pid=${Number.isFinite(p.spawnerPid) ? p.spawnerPid : '-'}`;
}

/**
 * Verified stop (docs/spec/service-lifecycle.md §8.3 shape) of each pid:
 * SIGTERM → poll for ESRCH → SIGKILL → re-verify. Hosts are signalled before
 * their children so a host's own ordered retire can terminate its pool first.
 *
 * @param {number[]} pids
 * @param {{ kill: (pid:number, sig:string|number)=>void, sleep: (ms:number)=>Promise<void>, log?: (s:string)=>void, termMs?: number, killMs?: number }} io
 * @returns {Promise<{ stopped: number[], undead: number[] }>}
 */
export async function reapEmbedHosts(pids, io) {
  const termMs = io.termMs ?? 5000;
  const killMs = io.killMs ?? 3000;
  const alive = (pid) => {
    try {
      io.kill(pid, 0);
      return true;
    } catch (e) {
      if (e && e.code === 'ESRCH') return false;
      // EPERM means it exists but is not ours to signal — still alive.
      if (io.log) io.log(`probe of pid ${pid} failed: ${(e && e.code) ?? ''} ${(e && e.message) ?? e}`);
      return true;
    }
  };
  const signal = (pid, sig) => {
    try {
      io.kill(pid, sig);
    } catch (e) {
      if (!e || e.code !== 'ESRCH') {
        if (io.log) io.log(`${sig} to pid ${pid} failed: ${(e && e.code) ?? ''} ${(e && e.message) ?? e}`);
      }
    }
  };
  const waitGone = async (set, ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && [...set].some(alive)) await io.sleep(100);
  };
  const targets = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0);
  for (const pid of targets) signal(pid, 'SIGTERM');
  await waitGone(targets, termMs);
  const stubborn = targets.filter(alive);
  for (const pid of stubborn) signal(pid, 'SIGKILL');
  if (stubborn.length > 0) await waitGone(stubborn, killMs);
  const undead = targets.filter(alive);
  return { stopped: targets.filter((p) => !undead.includes(p)), undead };
}

/**
 * Audit, then verified-stop every smoke-owned host, then re-scan once after
 * `rescanMs` to catch a host spawned during teardown. Foreign hosts are only
 * reported. The caller fails its step on `violations` or `undead`.
 *
 * @param {{ smokeRoots: string[], spawnedPids: Set<number>, runStartedMs: number }} ctx
 * @param {{ ps: () => string|null, now: () => number, kill: Function, sleep: Function, log?: Function, rescanMs?: number, termMs?: number, killMs?: number }} io
 */
export async function auditAndReapEmbedHosts(ctx, io) {
  const seen = new Map();
  const violations = [];
  const foreign = new Map();
  const undead = new Set();
  const stopped = new Set();
  let psFailed = false;
  for (let pass = 0; pass < 2; pass++) {
    if (pass === 1) await io.sleep(io.rescanMs ?? 750);
    const raw = io.ps();
    if (raw === null) { psFailed = true; continue; }
    const procs = parsePsLines(raw, io.now());
    const audit = auditEmbedHosts(procs, ctx);
    for (const p of audit.foreign) foreign.set(p.pid, p);
    for (const v of audit.violations) if (!violations.some((x) => x.pid === v.pid)) violations.push(v);
    const fresh = audit.smoke.filter((p) => !stopped.has(p.pid));
    for (const p of fresh) seen.set(p.pid, p);
    if (fresh.length === 0) continue;
    // Hosts first, then children (see reapEmbedHosts).
    const ordered = [...fresh.filter((p) => p.kind === 'host'), ...fresh.filter((p) => p.kind !== 'host')].map((p) => p.pid);
    const r = await reapEmbedHosts(ordered, io);
    for (const pid of r.stopped) { stopped.add(pid); undead.delete(pid); }
    for (const pid of r.undead) undead.add(pid);
  }
  return {
    smoke: [...seen.values()],
    foreign: [...foreign.values()],
    violations,
    stopped: [...stopped],
    undead: [...undead],
    psFailed,
  };
}

/**
 * The pass/fail verdict for one audit+reap result (26121495, 97e7f214).
 *
 * `requireObserved` is set for a leg KNOWN to embed (the memory-server serve
 * legs). For such a leg, zero attributed hosts is not "clean" — it means
 * attribution found nothing to check, which is exactly the no-evidence
 * false-green 26121495 was filed for (e.g. the host env stops carrying the smoke
 * root, or the `ps -E` format changes). It fails closed.
 *
 * @param {{ smoke: object[], undead: number[], violations: {pid:number, reasons:string[]}[], psFailed: boolean }} r
 * @param {{ requireObserved?: boolean }} [opts]
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function embedGateVerdict(r, opts = {}) {
  const problems = [];
  if (r.psFailed) problems.push('embed-host ps capture failed — reap unverifiable');
  if (opts.requireObserved && r.smoke.length === 0 && !r.psFailed) {
    problems.push('no smoke-owned embedding host was observed for a leg that embeds — attribution found nothing to verify (no evidence is not a pass)');
  }
  if (r.undead.length > 0) problems.push(`embed host(s) survived verified stop: ${r.undead.join(', ')}`);
  if (r.violations.length > 0) {
    problems.push(`embed host isolation breach: ${r.violations.map((v) => `pid ${v.pid}: ${v.reasons.join('; ')}`).join(' | ')}`);
  }
  return { ok: problems.length === 0, problems };
}
