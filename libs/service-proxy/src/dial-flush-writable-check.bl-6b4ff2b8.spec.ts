/**
 * dial-flush-writable-check.bl-6b4ff2b8.spec.ts — BL-6b4ff2b8: a synchronous
 * EPIPE mid-drain must not hang the process forever.
 *
 * THE REAL DEFECT (confirmed empirically against the pre-fix source,
 * df7b4595:libs/service-proxy/src/dial.ts — NOT a downgraded "wasted CPU"
 * characterization). `net.Socket.writable` flips to `false` SYNCHRONOUSLY
 * the instant `destroy()` is called — well before the async 'close' event
 * fires and dial.ts's `socket` variable is nulled out. The pre-fix
 * `flushQueue()` was:
 *
 *   function flushQueue(): void {
 *     if (!socket) return;
 *     while (queue.length > 0 && socket) {
 *       const p = queue.shift();
 *       if (!p) break;
 *       writeToBackend(p);
 *     }
 *   }
 *
 * and `writeToBackend` re-`queue.push(p)`es whenever `!socket.writable`. A
 * synchronous EPIPE surfaced by `socket.write()` (inside `writeToBackend`,
 * called from within this same loop) destroys the socket, but `socket` in
 * the closure stays non-null and the loop's ONLY exit conditions are
 * `queue.length === 0` (never true — every item removed is immediately
 * re-added) or `!socket` (never true — nothing here nulls it, and the async
 * 'close' handler that would CANNOT run: this loop never yields, so it holds
 * the ONLY thread there is, forever). The loop spins shift->push->shift->push
 * on the same items, unbounded, at 100% CPU — this IS the incident signature
 * (`sample <pid> 3` showed 100% of a 3s window inside
 * `PipeWrap::AfterConnect -> ArrayPrototypeShift`).
 *
 * MEASURED (2026-09-29, this investigation): a 200-item backlog with a
 * synthetic EPIPE at the 5th write, run against the exact df7b4595 source in
 * a real subprocess — `timeout 15 node --import tsx <repro>` — never
 * returned (exit 124, `ps` showed the node process pinned at 99.4% CPU for
 * the entire window). The SAME repro against this fix's `dial.ts` exits 0 in
 * under a second.
 *
 * WHY A SUBPROCESS TEST (same reasoning as dial-unref.spec.ts). A hang here
 * is a true infinite synchronous loop: it never yields, so nothing else on
 * that thread — including vitest's own test-timeout enforcement, which is
 * itself cooperative (a `setTimeout`) — can ever run. An in-process
 * regression of this exact bug would not fail the test; it would freeze the
 * ENTIRE vitest worker with no way for the test framework to intervene. A
 * subprocess lets the PARENT enforce a real, OS-level bound (kill the child)
 * regardless of what the child's own event loop is doing.
 *
 * This is why the fix in BL-6b4ff2b8 is two things together, not one: the
 * O(1) `Deque` (fixes unbounded quadratic cost) AND the `maxItemsPerTick` +
 * `setImmediate` yield AND the `socket.writable` check in `drainQueueChunk`
 * (fixes the actual infinite-loop hazard — without the `socket.writable`
 * check, EVEN a Deque-backed, chunked drain still spins non-productively for
 * up to `maxItemsPerTick` iterations per tick once the socket dies, though it
 * no longer hangs forever because chunking always yields between chunks,
 * letting the async 'close' handler eventually run).
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SRC_DIR = __dirname;
const INDEX_TS = pathToFileURL(path.resolve(SRC_DIR, 'index.ts')).href;
const TSX_CLI = require.resolve('tsx/cli');
const REPO_ROOT = path.resolve(SRC_DIR, '..', '..', '..');

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function tmpSock(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-dial-epipe-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, `${name}.sock`);
}

/**
 * Write the repro script: a bare consumer that starts its OWN backend,
 * patches `net.Socket.prototype.write` to synchronously destroy the socket
 * (simulating EPIPE) on the 5th request write, sends a 200-request backlog,
 * and prints `DONE` once every request has resolved (or hangs forever if the
 * defect this test guards against has regressed).
 */
function writeRepro(dir: string): string {
  const scriptPath = path.join(dir, 'epipe-repro.mjs');
  fs.writeFileSync(
    scriptPath,
    [
      `const mod = await import(process.env.DIAL_TEST_INDEX);`,
      `const net = await import('node:net');`,
      `const N = 200;`,
      `let writeCallCount = 0;`,
      `let epipeFired = false;`,
      `const origWrite = net.default.Socket.prototype.write;`,
      `net.default.Socket.prototype.write = function patchedWrite(chunk, ...rest) {`,
      `  const isRequestFrame = (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)).includes('"method"');`,
      `  if (isRequestFrame) {`,
      `    writeCallCount++;`,
      `    if (writeCallCount === 5 && !epipeFired) {`,
      `      epipeFired = true;`,
      `      this.destroy(new Error('simulated EPIPE'));`,
      `      return false;`,
      `    }`,
      `  }`,
      `  return origWrite.call(this, chunk, ...rest);`,
      `};`,
      `const conn = mod.dialBackend({`,
      `  socketPath: process.env.DIAL_TEST_SOCK,`,
      `  onDiagnostic: () => {},`,
      `  backoff: { initialMs: 20, maxMs: 40, giveUpAfterMs: 30000, maxQueue: N + 10 },`,
      `});`,
      `const sends = [];`,
      `for (let i = 0; i < N; i++) sends.push(conn.send({ jsonrpc: '2.0', id: i, method: 'ping' }));`,
      `const backend = await mod.serveBackend({`,
      `  socketPath: process.env.DIAL_TEST_SOCK,`,
      `  onDiagnostic: () => {},`,
      `  handler: (req) => ({ jsonrpc: '2.0', id: req.id ?? null, result: { ok: true } }),`,
      `});`,
      `const results = await Promise.all(sends);`,
      `if (results.some((r) => r.error)) {`,
      `  process.stderr.write('BAD: ' + JSON.stringify(results.find((r) => r.error)) + '\\n');`,
      `  process.exit(3);`,
      `}`,
      `conn.close();`,
      `await backend.close();`,
      `process.stderr.write('DONE\\n');`,
      '',
    ].join('\n'),
    'utf8',
  );
  return scriptPath;
}

function spawnRepro(scriptPath: string, socketPath: string): {
  exit: Promise<number | null>;
  stderr: () => string;
  kill: () => void;
} {
  const child = spawn(process.execPath, [TSX_CLI, scriptPath], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} --import tsx`.trim(),
      DIAL_TEST_INDEX: INDEX_TS,
      DIAL_TEST_SOCK: socketPath,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString('utf8');
  });
  const exit = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
    child.on('error', () => resolve(-1));
  });
  cleanups.push(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  return {
    exit,
    stderr: () => stderr,
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
  };
}

/** Bounded wait; `-999` means the child HUNG and was forcibly killed. */
async function awaitExitBounded(
  repro: { exit: Promise<number | null>; kill: () => void },
  ms: number,
): Promise<number | null> {
  return Promise.race([
    repro.exit,
    new Promise<number | null>((resolve) => {
      setTimeout(() => {
        repro.kill();
        resolve(-999);
      }, ms);
    }),
  ]);
}

describe('BL-6b4ff2b8 — a mid-drain synchronous EPIPE does not hang the process', () => {
  it(
    'a 200-request backlog completes after a synthetic EPIPE at the 5th write — no hang',
    async () => {
      const sock = tmpSock('epipe');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-dial-epipe-client-'));
      cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
      const scriptPath = writeRepro(dir);

      const repro = spawnRepro(scriptPath, sock);
      const code = await awaitExitBounded(repro, 20_000);
      process.stderr.write(`[dial-epipe] exit=${code} stderr=${repro.stderr()}\n`);

      // RED against the pre-fix source (verified directly, 2026-09-29: `timeout
      // 15 node --import tsx <this exact repro against df7b4595's dial.ts>`
      // never returned — exit 124, `ps` showed the process pinned at 99.4% CPU
      // for the whole window): the child would never exit, so `code` here
      // would be -999 (forcibly killed after the bound).
      expect(code, `must not hang (child killed after bound); stderr=${repro.stderr()}`).not.toBe(-999);
      expect(code, repro.stderr()).toBe(0);
      expect(repro.stderr()).toContain('DONE');
    },
    30_000,
  );
});
