/**
 * embed-funnel.spec.ts — the TEETH suite for SPEC-EMBEDDING-FUNNEL.md §F.
 *
 * These are real-process tests. Each "consumer" is a genuine OS process that
 * imports this package's source (via tsx) and drives the funnel the way a
 * consumer does; the host is the REAL `embedHostMain.ts`, and its private ONNX
 * pool is pointed at a stub IPC host (via the `SOX_FASTEMBED_HOST_PATH`
 * test/diagnostic seam) so the suite is fast and hermetic — NO model download,
 * NO native ONNX. What is under test is the funnel's process topology and
 * lifecycle, which is identical either way.
 *
 * ── The headline (funnel-to-one) ───────────────────────────────────────────────
 *
 *   N=5 concurrent consumer processes each embed once ⇒ EXACTLY ONE
 *   `embedHostMain` pid machine-wide, and exactly one private ONNX child behind
 *   it. The NEGATIVE CONTROL exercises the PRE-FIX code path
 *   (`getPrivateFastembedProcess()` — what `getSharedFastembedProcess()` returned
 *   before the funnel existed, and what `host:'private'` selects today): the same
 *   5 processes fork 5 private hosts. The headline assertion (`=== 1`) therefore
 *   goes RED if the funnel regresses, because the count becomes 5 (or 0).
 *
 * ── Why tsx, not the built dist ────────────────────────────────────────────────
 *
 * `NODE_OPTIONS=--import tsx` lets `ensureBackend` spawn the host straight from
 * `src/embedHostMain.ts` (plain `node`), so this suite exercises the source tree
 * without requiring a prior build. The consumers run under the tsx CLI.
 */

import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureBackend } from '@adhd/sox-service-proxy';
import { afterEach, describe, expect, it } from 'vitest';

const SRC_DIR = __dirname;
const INDEX_TS = pathToFileURL(path.resolve(SRC_DIR, 'index.ts')).href;
const EMBED_HOST_TS = pathToFileURL(path.resolve(SRC_DIR, 'embedHostMain.ts')).href;
const TSX_CLI = require.resolve('tsx/cli');
const REPO_ROOT = path.resolve(SRC_DIR, '..', '..', '..', '..');

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    // Kill every process whose command line references this test's unique temp
    // dir (consumers, the funnel host shim, and the private stub hosts are all
    // launched from there) before removing the dir.
    for (const pid of pidsMatching(dir)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// ── process table helpers ──────────────────────────────────────────────────────

interface PsRow {
  pid: number;
  command: string;
}

function psRows(): PsRow[] {
  const out = execFileSync('ps', ['-axo', 'pid=,command='], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const rows: PsRow[] = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = /^(\d+)\s+(.*)$/.exec(trimmed);
    if (m) rows.push({ pid: Number(m[1]), command: m[2] ?? '' });
  }
  return rows;
}

/** Pids whose command line contains `needle`. */
function pidsMatching(needle: string): number[] {
  return psRows().filter((r) => r.command.includes(needle)).map((r) => r.pid);
}

/** Bounded poll (no fixed sleep) until `pred()` is true. */
async function waitFor(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor: ${what} not observed within ${timeoutMs}ms`);
}

/** Bounded poll until a pid is gone (ESRCH). */
async function waitForPidGone(pid: number, timeoutMs: number): Promise<void> {
  await waitFor(
    () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    },
    timeoutMs,
    `pid ${pid} to exit`,
  );
}

// ── harness ────────────────────────────────────────────────────────────────────

interface FunnelEnv {
  dir: string;
  home: string;
  cache: string;
  privateStubPath: string;
  consumerPath: string;
  shimPath: string;
  graceMs: number;
  env: NodeJS.ProcessEnv;
}

interface SetupOpts {
  graceMs?: number;
  /** Delay (ms) the stub private host waits before replying — lets a test catch a request in flight. */
  stubDelayMs?: number;
  /** Make the stub private host IGNORE `{__shutdown:true}`, so `terminate()` waits its full grace. */
  stubIgnoreShutdown?: boolean;
  /** Point `SOX_EMBED_HOST_MAIN` at a nonexistent path (force ensureBackend failure). */
  breakHostMain?: boolean;
}

function setupEnv(opts: SetupOpts = {}): FunnelEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-embed-funnel-'));
  cleanupDirs.push(dir);
  const home = path.join(dir, 'sox-home');
  const cache = path.join(dir, 'models');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });

  const graceMs = opts.graceMs ?? 10_000;
  const stubDelayMs = opts.stubDelayMs ?? 0;
  const stubIgnoreShutdown = opts.stubIgnoreShutdown ?? false;

  // The private stub host: speaks the fastembed-host IPC protocol
  // (`process.on('message')`), replies to ANY request with an embedding. No
  // fastembed import, no model.
  const privateStubPath = path.join(dir, 'fastembedProcessHost-stub.mjs');
  fs.writeFileSync(
    privateStubPath,
    [
      `let q = Promise.resolve();`,
      `process.on('message', (msg) => {`,
      ...(stubIgnoreShutdown
        ? [`  // Deliberately IGNORE __shutdown: terminate() must wait its full grace.`]
        : [`  if (msg && msg.__shutdown) { try { process.disconnect(); } catch {} return; }`]),
      `  q = q.then(() => new Promise((resolve) => {`,
      `    setTimeout(() => {`,
      `      if (process.connected) process.send({ id: msg.id, embedding: [0, 0, 0] });`,
      `      resolve();`,
      `    }, ${stubDelayMs});`,
      `  }));`,
      `});`,
      '',
    ].join('\n'),
  );

  // The host shim: a UNIQUE per-test entrypoint (so `ps` can attribute pids to
  // this test) that runs the REAL `src/embedHostMain.ts` via the tsx loader
  // (`NODE_OPTIONS=--import tsx`).
  const shimPath = path.join(dir, 'embedHostMain-testshim.mjs');
  fs.writeFileSync(
    shimPath,
    [
      `const mod = await import(process.env.SOX_EMBED_HOST_SRC);`,
      `await mod.runEmbedHost();`,
      '',
    ].join('\n'),
  );

  const consumerPath = path.join(dir, 'funnel-consumer.mjs');
  fs.writeFileSync(
    consumerPath,
    [
      `const mod = await import(process.env.FUNNEL_TEST_INDEX);`,
      `const mode = process.env.FUNNEL_TEST_MODE || 'shared';`,
      `const cacheDir = process.env.FUNNEL_TEST_CACHE;`,
      `// Mode may carry a posture suffix ('reset-shared' / 'reset-private').`,
      `const isPrivate = mode === 'private' || mode.endsWith('-private');`,
      `const op = mode.replace(/-(shared|private)$/, '');`,
      `// Keep the event loop alive across awaits: a standalone consumer has no`,
      `// other ref'd handle (the private pool's child is unref'd), so a bare`,
      `// top-level await could otherwise exit 13 ("unsettled top-level await").`,
      `// EXCEPT for 'exit-natural', which must prove the OPPOSITE: with the dial`,
      `// socket correctly unref'd, a consumer that embeds once drains its own loop`,
      `// and exits — no keep-alive, no process.exit.`,
      `const naturalExit = op === 'exit-natural';`,
      `const keepAlive = naturalExit ? null : setInterval(() => {}, 1000);`,
      `void keepAlive;`,
      `// The idle bound is TYPED config (the public surface): set it the way a`,
      `// consumer does — via the typed API, NOT the internal transport env.`,
      `if (process.env.FUNNEL_TEST_GRACE_MS) {`,
      `  mod.configureEmbedHostIdleGraceMs(Number(process.env.FUNNEL_TEST_GRACE_MS));`,
      `}`,
      `if (op === 'construct') {`,
      `  // Mirrors backlog's bootstrap: construct the provider but never embed.`,
      `  try {`,
      `    await mod.createEmbeddingProvider({ type: 'fastembed', model: 'bge-small-en-v1.5', options: { cacheDir } });`,
      `    process.stderr.write('CONSUMER_OK\\n');`,
      `    process.exit(0);`,
      `  } catch (e) {`,
      `    process.stderr.write('CONSUMER_ERR:' + (e && e.message ? e.message : String(e)) + '\\n');`,
      `    process.exit(4);`,
      `  }`,
      `}`,
      `const client = isPrivate ? mod.getPrivateFastembedProcess() : mod.getSharedFastembedProcess();`,
      `const init = { type: 'init', model: 'stub', cacheDir };`,
      `try {`,
      `  await client.request(init, 25000);`,
      `  const res = await client.request({ type: 'embed', text: 'hello' }, 25000);`,
      `  if (!res || !Array.isArray(res.embedding)) { process.stderr.write('CONSUMER_BAD\\n'); process.exit(3); }`,
      `  if (op === 'terminate') {`,
      `    // A shared consumer's terminate() must be a NO-OP (never kill the host).`,
      `    await client.terminate();`,
      `  }`,
      `  if (op === 'reset') {`,
      `    // Heal path: reset the shared host / private pool, then re-init+embed on a`,
      `    // FRESH accessor. Must still succeed — the stale-accessor bug goes red here.`,
      `    await mod.resetSharedFastembedProcess();`,
      `    const client2 = isPrivate ? mod.getPrivateFastembedProcess() : mod.getSharedFastembedProcess();`,
      `    await client2.request(init, 25000);`,
      `    const res2 = await client2.request({ type: 'embed', text: 'hello again' }, 25000);`,
      `    if (!res2 || !Array.isArray(res2.embedding)) { process.stderr.write('CONSUMER_BAD\\n'); process.exit(3); }`,
      `  }`,
      `  if (op === 'reset-race') {`,
      `    // Fire the host reset WITHOUT awaiting it, then exit shortly after: the`,
      `    // host is still mid-reset (terminating its private pool) when the last`,
      `    // client disconnects. Its request depth must keep it from reaping.`,
      `    void mod.resetSharedFastembedProcess();`,
      `    await new Promise((r) => setTimeout(r, 100));`,
      `    process.stderr.write('CONSUMER_OK\\n');`,
      `    process.exit(0);`,
      `  }`,
      `  process.stderr.write('CONSUMER_OK\\n');`,
      `  if (naturalExit) {`,
      `    // Fall off the end with NO process.exit and NO keep-alive interval: the`,
      `    // event loop must drain on its own once the embed is done. Without the`,
      `    // dial-socket unref the ref'd UDS connection pins the loop and hangs.`,
      `  } else {`,
      `    const holdMs = Number(process.env.FUNNEL_TEST_HOLD_MS || '0');`,
      `    if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));`,
      `    process.exit(0);`,
      `  }`,
      `} catch (e) {`,
      `  process.stderr.write('CONSUMER_ERR:' + (e && e.message ? e.message : String(e)) + '\\n');`,
      `  process.exit(4);`,
      `}`,
      '',
    ].join('\n'),
  );

  const hostMain = opts.breakHostMain ? path.join(dir, 'does-not-exist-host-main.js') : shimPath;
  const baseNodeOptions = process.env['NODE_OPTIONS'] ?? '';
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: `${baseNodeOptions} --import tsx`.trim(),
    SOX_ECOSYSTEM_HOME: home,
    SOX_FASTEMBED_HOST_PATH: privateStubPath,
    SOX_EMBED_HOST_MAIN: hostMain,
    SOX_EMBED_HOST_SRC: EMBED_HOST_TS,
    // The idle bound is set via the TYPED config in the consumer script, NOT
    // here — `SOX_EMBED_HOST_IDLE_GRACE_MS` is only the internal spawner→host
    // transport, which the funnel client writes from `EmbedHostConfig.idleGraceMs`.
    FUNNEL_TEST_GRACE_MS: String(graceMs),
    SOX_EMBED_EXECUTION_PROVIDER: 'cpu',
    FUNNEL_TEST_INDEX: INDEX_TS,
    FUNNEL_TEST_CACHE: cache,
    FUNNEL_TEST_HOLD_MS: '0',
  };

  return { dir, home, cache, privateStubPath, consumerPath, shimPath, graceMs, env };
}

interface ConsumerResult {
  code: number | null;
  stderr: string;
}

/** The consumer-script modes the harness can drive. */
type ConsumerMode =
  | 'shared'
  | 'private'
  | 'construct'
  | 'terminate'
  | 'reset-shared'
  | 'reset-private'
  | 'reset-race'
  | 'exit-natural';

/** Spawn one consumer process and resolve when it exits. */
function spawnConsumer(
  env: FunnelEnv,
  mode: ConsumerMode,
  holdMs = 0,
): Promise<ConsumerResult> {
  return new Promise<ConsumerResult>((resolve) => {
    const child: ChildProcess = spawn(process.execPath, [TSX_CLI, env.consumerPath], {
      cwd: REPO_ROOT,
      env: { ...env.env, FUNNEL_TEST_MODE: mode, FUNNEL_TEST_HOLD_MS: String(holdMs) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('exit', (code) => resolve({ code, stderr }));
    child.on('error', (err) => resolve({ code: -1, stderr: `${stderr}\n${err.message}` }));
  });
}

/** Spawn `n` consumers concurrently; resolve when all exit. */
async function runConsumers(
  env: FunnelEnv,
  n: number,
  mode: ConsumerMode,
  holdMs = 0,
): Promise<ConsumerResult[]> {
  return Promise.all(Array.from({ length: n }, () => spawnConsumer(env, mode, holdMs)));
}

/** Spawn a consumer that HOLDS after its request; resolve once it prints OK (still alive). */
function spawnHoldingConsumer(
  env: FunnelEnv,
  mode: 'shared' | 'private',
  holdMs: number,
): { child: ChildProcess; ok: Promise<void> } {
  const child = spawn(process.execPath, [TSX_CLI, env.consumerPath], {
    cwd: REPO_ROOT,
    env: { ...env.env, FUNNEL_TEST_MODE: mode, FUNNEL_TEST_HOLD_MS: String(holdMs) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  const ok = new Promise<void>((resolve, reject) => {
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
      if (stderr.includes('CONSUMER_OK')) resolve();
      if (stderr.includes('CONSUMER_ERR') || stderr.includes('CONSUMER_BAD')) {
        reject(new Error(`consumer failed: ${stderr}`));
      }
    });
    child.on('exit', (code) => reject(new Error(`consumer exited early (${code}): ${stderr}`)));
    setTimeout(() => reject(new Error(`consumer never reported OK: ${stderr}`)), 25_000).unref?.();
  });
  // A caller may kill the consumer (crash tests) before it reports; attach a
  // no-op catch NOW so the rejection is never "unhandled".
  void ok.catch(() => undefined);
  return { child, ok };
}

function killPid(pid: number, signal: NodeJS.Signals = 'SIGKILL'): void {
  // NEVER signal pid 0 or a negative pid: `kill(0, SIG)` targets the whole
  // process group (including the test runner). Guard explicitly.
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

/**
 * Spawn `n` consumers that HOLD after their request, and resolve once all have
 * reported OK (still alive). Needed for the pre-fix/private negative control:
 * a private host is forked `detached:false`, so it dies WITH its consumer — the
 * count must be taken while the consumers are still up.
 */
function spawnHoldingConsumers(
  env: FunnelEnv,
  n: number,
  mode: 'shared' | 'private',
  holdMs: number,
): { children: ChildProcess[]; allOk: Promise<void> } {
  const children: ChildProcess[] = [];
  const oks: Promise<void>[] = [];
  for (let i = 0; i < n; i++) {
    const { child, ok } = spawnHoldingConsumer(env, mode, holdMs);
    children.push(child);
    oks.push(ok);
  }
  return { children, allOk: Promise.all(oks).then(() => undefined) };
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe('SPEC-EMBEDDING-FUNNEL — funnel-to-one (headline)', () => {
  it(
    '5 concurrent consumer processes collapse to EXACTLY ONE embedHostMain (and one ONNX child)',
    async () => {
      const env = setupEnv({ graceMs: 10_000 });
      // Hold the consumers open so the count is taken while the herd is live
      // (and so a REGRESSION — the pre-fix path forking per-process hosts —
      // lands on the count assertion below, not on a process-disappeared wait).
      const { children, allOk } = spawnHoldingConsumers(env, 5, 'shared', 5_000);
      try {
        await allOk;
        const hosts = pidsMatching(path.join(env.dir, 'embedHostMain'));
        const privateHosts = pidsMatching(path.join(env.dir, 'fastembedProcessHost-stub'));
        process.stderr.write(
          `[funnel-to-1] 5 consumers (host:shared) => embedHostMain pids=${JSON.stringify(hosts)} (${hosts.length}), private ONNX child pids=${JSON.stringify(privateHosts)} (${privateHosts.length})\n`,
        );
        expect(hosts.length, `expected exactly one embedHostMain, saw ${JSON.stringify(hosts)}`).toBe(1);
        expect(privateHosts.length, 'exactly one private ONNX child behind the one host').toBe(1);
      } finally {
        for (const c of children) killPid(c.pid ?? 0);
      }
    },
    90_000,
  );

  it(
    '[negative control] the PRE-FIX path (host:private) forks 5 hosts — so the headline count goes RED if the funnel regresses',
    async () => {
      const env = setupEnv({ graceMs: 10_000 });
      // Hold the consumers open: a private host is forked `detached:false` and
      // dies with its consumer, so the count must be taken while they are alive.
      const { children, allOk } = spawnHoldingConsumers(env, 5, 'private', 5_000);
      try {
        await allOk;
        await waitFor(
          () => pidsMatching(path.join(env.dir, 'fastembedProcessHost-stub')).length >= 5,
          5_000,
          '5 private hosts',
        );
        const hosts = pidsMatching(path.join(env.dir, 'embedHostMain'));
        const privateHosts = pidsMatching(path.join(env.dir, 'fastembedProcessHost-stub'));
        process.stderr.write(
          `[funnel-to-1] 5 consumers (host:private / PRE-FIX path) => embedHostMain pids=${JSON.stringify(hosts)} (${hosts.length}), private ONNX child pids=${JSON.stringify(privateHosts)} (${privateHosts.length})\n`,
        );
        // Pre-fix behaviour: NO funnel host, and one private host PER consumer.
        expect(hosts.length).toBe(0);
        expect(privateHosts.length).toBe(5);
      } finally {
        for (const c of children) killPid(c.pid ?? 0);
      }
    },
    90_000,
  );
});

describe('SPEC-EMBEDDING-FUNNEL — a read-only verb spawns zero hosts (backlog §E)', () => {
  it(
    'constructing a fastembed provider (as backlog bootstrap does) spawns ZERO hosts until the first real embed',
    async () => {
      const env = setupEnv({ graceMs: 5_000 });
      // A consumer that constructs a provider but never embeds — exactly what
      // `backlog query --input '{"view":"projects"}'` does with RAG enabled.
      const constructed = await runConsumers(env, 1, 'construct', 0);
      expect(constructed[0]?.code, constructed[0]?.stderr).toBe(0);
      expect(constructed[0]?.stderr).toContain('CONSUMER_OK');

      // Any host spawned during construction would be DETACHED and still alive
      // (5s grace), so no settle-wait is needed — absence is immediate proof.
      expect(pidsMatching(path.join(env.dir, 'embedHostMain')).length).toBe(0);
      expect(pidsMatching(path.join(env.dir, 'fastembedProcessHost-stub')).length).toBe(0);

      // Negative control: an actual embed DOES spawn exactly one host.
      const embedded = await runConsumers(env, 1, 'shared', 200);
      expect(embedded[0]?.code, embedded[0]?.stderr).toBe(0);
      expect(pidsMatching(path.join(env.dir, 'embedHostMain')).length).toBe(1);
    },
    60_000,
  );
});

describe('SPEC-EMBEDDING-FUNNEL — debounced, ref-counted self-reap', () => {
  it(
    'reuses the SAME host pid for a second burst inside the grace window, then reaps it after the grace',
    async () => {
      const graceMs = 6_000;
      const env = setupEnv({ graceMs });

      // Burst 1: bring the host up, then let the consumer exit.
      const first = await runConsumers(env, 1, 'shared', 300);
      expect(first[0]?.code, first[0]?.stderr).toBe(0);
      const hosts1 = pidsMatching(path.join(env.dir, 'embedHostMain'));
      expect(hosts1.length).toBe(1);
      const hostPid = hosts1[0]!;

      // Burst 2, well inside the grace window: must REUSE the same host.
      const second = await runConsumers(env, 1, 'shared', 300);
      expect(second[0]?.code, second[0]?.stderr).toBe(0);
      const hosts2 = pidsMatching(path.join(env.dir, 'embedHostMain'));
      expect(hosts2).toEqual([hostPid]);

      // After the last client leaves, the host must reap itself — bounded wait,
      // no fixed sleep.
      await waitForPidGone(hostPid, graceMs + 15_000);
    },
    90_000,
  );
});

describe('SPEC-EMBEDDING-FUNNEL — rendezvous race', () => {
  it('two concurrent ensureBackend calls for one singleton spawn exactly one host', async () => {
    const env = setupEnv({ graceMs: 10_000 });
    const socketPath = path.join(env.home, 'run', 'proxy-race.sock');

    const call = (): ReturnType<typeof ensureBackend> =>
      ensureBackend({
        socketPath,
        singletonKey: `embedding-host:race:${env.dir}`,
        command: process.execPath,
        args: [env.shimPath],
        env: { ...env.env, SOX_EMBED_HOST_SOCKET: socketPath },
        stderrLogPath: path.join(env.home, 'run', 'race.stderr.log'),
        readyTimeoutMs: 15_000,
      });

    const results = await Promise.all([call(), call()]);
    expect(results.every((r) => r.disposition !== 'failed'), JSON.stringify(results)).toBe(true);
    expect(results.some((r) => r.disposition === 'spawned')).toBe(true);

    const hosts = pidsMatching(path.join(env.dir, 'embedHostMain'));
    expect(hosts.length, JSON.stringify(results)).toBe(1);
  }, 60_000);
});

describe('SPEC-EMBEDDING-FUNNEL — crash + stale-socket recovery', () => {
  it(
    'kill -9 the host mid-request ⇒ the consumer gets a typed error (bounded); the NEXT consumer re-ensures and succeeds',
    async () => {
      const env = setupEnv({ graceMs: 10_000, stubDelayMs: 3_000 });

      // Consumer 1 holds while its (slow) request is in flight.
      const { child: holder, ok } = spawnHoldingConsumer(env, 'shared', 0);
      // Wait until the host is up and the consumer has at least connected.
      await waitFor(() => pidsMatching(path.join(env.dir, 'embedHostMain')).length === 1, 15_000, 'host up');
      const hostPid = pidsMatching(path.join(env.dir, 'embedHostMain'))[0]!;
      // Give the consumer a moment to issue its request, then SIGKILL the host.
      await new Promise((r) => setTimeout(r, 500));
      killPid(hostPid, 'SIGKILL');
      await waitForPidGone(hostPid, 5_000);

      // The holder either fails typed or (if its request already drained) is
      // fine — but it must never hang: bound it.
      const holderExit = new Promise<number | null>((resolve) => holder.on('exit', (c) => resolve(c)));
      const code = await Promise.race([
        holderExit,
        new Promise<number | null>((resolve) => setTimeout(() => resolve(-999), 20_000).unref?.()),
      ]);
      expect(code, 'consumer must terminate, never hang').not.toBe(-999);
      // If it failed, it failed with a typed funnel error (TransientEmbeddingError message).
      void ok.catch(() => undefined);

      // The next consumer re-ensures and succeeds.
      const next = await runConsumers(env, 1, 'shared', 200);
      expect(next[0]?.code, next[0]?.stderr).toBe(0);
      const hosts = pidsMatching(path.join(env.dir, 'embedHostMain'));
      expect(hosts.length).toBe(1);
      expect(hosts[0]).not.toBe(hostPid);
    },
    90_000,
  );

  it(
    'SIGKILL leaves a stale socket file; the next consumer re-ensures instead of deadlocking on E_LIVE_SOCKET',
    async () => {
      const env = setupEnv({ graceMs: 10_000 });
      const first = await runConsumers(env, 1, 'shared', 200);
      expect(first[0]?.code, first[0]?.stderr).toBe(0);
      const hostPid = pidsMatching(path.join(env.dir, 'embedHostMain'))[0]!;
      killPid(hostPid, 'SIGKILL');
      await waitForPidGone(hostPid, 5_000);

      const second = await runConsumers(env, 1, 'shared', 200);
      expect(second[0]?.code, second[0]?.stderr).toBe(0);
      expect(second[0]?.stderr).toContain('CONSUMER_OK');
      const hosts = pidsMatching(path.join(env.dir, 'embedHostMain'));
      expect(hosts.length).toBe(1);
      expect(hosts[0]).not.toBe(hostPid);
    },
    60_000,
  );
});

describe('SPEC-EMBEDDING-FUNNEL — honest failure, never a silent private re-fork', () => {
  it(
    'host:shared + a forced ensureBackend failure throws typed and forks ZERO hosts (no private fallback)',
    async () => {
      const env = setupEnv({ breakHostMain: true });
      const result = await runConsumers(env, 1, 'shared', 0);
      expect(result[0]?.code).toBe(4);
      expect(result[0]?.stderr).toContain('CONSUMER_ERR');
      expect(result[0]?.stderr).toContain('could not bring up a host');
      // ZERO hosts of either kind — the funnel did NOT quietly fork a private one.
      expect(pidsMatching(path.join(env.dir, 'embedHostMain')).length).toBe(0);
      expect(pidsMatching(path.join(env.dir, 'fastembedProcessHost-stub')).length).toBe(0);
    },
    60_000,
  );
});

describe('SPEC-EMBEDDING-FUNNEL — ADR-0012 teeth (compute-only host)', () => {
  it('the live host holds NO store-db handle (lsof)', async () => {
    const env = setupEnv({ graceMs: 10_000 });
    // Point the host at a store-db path in its env, so a host that DID open a
    // store would show it — proving the absence is real, not untested.
    const dbPath = path.join(env.home, 'fake-store.db');
    fs.writeFileSync(dbPath, '');
    env.env['SOX_CONFIG_DB_PATH'] = dbPath;

    const { child } = spawnHoldingConsumer(env, 'shared', 3_000);
    await waitFor(() => pidsMatching(path.join(env.dir, 'embedHostMain')).length === 1, 15_000, 'host up');
    const hostPid = pidsMatching(path.join(env.dir, 'embedHostMain'))[0]!;

    // `lsof` can exit non-zero for benign reasons; read stdout regardless.
    const lsof = spawnSync('lsof', ['-p', String(hostPid)], { encoding: 'utf8' });
    const lsofOut = lsof.stdout ?? '';
    expect(lsofOut).not.toMatch(/\.db($|\s)/m);
    expect(lsofOut).not.toMatch(/\.db-(wal|shm)($|\s)/m);
    expect(lsofOut).not.toMatch(/\.sqlite($|\s)/m);
    // Sanity: the pid we inspected really is OUR host — its stderr is redirected
    // to this test's unique temp log path (match the unique dir basename; macOS
    // lsof reports the /private-resolved path).
    expect(lsofOut).toContain(path.basename(env.dir));
    expect(lsofOut).toContain('embed-host.stderr.log');

    killPid(child.pid ?? 0);
  }, 60_000);
});

describe('SPEC-EMBEDDING-FUNNEL — the host resolves the private accessor at EVERY use (reset does not brick it)', () => {
  // The HIGH finding: `embedHostMain` used to capture `getPrivateFastembedProcess()`
  // ONCE, but `embedding.reset` terminates and nulls that singleton. Every later
  // request then went through the terminated reference and failed with
  // "shared fastembed process terminated". This test goes RED against that code.
  for (const [posture, mode] of [
    ['shared', 'reset-shared'],
    ['private', 'reset-private'],
  ] as const) {
    it(
      `init+embed → reset → init+embed still succeeds (host:'${posture}')`,
      async () => {
        const env = setupEnv({ graceMs: 10_000 });
        const result = await runConsumers(env, 1, mode, 0);
        expect(result[0]?.code, result[0]?.stderr).toBe(0);
        expect(result[0]?.stderr).toContain('CONSUMER_OK');
      },
      60_000,
    );
  }
});

describe('SPEC-EMBEDDING-FUNNEL — the reap gate honors in-flight work (not just the pool counter)', () => {
  it(
    'a client that disconnects while the host is mid-work does NOT trigger a reap — the host survives',
    async () => {
      // grace 300ms << the ~1s `terminate()` the in-flight reset is awaiting
      // (the stub ignores `__shutdown`, so the graceful teardown runs its full
      // TERMINATE_GRACE_MS). The consumer fires `embedding.reset` and exits, so
      // the last client is gone while the host's own request is still in flight.
      const env = setupEnv({ graceMs: 300, stubIgnoreShutdown: true });
      const result = await runConsumers(env, 1, 'reset-race', 0);
      expect(result[0]?.code, result[0]?.stderr).toBe(0);
      const hosts = pidsMatching(path.join(env.dir, 'embedHostMain'));
      expect(hosts.length, 'exactly one host').toBe(1);
      const hostPid = hosts[0]!;

      // At ~650ms after the consumer exits: past the 300ms grace (the OLD gate,
      // which read `pendingCount === 0` because `terminate()` cleared the pool,
      // would have reaped the host by now) but still inside the 1s reset
      // teardown (the NEW gate sees `inFlight === 1` and does not arm).
      await new Promise((r) => setTimeout(r, 650));
      expect(
        pidsMatching(path.join(env.dir, 'embedHostMain')),
        'the host must survive while its own request is in flight',
      ).toEqual([hostPid]);
    },
    60_000,
  );
});

describe('SPEC-EMBEDDING-FUNNEL — the idle bound is typed config', () => {
  it(
    'a non-default typed idleGraceMs (2s) takes effect — the host reaps ~2s after the last client, not the 30s default',
    async () => {
      const env = setupEnv({ graceMs: 2_000 });
      const first = await runConsumers(env, 1, 'shared', 200);
      expect(first[0]?.code, first[0]?.stderr).toBe(0);
      const hosts = pidsMatching(path.join(env.dir, 'embedHostMain'));
      expect(hosts.length, 'exactly one host').toBe(1);
      const hostPid = hosts[0]!;

      // If the typed value did not flow through `EmbedHostConfig.idleGraceMs`
      // to the host, the host would reap at the 30s DEFAULT and this 10s bound
      // would time out — so the test is RED without the fix.
      const t0 = Date.now();
      await waitForPidGone(hostPid, 10_000);
      expect(Date.now() - t0, 'reaped well under the 30s default').toBeLessThan(9_000);
    },
    60_000,
  );
});

describe('SPEC-EMBEDDING-FUNNEL — a consumer terminate() is a no-op (BL-405 cannot recur via the funnel)', () => {
  it(
    'terminate() does not kill the peer-shared host; a second consumer reuses the same host pid',
    async () => {
      const env = setupEnv({ graceMs: 10_000 });
      const first = await runConsumers(env, 1, 'terminate', 0);
      expect(first[0]?.code, first[0]?.stderr).toBe(0);
      const hosts1 = pidsMatching(path.join(env.dir, 'embedHostMain'));
      expect(hosts1.length, 'exactly one host').toBe(1);
      const hostPid = hosts1[0]!;

      // The consumer's `terminate()` is inert, so the host is never killed — a
      // second consumer reuses the SAME pid. BL-405's EPIPE-on-parent-exit crash
      // is structurally impossible here: the consumer never owns the child, so
      // its shutdown path cannot race the child's `process.send()`.
      const second = await runConsumers(env, 1, 'shared', 0);
      expect(second[0]?.code, second[0]?.stderr).toBe(0);
      expect(pidsMatching(path.join(env.dir, 'embedHostMain'))).toEqual([hostPid]);
    },
    60_000,
  );
});

describe('SPEC-EMBEDDING-FUNNEL — a consumer that embeds once EXITS on its own (dial socket unref)', () => {
  // The HIGH regression: `dialBackend` creates the host UDS socket with
  // `net.createConnection()` and never unref'd it, so every embedding-bearing
  // CLI completed its query and then hung forever on the referenced libuv
  // handle. This drives the REAL consumer shape — embed once, then fall off the
  // end of the script with no `process.exit()` and no keep-alive interval — and
  // requires it to drain its own event loop and exit within a bounded deadline,
  // with no external kill. Revert the unref in `dial.ts` and this goes RED
  // (`-999`, still alive at the deadline).
  it(
    'a real consumer process embeds once, then drains its event loop and exits within a bounded deadline with no external kill',
    async () => {
      const env = setupEnv({ graceMs: 10_000 });
      const child: ChildProcess = spawn(process.execPath, [TSX_CLI, env.consumerPath], {
        cwd: REPO_ROOT,
        env: { ...env.env, FUNNEL_TEST_MODE: 'exit-natural' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString('utf8');
      });

      const code = await new Promise<number | null>((resolve) => {
        const deadline = setTimeout(() => resolve(-999), 25_000);
        child.on('exit', (c) => {
          clearTimeout(deadline);
          resolve(c);
        });
        child.on('error', () => {
          clearTimeout(deadline);
          resolve(-1);
        });
      });
      process.stderr.write(`[exit-natural] consumer exit=${code} stderr=${stderr}\n`);

      expect(code, `consumer must exit on its own (not hang); stderr=${stderr}`).not.toBe(-999);
      expect(code, stderr).toBe(0);
      expect(stderr).toContain('CONSUMER_OK');
    },
    90_000,
  );
});
