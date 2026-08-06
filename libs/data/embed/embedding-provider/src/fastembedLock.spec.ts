import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initTelemetry, _resetTelemetryForTest, type TelemetryHandle } from '@adhd/sox-telemetry';
import { checkAndClaimFastembedLock } from './fastembedProcessHost.js';
import { resolveFastembedLockPath } from './fastembedLock.js';
import { SharedFastembedProcessClient } from './sharedFastembedProcess.js';

/**
 * BL-471 regression test — proves the WRITER (`fastembedProcessHost.ts`) and
 * the READER (`sharedFastembedProcess.ts`) share ONE definition of the
 * advisory lock's path and payload shape, via `./fastembedLock.ts`, instead
 * of each independently re-deriving it.
 *
 * Before the fix, `resolveFastembedLockPath()` and the `{ pid, startedAt }`
 * shape were spelled out twice — once in each file — with no shared
 * constant and no guard. Nothing failed when they drifted: renaming the
 * lock path (or the `startedAt` field) in one file would silently make
 * BL-432's `competing_host_pid` telemetry permanently `null`, which reads
 * identically to "no competing host was ever present". This test forces
 * that failure mode to be loud instead of silent: it exercises the real
 * writer (`checkAndClaimFastembedLock`) and the real path resolver
 * (`sharedFastembedProcess.ts`'s `detectCompetingFastembedHost` uses the
 * exact same `resolveFastembedLockPath` import under test here), so any
 * future re-duplication that lets the two drift apart will fail this test.
 */
describe('BL-471 — fastembed lock path/shape shared between writer and reader', () => {
  let lockPath: string;
  let prevEnv: string | undefined;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    lockPath = join(
      tmpdir(),
      `sox-fastembed-host-bl471-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.lock`,
    );
    prevEnv = process.env['SOX_FASTEMBED_LOCK_PATH'];
    process.env['SOX_FASTEMBED_LOCK_PATH'] = lockPath;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    if (prevEnv === undefined) delete process.env['SOX_FASTEMBED_LOCK_PATH'];
    else process.env['SOX_FASTEMBED_LOCK_PATH'] = prevEnv;
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // already gone / never created — fine
    }
  });

  it('the reader-visible path (resolveFastembedLockPath) is exactly the path the writer wrote to', () => {
    // The writer (`checkAndClaimFastembedLock`, running in
    // `fastembedProcessHost.ts`) writes to whatever `resolveFastembedLockPath()`
    // resolves to internally (it no longer has its own copy — it imports
    // this same function from `./fastembedLock.ts`).
    checkAndClaimFastembedLock();

    // The reader side (`sharedFastembedProcess.ts`) resolves the path via
    // the SAME imported function — not a re-derived literal.
    const readerVisiblePath = resolveFastembedLockPath();

    expect(readerVisiblePath).toBe(lockPath);
    expect(fs.existsSync(readerVisiblePath)).toBe(true);
  });

  it('a real writer-produced lock file parses under the reader-side payload shape', () => {
    checkAndClaimFastembedLock();

    const raw = JSON.parse(fs.readFileSync(resolveFastembedLockPath(), 'utf8')) as {
      pid?: unknown;
      startedAt?: unknown;
    };

    // This is exactly the duck-typed shape `detectCompetingFastembedHost` in
    // `sharedFastembedProcess.ts` reads. Since both sides now import the
    // same `FastembedLockInfo` type from `./fastembedLock.ts`, a field
    // rename in the writer is a compile-time break for the reader instead
    // of a silent runtime `null`.
    expect(typeof raw.pid).toBe('number');
    expect(raw.pid).toBe(process.pid);
    expect(typeof raw.startedAt).toBe('string');
  });
});

/**
 * BL-471 acceptance (option (b), the full end-to-end contract): the writer
 * (`checkAndClaimFastembedLock`) actually writes a lock file naming THIS
 * process as a "competing host", and the real reader path — the shipped
 * `SharedFastembedProcessClient.request()` telemetry, exercised through a
 * stub fork target so the suite stays hermetic (same pattern as
 * `bl432-queue-depth.spec.ts`) — actually surfaces `competing_host_pid`
 * for it. This is the test that would go RED if the lock path or the
 * `pid`/`startedAt` field names were ever independently re-duplicated and
 * allowed to drift between the two files again: a drift here does not
 * throw, it just makes `competing_host_pid` silently absent from the
 * telemetry line below — exactly the BL-471 failure mode.
 */
describe('BL-471 — SharedFastembedProcessClient.request() surfaces a writer-produced competing host', () => {
  let lockPath: string;
  let prevEnv: string | undefined;
  let stubDir: string;
  let logDir: string;
  let handle: TelemetryHandle;
  let client: SharedFastembedProcessClient;

  function writeStubHost(): string {
    const hostPath = path.join(stubDir, 'stub-host.mjs');
    fs.writeFileSync(
      hostPath,
      [
        `process.on('message', (msg) => {`,
        `  if (process.connected) process.send({ id: msg.id, embedding: [0, 0, 0] });`,
        `});`,
        '',
      ].join('\n'),
    );
    return hostPath;
  }

  function readLogLines(filePath: string | null): Record<string, unknown>[] {
    if (filePath === null || !fs.existsSync(filePath)) return [];
    return fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  beforeEach(() => {
    lockPath = join(
      tmpdir(),
      `sox-fastembed-host-bl471-e2e-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.lock`,
    );
    prevEnv = process.env['SOX_FASTEMBED_LOCK_PATH'];
    process.env['SOX_FASTEMBED_LOCK_PATH'] = lockPath;
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl471-stub-'));
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl471-log-'));
    _resetTelemetryForTest();
    handle = initTelemetry({ service: 'bl471-test', role: 'test', logSink: 'file', logDir });
  });

  afterEach(async () => {
    await client?.terminate();
    _resetTelemetryForTest();
    fs.rmSync(stubDir, { recursive: true, force: true });
    fs.rmSync(logDir, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env['SOX_FASTEMBED_LOCK_PATH'];
    else process.env['SOX_FASTEMBED_LOCK_PATH'] = prevEnv;
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // already gone / never created — fine
    }
  });

  it('a lock file written by the real checkAndClaimFastembedLock() writer is picked up by request() as competing_host_pid', async () => {
    // This vitest worker process stands in for "another live fastembed
    // host" — it calls the REAL writer function, which resolves its own
    // pid + the SOX_FASTEMBED_LOCK_PATH-scoped path via `./fastembedLock.ts`.
    checkAndClaimFastembedLock();
    expect(fs.existsSync(lockPath)).toBe(true);

    const hostPath = writeStubHost();
    client = new SharedFastembedProcessClient(hostPath);
    // The forked stub host has a different pid from this test process, so
    // the reader's `pid !== ownPid` check is satisfied for real.
    await client.request({ type: 'embed', text: 'bl471' }, 5000);
    await handle.flush();

    const admitted = readLogLines(handle.currentLogFilePath()).find(
      (r) => r['event'] === 'fastembed_process.request.admitted',
    );
    expect(admitted).toBeDefined();
    expect(admitted?.['competing_host_pid']).toBe(process.pid);
  }, 15_000);

  it('with no lock file present, competing_host_pid is absent (not falsely populated)', async () => {
    expect(fs.existsSync(lockPath)).toBe(false);

    const hostPath = writeStubHost();
    client = new SharedFastembedProcessClient(hostPath);
    await client.request({ type: 'embed', text: 'bl471-no-lock' }, 5000);
    await handle.flush();

    const admitted = readLogLines(handle.currentLogFilePath()).find(
      (r) => r['event'] === 'fastembed_process.request.admitted',
    );
    expect(admitted).toBeDefined();
    expect(admitted).not.toHaveProperty('competing_host_pid');
  }, 15_000);
});
