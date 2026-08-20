/**
 * BUG-MEMORYSERVER-SHUTDOWN-LEAKS-FASTEMBED-CHILD-001 regression test.
 *
 * ROOT CAUSE (reproduced live before this fix, see the fix's own doc comment
 * on `SharedFastembedProcessClient.terminated` in `sharedFastembedProcess.ts`
 * for the full production repro): `memory-server`'s `coordinatedShutdown`
 * (`extensions/bundles/sox-memory-bundle/members/memory-server/src/backend.ts`)
 * races step 0 (`flushPendingEmbeds`) against a short bound and, on timeout,
 * ABANDONS it as a background "loser" promise that keeps running concurrently
 * with step 1 (`terminateEmbedWorkers`). `fastembed.ts`'s `initModel()`
 * retries a cache-hit warmup up to `WARMUP_CACHE_HIT_ATTEMPTS` times; if its
 * first attempt is still in flight when step 1's `terminate()` rejects every
 * pending request, `initModel()`'s catch block fires a SECOND attempt —
 * which, before this fix, called `ensureProcess()` and found `this.child`
 * already nulled by `terminate()`, so it happily forked a BRAND NEW,
 * completely untracked child process. `coordinatedShutdown` had already
 * moved past step 1 by the time that fork completed, so the new child was
 * never subject to any further termination step and was abandoned as a live
 * OS-level orphan the instant the parent's `exit(0)` fired.
 *
 * This test drives the REAL `SharedFastembedProcessClient` (not a hand-rolled
 * parity re-implementation) against a stub fork target, and asserts against
 * REAL OS process ids via `ps` — not just in-memory promise state — because
 * an in-process handle/promise assertion can pass against broken code (the
 * leaked child is a real, independent OS process; only checking its actual
 * liveness proves it was never left running).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { SharedFastembedProcessClient } from './sharedFastembedProcess.js';

let tmpDir: string;
let hostPath: string;
let pidsFile: string;

/** True iff a real OS process with this pid is currently alive. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Every distinct pid the stub host recorded as having started, in order. */
function recordedPids(): number[] {
  if (!fs.existsSync(pidsFile)) return [];
  return fs
    .readFileSync(pidsFile, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => Number(l));
}

afterEach(() => {
  // Never leave a leaked child alive on the box even when this test is
  // deliberately proving the bug (fix reverted) — only pids THIS test spawned
  // (recorded by the stub host itself) are ever touched.
  for (const pid of recordedPids()) {
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/**
 * Stub fork target. Records its OWN real OS pid to `pidsFile` the instant it
 * starts (so the test can enumerate every child ACTUALLY forked, independent
 * of whatever the client believes happened), replies to `init`/`embed`
 * requests, and exits cleanly on the real `{ __shutdown: true }` protocol
 * message `SharedFastembedProcessClient.terminate()` sends.
 */
function writeStubHost(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug-shutdown-leak-fastembed-'));
  pidsFile = path.join(tmpDir, 'pids.log');
  const p = path.join(tmpDir, 'stub-host.mjs');
  fs.writeFileSync(
    p,
    [
      `import fs from 'node:fs';`,
      `fs.appendFileSync(${JSON.stringify(pidsFile)}, process.pid + '\\n');`,
      `process.on('message', (msg) => {`,
      `  if (msg && msg.__shutdown === true) { process.exit(0); return; }`,
      `  if (msg.type === 'init') {`,
      `    if (process.connected) process.send({ id: msg.id, initOk: true, dim: 3, execution_provider: 'cpu' });`,
      `    return;`,
      `  }`,
      `  if (msg.type === 'embed') {`,
      `    if (process.connected) process.send({ id: msg.id, embedding: [0.1, 0.2, 0.3] });`,
      `    return;`,
      `  }`,
      `});`,
      '',
    ].join('\n'),
  );
  return p;
}

describe('BUG-MEMORYSERVER-SHUTDOWN-LEAKS-FASTEMBED-CHILD-001 — terminate() must not let a racing request re-fork an orphan', () => {
  it(
    'a request() call AFTER terminate() is rejected and never forks a new, untracked child process',
    async () => {
      hostPath = writeStubHost();
      const client = new SharedFastembedProcessClient(hostPath);

      // 1) Normal startup: forks child A, init succeeds.
      const initRes = await client.request<{ initOk: true; dim: number }>(
        { type: 'init', model: 'stub', cacheDir: '/tmp' },
        5000,
      );
      expect(initRes.initOk).toBe(true);
      expect(recordedPids()).toHaveLength(1);
      const childAPid = recordedPids()[0]!;
      expect(isPidAlive(childAPid)).toBe(true);

      // 2) The real coordinated-shutdown step: terminate the shared client.
      // Child A is asked to exit gracefully (`__shutdown`) and does.
      await client.terminate();
      // terminate() resolves once the child has actually exited (or been
      // killed) — no leftover process from the FIRST child either.
      expect(isPidAlive(childAPid)).toBe(false);

      // 3) THE RACE: a request racing/following that terminate() — exactly
      // what `initModel()`'s cache-hit retry loop does when its first
      // attempt is rejected by `terminate()`'s pending-map sweep.
      //
      // BEFORE THE FIX: `ensureProcess()` saw `this.child === null` (nulled
      // by terminate()) and forked a brand-new child B — a second pid would
      // appear in `pidsFile`, and because nothing in this test (mirroring
      // `coordinatedShutdown`, which has already moved past its terminate
      // step by the time this fires in production) ever calls `terminate()`
      // on it, it would still be ALIVE at the end of this test — a real,
      // reproduced orphan.
      //
      // AFTER THE FIX: `ensureProcess()` observes the permanent `terminated`
      // flag and rejects immediately, WITHOUT forking anything.
      await expect(
        client.request({ type: 'init', model: 'stub', cacheDir: '/tmp' }, 5000),
      ).rejects.toThrow(/terminated/);

      // 4) The OS-level proof: exactly ONE child was EVER forked for the
      // lifetime of this client, and it is not alive.
      const allPids = recordedPids();
      expect(allPids).toEqual([childAPid]);
      for (const pid of allPids) {
        expect(isPidAlive(pid)).toBe(false);
      }

      // Belt-and-suspenders OS-level scan (independent of our own pid
      // bookkeeping): confirm no process with this stub script's path is
      // still running anywhere on the box under a pid we recorded.
      let psOutput = '';
      try {
        psOutput = execFileSync('ps', ['-p', allPids.join(','), '-o', 'pid='], {
          encoding: 'utf8',
        });
      } catch (err) {
        // `ps -p` exits non-zero when NONE of the given pids exist — that is
        // the expected (passing) outcome; anything else is a real failure.
        psOutput = (err as { stdout?: string }).stdout ?? '';
      }
      expect(psOutput.trim()).toBe('');
    },
    15_000,
  );
});
