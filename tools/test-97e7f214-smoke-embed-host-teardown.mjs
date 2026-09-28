#!/usr/bin/env node
/**
 * tools/test-97e7f214-smoke-embed-host-teardown.mjs
 *
 * Red->green pin for backlog 97e7f214 ("Smoke memory-server-serve-no-proxy
 * teardown leaves embedHostMain.js/fastembedProcessHost.js alive"; they
 * self-exited ~55 s later, i.e. on --idle-window-ms=60000).
 *
 * Root cause: the no-proxy leg's teardown signals only the `soxe` process group
 * (killProcessGroup). ADR-0022 spawns the embedding host DETACHED — its own
 * process-group leader, reparented to pid 1 once its spawner exits — so a group
 * kill can never reach it, and self-retirement is its only product lifecycle.
 *
 * This test runs REAL processes, never touching one it did not start:
 *   - a "spawner" (the soxe/memory-server stand-in) in its own process group
 *     spawns a detached `embedHostMain.js` stand-in carrying the smoke tag, which
 *     forks a `fastembedProcessHost.js` stand-in; the host IGNORES SIGTERM so
 *     the SIGKILL escalation of the verified stop is exercised too;
 *   - a DECOY `embedHostMain.js` with no smoke tag (a production host stand-in).
 * Teardown under test = the harness's group kill followed (post-fix) by
 * auditAndReapEmbedHosts(). Invariants: no smoke-tagged host or child survives;
 * the decoy is never signalled. Pre-fix control (--pre-fix): the authentic
 * pre-fix teardown, group kill only — the host and child survive (red).
 * Part C pins the harness wiring (reap after the group kill; a survivor FAILS the
 * leg instead of warning); pass a pre-fix harness via --smoke for the red demo.
 *
 * Usage:
 *   node tools/test-97e7f214-smoke-embed-host-teardown.mjs                        # green
 *   node tools/test-97e7f214-smoke-embed-host-teardown.mjs --pre-fix --smoke <pre-fix smoke-test.mjs>   # red demo
 */
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRE_FIX = process.argv.includes('--pre-fix');
const smokeIdx = process.argv.indexOf('--smoke');
const SMOKE_PATH = smokeIdx !== -1 ? path.resolve(process.argv[smokeIdx + 1]) : path.join(REPO_ROOT, 'scripts/smoke-test.mjs');
const lib = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/embed-host-isolation.mjs')).href);

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) {
    if (e && e.code === 'ESRCH') return false;
    console.error(`  note: probe of ${pid} failed: ${e && e.message}`);
    return true;
  }
};

// Short scratch roots (the stand-in socket path stays well inside sun_path).
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sox-97e7f214-'));
const smokeRoot = path.join(scratch, 'smoke-root');
const decoyRoot = path.join(scratch, 'decoy');
for (const d of [path.join(smokeRoot, 'dist'), path.join(decoyRoot, 'dist'), path.join(smokeRoot, 'fake-home')]) fs.mkdirSync(d, { recursive: true });

const childSrc = `setInterval(() => {}, 1000);\n`;
// The host stand-in ignores SIGTERM (worst case: forces the SIGKILL escalation).
const hostSrc = `const { fork } = require('node:child_process');
process.on('SIGTERM', () => {});
fork(require('node:path').join(__dirname, 'fastembedProcessHost.js'), [], { stdio: 'ignore' });
setInterval(() => {}, 1000);\n`;
for (const root of [smokeRoot, decoyRoot]) {
  fs.writeFileSync(path.join(root, 'dist', 'embedHostMain.js'), hostSrc);
  fs.writeFileSync(path.join(root, 'dist', 'fastembedProcessHost.js'), childSrc);
}
// The spawner stand-in: detached host (ADR-0022 §5 shape), then waits to be killed.
const spawnerSrc = `const { spawn } = require('node:child_process');
const path = require('node:path');
const root = process.argv[2];
const h = spawn(process.execPath, [path.join(root, 'dist', 'embedHostMain.js'),
  '--socket=' + path.join(root, 'run', 'h.sock'), '--model=m', '--cache-dir=' + path.join(root, 'fake-home', '.cache'),
  '--ep=cpu', '--build-id=b', '--idle-window-ms=60000', '--spawner-pid=' + process.pid],
  { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH, HOME: path.join(root, 'fake-home'), SOX_ECOSYSTEM_HOME: root } });
h.unref();
console.log(String(h.pid));
setInterval(() => {}, 1000);\n`;
const spawnerPath = path.join(scratch, 'spawner.js');
fs.writeFileSync(spawnerPath, spawnerSrc);

const started = [];
async function startSpawner(root) {
  const c = spawn(process.execPath, [spawnerPath, root], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  started.push(c.pid);
  const hostPid = await new Promise((res, rej) => {
    let buf = '';
    c.stdout.on('data', (d) => { buf += d; if (buf.includes('\n')) res(Number(buf.trim())); });
    c.on('error', rej);
  });
  started.push(hostPid);
  return { spawnerPid: c.pid, hostPid };
}
function childrenOf(pid) {
  try { return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).split(/\s+/).map(Number).filter((n) => n > 0); }
  catch (e) { if (e && e.status === 1) return []; throw e; }
}
async function groupKill(pgid) {
  // The harness's killProcessGroup(): SIGTERM the group, wait, SIGKILL the group.
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    try { process.kill(-pgid, sig); } catch (e) { if (!e || e.code !== 'ESRCH') console.error(`  note: ${sig} -${pgid}: ${e && e.message}`); }
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && alive(pgid)) await sleep(50);
  }
}

console.log(`97e7f214 — ${PRE_FIX ? 'PRE-FIX teardown (group kill only)' : 'fixed teardown (group kill + verified embed-host reap)'}`);
const smoke = await startSpawner(smokeRoot);
const decoy = await startSpawner(decoyRoot);
let smokeChild = [];
let decoyChild = [];
for (let i = 0; i < 50 && (smokeChild.length === 0 || decoyChild.length === 0); i++) {
  await sleep(100);
  smokeChild = childrenOf(smoke.hostPid);
  decoyChild = childrenOf(decoy.hostPid);
}
started.push(...smokeChild, ...decoyChild);
try {
  console.log('A. teardown of a detached embedding host');
  check('A0 fixture: smoke host + fastembed child are running, host is its own group leader',
    alive(smoke.hostPid) && smokeChild.length === 1 && Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(smoke.hostPid)], { encoding: 'utf8' }).trim()) === smoke.hostPid);

  await groupKill(smoke.spawnerPid); // the step's own teardown, both variants
  let reap = null;
  if (!PRE_FIX) {
    reap = await lib.auditAndReapEmbedHosts(
      { smokeRoots: [smokeRoot], spawnedPids: new Set([smoke.spawnerPid]), runStartedMs: Date.now() - 60_000 },
      {
        ps: () => execFileSync('ps', lib.PS_ARGS, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
        now: () => Date.now(), kill: (p, s) => process.kill(p, s), sleep,
        log: (m) => console.error(`  note: ${m}`), termMs: 1500, killMs: 2000, rescanMs: 300,
      },
    );
  }
  const survivors = [smoke.hostPid, ...smokeChild].filter(alive);
  check('A1 no smoke-tagged embedding host or fastembed child survives the step teardown', survivors.length === 0,
    `survivors ${JSON.stringify(survivors)} (would idle-retire ~60 s later)`);
  if (!PRE_FIX) {
    check('A2 the reap reports both stopped and none undead (SIGKILL escalation on a SIGTERM-ignoring host)',
      reap.undead.length === 0 && reap.stopped.includes(smoke.hostPid) && smokeChild.every((p) => reap.stopped.includes(p)), JSON.stringify(reap && { stopped: reap.stopped, undead: reap.undead }));
  }
  check('A3 the untagged decoy host and its child were never signalled', alive(decoy.hostPid) && decoyChild.every(alive));

  console.log('C. harness wiring');
  const src = fs.readFileSync(SMOKE_PATH, 'utf8');
  const leg = src.slice(src.indexOf('async function runMemoryServerDirectServeAndVerify'), src.indexOf('function verifyServiceRunning'));
  check('C1 the no-proxy leg verified-stops embedding hosts after the group kill',
    /killProcessGroup\(child\.pid, testId\)[\s\S]*reapSmokeEmbedHosts\(testId\)/.test(leg));
  check('C2 a survivor fails the no-proxy leg (not a WARNING)', /verdict: "teardown-leak"/.test(leg));
  const proxy = src.slice(src.indexOf('async function runServeProxyAndVerify'), src.indexOf('function hostsFromManifest'));
  check('C3 the proxy leg verified-stops embedding hosts and fails on a survivor',
    /reapSmokeEmbedHosts\(testId\)/.test(proxy) && /verdict: "embed-host-teardown"/.test(proxy));
} finally {
  // Clean up every process THIS test started (and only those).
  for (const pid of started) {
    try { process.kill(pid, 'SIGKILL'); } catch (e) { if (!e || e.code !== 'ESRCH') console.error(`  note: cleanup kill ${pid}: ${e && e.message}`); }
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(failed === 0 ? 'PASS 97e7f214: all cases pass' : `FAIL 97e7f214: ${failed} case(s) failed`);
process.exit(failed === 0 ? 0 : 1);
