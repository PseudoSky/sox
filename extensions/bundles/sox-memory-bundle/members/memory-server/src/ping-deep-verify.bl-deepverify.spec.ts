/**
 * BL-deepverify — `memory_ping` reads the store's durable deep-verify record
 * and reports a store whose OWED deep integrity pass timed out as `degraded`
 * ([inv:list-never-lies]). Driven through the real `handleToolCall` →
 * `memory_ping` path against a real store; the record is written into
 * `_adapter_meta` exactly as store-adapter's deep-verify.ts writes it.
 *
 * RED (fix disabled — the ping does not pass `deepVerify` to the verdict):
 * the degraded status and its reason are absent.
 */
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

describe('BL-deepverify — memory_ping degrades on an owed deep pass that timed out', () => {
  it('an owed + timed_out deep pass reads degraded, with the record in store.deep_verify', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl-deepverify-ping-'));
    const dbPath = path.join(dir, 'test.db');
    try {
      await handleToolCall('memory_write', {
        db_path: dbPath,
        project_path: dir,
        content: 'BL-deepverify ping fixture episode.',
      });
      const before = body(await handleToolCall('memory_ping', { db_path: dbPath }));
      expect(String(before['status_reason'] ?? '')).not.toMatch(/deep integrity verification/);
      const storeBefore = before['store'] as Record<string, unknown>;
      expect(storeBefore['deep_verify']).toEqual({ owed: null, last: null });

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
            status: 'timed_out',
            reason: 'unclean_shutdown',
            detail: 'deep verification exceeded its 1500ms wall-clock bound; the verifier (pid 1) was SIGKILLed',
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            duration_ms: 1500,
            timeout_ms: 1500,
            owner_pid: process.pid,
            verifier_pid: 1,
          }),
        ]);
      } finally {
        await writer.close();
      }

      const after = body(await handleToolCall('memory_ping', { db_path: dbPath }));
      expect(after['status']).toBe('degraded');
      expect(String(after['status_reason'])).toMatch(/deep integrity verification is owed.*'timed_out'/);
      expect(after['store_ok']).toBe(true);
      const store = after['store'] as { deep_verify: { owed: { reason: string } | null; last: { status: string } | null } };
      expect(store.deep_verify.owed?.reason).toBe('unclean_shutdown');
      expect(store.deep_verify.last?.status).toBe('timed_out');
    } finally {
      WriteQueue.clearInstances();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
