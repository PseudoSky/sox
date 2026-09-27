/**
 * BL-c5249cdd — `memory_ping`'s store-growth gauge.
 *
 * The gauge must (a) report the store's physical size honestly —
 * `page_count × page_size` equals the file size on a closed, checkpointed
 * store — (b) express it per live node, (c) carry the persisted count of
 * in-service FTS OPTIMIZE passes since the last rebuild, and (d) alarm on
 * typed numeric thresholds (ADR-0013 D3). A rebuild must clear the alarm it
 * raised.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from './db.js';
import { resolveStoreGrowthConfig } from './config.js';
import { _resetStoreGrowthAlarmWarningsForTest, readStoreGrowthGauge } from './store-growth.js';

// store-adapter is a lazy-loaded library in memory-core (lint: no static
// value imports) — load it the way the package does.
const { rebuildStoreOffline, TursoAdapterImpl } = await import('@adhd/sox-store-adapter');

const cleanups: Array<() => void | Promise<void>> = [];
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env['HOME'];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl-c5249cdd-gauge-home-'));
  process.env['HOME'] = home;
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  _resetStoreGrowthAlarmWarningsForTest();
});

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
});

function tok(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return `zq${s}word`;
}

const LIVE = 1200;

async function seedLeakedStore(): Promise<string> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl-c5249cdd-gauge-')));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'memory.db');
  const a = await openDb(dbPath);
  try {
    let i = 0;
    for (let r = 0; r < 12; r++) {
      for (let j = 0; j < LIVE / 12; j++, i++) {
        await a.executeRun(
          'INSERT INTO node (uid, kind, content, name, summary, t_created) VALUES (?, ?, ?, ?, ?, ?)',
          [`u${i}`, 'episode', `alpha beta gamma ${tok(i)}`, `name ${tok(i)}`, 'summary', new Date().toISOString()],
        );
      }
      await a.unwrap().exec('OPTIMIZE INDEX idx_fts_node');
    }
    // One invalidated node: live_nodes must exclude it.
    await a.executeRun(
      'INSERT INTO node (uid, kind, content, name, summary, t_created, t_invalid) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['dead', 'episode', 'gone', 'gone', 'gone', new Date().toISOString(), new Date().toISOString()],
    );
  } finally {
    await a.close();
  }
  return dbPath;
}

async function gauge(dbPath: string, overrides?: Parameters<typeof readStoreGrowthGauge>[2]) {
  const a = await TursoAdapterImpl.connect({ dbPath, readonly: true, allowFtsInReadonly: true, idleFlushMs: 3_600_000 });
  try {
    return await readStoreGrowthGauge(a, dbPath, overrides);
  } finally {
    await a.close();
  }
}

async function setPasses(dbPath: string, n: number): Promise<void> {
  const a = await openDb(dbPath);
  try {
    await a.executeRun(
      `INSERT INTO _adapter_meta(key, value) VALUES ('fts_optimize_passes_since_rebuild', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [String(n)],
    );
  } finally {
    await a.close();
  }
}

const T = 600_000;

describe('BL-c5249cdd — store-growth gauge', () => {
  it('BL-c5249cdd: the gauge reports file bytes, page_count and freelist_count consistently, per live node', async () => {
    const db = await seedLeakedStore();
    const g = await gauge(db);
    expect(g.wal_bytes).toBe(0);
    expect(g.page_count).toBeGreaterThan(0);
    expect(g.page_size).toBe(4096);
    expect(g.freelist_count).toBeGreaterThanOrEqual(0);
    // Cross-check: the closed store's file is exactly page_count × page_size.
    expect(g.page_bytes).toBe(g.page_count * g.page_size);
    expect(g.file_bytes).toBe(fs.statSync(db).size);
    expect(g.file_bytes).toBe(g.page_bytes);
    expect(g.live_nodes).toBe(LIVE);
    expect(g.bytes_per_live_node).toBe(Math.round(g.file_bytes / LIVE));
    // Raw OPTIMIZEs are not in-service passes; never counted = unknown, not 0.
    expect(g.fts_optimize_passes_since_rebuild).toBeNull();
    expect(g.last_rebuild_at).toBeNull();
  }, T);

  it('BL-c5249cdd: the gauge alarms past its thresholds and a rebuild clears the alarm', async () => {
    const db = await seedLeakedStore();
    const leaked = await gauge(db);
    const dry = await rebuildStoreOffline(db, { dryRun: true });
    expect(dry.status).toBe('dry_run');
    const compactedBpn = dry.after!.file_bytes / LIVE;
    // A threshold between the compacted and the leaked density.
    const threshold = Math.round((compactedBpn + leaked.bytes_per_live_node!) / 2);
    const overrides = { bytesPerLiveNodeAlarm: threshold, minLiveNodes: 100 };

    const alarmed = await gauge(db, overrides);
    expect(alarmed.alarm).toBe(true);
    expect(alarmed.alarm_reasons.join(' ')).toMatch(/bytes_per_live_node \d+ > \d+/);
    expect(alarmed.remedy).toMatch(/memory fts-rebuild/);
    expect(alarmed.thresholds.bytes_per_live_node).toBe(threshold);

    // Too few live nodes to judge: no alarm on the ratio.
    expect((await gauge(db, { bytesPerLiveNodeAlarm: threshold, minLiveNodes: LIVE + 1 })).alarm).toBe(false);

    expect((await rebuildStoreOffline(db)).status).toBe('rebuilt');
    const rebuilt = await gauge(db, overrides);
    expect(rebuilt.alarm).toBe(false);
    expect(rebuilt.alarm_reasons).toEqual([]);
    expect(rebuilt.remedy).toBeNull();
    expect(rebuilt.fts_optimize_passes_since_rebuild).toBe(0);
    expect(rebuilt.last_rebuild_at).not.toBeNull();
  }, T);

  it('BL-c5249cdd: the gauge alarms on optimize passes since the last rebuild (default threshold)', async () => {
    const db = await seedLeakedStore();
    const { config } = resolveStoreGrowthConfig();
    await setPasses(db, config.optimizePassesSinceRebuildAlarm);
    expect((await gauge(db, { bytesPerLiveNodeAlarm: 1e12 })).alarm).toBe(false);
    await setPasses(db, config.optimizePassesSinceRebuildAlarm + 1);
    const g = await gauge(db, { bytesPerLiveNodeAlarm: 1e12 });
    expect(g.fts_optimize_passes_since_rebuild).toBe(config.optimizePassesSinceRebuildAlarm + 1);
    expect(g.alarm).toBe(true);
    expect(g.alarm_reasons.join(' ')).toMatch(/fts_optimize_passes_since_rebuild \d+ > \d+/);
  }, T);

  it('BL-c5249cdd: thresholds are typed numeric config; a malformed D3 env value is reported, never silently used', () => {
    const ok = resolveStoreGrowthConfig(undefined, { SOX_STORE_GROWTH_BYTES_PER_NODE_ALARM: '65536' });
    expect(ok.config.bytesPerLiveNodeAlarm).toBe(65536);
    expect(ok.errors).toEqual([]);
    const bad = resolveStoreGrowthConfig(undefined, { SOX_STORE_GROWTH_OPTIMIZE_PASSES_ALARM: 'banana' });
    expect(bad.config.optimizePassesSinceRebuildAlarm).toBe(32);
    expect(bad.errors.join(' ')).toMatch(/SOX_STORE_GROWTH_OPTIMIZE_PASSES_ALARM="banana" is not a positive number/);
    // Overrides beat env.
    expect(
      resolveStoreGrowthConfig({ bytesPerLiveNodeAlarm: 1000 }, { SOX_STORE_GROWTH_BYTES_PER_NODE_ALARM: '65536' }).config
        .bytesPerLiveNodeAlarm,
    ).toBe(1000);
  });
});
