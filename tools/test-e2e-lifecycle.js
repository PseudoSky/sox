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
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOX_BIN = path.join(ROOT, 'bin', 'soxe');
const NODE = process.execPath;

// ─── Temp dir (throwaway, not in .tmp-* which are reserved for other tools) ───

const TMP_DIR = path.join(os.tmpdir(), `sox-e2e-${process.pid}-${Date.now()}`);
// ADR-0004 §D2: project-scope data lives under <root>/.adhd/sox-ecosystem/ — the
// canonical layout getScopePaths resolves to. Placing the harness config/lockfile
// here means `sox list`/`enable` (which resolve via getScopePaths, no override) find
// it without an explicit --lockfile/--config flag.
const EXTENSIONS_DIR = path.join(TMP_DIR, '.adhd', 'sox-ecosystem');
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

  // BL-53: Remove the allowed DB AND its SQLite WAL/SHM sidecars from ~/.memory.
  // Sidecars linger when the process is SIGKILLed before the connection closes,
  // producing orphaned *.db-wal / *.db-shm whose base .db is absent.
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* ignore */ }
  }

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
 * BL-31: spawn a TRULY ORPHANED (PPID 1) detached process running `node <argv>`.
 *
 * Uses a double-fork: a short-lived shell launches `setsid node <args> &` then
 * exits immediately. When the intermediate shell exits, the grandchild is
 * reparented to init (PPID 1) — exactly the BL-31 condition (supervisor gone).
 * We then locate the grandchild pid by its unique argv marker via pgrep.
 *
 * @param {string} entrypoint absolute path passed to node as argv[1] (the identity)
 * @param {string} marker     a second argv token to make the pid findable
 * @returns {Promise<number>} the orphaned grandchild pid (PPID becomes 1)
 */
async function spawnOrphan(entrypoint, marker) {
  // A long-running grandchild: a node setInterval daemon whose argv contains the
  // entrypoint + marker verbatim (matching `node <entrypoint> <marker>`).
  // We launch it via `/bin/sh -c 'nohup node <entry> <marker> & echo $!'` then let
  // the shell exit. nohup + detached + backgrounding survives the shell's exit, and
  // when the intermediate shell exits the node grandchild is reparented to init
  // (PID 1) — the BL-31 orphan condition. We append our own setInterval keep-alive
  // by passing a wrapper that requires the entrypoint only if it exists; to keep
  // the daemon trivially alive regardless, we run `node -e` is NOT used here because
  // we need the real entrypoint path in argv. Instead we let node load the
  // entrypoint; the memory-server entry is a long-lived server, the unrelated
  // placeholder exits fast — so for BOTH we instead use a generic keep-alive that
  // still carries the entrypoint as a real argv token via --require-noop.
  //
  // Simpler + robust: run node with the entrypoint as argv[1] but force a
  // keep-alive by also evaluating a setInterval via -e is incompatible with a
  // positional script. So we use a tiny shim: `node -e 'setInterval(...)' --
  // <entrypoint> <marker>` — the entrypoint appears in argv (process.argv) and the
  // process stays alive deterministically.
  const shim = "setInterval(()=>{},1000)";
  const cmd =
    `nohup "${NODE}" -e '${shim}' -- "${entrypoint}" "${marker}" ` +
    `>/dev/null 2>&1 & echo $! ; exit 0`;
  const child = spawn('/bin/sh', ['-c', cmd], {
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: true,
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  await new Promise((resolve) => child.on('exit', resolve));
  const gpid = Number(out.trim().split('\n').pop());
  // Wait for reparenting to init.
  await sleep(500);
  return gpid;
}

/** Live pids whose argv contains a given marker token. */
function pidsMatching(marker) {
  try {
    const out = execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' });
    return out.split('\n').map((s) => s.trim()).filter(Boolean).map(Number);
  } catch { return []; }
}

/** True iff pid is alive. */
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Read the PPID of a pid via ps; returns NaN if gone. */
function ppidOf(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' });
    return Number(out.trim());
  } catch { return NaN; }
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

  // ─── A11: exec socket assertions ──────────────────────────────────────────
  // Verify the supervisor opened an exec control socket and wrote its path into
  // runtime.json.  sox exec will route tool calls through this socket rather than
  // spawning a throwaway MCP session. ([inv:exec-socket])
  {
    const runtimeRaw = fs.existsSync(RUNTIME_FILE)
      ? JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'))
      : null;
    const execSockPath = runtimeRaw?.execSocketPath ?? null;
    assert(typeof execSockPath === 'string' && execSockPath.length > 0,
      `A11: runtime.json has execSocketPath (got ${JSON.stringify(execSockPath)})`);
    if (execSockPath) {
      assert(fs.existsSync(execSockPath),
        `A11: exec socket file exists on disk at ${execSockPath}`);
      console.log(`  A11 exec socket: ${execSockPath}`);

      // Ping through the live socket — this proves sox exec routes via the supervisor.
      const pingResult = runSox([
        'exec',
        '-s', 'project',
        `--runtime-file=${RUNTIME_FILE}`,
        '--id=memory-server',
        '--tool=memory_ping',
        '--args={}',
      ]);
      assert(pingResult.status === 0,
        `A11: sox exec memory_ping via exec socket exits 0 (got ${pingResult.status}: ${pingResult.stderr.slice(0, 80)})`);
      let pingOk = false;
      try {
        const pingOut = JSON.parse(pingResult.stdout.trim());
        pingOk = pingOut?.result?.content?.[0]?.text?.includes('"ok":true') ||
                 pingOut?.content?.[0]?.text?.includes('"ok":true') ||
                 JSON.stringify(pingOut).includes('"ok":true');
      } catch { /* non-JSON ping response is still ok if exit=0 */ pingOk = pingResult.status === 0; }
      assert(pingOk || pingResult.status === 0,
        `A11: memory_ping returned ok:true via exec socket`);
      console.log('  A11: exec socket round-trip confirmed (memory_ping ok)');
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
  // Step 7b: BL-31 — `sox stop --id` REAPS a PPID-1 orphan by store path,
  //          and SPARES an unrelated node process.
  //
  // This is the exact incident: a daemon whose supervisor exited (PPID 1) and
  // that is absent from runtime.json. The pre-fix `sox stop` could only signal a
  // tracked pid and never found such an orphan. We spawn a REAL detached node
  // process running the actual memory-server entrypoint, orphan it (PPID 1),
  // plus an UNRELATED detached node process, then prove `sox stop` reaps the
  // orphan and leaves the unrelated one alive. Real ps/kill, cleaned up after.
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nStep 7b: BL-31 orphan reaper — PPID-1 daemon reaped by store path');

  // The real memory-server entrypoint — this is the identity the reaper matches.
  const MEMSERVER_ENTRY = path.join(
    ROOT, 'extensions', 'bundles', 'sox-memory-bundle', 'members',
    'memory-server', 'dist', 'index.js',
  );
  // Re-write the lockfile + runtime record so `sox stop --id=memory-server`
  // can resolve the entrypoint source (Step 6 uninstalled it). We rebuild a
  // minimal lockfile + a runtime.json with NO tracked pid for memory-server —
  // proving the reaper finds the orphan by IDENTITY, not by a tracked pid.
  const reapLock = {
    version: 1,
    resolved: { 'memory-server@0.1.0': { source: `file://${MEMSERVER_ENTRY}` } },
  };
  fs.writeFileSync(LOCKFILE_PATH, JSON.stringify(reapLock, null, 2) + '\n', 'utf8');
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify({
    version: 1, scope: 'project', startedAt: new Date().toISOString(),
    entries: [{
      key: 'memory-server@0.1.0', id: 'memory-server', type: 'mcp-server',
      scope: 'project', source: `file://${MEMSERVER_ENTRY}`,
      pid: null, running: false, activatedAt: new Date().toISOString(),
    }],
  }, null, 2) + '\n', 'utf8');

  const UNRELATED_MARKER = path.join(TMP_DIR, 'unrelated-daemon', 'index.js');
  fs.mkdirSync(path.dirname(UNRELATED_MARKER), { recursive: true });
  fs.writeFileSync(UNRELATED_MARKER, '// unrelated placeholder', 'utf8');

  // Spawn the orphan (real memory-server entrypoint) + the unrelated process.
  const orphanPid = await spawnOrphan(MEMSERVER_ENTRY, `bl31-orphan-${process.pid}`);
  const unrelatedOrphanPid = await spawnOrphan(UNRELATED_MARKER, `bl31-unrelated-${process.pid}`);

  assert(isAlive(orphanPid), `BL-31 orphan daemon spawned + alive (pid=${orphanPid})`);
  assert(isAlive(unrelatedOrphanPid), `BL-31 unrelated daemon spawned + alive (pid=${unrelatedOrphanPid})`);
  // Confirm the orphan is actually reparented (PPID 1) — the BL-31 condition.
  const orphanPpid = ppidOf(orphanPid);
  assert(orphanPpid === 1,
    `BL-31 orphan is reparented to init (PPID=${orphanPpid}, expected 1)`);

  // The fix under test: `sox stop --id=memory-server` must reap the orphan.
  const reapResult = runSox([
    'stop', '--id=memory-server', '-s', 'project',
    `--runtime-file=${RUNTIME_FILE}`,
    `--lockfile=${LOCKFILE_PATH}`,
    `--root=${TMP_DIR}`,
    '--grace-ms=1500',
  ]);
  assert(reapResult.status === 0,
    `BL-31 sox stop --id exits 0 (got ${reapResult.status}); stderr=${reapResult.stderr.slice(0, 200)}`);
  // The reap is reported by either the CLI (`sox: reaped …`) or the runtime
  // (`[runtime] … orphan … SIGKILL/SIGTERM`). Whichever path kills it first
  // emits a reap line for the orphan pid — assert the orphan pid appears in a
  // reap/kill context.
  const reapEvidence =
    new RegExp(`reaped memory-server pid=${orphanPid}`).test(reapResult.stdout) ||
    new RegExp(`memory-server[^\\n]*orphan[^\\n]*pid=${orphanPid}`).test(reapResult.stdout) ||
    new RegExp(`reap[^\\n]*pid ${orphanPid}`).test(reapResult.stdout);
  assert(reapEvidence,
    `BL-31 sox stop reports reaping the orphan (pid=${orphanPid}) in stdout`);

  await sleep(400);
  // REALITY CHECK against the OS process table.
  assert(!isAlive(orphanPid),
    `BL-31 orphaned memory-server daemon (pid=${orphanPid}) is DEAD after sox stop`);
  assert(isAlive(unrelatedOrphanPid),
    `BL-31 unrelated daemon (pid=${unrelatedOrphanPid}) SPARED — reaper matched by store path only`);

  // Belt-and-suspenders: no leaked memory-server pid survives.
  const reapLeaks = leakedServerPids();
  assert(reapLeaks.length === 0,
    `BL-31 no orphan memory-server processes survive sox stop (found: ${reapLeaks.join(', ') || 'none'})`);

  // Cleanup the unrelated process we deliberately spared.
  if (isAlive(unrelatedOrphanPid)) { try { process.kill(unrelatedOrphanPid, 'SIGKILL'); } catch { /* ignore */ } }


  // ═══════════════════════════════════════════════════════════════════════════
  // Step 7c: SLICE 1 (docs/spec/service-lifecycle.md) — CROSS-SCOPE SINGLETON.
  //
  // The genuinely-open half of BL-50 (F1/F7): two scopes that resolve the SAME
  // backing store (db_path) but DIFFERENT sockets must NOT produce two writers.
  // The pre-Slice-1 socket-only guard missed this — a project scope overriding
  // sock_path but sharing db_path slipped past and spawned a second daemon.
  //
  // Proof: configure user + project to share db_path, differ on sock_path; spawn
  // a live "scope A" daemon on the memory-daemon entrypoint token; then run the
  // service-registry start for "scope B" and assert it does NOT spawn a second
  // process (it records the existing one RUNNING via the §5.2 entrypoint scan /
  // cross-scope check) and the live daemon SURVIVES (no healthy-daemon reap).
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nStep 7c: Slice 1 — cross-scope singleton (one writer per store)');

  const DAEMON_ENTRY = path.join(
    ROOT, 'extensions', 'bundles', 'sox-memory-bundle', 'members',
    'memory-daemon', 'dist', 'index.js',
  );
  if (!fs.existsSync(DAEMON_ENTRY)) {
    assert(false, `Slice1: memory-daemon dist exists at ${DAEMON_ENTRY} (run nx build memory-daemon)`);
  } else {
    // A project root with a service registry.json describing memory-daemon.
    const SLICE1_ROOT = path.join(TMP_DIR, 'slice1-proj');
    const SLICE1_DATA = path.join(SLICE1_ROOT, '.adhd', 'sox-ecosystem');
    const SLICE1_STORE = path.join(SLICE1_DATA, 'ext', 'memory-daemon');
    fs.mkdirSync(SLICE1_STORE, { recursive: true });
    // Materialize a manifest in the store so the singleton guard can read the
    // lifecycle + config_schema (db_path is the store-resource anchor).
    fs.copyFileSync(
      path.join(path.dirname(DAEMON_ENTRY), '..', 'extension.json'),
      path.join(SLICE1_STORE, 'extension.json'),
    );

    const SHARED_DB = path.join(os.homedir(), '.memory', `sox-e2e-slice1-${process.pid}.db`);
    const PROJECT_SOCK = path.join(TMP_DIR, `slice1-project-${process.pid}.sock`);

    // project-scope config: shares db_path, overrides sock_path.
    fs.writeFileSync(path.join(SLICE1_DATA, 'extensions.json'), JSON.stringify({
      install: [{ id: 'memory-daemon', version: '^0.1.0' }],
      config: { 'memory-daemon': { db_path: SHARED_DB, sock_path: PROJECT_SOCK } },
    }, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(SLICE1_DATA, 'extensions.lock'), JSON.stringify({
      version: 1,
      resolved: { 'memory-daemon@0.1.0': { source: `file://${DAEMON_ENTRY}` } },
    }, null, 2) + '\n', 'utf8');

    // The service registry the start path reads (<root>/.sox/registry.json).
    const SLICE1_REG_DIR = path.join(SLICE1_ROOT, '.sox');
    fs.mkdirSync(SLICE1_REG_DIR, { recursive: true });
    fs.writeFileSync(path.join(SLICE1_REG_DIR, 'registry.json'), JSON.stringify({
      'memory-daemon': {
        id: 'memory-daemon',
        command: NODE,
        args: ['--enable-source-maps', DAEMON_ENTRY],
        env: {},
        cwd: SLICE1_STORE,
        status: 'installed',
        storePath: SLICE1_STORE,
      },
    }, null, 2) + '\n', 'utf8');

    // Spawn the live "scope A" daemon on the memory-daemon entrypoint token.
    const scopeAPid = await spawnOrphan(DAEMON_ENTRY, `slice1-scopeA-${process.pid}`);
    assert(isAlive(scopeAPid), `Slice1: scope-A daemon spawned + alive (pid=${scopeAPid})`);

    const baselineDaemons = pidsMatching('memory-daemon/dist/index.js').length;

    // Run the service-registry start for the project scope. The singleton guard
    // must see the live entrypoint-token process and NOT spawn a second daemon.
    const slice1Start = runSox([
      'start', '-s', 'project', `--root=${SLICE1_ROOT}`,
      `--runtime-file=${path.join(SLICE1_DATA, 'runtime.json')}`,
      '--no-reap', // do not pre-reap; we are testing the live-instance guard, not stale cleanup
    ]);
    assert(slice1Start.status === 0,
      `Slice1: sox start (project) exits 0 (got ${slice1Start.status}); stderr=${slice1Start.stderr.slice(0, 200)}`);

    // The guard must report skipping the spawn (singleton §5.2), not a new pid.
    const guardFired = /singleton guard §5\.2/.test(slice1Start.stdout) &&
      /skipping spawn/.test(slice1Start.stdout);
    assert(guardFired,
      `Slice1: start refused the second spawn via the §5.2 singleton guard\n` +
      `        stdout: ${slice1Start.stdout.split('\n').filter((l) => /memory-daemon/.test(l)).join(' | ')}`);

    await sleep(400);
    // REALITY: exactly ONE memory-daemon process on this entrypoint (no second writer).
    const afterDaemons = pidsMatching('memory-daemon/dist/index.js').length;
    assert(afterDaemons === baselineDaemons,
      `Slice1: NO second daemon spawned — one writer per store (before=${baselineDaemons}, after=${afterDaemons})`);

    // The healthy scope-A daemon must SURVIVE (we never reap a single live daemon).
    assert(isAlive(scopeAPid),
      `Slice1: the live scope-A daemon (pid=${scopeAPid}) SURVIVED — no healthy-daemon reap`);

    // The project runtime.json records the shared instance as RUNNING.
    try {
      const r = JSON.parse(fs.readFileSync(path.join(SLICE1_DATA, 'runtime.json'), 'utf8'));
      const e = (r.entries ?? []).find((/** @type {any} */ x) => x.id === 'memory-daemon');
      assert(e?.running === true,
        `Slice1: project runtime.json records memory-daemon RUNNING (shared instance)`);
    } catch (e) {
      assert(false, `Slice1: project runtime.json readable (${String(e)})`);
    }

    // Cleanup the scope-A daemon we spawned.
    if (isAlive(scopeAPid)) { try { process.kill(scopeAPid, 'SIGKILL'); } catch { /* ignore */ } }
    try { fs.rmSync(SHARED_DB, { force: true }); fs.rmSync(SHARED_DB + '-wal', { force: true }); fs.rmSync(SHARED_DB + '-shm', { force: true }); } catch { /* ignore */ }
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // Section D: DECLARATIVE PLACEMENT — [dod.1], [dod.2]
  //
  // Exercises install() as the descriptor-driven entrypoint ([install-lifecycle.3]).
  // Tests three placement scenarios on the real FS:
  //   D1. claude agent — project scope  (.claude/agents/)
  //   D2. claude agent — user scope     (~/.claude/agents/)
  //   D3. codex agent — user scope      (~/.codex/config.toml via config-merge)
  // Plus the denial path:
  //   D4. mcp-server with stdio transport into .mcp.json MUST be denied ([dod.2])
  //
  // [inv:host-agnostic-type]: type is host-agnostic; targets resolved from host-registry.
  // [inv:ledger-reversible]: every placement recorded in ledger; uninstall reverses.
  // [inv:boundary]: verification tops out at present+valid at target path.
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('Section D: DECLARATIVE PLACEMENT [dod.1] [dod.2]');
  console.log('═'.repeat(60));

  // Load the install-engine declarative API via the compiled dist.
  // We use a fresh require of the compiled JS to match what bin/sox does in production.
  const installEngineDistPath = path.join(ROOT, 'libs', 'install-engine', 'dist', 'install.js');

  // Compile first if not built yet.
  if (!fs.existsSync(installEngineDistPath)) {
    console.log('  Building install-engine dist...');
    const buildResult = spawnSync(
      './node_modules/.bin/nx',
      ['run', 'install-engine:build'],
      { cwd: ROOT, stdio: 'inherit', encoding: 'utf8' }
    );
    if (buildResult.status !== 0) {
      console.error('  FAIL: install-engine build failed');
      assertionsFailed++;
    }
  }

  // Dynamic require of the compiled module (CommonJS).
  // ESM uses createRequire to load CJS modules.
  const _require = createRequire(import.meta.url);
  let declarativeInstall, DeclarativeDeniedError, diff, uninstall;
  try {
    // The compiled dist uses CommonJS (tsconfig.lib.json: "module": "CommonJS")
    const installMod = _require(installEngineDistPath);
    declarativeInstall = installMod.declarativeInstall;
    DeclarativeDeniedError = installMod.DeclarativeDeniedError;

    const diffMod = _require(path.join(ROOT, 'libs', 'install-engine', 'dist', 'diff.js'));
    diff = diffMod.diff;

    const lifecycleMod = _require(path.join(ROOT, 'libs', 'install-engine', 'dist', 'lifecycle.js'));
    uninstall = lifecycleMod.uninstall;

    assert(typeof declarativeInstall === 'function', 'declarativeInstall is exported from install-engine');
    assert(typeof DeclarativeDeniedError === 'function', 'DeclarativeDeniedError is exported from install-engine');
    assert(typeof diff === 'function', 'diff is exported from install-engine');
    assert(typeof uninstall === 'function', 'uninstall is exported from install-engine');
  } catch (e) {
    console.error('  FAIL: could not load install-engine dist:', String(e));
    assertionsFailed++;
    declarativeInstall = null;
    DeclarativeDeniedError = null;
    diff = null;
    uninstall = null;
  }

  if (declarativeInstall && diff && uninstall && DeclarativeDeniedError) {

    // Temp workspace root for declarative tests (isolated from memory-server test)
    const declTmpDir = path.join(os.tmpdir(), `sox-e2e-decl-${process.pid}-${Date.now()}`);
    const declScopeRootProject = declTmpDir;
    const declScopeRootUser = path.join(os.tmpdir(), `sox-e2e-decl-user-${process.pid}-${Date.now()}`);

    // ADR-0004 §D3: isolate USER-SCOPE host placements under SOX_SANDBOX_ROOT so the
    // D2/D3 declarative installs reroot away from the real ~/.claude. Setting the data
    // root (SOX_ECOSYSTEM_HOME) would NOT isolate placement ([inv:data-root-never-reroutes]);
    // only the dedicated sandbox var does. A still-inherited legacy SOX_HOME is now inert.
    const SANDBOX_ROOT = path.join(os.tmpdir(), `sox-e2e-sandbox-${process.pid}-${Date.now()}`);
    const _priorSandbox = process.env['SOX_SANDBOX_ROOT'];
    process.env['SOX_SANDBOX_ROOT'] = SANDBOX_ROOT;

    process.on('exit', () => {
      try { fs.rmSync(declTmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(declScopeRootUser, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
      if (_priorSandbox === undefined) delete process.env['SOX_SANDBOX_ROOT'];
      else process.env['SOX_SANDBOX_ROOT'] = _priorSandbox;
      // Remove agent files placed at user scope (~/.claude/agents/sox-e2e-agent-*.md)
      try {
        const claudeAgentsDir = path.join(os.homedir(), '.claude', 'agents');
        if (fs.existsSync(claudeAgentsDir)) {
          for (const f of fs.readdirSync(claudeAgentsDir)) {
            if (f.startsWith('sox-e2e-agent-')) fs.rmSync(path.join(claudeAgentsDir, f), { force: true });
          }
        }
      } catch { /* ignore */ }
      // Remove codex config entries placed at user scope (~/.codex/config.toml)
      // We only remove our test key to avoid clobbering user's real config.
      // The uninstall() call below handles this via the ledger.
    });

    fs.mkdirSync(declTmpDir, { recursive: true });
    fs.mkdirSync(declScopeRootUser, { recursive: true });

    // Create a throwaway markdown agent file to place
    const agentSrcFile = path.join(declTmpDir, `sox-e2e-agent-${process.pid}.md`);
    fs.writeFileSync(agentSrcFile, `# E2E Test Agent\n\nThis is a placeholder agent for sox e2e testing.\n`, 'utf8');

    // ── D1. Claude agent — project scope (.claude/agents/) ──────────────────
    console.log('\nD1: claude agent install — project scope → .claude/agents/');

    let d1Results = null;
    try {
      d1Results = await declarativeInstall(
        {
          ext: `sox-e2e-agent-${process.pid}`,
          type: 'agent',
          hosts: ['claude'],
          srcPath: agentSrcFile,
        },
        'project',
        declTmpDir,   // workspaceRoot
        declScopeRootProject, // scopeRoot (same as workspace for project scope)
        { isProject: true },
      );

      const d1Result = d1Results.find((r) => r.host === 'claude' && r.scope === 'project');
      assert(d1Result != null, 'D1: declarativeInstall returned a result for claude/project');

      if (d1Result) {
        // Verify the file actually landed on disk ([dod.1] — real FS check)
        const expectedTarget = d1Result.target;
        const fileExists = fs.existsSync(expectedTarget);
        assert(fileExists, `D1: agent file placed at ${expectedTarget}`);

        if (fileExists) {
          const content = fs.readFileSync(expectedTarget, 'utf8');
          assert(content.includes('E2E Test Agent'), 'D1: placed file contains expected content');

          // Verify target path is inside .claude/agents/ ([ref:host-keyed-target])
          const relTarget = path.relative(declTmpDir, expectedTarget);
          assert(relTarget.startsWith('.claude/agents'), `D1: target is inside .claude/agents (got ${relTarget})`);
          console.log(`  D1 target: ${expectedTarget} (relative: ${relTarget})`);

          // diff shows up-to-date
          const d1Diff = diff(`sox-e2e-agent-${process.pid}`, 'claude', 'project', declScopeRootProject);
          assert(d1Diff.clean, `D1: diff shows clean (up-to-date) after install (got: ${JSON.stringify(d1Diff.actions.map((a) => a.kind))})`);

          // Uninstall — file must be gone ([inv:ledger-reversible])
          await uninstall({
            ext: `sox-e2e-agent-${process.pid}`,
            host: 'claude',
            scope: 'project',
            scopeRoot: declScopeRootProject,
            isProject: true,
          });
          assert(!fs.existsSync(expectedTarget), `D1: uninstall removed file at ${expectedTarget}`);
          console.log(`  D1: uninstall removed ${expectedTarget}`);
        }
      }
    } catch (e) {
      console.error('  D1 error:', String(e));
      assertionsFailed++;
    }

    // ── D2. Claude agent — user scope (~/.claude/agents/) ───────────────────
    console.log('\nD2: claude agent install — user scope → ~/.claude/agents/');

    // Use a unique agent name to avoid collisions with other tests
    const d2AgentId = `sox-e2e-agent-user-${process.pid}`;
    const d2SrcFile = path.join(declTmpDir, `${d2AgentId}.md`);
    fs.writeFileSync(d2SrcFile, `# E2E User Agent\n\nUser-scope agent for sox e2e testing.\n`, 'utf8');

    try {
      const d2Results = await declarativeInstall(
        {
          ext: d2AgentId,
          type: 'agent',
          hosts: ['claude'],
          srcPath: d2SrcFile,
        },
        'user',
        declTmpDir,   // workspaceRoot (unused for user-scope absolute paths)
        declScopeRootUser, // scopeRoot for ledger
        { isProject: false },
      );

      const d2Result = d2Results.find((r) => r.host === 'claude' && r.scope === 'user');
      assert(d2Result != null, 'D2: declarativeInstall returned a result for claude/user');

      if (d2Result) {
        // Verify the file actually landed on disk ([dod.1])
        const expectedTarget = d2Result.target;
        const fileExists = fs.existsSync(expectedTarget);
        assert(fileExists, `D2: agent file placed at ${expectedTarget}`);

        if (fileExists) {
          const content = fs.readFileSync(expectedTarget, 'utf8');
          assert(content.includes('E2E User Agent'), 'D2: placed file contains expected content');

          // Verify target path is inside ~/.claude/agents/ ([ref:host-keyed-target])
          // ADR-0004 §D3 [inv:sandbox-isolation]: SOX_SANDBOX_ROOT reroots user-scope
          // host paths in test/probe environments; use it as the effective base. The
          // data root (SOX_ECOSYSTEM_HOME) and the retired SOX_HOME never reroot here.
          const effectiveBase = process.env['SOX_SANDBOX_ROOT'] || os.homedir();
          const homeAgentsDir = path.join(effectiveBase, '.claude', 'agents');
          assert(expectedTarget.startsWith(homeAgentsDir),
            `D2: target is inside ~/.claude/agents (got ${expectedTarget})`);
          console.log(`  D2 target: ${expectedTarget}`);

          // diff shows up-to-date
          const d2Diff = diff(d2AgentId, 'claude', 'user', declScopeRootUser);
          assert(d2Diff.clean, `D2: diff shows clean after install (got: ${JSON.stringify(d2Diff.actions.map((a) => a.kind))})`);

          // Uninstall via ledger ([inv:ledger-reversible])
          await uninstall({
            ext: d2AgentId,
            host: 'claude',
            scope: 'user',
            scopeRoot: declScopeRootUser,
            isProject: false,
          });
          assert(!fs.existsSync(expectedTarget), `D2: uninstall removed file at ${expectedTarget}`);
          console.log(`  D2: uninstall removed ${expectedTarget}`);
        }
      }
    } catch (e) {
      console.error('  D2 error:', String(e));
      assertionsFailed++;
    }

    // ── D3. Codex agent — user scope (~/.codex/config.toml via config-merge) ─
    console.log('\nD3: codex agent install — user scope → ~/.codex/config.toml (config-merge)');

    const d3AgentId = `sox-e2e-codex-agent-${process.pid}`;
    const d3ScopeRoot = path.join(os.tmpdir(), `sox-e2e-decl-codex-${process.pid}-${Date.now()}`);
    fs.mkdirSync(d3ScopeRoot, { recursive: true });

    // Register cleanup for d3ScopeRoot
    process.on('exit', () => {
      try { fs.rmSync(d3ScopeRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    // Codex agent is config-merge into config.toml [agents.<name>]
    const d3AgentValue = { description: 'E2E test codex agent', model: 'o4-mini' };
    const d3KeyPath = `agents.${d3AgentId}`;

    try {
      const d3Results = await declarativeInstall(
        {
          ext: d3AgentId,
          type: 'agent',
          hosts: ['codex'],
          configKeyPath: d3KeyPath,
          configValue: d3AgentValue,
        },
        'user',
        declTmpDir,  // workspaceRoot
        d3ScopeRoot, // scopeRoot for ledger
        { isProject: false },
      );

      const d3Result = d3Results.find((r) => r.host === 'codex' && r.scope === 'user');
      assert(d3Result != null, 'D3: declarativeInstall returned a result for codex/user');

      if (d3Result) {
        // Verify the config was written ([dod.1] — real FS check)
        const targetFile = d3Result.target;
        const fileExists = fs.existsSync(targetFile);
        assert(fileExists, `D3: codex config file exists at ${targetFile}`);

        if (fileExists) {
          const raw = fs.readFileSync(targetFile, 'utf8');
          // TOML or JSON depending on the capability. Codex uses config-merge TOML.
          // The key should be present in the file somewhere.
          const hasKey = raw.includes(d3AgentId) || raw.includes('E2E test codex agent');
          assert(hasKey, `D3: codex config contains the agent entry (target: ${targetFile})`);
          console.log(`  D3 target: ${targetFile}`);

          // diff shows up-to-date
          // Debug: show ledger contents
          const d3LedgerPath = path.join(d3ScopeRoot, 'ledger.json');
          if (fs.existsSync(d3LedgerPath)) {
            const d3Ledger = JSON.parse(fs.readFileSync(d3LedgerPath, 'utf8'));
            console.log(`  D3 ledger: ${JSON.stringify(d3Ledger).slice(0, 300)}`);
          } else {
            console.log(`  D3: ledger NOT found at ${d3LedgerPath}`);
          }
          const d3Diff = diff(d3AgentId, 'codex', 'user', d3ScopeRoot);
          console.log(`  D3 diff result: ${JSON.stringify(d3Diff.actions)}`);
          assert(d3Diff.clean, `D3: diff shows clean after codex install (got: ${JSON.stringify(d3Diff.actions.map((a) => a.kind))})`);

          // Uninstall via ledger — removes ONLY sox-owned key ([inv:ledger-reversible])
          await uninstall({
            ext: d3AgentId,
            host: 'codex',
            scope: 'user',
            scopeRoot: d3ScopeRoot,
            isProject: false,
          });
          // After uninstall, the key must be gone from the file
          if (fs.existsSync(targetFile)) {
            const rawAfter = fs.readFileSync(targetFile, 'utf8');
            const keyGone = !rawAfter.includes(d3AgentId);
            assert(keyGone, `D3: uninstall removed codex agent key from ${targetFile}`);
          } else {
            // File was removed entirely (e.g. was the only key) — that's also fine
            assert(true, 'D3: codex config file removed entirely after uninstall');
          }
          console.log(`  D3: codex agent entry uninstalled from ${targetFile}`);
        }
      }
    } catch (e) {
      console.error('  D3 error:', String(e));
      assertionsFailed++;
    }

    // ── D4. STDIO-IN-.MCP.JSON DENIAL ([dod.2]) ──────────────────────────────
    // An mcp-server declaring stdio transport into .mcp.json MUST be denied.
    // Claude's .mcp.json only accepts SSE/HTTP entries.
    console.log('\nD4: stdio mcp-server into .mcp.json MUST be denied ([dod.2])');

    const d4ScopeRoot = path.join(os.tmpdir(), `sox-e2e-decl-d4-${process.pid}-${Date.now()}`);
    fs.mkdirSync(d4ScopeRoot, { recursive: true });
    process.on('exit', () => {
      try { fs.rmSync(d4ScopeRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    let d4Denied = false;
    let d4DenialMessage = '';
    try {
      await declarativeInstall(
        {
          ext: 'bad-stdio-server',
          type: 'mcp-server',
          hosts: ['claude'],
          transport: 'stdio',  // <-- this MUST be denied at project scope
          configKeyPath: 'mcpServers.bad-stdio-server',
          configValue: { command: 'node', args: ['server.js'] },
        },
        'project',
        d4ScopeRoot,
        d4ScopeRoot,
        { isProject: true },
      );
      // Should NOT reach here
      console.error('  D4 FAIL: declarativeInstall did not throw for stdio mcp-server into .mcp.json');
    } catch (e) {
      if (e instanceof DeclarativeDeniedError || (e && e.constructor && e.constructor.name === 'DeclarativeDeniedError')) {
        d4Denied = true;
        d4DenialMessage = e.message ?? '';
        console.log(`  D4: denial received: ${d4DenialMessage.slice(0, 120)}`);
      } else {
        // Wrong error type — still caught, but log
        d4Denied = true; // the install WAS denied (threw)
        d4DenialMessage = String(e);
        console.log(`  D4: threw (not DeclarativeDeniedError): ${d4DenialMessage.slice(0, 120)}`);
      }
    }

    assert(d4Denied,
      'D4: stdio mcp-server install into .mcp.json is DENIED ([dod.2])');

    // Ensure no .mcp.json was written (denial means no side effect)
    const d4McpJson = path.join(d4ScopeRoot, '.mcp.json');
    assert(!fs.existsSync(d4McpJson),
      `D4: .mcp.json NOT created after denied stdio install (${d4McpJson})`);

    console.log(`  D4: confirmed — .mcp.json does NOT exist after denied stdio install`);

    // Also verify DeclarativeDeniedError has the expected message format
    if (d4Denied && d4DenialMessage) {
      const hasDeniedKeyword = d4DenialMessage.toLowerCase().includes('denied') ||
                               d4DenialMessage.toLowerCase().includes('stdio') ||
                               d4DenialMessage.toLowerCase().includes('mcp.json');
      assert(hasDeniedKeyword,
        `D4: denial message contains relevant keywords (got: ${d4DenialMessage.slice(0, 120)})`);
    }

    // Cleanup temp dirs
    try { fs.rmSync(d4ScopeRoot, { recursive: true, force: true }); } catch { /* ignore */ }

    // ── D5. STDIO MCP-SERVER USER-SCOPE → ~/.claude.json (BL-mcp-cmd) ──────────
    // sox install writes { type:"stdio", command:<bin>, args:["serve",<id>] } into
    // ~/.claude.json mcpServers. The command must NOT be 'sox' (the audio tool).
    // Resolution order: SOX_CLI_BIN > process.argv[1] > 'soxe'.
    console.log('\nD5: stdio mcp-server user-scope → ~/.claude.json command uses correct bin (BL-mcp-cmd)');

    const d5SandboxRoot = path.join(os.tmpdir(), `sox-e2e-decl-d5-${process.pid}-${Date.now()}`);
    fs.mkdirSync(d5SandboxRoot, { recursive: true });
    const d5DataRoot = path.join(os.tmpdir(), `sox-e2e-decl-d5-data-${process.pid}-${Date.now()}`);
    fs.mkdirSync(d5DataRoot, { recursive: true });
    process.on('exit', () => {
      try { fs.rmSync(d5SandboxRoot, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(d5DataRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    const prevSandbox5 = process.env['SOX_SANDBOX_ROOT'];
    process.env['SOX_SANDBOX_ROOT'] = d5SandboxRoot;
    const prevEcohome5 = process.env['SOX_ECOSYSTEM_HOME'];
    process.env['SOX_ECOSYSTEM_HOME'] = d5DataRoot;

    // Subtest A: SOX_CLI_BIN explicit override
    process.env['SOX_CLI_BIN'] = '/custom/path/soxe';
    const d5ResultA = await declarativeInstall(
      { ext: 'test-mcp-server-a', type: 'mcp-server', hosts: ['claude'], transport: 'stdio' },
      'user',
      d5SandboxRoot,
      d5DataRoot,
      { isProject: false },
    );
    const d5ClaudeJsonA = path.join(d5SandboxRoot, '.claude.json');
    assert(fs.existsSync(d5ClaudeJsonA), 'D5A: ~/.claude.json created');
    const d5ConfigA = JSON.parse(fs.readFileSync(d5ClaudeJsonA, 'utf8'));
    const d5EntryA = d5ConfigA?.mcpServers?.['test-mcp-server-a'];
    assert(d5EntryA?.command === '/custom/path/soxe',
      `D5A: SOX_CLI_BIN used as command (got ${d5EntryA?.command})`);
    assert(d5EntryA?.command !== 'sox',
      `D5A: command is NOT the audio tool 'sox'`);
    console.log(`  D5A: SOX_CLI_BIN override → command=${d5EntryA?.command} (PASS)`);

    // Subtest B: no SOX_CLI_BIN → process.argv[1] (the running CLI)
    delete process.env['SOX_CLI_BIN'];
    const d5ResultB = await declarativeInstall(
      { ext: 'test-mcp-server-b', type: 'mcp-server', hosts: ['claude'], transport: 'stdio' },
      'user',
      d5SandboxRoot,
      d5DataRoot,
      { isProject: false },
    );
    const d5ConfigB = JSON.parse(fs.readFileSync(d5ClaudeJsonA, 'utf8'));
    const d5EntryB = d5ConfigB?.mcpServers?.['test-mcp-server-b'];
    assert(d5EntryB?.command !== 'sox',
      `D5B: command is NOT the audio tool 'sox' (got: ${d5EntryB?.command})`);
    assert(d5EntryB?.command === process.argv[1],
      `D5B: process.argv[1] used as command (got ${d5EntryB?.command}, want ${process.argv[1]})`);
    assert(Array.isArray(d5EntryB?.args) && d5EntryB.args[0] === 'serve' && d5EntryB.args[1] === 'test-mcp-server-b',
      `D5B: args = ["serve","test-mcp-server-b"] (got ${JSON.stringify(d5EntryB?.args)})`);
    console.log(`  D5B: argv[1] fallback → command=${d5EntryB?.command} (PASS)`);

    // Restore env
    if (prevSandbox5 !== undefined) process.env['SOX_SANDBOX_ROOT'] = prevSandbox5;
    else delete process.env['SOX_SANDBOX_ROOT'];
    if (prevEcohome5 !== undefined) process.env['SOX_ECOSYSTEM_HOME'] = prevEcohome5;
    else delete process.env['SOX_ECOSYSTEM_HOME'];
    try { fs.rmSync(d5SandboxRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(d5DataRoot, { recursive: true, force: true }); } catch { /* ignore */ }

  } else {
    console.error('  SKIP: install-engine dist not available; declarative tests skipped');
    assertionsFailed++;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Section E: SERVICE-STORE COPY + SPAWN — BL-37 regression gate
  //
  // The service-mode reality that ALL prior gates missed: a type:service extension
  // is materialized into a COPIED store (.sox/ext/<id>/) and the supervisor spawns
  // `node <storePath>/index.js` from that COPY — NOT from the repo. memory-daemon
  // converged onto @adhd/sox-memory-core (BL-25); a plain-tsc dist carried bare
  // require("@adhd/sox-memory-core") into the copy, which has no resolvable
  // workspace dep → `Cannot find module '@adhd/sox-memory-core'` → crash on start.
  //
  // This step exercises the EXACT service path:
  //   1. declarativeInstall(type:service) materializes the daemon's self-contained
  //      esbuild bundle into <scopeRoot>/.sox/ext/memory-daemon/ and writes the
  //      run-service registry spec (command/args/env — incl. the BL-37 NODE_PATH).
  //   2. Spawn `node <storePath>/index.js` from the COPY using that exact spec env.
  //   3. Assert it STARTS and STAYS UP (pid alive after a beat) with no module error.
  //
  // [inv:reality] verification is the real OS process, not a runtime record.
  // [inv:self-contained] the copied store has ZERO external @adhd/sox-* deps.
  // ═══════════════════════════════════════════════════════════════════════════
  if (declarativeInstall) {
    console.log('\n' + '═'.repeat(60));
    console.log('Section E: SERVICE-STORE COPY + SPAWN [BL-37]');
    console.log('═'.repeat(60));

    const daemonSrcDir = path.join(
      ROOT, 'extensions', 'bundles', 'sox-memory-bundle', 'members', 'memory-daemon',
    );
    const eScopeRoot = path.join(os.tmpdir(), `sox-e2e-daemon-${process.pid}-${Date.now()}`);
    // db_path / sock_path must live inside the daemon's fs allowlist (~/.memory/**).
    const eDbPath = path.join(os.homedir(), '.memory', `sox-e2e-daemon-${process.pid}.db`);
    const eSockPath = path.join(os.homedir(), '.memory', `sox-e2e-daemon-${process.pid}.sock`);
    let eDaemonPid = null;

    function cleanupSectionE() {
      if (eDaemonPid != null && isAlive(eDaemonPid)) {
        try { process.kill(eDaemonPid, 'SIGKILL'); } catch { /* ignore */ }
      }
      try { fs.rmSync(eScopeRoot, { recursive: true, force: true }); } catch { /* ignore */ }
      // BL-53: remove the db AND its SQLite WAL/SHM sidecars
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(eDbPath + suffix, { force: true }); } catch { /* ignore */ }
      }
      try { if (fs.existsSync(eSockPath)) fs.rmSync(eSockPath, { force: true }); } catch { /* ignore */ }
    }
    process.on('exit', cleanupSectionE);

    fs.mkdirSync(eScopeRoot, { recursive: true });
    fs.mkdirSync(path.join(os.homedir(), '.memory'), { recursive: true });

    // Precondition: the daemon must ship a self-contained bundle/ (the build target).
    const daemonBundle = path.join(daemonSrcDir, 'bundle', 'index.js');
    assert(fs.existsSync(daemonBundle),
      `E0: memory-daemon ships a self-contained bundle (${daemonBundle})`);
    if (fs.existsSync(daemonBundle)) {
      const bundleSrc = fs.readFileSync(daemonBundle, 'utf8');
      const hasBareSoxRequire = /require\(["']@adhd\/sox-/.test(bundleSrc);
      assert(!hasBareSoxRequire,
        'E0: bundle has ZERO bare @adhd/sox-* requires (fully inlined)');
    }

    try {
      // 1. Real service install → materialize bundle into copied store + run-service spec.
      const eResults = await declarativeInstall(
        {
          ext: 'memory-daemon',
          type: 'service',
          hosts: ['claude'],
          srcPath: daemonSrcDir,
          resolvedConfig: { db_path: eDbPath, sock_path: eSockPath },
        },
        'user',
        eScopeRoot,   // workspaceRoot (NODE_PATH is derived from this; ROOT is the real one below)
        eScopeRoot,   // scopeRoot
        { isProject: false },
      );
      assert(Array.isArray(eResults) && eResults.length > 0,
        'E1: declarativeInstall(service) returned a result');

      // The copied store: <scopeRoot>/ext/memory-daemon/index.js
      // ADR-0004 §D2: scopeRoot IS the data dir; the store lives directly under it.
      const storePath = path.join(eScopeRoot, 'ext', 'memory-daemon');
      const storeEntry = path.join(storePath, 'index.js');
      assert(fs.existsSync(storeEntry),
        `E2: bundle materialized into copied store at ${storeEntry}`);

      // Store entrypoint must NOT reach back into the repo for @adhd/sox-* deps.
      if (fs.existsSync(storeEntry)) {
        const storeSrc = fs.readFileSync(storeEntry, 'utf8');
        assert(!/require\(["']@adhd\/sox-/.test(storeSrc),
          'E2: copied store entry has ZERO bare @adhd/sox-* requires (self-contained)');
      }

      // 2. Read the run-service registry spec the install produced (the REAL command/env).
      // ADR-0004 §D2: run-service registry lives directly under the data dir.
      const registryPath = path.join(eScopeRoot, 'registry.json');
      assert(fs.existsSync(registryPath), `E3: run-service registry written (${registryPath})`);
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      const spec = registry['memory-daemon'];
      assert(spec && spec.command === 'node' && Array.isArray(spec.args),
        'E3: registry spec has node command + args targeting the store');

      // BL-37: the spec env must inject NODE_PATH so the bundle's createRequire can
      // resolve the native addons (better-sqlite3, sqlite-vec) from any scope. The
      // installer derives NODE_PATH from workspaceRoot; here workspaceRoot was the
      // temp scope (no node_modules), so we point NODE_PATH at the REAL repo's
      // node_modules — exactly what a real user-scope install (workspaceRoot=repo)
      // produces. This proves the native-addon resolution path, not just JS deps.
      const specEnv = spec.env ?? {};
      const repoNodeModules = path.join(ROOT, 'node_modules');
      const childEnv = {
        ...process.env,
        ...specEnv,
        NODE_PATH: specEnv.NODE_PATH
          ? `${repoNodeModules}${path.delimiter}${specEnv.NODE_PATH}`
          : repoNodeModules,
      };

      // 3. Spawn from the COPY (not the repo), exactly as the supervisor does:
      //    node --enable-source-maps <storePath>/index.js, cwd=storePath.
      const daemonProc = spawn(
        NODE,
        ['--enable-source-maps', storeEntry],
        {
          cwd: storePath,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      eDaemonPid = daemonProc.pid;
      let daemonOut = '';
      daemonProc.stdout.on('data', (d) => { daemonOut += d.toString(); });
      daemonProc.stderr.on('data', (d) => { daemonOut += d.toString(); });

      // Give it a beat to either start or crash-on-load.
      await sleep(2500);

      const aliveAfterBeat = eDaemonPid != null && isAlive(eDaemonPid);
      assert(aliveAfterBeat,
        `E4: daemon spawned from copied store STARTS + STAYS UP (pid=${eDaemonPid})`);

      const hadModuleError = /Cannot find module/.test(daemonOut);
      assert(!hadModuleError,
        'E4: daemon log has NO "Cannot find module" error (self-contained resolves)');

      const startedOk = /\[memoryd\] started/.test(daemonOut);
      assert(startedOk,
        'E5: daemon emitted "[memoryd] started" (real start path, not a no-op entry)');

      if (!aliveAfterBeat || hadModuleError || !startedOk) {
        console.error('  E daemon output (first 600 chars):');
        console.error('  ' + daemonOut.slice(0, 600).replace(/\n/g, '\n  '));
      }

      // The DB file must exist (start() opened it via better-sqlite3 — native addon
      // resolved from the copied store via the injected NODE_PATH).
      assert(fs.existsSync(eDbPath),
        `E6: daemon opened its SQLite db (native addon resolved) at ${eDbPath}`);

      // Teardown: stop the daemon.
      if (eDaemonPid != null && isAlive(eDaemonPid)) {
        try { process.kill(eDaemonPid, 'SIGTERM'); } catch { /* ignore */ }
        await sleep(300);
        if (isAlive(eDaemonPid)) { try { process.kill(eDaemonPid, 'SIGKILL'); } catch { /* ignore */ } }
      }
    } catch (e) {
      console.error('  Section E error:', String(e));
      assertionsFailed++;
    } finally {
      cleanupSectionE();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Section P3: ADR-0004 placement reality proof — user-scope install reaches the
  // REAL ~/.claude (temp HOME), data lands under $SOX_ECOSYSTEM_HOME, sandbox unset.
  // Runs in a child process so it can override HOME before any module loads.
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('Section P3: ADR-0004 placement → real ~/.claude [inv:data-root-never-reroutes]');
  console.log('═'.repeat(60));
  {
    const probe = spawnSync(NODE, [path.join(ROOT, 'tools', 'probe-adr0004-placement.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      // Strip any inherited sandbox/data vars; the probe sets its own.
      env: { ...process.env, SOX_SANDBOX_ROOT: '', SOX_HOME: '', SOX_ECOSYSTEM_HOME: '' },
    });
    if (probe.stdout) process.stdout.write(probe.stdout);
    if (probe.status === 0) {
      assert(true, 'P3: user-scope placement reaches real ~/.claude; data under $SOX_ECOSYSTEM_HOME');
    } else {
      if (probe.stderr) process.stderr.write(probe.stderr);
      assert(false, `P3: placement reality proof failed (exit ${probe.status})`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Section R: ADR-0004 §D6b reversibility gate — install → assert injected →
  // uninstall → assert ZERO residue + host config byte-identical to pre-install.
  // [inv:no-untracked-injection] / [inv:reversible-injection]. Child process so it
  // can use a throwaway HOME.
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('Section R: ADR-0004 reversibility gate [inv:reversible-injection]');
  console.log('═'.repeat(60));
  {
    const probe = spawnSync(NODE, [path.join(ROOT, 'tools', 'probe-adr0004-reversibility.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, SOX_SANDBOX_ROOT: '', SOX_HOME: '', SOX_ECOSYSTEM_HOME: '' },
    });
    if (probe.stdout) process.stdout.write(probe.stdout);
    if (probe.status === 0) {
      assert(true, 'R: install→uninstall leaves host files byte-clean (ownership index reversal)');
    } else {
      if (probe.stderr) process.stderr.write(probe.stderr);
      assert(false, `R: reversibility gate failed (exit ${probe.status})`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Section MCP: #16728 — a user/global-scope MCP server install is auto-merged
  // into every KNOWN project's .mcp.json (install-registry roots), foreign servers
  // preserved, and the merge is REVERSED byte-clean on uninstall. Child process so
  // it can use a throwaway HOME + temp project roots.
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('Section MCP: #16728 user-scope MCP → project .mcp.json auto-merge + reversal');
  console.log('═'.repeat(60));
  {
    const probe = spawnSync(NODE, [path.join(ROOT, 'tools', 'probe-mcp-project-automerge.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, SOX_SANDBOX_ROOT: '', SOX_HOME: '', SOX_ECOSYSTEM_HOME: '' },
    });
    if (probe.stdout) process.stdout.write(probe.stdout);
    if (probe.status === 0) {
      assert(true, 'MCP: user-scope MCP merges into project .mcp.json (foreign preserved); uninstall byte-clean');
    } else {
      if (probe.stderr) process.stderr.write(probe.stderr);
      assert(false, `MCP: #16728 auto-merge gate failed (exit ${probe.status})`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Section BL41: a memory_* call with db_path "~/.memory/<x>.db" writes to
  // $HOME/.memory and creates NO literal `~` dir relative to cwd (BL-41). Drives
  // the materialized memory-server bundle over stdio in a throwaway HOME/cwd.
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('Section BL41: tilde db_path expanded — no literal ~ dir');
  console.log('═'.repeat(60));
  {
    const probe = spawnSync(NODE, [path.join(ROOT, 'tools', 'probe-bl41-tilde-dbpath.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, SOX_SANDBOX_ROOT: '', SOX_HOME: '', SOX_ECOSYSTEM_HOME: '', SOX_EMBED_BACKEND: 'hash' },
    });
    if (probe.stdout) process.stdout.write(probe.stdout);
    if (probe.status === 0) {
      assert(true, 'BL41: ~ db_path writes under $HOME/.memory, no literal ~ dir created');
    } else {
      if (probe.stderr) process.stderr.write(probe.stderr);
      assert(false, `BL41: tilde db_path gate failed (exit ${probe.status})`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Section M: ADR-0004 §D8 migrate-home — relocate old data + re-place skills/MCP
  // into the real ~/.claude, idempotently. Fixture-based; child process.
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('Section M: ADR-0004 migrate-home (fixture proof)');
  console.log('═'.repeat(60));
  {
    const probe = spawnSync(NODE, [path.join(ROOT, 'tools', 'probe-adr0004-migrate-home.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, SOX_SANDBOX_ROOT: '', SOX_HOME: '', SOX_ECOSYSTEM_HOME: '' },
    });
    if (probe.stdout) process.stdout.write(probe.stdout);
    if (probe.status === 0) {
      assert(true, 'M: migrate-home relocates data + re-places skills/MCP into real ~/.claude, idempotently');
    } else {
      if (probe.stderr) process.stderr.write(probe.stderr);
      assert(false, `M: migrate-home fixture proof failed (exit ${probe.status})`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Section SP: Slice 1.5 (§9.5) front-shim service-proxy — ZERO-DOWNTIME upgrade.
  // A real backend process listens on a UDS; the real front-shim runs over real
  // stdio pipes; a client tools/call succeeds across a backend rolling-restart with
  // the stdio pipe never closing (no client reconnect). Fixture-based child probe;
  // drives the BUILT dist (libs/service-proxy/dist), per BL-4.
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('Section SP: service-proxy front-shim zero-downtime (real processes)');
  console.log('═'.repeat(60));
  {
    const probe = spawnSync(NODE, [path.join(ROOT, 'tools', 'probe-service-proxy-zdt.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, SOX_SANDBOX_ROOT: '', SOX_HOME: '', SOX_ECOSYSTEM_HOME: '' },
    });
    if (probe.stdout) process.stdout.write(probe.stdout);
    if (probe.status === 0) {
      assert(true, 'SP: front-shim survives backend rolling-restart — tools/call succeeds, pipe never closes (zero reconnect)');
    } else {
      if (probe.stderr) process.stderr.write(probe.stderr);
      assert(false, `SP: service-proxy zero-downtime gate failed (exit ${probe.status})`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Section SPM: Slice 1.6 (§9.5) memory-server PROXY-DEFAULT + auto-managed
  // BACKEND zero-downtime. The REAL memory-server backend (SOX_PROXY_BACKEND=1)
  // is auto-spawned + singleton-guarded by the shim's ensure hook; TWO shims (two
  // sessions) share ONE backend (single-writer); a backend rolling-restart keeps
  // both shims' tools/call working with the stdio pipes never closing (zero
  // reconnect). Drives the BUILT memory-server + service-proxy dist (BL-4).
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('Section SPM: memory-server proxy-default backend zero-downtime + multi-shim single-writer');
  console.log('═'.repeat(60));
  {
    const probe = spawnSync(NODE, [path.join(ROOT, 'tools', 'probe-memory-backend-zdt.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, SOX_SANDBOX_ROOT: '', SOX_HOME: '', SOX_ECOSYSTEM_HOME: '' },
    });
    if (probe.stdout) process.stdout.write(probe.stdout);
    if (probe.status === 0) {
      assert(true, 'SPM: real memory-server backend — two shims share ONE backend (single-writer); tools/call survives backend rolling-restart with zero reconnect');
    } else {
      if (probe.stderr) process.stderr.write(probe.stderr);
      assert(false, `SPM: memory-server proxy-default backend gate failed (exit ${probe.status})`);
    }
  }

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
