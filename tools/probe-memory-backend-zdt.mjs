/**
 * tools/probe-memory-backend-zdt.mjs — Slice 1.6 (§9.5) memory-server proxy-default
 * + auto-managed backend zero-downtime e2e probe (real processes).
 *
 * Proves the FULL M3→M4 bridge with the REAL memory-server backend:
 *   1. Two front-shims (two simulated MCP sessions) start over real stdio pipes,
 *      each with an `ensure` hook that spawns the REAL memory-server in BACKEND
 *      mode (SOX_PROXY_BACKEND=1) — singleton-guarded, so exactly ONE backend
 *      binds the store's UDS (single-writer).
 *   2. Each shim issues a real tools/call (memory_ping) → answered by the backend.
 *   3. The backend is ROLLING-RESTARTED (verified kill + the shim's ensure respawns
 *      it). Both shims' next tools/call MUST succeed with the stdio pipes NEVER
 *      closing (zero client reconnect).
 *   4. Single-writer is re-asserted after the restart: exactly ONE backend pid for
 *      the store.
 *
 * Drives the BUILT dist (libs/service-proxy/dist + memory-server/dist), per BL-4.
 * Run standalone; exits 0 on success. Driven as a child by test-e2e-lifecycle.js.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROXY_DIST = path.join(ROOT, 'libs', 'service-proxy', 'dist', 'index.js');
const MEM_DIST = path.join(
  ROOT,
  'extensions', 'bundles', 'sox-memory-bundle', 'members', 'memory-server', 'dist', 'index.js',
);
const MEM_SCHEMA = path.join(path.dirname(MEM_DIST), 'schema.json');
const NODE = process.execPath;

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  PASS: ${msg}`);
  else { console.error(`  FAIL: ${msg}`); failures++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const [label, p] of [['service-proxy', PROXY_DIST], ['memory-server', MEM_DIST], ['schema.json', MEM_SCHEMA]]) {
  if (!fs.existsSync(p)) {
    console.error(`FATAL: built ${label} not found at ${p} — build first (nx build service-proxy memory-server)`);
    process.exit(2);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-mem-zdt-'));
const memDir = path.join(tmp, 'memory');
fs.mkdirSync(memDir, { recursive: true });
const dbPath = path.join(memDir, 'memory.db');
const sock = path.join(tmp, 'backend.sock');
const lockDir = path.join(tmp, 'locks');
fs.mkdirSync(lockDir, { recursive: true });
// Each ensureBackend that ACTUALLY spawns records its pid here (one line per real
// spawn). This is test-scoped — it does NOT scan the global process table, so it
// cannot conflate this probe's backends with the user's live memory-server.
const spawnLog = path.join(tmp, 'spawned-pids.txt');
fs.writeFileSync(spawnLog, '');

const SINGLETON_KEY = `memory-server db:${dbPath}`;

/** Is a pid alive? */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Live backends THIS probe spawned (recorded in spawnLog), filtered to alive. */
function countLiveBackends() {
  let recorded = [];
  try {
    recorded = fs.readFileSync(spawnLog, 'utf8').trim().split('\n').filter(Boolean).map(Number);
  } catch { recorded = []; }
  return [...new Set(recorded)].filter(pidAlive);
}

/**
 * The shim child: runs runFrontShim over real stdio with an ensure hook that spawns
 * the REAL memory-server backend (singleton-guarded). Backend env carries the
 * db_path + the backend-mode signal + socket + schema.
 */
function shimSource() {
  return `
import { runFrontShim, ensureBackend } from ${JSON.stringify(PROXY_DIST)};
import * as fsm from 'node:fs';
const sock = ${JSON.stringify(sock)};
const key = ${JSON.stringify(SINGLETON_KEY)};
const memDist = ${JSON.stringify(MEM_DIST)};
const memSchema = ${JSON.stringify(MEM_SCHEMA)};
const dbPath = ${JSON.stringify(dbPath)};
const lockDir = ${JSON.stringify(lockDir)};
const spawnLog = ${JSON.stringify(spawnLog)};
const handle = runFrontShim({
  id: 'memory-server',
  socketPath: sock,
  schemaCachePath: memSchema,
  onDiagnostic: (l) => process.stderr.write(l + '\\n'),
  backoff: { initialMs: 30, maxMs: 150, giveUpAfterMs: 12000 },
  ensure: async () => {
    const r = await ensureBackend({
      socketPath: sock,
      singletonKey: key,
      command: process.execPath,
      args: ['--enable-source-maps', memDist],
      cwd: ${JSON.stringify(memDir)},
      lockDir,
      env: {
        ...process.env,
        SOX_PROXY_BACKEND: '1',
        SOX_PROXY_BACKEND_SOCKET: sock,
        SOX_PROXY_BACKEND_SCHEMA: memSchema,
        SOX_CONFIG_DB_PATH: dbPath,
        // No hash embedding backend exists (removed — see libs/memory-core/src/embed.ts:43,
        // EmbedBackend = 'auto' | 'real'). This probe does not override HOME, so
        // resolveConfig()'s default cacheDir (embed.ts:51-60) already resolves to this
        // machine's real, persistent ~/.cache/sox-memory/models — the bge-base-en-v1.5
        // ONNX model is loaded from cache, not re-downloaded, on every run.
        SOX_EMBED_BACKEND: 'real',
      },
      onDiagnostic: (l) => process.stderr.write('[ensure] ' + l + '\\n'),
      readyTimeoutMs: 12000,
    });
    // Record ONLY real spawns (test-scoped single-writer accounting).
    if (r.disposition === 'spawned' && r.pid) {
      fsm.appendFileSync(spawnLog, r.pid + '\\n');
    }
    process.stderr.write('[ensure] ' + r.disposition + ' — ' + r.detail + '\\n');
  },
});
await handle.done;
process.exit(0);
`;
}

const shimFile = path.join(tmp, 'shim.mjs');
fs.writeFileSync(shimFile, shimSource());

/** A client wrapper around one shim child over real stdio pipes. */
function makeShimClient(label) {
  const proc = spawn(NODE, [shimFile], { stdio: ['pipe', 'pipe', 'pipe'] });
  let closed = false;
  proc.on('exit', () => { closed = true; });
  proc.stderr.on('data', (b) => {
    // Surface ensure diagnostics for debugging (stderr only).
    const s = b.toString();
    if (process.env.PROBE_VERBOSE) process.stderr.write(`[${label}] ${s}`);
  });
  const responses = [];
  const waiters = [];
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const obj = JSON.parse(line);
      responses.push(obj);
      const i = waiters.findIndex((w) => w.pred(obj));
      if (i !== -1) waiters.splice(i, 1)[0].resolve(obj);
    }
  });
  return {
    proc,
    isClosed: () => closed,
    send: (req) => proc.stdin.write(JSON.stringify(req) + '\n'),
    next: (pred, timeoutMs = 14000) =>
      new Promise((resolve, reject) => {
        const hit = responses.find(pred);
        if (hit) return resolve(hit);
        const t = setTimeout(() => reject(new Error(`[${label}] timeout`)), timeoutMs);
        waiters.push({ pred, resolve: (o) => { clearTimeout(t); resolve(o); } });
      }),
    kill: () => { try { proc.kill('SIGKILL'); } catch { /* gone */ } },
  };
}

/** Verified-stop every live backend pid THIS probe spawned (scoped, not global). */
async function rollingRestartBackend() {
  const pids = countLiveBackends();
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  }
  // Wait for them to die.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (countLiveBackends().length === 0) break;
    await sleep(100);
  }
  // Force-kill any survivor.
  for (const pid of countLiveBackends()) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  // Remove the now-stale socket so the shim's ensure re-binds cleanly.
  try { if (fs.existsSync(sock)) fs.unlinkSync(sock); } catch { /* ignore */ }
}

async function main() {
  console.log('=== memory-server proxy-default backend zero-downtime probe ===');
  console.log(`db: ${dbPath}`);
  console.log(`socket: ${sock}`);

  // 1. Start TWO shims (two sessions). Each ensures the backend; singleton guard
  //    must collapse them to ONE backend.
  const a = makeShimClient('shimA');
  const b = makeShimClient('shimB');

  // 2. Both issue a real tools/call (memory_ping). The first triggers ensure →
  //    backend spawn; the second adopts the same backend.
  a.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_ping', arguments: {} } });
  b.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_ping', arguments: {} } });
  const ra1 = await a.next((r) => r.id === 1);
  const rb1 = await b.next((r) => r.id === 1);
  assert(!ra1.error && ra1.result?.content?.[0]?.text?.includes('ok'), 'shimA memory_ping answered by backend');
  assert(!rb1.error && rb1.result?.content?.[0]?.text?.includes('ok'), 'shimB memory_ping answered by backend');

  // 3. Single-writer: exactly ONE backend pid for the store.
  await sleep(300);
  const before = countLiveBackends();
  assert(before.length === 1, `exactly ONE backend for the store (single-writer); found ${before.length} [${before.join(',')}]`);

  // 4. ROLLING-RESTART the backend. The shims' ensure (on disconnect) respawns it.
  console.log('  rolling-restarting backend...');
  await rollingRestartBackend();
  // Nudge each shim so its dial layer notices the drop and re-ensures.
  a.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_ping', arguments: {} } });
  b.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_ping', arguments: {} } });

  // 5. Both calls MUST succeed across the restart with the pipes never closing.
  const ra2 = await a.next((r) => r.id === 2);
  const rb2 = await b.next((r) => r.id === 2);
  assert(!ra2.error && ra2.result?.content?.[0]?.text?.includes('ok'), 'shimA tools/call SUCCEEDS across backend restart (zero reconnect)');
  assert(!rb2.error && rb2.result?.content?.[0]?.text?.includes('ok'), 'shimB tools/call SUCCEEDS across backend restart (zero reconnect)');
  assert(!a.isClosed(), 'shimA stdio pipe NEVER closed during the upgrade');
  assert(!b.isClosed(), 'shimB stdio pipe NEVER closed during the upgrade');

  // 6. Single-writer holds after the restart.
  await sleep(300);
  const after = countLiveBackends();
  assert(after.length === 1, `exactly ONE backend after restart (single-writer); found ${after.length} [${after.join(',')}]`);

  // Teardown.
  a.proc.stdin.end();
  b.proc.stdin.end();
  await sleep(200);
  for (const pid of countLiveBackends()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  a.kill();
  b.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log(`\nResult: ${failures === 0 ? 'PASS' : 'FAIL'} (${failures} failure(s))`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  try {
    for (const pid of countLiveBackends()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  } catch { /* ignore */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
