/**
 * BL-9f6681ee — `memory_ping` reads the recorded deep-verify owner's liveness.
 * An owed pass recorded `running` by an owner process that is now dead will
 * never finish; the ping must say `degraded`, not `ok`. Driven through the
 * real `handleToolCall` → `memory_ping` path against a real store.
 *
 * RED (fix disabled — the ping does not pass `ownerAlive` to the verdict):
 * the dead-owner reason is absent.
 */
import { spawn } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WriteQueue } from '@adhd/sox-memory-core';
import { DEEP_VERIFY_OWED_KEY, DEEP_VERIFY_STATE_KEY, createStoreAdapter } from '@adhd/sox-store-adapter';
import { handleToolCall } from './index.js';

function body(resp: { content: Array<{ text?: string }> }): Record<string, unknown> {
  return JSON.parse(resp.content[0]?.text ?? '{}') as Record<string, unknown>;
}

const UPSERT = `INSERT INTO _adapter_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`;

/** A pid that certainly belonged to a process which has exited. */
async function deadPid(): Promise<number> {
  const proc = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = proc.pid;
  await new Promise<void>((r) => proc.once('exit', () => r()));
  if (pid === undefined) throw new Error('spawn produced no pid');
  return pid;
}

async function recordRunning(dbPath: string, ownerPid: number): Promise<void> {
  const writer = await createStoreAdapter({ dbPath });
  try {
    await writer.executeRun(UPSERT, [
      DEEP_VERIFY_OWED_KEY,
      JSON.stringify({ reason: 'unclean_shutdown', since: new Date().toISOString() }),
    ]);
    await writer.executeRun(UPSERT, [
      DEEP_VERIFY_STATE_KEY,
      JSON.stringify({
        v: 1,
        status: 'running',
        reason: 'unclean_shutdown',
        detail: null,
        started_at: new Date().toISOString(),
        finished_at: null,
        duration_ms: null,
        timeout_ms: 1_800_000,
        owner_pid: ownerPid,
        verifier_pid: null,
      }),
    ]);
  } finally {
    await writer.close();
  }
}

describe('BL-9f6681ee — memory_ping degrades on an owed deep pass whose running owner is dead', () => {
  it('running + dead owner_pid ⇒ degraded; running + live owner_pid ⇒ no deep-verify degradation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl-9f6681ee-ping-'));
    const dbPath = path.join(dir, 'test.db');
    try {
      await handleToolCall('memory_write', {
        db_path: dbPath,
        project_path: dir,
        content: 'BL-9f6681ee ping fixture episode.',
      });

      await recordRunning(dbPath, await deadPid());
      const dead = body(await handleToolCall('memory_ping', { db_path: dbPath }));
      expect(dead['status']).toBe('degraded');
      expect(String(dead['status_reason'])).toMatch(/deep integrity verification is owed.*'running'.*owner process is dead/);

      await recordRunning(dbPath, process.pid);
      const live = body(await handleToolCall('memory_ping', { db_path: dbPath }));
      expect(String(live['status_reason'] ?? '')).not.toMatch(/deep integrity verification/);
    } finally {
      WriteQueue.clearInstances();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
