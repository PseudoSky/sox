#!/usr/bin/env node
/**
 * tools/test-e5cf17a0-smoke-teardown-hardening.mjs
 *
 * Red->green pin for backlog e5cf17a0 (grouped review findings on the smoke
 * harness's embedding-host isolation/teardown, 8ee98667 + 82ef7b9d). One case
 * group per sub-item:
 *
 *   a. the proxy leg's backend is verified-stopped (SIGTERM → poll → SIGKILL),
 *      before the embed reap — not SIGTERMed fire-and-forget;
 *   b. hosts are SIGTERMed and waited on FIRST; only children that survive their
 *      host's retire are signalled (the documented order);
 *   c. identity (start time + argv) is re-read before SIGKILL: a recycled pid is
 *      never killed;
 *   d. a host is attributed by --spawner-pid only if it started no earlier than
 *      that spawner (per-spawner start time, not the run start);
 *   e. a fastembed child attributed through its host stays the run's after the
 *      host dies (reparented to pid 1, no tag);
 *   f. SIGINT/SIGTERM verified-stop the smoke hosts and remove the /tmp alias
 *      before exiting (real process);
 *   g. `ps -E` env/argv parsing keeps paths that contain spaces;
 *   h. a ps failure is reported as an unverifiable audit, never as a breach, and
 *      the run-end FATAL lists undead hosts even when breaches also exist;
 *   i. the no-proxy orphan proof diffs survivors against the pre-teardown capture;
 *   j. the embed-isolation guard watches embedHostConfig.ts,
 *      embedding-provider/src/index.ts and host-runtime/src/env-policy.ts;
 *   k. a 4-byte /tmp alias collision retries under a new name instead of aborting,
 *      and a colliding path is never removed.
 *
 * Usage:
 *   node tools/test-e5cf17a0-smoke-teardown-hardening.mjs                      # green
 *   node tools/test-e5cf17a0-smoke-teardown-hardening.mjs --code-root <dir>   # red demo: <dir> holds 82ef7b9d's scripts/ + tools/guards-manifest.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const crIdx = process.argv.indexOf('--code-root');
const CODE_ROOT = crIdx !== -1 ? path.resolve(process.argv[crIdx + 1]) : REPO_ROOT;
async function load(rel) {
  const p = path.join(CODE_ROOT, rel);
  return fs.existsSync(p) ? import(pathToFileURL(p).href) : {};
}
const lib = await load('scripts/lib/embed-host-isolation.mjs');
const fsLib = await load('scripts/lib/smoke-fs.mjs');
const tdLib = await load('scripts/lib/smoke-teardown.mjs');
const { GUARDS } = await load('tools/guards-manifest.mjs');
const src = fs.readFileSync(path.join(CODE_ROOT, 'scripts/smoke-test.mjs'), 'utf8');
const slice = (from, to) => { const a = src.indexOf(from); return a === -1 ? '' : src.slice(a, src.indexOf(to, a)); };

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const has = (m, n) => m && typeof m[n] === 'function';

/**
 * A simulated process table for the reap: `procs` pid → { alive, onTerm, identity }.
 * onTerm(pid, table) runs on SIGTERM (default: the process exits). Every signal
 * is appended to `sent` so ordering can be asserted.
 */
function fakeIo(procs, extra = {}) {
  const sent = [];
  let clock = 0;
  const io = {
    sent,
    clock: () => clock,
    kill: (pid, sig) => {
      const p = procs[pid];
      if (!p || !p.alive) { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; }
      if (sig === 0) return;
      sent.push(`${sig}:${pid}@${clock}`);
      if (sig === 'SIGTERM') (p.onTerm ?? ((id, t) => { t[id].alive = false; }))(pid, procs);
      if (sig === 'SIGKILL') p.alive = false;
    },
    sleep: async (ms) => { clock += ms; for (const p of Object.values(procs)) if (p.dieAt !== undefined && clock >= p.dieAt) p.alive = false; },
    termMs: 300, killMs: 300,
    ...extra,
  };
  return io;
}

console.log(`e5cf17a0 — code under test: ${CODE_ROOT}`);

console.log('a. proxy backend verified stop');
{
  const proxy = slice('async function runServeProxyAndVerify', 'function hostsFromManifest');
  const iStop = proxy.search(/verifiedStop\(\[backendPid\]/);
  const iReap = proxy.search(/reapSmokeEmbedHosts\(testId,/);
  check('a1 e5cf17a0: the proxy leg verified-stops the backend pid before the embed reap', iStop !== -1 && iReap !== -1 && iStop < iReap);
  check('a2 e5cf17a0: no fire-and-forget SIGTERM of the backend remains', !/process\.kill\(backendPid, "SIGTERM"\)/.test(proxy));
  check('a3 e5cf17a0: a backend that survives the verified stop fails the leg', /verdict: "backend-teardown"/.test(proxy));
  if (has(lib, 'verifiedStop')) {
    const procs = { 700: { alive: true, onTerm: () => {} } }; // ignores SIGTERM
    const io = fakeIo(procs);
    const r = await lib.verifiedStop([700], io);
    check('a4 e5cf17a0: verifiedStop escalates a SIGTERM-ignoring pid to SIGKILL and reports it stopped',
      r.undead.length === 0 && r.stopped.includes(700) && io.sent.some((s) => s.startsWith('SIGKILL:700')), JSON.stringify({ r, sent: io.sent }));
  } else check('a4 e5cf17a0: verifiedStop is exported', false);
}

console.log('b. hosts first, then only surviving children');
{
  // Host 800 retires cleanly on SIGTERM and takes its child 801 with it.
  const procs = { 800: { alive: true, onTerm: (id, t) => { t[800].alive = false; t[801].alive = false; } }, 801: { alive: true } };
  const io = fakeIo(procs);
  await lib.reapEmbedHosts([{ pid: 800, kind: 'host' }, { pid: 801, kind: 'child' }], io);
  check('b1 e5cf17a0: a child whose host retired it on SIGTERM is never signalled', !io.sent.some((s) => /:801@/.test(s)), JSON.stringify(io.sent));
  // Host 810 takes 200 ms to retire after SIGTERM and leaves its child 811 behind
  // (orphaned pool). Driven through auditAndReapEmbedHosts, the entry point every
  // version shares, from a ps capture of the live table.
  const T0 = Date.parse('2026-09-28T10:00:00Z');
  const procs2 = { 810: { alive: true, onTerm: (id, t) => { t[id].dieAt = io2.clock() + 200; } }, 811: { alive: true } };
  const io2 = fakeIo(procs2);
  const psLines = () => [
    procs2[810].alive ? `810 1 810 00:05 /n/node /w/dist/embedHostMain.js --socket=/tmp/sox-smoke-b2/run/a.sock --cache-dir=/tmp/sox-smoke-b2/c --spawner-pid=1 HOME=/tmp/sox-smoke-b2/h` : '',
    procs2[811].alive ? `811 ${procs2[810].alive ? 810 : 1} 810 00:05 /n/node /w/dist/fastembedProcessHost.js HOME=/tmp/sox-smoke-b2/h` : '',
  ].filter(Boolean).join('\n');
  await lib.auditAndReapEmbedHosts({ smokeRoots: ['/tmp/sox-smoke-b2'], spawnedPids: new Set(), runStartedMs: T0 - 60_000 },
    { ...io2, ps: psLines, now: () => T0, rescanMs: 10 });
  const at = (sig, pid) => { const e = io2.sent.find((s) => s.startsWith(`${sig}:${pid}@`)); return e ? Number(e.split('@')[1]) : null; };
  check('b2 e5cf17a0: a surviving child is SIGTERMed only AFTER waiting for its host to retire (not in the same batch)',
    at('SIGTERM', 810) !== null && at('SIGTERM', 811) !== null && at('SIGTERM', 811) >= at('SIGTERM', 810) + 200, JSON.stringify(io2.sent));
}

console.log('c. identity re-check before SIGKILL');
{
  let ident = 'Mon Sep 28 10:00:00 2026 node /x/embedHostMain.js --socket=/tmp/sox-smoke-1/run/a.sock';
  const procs = { 900: { alive: true, onTerm: () => {} } }; // ignores SIGTERM ...
  const io = fakeIo(procs, {
    identity: () => ident,
    // ... and during the wait the pid is recycled for an unrelated process.
    sleep: async () => { ident = 'Mon Sep 28 10:00:04 2026 /usr/bin/some-operator-tool'; },
  });
  const r = await lib.reapEmbedHosts([900], io); // a bare pid: the shape every version accepts
  check('c1 e5cf17a0: a pid whose identity changed during the wait is NOT SIGKILLed', !io.sent.some((s) => s.startsWith('SIGKILL:900')), JSON.stringify(io.sent));
  check('c2 e5cf17a0: and is reported as identity-changed, not undead', Array.isArray(r.identityChanged) && r.identityChanged.includes(900) && !r.undead.includes(900), JSON.stringify(r));
  const sweepSrc = slice('function processIo(', '\n}\n');
  check('c3 e5cf17a0: the harness wires identity (lstart + argv) into every verified stop', /identity: \(pid\) => processIdentity\(pid, testId\)/.test(sweepSrc) && /lstart=,command=/.test(src));

  // c4/c5/c6 (BL-e5cf17a0-1a32-4cdd-94c1-8b213c5e24ac, HIGH): a failed identity probe
  // must fail closed as undead, never as a silent identityChanged/stopped pass.
  const procs4 = { 910: { alive: true, onTerm: () => {} } }; // ignores SIGTERM
  const io4 = fakeIo(procs4, { identity: () => null });
  const r4 = await lib.reapEmbedHosts([910], io4);
  check('c4 e5cf17a0-1a32: identity() returning null on a still-alive pid is undead (fail-closed), never identityChanged',
    r4.undead.includes(910) && !r4.identityChanged.includes(910) && !io4.sent.some((s) => s.startsWith('SIGKILL:910')), JSON.stringify(r4));

  let calls5 = 0;
  const procs5 = { 920: { alive: true, onTerm: () => {} } }; // ignores SIGTERM
  const io5 = fakeIo(procs5, {
    identity: () => { calls5++; return calls5 === 1 ? null : 'Mon Sep 28 10:00:00 2026 node /x/embedHostMain.js'; },
  });
  const r5 = await lib.reapEmbedHosts([920], io5);
  check('c5 e5cf17a0-1a32: a null identity0 (the pre-SIGTERM read failed) on a still-alive pid is undead, never identityChanged',
    r5.undead.includes(920) && !r5.identityChanged.includes(920) && !io5.sent.some((s) => s.startsWith('SIGKILL:920')), JSON.stringify(r5));

  let ident6 = 'Mon Sep 28 10:00:00 2026 node /x/embedHostMain.js';
  const procs6 = { 930: { alive: true, onTerm: () => {} } }; // ignores SIGTERM
  const io6 = fakeIo(procs6, { identity: () => ident6, sleep: async () => { ident6 = 'Mon Sep 28 10:00:04 2026 /usr/bin/some-operator-tool'; } });
  const r6 = await lib.reapEmbedHosts([930], io6);
  check('c6 e5cf17a0-1a32: a genuine non-null identity mismatch stays identityChanged, never undead, never killed (regression guard)',
    r6.identityChanged.includes(930) && !r6.undead.includes(930) && !io6.sent.some((s) => s.startsWith('SIGKILL:930')), JSON.stringify(r6));
}

const NOW = Date.parse('2026-09-28T10:10:00Z');
const RUN = Date.parse('2026-09-28T10:00:00Z');
const hostLine = (pid, ppid, etime, spawner, env) =>
  `${pid} ${ppid} ${pid} ${etime} /n/node /w/dist/embedHostMain.js --socket=/tmp/x.sock --model=m --cache-dir=/c --ep=cpu --spawner-pid=${spawner} ${env}`;
const childLine = (pid, ppid, etime, env) => `${pid} ${ppid} ${ppid} ${etime} /n/node /w/dist/fastembedProcessHost.js ${env}`;

console.log('d. per-spawner start time');
{
  // Smoke child 6000 started at RUN+300s. Host 6001 names spawner 6000 but started at RUN+120s
  // (etime 08:00 at NOW=RUN+600s): 6000 is a recycled pid, the host is not the run's.
  const procs = lib.parsePsLines(hostLine(6001, 1, '08:00', 6000, 'HOME=/Users/op'), NOW);
  const ctx = { smokeRoots: ['/nowhere'], spawnedPids: new Set([6000]), runStartedMs: RUN, spawnStartedMs: new Map([[6000, RUN + 300_000]]) };
  check('d1 e5cf17a0: a host older than its (recycled) spawner pid is foreign', lib.isSmokeOwned(procs[0], ctx) === false);
  const young = lib.parsePsLines(hostLine(6002, 1, '04:00', 6000, 'HOME=/Users/op'), NOW);
  check('d2 e5cf17a0: a host started after its spawner is the run\'s', lib.isSmokeOwned(young[0], ctx) === true);
  check('d3 e5cf17a0: the harness records spawn start times and passes them to the audit',
    /spawnStartedMs: SMOKE_SPAWN_STARTED_MS/.test(src) && /noteSpawnStarts\(seen, testId\)/.test(src));
}

console.log('e. a reparented child stays the run\'s');
{
  // Child 7002 of a smoke host that has since died: ppid 1, no smoke tag in argv/env.
  const [child] = lib.parsePsLines(childLine(7002, 1, '02:00', 'HOME=/Users/op'), NOW);
  const ctx = { smokeRoots: ['/nowhere'], spawnedPids: new Set(), runStartedMs: RUN, ownedIds: new Map([[7002, NOW - 120_000]]) };
  check('e1 e5cf17a0: a previously attributed child keeps ownership after its host dies', lib.isSmokeOwned(child, ctx) === true);
  const ctxReused = { ...ctx, ownedIds: new Map([[7002, NOW - 3_600_000]]) };
  check('e2 e5cf17a0: a recycled pid (different start) does not inherit ownership', lib.isSmokeOwned(child, ctxReused) === false);
  check('e3 e5cf17a0: the harness persists attributions across audits', /ownedIds: EMBED_OWNED_IDS/.test(src));
}

console.log('f. SIGINT/SIGTERM sweep + alias cleanup (real process)');
{
  const tdPath = path.join(CODE_ROOT, 'scripts/lib/smoke-teardown.mjs');
  if (!has(tdLib, 'installSignalSweep')) check('f1 e5cf17a0: installSignalSweep is exported', false);
  else {
    const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sox-e5cf17a0-'));
    try {
      const alias = path.join(scratch, 'alias');
      fs.symlinkSync(scratch, alias, 'dir');
      const marker = path.join(scratch, 'swept');
      const script = path.join(scratch, 'child.mjs');
      fs.writeFileSync(script, `import * as fs from 'node:fs';
import { installSignalSweep } from ${JSON.stringify(pathToFileURL(tdPath).href)};
installSignalSweep(process, {
  sweep: () => new Promise((r) => setTimeout(() => { fs.writeFileSync(${JSON.stringify(marker)}, 'ok'); r(); }, 200)),
  cleanup: () => fs.unlinkSync(${JSON.stringify(alias)}),
  log: (m) => console.error(m),
});
console.log('ready');
setInterval(() => {}, 1000);
`);
      const c = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise((res) => c.stdout.on('data', (d) => { if (String(d).includes('ready')) res(); }));
      const exit = new Promise((res) => c.on('exit', (code, sig) => res({ code, sig })));
      c.kill('SIGTERM');
      const r = await Promise.race([exit, new Promise((res) => setTimeout(() => res({ code: 'timeout' }), 5000))]);
      if (r.code === 'timeout') c.kill('SIGKILL');
      check('f1 e5cf17a0: SIGTERM runs the sweep to completion, removes the alias, exits 143',
        r.code === 143 && fs.existsSync(marker) && !fs.existsSync(alias), JSON.stringify({ r, swept: fs.existsSync(marker), alias: fs.existsSync(alias) }));
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
  check('f2 e5cf17a0: the harness installs it with the embed-host sweep and the alias removal',
    /installSignalSweep\(process, \{\s*sweep: \(\) => reapSmokeEmbedHosts\('signal-sweep'\),\s*cleanup: removeShortAlias,/.test(src));
}

console.log('g. paths with spaces');
{
  const [p] = lib.parsePsLines(
    `42 1 42 00:10 /n/node /w/dist/embedHostMain.js --socket=/Users/op/My Smoke/run/a.sock --model=m --cache-dir=/Users/op/My Smoke/xdg/sox/models --spawner-pid=41 HOME=/Users/op/My Smoke/fake-home TMPDIR=/tmp/s t PATH=/usr/bin`, NOW);
  check('g1 e5cf17a0: HOME keeps its spaces', p.home === '/Users/op/My Smoke/fake-home', p.home);
  check('g2 e5cf17a0: --socket / --cache-dir keep their spaces',
    p.socket === '/Users/op/My Smoke/run/a.sock' && p.cacheDir === '/Users/op/My Smoke/xdg/sox/models', `${p.socket} | ${p.cacheDir}`);
  check('g3 e5cf17a0: TMPDIR keeps its spaces and --spawner-pid still parses', p.tmpdir === '/tmp/s t' && p.spawnerPid === 41, `${p.tmpdir} | ${p.spawnerPid}`);
}

console.log('h. ps failure is not a breach; undead is reported alongside breaches');
{
  if (!has(lib, 'finalEmbedVerdict')) check('h1 e5cf17a0: finalEmbedVerdict is exported', false);
  else {
    const both = lib.finalEmbedVerdict({ breaches: ['leg-x: pid=5 host — HOME outside'], undead: [4242], auditFailures: [], finalSweep: { ok: true, detail: '' }, attributed: [] });
    check('h1 e5cf17a0: with breaches AND undead, the FATAL lines name both', both.fatalLines.some((l) => /breach/.test(l)) && both.fatalLines.some((l) => /4242/.test(l)), JSON.stringify(both.fatalLines));
    const ps = lib.finalEmbedVerdict({ breaches: [], undead: [], auditFailures: ['leg-y: embed-host audit could not run (ps capture failed)'], finalSweep: { ok: true, detail: '' }, attributed: [] });
    check('h2 e5cf17a0: a ps failure fails the run as UNVERIFIED, not as an isolation breach',
      !ps.ok && ps.fatalLines.length === 1 && /could not run/.test(ps.fatalLines[0]) && !/isolation breach/.test(ps.fatalLines[0]), JSON.stringify(ps.fatalLines));
  }
  const audit = slice('function auditSmokeEmbedHosts(', '\n}\n');
  check('h3 e5cf17a0: the harness records a ps failure in EMBED_AUDIT_FAILURES, not EMBED_ISOLATION_BREACHES',
    /EMBED_AUDIT_FAILURES\.push/.test(audit) && !/EMBED_ISOLATION_BREACHES\.push/.test(audit));
}

console.log('i. no-proxy orphan proof diffs against the pre-teardown capture');
{
  if (!has(tdLib, 'diffTeardownSurvivors')) check('i1 e5cf17a0: diffTeardownSurvivors is exported', false);
  else {
    const before = ['100 1 100 node soxe HOME=/r', '101 100 100 node memory-server HOME=/r'];
    const d = tdLib.diffTeardownSurvivors(before, ['101 1 100 node memory-server HOME=/r', '555 1 555 node late HOME=/r']);
    check('i1 e5cf17a0: a process alive before and after is a survivor; one only after "appeared"',
      d.survivors.length === 1 && d.survivors[0].startsWith('101') && d.appeared.length === 1 && d.appeared[0].startsWith('555'), JSON.stringify(d));
    check('i2 e5cf17a0: an empty pre-teardown capture makes the proof vacuous (not a pass)', tdLib.diffTeardownSurvivors([], []).vacuous === true);
    check('i3 e5cf17a0: a clean teardown has no problems', tdLib.diffTeardownSurvivors(before, []).problems.length === 0);
  }
  const noProxy = slice('async function runMemoryServerDirectServeAndVerify', 'function verifyServiceRunning');
  check('i4 e5cf17a0: the no-proxy leg uses the diff', /diffTeardownSurvivors\(testRootProcsBefore, testRootProcsAfter\)/.test(noProxy));
}

console.log('j. guard watch list');
{
  const g = (GUARDS ?? []).find((x) => x.id === '26121495');
  const want = ['libs/data/embed/embedding-provider/src/embedHostConfig.ts', 'libs/data/embed/embedding-provider/src/index.ts', 'libs/host-runtime/src/env-policy.ts'];
  const missing = want.filter((w) => !(g?.watch ?? []).includes(w));
  check('j1 e5cf17a0: 26121495 watches the socket-dir, cache-resolution and env-policy sources', g && missing.length === 0, `missing ${JSON.stringify(missing)}`);
  check('j2 e5cf17a0: every watched path exists', want.every((w) => fs.existsSync(path.join(REPO_ROOT, w))));
}

console.log('k. /tmp alias collision retries');
{
  if (!has(fsLib, 'claimShortAlias')) check('k1 e5cf17a0: claimShortAlias is exported', false);
  else {
    const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sox-e5cf17a0k-'));
    try {
      const target = path.join(scratch, 'data-root');
      fs.mkdirSync(target);
      const other = path.join(scratch, 'someone-else');
      fs.mkdirSync(other);
      fs.symlinkSync(other, path.join(scratch, 'sox-smoke-deadbeef'), 'dir'); // a live alias from another run
      const names = ['deadbeef', 'deadbeef', 'cafef00d'];
      const got = fsLib.claimShortAlias({ target, dir: scratch, randomHex: () => names.shift(), log: () => {} });
      check('k1 e5cf17a0: a colliding name is retried under a new one', got === path.join(scratch, 'sox-smoke-cafef00d') && fs.readlinkSync(got) === target, got);
      check('k2 e5cf17a0: the other run\'s alias is untouched', fs.readlinkSync(path.join(scratch, 'sox-smoke-deadbeef')) === other);
      check('k3 e5cf17a0: releaseShortAlias leaves an alias that no longer points at this run',
        fsLib.releaseShortAlias(path.join(scratch, 'sox-smoke-deadbeef'), target) === 'foreign' && fs.existsSync(path.join(scratch, 'sox-smoke-deadbeef')));
      let threw = null;
      try { fsLib.claimShortAlias({ target, dir: scratch, randomHex: () => 'x', symlinkSync: () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; } }); } catch (e) { threw = e.code; }
      check('k4 e5cf17a0: a non-collision error is not retried', threw === 'EACCES');
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
  check('k5 e5cf17a0: the harness claims the alias via claimShortAlias and releases only its own',
    /const SMOKE_SHORT_ROOT = claimShortAlias\(/.test(src) && /releaseShortAlias\(SMOKE_SHORT_ROOT, SMOKE_DATA_ROOT\)/.test(src) && !/fs\.unlinkSync\(SMOKE_SHORT_ROOT\)/.test(src));
}

console.log(failed === 0 ? 'PASS e5cf17a0: all cases pass' : `FAIL e5cf17a0: ${failed} case(s) failed`);
process.exit(failed === 0 ? 0 : 1);
