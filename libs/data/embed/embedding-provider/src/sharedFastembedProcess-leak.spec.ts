/**
 * sharedFastembedProcess-leak.spec.ts — BL-370.
 *
 * `ensureProcess()` forks the shared embed host with an IPC channel and calls
 * `c.unref()` twice, with a comment stating the intent: *"so a real process can
 * exit when its own work is done instead of hanging on this child forever."*
 * The intent was not achieved. `fork()` with `'ipc'` creates a SEPARATE libuv
 * handle for the channel; `ChildProcess.unref()` does not release it, so the
 * parent's event loop stayed alive forever.
 *
 * Observed in the wild before the fix: two probe processes still running 40+
 * minutes after writing their final output, each holding a resident ONNX model.
 * The leaked orphans then produced the "another fastembed host process is
 * ALREADY RUNNING … Neural Engine contention" warning that was cited as
 * evidence for an unrelated hypothesis — the defect manufactured its own
 * corroboration.
 *
 * These tests use a STUB child (a trivial script that just idles) rather than
 * the real fastembed host, so nothing loads a 400 MB ONNX model and the test
 * stays fast and hermetic. What is under test is the fork/unref contract, which
 * is identical either way.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

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
 * Fork a child exactly the way `ensureProcess()` does, optionally applying the
 * BL-370 fix, and report whether the parent process exits on its own.
 *
 * Returns `'exited'` or `'hung'`.
 */
function forkAndReportExit(applyChannelUnref: boolean, waitMs = 3_000): 'exited' | 'hung' {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl370-'));
  const childPath = path.join(tmpDir, 'child.mjs');
  const parentPath = path.join(tmpDir, 'parent.mjs');
  fs.writeFileSync(childPath, 'setInterval(() => {}, 1e9);\n');
  fs.writeFileSync(
    parentPath,
    [
      `import { fork } from 'node:child_process';`,
      // Mirrors ensureProcess(): same stdio, same detached, same double-unref,
      // same listener attachment order.
      `const c = fork(${JSON.stringify(childPath)}, [], { stdio: ['ignore','inherit','inherit','ipc'], detached: false });`,
      `c.unref();`,
      `c.on('message', () => {});`,
      `c.on('error', () => {});`,
      `c.on('exit', () => {});`,
      `c.unref();`,
      applyChannelUnref ? `c.channel?.unref();` : `// BL-370 fix withheld`,
      '',
    ].join('\n'),
  );

  // `stdio: 'ignore'` is load-bearing, and getting it wrong made BOTH arms look
  // hung on the first run of this test. The forked grandchild INHERITS the
  // parent's stdout/stderr; if those are spawnSync pipes, spawnSync waits for
  // pipe EOF as well as process exit, and the surviving grandchild holds the
  // pipe open forever — so the parent's own exit becomes unobservable and the
  // measurement reports "hung" regardless of the fix. With no pipes, spawnSync
  // waits only on process exit, which is exactly the property under test.
  const r = spawnSync(process.execPath, [parentPath], { timeout: waitMs, stdio: 'ignore' });
  // On timeout spawnSync reports BOTH `error.code === 'ETIMEDOUT'` and
  // `signal === 'SIGTERM'`, and leaves `status` null. A clean exit gives
  // `status === 0` with no error. Check all three rather than one, so a change
  // in any single field cannot silently turn this assertion green.
  const timedOut =
    (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ||
    r.signal !== null ||
    r.status === null;
  return timedOut ? 'hung' : 'exited';
}

describe('BL-370 — a process that forks the shared embed host must be able to exit', () => {
  it('RED: ChildProcess.unref() alone leaves the parent hung forever', () => {
    // This is the shipped behaviour before the fix. If this ever starts
    // reporting 'exited', Node changed its fork/IPC semantics and the fix below
    // may no longer be load-bearing — investigate rather than deleting it.
    expect(forkAndReportExit(false)).toBe('hung');
  }, 20_000);

  it('GREEN: adding channel.unref() lets the parent exit on its own', () => {
    expect(forkAndReportExit(true)).toBe('exited');
  }, 20_000);
});

describe('BL-370 — the shipped source carries the fix', () => {
  it('sharedFastembedProcess.ts unrefs the IPC channel, not just the ChildProcess', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'sharedFastembedProcess.ts'), 'utf8');
    expect(src).toContain('c.channel?.unref()');
  });
});
