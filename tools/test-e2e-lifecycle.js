#!/usr/bin/env node
/**
 * tools/test-e2e-lifecycle.js — End-to-end sox lifecycle test.
 *
 * Tests the COMPLETE install→start→use→disable→uninstall→stop lifecycle
 * using a throwaway temp directory. Never touches ~/.sox, ~/.memory, or .tmp-* dirs.
 *
 * Steps:
 *   1. sox install memory-server -s project (into temp scope)
 *   2. sox start -s project → memory-server process spawned, runtime record written
 *   3. Use memory_write + memory_recall via sox exec (through the runtime record)
 *   4. sox list → shows memory-server as RUNNING
 *   5. sox disable memory-server → process is STOPPED
 *   6. sox uninstall memory-server → removed from lockfile
 *   7. sox stop -s project → cleans up; runtime record updated
 *
 * Exit: 0 if all assertions pass, 1 if any fail.
 * Cleanup: temp dir always removed (even on failure) via process.on('exit').
 */

import { spawnSync, execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOX_BIN = path.join(ROOT, 'bin', 'sox');
const NODE = process.execPath;

// ─── Temp dir (throwaway, not in .tmp-* which are reserved for other tools) ───

const TMP_DIR = path.join(os.tmpdir(), `sox-e2e-${process.pid}-${Date.now()}`);
const EXTENSIONS_DIR = path.join(TMP_DIR, '.extensions');
const RUNTIME_FILE = path.join(EXTENSIONS_DIR, 'runtime.json');

// [process-boundary.exec] C6 enforcement: DB_PATH must be INSIDE the declared allowlist
// (memory-server declares fs.{read,write}: ["~/.memory/**"]) so the positive write succeeds
// under enforcement. Previously DB_PATH was under TMP_DIR which is OUTSIDE the allowlist —
// that write only succeeded because exec enforcement was absent (the C6 hole). Now that
// enforcement is in place the allowed path must be within ~/.memory/**.
// We use a pid-scoped name to avoid collisions with concurrent tests. Teardown deletes it.
const DB_PATH = path.join(os.homedir(), '.memory', `sox-e2e-${process.pid}.db`);

// Negative (evil) path: clearly outside the allowlist. Used to prove exec enforcement.
// Must NOT exist after a denied memory_write call ([dod.2] through the real exec path).
const EVIL_DB_PATH = path.join(os.tmpdir(), `sox-e2e-evil-${process.pid}.db`);

// Custom config with ONLY memory-server
const CUSTOM_CONFIG = {
  install: [
    { id: 'memory-server', version: '^0.1.0' }
  ],
  config: {
    'memory-server': { db_path: DB_PATH }
  }
};

const CONFIG_PATH = path.join(EXTENSIONS_DIR, 'extensions.json');
const LOCKFILE_PATH = path.join(EXTENSIONS_DIR, 'extensions.lock');

// ─── Reality check: the actual OS process table (NOT the runtime record) ──────
// The record can claim running:false while the supervisor has restarted the child
// under a new pid. The only trustworthy check is the process table itself.

/** Set of live pids whose command line includes the memory-server MCP entrypoint. */
function liveServerPids() {
  try {
    const out = execFileSync('pgrep', ['-f', 'memory-server/dist/index.js'], { encoding: 'utf8' });
    return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean).map(Number));
  } catch {
    return new Set(); // pgrep exits non-zero when there are no matches
  }
}

/** Server pids that belong to THIS test = current live pids minus the pre-test baseline. */
function leakedServerPids() {
  const out = [];
  for (const pid of liveServerPids()) if (!BASELINE_PIDS.has(pid)) out.push(pid);
  return out;
}

// Captured at import (before the test spawns anything) so we ignore unrelated servers.
const BASELINE_PIDS = liveServerPids();

// ─── Cleanup ──────────────────────────────────────────────────────────────────

let cleanedUp = false;
/** @type {import('node:child_process').ChildProcess|null} */
let startProcess = null;

function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;

  // Kill any running extension processes found in runtime record
  try {
    if (fs.existsSync(RUNTIME_FILE)) {
      const record = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
      if (Array.isArray(record?.entries)) {
        for (const entry of record.entries) {
          if (entry.running && entry.pid != null) {
            try {
              process.kill(entry.pid, 'SIGKILL');
            } catch { /* already gone */ }
          }
        }
      }
    }
  } catch { /* ignore */ }

  // Kill start process if still alive
  if (startProcess && startProcess.exitCode === null) {
    try { startProcess.kill('SIGKILL'); } catch { /* ignore */ }
  }

  // Backstop: kill any server this test leaked (new pids not in the baseline).
  for (const pid of leakedServerPids()) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }

  // Remove temp dir
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch { /* ignore */ }

  // Remove the allowed DB we wrote into ~/.memory (pid-scoped; no other test entry polluted)
  try {
    if (fs.existsSync(DB_PATH)) fs.rmSync(DB_PATH, { force: true });
  } catch { /* ignore */ }

  // Remove the evil DB if it somehow got created (should not exist — denial means no file)
  try {
    if (fs.existsSync(EVIL_DB_PATH)) fs.rmSync(EVIL_DB_PATH, { force: true });
  } catch { /* ignore */ }
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

// ─── Assertions ───────────────────────────────────────────────────────────────

let assertionsFailed = 0;
let assertionsPassed = 0;

/**
 * @param {boolean} cond
 * @param {string} msg
 */
function assert(cond, msg) {
  if (cond) {
    console.log(`  PASS: ${msg}`);
    assertionsPassed++;
  } else {
    console.error(`  FAIL: ${msg}`);
    assertionsFailed++;
  }
}

/**
 * @param {string[]} args
 * @param {{ input?: string; env?: Record<string,string> }} [opts]
 * @returns {{ stdout: string; stderr: string; status: number }}
 */
function runSox(args, opts = {}) {
  const env = {
    ...process.env,
    SOX_RUNTIME_FILE: RUNTIME_FILE,
    ...(opts.env ?? {}),
  };

  const result = spawnSync(NODE, [SOX_BIN, ...args], {
    cwd: ROOT,
    env,
    input: opts.input,
    encoding: 'utf8',
    timeout: 60000,
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return {
    stdout,
    stderr,
    status: result.status ?? (result.error ? 1 : 0),
  };
}

/**
 * Sleep for a given number of ms.
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for the runtime record to show the extension as running.
 * @param {string} extId
 * @param {number} timeoutMs
 */
async function waitForRunning(extId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(RUNTIME_FILE)) {
      try {
        const record = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
        if (Array.isArray(record?.entries)) {
          const entry = record.entries.find(
            (/** @type {any} */ e) => e.id === extId || e.key === extId
          );
          if (entry?.running) return true;
        }
      } catch { /* retry */ }
    }
    await sleep(200);
  }
  return false;
}

// ─── Main test ────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== sox e2e lifecycle test ===');
  console.log(`TMP_DIR: ${TMP_DIR}`);
  console.log('');

  // ── Setup: create temp dir + custom config ────────────────────────────────
  fs.mkdirSync(EXTENSIONS_DIR, { recursive: true });
  // Ensure ~/.memory exists so the allowed DB path is writable (memory-server creates
  // the DB file itself, but the parent dir must exist or openDb/mkdirSync handles it;
  // we create it here to be explicit about the allowed-path precondition).
  fs.mkdirSync(path.join(os.homedir(), '.memory'), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(CUSTOM_CONFIG, null, 2) + '\n', 'utf8');
  console.log('Setup: temp dir + config created');
  console.log(`DB_PATH (allowed, inside ~/.memory/**): ${DB_PATH}`);
  console.log(`EVIL_DB_PATH (denied, outside allowlist): ${EVIL_DB_PATH}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 1: sox install memory-server -s project (into temp scope)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nStep 1: sox install memory-server -s project');

  const installResult = runSox([
    'install',
    'memory-server',
    '-s', 'project',
    `--config=${CONFIG_PATH}`,
    `--lockfile=${LOCKFILE_PATH}`,
  ]);

  if (installResult.status !== 0) {
    console.error('install stdout:', installResult.stdout);
    console.error('install stderr:', installResult.stderr);
  }

  assert(installResult.status === 0, `install exits 0 (got ${installResult.status})`);
  assert(fs.existsSync(LOCKFILE_PATH), 'lockfile created');

  if (fs.existsSync(LOCKFILE_PATH)) {
    const lock = JSON.parse(fs.readFileSync(LOCKFILE_PATH, 'utf8'));
    const resolvedKeys = Object.keys(lock.resolved ?? {});
    const hasMemoryServer = resolvedKeys.some((k) => k.startsWith('memory-server'));
    assert(hasMemoryServer, `lockfile contains memory-server (resolved: ${resolvedKeys.join(', ')})`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 2: sox start -s project → memory-server spawned, runtime record written
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nStep 2: sox start -s project');

  // Run start via the compiled canonical runtime-cli (background child).
  // The test will keep a reference to the child and kill it on cleanup.
  const runtimeCliPath = path.join(ROOT, 'libs', 'host-runtime', 'dist', 'runtime-cli.js');

  startProcess = spawn(process.execPath, [
    runtimeCliPath,
    'start',
    `--scope=project`,
    `--root=${TMP_DIR}`,
    `--lockfile=${LOCKFILE_PATH}`,
    `--config=${CONFIG_PATH}`,
    `--runtime-file=${RUNTIME_FILE}`,
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      SOX_RUNTIME_FILE: RUNTIME_FILE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let startOutput = '';
  startProcess.stdout?.on('data', (/** @type {Buffer} */ d) => {
    const s = d.toString();
    startOutput += s;
    process.stdout.write('[runtime-cli] ' + s);
  });
  startProcess.stderr?.on('data', (/** @type {Buffer} */ d) => {
    process.stderr.write('[runtime-cli:err] ' + d.toString());
  });

  // Wait for runtime record to show memory-server running
  console.log('  Waiting for memory-server to start...');
  const isRunning = await waitForRunning('memory-server', 20000);

  assert(isRunning, 'memory-server is RUNNING in runtime record after sox start');

  if (fs.existsSync(RUNTIME_FILE)) {
    const record = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
    const entry = (record.entries ?? []).find(
      (/** @type {any} */ e) => e.id === 'memory-server'
    );
    if (entry) {
      assert(entry.running === true, 'runtime record entry.running === true');
      assert(typeof entry.pid === 'number' && entry.pid > 0, `runtime record has valid pid (got ${String(entry.pid)})`);
      assert(entry.scope === 'project', `runtime record entry.scope === 'project' (got ${String(entry.scope)})`);
      assert(typeof entry.source === 'string' && entry.source.length > 0, 'runtime record has source');
      console.log(`  memory-server pid: ${String(entry.pid)}, scope: ${entry.scope}`);
    } else {
      assert(false, 'memory-server entry found in runtime record');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 3: Use memory_write + memory_recall via sox exec (through activated runtime)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nStep 3: Use memory_write + memory_recall through activated runtime');

  const writeArgs = JSON.stringify({
    content: 'The sox lifecycle test wrote this memory entry successfully.',
    db_path: DB_PATH,
    importance: 8,
  });

  const writeResult = runSox([
    'exec',
    '-s', 'project',
    `--runtime-file=${RUNTIME_FILE}`,
    `--id=memory-server`,
    `--tool=memory_write`,
    `--args=${writeArgs}`,
  ]);

  if (writeResult.status !== 0) {
    console.error('write stdout:', writeResult.stdout);
    console.error('write stderr:', writeResult.stderr);
  }

  assert(writeResult.status === 0, `memory_write via sox exec exits 0 (got ${writeResult.status})`);

  let episodeUid = null;
  if (writeResult.status === 0) {
    try {
      const writeOutput = JSON.parse(writeResult.stdout.trim());
      const text = writeOutput?.content?.[0]?.text ?? '';
      const parsed = JSON.parse(text);
      episodeUid = parsed?.episode_uid;
      assert(typeof episodeUid === 'string' && episodeUid.length > 0,
        `memory_write returned episode_uid: ${String(episodeUid)}`);
    } catch (e) {
      console.error('Could not parse write output:', writeResult.stdout);
      assert(false, `memory_write output is valid JSON: ${String(e)}`);
    }
  }

  // Now recall
  const recallArgs = JSON.stringify({
    query: 'sox lifecycle test memory entry',
    db_path: DB_PATH,
    limit: 5,
  });

  const recallResult = runSox([
    'exec',
    '-s', 'project',
    `--runtime-file=${RUNTIME_FILE}`,
    `--id=memory-server`,
    `--tool=memory_recall`,
    `--args=${recallArgs}`,
  ]);

  if (recallResult.status !== 0) {
    console.error('recall stdout:', recallResult.stdout);
    console.error('recall stderr:', recallResult.stderr);
  }

  assert(recallResult.status === 0, `memory_recall via sox exec exits 0 (got ${recallResult.status})`);

  if (recallResult.status === 0) {
    try {
      const recallOutput = JSON.parse(recallResult.stdout.trim());
      const text = recallOutput?.content?.[0]?.text ?? '';
      const parsed = JSON.parse(text);
      const results = parsed?.results ?? [];
      assert(results.length > 0, `memory_recall returned ${results.length} result(s)`);
      const foundIt = results.some(
        (/** @type {any} */ r) =>
          typeof r.content === 'string' &&
          r.content.includes('sox lifecycle test')
      );
      assert(foundIt, 'memory_recall result contains the written content');
    } catch (e) {
      console.error('Could not parse recall output:', recallResult.stdout);
      assert(false, `memory_recall output is valid JSON: ${String(e)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 3b: NEGATIVE enforcement test via the REAL sox exec path ([dod.2])
  //
  // [process-boundary.exec] closed the C6 hole: exec now injects policy.toEnv()
  // so the spawned child receives SOX_PERM_ENFORCE + the allowlist. A write to
  // EVIL_DB_PATH (outside ~/.memory/**) MUST:
  //   (a) return isError in the tool result OR cause exec to exit non-zero, AND
  //   (b) NOT create the file on disk.
  //
  // This is the end-to-end reality proof that enforcement flows through the real
  // production exec path (not just the hand-wired _REALITY_DRIVER in audit_c6.py).
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nStep 3b: negative enforcement test — evil db_path MUST be denied via sox exec');

  // Ensure no stale evil file from a previous run.
  try { if (fs.existsSync(EVIL_DB_PATH)) fs.rmSync(EVIL_DB_PATH, { force: true }); } catch { /* ignore */ }

  const evilWriteArgs = JSON.stringify({
    content: 'This write MUST be denied by C6 permission enforcement.',
    db_path: EVIL_DB_PATH,
    importance: 1,
  });

  const evilWriteResult = runSox([
    'exec',
    '-s', 'project',
    `--runtime-file=${RUNTIME_FILE}`,
    `--id=memory-server`,
    `--tool=memory_write`,
    `--args=${evilWriteArgs}`,
  ]);

  // The denied call must signal failure: either a non-zero exit (exec error) OR
  // an isError:true result in the tool output. Both indicate enforcement.
  let evilDenied = false;
  if (evilWriteResult.status !== 0) {
    // exec itself exited non-zero — enforcement at the transport level.
    evilDenied = true;
    console.log(`  [enforcement] sox exec exited ${evilWriteResult.status} (denied at exec level)`);
  } else {
    // exec exited 0 — check whether the tool returned isError:true.
    try {
      const out = JSON.parse(evilWriteResult.stdout.trim());
      if (out?.isError === true) {
        evilDenied = true;
        console.log(`  [enforcement] tool returned isError:true: ${out?.content?.[0]?.text ?? '(no text)'}`);
      } else {
        console.error('  evil write stdout:', evilWriteResult.stdout);
      }
    } catch {
      console.error('  could not parse evil write output:', evilWriteResult.stdout);
    }
  }
  assert(evilDenied,
    `[dod.2] memory_write to evil path denied (exit=${evilWriteResult.status}, stdout=${evilWriteResult.stdout.slice(0, 120)})`);

  // The evil file MUST NOT exist on disk — no side effect from the denied call.
  const evilFileExists = fs.existsSync(EVIL_DB_PATH);
  assert(!evilFileExists,
    `[dod.2] evil db_path NOT created on disk after denied write (file must not exist: ${EVIL_DB_PATH})`);

  if (!evilFileExists) {
    console.log(`  [enforcement] confirmed: ${EVIL_DB_PATH} does NOT exist after denied write`);
  } else {
    console.error(`  [enforcement] FAIL: ${EVIL_DB_PATH} EXISTS after denied write — enforcement hole`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 4: sox list → memory-server shown as RUNNING with scope + source
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nStep 4: sox list');

  const listResult = runSox([
    'list',
    `--runtime-file=${RUNTIME_FILE}`,
    `--root=${TMP_DIR}`,
    '--json',
  ]);

  assert(listResult.status === 0, `sox list exits 0 (got ${listResult.status})`);

  if (listResult.status === 0) {
    try {
      const listOutput = JSON.parse(listResult.stdout.trim());
      assert(Array.isArray(listOutput), 'sox list --json returns an array');
      const memEntry = listOutput.find(
        (/** @type {any} */ e) =>
          (e.id ?? '').startsWith('memory-server') ||
          (e.key ?? '').startsWith('memory-server')
      );
      assert(memEntry != null, 'memory-server appears in sox list output');
      if (memEntry) {
        assert(memEntry.running === true,
          `memory-server is shown as RUNNING (got running=${String(memEntry.running)})`);
        assert(typeof memEntry.source === 'string' && memEntry.source.length > 0,
          'memory-server has source in list output');
        assert(memEntry.scope === 'project',
          `memory-server has scope=project in list (got ${String(memEntry.scope)})`);
        assert(typeof memEntry.pid === 'number' && memEntry.pid > 0,
          `memory-server has pid in list (got ${String(memEntry.pid)})`);
      }
    } catch (e) {
      console.error('Could not parse list output:', listResult.stdout);
      assert(false, `sox list --json is valid JSON: ${String(e)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 5: sox disable memory-server → process is STOPPED
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nStep 5: sox disable memory-server -s project');

  // Get the PID before disable (to verify it's killed after)
  let preDisablePid = null;
  if (fs.existsSync(RUNTIME_FILE)) {
    const record = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
    const entry = (record.entries ?? []).find((/** @type {any} */ e) => e.id === 'memory-server');
    preDisablePid = entry?.pid ?? null;
  }

  const disableResult = runSox([
    'disable',
    'memory-server',
    '-s', 'project',
    `--runtime-file=${RUNTIME_FILE}`,
    `--root=${TMP_DIR}`,
  ]);

  if (disableResult.status !== 0) {
    console.error('disable stdout:', disableResult.stdout);
    console.error('disable stderr:', disableResult.stderr);
  }

  assert(disableResult.status === 0, `sox disable exits 0 (got ${disableResult.status})`);

  // Wait a moment for SIGTERM to take effect
  await sleep(800);

  // Verify process is gone (check runtime record + check pid)
  let pidAliveAfterDisable = false;
  if (preDisablePid !== null) {
    try {
      process.kill(preDisablePid, 0); // 0 = check existence
      pidAliveAfterDisable = true;
    } catch {
      // ESRCH = no such process → good
      pidAliveAfterDisable = false;
    }
  }

  assert(!pidAliveAfterDisable,
    `memory-server process (pid=${String(preDisablePid)}) is STOPPED after disable`);

  // REALITY CHECK: no memory-server process spawned by this test may survive disable —
  // this catches a supervisor restart under a NEW pid (which the old-pid check above misses).
  const leakedAfterDisable = leakedServerPids();
  assert(leakedAfterDisable.length === 0,
    `no memory-server process alive after disable (leaked pids: ${leakedAfterDisable.join(', ') || 'none'})`);

  // Runtime record should show running: false
  if (fs.existsSync(RUNTIME_FILE)) {
    const record = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
    const entry = (record.entries ?? []).find((/** @type {any} */ e) => e.id === 'memory-server');
    if (entry) {
      assert(entry.running === false,
        `runtime record shows running=false after disable (got ${String(entry.running)})`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 5b: sox enable memory-server → process is RE-ACTIVATED (symmetry with disable)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nStep 5b: sox enable memory-server -s project (must re-activate, not just flag)');

  const enableResult = runSox([
    'enable', 'memory-server', '-s', 'project',
    `--runtime-file=${RUNTIME_FILE}`, `--root=${TMP_DIR}`,
  ]);
  if (enableResult.status !== 0) {
    console.error('enable stdout:', enableResult.stdout);
    console.error('enable stderr:', enableResult.stderr);
  }
  assert(enableResult.status === 0, `sox enable exits 0 (got ${enableResult.status})`);

  await sleep(1500); // allow the restart to spawn + pass health

  // REALITY CHECK: enable must bring the process back (not merely set a flag).
  const aliveAfterEnable = leakedServerPids();
  assert(aliveAfterEnable.length >= 1,
    `memory-server RUNNING again after enable (live pids: ${aliveAfterEnable.join(', ') || 'NONE'})`);

  if (fs.existsSync(RUNTIME_FILE)) {
    const record = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
    const entry = (record.entries ?? []).find((/** @type {any} */ e) => e.id === 'memory-server');
    assert(entry?.running === true && entry?.pid != null,
      `runtime record shows running=true+pid after enable (got running=${String(entry?.running)}, pid=${String(entry?.pid)})`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 6: sox uninstall memory-server → removed from lockfile
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nStep 6: sox uninstall memory-server -s project');

  const uninstallResult = runSox([
    'uninstall',
    'memory-server',
    '-s', 'project',
    `--runtime-file=${RUNTIME_FILE}`,
    `--root=${TMP_DIR}`,
    `--lockfile=${LOCKFILE_PATH}`,
  ]);

  if (uninstallResult.status !== 0) {
    console.error('uninstall stdout:', uninstallResult.stdout);
    console.error('uninstall stderr:', uninstallResult.stderr);
  }

  assert(uninstallResult.status === 0, `sox uninstall exits 0 (got ${uninstallResult.status})`);

  // Verify removed from lockfile
  if (fs.existsSync(LOCKFILE_PATH)) {
    const lock = JSON.parse(fs.readFileSync(LOCKFILE_PATH, 'utf8'));
    const keys = Object.keys(lock.resolved ?? {});
    const stillPresent = keys.some((k) => k.startsWith('memory-server'));
    assert(!stillPresent,
      `memory-server removed from lockfile (remaining keys: ${keys.join(', ') || '(empty)'})`);
  } else {
    assert(true, 'lockfile no longer contains memory-server (file removed)');
  }

  // Verify removed from config
  if (fs.existsSync(CONFIG_PATH)) {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const installList = config.install ?? [];
    const stillInConfig = installList.some((/** @type {any} */ e) => e.id === 'memory-server');
    assert(!stillInConfig, 'memory-server removed from config install[]');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 7: sox stop -s project → cleans up
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nStep 7: sox stop -s project');

  const stopResult = runSox([
    'stop',
    '-s', 'project',
    `--runtime-file=${RUNTIME_FILE}`,
    `--root=${TMP_DIR}`,
  ]);

  assert(stopResult.status === 0, `sox stop exits 0 (got ${stopResult.status})`);

  // Kill the start process (supervisor) that's been keeping the runtime alive
  if (startProcess && startProcess.exitCode === null) {
    startProcess.kill('SIGTERM');
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 3000);
      startProcess?.on('exit', () => { clearTimeout(t); resolve(undefined); });
    });
    if (startProcess.exitCode === null) {
      startProcess.kill('SIGKILL');
    }
  }

  // REALITY CHECK (the gate): scan the actual process table, not the runtime record.
  // Assert BEFORE cleanup so a survivor FAILS the test instead of being silently killed.
  await sleep(500);
  const orphans = leakedServerPids();
  assert(orphans.length === 0,
    `no orphan memory-server processes after stop (found: ${orphans.join(', ') || 'none'})`);

  // The supervisor (start) process itself must be gone too.
  const supervisorAlive = !!(startProcess && startProcess.exitCode === null);
  assert(!supervisorAlive, 'supervisor (start) process exited after stop');

  // ═══════════════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log(`Results: ${assertionsPassed} passed, ${assertionsFailed} failed`);
  console.log('═'.repeat(60));

  process.exit(assertionsFailed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
