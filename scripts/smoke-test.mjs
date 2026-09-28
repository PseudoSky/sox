#!/usr/bin/env node
/**
 * scripts/smoke-test.mjs — manifest-driven lifecycle smoke tests for sox extensions.
 *
 * Discovers every service / mcp-server extension (standalone + bundle members) in
 * the workspace, reads each manifest to derive supported variations (hosts, scopes,
 * serve modes, background-vs-foreground), exercises the full lifecycle via `soxe`
 * in a disposable project scope under dist/smoke/, and records structured pass/fail
 * json to dist/smoke/<run>/log.json.
 *
 * Usage:
 *   node scripts/smoke-test.mjs [--extension id] [--root /tmp/smoke]
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
// BL-192 gap fix: workspace package discovery + contract-path resolution
// (shared with tools/verify-exports-publint-attw.mjs) so the Build-first gate
// below checks EVERY package's main/module/types/bin/exports paths, not just
// the CLI bundle + extension entrypoints.
import { workspacePackageDirs, contractArtifactPaths } from '../tools/workspace-package-scan.mjs';
import {
  DEFAULT_OPERATOR_SLACK_MS,
  evaluateIsolation,
  otherServiceLogDirs,
  pidsFromPsLines,
  pidsFromServiceStatus,
  readTelemetryEvents,
  snapshotLiveFiles,
  soxCliLogDirs,
  telemetryLogDirs,
} from './lib/isolation-guard.mjs';
import {
  PS_ARGS as EMBED_PS_ARGS,
  auditAndReapEmbedHosts,
  auditEmbedHosts,
  describeHost,
  embedGateVerdict,
  parsePsLines,
} from './lib/embed-host-isolation.mjs';
import { buildMemoryServerEnv, buildSmokeEnv } from './lib/smoke-env.mjs';

// ──────────────────────────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────────────────────────

const ARGV = process.argv.slice(2);

/**
 * Read a `--flag value` pair. Guards against the value being missing or being
 * another flag — otherwise `--root --extension foo` would silently treat
 * `--extension` as the root path and write output to `./--extension/…`
 * (that exact bug created a stray `--extension/` dir in the repo).
 */
function flagValue(name) {
  const i = ARGV.indexOf(name);
  if (i === -1) return null;
  const v = ARGV[i + 1];
  if (v === undefined || v.startsWith('-')) {
    console.error(`[smoke] flag ${name} requires a value (got ${v === undefined ? 'end-of-args' : v})`);
    process.exit(2);
  }
  return v;
}

const rootArg = flagValue('--root');
const WORKSPACE = rootArg ? path.resolve(rootArg) : path.resolve('.');
const SOXE = path.join(WORKSPACE, 'bin', 'soxe');
const require = createRequire(import.meta.url);

// 7c686059: what the local-sources registry computed for each id — populated
// once in main() after generating TEST_ROOT's own registry/index.json (see
// the generation block below). Diagnostic only: verifyLocalBytesInvariant()
// asserts against the INSTALLED lockfile entry's own bytes directly (hashing
// whatever it points at right now), not against this map — that avoids a
// tautological "does resolver A agree with resolver B" check and stays
// correct for ids (e.g. a private extension) that never made it into a
// published/local-sources registry row at all.
let localRegistryEntries = new Map();

// Portability: prefer a real "timeout" binary (GNU coreutils -- present by
// default on essentially every Linux CI image, and installable on macOS via
// `brew install coreutils` as `gtimeout`) to own process termination for the
// proxy-mode serve step below, rather than Node child.kill(). Neither is
// hard-required: TIMEOUT_BIN is null when absent and the caller falls back to
// a raw process.kill(pid, signal) syscall wrapper.
function findTimeoutBin() {
  for (const bin of ["timeout", "gtimeout"]) {
    try {
      execSync("command -v " + bin, { stdio: ["ignore", "ignore", "ignore"] });
      return bin;
    } catch { /* not found -- try next */ }
  }
  return null;
}
const TIMEOUT_BIN = findTimeoutBin();
const EXTENSION_FILTER = flagValue('--extension');

const TEST_ROOT = path.resolve(WORKSPACE, 'dist', 'smoke',
  `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
const LOG_PATH = path.join(TEST_ROOT, 'log.json');

// (BL-585) Set ONLY on a path that reached a real verdict — see the 'exit' handler
// at the bottom of this file for why exit 0 alone cannot be trusted.
let runCompleted = false;

// ── BL-173 Hermetic data-root sandbox ─────────────────────────────────────────
//
// The service/serve legs derive the backend UDS socket from the USER data root
// (~/.adhd/sox-ecosystem/run/supervisors/ via libs/host-runtime/src/data-paths.ts
// `socketDir()`). If SOX_ECOSYSTEM_HOME is not set, every soxe spawn in this
// harness races the production memory-server writer for the live socket.
//
// Fix: inject a scratch data root and scratch db path into EVERY child process
// this harness spawns. The runtime (data-paths.ts) reads SOX_ECOSYSTEM_HOME at
// call time, so setting it in the child's env is sufficient.
//
//   SOX_ECOSYSTEM_HOME  — redirects userDataRoot() → socket dir, install-registry,
//                          supervisors, ledger, ownership (libs/host-runtime AND
//                          libs/install-engine both honour the same var).
//
// NOT injected here: SOX_CONFIG_DB_PATH. Every resolveStoreResource() call site
// (apps/sox/src/main.ts) is fed `buildExtConfigEnv()`'s config-cascade env, never
// raw `process.env` — and for memory-server specifically, `soxe serve` always
// scrubs SOX_CONFIG_* from the AMBIENT env before re-applying it from the resolved
// config cascade (`env-policy.ts` ENV_DENY_PREFIXES; memory-server declares a
// `permissions` block, so this scrub always fires for it). An ambient
// SOX_CONFIG_DB_PATH in this function would therefore never reach the singleton
// key or the served store — see the BL-635 `config set` call in testExtension()
// below, which is the only path that actually threads db_path through.
//
// The live user data root (~/.adhd/sox-ecosystem) MUST remain untouched.
// An assertion in main() verifies no sockets appeared under the real socket dir.

const SMOKE_DATA_ROOT = path.join(TEST_ROOT, 'sox-data-root');
// BL-635 (memory-server-serve-no-proxy false green / db_path never reachable):
// two independent gates stood between an ambient SOX_CONFIG_DB_PATH and the
// spawned memory-server, and BOTH must be satisfied, not just one:
//
//   1. env-policy.ts's ENV_DENY_PREFIXES denies `SOX_CONFIG_*` from the
//      AMBIENT environment on any policy-enforced spawn (memory-server
//      declares a `permissions` block, so cmdServe's `soxe serve` always
//      scrubs it — apps/sox/src/main.ts's `serveEnv = {...baseEnv2,
//      ...configEnv2, ...}`, where baseEnv2 = scrubEnvReported()). This is
//      BY DESIGN (SOX_CONFIG_* is host-authoritative, see env-policy.ts's
//      module header) — the fix is to inject db_path through the resolved
//      config CASCADE (`soxe config set`), not the ambient env; see the
//      config-set call in testExtension() below.
//   2. Even once SOX_CONFIG_DB_PATH threads through correctly, the
//      extension's OWN in-process fs-permission guard
//      (extension.json permissions.fs: read/write ["~/.memory/**"]) governs
//      the resolved db_path too, and `~` expands via `expandTilde`/
//      `os.homedir()` against the REAL $HOME — NOT $SOX_ECOSYSTEM_HOME. A
//      db_path under TEST_ROOT (outside the real ~/.memory) is denied
//      regardless of (1). Give the memory-server legs a SCRATCH $HOME
//      (mirroring the FAKE_HOME technique memory-server's own
//      permission-guard.spec.ts uses) so `~/.memory/**` resolves inside
//      TEST_ROOT, and put the scratch store there.
const MEMORY_FAKE_HOME = path.join(TEST_ROOT, 'sox-data-root', 'fake-home');

// ── 26121495: a smoke run shares no socket path class, model cache or
// embedding host with production ──────────────────────────────────────────
// The embedding host's socket lives under `$SOX_ECOSYSTEM_HOME/run`
// (embedHostConfig.ts resolveEmbedHostSocketDir). SMOKE_DATA_ROOT sits ~100
// bytes deep in a worktree, so `<root>/run/<socket>` blows the 104-byte
// sun_path budget and backendSocketPath() (libs/service-proxy/src/socket-path.ts,
// BL-578, BL-4041c6e0) falls back to the per-uid root `/tmp/sox-<uid>/` — a
// directory every deep-rooted process of this user shares, production included.
// SMOKE_SHORT_ROOT is a short, run-unique symlink to
// SMOKE_DATA_ROOT: the children get it as SOX_ECOSYSTEM_HOME, so every socket
// fits under it (28-byte `<short>/run/` + a 72-byte key filename = 100), while
// every file still lands physically under TEST_ROOT for the snapshot diffs.
const SMOKE_SHORT_ROOT = path.join('/tmp', `sox-smoke-${crypto.randomBytes(4).toString('hex')}`);
// The model cache and the TMPDIR every smoke child resolves (XDG_CACHE_HOME
// outranks $HOME/.cache in joinDefaultCacheDir(); TMPDIR stays run-owned so no
// child writes scratch files into the operator's temp dir. The socket fallback
// no longer reads TMPDIR).
const SMOKE_XDG_CACHE_HOME = path.join(TEST_ROOT, 'sox-data-root', 'xdg-cache');
const SMOKE_TMPDIR = path.join(SMOKE_SHORT_ROOT, 'tmp');
/** Every root a smoke-owned process may resolve HOME / cache / socket under. */
const SMOKE_ROOTS = [TEST_ROOT, SMOKE_SHORT_ROOT];
/** 26121495: every embedding host this run spawned that escaped containment. */
const EMBED_ISOLATION_BREACHES = [];
/** 97e7f214: every smoke embedding host that survived a verified stop. */
const EMBED_UNDEAD = new Set();
/** 26121495: every distinct pid attributed to this run by an embed-host reap (the gate's evidence). */
const EMBED_ATTRIBUTED = new Set();
const SMOKE_DB_PATH = path.join(MEMORY_FAKE_HOME, '.memory', 'memory-smoke.db');

// Derive the real live socket dir so we can assert against it after the run.
const REAL_SOCKET_DIR = process.env['SOX_ECOSYSTEM_HOME']
  ? path.join(process.env['SOX_ECOSYSTEM_HOME'], 'run', 'supervisors')
  : path.join(process.env['HOME'] ?? '', '.adhd', 'sox-ecosystem', 'run', 'supervisors');

// ── BL-173 / d5c01be3: live data-root isolation baseline ─────────────────────
// The LIVE data root the smoke run must never write. Deliberately derived from
// $HOME, never from $SOX_ECOSYSTEM_HOME (which the harness overrides for its
// children and an operator may have pointed anywhere).
const LIVE_DATA_ROOT = path.join(process.env['HOME'] ?? '', '.adhd', 'sox-ecosystem');
/** Live snapshot taken immediately before the FIRST smoke-spawned soxe (d5c01be3 (c)). */
let isolationBaseline = null;
/** Every extension/bundle id this run spawned soxe against (d5c01be3 (b′)). */
const SMOKE_TOUCHED_IDS = new Set();
/**
 * Every pid this run is known to have spawned (spawn()ed children, their
 * descendants, the proxy's backend, each detached process group's members).
 * A role=harness event in ANOTHER live service log (e.g. memory-core) whose
 * pid is in this set is a smoke child that lost SOX_ECOSYSTEM_HOME → FATAL.
 */
const SMOKE_SPAWNED_PIDS = new Set();

/** Subset of SMOKE_SPAWNED_PIDS parsed from `soxe service status` `live pids:` (reported as a count). */
const SMOKE_SERVICE_PIDS = new Set();

/** Record `pid` and (best effort) its live descendants via `pgrep -P`. */
function recordSmokePidTree(pid, testId) {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return;
  const stack = [pid];
  const seen = new Set();
  while (stack.length > 0) {
    const p = stack.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    SMOKE_SPAWNED_PIDS.add(p);
    let out = '';
    try {
      out = execSync(`pgrep -P ${p}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      if (!e || e.status !== 1) console.error(`[smoke] WARNING: ${testId ?? '?'} pgrep -P ${p} failed: ${(e && e.message) ?? e}`);
      continue; // status 1 = no children
    }
    for (const t of out.split(/\s+/)) { const n = Number(t); if (n > 0) stack.push(n); }
  }
}

/**
 * Trace a failed process.kill. ESRCH (the process is already gone) is the
 * expected steady state at teardown and stays silent; anything else (EPERM, a
 * bad pid, …) is a real condition worth seeing.
 */
function logKillError(e, testId, pid, sig) {
  if (e && e.code === 'ESRCH') return;
  console.error(`[smoke] WARNING: ${testId ?? '?'} ${sig} to pid ${pid} failed: ${(e && e.code) ?? ''} ${(e && e.message) ?? e}`);
}

/** Record every member of process group `pgid` (`pgrep -g`). */
function recordSmokePgroup(pgid, testId) {
  let out = '';
  try {
    out = execSync(`pgrep -g ${pgid}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    if (!e || e.status !== 1) console.error(`[smoke] WARNING: ${testId ?? '?'} pgrep -g ${pgid} (pid recording) failed: ${(e && e.message) ?? e}`);
    return;
  }
  for (const t of out.split(/\s+/)) { const n = Number(t); if (n > 0) SMOKE_SPAWNED_PIDS.add(n); }
}

/** Wall-clock start of main() — lower bound for the scratch-log scan. */
let RUN_STARTED_MS = Date.now();

/**
 * Called at the top of every soxe spawn wrapper. Takes the BEFORE snapshot on
 * the first call only — after the ~86 s preflight (nx graph, build-index,
 * publint/attw) that spawns no soxe, so an operator write landing during
 * preflight can never be misread as a smoke leak — and records the id(s) the
 * spawn acts on, so a live change to one of them is FATAL even when an
 * operator event also names it.
 */
const SOXE_ID_TARGET_VERBS = new Set([
  'install', 'uninstall', 'update', 'upgrade', 'enable', 'disable',
  'start', 'stop', 'serve', 'exec', 'details', 'status', 'logs',
]);
function noteSoxeSpawn(args, extId) {
  if (isolationBaseline === null) {
    isolationBaseline = snapshotLiveFiles(LIVE_DATA_ROOT);
    console.error(`[smoke] live fingerprint BEFORE (first soxe spawn, ${new Date(isolationBaseline.takenAtMs).toISOString()}):`,
      JSON.stringify(Object.fromEntries(Object.entries(isolationBaseline.files).map(([k, v]) => [k, v.sha256 ?? 'ABSENT']))));
  }
  if (typeof extId === 'string' && extId !== '') SMOKE_TOUCHED_IDS.add(extId);
  // Positional ids after the verb (`install <id>`, `service enable <id>`), never flag values.
  const positionals = [];
  for (let i = 1; i < args.length; i++) {
    const a = String(args[i]);
    if (a.startsWith('-')) {
      if (!a.includes('=') && i + 1 < args.length && !String(args[i + 1]).startsWith('-')) i++;
      continue;
    }
    positionals.push(a);
  }
  // Only verbs whose positional IS an extension/bundle id (mirrors apps/sox/src/cli-invoked-fields.ts);
  // `config set <key> <value>` names a config key, not an id.
  const idPos = args[0] === 'service' ? positionals[1]
    : SOXE_ID_TARGET_VERBS.has(args[0]) ? positionals[0] : undefined;
  if (idPos) SMOKE_TOUCHED_IDS.add(idPos);
}

const SMOKE_ENV_CFG = {
  dataRoot: SMOKE_SHORT_ROOT,
  xdgCacheHome: SMOKE_XDG_CACHE_HOME,
  tmpdir: SMOKE_TMPDIR,
  fastembedLock: path.join(SMOKE_DATA_ROOT, 'fastembed-host.lock'),
  memoryHome: MEMORY_FAKE_HOME,
};

/** Env block injected into every child process this harness spawns (scripts/lib/smoke-env.mjs). */
function smokeEnv() {
  return buildSmokeEnv(process.env, SMOKE_ENV_CFG);
}

/**
 * smokeEnv() plus a scratch $HOME (see MEMORY_FAKE_HOME above) — used for
 * EVERY memory-server leg (26121495), so `~/.memory/**` fs-permission expansion
 * and the embedding host's model cache resolve inside TEST_ROOT instead of the
 * operator's real home directory.
 */
function memoryServerEnv() {
  return buildMemoryServerEnv(process.env, SMOKE_ENV_CFG);
}

// ──────────────────────────────────────────────────────────────────────────────
// Logging / tracking
// ──────────────────────────────────────────────────────────────────────────────

const log = [];
const summary = { passed: 0, failed: 0, skipped: 0 };

function sha256(buf) { return require('node:crypto').createHash('sha256').update(buf).digest('hex'); }

async function snapshotFiles(root) {
  const m = new Map();
  try {
    for await (const d of await fsp.opendir(root, { recursive: true })) {
      if (!d.isFile()) continue;
      const full = path.join(d.parentPath, d.name);
      try { m.set(path.relative(root, full), sha256(await fsp.readFile(full))); } catch { m.set(path.relative(root, full), 'UNREADABLE'); }
    }
  } catch (err) {
    // A failed snapshot silently yields an empty map, which then diffs as
    // "everything created" — false isolation evidence. Trace it.
    console.error(`[smoke] WARNING: snapshot of ${root} failed (${(err && err.message) ?? err}); before/after diff will be unreliable`);
  }
  return m;
}

function diffSnapshots(before, after) {
  const changes = [];
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    if (!before.has(k)) changes.push({ op: 'created', path: k });
    else if (!after.has(k)) changes.push({ op: 'deleted', path: k });
    else if (before.get(k) !== after.get(k)) changes.push({ op: 'modified', path: k });
  }
  return changes;
}

async function runCmd(args, opts = {}) {
  const { cwd = TEST_ROOT, timeoutMs = 120_000, testId, extId, extType, stdinInput, verify, env } = opts;
  noteSoxeSpawn(args, extId);
  const before = await snapshotFiles(TEST_ROOT);
  const t0 = Date.now();
  let stdout = '', stderr = '', exitCode = null, signal = null, error = null;

  try {
    stdout = execSync(`${SOXE} ${args.join(' ')}`, {
      cwd, encoding: 'utf-8', timeout: timeoutMs,
      env: env || smokeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'], input: stdinInput,
    });
    exitCode = 0;
  } catch (e) {
    stdout = e.stdout ?? ''; stderr = e.stderr ?? '';
    // execSync sets `status: null` (NOT a truthy fallback) when the process was
    // killed by a signal (e.g. our own timeoutMs kill) rather than exiting on its
    // own. BL-578 audit: the old `e.status ?? 1` collapsed "genuinely exited 1"
    // and "we killed it after timeoutMs" into the same value, which is exactly
    // the ambiguity `isServe ? exitCode !== null : ...` then exploited to call
    // both cases a pass. Keep them distinguishable.
    exitCode = e.status ?? null;
    signal = e.signal ?? null;
    error = e.message.slice(0, 500);
  }
  const after = await snapshotFiles(TEST_ROOT);
  const fileChanges = diffSnapshots(before, after);
  auditSmokeEmbedHosts(testId ?? args.join(' '));

  // ── BL-578: fail-closed verdict computation ────────────────────────────────
  // Every step's pass/fail must be a POSITIVE assertion, never an absence of a
  // thrown error. `verify`, when supplied, is the assertion: it inspects the
  // actually-observed stdout/stderr/exitCode/signal and returns concrete
  // evidence. A step with no `verify` falls back to the simplest positive
  // assertion available -- a clean exit(0) -- which is now enforced for EVERY
  // command, including `serve` (previously exempted). A long-running `serve`
  // that is expected to be killed by our own timeoutMs MUST supply `verify` to
  // prove something happened before the kill; it no longer gets a free pass
  // for merely not being null.
  let passed;
  let verdict;
  let verdictDetail;
  if (verify) {
    let result;
    try {
      result = await verify({ stdout, stderr, exitCode, signal });
    } catch (verr) {
      // The verifier itself threw -- this is NOT "passed", and it is NOT the
      // same as "verify said fail" either: record it as a distinct outcome so
      // a broken assertion can never silently read as a clean failure, let
      // alone a pass (tools/backlog-verify-durable.mjs discipline: "could not
      // check" and "verified fine" must never render the same).
      result = { ok: false, verdict: 'verify-threw', detail: `verify() threw: ${(verr && verr.message) ?? verr}` };
    }
    passed = result != null && result.ok === true;
    verdict = passed ? 'verified' : (result && result.verdict ? result.verdict : 'unverified');
    verdictDetail = (result && result.detail) || '';
  } else {
    passed = exitCode === 0;
    verdict = passed ? 'verified' : (signal ? `killed(${signal})` : 'failed');
    verdictDetail = passed ? '' : (error ?? '');
  }

  const entry = {
    test_id: testId, extension_id: extId, extension_type: extType,
    command: `${SOXE} ${args.join(' ')}`,
    exit_code: exitCode, signal, verdict, verdict_detail: verdictDetail,
    stdout: (stdout || '').slice(-2000), stderr: (stderr || '').slice(-2000),
    file_changes: (fileChanges || []).slice(0, 50), duration_ms: Date.now() - t0, passed, error,
  };
  log.push(entry);
  passed ? summary.passed++ : summary.failed++;
  return { stdout, stderr, exitCode, signal };
}

// 7c686059: the project-scope lockfile this harness's every install leg
// writes to (scopesFromManifest below always returns ['project'], and every
// runCmd(['install', ...]) call passes --root TEST_ROOT) — mirrors
// libs/install-engine/src/data-paths.ts scopeConfigPaths('project', root):
// `<root>/.adhd/sox-ecosystem/extensions.lock`.
const PROJECT_LOCKFILE = path.join(TEST_ROOT, '.adhd', 'sox-ecosystem', 'extensions.lock');

/**
 * 7c686059: after ANY install leg that should have resolved `id`, assert the
 * project-scope lockfile recorded a LOCAL source/checksum — never an
 * npm-package: tarball fetch, and never install.ts's npm content-store cache
 * either — by (a) requiring `resolved[id].source` to point INSIDE this
 * worktree's own `extensions/**`/`apps/**`, then (b) hashing whatever that
 * source actually points at RIGHT NOW and requiring it to equal
 * `resolved[id].checksum`. This is the positive assertion the defect
 * (symlinking the committed, partly npm-package:-pinned registry straight
 * into TEST_ROOT) made impossible: a regression in this worktree's own
 * rebuilt dist/ would previously sail through a fully green smoke run
 * because install.ts was npm-installing PUBLISHED bytes for these ids, never
 * touching local disk.
 *
 * Returns a `verify`-shaped result ({ok, verdict, detail}) — pass either as
 * `runCmd`'s `verify` option directly, or call the returned function
 * out-of-band (bundle members never go through `testExtension`'s own runCmd
 * calls, so their invariant is checked immediately after the bundle's own
 * install/upgrade legs instead — see main()).
 */
function verifyLocalBytesInvariant(id) {
  return ({ exitCode, stderr } = {}) => {
    if (exitCode !== undefined && exitCode !== null && exitCode !== 0) {
      return {
        ok: false,
        verdict: 'install-failed',
        detail: `soxe install for "${id}" exited ${exitCode} — cannot assert the local-bytes invariant against a failed install: ${(stderr || '').slice(-500)}`,
      };
    }
    let lockfile;
    try {
      lockfile = JSON.parse(fs.readFileSync(PROJECT_LOCKFILE, 'utf-8'));
    } catch (e) {
      return {
        ok: false,
        verdict: 'lockfile-unreadable',
        detail: `could not read/parse ${PROJECT_LOCKFILE}: ${(e && e.message) ?? e}`,
      };
    }
    const entry = lockfile.resolved && lockfile.resolved[id];
    if (!entry) {
      return {
        ok: false,
        verdict: 'lockfile-entry-missing',
        detail: `no resolved["${id}"] in ${PROJECT_LOCKFILE} (keys: ${Object.keys(lockfile.resolved || {}).join(', ')})`,
      };
    }
    if (typeof entry.source !== 'string' || entry.source.startsWith('npm-package:')) {
      return {
        ok: false,
        verdict: 'source-is-npm-package',
        detail: `resolved["${id}"].source = ${entry.source} — this install pulled a NPM TARBALL instead of local dist/ bytes (7c686059)`,
      };
    }
    // 7c686059: the ONLY places a genuine local extension source lives are
    // `extensions/**` and `apps/**` (apps/sox is a self-hosted extension —
    // see build-index.ts's secondary scan). `file://${WORKSPACE}/` alone is
    // too loose: `TEST_ROOT` (dist/smoke/**) lives INSIDE `WORKSPACE`, and
    // install.ts's npm-package: content store (fetchNpmPackage's `storeDir`)
    // is scoped under it too — so a genuine npm-tarball-fetched artifact's
    // resolvedSource would ALSO start with `file://${WORKSPACE}/` and slip
    // past a bare-prefix check. Anchor to the two real source roots instead.
    const extensionsPrefix = `file://${path.join(WORKSPACE, 'extensions')}${path.sep}`;
    const appsPrefix = `file://${path.join(WORKSPACE, 'apps')}${path.sep}`;
    if (!entry.source.startsWith(extensionsPrefix) && !entry.source.startsWith(appsPrefix)) {
      return {
        ok: false,
        verdict: 'source-not-local',
        detail: `resolved["${id}"].source = ${entry.source} — expected to start with ${extensionsPrefix} or ${appsPrefix} (7c686059: must resolve to a real extension source in THIS worktree, never an npm content store or any other external location)`,
      };
    }
    // 7c686059: the checksum authority is the ACTUAL bytes on disk at the
    // resolved entrypoint RIGHT NOW — not a second lookup into a registry
    // (comparing two things install.ts itself already derived the same way
    // would be a tautology, and would fail to notice `id` was never in that
    // registry to begin with, e.g. a private/local-only extension). This is
    // exactly what makes it an assertion "the installed artifact IS this
    // worktree's current dist/ bytes" rather than "two resolvers agreed".
    let entryPath;
    try {
      entryPath = fileURLToPath(entry.source);
    } catch (e) {
      return {
        ok: false,
        verdict: 'source-unparseable',
        detail: `resolved["${id}"].source = ${entry.source} could not be parsed as a file:// URL: ${(e && e.message) ?? e}`,
      };
    }
    let actualChecksum;
    try {
      actualChecksum = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(entryPath)).digest('hex')}`;
    } catch (e) {
      return {
        ok: false,
        verdict: 'entrypoint-unreadable',
        detail: `could not read ${entryPath} (resolved["${id}"].source) to verify its checksum: ${(e && e.message) ?? e}`,
      };
    }
    if (entry.checksum !== actualChecksum) {
      return {
        ok: false,
        verdict: 'checksum-mismatch',
        detail: `resolved["${id}"].checksum = ${entry.checksum}, but sha256(${entryPath}) = ${actualChecksum} right now — the lockfile's recorded checksum does not match the file it points at`,
      };
    }
    return {
      ok: true,
      verdict: 'verified',
      detail: `resolved["${id}"].source=${entry.source}, checksum=${entry.checksum} matches sha256(${entryPath}) computed just now`,
    };
  };
}

/**
 * 7c686059: like verifyLocalBytesInvariant, but for a check run OUT OF BAND
 * of any `runCmd` (bundle members never get their own `soxe install` call —
 * they resolve as a side effect of `soxe install <bundle-id>`). Synthesizes a
 * log/summary entry the same shape `runCmd` produces so the JSON report and
 * `summary.failed` gate this exactly like a real step.
 */
function recordLocalBytesCheck(testId, extId, extType) {
  const result = verifyLocalBytesInvariant(extId)({ exitCode: 0, stderr: '' });
  const passed = result.ok === true;
  log.push({
    test_id: testId, extension_id: extId, extension_type: extType,
    command: '(post-install local-bytes invariant check, 7c686059)',
    exit_code: null, signal: null,
    verdict: result.verdict, verdict_detail: result.detail,
    stdout: '', stderr: '', file_changes: [], duration_ms: 0, passed, error: null,
  });
  passed ? summary.passed++ : summary.failed++;
  return result;
}

/**
 * BL-578 audit finding #2 (distinct from the pass/fail-computation bug fixed in
 * runCmd above): execSync's `input` option ends the child's stdin almost
 * immediately once whatever was written has flushed (and closes it right away
 * when no `input` is given at all, per the proxy-mode call site below). The
 * front-shim's `runFrontShim().done` resolves on that stdin close, so the CLI
 * process was observed exiting in ~90ms -- well before its own fire-and-forget
 * `ensureBackendLive('shim start')` call (never awaited by the shim itself,
 * by design -- it must not block the client pipe) had any realistic chance to
 * finish and write its `[soxe serve] ensure-backend: ...` diagnostic. A
 * correct pass/fail computation over that truncated output can only ever see
 * "no evidence" -- it can never see a genuine pass, even for a perfectly
 * healthy backend. That is still fail-closed and still strictly better than
 * BL-578's silent false pass, but it is not useful as a real smoke test.
 *
 * Fix: spawn the proxy-mode `serve` step ASYNCHRONOUSLY with stdin left open,
 * poll the accumulating stderr for the shim's own evidence line (or a fatal
 * diagnostic) for up to `waitMs`, THEN terminate the child -- instead of
 * closing its input and hoping something async lands in the last event-loop
 * ticks before exit.
 */

async function runServeProxyAndVerify(args, opts) {
  const cwd = opts.cwd || TEST_ROOT;
  const testId = opts.testId;
  const extId = opts.extId;
  const extType = opts.extType;
  const waitSec = opts.waitSec || 15;
  noteSoxeSpawn(args, extId);
  const before = await snapshotFiles(TEST_ROOT);
  const t0 = Date.now();

  // Prefer an external timeout binary to own termination end-to-end (SIGTERM
  // at waitSec, SIGKILL 5s later if ignored); fall back to a raw
  // process.kill(pid, signal) syscall wrapper (proven reliable elsewhere in
  // this file -- see the backend-reap call below) if neither timeout nor
  // gtimeout is on PATH.
  const spawnCmd = TIMEOUT_BIN !== null ? TIMEOUT_BIN : SOXE;
  const spawnArgs = TIMEOUT_BIN !== null
    ? ["--kill-after=5", waitSec + "s", SOXE].concat(args)
    : args;
  const child = spawn(spawnCmd, spawnArgs, {
    cwd: cwd, env: opts.env || smokeEnv(), stdio: ["pipe", "pipe", "pipe"],
  });
  recordSmokePidTree(child.pid, testId);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", function (d) { stdout += d.toString(); });
  child.stderr.on("data", function (d) { stderr += d.toString(); });
  let exited = false;
  let exitCode = null;
  let signal = null;
  const exitPromise = new Promise(function (resolve) {
    child.on("exit", function (code, sig) { exited = true; exitCode = code; signal = sig; resolve(); });
  });

  const evidenceDeadline = Date.now() + waitSec * 1000;
  while (Date.now() < evidenceDeadline && !exited) {
    if (/\[soxe serve\] ensure-backend: /.test(stderr) || /FATAL|EINVAL/.test(stderr)) break;
    // BL-626: keep this timer REF'd. If the serve child exits early, an unref'd
    // timer is the only pending handle, so the event loop drains and the harness
    // dies mid-await — firing the misleading BL-585 "no summary" FATAL instead of
    // recording the real step failure. A ref'd timer lets the loop observe
    // `exited` and record a proper `done — N failed` summary.
    await new Promise(function (r) { setTimeout(r, 150); });
  }
  // d5c01be3: the soxe → backend descendants exist by now; record them before teardown.
  recordSmokePidTree(child.pid, testId);
  if (TIMEOUT_BIN !== null) {
    // TIMEOUT_BIN itself owns termination -- just wait for it to actually exit,
    // bounded so a broken timeout binary can never hang the harness forever.
    await Promise.race([
      exitPromise,
      new Promise(function (r) { const tm = setTimeout(r, (waitSec + 8) * 1000); if (tm.unref) tm.unref(); }),
    ]);
  } else if (!exited) {
    // No timeout/gtimeout on PATH -- terminate via a raw process.kill(pid,
    // signal) syscall wrapper (SIGTERM, then SIGKILL after a grace window).
    try { process.kill(child.pid, "SIGTERM"); } catch (e) { logKillError(e, testId, child.pid, "SIGTERM"); }
    const termDeadline = Date.now() + 5000;
    while (Date.now() < termDeadline && !exited) {
      await new Promise(function (r) { const tm = setTimeout(r, 100); if (tm.unref) tm.unref(); });
    }
    if (!exited) {
      try { process.kill(child.pid, "SIGKILL"); } catch (e) { logKillError(e, testId, child.pid, "SIGKILL"); }
      await Promise.race([
        exitPromise,
        new Promise(function (r) { const tm = setTimeout(r, 2000); if (tm.unref) tm.unref(); }),
      ]);
    }
  }

  const spawnedPidMatch = stderr.match(/spawned backend pid (\d+)/);
  if (spawnedPidMatch) {
    const backendPid = Number(spawnedPidMatch[1]);
    recordSmokePidTree(backendPid, testId);
    try {
      process.kill(backendPid, "SIGTERM");
    } catch (e) { logKillError(e, testId, backendPid, "SIGTERM (backend)"); }
  }
  // 97e7f214/26121495: the embedding host the backend spawned is detached; stop it here.
  // The memory-server backend is known to embed, so the leg must attribute a host.
  const embedReap = await reapSmokeEmbedHosts(testId, { requireObserved: extId === 'memory-server' });

  const after = await snapshotFiles(TEST_ROOT);
  const fileChanges = diffSnapshots(before, after);

  let result;
  try {
    result = verifyProxyServe({ stdout: stdout, stderr: stderr });
  } catch (verr) {
    result = { ok: false, verdict: "verify-threw", detail: "verify() threw: " + ((verr && verr.message) || verr) };
  }
  if (result && result.ok === true && !embedReap.ok) {
    result = { ok: false, verdict: "embed-host-teardown", detail: embedReap.detail };
  }
  const passed = result != null && result.ok === true;
  const verdict = passed ? "verified" : ((result && result.verdict) || "unverified");
  const verdictDetail = (result && result.detail) || "";

  const entry = {
    test_id: testId, extension_id: extId, extension_type: extType,
    command: (TIMEOUT_BIN !== null ? (TIMEOUT_BIN + " --kill-after=5 " + waitSec + "s ") : "") + SOXE + " " + args.join(" "),
    exit_code: exitCode, signal: signal, verdict: verdict, verdict_detail: verdictDetail,
    stdout: (stdout || "").slice(-2000), stderr: (stderr || "").slice(-2000),
    file_changes: (fileChanges || []).slice(0, 50), duration_ms: Date.now() - t0, passed: passed, error: null,
  };
  log.push(entry);
  passed ? summary.passed++ : summary.failed++;
  return { stdout: stdout, stderr: stderr, exitCode: exitCode, signal: signal };
}

// ──────────────────────────────────────────────────────────────────────────────
// Manifest-driven test combinator
// ──────────────────────────────────────────────────────────────────────────────

function hostsFromManifest(m) { return Array.isArray(m.install) ? m.install : []; }
function hasBackground(m) { return m.lifecycle?.background === true; }
function serveModes(m) { return m.lifecycle?.serve_mode === 'proxy' ? ['proxy', 'no-proxy'] : ['no-proxy']; }
function scopesFromManifest(m) { return ['project']; }
// -- BL-578: positive-evidence verifiers for serve and service status --
//
// These replace the removed isServe blanket pass: each returns
// { ok, verdict, detail } built from ACTUALLY OBSERVED output, not from the
// mere absence of a thrown error.

function verifyProxyServe(args) {
  const stdout = args.stdout;
  const stderr = args.stderr;
  const combined = stdout + String.fromCharCode(10) + stderr;
  const m = combined.match(/\[soxe serve\] ensure-backend: (\S+) [-\u2014] (.*)/);
  if (!m) {
    return {
      ok: false,
      verdict: "no-ensure-backend-evidence",
      detail: "no ensure-backend line observed in captured stdout/stderr before the harness stopped the process -- cannot prove a backend ever came up (this is the exact BL-578 gap)",
    };
  }
  const disposition = m[1];
  const detail = m[2];
  if (disposition === "failed") {
    return { ok: false, verdict: "backend-ensure-failed", detail: detail };
  }
  if (["spawned", "already-live", "adopted-after-wait"].indexOf(disposition) === -1) {
    return { ok: false, verdict: "unrecognized-disposition", detail: "disposition=" + disposition + ": " + detail };
  }
  if (/FATAL|EINVAL/.test(combined)) {
    return {
      ok: false,
      verdict: "fatal-diagnostic-present",
      detail: "disposition line said " + disposition + " but a FATAL/EINVAL diagnostic is also present: " + combined.slice(-500),
    };
  }
  return { ok: true, verdict: "verified", detail: "backend disposition: " + disposition + " (" + detail + ")" };
}

function verifyDirectServe(args) {
  const stdout = args.stdout;
  if (!stdout || stdout.trim().length === 0) {
    return {
      ok: false,
      verdict: "no-stdout",
      detail: "no stdout captured before the harness stopped the process -- the initialize request produced no observable response",
    };
  }
  const lines = stdout.split(String.fromCharCode(10));
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    let msg;
    try { msg = JSON.parse(t); } catch (e) { continue; }
    if (msg && typeof msg === "object" && msg.id === 1 && (msg.result !== undefined || msg.error !== undefined)) {
      return { ok: true, verdict: "verified", detail: "initialize request answered on stdout" };
    }
  }
  return {
    ok: false,
    verdict: "no-initialize-response",
    detail: "stdout did not contain a JSON-RPC response to the initialize request (id:1): " + stdout.slice(0, 300),
  };
}

// BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001: for the memory-server, the
// serve step follows initialize with a memory_write (to create the store) and a
// memory_ping, then asserts the store-concurrency contract on the ping surface:
// `ping.store.wal_mode === 'multiprocess-wal'` (turso default, ADR-0012), plus
// `wal_mode_verified === true`; presence-only when STORE_ADAPTER=sqlite.
//
// Review item #2: the WAL-mode assertions above prove the store this process
// opened is CONFIGURED for the right concurrency mode, but never prove it is
// the SCRATCH store (SMOKE_DB_PATH) rather than the fake-home DEFAULT_DB_PATH
// (`~/.memory/memory.db`, i.e. `<fake-home>/.memory/memory.db` under
// MEMORY_FAKE_HOME) — a broken `config set db_path` thread-through would fall
// back to that default and still report a plausible wal_mode block. Assert
// three independent facts instead of trusting the happy path:
//   1. `store.path` (the server's OWN resolved path, index.ts's
//      `storeBlock.path = resolvedPath`) equals SMOKE_DB_PATH exactly.
//   2. The scratch store file (or a WAL/SHM/TSHM sidecar sharing its stem —
//      WAL mode can land a write in `-wal`/`-tshm` without touching the main
//      file) shows up as created/modified in this leg's fileChanges diff.
//   3. The fake-home DEFAULT_DB_PATH (`<fake-home>/.memory/memory.db` —
//      `memory-smoke.db` vs `memory.db`, deliberately distinct stems so this
//      check can never alias) was NOT created — the one file a broken
//      db_path thread-through would produce instead.
function verifyMemoryServerPing(args) {
  const base = verifyDirectServe(args);
  if (!base.ok) return base;

  const fileChanges = args.fileChanges || [];
  const smokeDbRel = path.relative(TEST_ROOT, SMOKE_DB_PATH);
  const smokeDbStem = smokeDbRel.replace(/\.db$/, '');
  const defaultDbPath = path.join(MEMORY_FAKE_HOME, '.memory', 'memory.db');
  const defaultDbRel = path.relative(TEST_ROOT, defaultDbPath);

  const scratchStoreTouched = fileChanges.some(
    (c) => c.path === smokeDbRel || c.path.startsWith(smokeDbStem + '-') || c.path.startsWith(smokeDbStem + '.'),
  );
  const defaultStoreCreated = fileChanges.some(
    (c) => c.op === 'created' && (c.path === defaultDbRel || c.path.startsWith(defaultDbRel + '-') || c.path.startsWith(defaultDbRel + '.')),
  );

  const lines = args.stdout.split(String.fromCharCode(10));
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let msg;
    try { msg = JSON.parse(t); } catch { continue; }
    if (msg && typeof msg === "object" && msg.id === 3 && msg.result) {
      const text = msg.result.content && msg.result.content[0] && msg.result.content[0].text;
      if (!text) {
        return { ok: false, verdict: "ping-no-content", detail: "memory_ping tools/call (id:3) returned no text content" };
      }
      let ping;
      try { ping = JSON.parse(text); } catch {
        return { ok: false, verdict: "ping-unparseable", detail: "memory_ping text is not JSON: " + text.slice(0, 200) };
      }
      const store = ping.store;
      if (!store || typeof store !== "object") {
        return { ok: false, verdict: "ping-no-store", detail: "memory_ping store block is null/absent: " + text.slice(0, 200) };
      }

      // ── Review item #2: the store served is SMOKE_DB_PATH, not the default ──
      if (store.path !== SMOKE_DB_PATH) {
        return {
          ok: false,
          verdict: "ping-wrong-store-path",
          detail: "store.path=" + store.path + ", expected SMOKE_DB_PATH=" + SMOKE_DB_PATH +
            " — db_path never threaded through the resolved config cascade",
        };
      }
      if (!scratchStoreTouched) {
        return {
          ok: false,
          verdict: "ping-scratch-store-not-written",
          detail: "no file under " + smokeDbStem + "(.db|-wal|-shm|-tshm) appears in this leg's fileChanges: " +
            JSON.stringify(fileChanges.slice(0, 20)),
        };
      }
      if (defaultStoreCreated) {
        return {
          ok: false,
          verdict: "ping-default-store-created",
          detail: "fake-home DEFAULT_DB_PATH (" + defaultDbRel + ") was created this leg — db_path fell back " +
            "to the default instead of SMOKE_DB_PATH",
        };
      }

      const walMode = store.wal_mode;
      if (process.env.STORE_ADAPTER === "sqlite") {
        // Presence-only on the sqlite arm: no -tshm coordinator to verify, so
        // the field just has to exist (it reads 'single-writer').
        if (walMode === undefined || walMode === null) {
          return { ok: false, verdict: "ping-wal-mode-absent", detail: "store.wal_mode absent (STORE_ADAPTER=sqlite)" };
        }
        return { ok: true, verdict: "verified", detail: "store.path=" + store.path + ", store.wal_mode=" + walMode + " (presence-only, STORE_ADAPTER=sqlite)" };
      }
      if (walMode !== "multiprocess-wal") {
        return { ok: false, verdict: "ping-wrong-wal-mode", detail: "store.wal_mode=" + walMode + ", expected multiprocess-wal" };
      }
      if (store.wal_mode_verified !== true) {
        return { ok: false, verdict: "ping-wal-unverified", detail: "store.wal_mode_verified=" + store.wal_mode_verified + ", expected true" };
      }
      return { ok: true, verdict: "verified", detail: "store.path=" + store.path + ", store.wal_mode=multiprocess-wal, wal_mode_verified=true" };
    }
  }
  return { ok: false, verdict: "ping-no-response", detail: "no memory_ping tools/call (id:3) response observed on stdout" };
}

/**
 * Reap `soxe serve --no-proxy`'s whole process-group tree — the grandchild
 * memory-server process it execs (apps/sox/src/main.ts's wantLog spawn path)
 * gets no SIGTERM forwarding, unlike the proxy shim's own SIGHUP/SIGTERM
 * handler, so signalling only `child.pid` orphans it. `child` is spawned
 * `detached: true` (its call site below) so `pgid === child.pid`; every
 * non-detached descendant it forks inherits that same group.
 *
 * Liveness is probed with `pgrep -g <pgid>` (exit 1 / empty stdout = group
 * gone), never `process.kill(pgid, 0)` — that probe form returned `EPERM`
 * against a group this process's own child leads, which is not a "does it
 * exist" answer libuv gives a consistent meaning to across platforms; pgrep
 * reports group membership directly. The wait loops below intentionally use
 * `setTimeout` WITHOUT `.unref()` — an unref'd timer does not keep the event
 * loop alive, so if `soxe` (child.pid) has already exited and its streams
 * closed, Node can drain and exit mid-teardown while this async function is
 * still suspended on the timer, abandoning the kill sequence silently (BL-585
 * completion sentinel then fires as a false "run did not complete", measured
 * directly while developing this function).
 */
async function killProcessGroup(pgid, testId) {
  const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
  const groupAlive = () => {
    try {
      execSync(`pgrep -g ${pgid}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      return true;
    } catch (e) {
      if (e && e.status === 1) return false; // pgrep: no matches — group is gone
      console.error(`[smoke] WARNING: ${testId} pgrep -g ${pgid} failed: ${(e && e.message) ?? e}`);
      return true; // unknown — assume alive so we don't stop retrying early
    }
  };
  const signalGroup = (sig) => {
    try {
      process.kill(-pgid, sig);
    } catch (e) {
      // ESRCH: group already gone — expected steady state at teardown's end.
      if (!e || e.code !== 'ESRCH') console.error(`[smoke] WARNING: ${testId} ${sig} to process group ${pgid} failed: ${(e && e.message) ?? e}`);
    }
  };

  if (!groupAlive()) return;
  // d5c01be3: record every group member before it is torn down.
  recordSmokePgroup(pgid, testId);
  signalGroup('SIGTERM');
  const termDeadline = Date.now() + 5000;
  while (Date.now() < termDeadline && groupAlive()) {
    await wait(100);
  }
  if (groupAlive()) {
    signalGroup('SIGKILL');
    const killDeadline = Date.now() + 5000;
    while (Date.now() < killDeadline && groupAlive()) {
      await wait(100);
    }
  }
}

/**
 * Orphan proof for the no-proxy leg (dispatch-2026-09-24-7743 item 3): list
 * every live process whose command line OR environment mentions TEST_ROOT.
 * `ps -axEww` prints the environment block after the command, which is how a
 * memory-server grandchild is findable at all — its own argv is just
 * `node --enable-source-maps <dist>/index.js`, with no TEST_ROOT in it; the
 * TEST_ROOT signal lives in its env (SOX_ECOSYSTEM_HOME / HOME, set by
 * memoryServerEnv()/smokeEnv()). Filtering happens in JS, not by piping
 * through `rg`/`grep`, so the filter process's own argv can never self-match.
 */
function listTestRootProcesses() {
  let raw = '';
  try {
    // Default execSync maxBuffer (1 MiB) is too small for `-E` (full
    // per-process environment blocks) across a normal process table — it
    // failed with ENOBUFS in practice, which the catch below then silently
    // turned into an empty (and wrong) "no orphans" result. 64 MiB is far
    // more than a real process table needs.
    raw = execSync('ps -axEww -o pid,ppid,pgid,command', { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    console.error(`[smoke] WARNING: ps -axEww failed: ${(e && e.message) ?? e}`);
    return null; // unknown, not "zero" — callers must not read this as proof of nothing
  }
  // 26121495: a child's SOX_ECOSYSTEM_HOME is SMOKE_SHORT_ROOT, which is not a
  // substring of TEST_ROOT — tag on every smoke root.
  const lines = raw.split('\n').filter((line) => SMOKE_ROOTS.some((r) => line.includes(r)));
  // d5c01be3: every TEST_ROOT-tagged process (argv `--root TEST_ROOT` or env) is
  // smoke-spawned — including supervisor/OS-unit daemons runCmd never sees a pid for.
  for (const root of SMOKE_ROOTS) {
    for (const pid of pidsFromPsLines(lines, root, process.pid)) SMOKE_SPAWNED_PIDS.add(pid);
  }
  return lines;
}

/** `ps` capture for the embedding-host audit; null (unknown, never "none") on failure. */
function psEmbedHosts(testId) {
  try {
    return execSync(`ps ${EMBED_PS_ARGS.join(' ')}`, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    console.error(`[smoke] WARNING: ${testId} embed-host ps capture failed: ${(e && e.message) ?? e}`);
    return null;
  }
}

function embedAuditCtx() {
  return { smokeRoots: SMOKE_ROOTS, spawnedPids: SMOKE_SPAWNED_PIDS, runStartedMs: RUN_STARTED_MS };
}

function recordEmbedBreaches(testId, violations, procs) {
  for (const v of violations) {
    const p = procs.find((x) => x.pid === v.pid);
    const line = `${testId}: ${p ? describeHost(p) : `pid=${v.pid}`} — ${v.reasons.join('; ')}`;
    if (!EMBED_ISOLATION_BREACHES.includes(line)) EMBED_ISOLATION_BREACHES.push(line);
    console.error(`[smoke] EMBED ISOLATION BREACH (26121495) ${line}`);
  }
}

/**
 * 26121495: audit-only pass (no signals) — records every smoke-owned embedding
 * host that escaped containment. Called after every soxe step so a host is seen
 * while it is still inside its idle window.
 */
function auditSmokeEmbedHosts(testId) {
  const raw = psEmbedHosts(testId);
  if (raw === null) {
    EMBED_ISOLATION_BREACHES.push(`${testId}: embed-host audit UNKNOWN (ps failed)`);
    return;
  }
  const procs = parsePsLines(raw, Date.now());
  const audit = auditEmbedHosts(procs, embedAuditCtx());
  recordEmbedBreaches(testId, audit.violations, audit.smoke);
}

/**
 * 97e7f214 + 26121495: audit, then verified-stop every embedding host this run
 * owns (SIGTERM → poll → SIGKILL → re-verify, spec §8.3), re-scanning once for a
 * host spawned during teardown. The host is detached into its own process group
 * (ADR-0022), so the soxe group kill in the caller can never reach it. Foreign
 * hosts (production, other sessions) are reported and never signalled.
 *
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
async function reapSmokeEmbedHosts(testId, opts = {}) {
  const r = await auditAndReapEmbedHosts(embedAuditCtx(), {
    ps: () => psEmbedHosts(testId),
    now: () => Date.now(),
    kill: (pid, sig) => process.kill(pid, sig),
    // Ref'd timer: see killProcessGroup() for why an unref'd wait can let the loop drain.
    sleep: (ms) => new Promise((res) => { setTimeout(res, ms); }),
    log: (msg) => console.error(`[smoke] WARNING: ${testId} embed-host reap: ${msg}`),
  });
  recordEmbedBreaches(testId, r.violations, r.smoke);
  for (const pid of r.undead) EMBED_UNDEAD.add(pid);
  for (const p of r.smoke) SMOKE_SPAWNED_PIDS.add(p.pid);
  console.error(`[smoke] ${testId} embed-host reap (97e7f214): smoke-owned ${r.smoke.length} ` +
    `[${r.smoke.map((p) => `${p.pid}:${p.kind}`).join(', ')}], stopped ${r.stopped.length}, undead ${r.undead.length}, ` +
    `violations ${r.violations.length}, foreign (untouched) ${r.foreign.length}`);
  for (const p of r.smoke) EMBED_ATTRIBUTED.add(p.pid);
  // requireObserved: a leg known to embed must attribute >=1 host, else fail closed.
  const verdict = embedGateVerdict(r, { requireObserved: opts.requireObserved === true });
  if (!verdict.ok) console.error(`[smoke] FAIL: ${testId} embed-host gate: ${verdict.problems.join(' || ')}`);
  return { ok: verdict.ok, detail: verdict.problems.join(' || '), attributed: r.smoke.length };
}

// BL-635: the no-proxy memory-server leg used to send initialize + memory_write
// + memory_ping as one static stdin blob to execSync (runCmd). On a genuinely
// FRESH scratch store (SMOKE_DB_PATH is a new path every run) that races
// openDb(): memory_ping's liveness check refuses to open/create a store it
// did not itself request (by design — a liveness probe must not have the
// side effect of creating a store) and can observe "store file does not
// exist yet" if it runs before memory_write's own store-open lands, because
// the two tools/call requests are dispatched concurrently, not queued
// strictly behind one another. Fix: spawn interactively, wait for the
// memory_write response (id:2) — which guarantees the store file now
// exists — before writing the memory_ping request (id:3) to stdin.
async function runMemoryServerDirectServeAndVerify(args, opts) {
  const cwd = opts.cwd || TEST_ROOT;
  const testId = opts.testId;
  const extId = opts.extId;
  const extType = opts.extType;
  const env = opts.env || smokeEnv();
  const timeoutMs = opts.timeoutMs || 30_000;
  noteSoxeSpawn(args, extId);
  const before = await snapshotFiles(TEST_ROOT);
  const t0 = Date.now();

  // `detached: true` makes `child.pid` the leader of a NEW process group, so
  // its non-detached grandchild (the actual memory-server process `soxe`
  // execs) inherits that same group — see killProcessGroup() above for the
  // teardown side of this and why the wait loops there must not use unref'd
  // timers.
  let spawnError = null;
  const child = spawn(SOXE, args, { cwd: cwd, env: env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  recordSmokePidTree(child.pid, testId);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", function (d) { stdout += d.toString(); });
  child.stderr.on("data", function (d) { stderr += d.toString(); });
  // An EPIPE on a write past process exit surfaces as an async 'error' event
  // on the stream, not a thrown exception the surrounding try/catch below can
  // see — an unhandled one crashes the whole harness (AGENTS.md: never leave
  // an error path untraced).
  child.stdin.on("error", function (err) {
    console.error(`[smoke] WARNING: ${testId} child.stdin error (likely EPIPE after early exit): ${(err && err.message) ?? err}`);
  });
  let exited = false;
  let exitCode = null;
  let signal = null;
  child.on("exit", function (code, sig) { exited = true; exitCode = code; signal = sig; });
  child.on("error", function (err) {
    // AGENTS.md: never use an empty/silent catch. A spawn error (e.g. ENOENT
    // on SOXE) must be traced AND carried into this leg's result entry
    // instead of being swallowed as a bare `exited = true`.
    exited = true;
    spawnError = err;
    console.error(`[smoke] WARNING: ${testId} child process error: ${(err && err.message) ?? err}`);
  });

  const initPayload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } }) + "\n";
  // A constant content string dedups (content_hash) against a prior leg's
  // write to the same store family, so "the store changed" would silently
  // fail to prove anything on a re-run that reused a stem. Keep the write
  // unique per invocation.
  const writeContent = `smoke-test store-init probe ${testId} ${Date.now()}`;
  const memoryWritePayload = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_write", arguments: { content: writeContent, project_path: TEST_ROOT } } }) + "\n";
  const memoryPingPayload = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_ping", arguments: {} } }) + "\n";

  try {
    child.stdin.write(initPayload + memoryWritePayload);
  } catch (e) {
    // Synchronous write-after-end (rare; the common EPIPE case lands on the
    // 'error' listener above) — trace it, don't swallow it.
    console.error(`[smoke] WARNING: ${testId} stdin write (init+write) threw: ${(e && e.message) ?? e}`);
  }

  // These wait loops intentionally do NOT unref their timers — see the
  // killProcessGroup() doc comment for why an unref'd timer here can let
  // Node drain and exit mid-await once `soxe`'s own streams close.
  const writeDeadline = Date.now() + timeoutMs;
  while (Date.now() < writeDeadline && !exited && !/"id":\s*2[,}]/.test(stdout)) {
    await new Promise(function (r) { setTimeout(r, 100); });
  }
  if (!exited) {
    try {
      child.stdin.write(memoryPingPayload);
    } catch (e) {
      console.error(`[smoke] WARNING: ${testId} stdin write (ping) threw (process may have exited between the check and this write): ${(e && e.message) ?? e}`);
    }
  }

  const pingDeadline = Date.now() + 10_000;
  while (Date.now() < pingDeadline && !exited && !/"id":\s*3[,}]/.test(stdout)) {
    await new Promise(function (r) { setTimeout(r, 100); });
  }

  // Orphan proof (dispatch-2026-09-24-7743 item 3), captured around the same
  // teardown this leg exercises live: snapshot every TEST_ROOT-tagged process
  // just before signalling, and again after. A non-empty "before" is what
  // makes an empty "after" mean something — see listTestRootProcesses().
  const testRootProcsBefore = listTestRootProcesses();

  // Teardown: always run the group-kill sequence, not just `if (!exited)` —
  // `soxe` itself can exit (stdin.end() closing its stdio) while the
  // grandchild memory-server process it spawned keeps running, which is
  // exactly how a plain `!exited`-gated kill would orphan it.
  try { child.stdin.end(); } catch (e) { console.error(`[smoke] WARNING: ${testId} stdin.end() threw: ${(e && e.message) ?? e}`); }
  if (typeof child.pid === "number") {
    await killProcessGroup(child.pid, testId);
  }
  const exitWaitDeadline = Date.now() + 5000;
  while (Date.now() < exitWaitDeadline && !exited) {
    await new Promise(function (r) { setTimeout(r, 50); });
  }
  // 97e7f214: the embedding host is its own process-group leader (ADR-0022), so
  // the group kill above never reaches it — verified-stop it explicitly.
  // This leg writes a memory (embeds), so it must attribute >=1 host (26121495).
  const embedReap = await reapSmokeEmbedHosts(testId, { requireObserved: true });

  const testRootProcsAfter = listTestRootProcesses();
  let orphanProblem = null;
  if (testRootProcsAfter === null || testRootProcsBefore === null) {
    console.error(`[smoke] WARNING: ${testId} orphan proof UNKNOWN — ps capture failed at least once, see the ps WARNING above`);
    orphanProblem = "orphan proof unknown: ps capture failed";
  } else {
    if (testRootProcsAfter.length > 0) {
      console.error(`[smoke] FAIL: ${testId} smoke-tagged process(es) survived teardown (97e7f214): ${JSON.stringify(testRootProcsAfter)}`);
      orphanProblem = `${testRootProcsAfter.length} smoke-tagged process(es) survived teardown`;
    }
    console.error(`[smoke] ${testId} orphan proof — before teardown: ${testRootProcsBefore.length} TEST_ROOT process(es); after: ${testRootProcsAfter.length}`);
  }

  const after = await snapshotFiles(TEST_ROOT);
  const fileChanges = diffSnapshots(before, after);

  let result;
  try {
    result = verifyMemoryServerPing({ stdout: stdout, stderr: stderr, exitCode: exitCode, signal: signal, fileChanges: fileChanges });
  } catch (verr) {
    result = { ok: false, verdict: "verify-threw", detail: "verify() threw: " + ((verr && verr.message) || verr) };
  }
  if (result && result.ok === true && (!embedReap.ok || orphanProblem !== null)) {
    result = { ok: false, verdict: "teardown-leak", detail: [embedReap.detail, orphanProblem].filter(Boolean).join(" || ") };
  }
  const passed = result != null && result.ok === true;
  const verdict = passed ? "verified" : ((result && result.verdict) || "unverified");
  const verdictDetail = (result && result.detail) || "";

  const entry = {
    test_id: testId, extension_id: extId, extension_type: extType,
    command: SOXE + " " + args.join(" ") + " (interactive write-then-ping)",
    exit_code: exitCode, signal: signal, verdict: verdict, verdict_detail: verdictDetail,
    stdout: (stdout || "").slice(-2000), stderr: (stderr || "").slice(-2000),
    file_changes: (fileChanges || []).slice(0, 50), duration_ms: Date.now() - t0, passed: passed,
    error: spawnError ? spawnError.message : null,
    orphan_proof: { test_root_procs_before: testRootProcsBefore, test_root_procs_after: testRootProcsAfter },
  };
  log.push(entry);
  passed ? summary.passed++ : summary.failed++;
  return { stdout: stdout, stderr: stderr, exitCode: exitCode, signal: signal };
}

function verifyServiceRunning(args) {
  const stdout = args.stdout;
  const loadedYes = /^\s*loaded:\s*yes\s*$/m.test(stdout);
  const livePidsMatch = stdout.match(/^\s*live pids:\s*(.*)$/m);
  // d5c01be3: `soxe service enable` daemons are launched by the supervisor / OS
  // unit, never by this harness's spawn() — their pids come only from here.
  for (const pid of pidsFromServiceStatus(stdout)) {
    SMOKE_SERVICE_PIDS.add(pid);
    recordSmokePidTree(pid, 'service-status');
  }
  const hasLivePid = livePidsMatch !== undefined && livePidsMatch !== null
    && livePidsMatch[1].trim() !== "(none)" && livePidsMatch[1].trim() !== "";
  if (!loadedYes || !hasLivePid) {
    return {
      ok: false,
      verdict: "not-actually-running",
      detail: "expected loaded: yes and a non-empty live pids: (the inv:list-never-lies reality check) after service enable; got: " + stdout.slice(0, 500),
    };
  }
  return { ok: true, verdict: "verified", detail: "loaded=yes, live pids=" + livePidsMatch[1].trim() };
}


async function testExtension(ext) {
  const { id, type, dir, manifest: m } = ext;
  const isBundleMember = dir.includes('/members/');
  const hosts = hostsFromManifest(m);
  const scopes = scopesFromManifest(m);
  const isBackground = hasBackground(m);
  const modes = type === 'mcp-server' ? serveModes(m) : [];
  // 26121495: EVERY memory-server leg — install, upgrade, service
  // enable/status/disable, config, serve, uninstall — runs with the scratch
  // $HOME. The service daemon embeds on warmup, and before this it ran under
  // smokeEnv()'s operator $HOME: its embedding host resolved the operator's
  // model cache (~/.cache/sox/models) and a socket under the shared
  // /tmp/sox-<uid> fallback. undefined → smokeEnv().
  const legEnv = id === 'memory-server' ? memoryServerEnv() : undefined;

  // ── Install (standalone only) ───────────────────────────────────
  if (!isBundleMember) {
    for (const scope of scopes) {
      await runCmd(['install', id, '--scope', scope, '--root', TEST_ROOT], { testId: `${id}-${scope}-install`, extId: id, extType: type, env: legEnv, verify: verifyLocalBytesInvariant(id) });
      await runCmd(['upgrade', '--all', '--scope', scope, '--root', TEST_ROOT], { timeoutMs: 60_000, testId: `${id}-${scope}-upgrade`, extId: id, extType: type, env: legEnv });
    }
  }

  // ── Host-based install (mcp-server / skill) ─────────────────────
  for (const host of hosts) {
    for (const scope of scopes) {
      await runCmd(['install', id, `--host=${host}`, '--scope', scope, '--root', TEST_ROOT], { testId: `${id}-${host}-${scope}-install`, extId: id, extType: type, env: legEnv, verify: verifyLocalBytesInvariant(id) });
    }
  }

  // ── Service lifecycle (background: true) ───────────────────────
  if (isBackground) {
    for (const scope of scopes) {
      await runCmd(['service', 'enable', id, '--allow-volatile-node', '--scope', scope, '--root', TEST_ROOT], { timeoutMs: 60_000, testId: `${id}-${scope}-enable`, extId: id, extType: type, env: legEnv });
      await runCmd(['service', 'status', id, '--scope', scope, '--root', TEST_ROOT], { testId: `${id}-${scope}-status`, extId: id, extType: type, env: legEnv, verify: verifyServiceRunning });
      await runCmd(['service', 'disable', id, '--scope', scope, '--root', TEST_ROOT], { timeoutMs: 30_000, testId: `${id}-${scope}-disable`, extId: id, extType: type, env: legEnv });
    }
  }

  // ── MCP serve modes ────────────────────────────────────────────
  const initPayload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } }) + '\n';
  // BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001 / BL-635: for the
  // memory-server, the serve step asserts the store-concurrency contract on
  // the live process's ping surface (ping.store.wal_mode) — see
  // runMemoryServerDirectServeAndVerify. Other mcp-servers keep the bare
  // initialize probe.
  const isMemoryServer = id === 'memory-server';
  const memoryEnv = legEnv;

  if (isMemoryServer) {
    // BL-635: point db_path at the scratch store through the extension's OWN
    // documented config key (config_schema.db_path, extension.json) rather
    // than ambient SOX_CONFIG_DB_PATH — memory-server declares a
    // `permissions` block, so `soxe serve` always scrubs SOX_CONFIG_* from
    // the ambient env for it ([def:policy-env] / env-policy.ts's deny-list,
    // by design: SOX_CONFIG_* is host-authoritative). `soxe config set`
    // writes to the project-scope config.json that cmdServe's own
    // buildExtConfigEnv() reads and re-applies AFTER the scrub, so the
    // resulting SOX_CONFIG_DB_PATH survives — the same path a real deployed
    // install takes.
    await runCmd(
      ['config', 'set', id, 'db_path', SMOKE_DB_PATH, '--scope', 'project', '--root', TEST_ROOT, '--no-restart'],
      { testId: `${id}-config-set-db-path`, extId: id, extType: type, env: memoryEnv },
    );
  }

  for (const mode of modes) {
    const args = ['serve', id];
    if (mode === 'no-proxy') args.push('--no-proxy');
    for (const scope of scopes) {
      args.push('--scope', scope, '--root', TEST_ROOT);
    }
    if (mode === 'proxy') {
      // BL-578 audit finding #2: execSync-with-no-stdin exits the shim before
      // its fire-and-forget ensure() can ever be observed -- use the async
      // spawn+poll+kill helper so the step genuinely waits for evidence.
      await runServeProxyAndVerify(args, { testId: `${id}-serve-${mode}`, extId: id, extType: type, env: memoryEnv });
    } else if (isMemoryServer) {
      await runMemoryServerDirectServeAndVerify(args, { timeoutMs: 30_000, testId: `${id}-serve-${mode}`, extId: id, extType: type, env: memoryEnv });
    } else {
      await runCmd(args, { timeoutMs: 30_000, testId: `${id}-serve-${mode}`, extId: id, extType: type, env: legEnv, stdinInput: initPayload, verify: verifyDirectServe });
    }
  }

  // ── Uninstall (standalone only) ────────────────────────────────
  if (!isBundleMember) {
    for (const scope of scopes) {
      await runCmd(['uninstall', id, '--scope', scope, '--root', TEST_ROOT], { testId: `${id}-${scope}-uninstall`, extId: id, extType: type, env: legEnv });
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Discovery
// ──────────────────────────────────────────────────────────────────────────────

// Unfiltered: every extension.json-bearing dir under extensions/{services,bundles}
// (INCLUDING non-service/mcp-server members like a bundle's skill members) — the
// raw universe BL-407's preflight-scoping needs to find bundle SIBLINGS of a
// filtered target, not just the filtered target itself.
async function scanAllExtensionDirs() {
  const exts = [];

  const scan = async (baseDir) => {
    try {
      for (const entry of await fsp.readdir(baseDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const full = path.join(baseDir, entry.name);
        try {
          const raw = await fsp.readFile(path.join(full, 'extension.json'), 'utf-8');
          const m = JSON.parse(raw);
          if (m.id && m.type) exts.push({ id: m.id, type: m.type, dir: full, manifest: m });
        } catch (err) {
          // A malformed extension.json is a real manifest defect, not a skip.
          console.error(`[smoke] WARNING: unreadable extension.json at ${full} (${(err && err.message) ?? err})`);
        }
        try { await scan(path.join(full, 'members')); } catch (err) {
          console.error(`[smoke] WARNING: scanning members of ${full} failed (${(err && err.message) ?? err})`);
        }
      }
    } catch (err) {
      console.error(`[smoke] WARNING: scanning ${baseDir} failed (${(err && err.message) ?? err})`);
    }
  };

  for (const typeDir of ['services', 'bundles']) {
    await scan(path.join(WORKSPACE, 'extensions', typeDir));
  }
  return exts;
}

async function discoverExtensions(allExts) {
  const seen = new Set();
  return allExts.filter(e => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    if (EXTENSION_FILTER && e.id !== EXTENSION_FILTER) return false;
    return e.type === 'service' || e.type === 'mcp-server';
  });
}

// ── BL-407: scope the exports-contract preflight to what --extension actually
//    exercises, instead of the whole workspace ─────────────────────────────────
//
// Without this, `node scripts/smoke-test.mjs --extension memory-server` — the
// "Single extension fast pass" CLAUDE.md documents as supported — is NOT
// isolated: the BL-266 preflight (see below) ran `--root WORKSPACE`
// unconditionally, so a broken package.json anywhere in the other 40 projects
// FATALs a run that never touches it. In a shared, non-worktree checkout with
// concurrent agents, that is the normal condition, not an edge case — it means
// any agent's in-flight `workspace:*` edit can wedge every other agent's
// ability to run even a scoped smoke pass (observed live: PKT-15/BL-259 was
// blocked by an unrelated agent's uncommitted memory-flush→store-adapter edit).
//
// Scope = the filtered extension's dir, PLUS (if it is a bundle member) the
// bundle root and every sibling member — `soxe install <bundle>` installs the
// WHOLE bundle whenever any one member is targeted, so siblings are genuinely
// in the filtered run's blast radius, not just nx-graph neighbors — PLUS the
// transitive closure of `workspace:*` dependencies from the nx project graph
// (a broken package two hops away must not silently escape the gate).
//
// Returns `null` to mean "unfiltered / full workspace scope" — the caller must
// treat null as "run the ORIGINAL unrestricted preflight", never as "check
// nothing". A `--skip-preflight` escape hatch is deliberately NOT provided
// (see docs/spec discussion in BL-407): scoping must be correct, not optional.
function computePreflightOnlyDirs(allExts) {
  if (!EXTENSION_FILTER) return null;

  const target = allExts.find((e) => e.id === EXTENSION_FILTER);
  if (!target) return null; // unknown --extension id — fail SAFE to full scope

  const membersSeg = `${path.sep}members${path.sep}`;
  const seedDirs = new Set([target.dir]);
  if (target.dir.includes(membersSeg)) {
    const bundleDir = target.dir.slice(0, target.dir.indexOf(membersSeg));
    seedDirs.add(bundleDir);
    for (const e of allExts) {
      if (e.dir.startsWith(bundleDir + membersSeg)) seedDirs.add(e.dir);
    }
  }

  // Resolve each seed dir's nx project name (from project.json — the bundle
  // root may not have one; that's fine, it just doesn't contribute graph edges).
  const seedNames = new Set();
  for (const d of seedDirs) {
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(d, 'project.json'), 'utf-8'));
      if (pj.name) seedNames.add(pj.name);
    } catch { /* no project.json at this dir — nx-graph expansion skips it */ }
  }

  let graph;
  try {
    const graphFile = path.join(TEST_ROOT, '.nx-graph-preflight.json');
    execSync(`npx nx graph --file=${JSON.stringify(graphFile)}`, {
      cwd: WORKSPACE, stdio: ['ignore', 'ignore', 'inherit'],
    });
    graph = JSON.parse(fs.readFileSync(graphFile, 'utf-8')).graph;
  } catch (e) {
    console.error(`[smoke] WARNING: nx graph unavailable for BL-407 preflight scoping (${e.message}); falling back to the full workspace scope`);
    return null;
  }

  const seenNames = new Set(seedNames);
  const stack = [...seedNames];
  while (stack.length > 0) {
    const n = stack.pop();
    for (const edge of graph.dependencies[n] ?? []) {
      if (!seenNames.has(edge.target)) { seenNames.add(edge.target); stack.push(edge.target); }
    }
  }

  const dirs = new Set(seedDirs);
  for (const name of seenNames) {
    const root = graph.nodes[name]?.data?.root;
    if (root) dirs.add(path.join(WORKSPACE, root));
  }
  return [...dirs].sort();
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  RUN_STARTED_MS = Date.now();
  console.error(`[smoke] root: ${TEST_ROOT}`);
  await fsp.mkdir(TEST_ROOT, { recursive: true });

  // ── BL-173: create scratch data root and verify isolation ──────────────────
  await fsp.mkdir(SMOKE_DATA_ROOT, { recursive: true });
  // 26121495: short alias (see SMOKE_SHORT_ROOT) + the run-owned cache/tmp dirs.
  await fsp.symlink(SMOKE_DATA_ROOT, SMOKE_SHORT_ROOT, 'dir');
  await fsp.mkdir(SMOKE_TMPDIR, { recursive: true });
  await fsp.mkdir(SMOKE_XDG_CACHE_HOME, { recursive: true });
  console.error(`[smoke] SOX_ECOSYSTEM_HOME (scratch) → ${SMOKE_SHORT_ROOT} → ${SMOKE_DATA_ROOT}`);
  console.error(`[smoke] XDG_CACHE_HOME (scratch) → ${SMOKE_XDG_CACHE_HOME}; TMPDIR (scratch) → ${SMOKE_TMPDIR}`);
  console.error(`[smoke] db_path (config set, scratch) → ${SMOKE_DB_PATH}`);

  // Assert: scratch root is NOT the real user data root.
  if (SMOKE_DATA_ROOT === LIVE_DATA_ROOT) {
    console.error('[smoke] FATAL: scratch data root resolved to real user data root — aborting');
    process.exit(2);
  }

  // d5c01be3 (c): the live BEFORE snapshot is NOT taken here. The preflight
  // below (nx graph, build-index, publint/attw — ~86 s) spawns no soxe, so a
  // snapshot here only widens the window in which an unrelated operator write
  // reads as a smoke leak. noteSoxeSpawn() takes it at the first soxe spawn.

  await fsp.writeFile(path.join(TEST_ROOT, 'package.json'), JSON.stringify({ name: 'smoke', private: true }));

  // 7c686059-021d-4fc9-9c3f-e17a59b61b4f: the committed registry/index.json
  // pins several ids (memory-server, memory-cli, memory-flush, memory-usage,
  // sox, sox-memory-bundle) to `npm-package:` locators — install.ts's REAL
  // behavior for one of those is a genuine `npm install` of the PUBLISHED
  // tarball (libs/install-engine/src/install.ts fetchArtifact, ~472-484).
  // Symlinking the committed file straight into TEST_ROOT (the prior
  // behavior here) meant this pre-merge gate exercised npm-published bytes
  // for those ids on EVERY run, never this worktree's own rebuilt dist/ — a
  // local regression in one of those dists could ship past a fully green
  // smoke run. Generate a DERIVED, disposable registry instead: every row
  // forced to a `file://` locator inside THIS checkout, with checksums
  // freshly computed from local disk via `scripts/build-index.ts --local-sources`
  // (the same resolver install.ts's checksum gate verifies against — never
  // duplicated here). The release/npm-bytes leg stays the release flow's job;
  // see PUBLISHING.md.
  const tr = path.join(TEST_ROOT, 'registry', 'index.json');
  await fsp.mkdir(path.dirname(tr), { recursive: true });
  try {
    await fsp.unlink(tr);
  } catch (e) {
    // ENOENT (nothing there yet, the common case on a fresh TEST_ROOT) is
    // fine to swallow silently. Anything else (permissions, a directory
    // sitting at `tr`, ...) is a real condition the next step would fail on
    // anyway with a far more confusing error — surface it now.
    if (!e || e.code !== 'ENOENT') {
      console.error(`[smoke] WARNING: could not remove stale ${tr} before regenerating it: ${(e && e.message) ?? e}`);
    }
  }
  const committedRegistry = JSON.parse(
    await fsp.readFile(path.join(WORKSPACE, 'registry', 'index.json'), 'utf-8'),
  );
  const committedNpmPackageIds = new Set(
    committedRegistry
      .filter((r) => typeof r.source === 'string' && r.source.startsWith('npm-package:'))
      .map((r) => r.id),
  );
  const tsxCli = require.resolve('tsx/cli');
  execSync(
    `${JSON.stringify(process.execPath)} ${JSON.stringify(tsxCli)} ` +
      `${JSON.stringify(path.join(WORKSPACE, 'scripts', 'build-index.ts'))} ` +
      `${JSON.stringify(WORKSPACE)} --local-sources --out ${JSON.stringify(tr)}`,
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  const localRegistry = JSON.parse(await fsp.readFile(tr, 'utf-8'));
  localRegistryEntries = new Map(localRegistry.map((r) => [r.id, r]));
  const rewrittenIds = localRegistry
    .filter((r) => committedNpmPackageIds.has(r.id))
    .map((r) => r.id);
  console.error(
    `[smoke] test-root registry (7c686059): ${localRegistry.length} entries generated locally from ` +
      `${WORKSPACE}; ${rewrittenIds.length} row(s) rewritten from npm-package: to file:// — ` +
      `${rewrittenIds.join(', ') || '(none)'}`,
  );

  const allExtensions = await scanAllExtensionDirs();
  const extensions = await discoverExtensions(allExtensions);

  // ── BL-407 preflight scope — computed BEFORE the BL-192 gate so the gate
  //    itself is scoped the same way the preflight is: a filtered run only
  //    requires artifacts for its own BL-407 closure, an unfiltered run walks
  //    the full workspace package universe. computePreflightOnlyDirs returns
  //    null (no nx graph, no scoping) when no --extension filter is set.
  const onlyDirs = computePreflightOnlyDirs(allExtensions);
  if (EXTENSION_FILTER) {
    console.error(onlyDirs
      ? `[smoke] preflight scoped (BL-407) to --extension ${EXTENSION_FILTER}: ${onlyDirs.length} package(s) — ${onlyDirs.map((d) => path.relative(WORKSPACE, d)).join(', ')}`
      : `[smoke] preflight NOT scoped — running full workspace scope even though --extension ${EXTENSION_FILTER} was passed (see warning above)`);
  }

  // ── BL-192 preflight: refuse to run against an unbuilt workspace ────────────
  // A dist-less checkout (fresh worktree) makes install/enable legs fail with
  // "no entrypoint" — a TRUE statement about the environment that reads like a
  // product bug (exactly how BL-192 got mis-filed). Fail fast and say why.
  const missingArtifacts = [];
  const cliMain = path.join(WORKSPACE, 'dist', 'apps', 'sox', 'main.js');
  if (!fs.existsSync(cliMain)) missingArtifacts.push(cliMain);
  for (const e of extensions) {
    if (typeof e.manifest.entrypoint === 'string') {
      const ep = path.join(e.dir, e.manifest.entrypoint);
      if (!fs.existsSync(ep)) missingArtifacts.push(ep);
    }
  }
  // BL-192 gap fix: the BL-266 exports-contract preflight below checks every
  // workspace package's main/module/types/bin/exports paths. A partial build
  // (e.g. `nx affected:build`, which structurally skips zero-dependency
  // packages like @adhd/sox-nx, @adhd/sox-baseline-capture,
  // @adhd/sox-source-provider) sails past the cliMain/entrypoint checks above
  // and detonates inside publint with cryptic "file does not exist". Walk the
  // same contract paths up front so ANY unbuilt package aborts with the clear
  // Build-first FATAL before the preflight runs. Gate scope = the BL-407
  // closure for filtered runs, the full workspace universe otherwise.
  const gateDirs = onlyDirs ?? workspacePackageDirs(WORKSPACE);
  for (const dir of gateDirs) {
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')); } catch { continue; }
    if (!pkg.name || pkg.name === 'sox-ecosystem') continue;
    for (const p of contractArtifactPaths(dir, pkg)) {
      if (!fs.existsSync(p)) missingArtifacts.push(p);
    }
  }
  if (missingArtifacts.length > 0) {
    console.error('[smoke] FATAL: workspace is not built — missing compiled artifacts:');
    for (const p of missingArtifacts) console.error(`[smoke]   - ${p}`);
    console.error('[smoke] Build first (e.g. `npx nx run-many -t build`), then re-run.');
    console.error('[smoke] Running unbuilt produces "no entrypoint" enable/serve failures that masquerade as product bugs (BL-192).');
    console.error('[smoke] If you already ran a full build and these are still missing, this is a package.json/build-target mismatch — run node tools/verify-exports-publint-attw.mjs for the real contract error.');
    process.exit(2);
  }

  // ── Exports-contract preflight (BL-266): publint + attw against every
  //    workspace package.json/dist pair. Rides the mandatory smoke gate so a
  //    build-layout change that breaks the contract (the 0ba5d78 @nx/js:tsc
  //    nesting incident — cache-masked for hours) fails loudly pre-merge
  //    instead of detonating on the next cache bust. Supersedes the former
  //    tools/verify-package-exports.mjs (deleted) — publint proved a strict
  //    superset of its file-existence check (main/module/types/bin/exports),
  //    plus packaging-correctness checks it never had; attw adds the
  //    type/runtime-format resolution check verify-package-exports.mjs never
  //    performed at all. See docs/standards/extension-bundling.md.
  //
  //    BL-407: when --extension narrows the run, the preflight is narrowed too
  //    (see computePreflightOnlyDirs) — a `--only <dir>` per in-scope package,
  //    computed from the filtered extension + its bundle siblings + its
  //    transitive nx workspace dependencies. Unfiltered runs are UNCHANGED:
  //    still the full, unrestricted `--root WORKSPACE` merge-gate scope.
  const onlyArgs = onlyDirs ? onlyDirs.flatMap((d) => ['--only', d]) : [];
  try {
    execSync(
      `node ${JSON.stringify(path.join(WORKSPACE, 'tools', 'verify-exports-publint-attw.mjs'))} --root ${JSON.stringify(WORKSPACE)} ${onlyArgs.map((a) => JSON.stringify(a)).join(' ')}`,
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
  } catch {
    console.error('[smoke] FATAL: package exports contract violated — see verify-exports-publint-attw output above.');
    console.error(EXTENSION_FILTER
      ? `[smoke] this WAS scoped to --extension ${EXTENSION_FILTER} (BL-407) — the offending package(s) named above are in that extension's own dependency closure, not an unrelated project.`
      : '[smoke] this was an UNFILTERED (full-workspace) run — pass --extension <id> to check whether the failure is actually in scope for the change you are testing.');
    process.exit(2);
  }

  // Install bundles that contain service/mcp-server members
  const bundleIds = new Set();
  if (extensions.some(e => e.dir.includes('/members/'))) {
    const installed = new Set();
    for (const e of extensions) {
      if (!e.dir.includes('/members/')) continue;
      const bid = e.dir.split('/members/')[0].split('/').pop();
      if (!installed.has(bid)) {
        installed.add(bid);
        console.error(`[smoke] installing bundle ${bid}`);

        // 7c686059: a BUNDLE id never gets its own `resolved[bid]` lockfile
        // entry — only its expanded MEMBERS do (verified empirically: a
        // naive `verifyLocalBytesInvariant(bid)` here reads
        // `lockfile-entry-missing`, and the entry's own `detail` lists
        // exactly the member ids as the only keys present). So the bundle
        // install's own `verify` only asserts it exited 0; the actual
        // local-bytes invariant is checked per MEMBER below, out of band,
        // right after — `testExtension`'s own install loop only runs for
        // `mcp-server`/`service` types, so a bundle's command/hook/skill
        // members (memory-cli/memory-flush/memory-usage) never get an
        // individual `soxe install` call of their own; they resolve purely
        // as a side effect of the bundle install here.
        const memberIds = allExtensions
          .filter((e) => e.dir.includes('/members/') && e.dir.split('/members/')[0].split('/').pop() === bid)
          .map((e) => ({ id: e.id, type: e.type }));
        // d5c01be3: a bundle install writes its MEMBERS' entries (ledger/ownership/
        // lockfile) — those ids are smoke-touched even though no spawn names them.
        for (const m of memberIds) SMOKE_TOUCHED_IDS.add(m.id);
        const bundleInstallResult = await runCmd(['install', bid, '--scope=project', '--root', TEST_ROOT], {
          timeoutMs: 60_000, testId: `bundle-${bid}-install`, extId: bid, extType: 'bundle',
          verify: ({ exitCode, stderr } = {}) => (exitCode === 0
            ? { ok: true, verdict: 'verified', detail: `bundle install exited 0 (${memberIds.length} member(s): ${memberIds.map((m) => m.id).join(', ')})` }
            : { ok: false, verdict: 'install-failed', detail: `soxe install ${bid} exited ${exitCode}: ${(stderr || '').slice(-500)}` }),
        });
        await runCmd(['upgrade', '--all', '--scope=project', '--root', TEST_ROOT], { timeoutMs: 60_000, testId: `bundle-${bid}-upgrade`, extId: bid, extType: 'bundle' });

        if (bundleInstallResult.exitCode === 0) {
          for (const member of memberIds) {
            recordLocalBytesCheck(`${member.id}-local-bytes-invariant`, member.id, member.type);
          }
        }
      }
    }
  }

  console.error(`[smoke] ${extensions.length} testable: ${extensions.map(e => e.id).join(', ')}`);
  for (const ext of extensions) {
    console.error(`[smoke] testing ${ext.id} (${ext.type})`);
    try {
      await testExtension(ext);
    } catch (err) {
      // BL-578 audit: an exception thrown mid-testExtension (a bug in the harness
      // itself, or a truly unexpected condition) used to be swallowed to
      // console.error ONLY -- summary.failed was never incremented, so a run that
      // crashed halfway through an extension's steps could still end with
      // `summary.failed === 0` and read as a clean pass. Record it as a hard
      // failure with the full stack, same as any other failed step.
      const msg = (err && err.stack) ? err.stack : String(err);
      console.error(`[smoke] FATAL ${ext.id}:`, msg);
      log.push({
        test_id: `${ext.id}-testExtension-fatal`,
        extension_id: ext.id,
        extension_type: ext.type,
        command: '(testExtension threw before completing all of its steps)',
        exit_code: null,
        signal: null,
        verdict: 'harness-exception',
        verdict_detail: msg.slice(0, 2000),
        stdout: '',
        stderr: '',
        file_changes: [],
        duration_ms: 0,
        passed: false,
        error: msg.slice(0, 500),
      });
      summary.failed++;
    }
  }

  await fsp.mkdir(path.dirname(LOG_PATH), { recursive: true });
  await fsp.writeFile(LOG_PATH, JSON.stringify({ run_id: path.basename(TEST_ROOT), root: TEST_ROOT, tests: log, summary }, null, 2) + '\n');
  console.error(`[smoke] done — ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`);

  // ── BL-173: post-run isolation assertions ──────────────────────────────────
  let isolationFailed = false;

  // 1. d5c01be3: attribute every live data-root change (see scripts/lib/isolation-guard.mjs).
  //    (c′) This runs only after every extension's teardown/uninstall step has
  //    completed (testExtension ends with them) — nothing the harness spawned is
  //    still expected to write. If no soxe was ever spawned there is no baseline
  //    and nothing the run did could have written the live root; the harness-
  //    telemetry leak check below still runs over the whole run.
  const isolationAfter = snapshotLiveFiles(LIVE_DATA_ROOT);
  const isolationBefore = isolationBaseline ?? { ...isolationAfter, takenAtMs: RUN_STARTED_MS };
  console.error('[smoke] live fingerprint AFTER:',
    JSON.stringify(Object.fromEntries(Object.entries(isolationAfter.files).map(([k, v]) => [k, v.sha256 ?? 'ABSENT']))));
  const liveWindow = { sinceMs: isolationBefore.takenAtMs - DEFAULT_OPERATOR_SLACK_MS, untilMs: isolationAfter.takenAtMs };
  const liveLogs = readTelemetryEvents(soxCliLogDirs(LIVE_DATA_ROOT), liveWindow);
  const liveOtherLogs = readTelemetryEvents(otherServiceLogDirs(LIVE_DATA_ROOT), liveWindow);
  const scratchLogs = readTelemetryEvents(telemetryLogDirs(SMOKE_DATA_ROOT), {
    sinceMs: RUN_STARTED_MS, untilMs: isolationAfter.takenAtMs,
  });
  console.error(`[smoke] isolation telemetry: live sox ${liveLogs.events.length} event(s) from ${liveLogs.filesRead.length} file(s)` +
    ` (${liveLogs.parseErrors} unparseable line(s)); live other-service ${liveOtherLogs.events.length} relevant event(s) from ${liveOtherLogs.filesRead.length} file(s)` +
    ` (${liveOtherLogs.parseErrors} unparseable line(s)); scratch ${scratchLogs.events.length} event(s) from ${scratchLogs.filesRead.length} file(s)` +
    ` (${scratchLogs.parseErrors} unparseable line(s)); smoke-touched ids: ${[...SMOKE_TOUCHED_IDS].sort().join(', ') || '(none)'}; smoke-spawned pids recorded: ${SMOKE_SPAWNED_PIDS.size} (service-status daemon pids: ${SMOKE_SERVICE_PIDS.size})`);
  const isolation = evaluateIsolation({
    before: isolationBefore,
    after: isolationAfter,
    liveEvents: liveLogs.events,
    liveOtherEvents: liveOtherLogs.events,
    scratchEvents: scratchLogs.events,
    smokeTouchedIds: SMOKE_TOUCHED_IDS,
    smokePids: SMOKE_SPAWNED_PIDS,
  });
  for (const line of isolation.lines) console.error(`[smoke] ${line}`);
  if (isolation.verdict === 'fatal') isolationFailed = true;

  // 1b. 26121495 / 97e7f214: final embedding-host sweep. Every smoke-owned host
  // must have been contained (HOME, model cache and socket inside the run) and
  // none may outlive the run.
  let embedIsolationFailed = false;
  const finalEmbed = await reapSmokeEmbedHosts('final-sweep');
  if (EMBED_ISOLATION_BREACHES.length > 0) {
    console.error(`[smoke] FATAL: ${EMBED_ISOLATION_BREACHES.length} embedding-host isolation breach(es) (26121495): a smoke-owned ` +
      `embedding host ran with the operator HOME, model cache or a socket outside the run:\n  ${EMBED_ISOLATION_BREACHES.join('\n  ')}`);
    embedIsolationFailed = true;
  } else if (EMBED_UNDEAD.size > 0 || !finalEmbed.ok) {
    console.error(`[smoke] FATAL: smoke embedding host(s) outlived the run (97e7f214): ${[...EMBED_UNDEAD].join(', ')} ${finalEmbed.detail}`);
    embedIsolationFailed = true;
  } else {
    console.error(`[smoke] embedding-host isolation OK — ${EMBED_ATTRIBUTED.size} smoke-owned embedding process(es) attributed ` +
      `[${[...EMBED_ATTRIBUTED].join(', ')}]; all contained in the run and verified-stopped`);
  }

  // 2. Assert no sockets appeared under the REAL (live) socket dir during the run.
  try {
    const realSocketEntries = await fsp.readdir(REAL_SOCKET_DIR);
    const smokeSockets = realSocketEntries.filter(e => e.startsWith('proxy-'));
    // It's possible the live production backend has a pre-existing socket; we only
    // care that the COUNT did not increase (i.e. smoke did not create new ones).
    // We cannot distinguish pre-existing from new without a pre-run snapshot, so
    // check the scratch socket dir instead: it MUST exist after any serve test.
    console.error(`[smoke] real socket dir entries: ${realSocketEntries.length} (pre-existing production sockets are expected)`);
  } catch {
    // Real socket dir doesn't exist — perfect (no live sockets bound there).
    console.error('[smoke] real socket dir absent — no live sockets (isolation confirmed)');
  }

  // 3. Verify scratch data root received the runtime dirs (evidence of redirection).
  const scratchRunDir = path.join(SMOKE_DATA_ROOT, 'run');
  try {
    await fsp.access(scratchRunDir);
    console.error(`[smoke] scratch run dir exists: ${scratchRunDir} (socket redirection confirmed)`);
  } catch {
    // run/ only appears when serve/service is exercised — not a hard failure if no
    // serve tests ran (e.g. --extension filter for a non-serve extension).
    console.error(`[smoke] scratch run dir absent (no serve tests or serve tests failed pre-bind)`);
  }

  if (isolationFailed) {
    console.error('[smoke] FATAL: live data-root was mutated (or harness telemetry reached it) and the change is not attributable to a concurrent operator invocation — BL-173 isolation breach (d5c01be3 attribution above)');
    runCompleted = true;
    process.exit(2);
  }

  if (embedIsolationFailed) {
    console.error('[smoke] FATAL: embedding-host isolation breach (26121495/97e7f214 — see the embedding-host FATAL above)');
    runCompleted = true;
    process.exit(2);
  }

  runCompleted = true;
  process.exit(summary.failed > 0 ? 1 : 0);
}

/**
 * (BL-585) A COMPLETION SENTINEL, because "exit 0" is not proof this harness ran.
 *
 * BL-578 made each STEP fail closed. It did not make the RUN fail closed: if the
 * harness process dies mid-run — killed, OOM, an unhandled rejection, or the
 * agent-sandbox hazard where terminating a child that owns a detached grandchild
 * takes the invoking shell with it — the caller can observe a clean exit 0 with
 * no summary ever written. Measured 2026-08-18: a full run stopped after
 * `testing memory-server` and the shell reported EXIT=0, with no log.json and no
 * `[smoke] done` line. A gate whose own death reads as success is the exact
 * defect BL-578 existed to remove, one level up.
 *
 * `main()` calls `process.exit()` on every path, so this handler fires with an
 * explicit code on any real completion. If `completed` was never set, the run
 * was truncated: say so loudly and force a non-zero code so no caller can read
 * a partial run as a pass. A SIGKILL bypasses this entirely — nothing in-process
 * can cover that — but then the caller sees a signal rather than 0.
 */
process.on('exit', (code) => {
  // 26121495: the short SOX_ECOSYSTEM_HOME alias lives in /tmp — remove it on
  // every exit path (the data it points at stays under TEST_ROOT).
  try {
    fs.unlinkSync(SMOKE_SHORT_ROOT);
  } catch (e) {
    if (!e || e.code !== 'ENOENT') console.error(`[smoke] WARNING: removing ${SMOKE_SHORT_ROOT} failed: ${(e && e.message) ?? e}`);
  }
  if (runCompleted) return;
  // `console.error` is sync on a pipe at exit; `process.exitCode` is the only
  // mutation still honoured inside an 'exit' handler.
  console.error(
    '[smoke] FATAL: run did not complete — no summary was produced. ' +
      'This is NOT a pass. The harness exited before finishing, so no step verdict is trustworthy.',
  );
  if (code === 0) process.exitCode = 2;
});

process.on('unhandledRejection', (err) => {
  console.error(`[smoke] FATAL: unhandled rejection — ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(2);
});

main();
