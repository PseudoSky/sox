/**
 * bl401-telemetry-status-surface.spec.ts — BL-401 gap 3.
 *
 * BL-351's stated acceptance line requires "every emitted metric is reachable
 * from the status surface without reading a log file". `telemetrySelfCheck()`
 * existed (published by PKT-02) but was never called from `memory_ping`/
 * `memory_stats` — this is what wires it in. Proves `memory_stats`'s response
 * carries a `telemetry_self_check` field shaped like `TelemetrySelfCheck`,
 * additive (doesn't remove any existing field), and that the read never
 * throws even with nothing declared.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WriteQueue } from '@adhd/sox-memory-core';
import { handleToolCall } from './index.js';

function parseResult(resp: { content: Array<{ text?: string }> }): Record<string, unknown> {
  return JSON.parse(resp.content[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('BL-401: memory_stats surfaces telemetrySelfCheck() without reading a log file', () => {
  it('BL-401: telemetry_self_check is present, well-shaped, and existing fields are untouched', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl401-status-surface-'));
    const dbPath = path.join(dir, 'test.db');
    try {
      await handleToolCall('memory_write', {
        db_path: dbPath,
        content: 'BL-401 regression fixture episode for memory_stats telemetry surface.',
      });
      const resp = await handleToolCall('memory_stats', { db_path: dbPath });
      const body = parseResult(resp);

      expect(Object.prototype.hasOwnProperty.call(body, 'telemetry_self_check')).toBe(true);
      const check = body['telemetry_self_check'] as Record<string, unknown> | null;
      expect(check).not.toBeNull();
      expect(check!['window']).toBe('since process start');
      expect(typeof check!['role']).toBe('string');
      expect(typeof check!['stages_declared']).toBe('number');
      expect(Array.isArray(check!['stages_with_zero_samples'])).toBe(true);
      expect(Array.isArray(check!['paths_with_zero_samples'])).toBe(true);
      expect(Array.isArray(check!['stages'])).toBe(true);

      // Additive — BL-334's integrity fields (and every other pre-existing
      // field) are still present alongside the new one.
      expect(Object.prototype.hasOwnProperty.call(body, 'integrity')).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(body, 'integrity_headline')).toBe(true);
      expect(typeof body['total_episodes']).toBe('number');
    } finally {
      WriteQueue.clearInstances();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
