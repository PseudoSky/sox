#!/usr/bin/env node
/**
 * tools/test-26121495-smoke-embed-host-isolation.mjs
 *
 * Red->green pin for backlog 26121495 ("smoke serve-no-proxy: embed host leak
 * with real HOME"). A smoke run spawned an embedding host with the operator's
 * HOME, the operator's model cache (~/.cache/sox/models) and a socket under the
 * OS temp dir's shared `sox-uds/` fallback, and still printed "isolation OK",
 * because the only isolation check compared live data-root FILES.
 *
 * Root cause (measured 2026-09-28): the memory-server's service legs
 * (enable/status/disable) ran under smokeEnv() — the operator $HOME and TMPDIR —
 * and the service daemon embeds on warmup, so its host resolved the operator
 * cache; and SOX_ECOSYSTEM_HOME was ~100 bytes deep, so every embed socket
 * overflowed sun_path and fell back to os.tmpdir()/sox-uds (BL-578).
 *
 * Three parts, each with an authentic pre-fix negative control:
 *   A. the audit (scripts/lib/embed-host-isolation.mjs) flags a smoke-owned host
 *      whose HOME, --cache-dir or --socket leaves the run, attributes by lineage
 *      only, and never flags a foreign (production / other session) host.
 *      Pre-fix control (9303b749): the pre-fix harness had NO process-level check
 *      of any kind — its only isolation verdict was evaluateIsolation() over the
 *      live data root's files and telemetry. The control therefore loads the REAL
 *      `evaluateIsolation`/`snapshotLiveFiles` from
 *      `git show 0bb5b497:scripts/lib/isolation-guard.mjs` and hands it exactly
 *      what such a run produced (an untouched live root, no harness telemetry — an
 *      embedding host writes neither): a pre-fix FATAL would flag every host, a
 *      pre-fix "ok" flags none. It returns "ok", which is the reported false green.
 *   B. the env the harness hands its children (scripts/lib/smoke-env.mjs), fed
 *      through the product's own socket-path function and cache resolution,
 *      keeps socket and cache inside the run — with and without TMPDIR (a
 *      `soxe serve` child has TMPDIR scrubbed) and with a hostile operator
 *      XDG_CACHE_HOME / SOX_EMBED_CACHE_DIR. Pre-fix control: the authentic
 *      pre-fix smokeEnv() (inherit everything, deep SOX_ECOSYSTEM_HOME).
 *   C. harness wiring (scripts/smoke-test.mjs): every memory-server leg passes
 *      an explicit env, and the run fails on a breach. Pre-fix control: pass the
 *      pre-fix harness via --smoke.
 *
 * Usage:
 *   node tools/test-26121495-smoke-embed-host-isolation.mjs                     # green: all cases pass
 *   node tools/test-26121495-smoke-embed-host-isolation.mjs --pre-fix --smoke <pre-fix smoke-test.mjs>   # red demo
 *   node tools/test-26121495-smoke-embed-host-isolation.mjs --pre-fix-gate --smoke <853b283f smoke-test.mjs>   # part D red demo
 *
 * Part D (review HIGH on 853b283f): the gate must FAIL a leg known to embed when
 * attribution finds zero smoke-owned hosts — no evidence is not a pass. Control:
 * the authentic 853b283f gate (ok iff no ps failure / undead / violations).
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRE_FIX = process.argv.includes('--pre-fix');
const smokeIdx = process.argv.indexOf('--smoke');
const SMOKE_PATH = smokeIdx !== -1 ? path.resolve(process.argv[smokeIdx + 1]) : path.join(REPO_ROOT, 'scripts/smoke-test.mjs');

const lib = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/embed-host-isolation.mjs')).href);
const envLib = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/smoke-env.mjs')).href);
const socketPathMod = path.join(REPO_ROOT, 'libs/service-proxy/dist/socket-path.js');
if (!fs.existsSync(socketPathMod)) {
  console.error(`FAIL: ${socketPathMod} missing — run \`npx nx build service-proxy\` first`);
  process.exit(1);
}
const { backendSocketPath } = await import(pathToFileURL(socketPathMod).href);

// ── Pre-fix controls (authentic code from 0bb5b497, the commit before 8ee98667) ──
const PRE_FIX_REV = '0bb5b497';
/**
 * 9303b749: the pre-fix harness's only isolation verdict, loaded from git — never
 * a hand-written stub. Returns an audit-shaped result from that verdict.
 */
async function loadPreFixAudit() {
  const src = execFileSync('git', ['-C', REPO_ROOT, 'show', `${PRE_FIX_REV}:scripts/lib/isolation-guard.mjs`], { encoding: 'utf8' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-9303b749-'));
  const file = path.join(dir, 'isolation-guard.pre-fix.mjs');
  fs.writeFileSync(file, src);
  const pre = await import(pathToFileURL(file).href);
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  const liveRoot = path.join(dir, 'live-root'); // the operator's live data root, untouched by the embed host
  fs.mkdirSync(liveRoot);
  return (procs, ctx) => {
    const before = pre.snapshotLiveFiles(liveRoot);
    const after = pre.snapshotLiveFiles(liveRoot);
    const v = pre.evaluateIsolation({ before, after, liveEvents: [], liveOtherEvents: [], scratchEvents: [], smokeTouchedIds: [], smokePids: ctx.spawnedPids });
    return v.verdict === 'fatal'
      ? { smoke: procs, foreign: [], violations: procs.map((p) => ({ pid: p.pid, kind: p.kind, reasons: [`pre-fix evaluateIsolation fatal: ${v.lines.join('; ')}`] })) }
      : { smoke: [], foreign: procs, violations: [], preFixVerdict: v.verdict };
  };
}
const PRE_FIX_AUDIT = PRE_FIX ? await loadPreFixAudit() : null;
/** Pre-fix smokeEnv()/memoryServerEnv(): inherit everything, deep SOX_ECOSYSTEM_HOME. */
const preFixSmokeEnv = (base, cfg) => ({ ...base, NODE_NO_WARNINGS: '1', SOX_ECOSYSTEM_HOME: cfg.deepDataRoot, SOX_TELEMETRY_HARNESS: '1' });

/**
 * Pre-fix gate (authentic, scripts/smoke-test.mjs @ 853b283f reapSmokeEmbedHosts):
 * ok iff no ps failure, no undead, no violations — zero attributed hosts passed.
 */
const PRE_FIX_GATE = (r) => {
  const problems = [];
  if (r.psFailed) problems.push('ps failed');
  if (r.undead.length > 0) problems.push('undead');
  if (r.violations.length > 0) problems.push('violations');
  return { ok: problems.length === 0, problems };
};
// --pre-fix-gate swaps ONLY the gate (isolates part D's red demo from A–C).
const gate = PRE_FIX || process.argv.includes('--pre-fix-gate') ? PRE_FIX_GATE : lib.embedGateVerdict;

const audit = PRE_FIX ? PRE_FIX_AUDIT : (procs, ctx) => lib.auditEmbedHosts(procs, ctx);
const buildEnv = PRE_FIX ? preFixSmokeEnv : envLib.buildSmokeEnv;
const buildMemEnv = PRE_FIX ? (b, c) => ({ ...preFixSmokeEnv(b, c), HOME: c.memoryHome }) : envLib.buildMemoryServerEnv;

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// A realistic deep worktree run root (the shape that overflowed sun_path).
const TEST_ROOT = '/Users/op/dev/ai/sox-ecosystem/.worktrees/smoke-embed-isolation/dist/smoke/run-2026-09-28T03-20-00';
const DEEP_DATA_ROOT = `${TEST_ROOT}/sox-data-root`;
const SHORT_ROOT = '/tmp/sox-smoke-0a1b2c3d';
const ROOTS = [TEST_ROOT, SHORT_ROOT];
const NOW = Date.parse('2026-09-28T03:21:00Z');
const RUN_START = Date.parse('2026-09-28T03:20:00Z');
const OP_TMP = '/var/folders/yg/cfczgtx54bzfh74lx2_mv0z80000gp/T/';
const NODE = '/Users/op/.nvm/versions/node/v24.11.1/bin/node';
const HOST_JS = '/Users/op/dev/ai/sox-ecosystem/.worktrees/smoke-embed-isolation/extensions/bundles/sox-memory-bundle/members/memory-server/dist/embedHostMain.js';
const CHILD_JS = HOST_JS.replace('embedHostMain.js', 'fastembedProcessHost.js');
const hostLine = ({ pid, etime = '00:30', socket, cache, spawner, env }) =>
  `${pid} 1 ${pid} ${etime} ${NODE} ${HOST_JS} --socket=${socket} --model=bge-base-en-v1.5 --cache-dir=${cache} --ep=cpu --build-id=e048973ce9e1 --idle-window-ms=60000 --spawner-pid=${spawner} ${env}`;
const childLine = ({ pid, ppid, env }) => `${pid} ${ppid} ${ppid} 00:29 ${NODE} ${CHILD_JS} ${env}`;

console.log(`26121495 — ${PRE_FIX ? 'PRE-FIX controls' : 'fixed modules'}; harness: ${path.relative(REPO_ROOT, SMOKE_PATH) || SMOKE_PATH}`);

// ── A. audit ────────────────────────────────────────────────────────────────
console.log('A. embed-host audit (positive containment, lineage attribution)');
{
  // A1: the exact reported shape — smoke-tagged via SOX_ECOSYSTEM_HOME, but
  // operator HOME, operator cache and a socket in $TMPDIR/sox-uds.
  const env = `HOME=/Users/op TMPDIR=${OP_TMP} SOX_ECOSYSTEM_HOME=${DEEP_DATA_ROOT} PATH=/usr/bin`;
  const raw = [
    hostLine({ pid: 5001, socket: `${OP_TMP}sox-uds/p-b644fac816a82914.sock`, cache: '/Users/op/.cache/sox/models', spawner: 4999, env }),
    childLine({ pid: 5002, ppid: 5001, env }),
  ].join('\n');
  const r = audit(lib.parsePsLines(raw, NOW), { smokeRoots: ROOTS, spawnedPids: new Set(), runStartedMs: RUN_START });
  if (PRE_FIX) console.log(`  note pre-fix evaluateIsolation verdict: ${r.preFixVerdict ?? 'fatal'} (the harness printed "isolation OK" for this run)`);
  const v = r.violations.find((x) => x.pid === 5001);
  check('A1 reported shape (operator HOME + cache + $TMPDIR/sox-uds socket) is a breach', !!v && v.reasons.length === 3,
    JSON.stringify(r.violations));
  check('A1 its fastembed child is attributed and flagged (operator HOME)', r.violations.some((x) => x.pid === 5002));
}
{
  // A2: scratch HOME/cache but the BL-578 /tmp/sox-uds fallback (a served child with TMPDIR scrubbed).
  const env = `HOME=${DEEP_DATA_ROOT}/fake-home SOX_ECOSYSTEM_HOME=${DEEP_DATA_ROOT}`;
  const raw = hostLine({ pid: 5101, socket: '/tmp/sox-uds/p-f9eebe447a3fd139.sock', cache: `${DEEP_DATA_ROOT}/fake-home/.cache/sox/models`, spawner: 5100, env });
  const r = audit(lib.parsePsLines(raw, NOW), { smokeRoots: ROOTS, spawnedPids: new Set(), runStartedMs: RUN_START });
  check('A2 /tmp/sox-uds fallback socket is a breach even with a scratch HOME', r.violations.some((x) => x.pid === 5101 && x.reasons.some((s) => s.includes('--socket'))),
    JSON.stringify(r.violations));
}
{
  // A3: lineage via --spawner-pid only (no tag anywhere): the smoke spawned pid 6000.
  const env = 'HOME=/Users/op TMPDIR=/var/folders/x/T/';
  const raw = [
    hostLine({ pid: 6001, etime: '00:20', socket: '/var/folders/x/T/sox-uds/p-1.sock', cache: '/Users/op/.cache/sox/models', spawner: 6000, env }),
    // pid reuse: same spawner pid, but the host predates the run → not the run's.
    hostLine({ pid: 6002, etime: '01:00:00', socket: '/Users/op/.adhd/sox-ecosystem/run/p.sock', cache: '/Users/op/.cache/sox/models', spawner: 6000, env }),
  ].join('\n');
  const r = audit(lib.parsePsLines(raw, NOW), { smokeRoots: ROOTS, spawnedPids: new Set([6000]), runStartedMs: RUN_START });
  check('A3 untagged host whose spawner the run spawned is attributed and flagged', r.violations.some((x) => x.pid === 6001));
}
if (!PRE_FIX) {
  const env = 'HOME=/Users/op TMPDIR=/var/folders/x/T/';
  const raw = [
    hostLine({ pid: 6002, etime: '01:00:00', socket: '/Users/op/.adhd/sox-ecosystem/run/p.sock', cache: '/Users/op/.cache/sox/models', spawner: 6000, env }),
    hostLine({ pid: 7001, socket: '/Users/op/.adhd/sox-ecosystem/run/proxy-09e52ac089c6.sock', cache: '/Users/op/.cache/sox/models', spawner: 85328, env: 'HOME=/Users/op' }),
    childLine({ pid: 7002, ppid: 7001, env: 'HOME=/Users/op' }),
  ].join('\n');
  const r = lib.auditEmbedHosts(lib.parsePsLines(raw, NOW), { smokeRoots: ROOTS, spawnedPids: new Set([6000]), runStartedMs: RUN_START });
  check('A4 production host + child and a pre-run pid-reuse host are foreign, never flagged', r.violations.length === 0 && r.smoke.length === 0 && r.foreign.length === 3,
    JSON.stringify({ v: r.violations, s: r.smoke.map((p) => p.pid) }));
  const ok = [
    hostLine({ pid: 8001, socket: `/private${SHORT_ROOT}/run/proxy-embedding-host_v2_e048973ce9e1_bge-base-en-v1.5_-1d98401dda56.sock`,
      cache: `${DEEP_DATA_ROOT}/xdg-cache/sox/models`, spawner: 8000, env: `HOME=${DEEP_DATA_ROOT}/fake-home SOX_ECOSYSTEM_HOME=${SHORT_ROOT}` }),
    childLine({ pid: 8002, ppid: 8001, env: `HOME=${DEEP_DATA_ROOT}/fake-home SOX_ECOSYSTEM_HOME=${SHORT_ROOT}` }),
  ].join('\n');
  const r2 = lib.auditEmbedHosts(lib.parsePsLines(ok, NOW), { smokeRoots: ROOTS, spawnedPids: new Set(), runStartedMs: RUN_START });
  check('A5 a contained host (/private spelling of the short root) is smoke-owned with no violations', r2.smoke.length === 2 && r2.violations.length === 0,
    JSON.stringify(r2.violations));
}

// ── B. env contract through the product's own resolution ──────────────────────
console.log('B. harness env → product socket path + model cache stay inside the run');
{
  const cfg = {
    dataRoot: SHORT_ROOT, deepDataRoot: DEEP_DATA_ROOT,
    xdgCacheHome: `${DEEP_DATA_ROOT}/xdg-cache`, tmpdir: `${SHORT_ROOT}/tmp`,
    fastembedLock: `${DEEP_DATA_ROOT}/fastembed-host.lock`, memoryHome: `${DEEP_DATA_ROOT}/fake-home`,
  };
  // A hostile operator shell: every cache/tmp knob points at the operator's box.
  const operator = { HOME: '/Users/op', TMPDIR: OP_TMP, XDG_CACHE_HOME: '/Users/op/.xdg-cache', SOX_EMBED_CACHE_DIR: '/Users/op/models', PATH: '/usr/bin' };
  // libs/data/embed/embedding-provider/src/index.ts: SOX_EMBED_CACHE_DIR → $XDG_CACHE_HOME/sox/models → $HOME/.cache/sox/models.
  const cacheDirOf = (env) => env.SOX_EMBED_CACHE_DIR ?? path.join(env.XDG_CACHE_HOME ?? path.join(env.HOME ?? os.homedir(), '.cache'), 'sox', 'models');
  // The real embed-host key shape (ADR-0022 §4) and socket dir (embedHostConfig.ts: $SOX_ECOSYSTEM_HOME/run).
  const KEY = 'embedding-host:v2:e048973ce9e1:bge-base-en-v1.5:cpu:4f1c2a9d0b7e';
  const socketOf = (env) => {
    const saved = process.env.TMPDIR;
    if (env.TMPDIR === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = env.TMPDIR;
    try { return backendSocketPath(path.join(env.SOX_ECOSYSTEM_HOME, 'run'), KEY); }
    finally { if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved; }
  };
  for (const [label, env] of [['smoke env', buildEnv(operator, cfg)], ['memory-server env', buildMemEnv(operator, cfg)]]) {
    const cache = cacheDirOf(env);
    check(`B ${label}: model cache ${cache} is inside the run`, lib.isInsideRoot(cache, TEST_ROOT) || lib.isInsideRoot(cache, SHORT_ROOT));
    const sockWith = socketOf(env);
    check(`B ${label}: embed socket ${sockWith} is inside the run`, ROOTS.some((r) => lib.isInsideRoot(sockWith, r)));
    const scrubbed = { ...env }; delete scrubbed.TMPDIR; // soxe serve's ENV_BASE_ALLOW drops TMPDIR
    const sockScrub = socketOf(scrubbed);
    check(`B ${label} (TMPDIR scrubbed by soxe serve): embed socket ${sockScrub} is inside the run`, ROOTS.some((r) => lib.isInsideRoot(sockScrub, r)));
  }
}

// ── C. harness wiring ──────────────────────────────────────────────────────────
console.log('C. harness wiring');
{
  const src = fs.readFileSync(SMOKE_PATH, 'utf8');
  const start = src.indexOf('async function testExtension(ext) {');
  const end = src.indexOf('\n}\n', start);
  const body = start === -1 ? '' : src.slice(start, end);
  const calls = [...body.matchAll(/await (runCmd|runServeProxyAndVerify|runMemoryServerDirectServeAndVerify)\(([\s\S]*?)\);\n/g)];
  const bare = calls.filter((m) => !/\benv:\s*\w/.test(m[2])).map((m) => m[2].split('\n')[0].slice(0, 90));
  check('C1 every testExtension leg passes an explicit env (memory-server legs get the scratch HOME)', calls.length > 0 && bare.length === 0,
    `${bare.length} leg(s) default to the operator-HOME smokeEnv(): ${JSON.stringify(bare)}`);
  check('C2 the run fails (exit 2) on an embedding-host isolation breach',
    (/embedIsolationFailed = true/.test(src) && /if \(embedIsolationFailed\)[\s\S]{0,300}process\.exit\(2\)/.test(src)) ||
    (/const embed = finalEmbedVerdict\(/.test(src) && /if \(!embed\.ok\)[\s\S]{0,300}process\.exit\(2\)/.test(src)));
  check('C3 every soxe step is audited for smoke-owned embedding hosts', /auditSmokeEmbedHosts\(/.test(src) && /reapSmokeEmbedHosts\('final-sweep'\)/.test(src));
}

// ── D. the gate fails closed on no evidence (review HIGH on 853b283f) ─────────────
console.log('D. embed-host gate requires evidence for a leg that embeds');
{
  // Attribution broke silently: the smoke host no longer carries the root, so the
  // audit sees only a foreign host and attributes nothing.
  const raw = hostLine({ pid: 9001, socket: '/Users/op/.adhd/sox-ecosystem/run/p.sock', cache: '/Users/op/.cache/sox/models', spawner: 85328, env: 'HOME=/Users/op' });
  const a = lib.auditEmbedHosts(lib.parsePsLines(raw, NOW), { smokeRoots: ROOTS, spawnedPids: new Set(), runStartedMs: RUN_START });
  const r = { smoke: a.smoke, undead: [], violations: a.violations, psFailed: false };
  const v = gate(r, { requireObserved: true });
  check('D1 an embedding leg that attributes zero smoke-owned hosts FAILS the gate', a.smoke.length === 0 && v.ok === false,
    `attributed ${a.smoke.length}, gate ok=${v.ok}`);
  const v2 = gate(r, { requireObserved: false });
  check('D2 a leg that is not known to embed may attribute zero hosts', v2.ok === true);
  const src = fs.readFileSync(SMOKE_PATH, 'utf8');
  const noProxy = src.slice(src.indexOf('async function runMemoryServerDirectServeAndVerify'), src.indexOf('function verifyServiceRunning'));
  const proxy = src.slice(src.indexOf('async function runServeProxyAndVerify'), src.indexOf('function hostsFromManifest'));
  check('D3 both memory-server serve legs demand an observed host',
    /reapSmokeEmbedHosts\(testId, \{ requireObserved: true[ ,]/.test(noProxy) &&
    (/reapSmokeEmbedHosts\(testId, \{ requireObserved: extId === 'memory-server'[ ,]/.test(proxy) ||
      (/const embeds = extId === 'memory-server';/.test(proxy) && /reapSmokeEmbedHosts\(testId, \{ requireObserved: embeds[ ,]/.test(proxy))));
  const okLine = typeof lib.finalEmbedVerdict === 'function'
    ? lib.finalEmbedVerdict({ breaches: [], undead: [], auditFailures: [], finalSweep: { ok: true, detail: '' }, attributed: [11, 12] }).okLine ?? ''
    : (src.match(/embedding-host isolation OK[^\n]*/) ?? [''])[0];
  check('D4 the final OK line reports the attributed count, not "every … host"',
    /(EMBED_ATTRIBUTED\.size\}|^embedding-host isolation OK — 2) smoke-owned embedding process/.test(okLine) && !/every smoke-owned host was contained/.test(src), okLine);
}

console.log(failed === 0 ? 'PASS 26121495: all cases pass' : `FAIL 26121495: ${failed} case(s) failed`);
process.exit(failed === 0 ? 0 : 1);
