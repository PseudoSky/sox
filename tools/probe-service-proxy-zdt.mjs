/**
 * tools/probe-service-proxy-zdt.mjs — Slice 1.5 (§9.5) zero-downtime e2e probe.
 *
 * Proves the front-shim service-proxy at the OS/process boundary (not just in
 * in-memory streams): a REAL backend process listens on a UDS, the front-shim runs
 * in a REAL child `soxe`-style process over REAL stdio pipes, a client issues a
 * tools/call, the backend is ROLLING-RESTARTED (verified kill + respawn on the same
 * socket), and the client's next tools/call MUST succeed — answered by the NEW
 * backend version — with the stdio pipe NEVER closing (zero client reconnect).
 *
 * Run standalone; exits 0 on success, non-zero on failure. Driven as a child by
 * tools/test-e2e-lifecycle.js (the probe pattern used by the other sections).
 *
 * Uses the BUILT dist (libs/service-proxy/dist) — proving runtime behaviour against
 * the compiled artifact, per BL-4 (never a vitest run alone).
 */
import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'libs', 'service-proxy', 'dist', 'index.js');
const NODE = process.execPath;

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  PASS: ${msg}`);
  } else {
    console.error(`  FAIL: ${msg}`);
    failures++;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(DIST)) {
  console.error(`FATAL: built dist not found at ${DIST} — run \`npx nx build service-proxy\` first`);
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-proxy-zdt-'));
const sock = path.join(tmp, 'backend.sock');

/**
 * A real backend process: requires the built dist, calls serveBackend, and answers
 * tools/call with the version passed as argv[2]. Written to a temp .mjs so we spawn
 * a genuinely separate OS process (real restart, real pid).
 */
function backendSource() {
  return `
import { serveBackend } from ${JSON.stringify(DIST)};
const version = process.argv[2];
const socketPath = process.argv[3];
const TOOLS = { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }] };
const h = await serveBackend({
  socketPath,
  onDiagnostic: (l) => process.stderr.write(l + '\\n'),
  handler: (req) => {
    if (req.method === 'tools/list') return { jsonrpc: '2.0', id: req.id ?? null, result: TOOLS };
    if (req.method === 'initialize') return { jsonrpc: '2.0', id: req.id ?? null, result: { serverInfo: { name: 'probe', version }, capabilities: {} } };
    if (req.method === 'tools/call') return { jsonrpc: '2.0', id: req.id ?? null, result: { version, params: req.params } };
    return { jsonrpc: '2.0', id: req.id ?? null, result: null };
  },
});
process.stderr.write('backend ' + version + ' listening on ' + h.socketPath + '\\n');
process.on('SIGTERM', () => { h.close().finally(() => process.exit(0)); });
setInterval(() => {}, 1 << 30); // keep alive
`;
}

/** The front-shim process: requires the built dist, runs runFrontShim over stdio. */
function shimSource() {
  return `
import { runFrontShim } from ${JSON.stringify(DIST)};
const socketPath = process.argv[2];
const handle = runFrontShim({
  id: 'probe',
  socketPath,
  onDiagnostic: (l) => process.stderr.write(l + '\\n'),
  backoff: { initialMs: 20, maxMs: 80, giveUpAfterMs: 8000 },
});
await handle.done;
process.exit(0);
`;
}

const backendFile = path.join(tmp, 'backend.mjs');
const shimFile = path.join(tmp, 'shim.mjs');
fs.writeFileSync(backendFile, backendSource());
fs.writeFileSync(shimFile, shimSource());

/** Spawn a backend process at `version`; resolve once it reports listening. */
function startBackend(version) {
  return new Promise((resolve) => {
    const p = spawn(NODE, [backendFile, version, sock], { stdio: ['ignore', 'ignore', 'pipe'] });
    p.stderr.on('data', (b) => {
      if (b.toString().includes('listening')) resolve(p);
    });
  });
}

/** Verified stop: SIGTERM, wait for exit, confirm the pid is gone. */
function verifiedStop(proc) {
  return new Promise((resolve) => {
    proc.on('exit', () => resolve());
    proc.kill('SIGTERM');
    // Escalate if it lingers.
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
  });
}

async function main() {
  console.log('=== service-proxy zero-downtime probe (real processes) ===');
  console.log(`socket: ${sock}`);

  // 1. Start backend v1 + the shim child (over real stdio pipes).
  let backend = await startBackend('v1');
  assert(backend.pid > 0, `backend v1 started (pid ${backend.pid})`);

  const shim = spawn(NODE, [shimFile, sock], { stdio: ['pipe', 'pipe', 'pipe'] });
  let shimClosed = false;
  shim.on('exit', () => { shimClosed = true; });
  shim.stderr.on('data', () => { /* diagnostics; swallow */ });

  // Collect newline-delimited JSON-RPC responses from the shim's stdout.
  const responses = [];
  const waiters = [];
  let buf = '';
  shim.stdout.on('data', (chunk) => {
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
  const send = (req) => shim.stdin.write(JSON.stringify(req) + '\n');
  const next = (pred, timeoutMs = 6000) =>
    new Promise((resolve, reject) => {
      const hit = responses.find(pred);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error('timeout waiting for response')), timeoutMs);
      waiters.push({ pred, resolve: (o) => { clearTimeout(t); resolve(o); } });
    });

  // 2. Baseline tools/call against v1.
  send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { x: 1 } });
  const r1 = await next((r) => r.id === 1);
  assert(r1.result && r1.result.version === 'v1', `baseline tools/call answered by v1 (got ${r1.result?.version})`);

  // 3. ROLLING RESTART the backend to v2 (verified stop + respawn on same socket).
  await verifiedStop(backend);
  let pidGone = false;
  try { process.kill(backend.pid, 0); } catch { pidGone = true; }
  assert(pidGone, `backend v1 verified stopped (pid ${backend.pid} gone)`);
  backend = await startBackend('v2');
  assert(backend.pid > 0, `backend v2 respawned (pid ${backend.pid})`);

  // 4. The SAME client (no reconnect — stdin never closed) calls again. It MUST
  //    succeed and be answered by the NEW backend (v2) — zero downtime.
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { x: 2 } });
  const r2 = await next((r) => r.id === 2);
  assert(!r2.error, 'tools/call across backend restart returned NO error');
  assert(r2.result && r2.result.version === 'v2', `tools/call after restart answered by NEW backend v2 (got ${r2.result?.version})`);

  // 5. The stdio pipe to the client NEVER closed across the restart.
  assert(!shimClosed, 'shim stdio pipe to client never closed during the upgrade (no reconnect)');

  // Teardown.
  shim.stdin.end();
  await sleep(200);
  await verifiedStop(backend);
  try { shim.kill('SIGKILL'); } catch { /* gone */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log(`\nResult: ${failures === 0 ? 'PASS' : 'FAIL'} (${failures} failure(s))`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
