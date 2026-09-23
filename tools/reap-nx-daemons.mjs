#!/usr/bin/env node
/**
 * reap-nx-daemons — stop nx daemons left behind by dead agent worktrees of THIS repository.
 *
 * THE PROBLEM
 * -----------
 * nx's daemon identity is the workspace root. `socketDirName()` hashes
 * `workspaceRoot.toLowerCase()` (nx/dist/src/daemon/tmp-dir.js:43-49) and the daemon's state dir is
 * `<workspaceRoot>/.nx/workspace-data/d` (tmp-dir.js:20, cache-directory.js:57). Every git worktree
 * is its own workspace root, so every worktree that runs any nx command gets its OWN daemon
 * process, spawned detached with `cwd: workspaceRoot` (daemon/client/client.js:955-961).
 *
 * That daemon does not die with the agent that spawned it. Its only self-shutdown is
 * `SERVER_INACTIVITY_TIMEOUT_MS = 10800000` — three hours — hard-coded in
 * daemon/server/shutdown-utils.js:27, with no environment override (the only daemon env vars nx
 * reads are NX_DAEMON, NX_DAEMON_PROCESS, NX_DAEMON_SOCKET_DIR, NX_DAEMON_VERBOSE_LOGGING).
 * Measured on this box: orphaned daemons at 118-226 MB RSS each, one 22 minutes past its agent's
 * death, against a load average of 208.
 *
 * Setting NX_DAEMON=false in agent worktrees is the cheaper half of the fix and is recommended
 * separately — but an agent that is SIGKILLed never runs teardown, so a reaper is still required.
 *
 * WHAT MAKES THIS SAFE
 * --------------------
 * A daemon is only a candidate when ALL of these hold:
 *
 *  - Its workspace root is a worktree of THIS repository (matched through
 *    `git worktree list --porcelain`, or — for a worktree git has already forgotten — a path under
 *    `<repo>/.claude/worktrees/` or `<repo>/.worktrees/`). Daemons belonging to any other
 *    repository are printed with their exclusion reason and never touched.
 *  - It is not the main checkout's daemon. That is refused by its own rule, not incidentally.
 *  - The pid was read from `<root>/.nx/workspace-data/d/server-process.json` AND that pid is
 *    present in this run's `ps` snapshot with an `nx/.../daemon/server/start.js` argv. Pids
 *    recycle; a pid whose argv we have not read is never signalled. A json pid that is gone or
 *    now belongs to something else is reported as a stale file, not as a target.
 *  - The worktree is UNOCCUPIED: no process other than the daemon itself has its cwd at or under
 *    the worktree, and no process's argv mentions the worktree path (that second check catches an
 *    agent driving the worktree via `git -C` from elsewhere — cwd alone misses exactly the case
 *    that would kill a live build). The daemon's own cwd IS the worktree (client.js:956), so it
 *    must be excluded from the occupancy set or nothing is ever reapable.
 *  - The worktree is not `locked` in `git worktree list` — an explicit "in use" marker.
 *
 * `--min-idle-min` is an ADDITIONAL gate on top of occupancy, never a substitute. It reads the
 * worktree's git metadata (index/HEAD under `<common-git-dir>/worktrees/<name>/`), the same signal
 * `unstage-orphans.mjs` uses. It deliberately does NOT use `daemon.log` mtime: measured here, the
 * log of an idle worktree is rewritten continuously by the file watcher — three worktrees all
 * showed mtimes within seconds of `now` — so it reads "busy" forever and is worthless as an idle
 * signal.
 *
 * HOW IT STOPS THEM
 * -----------------
 *  - Worktree still exists → `nx daemon --stop` executed with cwd set to that worktree, using the
 *    worktree's own `node_modules/.bin/nx` (never `npx`, which can go to the network).
 *    `nx daemon --stop` is NOT a graceful protocol handshake: daemon/client/client.js:981-996 reads
 *    the pid out of the very same `server-process.json` this tool reads and sends it SIGTERM, then
 *    calls `removeSocketDir()`. The two stop paths are therefore identical except that the nx one
 *    also cleans up the `/private/tmp/<hash>` socket dir — which is precisely why it is preferred
 *    where a directory still exists to run it in. It does not respawn anything.
 *  - Worktree is GONE → there is no directory to run a command in, so a signal is the ONLY path,
 *    not a fallback: SIGTERM (the daemon installs handlers in shutdown-utils.js), verify exit,
 *    escalate to SIGKILL only if it survives. The output always names which path was taken.
 *
 * RESIDUAL RISK, STATED HONESTLY
 * ------------------------------
 * Occupancy is a point-in-time sample. An agent that is alive but between nx invocations — with no
 * process cwd'd in the worktree and none naming it in argv — reads as unoccupied. Observed once
 * during verification: a reaped worktree had a fresh daemon 90 seconds later. The blast radius of
 * that miss is bounded to one project-graph recomputation on the agent's next nx command (~0.4s
 * warm vs ~0.8-1.3s cold, measured on this repo); it cannot corrupt or interrupt a build, because
 * nx transparently respawns. Use `--min-idle-min` at teardown if even that is unwanted.
 *
 * Usage
 *   node tools/reap-nx-daemons.mjs                        report only; changes nothing
 *   node tools/reap-nx-daemons.mjs --apply                stop the orphaned daemons
 *   node tools/reap-nx-daemons.mjs --apply --min-idle-min 10
 *                                                         also require the worktree's git metadata
 *                                                         to have been idle that long
 *   node tools/reap-nx-daemons.mjs --json                 machine-readable, for orchestrator teardown
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DAEMON_ARGV_MARKER = /nx[/\\](?:dist[/\\])?src[/\\]daemon[/\\]server[/\\]start\.js/;

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const json = argv.includes('--json');
const minIdleMin = Number(argv[argv.indexOf('--min-idle-min') + 1]) || 0;
const graceMs = (Number(argv[argv.indexOf('--grace-sec') + 1]) || 5) * 1000;

const out = (msg) => {
  if (!json) console.error(msg);
};

const git = (args, cwd) =>
  execFileSync('git', args, { encoding: 'utf8', cwd, maxBuffer: 32 * 1024 * 1024 });

const repoRoot = resolve(git(['rev-parse', '--show-toplevel']).trim());
const commonGitDir = resolve(
  repoRoot,
  git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim(),
);
// The main checkout is the one whose worktree dir is the parent of the common git dir.
const mainRoot = resolve(commonGitDir, '..');

/** Every process on the box: pid → { pid, rss, etime, args }. One snapshot, reused throughout. */
function psSnapshot() {
  const raw = execFileSync('ps', ['-eo', 'pid=,rss=,etime=,args='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const map = new Map();
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    map.set(Number(m[1]), { pid: Number(m[1]), rss: Number(m[2]), etime: m[3], args: m[4] });
  }
  return map;
}

/** pid → cwd for every process that has one. `lsof -a -d cwd` is ~0.5s box-wide on this machine. */
function cwdSnapshot() {
  const res = spawnSync('lsof', ['-a', '-d', 'cwd', '-F', 'pn'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const map = new Map();
  let pid = null;
  for (const line of (res.stdout || '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== null) map.set(pid, line.slice(1));
  }
  return map;
}

const ps = psSnapshot();
const cwds = cwdSnapshot();
const daemons = [...ps.values()].filter((p) => DAEMON_ARGV_MARKER.test(p.args));

/** `git worktree list --porcelain` → [{ path, locked, prunable, isMain }]. */
function worktrees() {
  const list = [];
  let cur = null;
  for (const line of git(['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: resolve(line.slice('worktree '.length)), locked: false, prunable: false };
      list.push(cur);
    } else if (cur && line.startsWith('locked')) cur.locked = true;
    else if (cur && line.startsWith('prunable')) cur.prunable = true;
  }
  for (const w of list) w.isMain = w.path === mainRoot;
  return list;
}

const wts = worktrees();
const knownPaths = new Set(wts.map((w) => w.path));

const inAgentWorktreeNamespace = (p) =>
  p.startsWith(join(repoRoot, '.claude', 'worktrees') + '/') ||
  p.startsWith(join(repoRoot, '.worktrees') + '/');

/** Root of a daemon we can no longer ask git about: its cwd if it still has one, else argv split. */
function rootFromProcess(proc) {
  const viaCwd = cwds.get(proc.pid);
  if (viaCwd && viaCwd !== '/' && inAgentWorktreeNamespace(viaCwd)) return { root: viaCwd, via: 'cwd' };
  const idx = proc.args.indexOf('/node_modules/');
  if (idx > 0) {
    const root = proc.args.slice(proc.args.lastIndexOf(' ', idx) + 1, idx);
    return { root, via: 'argv' };
  }
  return { root: null, via: 'unknown' };
}

/** Processes other than the daemon that hold this worktree open. */
function occupants(root, daemonPid) {
  const hits = [];
  for (const [pid, cwd] of cwds) {
    if (pid === daemonPid || pid === process.pid) continue;
    if (cwd === root || cwd.startsWith(root + '/')) hits.push({ pid, why: `cwd ${cwd}` });
  }
  for (const p of ps.values()) {
    if (p.pid === daemonPid || p.pid === process.pid) continue;
    if (p.args.includes(root)) hits.push({ pid: p.pid, why: `argv mentions worktree` });
  }
  const seen = new Set();
  return hits.filter((h) => (seen.has(h.pid) ? false : seen.add(h.pid)));
}

/** Minutes since this worktree's git metadata was last written. Infinity if unknowable. */
function gitIdleMinutes(root, isMain) {
  let dir;
  try {
    dir = resolve(root, git(['rev-parse', '--path-format=absolute', '--git-dir'], root).trim());
  } catch {
    return Infinity;
  }
  let newest = 0;
  for (const f of ['index', 'HEAD', 'logs/HEAD']) {
    try {
      newest = Math.max(newest, statSync(join(dir, f)).mtimeMs);
    } catch {
      /* file absent for this worktree — the other two still carry the signal */
    }
  }
  void isMain;
  return newest ? (Date.now() - newest) / 60000 : Infinity;
}

// ---------------------------------------------------------------------------------------------
// Classify every daemon on the box.
// ---------------------------------------------------------------------------------------------
const targets = [];
const excluded = [];
const stale = [];
const claimed = new Set();

for (const w of wts) {
  if (!existsSync(w.path)) continue;
  const jsonPath = join(w.path, '.nx', 'workspace-data', 'd', 'server-process.json');
  if (!existsSync(jsonPath)) continue;
  let pid = null;
  try {
    pid = JSON.parse(readFileSync(jsonPath, 'utf8')).processId;
  } catch {
    stale.push({ root: w.path, reason: 'server-process.json unreadable' });
    continue;
  }
  const proc = ps.get(pid);
  if (!proc || !DAEMON_ARGV_MARKER.test(proc.args)) {
    stale.push({
      root: w.path,
      pid,
      reason: proc
        ? 'pid recycled — live process is NOT an nx daemon; never signalled'
        : 'pid not running',
    });
    continue;
  }
  claimed.add(pid);

  if (w.isMain) {
    excluded.push({ pid, root: w.path, rss: proc.rss, reason: 'main checkout — refused by rule' });
    continue;
  }
  const occ = occupants(w.path, pid);
  const idle = gitIdleMinutes(w.path, w.isMain);
  const blockers = [];
  if (w.locked) blockers.push('worktree is `locked` in git worktree list');
  if (occ.length) blockers.push(`occupied by ${occ.length} live process(es): ${occ.slice(0, 4).map((o) => `${o.pid} (${o.why})`).join(', ')}`);
  if (minIdleMin > 0 && idle < minIdleMin)
    blockers.push(`git metadata written ${idle.toFixed(2)} min ago, --min-idle-min ${minIdleMin}`);

  const entry = {
    pid,
    root: w.path,
    rss: proc.rss,
    etime: proc.etime,
    worktree: 'present',
    prunable: w.prunable,
    idleMinutes: Number.isFinite(idle) ? Number(idle.toFixed(2)) : null,
    method: 'nx daemon --stop',
    blockers,
  };
  if (blockers.length) excluded.push({ ...entry, reason: blockers.join('; ') });
  else targets.push(entry);
}

// Daemons no worktree claimed: either a removed worktree of this repo, or another repository.
for (const proc of daemons) {
  if (claimed.has(proc.pid)) continue;
  const { root, via } = rootFromProcess(proc);
  if (!root) {
    excluded.push({ pid: proc.pid, root: null, rss: proc.rss, reason: 'workspace root not determinable — not touched' });
    continue;
  }
  if (knownPaths.has(root) || !inAgentWorktreeNamespace(root)) {
    excluded.push({
      pid: proc.pid,
      root,
      rss: proc.rss,
      reason: knownPaths.has(root)
        ? 'live worktree with no server-process.json claim — not touched'
        : 'not a worktree of this repository — strictly out of scope',
    });
    continue;
  }
  const occ = occupants(root, proc.pid);
  const entry = {
    pid: proc.pid,
    root,
    rss: proc.rss,
    etime: proc.etime,
    worktree: existsSync(root) ? 'present-but-unregistered' : 'GONE',
    rootVia: via,
    idleMinutes: null,
    method: existsSync(root) ? 'nx daemon --stop' : 'SIGTERM (worktree gone: no directory to run nx in)',
    blockers: occ.length ? [`occupied by ${occ.length} live process(es)`] : [],
  };
  if (entry.blockers.length) excluded.push({ ...entry, reason: entry.blockers.join('; ') });
  else targets.push(entry);
}

// ---------------------------------------------------------------------------------------------
// Act.
// ---------------------------------------------------------------------------------------------
function stopViaNx(root) {
  const bin = join(root, 'node_modules', '.bin', 'nx');
  const exe = existsSync(bin) ? bin : join(mainRoot, 'node_modules', '.bin', 'nx');
  if (!existsSync(exe)) return { ok: false, how: 'nx daemon --stop', detail: 'no nx binary found' };
  const res = spawnSync(exe, ['daemon', '--stop'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, NX_DAEMON: 'true' },
  });
  return {
    ok: res.status === 0,
    how: `nx daemon --stop (cwd ${root}, bin ${exe})`,
    detail: (res.stdout || '').trim() || (res.stderr || '').trim() || `exit ${res.status}`,
  };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function stopViaSignal(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    return { ok: !alive(pid), how: 'SIGTERM', detail: String(e.message) };
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && alive(pid)) execFileSync('sleep', ['0.25']);
  if (!alive(pid)) return { ok: true, how: 'SIGTERM (worktree gone)', detail: 'exited' };
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* raced with exit */
  }
  return { ok: !alive(pid), how: 'SIGTERM then SIGKILL (worktree gone)', detail: 'escalated' };
}

const freeableKb = targets.reduce((n, t) => n + t.rss, 0);
const report = {
  repoRoot,
  mainRoot,
  daemonsOnBox: daemons.length,
  wouldFree: { count: targets.length, rssMb: Number((freeableKb / 1024).toFixed(1)) },
  targets,
  excluded,
  stale,
  applied: [],
};

out(`reap-nx-daemons: ${daemons.length} nx daemon(s) running on this box.`);
out(
  `reap-nx-daemons: ${targets.length} orphaned in ${repoRoot} — would free ${(freeableKb / 1024).toFixed(1)} MB RSS.`,
);
for (const t of targets)
  out(
    `  ORPHAN pid ${t.pid}  ${(t.rss / 1024).toFixed(0)} MB  up ${t.etime}  worktree ${t.worktree}  ${t.root}\n` +
      `         stop via: ${t.method}`,
  );
for (const e of excluded)
  out(`  keep   pid ${e.pid}  ${e.rss ? (e.rss / 1024).toFixed(0) + ' MB' : '?'}  ${e.root ?? '?'}\n         reason: ${e.reason}`);
for (const s of stale) out(`  stale  ${s.root}  pid ${s.pid ?? '?'} — ${s.reason}`);

if (!apply) {
  out('reap-nx-daemons: report only. Re-run with --apply to stop the ORPHAN daemons above.');
} else {
  for (const t of targets) {
    const res = t.worktree === 'GONE' ? stopViaSignal(t.pid) : stopViaNx(t.root);
    // `nx daemon --stop` returns as soon as the server acknowledges; the process exits a moment
    // later. Poll for actual exit rather than reporting the race as "STILL RUNNING".
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && alive(t.pid)) execFileSync('sleep', ['0.25']);
    const gone = !alive(t.pid);
    report.applied.push({ ...t, result: { ...res, processGone: gone } });
    out(`  stopped pid ${t.pid} via ${res.how} → ${gone ? 'process gone' : 'STILL RUNNING'} (${res.detail})`);
  }
  const freed = report.applied.filter((a) => a.result.processGone).reduce((n, a) => n + a.rss, 0);
  out(`reap-nx-daemons: freed ${(freed / 1024).toFixed(1)} MB RSS across ${report.applied.filter((a) => a.result.processGone).length} daemon(s).`);
}

if (json) console.log(JSON.stringify(report, null, 2));
