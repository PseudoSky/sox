/**
 * bl410-standalone-exit-survives-load.spec.ts — BL-410.
 *
 * `ensureProcess()` in `sharedFastembedProcess.ts` `unref()`s both the forked
 * fastembed-host child and its IPC channel the moment it forks (BL-370: so a
 * long-lived *service*, memory-server, can exit cleanly without the embed
 * child pinning it open forever). That is correct for a service, but a
 * **standalone script** whose only pending work is an in-flight
 * `request()` — e.g. `warmupEmbed()` — has nothing else keeping its event
 * loop alive while the request is in flight. Node can decide the loop is
 * empty and tear the process down mid-model-load, silently abandoning the
 * pending promise before the child's reply ever arrives.
 *
 * Manually reproduced against the REAL (cached, no download) fastembed model
 * on 2026-08-01: a bare script that does `new FastembedProvider(...).
 * embedSingle('warmup')` with no other keep-alive exits with code 0, 3/3
 * times, WITHOUT the "warmup resolved" continuation ever running — the
 * promise is silently abandoned, not merely slow. (The literal uncaught-EPIPE
 * *crash* originally filed under BL-410 is separately guarded against by an
 * uncommitted `fastembedProcessHost.ts` change from another session — BL-405
 * — which is why this suite asserts on "did the request settle before exit",
 * not on stderr content: that is the surviving, still-open part of BL-410.)
 *
 * These tests use a stub host script (a trivial fork target that replies
 * after a short delay) instead of the real fastembed host, so nothing loads
 * a model and the suite stays fast and hermetic. What is under test is the
 * fork/ref/unref contract in `SharedFastembedProcessClient`, which is
 * identical either way — proven directly against the shipped class via its
 * BL-410 test-only `hostPathOverride` constructor param, not a hand-rolled
 * parity re-implementation.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const CLIENT_MODULE_PATH = path.resolve(__dirname, 'sharedFastembedProcess.ts');
const TSX_CLI = require.resolve('tsx/cli');

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/**
 * Spawn a standalone script that forks a slow-replying stub host through the
 * REAL `SharedFastembedProcessClient`, fires a single `request()` WITHOUT
 * awaiting it at top level (mirroring `warmupEmbed()` being the only thing a
 * short script does), and does nothing else to keep the event loop alive.
 *
 * Returns whether the request settled before the standalone process itself
 * exited, plus the exit status, so a test can distinguish "exited before
 * settling" (the bug) from "hung" (the banned regression — see BL-410's
 * explicit "do NOT fix this by removing the unref()" constraint) from
 * "settled, then exited cleanly" (the fix).
 */
function runStandaloneScript(replyDelayMs = 150): {
  settledBeforeExit: boolean;
  status: number | null;
  timedOut: boolean;
} {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl410-'));
  const hostPath = path.join(tmpDir, 'stub-host.mjs');
  const driverPath = path.join(tmpDir, 'driver.mjs');

  // Stub fork target: on any message, wait `replyDelayMs` then reply with the
  // same `{ id, initOk: true, ... }` shape the real fastembedProcessHost
  // sends for an `init` request. No fastembed import, no model.
  fs.writeFileSync(
    hostPath,
    [
      `process.on('message', (msg) => {`,
      `  setTimeout(() => {`,
      `    if (process.connected) process.send({ id: msg.id, initOk: true, dim: 768, execution_provider: 'cpu' });`,
      `  }, ${replyDelayMs});`,
      `});`,
      '',
    ].join('\n'),
  );

  // Standalone driver: constructs the REAL client (pointed at the stub host
  // via the BL-410 test-only override), fires one request, and — critically —
  // does NOT await it at top level. That's the exact shape of a script whose
  // only work is `await warmupEmbed()` racing process exit: nothing else in
  // this file refs the event loop.
  fs.writeFileSync(
    driverPath,
    [
      `import { SharedFastembedProcessClient } from ${JSON.stringify(CLIENT_MODULE_PATH)};`,
      `const client = new SharedFastembedProcessClient(${JSON.stringify(hostPath)});`,
      `client.request({ type: 'init', model: 'stub', cacheDir: '/tmp' }, 5000).then(`,
      `  () => { process.stderr.write('BL410_SETTLED:resolved\\n'); },`,
      `  (e) => { process.stderr.write('BL410_SETTLED:rejected:' + e.message + '\\n'); },`,
      `);`,
      `process.stderr.write('BL410_MAIN_DONE\\n');`,
      '',
    ].join('\n'),
  );

  const r = spawnSync(process.execPath, [TSX_CLI, driverPath], {
    timeout: 10_000,
    encoding: 'utf8',
  });

  const timedOut =
    (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ||
    (r.signal !== null && r.status === null);

  const stderr = r.stderr ?? '';
  expect(stderr).toContain('BL410_MAIN_DONE');
  // No uncaught throw / crash trace reached the standalone process's own stderr.
  expect(stderr).not.toMatch(/Unhandled ('error' event|exception)/);

  return {
    settledBeforeExit: stderr.includes('BL410_SETTLED:'),
    status: r.status,
    timedOut,
  };
}

describe('BL-410 — a standalone script must not silently abandon an in-flight warmup on exit', () => {
  it('the standalone process waits for its in-flight request to settle before exiting', () => {
    const result = runStandaloneScript();
    expect(result.timedOut).toBe(false); // never hang — the explicitly banned "fix"
    expect(result.settledBeforeExit).toBe(true); // never silently abandon the request either
    expect(result.status).toBe(0); // and it must still exit cleanly, not crash
  }, 15_000);

  it('still exits promptly (does not hang) once nothing is pending', () => {
    // A fast reply (well under the 5s request timeout) should let the process
    // exit almost immediately after settling — proving the re-ref is released
    // again, not held forever.
    const start = Date.now();
    const result = runStandaloneScript(10);
    const elapsedMs = Date.now() - start;
    expect(result.settledBeforeExit).toBe(true);
    expect(result.status).toBe(0);
    expect(elapsedMs).toBeLessThan(5_000);
  }, 15_000);
});

describe('BL-410 — the shipped source carries the fix', () => {
  it('sharedFastembedProcess.ts refs the child/channel while a request is pending', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'sharedFastembedProcess.ts'), 'utf8');
    expect(src).toContain('refForPending');
    expect(src).toContain('unrefIfIdle');
  });
});
