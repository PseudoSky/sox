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

// e5cf17a0: `ps -E` joins argv and environment with single spaces and quotes
// nothing, so a value ends where the NEXT `NAME=` / `--flag=` token begins — not
// at the first whitespace. `\S+` truncated `HOME=/Users/op/My Smoke/home` to
// `/Users/op/My`, which then failed (or worse, passed) containment on a prefix.
const NEXT_ENV = '\\s+[A-Za-z_][A-Za-z0-9_]*=';
const NEXT_FLAG = '\\s+--[A-Za-z][A-Za-z0-9-]*=';

/** Pull `KEY=value` out of a `ps -E` line (value may contain spaces). */
export function envValue(line, key) {
  const m = new RegExp(`(?:^|\\s)${key}=(.*?)(?=${NEXT_ENV}|${NEXT_FLAG}|\\s*$)`).exec(line);
  return m ? m[1] : null;
}

/** Pull `--flag=value` out of the host argv (ADR-0022 §5 uses the `=` form; value may contain spaces). */
export function flagValue(line, flag) {
  const m = new RegExp(`(?:^|\\s)--${flag}=(.*?)(?=${NEXT_FLAG}|${NEXT_ENV}|\\s*$)`).exec(line);
  return m && m[1] !== '' ? m[1] : null;
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

/** Two etime-derived start estimates of ONE process differ by < 1 s each way. */
const SAME_START_MS = 2000;

/**
 * Is this host record the smoke run's? Lineage only (see the module header).
 *
 * e5cf17a0:
 *  - `ownedIds` (pid → startedMs) remembers every record a previous audit
 *    attributed. A fastembed child attributed through its parent host keeps its
 *    ownership after that host dies and it is reparented to pid 1; the start
 *    time must match, so a recycled pid never inherits it.
 *  - `spawnStartedMs` (pid → startedMs) is when each spawned pid itself started.
 *    A host is attributed by `--spawner-pid` only when it started no earlier than
 *    THAT spawner (1 s etime slack) — the run-wide start alone let a host whose
 *    spawner pid was recycled mid-run by a smoke child count as the run's.
 *    Without an entry the run start is the (weaker) floor.
 *
 * @param {object} proc  a {@link parsePsLines} record
 * @param {{ smokeRoots: string[], spawnedPids: Set<number>, runStartedMs: number, hostPids?: Set<number>,
 *           ownedIds?: Map<number, number>, spawnStartedMs?: Map<number, number> }} ctx
 */
export function isSmokeOwned(proc, ctx) {
  if (ctx.smokeRoots.some((r) => r && proc.line.includes(r))) return true;
  if (ctx.ownedIds && ctx.ownedIds.has(proc.pid)) {
    const was = ctx.ownedIds.get(proc.pid);
    if (Number.isFinite(was) && Number.isFinite(proc.startedMs) && Math.abs(was - proc.startedMs) < SAME_START_MS) return true;
  }
  if (ctx.hostPids && ctx.hostPids.has(proc.ppid)) return true; // fastembed child of a smoke host
  if (Number.isFinite(proc.spawnerPid) && ctx.spawnedPids.has(proc.spawnerPid)) {
    const spawnerStart = ctx.spawnStartedMs?.get(proc.spawnerPid);
    const floor = Number.isFinite(spawnerStart) ? spawnerStart : ctx.runStartedMs;
    // A recycled pid cannot make an older host the run's (1 s slack for etime's resolution).
    return Number.isFinite(proc.startedMs) && proc.startedMs >= floor - 1000;
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
 * Verified stop (docs/spec/service-lifecycle.md §8.3 shape), ordered (e5cf17a0):
 *   1. SIGTERM every host, poll for ESRCH — a host's own ordered retire
 *      terminates its fastembed pool, so most children need no signal at all;
 *   2. SIGTERM only the children that SURVIVED that, poll again;
 *   3. SIGKILL whatever is left — but only after re-reading its identity
 *      (`io.identity`: start time + argv) and finding it unchanged, so a pid the
 *      kernel recycled for an unrelated process during the wait is never killed;
 *   4. re-verify; anything still alive is undead.
 *
 * `targets` are {@link parsePsLines} records (or `{ pid, kind }`); a bare pid is
 * treated as a host. Without `io.identity` step 3 skips the re-check.
 *
 * @param {Array<number|{pid:number, kind?:string}>} targets
 * @param {{ kill: (pid:number, sig:string|number)=>void, sleep: (ms:number)=>Promise<void>, identity?: (pid:number)=>string|null,
 *           log?: (s:string)=>void, termMs?: number, killMs?: number }} io
 * @returns {Promise<{ stopped: number[], undead: number[], identityChanged: number[] }>}
 */
export async function reapEmbedHosts(targets, io) {
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
  const waitGone = async (list, ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && list.some(alive)) await io.sleep(100);
  };
  const recs = new Map();
  for (const t of targets) {
    const r = typeof t === 'number' ? { pid: t, kind: 'host' } : t;
    if (Number.isInteger(r.pid) && r.pid > 0 && !recs.has(r.pid)) recs.set(r.pid, r);
  }
  const all = [...recs.keys()];
  const hosts = all.filter((p) => recs.get(p).kind === 'host');
  const children = all.filter((p) => recs.get(p).kind !== 'host');
  const identity0 = new Map();
  if (io.identity) for (const pid of all) identity0.set(pid, io.identity(pid));

  for (const pid of hosts) signal(pid, 'SIGTERM');
  if (hosts.length > 0) await waitGone(hosts, termMs);
  const orphanedChildren = children.filter(alive);
  for (const pid of orphanedChildren) signal(pid, 'SIGTERM');
  if (orphanedChildren.length > 0) await waitGone(orphanedChildren, termMs);

  const identityChanged = [];
  const killed = [];
  for (const pid of all.filter(alive)) {
    if (io.identity) {
      const now = io.identity(pid);
      if (now === null || now !== identity0.get(pid)) {
        identityChanged.push(pid);
        if (io.log) io.log(`pid ${pid} identity changed before SIGKILL (was ${JSON.stringify(identity0.get(pid))}, now ${JSON.stringify(now)}) — not ours any more, not killed`);
        continue;
      }
    }
    signal(pid, 'SIGKILL');
    killed.push(pid);
  }
  if (killed.length > 0) await waitGone(killed, killMs);
  const undead = killed.filter(alive);
  return { stopped: all.filter((p) => !undead.includes(p) && !identityChanged.includes(p)), undead, identityChanged };
}

/** Verified stop of plain pids (e.g. the proxy leg's backend), same §8.3 shape. */
export function verifiedStop(pids, io) {
  return reapEmbedHosts(pids.map((pid) => ({ pid, kind: 'host' })), io);
}

/**
 * Audit, then verified-stop every smoke-owned host, then re-scan once after
 * `rescanMs` to catch a host spawned during teardown. Foreign hosts are only
 * reported. The caller fails its step on `violations` or `undead`.
 *
 * `ctx.ownedIds`, when supplied, is updated in place with every record this call
 * attributes, so the caller's later audits keep a reparented child the run's.
 *
 * @param {{ smokeRoots: string[], spawnedPids: Set<number>, runStartedMs: number, ownedIds?: Map<number, number>, spawnStartedMs?: Map<number, number> }} ctx
 * @param {{ ps: () => string|null, now: () => number, kill: Function, sleep: Function, identity?: Function, log?: Function, rescanMs?: number, termMs?: number, killMs?: number }} io
 */
export async function auditAndReapEmbedHosts(ctx, io) {
  const seen = new Map();
  const violations = [];
  const foreign = new Map();
  const undead = new Set();
  const stopped = new Set();
  const ownedIds = ctx.ownedIds ?? new Map();
  const actx = { ...ctx, ownedIds };
  let psFailed = false;
  for (let pass = 0; pass < 2; pass++) {
    if (pass === 1) await io.sleep(io.rescanMs ?? 750);
    const raw = io.ps();
    if (raw === null) { psFailed = true; continue; }
    const procs = parsePsLines(raw, io.now());
    const audit = auditEmbedHosts(procs, actx);
    for (const p of audit.foreign) foreign.set(p.pid, p);
    for (const v of audit.violations) if (!violations.some((x) => x.pid === v.pid)) violations.push(v);
    for (const p of audit.smoke) if (!ownedIds.has(p.pid)) ownedIds.set(p.pid, p.startedMs);
    const fresh = audit.smoke.filter((p) => !stopped.has(p.pid));
    for (const p of fresh) seen.set(p.pid, p);
    if (fresh.length === 0) continue;
    const r = await reapEmbedHosts(fresh, io);
    for (const pid of [...r.stopped, ...r.identityChanged]) { stopped.add(pid); undead.delete(pid); }
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
 * legs, and its service leg). For such a leg, zero attributed hosts is not
 * "clean" — it means attribution found nothing to check, which is exactly the
 * no-evidence false-green 26121495 was filed for (e.g. the host env stops
 * carrying the smoke root, or the `ps -E` format changes). It fails closed.
 *
 * `legStartedMs` (1647035b): the evidence must be the leg's OWN. A host that
 * started before the leg did — e.g. the service daemon's warm-up host, reused
 * through the identical socket key — cannot satisfy `requireObserved`.
 *
 * @param {{ smoke: object[], undead: number[], violations: {pid:number, reasons:string[]}[], psFailed: boolean }} r
 * @param {{ requireObserved?: boolean, legStartedMs?: number }} [opts]
 * @returns {{ ok: boolean, problems: string[], observed: number }}
 */
export function embedGateVerdict(r, opts = {}) {
  const problems = [];
  if (r.psFailed) problems.push('embed-host ps capture failed — reap unverifiable');
  const legT0 = opts.legStartedMs;
  const own = r.smoke.filter((p) => !Number.isFinite(legT0) || (Number.isFinite(p.startedMs) && p.startedMs >= legT0 - 1000));
  if (opts.requireObserved && own.length === 0 && !r.psFailed) {
    problems.push(r.smoke.length > 0
      ? `only embedding host(s) that predate this leg were observed [${r.smoke.map((p) => p.pid).join(', ')}] — another leg's host is not this leg's evidence`
      : 'no smoke-owned embedding host was observed for a leg that embeds — attribution found nothing to verify (no evidence is not a pass)');
  }
  if (r.undead.length > 0) problems.push(`embed host(s) survived verified stop: ${r.undead.join(', ')}`);
  if (r.violations.length > 0) {
    problems.push(`embed host isolation breach: ${r.violations.map((v) => `pid ${v.pid}: ${v.reasons.join('; ')}`).join(' | ')}`);
  }
  return { ok: problems.length === 0, problems, observed: own.length };
}

/**
 * 1647035b: precondition for a leg that must produce its own embedding-host
 * evidence — no smoke-owned host may be alive when it starts. `audit` is an
 * {@link auditEmbedHosts} result (or null when ps failed).
 *
 * @returns {{ ok: boolean, problems: string[], alive: object[] }}
 */
export function preLegEmbedVerdict(audit) {
  if (audit === null) return { ok: false, problems: ['pre-leg embed-host ps capture failed — leg evidence unattributable'], alive: [] };
  if (audit.smoke.length === 0) return { ok: true, problems: [], alive: [] };
  return {
    ok: false,
    alive: audit.smoke,
    problems: [`smoke-owned embedding process(es) already alive before the leg started [${audit.smoke.map((p) => `${p.pid}:${p.kind}`).join(', ')}] — ` +
      'a previous leg leaked its host, and this leg could reuse it as its own evidence'],
  };
}

/**
 * e5cf17a0 + 8c3f8f87: the run-end embedding-host verdict. Every category is
 * reported on its own (an isolation breach no longer hides undead hosts behind
 * an `else`), and a ps failure is named as an unverifiable audit, never as a
 * breach. `steps` are the log.json entries the harness records for each
 * category, pass or fail, so a FATAL can never coexist with `summary.failed: 0`.
 *
 * @param {{ breaches: string[], undead: number[], auditFailures: string[], finalSweep: { ok: boolean, detail: string, attributed?: number },
 *           attributed: number[] }} s
 * @returns {{ ok: boolean, fatalLines: string[], okLine: string|null, steps: {test_id:string, passed:boolean, verdict:string, detail:string}[] }}
 */
export function finalEmbedVerdict(s) {
  const fatalLines = [];
  const steps = [];
  const step = (test_id, passed, failVerdict, detail) => steps.push({ test_id, passed, verdict: passed ? 'verified' : failVerdict, detail });
  step('embed-host-final-sweep', s.finalSweep.ok, 'embed-host-final-sweep-failed',
    s.finalSweep.ok ? `final sweep clean (${s.finalSweep.attributed ?? 0} smoke-owned process(es) stopped)` : s.finalSweep.detail);
  if (!s.finalSweep.ok) fatalLines.push(`FATAL: final embedding-host sweep failed (97e7f214): ${s.finalSweep.detail}`);
  step('embed-host-isolation-breaches', s.breaches.length === 0, 'embed-host-isolation-breach',
    s.breaches.length === 0 ? 'no smoke-owned embedding host escaped containment' : s.breaches.join(' | '));
  if (s.breaches.length > 0) {
    fatalLines.push(`FATAL: ${s.breaches.length} embedding-host isolation breach(es) (26121495): a smoke-owned embedding host ran with the ` +
      `operator HOME, model cache or a socket outside the run:\n  ${s.breaches.join('\n  ')}`);
  }
  step('embed-host-undead', s.undead.length === 0, 'embed-host-undead',
    s.undead.length === 0 ? 'no smoke embedding host survived a verified stop' : `undead: ${s.undead.join(', ')}`);
  if (s.undead.length > 0) fatalLines.push(`FATAL: smoke embedding host(s) outlived a verified stop (97e7f214): ${s.undead.join(', ')}`);
  step('embed-host-audit', s.auditFailures.length === 0, 'embed-host-audit-unverifiable',
    s.auditFailures.length === 0 ? 'every embed-host audit captured ps' : s.auditFailures.join(' | '));
  if (s.auditFailures.length > 0) {
    fatalLines.push(`FATAL: ${s.auditFailures.length} embedding-host audit(s) could not run (ps capture failed) — containment is UNVERIFIED, ` +
      `not breached:\n  ${s.auditFailures.join('\n  ')}`);
  }
  const ok = fatalLines.length === 0;
  return {
    ok,
    fatalLines,
    okLine: ok ? `embedding-host isolation OK — ${s.attributed.length} smoke-owned embedding process(es) attributed ` +
      `[${s.attributed.join(', ')}]; all contained in the run and verified-stopped` : null,
    steps,
  };
}
