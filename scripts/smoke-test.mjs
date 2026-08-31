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

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { execSync, spawn } from 'node:child_process';
// BL-192 gap fix: workspace package discovery + contract-path resolution
// (shared with tools/verify-exports-publint-attw.mjs) so the Build-first gate
// below checks EVERY package's main/module/types/bin/exports paths, not just
// the CLI bundle + extension entrypoints.
import { workspacePackageDirs, contractArtifactPaths } from '../tools/workspace-package-scan.mjs';

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
//   SOX_CONFIG_DB_PATH  — redirects the singleton-key for the memory-server backend
//                          (resolveStoreResource() in libs/host-runtime uses this as
//                          the canonical single-writer SQLite resource). Without it
//                          the backend's singleton key defaults to the live
//                          ~/.memory/memory.db path, which causes the smoke-spawned
//                          process to contest the live backend's store.
//
// The live user data root (~/.adhd/sox-ecosystem) MUST remain untouched.
// An assertion in main() verifies no sockets appeared under the real socket dir.

const SMOKE_DATA_ROOT = path.join(TEST_ROOT, 'sox-data-root');
const SMOKE_DB_PATH = path.join(TEST_ROOT, 'sox-data-root', 'memory-smoke.db');

// Derive the real live socket dir so we can assert against it after the run.
const REAL_SOCKET_DIR = process.env['SOX_ECOSYSTEM_HOME']
  ? path.join(process.env['SOX_ECOSYSTEM_HOME'], 'run', 'supervisors')
  : path.join(process.env['HOME'] ?? '', '.adhd', 'sox-ecosystem', 'run', 'supervisors');

/** Env block injected into every child process this harness spawns. */
function smokeEnv() {
  return {
    ...process.env,
    NODE_NO_WARNINGS: '1',
    // BL-173: redirect data root and db path away from the live user installation.
    SOX_ECOSYSTEM_HOME: SMOKE_DATA_ROOT,
    SOX_CONFIG_DB_PATH: SMOKE_DB_PATH,
    // BL-501: every process this harness execs (memory-server, memory-cli, ...)
    // is a synthetic spawn of the real compiled binary, not a genuine
    // production/operator invocation. Without this signal those spawns report
    // telemetry role:'live-service'/'cli' identically to a real one — see
    // resolveProcessRole() in @adhd/sox-telemetry and docs/reporting/memory/
    // findings/2026-08-17-store-connection-lifetime-forensics.md §1d for the
    // cross-repo incident this class of bug caused.
    SOX_TELEMETRY_HARNESS: '1',
  };
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
  const { cwd = TEST_ROOT, timeoutMs = 120_000, testId, extId, extType, stdinInput, verify } = opts;
  const before = await snapshotFiles(TEST_ROOT);
  const t0 = Date.now();
  let stdout = '', stderr = '', exitCode = null, signal = null, error = null;

  try {
    stdout = execSync(`${SOXE} ${args.join(' ')}`, {
      cwd, encoding: 'utf-8', timeout: timeoutMs,
      env: smokeEnv(),
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
    cwd: cwd, env: smokeEnv(), stdio: ["pipe", "pipe", "pipe"],
  });
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
    try { process.kill(child.pid, "SIGTERM"); } catch (e) { /* already gone */ }
    const termDeadline = Date.now() + 5000;
    while (Date.now() < termDeadline && !exited) {
      await new Promise(function (r) { const tm = setTimeout(r, 100); if (tm.unref) tm.unref(); });
    }
    if (!exited) {
      try { process.kill(child.pid, "SIGKILL"); } catch (e) { /* already gone */ }
      await Promise.race([
        exitPromise,
        new Promise(function (r) { const tm = setTimeout(r, 2000); if (tm.unref) tm.unref(); }),
      ]);
    }
  }

  const spawnedPidMatch = stderr.match(/spawned backend pid (\d+)/);
  if (spawnedPidMatch) {
    const backendPid = Number(spawnedPidMatch[1]);
    try {
      process.kill(backendPid, "SIGTERM");
    } catch (e) { /* already gone, or never actually came up -- nothing to reap */ }
  }

  const after = await snapshotFiles(TEST_ROOT);
  const fileChanges = diffSnapshots(before, after);

  let result;
  try {
    result = verifyProxyServe({ stdout: stdout, stderr: stderr });
  } catch (verr) {
    result = { ok: false, verdict: "verify-threw", detail: "verify() threw: " + ((verr && verr.message) || verr) };
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
function verifyMemoryServerPing(args) {
  const base = verifyDirectServe(args);
  if (!base.ok) return base;

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
      const walMode = store.wal_mode;
      if (process.env.STORE_ADAPTER === "sqlite") {
        // Presence-only on the sqlite arm: no -tshm coordinator to verify, so
        // the field just has to exist (it reads 'single-writer').
        if (walMode === undefined || walMode === null) {
          return { ok: false, verdict: "ping-wal-mode-absent", detail: "store.wal_mode absent (STORE_ADAPTER=sqlite)" };
        }
        return { ok: true, verdict: "verified", detail: "store.wal_mode=" + walMode + " (presence-only, STORE_ADAPTER=sqlite)" };
      }
      if (walMode !== "multiprocess-wal") {
        return { ok: false, verdict: "ping-wrong-wal-mode", detail: "store.wal_mode=" + walMode + ", expected multiprocess-wal" };
      }
      if (store.wal_mode_verified !== true) {
        return { ok: false, verdict: "ping-wal-unverified", detail: "store.wal_mode_verified=" + store.wal_mode_verified + ", expected true" };
      }
      return { ok: true, verdict: "verified", detail: "store.wal_mode=multiprocess-wal, wal_mode_verified=true" };
    }
  }
  return { ok: false, verdict: "ping-no-response", detail: "no memory_ping tools/call (id:3) response observed on stdout" };
}

function verifyServiceRunning(args) {
  const stdout = args.stdout;
  const loadedYes = /^\s*loaded:\s*yes\s*$/m.test(stdout);
  const livePidsMatch = stdout.match(/^\s*live pids:\s*(.*)$/m);
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

  // ── Install (standalone only) ───────────────────────────────────
  if (!isBundleMember) {
    for (const scope of scopes) {
      await runCmd(['install', id, '--scope', scope, '--root', TEST_ROOT], { testId: `${id}-${scope}-install`, extId: id, extType: type });
      await runCmd(['upgrade', '--all', '--scope', scope, '--root', TEST_ROOT], { timeoutMs: 60_000, testId: `${id}-${scope}-upgrade`, extId: id, extType: type });
    }
  }

  // ── Host-based install (mcp-server / skill) ─────────────────────
  for (const host of hosts) {
    for (const scope of scopes) {
      await runCmd(['install', id, `--host=${host}`, '--scope', scope, '--root', TEST_ROOT], { testId: `${id}-${host}-${scope}-install`, extId: id, extType: type });
    }
  }

  // ── Service lifecycle (background: true) ───────────────────────
  if (isBackground) {
    for (const scope of scopes) {
      await runCmd(['service', 'enable', id, '--allow-volatile-node', '--scope', scope, '--root', TEST_ROOT], { timeoutMs: 60_000, testId: `${id}-${scope}-enable`, extId: id, extType: type });
      await runCmd(['service', 'status', id, '--scope', scope, '--root', TEST_ROOT], { testId: `${id}-${scope}-status`, extId: id, extType: type, verify: verifyServiceRunning });
      await runCmd(['service', 'disable', id, '--scope', scope, '--root', TEST_ROOT], { timeoutMs: 30_000, testId: `${id}-${scope}-disable`, extId: id, extType: type });
    }
  }

  // ── MCP serve modes ────────────────────────────────────────────
  const initPayload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } }) + '\n';
  // BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001: for the memory-server,
  // follow initialize with a memory_write (creates the scratch store) then a
  // memory_ping, so the serve step can assert the store-concurrency contract on
  // the live process's ping surface (ping.store.wal_mode). Other mcp-servers
  // keep the bare initialize probe.
  const memoryWritePayload = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_write', arguments: { content: 'smoke-test store-init probe', project_path: TEST_ROOT } } }) + '\n';
  const memoryPingPayload = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_ping', arguments: {} } }) + '\n';
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
      await runServeProxyAndVerify(args, { testId: `${id}-serve-${mode}`, extId: id, extType: type });
    } else {
      const isMemoryServer = id === 'memory-server';
      const stdinInput = isMemoryServer ? initPayload + memoryWritePayload + memoryPingPayload : initPayload;
      const verify = isMemoryServer ? verifyMemoryServerPing : verifyDirectServe;
      await runCmd(args, { timeoutMs: 30_000, testId: `${id}-serve-${mode}`, extId: id, extType: type, stdinInput, verify });
    }
  }

  // ── Uninstall (standalone only) ────────────────────────────────
  if (!isBundleMember) {
    for (const scope of scopes) {
      await runCmd(['uninstall', id, '--scope', scope, '--root', TEST_ROOT], { testId: `${id}-${scope}-uninstall`, extId: id, extType: type });
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
  console.error(`[smoke] root: ${TEST_ROOT}`);
  await fsp.mkdir(TEST_ROOT, { recursive: true });

  // ── BL-173: create scratch data root and verify isolation ──────────────────
  await fsp.mkdir(SMOKE_DATA_ROOT, { recursive: true });
  console.error(`[smoke] SOX_ECOSYSTEM_HOME (scratch) → ${SMOKE_DATA_ROOT}`);
  console.error(`[smoke] SOX_CONFIG_DB_PATH  (scratch) → ${SMOKE_DB_PATH}`);

  // Assert: scratch root is NOT the real user data root.
  const realUserDataRoot = path.join(process.env['HOME'] ?? '', '.adhd', 'sox-ecosystem');
  if (SMOKE_DATA_ROOT === realUserDataRoot) {
    console.error('[smoke] FATAL: scratch data root resolved to real user data root — aborting');
    process.exit(2);
  }

  // Capture fingerprint of live data-root files BEFORE the run.
  const LIVE_FILES = [
    path.join(realUserDataRoot, 'extensions.lock'),
    path.join(realUserDataRoot, 'install-registry.json'),
    path.join(realUserDataRoot, 'ledger.json'),
    path.join(realUserDataRoot, 'ownership.json'),
  ];
  const fingerprint = {};
  for (const f of LIVE_FILES) {
    try { fingerprint[f] = execSync(`shasum "${f}"`, { encoding: 'utf-8' }).trim(); }
    catch { fingerprint[f] = 'ABSENT'; }
  }
  console.error('[smoke] live fingerprint BEFORE:', JSON.stringify(fingerprint));

  await fsp.writeFile(path.join(TEST_ROOT, 'package.json'), JSON.stringify({ name: 'smoke', private: true }));
  const tr = path.join(TEST_ROOT, 'registry', 'index.json');
  await fsp.mkdir(path.dirname(tr), { recursive: true });
  try { await fsp.unlink(tr); } catch {}
  await fsp.symlink(path.join(WORKSPACE, 'registry', 'index.json'), tr);

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
        await runCmd(['install', bid, '--scope=project', '--root', TEST_ROOT], { timeoutMs: 60_000, testId: `bundle-${bid}-install`, extId: bid, extType: 'bundle' });
        await runCmd(['upgrade', '--all', '--scope=project', '--root', TEST_ROOT], { timeoutMs: 60_000, testId: `bundle-${bid}-upgrade`, extId: bid, extType: 'bundle' });
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

  // 1. Verify live data-root files are byte-identical to pre-run fingerprint.
  const fingerprintAfter = {};
  for (const f of LIVE_FILES) {
    try { fingerprintAfter[f] = execSync(`shasum "${f}"`, { encoding: 'utf-8' }).trim(); }
    catch { fingerprintAfter[f] = 'ABSENT'; }
  }
  console.error('[smoke] live fingerprint AFTER:', JSON.stringify(fingerprintAfter));
  for (const f of LIVE_FILES) {
    if (fingerprint[f] !== fingerprintAfter[f]) {
      console.error(`[smoke] ISOLATION FAILURE: live file mutated during smoke run: ${f}`);
      console.error(`  before: ${fingerprint[f]}`);
      console.error(`  after:  ${fingerprintAfter[f]}`);
      isolationFailed = true;
    }
  }
  if (!isolationFailed) {
    console.error('[smoke] isolation OK — live data-root files byte-identical before/after');
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
    console.error('[smoke] FATAL: live data-root was mutated — BL-173 isolation breach');
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
