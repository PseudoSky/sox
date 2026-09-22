/**
 * dial-unref.spec.ts — a `dialBackend` connection must not pin the event loop
 * open, and must not be unref'd so eagerly that it abandons an in-flight
 * request.
 *
 * THE DEFECT. A connected socket is a referenced libuv handle. `dialBackend`
 * used to leave it referenced forever, so a short-lived CLI that dials the
 * backend, gets its reply, and then has nothing else to do never exited — it
 * hung after its query completed. Under the embedding funnel this is the
 * reported HIGH: every embedding-bearing CLI dials the host over this socket
 * and then hangs.
 *
 * THE OPPOSITE ERROR. Unref'ing unconditionally is equally wrong. A standalone
 * consumer whose ONLY pending work is an in-flight `send()` has nothing else
 * referenced, so Node tears the process down mid-request before the reply
 * arrives — the `ensure-backend-await-survives` failure shape. Verified
 * empirically: an unref'd socket with a pending read does NOT hold the loop. So
 * the socket is REF'd while a request is outstanding and UNREF'd the instant it
 * drains.
 *
 * WHY A SUBPROCESS TEST. The defect is invisible in-process: vitest holds its
 * own referenced handles, so a leaked ref'd socket inside the module under test
 * never gets the chance to keep a bare process alive. Reproducing it REQUIRES a
 * bare node process whose only pending work is the dial — the exact shape of a
 * short-lived CLI. (Same reasoning as `ensure-backend-await-survives.spec.ts`.)
 *
 * The client script is a genuine consumer: it imports this package's SOURCE via
 * tsx, dials a REAL `serveBackend`, sends one request, prints the reply, and
 * then simply falls off the end of the script — no `process.exit()`, no
 * keep-alive interval. It must drain its own event loop and exit 0.
 *
 * TEETH. Revert the ref-count in `dial.ts` and both arms go RED:
 *   - the immediate arm HANGS (a ref'd socket never lets the loop drain), and
 *   - the delayed arm exits 13 with no reply (unref'd while a request is pending).
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { serveBackend, type BackendHandle } from './backend.js';

const SRC_DIR = __dirname;
const INDEX_TS = pathToFileURL(path.resolve(SRC_DIR, 'index.ts')).href;
const TSX_CLI = require.resolve('tsx/cli');
const REPO_ROOT = path.resolve(SRC_DIR, '..', '..', '..');

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/**
 * Write the bare-consumer client script. It dials `socketPath`, sends exactly
 * one request, prints `GOT_OK` on a well-formed reply, and then returns control
 * to the event loop — deliberately NO `process.exit()` and NO keep-alive
 * interval, so the process exits only if the dial socket releases the loop.
 */
function writeClient(dir: string): string {
  const clientPath = path.join(dir, 'dial-client.mjs');
  fs.writeFileSync(
    clientPath,
    [
      `const mod = await import(process.env.DIAL_TEST_INDEX);`,
      `const conn = mod.dialBackend({ socketPath: process.env.DIAL_TEST_SOCK, onDiagnostic: () => {} });`,
      `const resp = await conn.send({ jsonrpc: '2.0', id: 'r1', method: 'ping' });`,
      `if (!resp || resp.error || !resp.result) {`,
      `  process.stderr.write('BAD:' + JSON.stringify(resp) + '\\n');`,
      `  process.exit(3);`,
      `}`,
      `process.stderr.write('GOT_OK\\n');`,
      `// Fall off the end: the event loop must drain by itself.`,
      '',
    ].join('\n'),
    'utf8',
  );
  return clientPath;
}

/** Spawn the bare consumer and resolve with its exit code once it exits. */
function spawnClient(clientPath: string, socketPath: string): {
  exit: Promise<number | null>;
  stderr: () => string;
} {
  const child = spawn(process.execPath, [TSX_CLI, clientPath], {
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
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  });
  return { exit, stderr: () => stderr };
}

/** A real backend on a temp UDS; `delayMs` defers each reply. */
async function startBackend(socketPath: string, delayMs = 0): Promise<BackendHandle> {
  const h = await serveBackend({
    socketPath,
    onDiagnostic: () => {},
    handler: async (req) => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return { jsonrpc: '2.0', id: req.id ?? null, result: { ok: true } };
    },
  });
  cleanups.push(() => h.close());
  return h;
}

/** Bounded wait for the consumer to exit; `-999` means it HUNG. */
async function awaitExitBounded(exit: Promise<number | null>, ms: number): Promise<number | null> {
  return Promise.race([
    exit,
    new Promise<number | null>((resolve) => {
      setTimeout(() => resolve(-999), ms);
    }),
  ]);
}

function tmpSock(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-dial-unref-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, `${name}.sock`);
}

describe('dialBackend — the connection must not pin the event loop', () => {
  it(
    'a bare consumer that dials, sends one request, and gets a reply EXITS on its own',
    async () => {
      const sock = tmpSock('immediate');
      await startBackend(sock, 0);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-dial-unref-client-'));
      cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
      const clientPath = writeClient(dir);

      const { exit, stderr } = spawnClient(clientPath, sock);
      const code = await awaitExitBounded(exit, 20_000);
      process.stderr.write(`[dial-unref] immediate arm exit=${code} stderr=${stderr()}\n`);

      // RED without the fix: the ref'd socket holds the loop, `code` is -999.
      expect(code, `consumer must exit on its own (not hang); stderr=${stderr()}`).not.toBe(-999);
      expect(code, stderr()).toBe(0);
      expect(stderr()).toContain('GOT_OK');
    },
    60_000,
  );

  it(
    'the connection is REF\'d while a request is in flight — a delayed reply is still received',
    async () => {
      const sock = tmpSock('delayed');
      // Reply lands well after the consumer would have drained an idle loop.
      await startBackend(sock, 500);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-dial-unref-client-'));
      cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
      const clientPath = writeClient(dir);

      const { exit, stderr } = spawnClient(clientPath, sock);
      const code = await awaitExitBounded(exit, 20_000);
      process.stderr.write(`[dial-unref] delayed arm exit=${code} stderr=${stderr()}\n`);

      // RED if unref is applied too eagerly: the process would exit (13,
      // unsettled top-level await) BEFORE the reply, printing no GOT_OK.
      expect(code, `consumer must survive its own in-flight request; stderr=${stderr()}`).not.toBe(-999);
      expect(stderr()).toContain('GOT_OK');
      expect(code, stderr()).toBe(0);
    },
    60_000,
  );
});
