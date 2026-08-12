/**
 * embed-health-surface.spec.ts — regression coverage for BL-250 on the
 * memory_ping / memory_stats MCP surface.
 *
 * `EmbedHealth` (libs/memory-core/src/embed.ts) never had an `on_hash_fallback`
 * field (the hash backend does not exist — EmbedBackend = 'auto' | 'real'
 * only), yet index.ts read `embedHealth.on_hash_fallback` at THREE sites
 * (memory_ping's `embed` block, memory_ping's legacy flat keys, and the
 * startup warmup warning branch) — always `undefined` at runtime, and the
 * startup warning branch was consequently permanently dead code.
 *
 * This is a BREAKING MCP response change: `memory_ping.embed.on_hash_fallback`
 * and `memory_ping.embed_on_hash_fallback` (legacy flat key) are REMOVED, not
 * replaced with another field — the pre-fix values were undefined at runtime
 * anyway, so no caller could have depended on a real value. `memory_stats`'s
 * `embed_on_hash_fallback` (a hardcoded `false` constant) is also removed —
 * see stats.spec.ts for that half of BL-250.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  WriteQueue,
  _setEmbedProviderForTest,
  _resetEmbedSingleton,
  DeterministicTestProvider,
} from '@adhd/sox-memory-core';
import { handleToolCall } from './index.js';

function parseResult(resp: { content: Array<{ text?: string }> }): Record<string, unknown> {
  return JSON.parse(resp.content[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('memory_ping — embed block (BL-250)', () => {
  it('embed.on_hash_fallback is absent (the hash backend does not exist)', async () => {
    const resp = await handleToolCall('memory_ping', {});
    const body = parseResult(resp);
    const embedBlock = body['embed'] as Record<string, unknown>;
    expect(embedBlock).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(embedBlock, 'on_hash_fallback')).toBe(false);
    // The rest of the embed block is untouched by this fix.
    expect(typeof embedBlock['model']).toBe('string');
    expect(typeof embedBlock['backend']).toBe('string');
    expect(typeof embedBlock['state']).toBe('string');
  });

  it('legacy flat embed_on_hash_fallback key is absent', async () => {
    const resp = await handleToolCall('memory_ping', {});
    const body = parseResult(resp);
    expect(Object.prototype.hasOwnProperty.call(body, 'embed_on_hash_fallback')).toBe(false);
    // The other legacy flat keys are untouched by this fix.
    expect(typeof body['embed_model']).toBe('string');
    expect(typeof body['embed_backend_configured']).toBe('string');
    expect(typeof body['embed_state']).toBe('string');
  });
});

describe('memory_ping — status field (BUG-EMBED-WARMUP-CACHEHIT-ASSUMES-FAST-LOAD-001, AC-4)', () => {
  // (BL-373 family, ping honesty) These arms exercise the EMBED dimension of
  // `status`. A bare `memory_ping {}` with no SOX_CONFIG_DB_PATH would now
  // read `unhealthy` (store not open, BL-412) and never exercise embed, so
  // each arm materialises a real scratch store and pings with an explicit
  // `db_path` — store_ok:true, status purely embed-driven.
  let dbPath: string;
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-embed-health-surface-'));
    dbPath = path.join(dir, 'test.db');
    const resp = await handleToolCall('memory_write', {
      db_path: dbPath,
      content: 'AC-4 embed-health-surface fixture episode.',
      project_path: '/test/embed-health-surface',
    });
    expect(resp.isError).toBeFalsy();
  });

  afterEach(() => {
    // Restore a healthy real-state provider so subsequent tests/files in this
    // process aren't left with the uninitialized state this describe block
    // deliberately forces.
    _setEmbedProviderForTest(new DeterministicTestProvider());
    _resetEmbedSingleton();
  });

  it('status === "degraded" when embed_state !== "real" (vec channel absent, store open)', async () => {
    // Force the embed subsystem to uninitialized: clear any injected test
    // provider and reset the singleton so getEmbedState() falls through to
    // its default 'uninitialized' (embed.ts:128-132 — no provider set).
    _setEmbedProviderForTest(null);
    _resetEmbedSingleton();

    const resp = await handleToolCall('memory_ping', { db_path: dbPath });
    const body = parseResult(resp);
    expect(body['store_ok']).toBe(true); // the store dimension must not be the reason
    expect(body['embed_state']).toBe('uninitialized');
    expect(body['status']).toBe('degraded');
    // Decision 2: `ok` never flips — it stays the RPC-success boolean.
    expect(body['ok']).toBe(true);
  });

  it('status === "ok" when embed_state === "real" (store open)', async () => {
    _setEmbedProviderForTest(new DeterministicTestProvider());
    _resetEmbedSingleton();

    const resp = await handleToolCall('memory_ping', { db_path: dbPath });
    const body = parseResult(resp);
    expect(body['store_ok']).toBe(true);
    expect(body['embed_state']).toBe('real');
    expect(body['status']).toBe('ok');
    expect(body['ok']).toBe(true);
  });
});

describe('memory_stats — embed_on_hash_fallback (BL-250)', () => {
  it('is absent from the memory_stats response', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-embed-health-surface-'));
    const dbPath = path.join(dir, 'test.db');
    try {
      await handleToolCall('memory_write', {
        db_path: dbPath,
        content: 'BL-250 regression fixture episode for memory_stats.',
      });
      const resp = await handleToolCall('memory_stats', { db_path: dbPath });
      const body = parseResult(resp);
      expect(Object.prototype.hasOwnProperty.call(body, 'embed_on_hash_fallback')).toBe(false);
    } finally {
      WriteQueue.clearInstances();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
