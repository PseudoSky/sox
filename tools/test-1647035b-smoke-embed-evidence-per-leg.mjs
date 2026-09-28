#!/usr/bin/env node
/**
 * tools/test-1647035b-smoke-embed-evidence-per-leg.mjs
 *
 * Red->green pin for backlog 1647035b ("smoke: the service leg's embedding host
 * outlives it and satisfies the next serve leg's requireObserved").
 *
 * The memory-server daemon started by `soxe service enable` warms its embedder
 * (memory-server src/index.ts, setImmediate → warmupEmbed) and spawns a DETACHED
 * embedding host (ADR-0022). runCmd only audited, never reaped, so that host
 * outlived the service legs, and the next serve leg — whose memory-server
 * resolves the identical socket key — reused it. `requireObserved` then passed
 * on ANOTHER leg's host: no evidence the serve leg's own embed path works.
 *
 * Invariants pinned:
 *   A. the gate counts only hosts that started during the leg (legStartedMs);
 *      a pre-existing host cannot satisfy requireObserved;
 *   B. a leg that must produce its own evidence starts with no smoke-owned host
 *      alive (preLegEmbedVerdict);
 *   C. harness wiring: the memory-server service leg waits for its host while the
 *      daemon lives, verified-stops it after `service disable` with
 *      requireObserved, and records that as a step; both serve legs run the
 *      pre-leg check and pass their own start time to the gate.
 *
 * Usage:
 *   node tools/test-1647035b-smoke-embed-evidence-per-leg.mjs                        # green
 *   node tools/test-1647035b-smoke-embed-evidence-per-leg.mjs --code-root <dir>     # red demo: <dir> holds 82ef7b9d's scripts/
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const crIdx = process.argv.indexOf('--code-root');
const CODE_ROOT = crIdx !== -1 ? path.resolve(process.argv[crIdx + 1]) : REPO_ROOT;
const lib = await import(pathToFileURL(path.join(CODE_ROOT, 'scripts/lib/embed-host-isolation.mjs')).href);
const src = fs.readFileSync(path.join(CODE_ROOT, 'scripts/smoke-test.mjs'), 'utf8');

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const fn = (name) => (typeof lib[name] === 'function' ? lib[name] : null);
const slice = (from, to) => { const a = src.indexOf(from); return a === -1 ? '' : src.slice(a, src.indexOf(to, a)); };

console.log(`1647035b — code under test: ${CODE_ROOT}`);
const LEG_T0 = Date.parse('2026-09-28T10:00:00Z');
// The service leg's host: started 40 s before the serve leg, still alive (the leak).
const serviceHost = { pid: 4101, kind: 'host', startedMs: LEG_T0 - 40_000, line: '' };
const ownHost = { pid: 4201, kind: 'host', startedMs: LEG_T0 + 3_000, line: '' };

console.log('A. requireObserved counts only the leg\'s own hosts');
{
  const r = { smoke: [serviceHost], undead: [], violations: [], psFailed: false };
  const v = lib.embedGateVerdict(r, { requireObserved: true, legStartedMs: LEG_T0 });
  check('A1 1647035b: a host that predates the leg (the service leg\'s) does NOT satisfy requireObserved', v.ok === false,
    `gate ok=${v.ok} problems=${JSON.stringify(v.problems)}`);
  const v2 = lib.embedGateVerdict({ ...r, smoke: [serviceHost, ownHost] }, { requireObserved: true, legStartedMs: LEG_T0 });
  check('A2 1647035b: a host started during the leg does satisfy it', v2.ok === true, JSON.stringify(v2.problems));
}

console.log('B. no smoke-owned host may be alive when an evidence leg starts');
{
  const pre = fn('preLegEmbedVerdict');
  check('B0 1647035b: preLegEmbedVerdict is exported', pre !== null);
  if (pre) {
    const bad = pre({ smoke: [serviceHost], foreign: [], violations: [] });
    check('B1 1647035b: a leaked smoke host before the leg fails the precondition and is named', bad.ok === false && bad.alive.length === 1 && /4101/.test(bad.problems[0]),
      JSON.stringify(bad));
    check('B2 1647035b: no smoke host alive → precondition holds', pre({ smoke: [], foreign: [{ pid: 1 }], violations: [] }).ok === true);
    check('B3 1647035b: an unrunnable ps is not a pass', pre(null).ok === false);
  }
}

console.log('C. harness wiring');
{
  const ext = slice('async function testExtension(ext) {', '\n}\n');
  const svc = ext.slice(ext.indexOf('if (isBackground)'), ext.indexOf('// ── MCP serve modes'));
  const iDisable = svc.indexOf("'service', 'disable'");
  const iAwait = svc.indexOf('awaitSmokeEmbedHost(');
  const iReap = svc.search(/reapSmokeEmbedHosts\(\w+, \{ requireObserved: true, legStartedMs: serviceT0 \}\)/);
  check('C1 1647035b: the memory-server service leg waits for its own host while the daemon is alive (before disable)',
    iAwait !== -1 && iDisable !== -1 && iAwait < iDisable);
  check('C2 1647035b: and verified-stops it after disable with requireObserved + the service leg start',
    iReap !== -1 && iReap > iDisable);
  check('C3 1647035b: the service-leg reap is recorded as a log/summary step', /recordStep\(reapId,/.test(svc));
  const proxy = slice('async function runServeProxyAndVerify', 'function hostsFromManifest');
  const noProxy = slice('async function runMemoryServerDirectServeAndVerify', 'function verifyServiceRunning');
  for (const [name, body, spawnRe] of [['proxy', proxy, /spawn\(spawnCmd/], ['no-proxy', noProxy, /spawn\(SOXE, args/]]) {
    const iPre = body.indexOf('embedPreLegCheck(testId)');
    check(`C4 1647035b: the ${name} serve leg checks for a live smoke host before it spawns`, iPre !== -1 && iPre < body.search(spawnRe));
    check(`C5 1647035b: the ${name} serve leg's gate is bounded to its own start (legStartedMs: t0)`, /reapSmokeEmbedHosts\(testId, \{ requireObserved: \w+(?: === '[^']+')?, legStartedMs: t0 \}\)/.test(body));
    check(`C6 1647035b: the ${name} serve leg fails on a leaked host (embed-host-precondition)`, /verdict: "embed-host-precondition"/.test(body));
  }
}

console.log(failed === 0 ? 'PASS 1647035b: all cases pass' : `FAIL 1647035b: ${failed} case(s) failed`);
process.exit(failed === 0 ? 0 : 1);
