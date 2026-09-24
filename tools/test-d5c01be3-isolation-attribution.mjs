#!/usr/bin/env node
/**
 * tools/test-d5c01be3-isolation-attribution.mjs
 *
 * Red->green contract pin for backlog d5c01be3: the smoke harness's BL-173
 * isolation guard declared a FATAL breach whenever ANY process wrote the live
 * data root during a run, so a concurrent operator `soxe install <id>` from
 * another session (2026-09-24, pid 36115, `install backlog-operator --host
 * claude --scope user`) was indistinguishable from a smoke leak.
 *
 * The fixed guard (scripts/lib/isolation-guard.mjs) attributes each changed
 * entry to an operator `cli_invoked` event by verb AND target, and still fails
 * closed on everything it cannot attribute. This test pins both halves: the
 * concurrent-operator case must be a WARNING, and every leak shape must stay
 * FATAL.
 *
 * The negative control is the AUTHENTIC pre-fix rule, lifted from
 * scripts/smoke-test.mjs before d5c01be3: compare whole-file hashes of the four
 * live files and fail on any mismatch (`if (fingerprint[f] !==
 * fingerprintAfter[f]) isolationFailed = true`). It is embedded below as
 * PRE_FIX_GUARD and must FAIL this suite (it cannot produce the WARNING), which
 * proves the suite is able to fail.
 *
 * Usage:
 *   node tools/test-d5c01be3-isolation-attribution.mjs                 # real module; exit 0 iff all cases pass AND pre-fix control is rejected
 *   node tools/test-d5c01be3-isolation-attribution.mjs --module <path> # run the cases against another module exporting the same API (red demo)
 *   node tools/test-d5c01be3-isolation-attribution.mjs --pre-fix       # run the cases against the embedded pre-fix rule (red demo)
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MODULE = path.join(REPO_ROOT, 'scripts/lib/isolation-guard.mjs');

const modIdx = process.argv.indexOf('--module');
const MODULE_PATH = modIdx !== -1 ? path.resolve(process.argv[modIdx + 1]) : DEFAULT_MODULE;
const USE_PRE_FIX = process.argv.includes('--pre-fix');

const real = await import(pathToFileURL(DEFAULT_MODULE).href);
const underTest = modIdx !== -1 ? await import(pathToFileURL(MODULE_PATH).href) : real;

/** Authentic pre-fix rule (smoke-test.mjs before d5c01be3): any hash mismatch → FATAL; nothing else considered. */
const PRE_FIX_GUARD = {
  evaluateIsolation({ before, after }) {
    let failed = false;
    const lines = [];
    for (const f of Object.keys(after.files)) {
      if ((before.files[f]?.sha256 ?? 'ABSENT') !== (after.files[f]?.sha256 ?? 'ABSENT')) {
        lines.push(`ISOLATION FAILURE: live file mutated during smoke run: ${f}`);
        failed = true;
      }
    }
    if (!failed) lines.push('isolation OK — live data-root files byte-identical before/after');
    return { verdict: failed ? 'fatal' : 'ok', lines };
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

const T0 = Date.parse('2026-09-24T21:00:00.000Z');
const T1 = Date.parse('2026-09-24T21:10:00.000Z');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'd5c01be3-'));

function baseState() {
  return {
    'extensions.lock': { lockfileVersion: 2, resolved: {
      'memory-server': { source: 'file:///x/memory-server', checksum: 'sha256:aa', resolved_at: '2026-09-01T00:00:00Z', bundle_id: 'sox-memory-bundle' },
      'memory-cli': { source: 'file:///x/memory-cli', checksum: 'sha256:bb', resolved_at: '2026-09-01T00:00:00Z', bundle_id: 'sox-memory-bundle' },
    } },
    'install-registry.json': { version: 1, installs: [
      { extId: 'memory-server', version: '1.0.0', scope: 'user', root: '/home/u', installedAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', source: 'file:///x' },
    ] },
    'ledger.json': { version: 1, entries: [
      { ext: 'memory-server', host: 'claude', scope: 'user', actions: [], installedAt: '2026-09-01T00:00:00Z' },
    ] },
    'ownership.json': { version: 1, owned: [
      { extId: 'memory-server', scope: 'user', host: 'claude', bundleId: 'sox-memory-bundle', installedAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', entries: [] },
    ] },
  };
}

function writeState(root, state, rawOverrides = {}) {
  fs.mkdirSync(root, { recursive: true });
  for (const [name, doc] of Object.entries(state)) {
    fs.writeFileSync(path.join(root, name), rawOverrides[name] ?? JSON.stringify(doc, null, 2) + '\n');
  }
}

function writeLog(root, service, role, events) {
  const dir = path.join(root, service, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${service}.${role}-2026-09-24.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

const cli = (over) => ({ ts: '2026-09-24T21:03:11.552Z', level: 'info', event: 'cli_invoked', role: 'cli', pid: 36115, verb: 'install', target: 'backlog-operator', host: 'claude', scope: 'user', ...over });

/** An operator install of backlog-operator (the 2026-09-24 incident shape), applied to a state. */
function applyOperatorInstall(s, id = 'backlog-operator') {
  s['ledger.json'].entries.push({ ext: id, host: 'claude', scope: 'user', actions: [], installedAt: '2026-09-24T21:03:12Z' });
  s['ownership.json'].owned.push({ extId: id, scope: 'user', host: 'claude', installedAt: '2026-09-24T21:03:12Z', updatedAt: '2026-09-24T21:03:12Z', entries: [] });
  s['install-registry.json'].installs.push({ extId: id, version: '0.1.0', scope: 'user', root: '/home/u', installedAt: '2026-09-24T21:03:12Z', updatedAt: '2026-09-24T21:03:12Z', source: 'file:///x' });
  s['extensions.lock'].resolved[id] = { source: 'file:///x/' + id, checksum: 'sha256:cc', resolved_at: '2026-09-24T21:03:12Z' };
  return s;
}

let caseNo = 0;
/**
 * Build a scenario on disk and evaluate it through `guard`.
 * mutate(state) → mutated state (or {state, raw}); liveEvents/scratchEvents are written as real JSONL files
 * and read back through the real module's readTelemetryEvents (so the fs readers are exercised too).
 */
function scenario(guard, { mutate = (s) => s, liveEvents = [], scratchEvents = [], touched = [] }) {
  const dir = path.join(TMP, `case-${++caseNo}`);
  const live = path.join(dir, 'live');
  const scratch = path.join(dir, 'scratch');
  writeState(live, baseState());
  const before = real.snapshotLiveFiles(live, { now: () => T0 });
  const m = mutate(baseState());
  if (m && m.raw) writeState(live, m.state, m.raw); else writeState(live, m);
  const after = real.snapshotLiveFiles(live, { now: () => T1 });
  if (liveEvents.length) writeLog(live, 'sox', 'cli', liveEvents);
  if (scratchEvents.length) writeLog(scratch, 'sox', 'harness', scratchEvents);
  const window = { sinceMs: T0 - real.DEFAULT_OPERATOR_SLACK_MS, untilMs: T1 };
  // mtime filter: fixture files are written "now", far after T0 — always read.
  const le = real.readTelemetryEvents(real.telemetryLogDirs(live), window).events;
  const se = real.readTelemetryEvents(real.telemetryLogDirs(scratch), window).events;
  return guard.evaluateIsolation({ before, after, liveEvents: le, scratchEvents: se, smokeTouchedIds: touched });
}

// ──────────────────────────────────────────────────────────────────────────────
// Cases
// ──────────────────────────────────────────────────────────────────────────────

const CASES = [
  {
    name: 'concurrent operator install of an unrelated id → WARNING naming pid/verb/target/entry',
    run: (g) => scenario(g, { mutate: (s) => applyOperatorInstall(s), liveEvents: [cli()], touched: ['memory-server', 'sox-memory-bundle'] }),
    expect: (r) => r.verdict === 'warning' &&
      r.lines.some((l) => l.includes('pid=36115') && l.includes('verb=install') && l.includes('target=backlog-operator')) &&
      r.lines.some((l) => l.includes('ledger.json added backlog-operator|claude|user')),
  },
  {
    name: 'changed entry with NO operator event → FATAL',
    run: (g) => scenario(g, { mutate: (s) => applyOperatorInstall(s), liveEvents: [] }),
    expect: (r) => r.verdict === 'fatal' && r.lines.some((l) => l.includes('UNEXPLAINED')),
  },
  {
    name: 'operator event whose target does not match the changed entry → FATAL',
    run: (g) => scenario(g, { mutate: (s) => applyOperatorInstall(s), liveEvents: [cli({ target: 'some-other-ext' })] }),
    expect: (r) => r.verdict === 'fatal',
  },
  {
    name: 'change to an id the smoke run touched → FATAL even though an operator event names it',
    run: (g) => scenario(g, {
      mutate: (s) => { s['ledger.json'].entries[0].installedAt = '2026-09-24T21:05:00Z'; return s; },
      liveEvents: [cli({ target: 'memory-server' })], touched: ['memory-server'],
    }),
    expect: (r) => r.verdict === 'fatal' && r.lines.some((l) => l.includes('SMOKE-TOUCHED')),
  },
  {
    name: 'role=harness event in the LIVE log window (no file change at all) → FATAL',
    run: (g) => scenario(g, { liveEvents: [cli({ role: 'harness', pid: 777, verb: 'install', target: 'memory-server' })] }),
    expect: (r) => r.verdict === 'fatal' && r.lines.some((l) => l.includes('role=harness')),
  },
  {
    name: 'role=harness event plus an otherwise-explained operator change → still FATAL',
    run: (g) => scenario(g, { mutate: (s) => applyOperatorInstall(s),
      liveEvents: [cli(), cli({ role: 'harness', pid: 778, ts: '2026-09-24T21:04:00.000Z' })] }),
    expect: (r) => r.verdict === 'fatal',
  },
  {
    name: 'bundle member entries explained by an operator install of the bundle → WARNING',
    run: (g) => scenario(g, {
      mutate: (s) => { s['ledger.json'].entries.push({ ext: 'memory-cli', host: 'claude', scope: 'user', actions: [], installedAt: '2026-09-24T21:03:12Z' }); return s; },
      liveEvents: [cli({ target: 'sox-memory-bundle' })],
    }),
    expect: (r) => r.verdict === 'warning',
  },
  {
    name: 'bundle member of a smoke-touched bundle → FATAL',
    run: (g) => scenario(g, {
      mutate: (s) => { s['ledger.json'].entries.push({ ext: 'memory-cli', host: 'claude', scope: 'user', actions: [], installedAt: '2026-09-24T21:03:12Z' }); return s; },
      liveEvents: [cli({ target: 'memory-cli' })], touched: ['sox-memory-bundle'],
    }),
    expect: (r) => r.verdict === 'fatal',
  },
  {
    name: 'read-only verb naming the id (details) cannot explain a write → FATAL',
    run: (g) => scenario(g, { mutate: (s) => applyOperatorInstall(s), liveEvents: [cli({ verb: 'details' })] }),
    expect: (r) => r.verdict === 'fatal',
  },
  {
    name: 'operator event with no target (pre-d5c01be3 soxe dist / upgrade --all) → FATAL (fail closed)',
    run: (g) => scenario(g, { mutate: (s) => applyOperatorInstall(s), liveEvents: [cli({ target: undefined })] }),
    expect: (r) => r.verdict === 'fatal' && r.lines.some((l) => l.includes('carry no target')),
  },
  {
    name: 'operator event with a mismatched scope → FATAL',
    run: (g) => scenario(g, { mutate: (s) => applyOperatorInstall(s), liveEvents: [cli({ scope: 'project' })] }),
    expect: (r) => r.verdict === 'fatal',
  },
  {
    name: 'operator event outside the run window → FATAL',
    run: (g) => scenario(g, { mutate: (s) => applyOperatorInstall(s), liveEvents: [cli({ ts: '2026-09-24T20:00:00.000Z' })] }),
    expect: (r) => r.verdict === 'fatal',
  },
  {
    name: 'scratch-log harness target joins the smoke-touched set → FATAL',
    run: (g) => scenario(g, { mutate: (s) => applyOperatorInstall(s), liveEvents: [cli()],
      scratchEvents: [cli({ role: 'harness', pid: 900, target: 'backlog-operator' })] }),
    expect: (r) => r.verdict === 'fatal' && r.lines.some((l) => l.includes('SMOKE-TOUCHED')),
  },
  {
    name: 'bytes changed with no entry-level difference → FATAL (never vacuously explained)',
    run: (g) => scenario(g, { mutate: (s) => ({ state: s, raw: { 'ledger.json': JSON.stringify(s['ledger.json']) } }), liveEvents: [cli()] }),
    expect: (r) => r.verdict === 'fatal' && r.lines.some((l) => l.includes('bytes-only')),
  },
  {
    name: 'top-level field change → FATAL',
    run: (g) => scenario(g, { mutate: (s) => { s['ownership.json'].version = 2; return s; }, liveEvents: [cli()] }),
    expect: (r) => r.verdict === 'fatal' && r.lines.some((l) => l.includes('top-level')),
  },
  {
    name: 'unparseable live file → FATAL',
    run: (g) => scenario(g, { mutate: (s) => ({ state: s, raw: { 'ownership.json': '{ torn' } }), liveEvents: [cli()] }),
    expect: (r) => r.verdict === 'fatal' && r.lines.some((l) => l.includes('unparseable')),
  },
  {
    name: 'no change and no harness telemetry → OK',
    run: (g) => scenario(g, { liveEvents: [cli()] }),
    expect: (r) => r.verdict === 'ok',
  },
];

function runSuite(guard, label) {
  let failed = 0;
  for (const c of CASES) {
    let r;
    let ok = false;
    try {
      r = c.run(guard);
      ok = c.expect(r);
    } catch (e) {
      console.error(`  [${label}] threw on "${c.name}": ${(e && e.stack) ?? e}`);
    }
    if (!ok) {
      failed++;
      console.error(`  [${label}] FAIL: ${c.name} (verdict=${r?.verdict ?? 'n/a'})`);
      for (const l of r?.lines ?? []) console.error(`      ${l}`);
    } else {
      console.log(`  [${label}] ok: ${c.name}`);
    }
  }
  return failed;
}

let exitCode = 0;
try {
  const label = USE_PRE_FIX ? 'pre-fix' : path.relative(REPO_ROOT, MODULE_PATH);
  const guard = USE_PRE_FIX ? PRE_FIX_GUARD : underTest;
  const failed = runSuite(guard, label);
  console.log(`${label}: ${CASES.length - failed}/${CASES.length} cases pass`);
  if (failed > 0) exitCode = 1;

  if (!USE_PRE_FIX && modIdx === -1) {
    // Negative control: the authentic pre-fix rule must NOT satisfy this suite.
    const controlFailed = runSuite(PRE_FIX_GUARD, 'pre-fix-control');
    if (controlFailed === 0) {
      console.error('NEGATIVE CONTROL FAILED: the pre-fix any-mismatch-is-FATAL rule passes every case — the suite cannot detect the d5c01be3 defect');
      exitCode = 1;
    } else {
      console.log(`negative control: pre-fix rule rejected (${controlFailed}/${CASES.length} cases fail) — suite is able to fail`);
    }
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(exitCode === 0 ? 'd5c01be3: PASS' : 'd5c01be3: FAIL');
process.exit(exitCode);
