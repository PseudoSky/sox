/**
 * bl432-queue-depth.spec.ts — BL-432 acceptance.
 *
 * BL-432 retracted memory-core's `embed.ts` `wait`/`work` split as a
 * head-of-line-blocking instrument: `wait_ms` was measured (n=570 warm
 * embeds, three runs) at median 0 ms / max 4 ms, flat across an 8x
 * concurrency sweep that moves `work_ms` 5x — because `admit` is just
 * `await getOrCreateProvider()`, an already-resolved promise after the first
 * embed in a process. The real contention for the ONE shared fastembed
 * child happens one level down, inside `SharedFastembedProcessClient.
 * request()` — this spec proves the instrument BL-432 put there instead.
 *
 * Uses a stub fork target (no fastembed, no model — mirrors bl410's
 * pattern) so the suite stays fast and hermetic while exercising the REAL
 * `SharedFastembedProcessClient.request()` and its real telemetry emission
 * through `@adhd/sox-telemetry`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initTelemetry, _resetTelemetryForTest, type TelemetryHandle } from '@adhd/sox-telemetry';
import { SharedFastembedProcessClient } from './sharedFastembedProcess.js';

let stubDir: string;
let logDir: string;
let handle: TelemetryHandle;
let client: SharedFastembedProcessClient;

/** Trivial fork target: replies to every message after `delayMs`, echoing a
 *  fake embedding response shape. No fastembed import, no model load. */
function writeStubHost(delayMs: number): string {
  const hostPath = path.join(stubDir, 'stub-host.mjs');
  fs.writeFileSync(
    hostPath,
    [
      `process.on('message', (msg) => {`,
      `  setTimeout(() => {`,
      `    if (process.connected) process.send({ id: msg.id, embedding: [0, 0, 0] });`,
      `  }, ${delayMs});`,
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
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl432-stub-'));
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl432-log-'));
  _resetTelemetryForTest();
  handle = initTelemetry({ service: 'bl432-test', role: 'test', logSink: 'file', logDir });
});

afterEach(async () => {
  await client?.terminate();
  _resetTelemetryForTest();
  fs.rmSync(stubDir, { recursive: true, force: true });
  fs.rmSync(logDir, { recursive: true, force: true });
});

describe('BL-432 — SharedFastembedProcessClient.request() emits a real queue-depth signal', () => {
  it('queue_depth is ALWAYS 0 when requests are issued strictly serially (each awaited before the next)', async () => {
    const hostPath = writeStubHost(20);
    client = new SharedFastembedProcessClient(hostPath);

    for (let i = 0; i < 5; i++) {
      await client.request({ type: 'embed', text: `serial ${i}` }, 5000);
    }
    await handle.flush();

    const admitted = readLogLines(handle.currentLogFilePath()).filter(
      (r) => r['event'] === 'fastembed_process.request.admitted',
    );
    expect(admitted.length).toBe(5);
    for (const r of admitted) {
      expect(r['queue_depth']).toBe(0);
    }
  }, 15_000);

  it('queue_depth is NON-ZERO for at least one request when requests are issued concurrently through one shared child', async () => {
    const hostPath = writeStubHost(80);
    client = new SharedFastembedProcessClient(hostPath);

    // Fire all 5 without awaiting between them — they contend for the one
    // shared child, which can only reply to one in-flight message class at a
    // time (the stub, like the real host, processes each message on its own
    // timer but the CLIENT-side `pending` map is exactly what this signal
    // reads: how many were already admitted-and-unsettled when this one
    // joined).
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => client.request({ type: 'embed', text: `concurrent ${i}` }, 5000)),
    );
    await handle.flush();

    const admitted = readLogLines(handle.currentLogFilePath()).filter(
      (r) => r['event'] === 'fastembed_process.request.admitted',
    );
    expect(admitted.length).toBe(5);
    const queueDepths = admitted.map((r) => r['queue_depth'] as number);
    // This is the exact assertion `wait_ms` structurally cannot make (BL-432):
    // a signal that moves under contention and is flat at 0 when serial.
    expect(Math.max(...queueDepths)).toBeGreaterThan(0);

    const finish = readLogLines(handle.currentLogFilePath()).filter(
      (r) => r['event'] === 'fastembed_process.request.finish',
    );
    expect(finish.length).toBe(5);
    for (const r of finish) {
      expect(typeof r['response_ms']).toBe('number');
      expect(r['response_ms'] as number).toBeGreaterThanOrEqual(0);
    }
  }, 15_000);

  it('the request() finish/error telemetry always carries queue_depth and response_ms fields', async () => {
    const hostPath = writeStubHost(5);
    client = new SharedFastembedProcessClient(hostPath);
    await client.request({ type: 'embed', text: 'one-shot' }, 5000);
    await handle.flush();

    const lines = readLogLines(handle.currentLogFilePath());
    const admitted = lines.find((r) => r['event'] === 'fastembed_process.request.admitted');
    const finish = lines.find((r) => r['event'] === 'fastembed_process.request.finish');
    expect(admitted).toBeDefined();
    expect(finish).toBeDefined();
    expect(admitted?.['queue_depth']).toBe(0);
    expect(finish?.['queue_depth']).toBe(0);
    expect(typeof finish?.['response_ms']).toBe('number');
  }, 15_000);
});
