/**
 * BL-c5249cdd — `memory_ping` carries the store-growth gauge (`store.growth`):
 * file bytes, page_count, page_size, freelist_count, bytes per live node, the
 * persisted in-service OPTIMIZE pass count since the last rebuild, the typed
 * thresholds, and the alarm. Additive (HF-3): the alarm never changes
 * `status` — it is an operator action item (`remedy`), not a health failure.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '@adhd/sox-memory-core';
import { handleToolCall } from './index.js';

let dir: string;
let dbPath: string;
const savedConfig = process.env['SOX_CONFIG_DB_PATH'];
const savedHome = process.env['HOME'];
const savedPasses = process.env['SOX_STORE_GROWTH_OPTIMIZE_PASSES_ALARM'];

beforeAll(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl-c5249cdd-ping-home-'));
  process.env['HOME'] = home;
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl-c5249cdd-ping-')));
  dbPath = path.join(dir, 'memory.db');
  const a = await openDb(dbPath);
  try {
    for (let i = 0; i < 20; i++) {
      await a.executeRun(
        'INSERT INTO node (uid, kind, content, name, summary, t_created) VALUES (?, ?, ?, ?, ?, ?)',
        [`u${i}`, 'episode', `growth gauge probe row ${i}`, `n${i}`, 's', new Date().toISOString()],
      );
    }
    await a.executeRun(
      `INSERT INTO _adapter_meta(key, value) VALUES ('fts_optimize_passes_since_rebuild', '7')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
  } finally {
    await a.close();
  }
});

afterEach(() => {
  if (savedConfig === undefined) delete process.env['SOX_CONFIG_DB_PATH'];
  else process.env['SOX_CONFIG_DB_PATH'] = savedConfig;
  if (savedPasses === undefined) delete process.env['SOX_STORE_GROWTH_OPTIMIZE_PASSES_ALARM'];
  else process.env['SOX_STORE_GROWTH_OPTIMIZE_PASSES_ALARM'] = savedPasses;
});

afterAll(() => {
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Growth {
  file_bytes: number;
  page_count: number;
  page_size: number;
  page_bytes: number;
  freelist_count: number;
  live_nodes: number;
  bytes_per_live_node: number | null;
  fts_optimize_passes_since_rebuild: number | null;
  thresholds: { bytes_per_live_node: number; optimize_passes_since_rebuild: number; min_live_nodes: number };
  alarm: boolean;
  alarm_reasons: string[];
  remedy: string | null;
}

async function ping(): Promise<{ status: string; store: { growth: Growth | null; growth_error: string | null } }> {
  const res = await handleToolCall('memory_ping', { db_path: dbPath });
  expect(res.isError).not.toBe(true);
  return JSON.parse((res.content[0] as { text: string }).text);
}

describe('BL-c5249cdd — memory_ping store.growth', () => {
  it('BL-c5249cdd: memory_ping reports the growth gauge and alarms on the typed pass threshold', async () => {
    delete process.env['SOX_CONFIG_DB_PATH'];
    const quiet = await ping();
    expect(quiet.store.growth_error).toBeNull();
    const g = quiet.store.growth!;
    expect(g).not.toBeNull();
    expect(g.page_size).toBeGreaterThan(0);
    expect(g.page_bytes).toBe(g.page_count * g.page_size);
    expect(g.file_bytes).toBeGreaterThan(0);
    expect(g.freelist_count).toBeGreaterThanOrEqual(0);
    expect(g.live_nodes).toBe(20);
    expect(g.bytes_per_live_node).toBe(Math.round(g.file_bytes / 20));
    expect(g.fts_optimize_passes_since_rebuild).toBe(7);
    expect(g.thresholds.optimize_passes_since_rebuild).toBe(32);
    expect(g.alarm).toBe(false);

    // D3 tuning: lower the pass threshold below the store's count → alarm.
    process.env['SOX_STORE_GROWTH_OPTIMIZE_PASSES_ALARM'] = '5';
    const loud = await ping();
    const lg = loud.store.growth!;
    expect(lg.thresholds.optimize_passes_since_rebuild).toBe(5);
    expect(lg.alarm).toBe(true);
    expect(lg.alarm_reasons.join(' ')).toMatch(/fts_optimize_passes_since_rebuild 7 > 5/);
    expect(lg.remedy).toMatch(/memory fts-rebuild/);
    // Additive: the alarm does not change the health verdict.
    expect(loud.status).toBe(quiet.status);
  }, 300_000);
});
