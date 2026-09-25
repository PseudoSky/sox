/**
 * 4cd68c4e — Turso FTS (Tantivy) segments grow without bound; the adapter never
 * ran `OPTIMIZE INDEX`.
 *
 * Every committed write that touches an `USING fts`-indexed table adds one
 * segment; nothing merges them, so per-insert cost and `fts_match` latency grow
 * linearly with the store's write history (prod: 5,001 segments, fts_match
 * 601 ms). The fix is a bounded maintenance pass at the adapter's idle point
 * (`_maybeOptimizeFts`, run from `_performIdleFlush`): once
 * `ftsOptimizeWriteThreshold` writes have landed it runs `OPTIMIZE INDEX` on
 * every index-method index — ONLY when the store is quiescent.
 *
 * Teeth (BL-225): with the pass disabled (`_maybeOptimizeFts` returning null),
 * the "optimizes at the idle point" arm never sees `fts.optimize.finish` and
 * times out, and the peer arm never sees `fts.optimize.skipped`.
 *
 * Latency is a SECONDARY check only (this box runs at load 100–300): the
 * primary assertions are the telemetry events and the maintenance state.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { log } from '@adhd/sox-telemetry';
import { TursoAdapterImpl } from '../turso-adapter.js';

const require = createRequire(import.meta.url);
const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();
const tursoDescribe = hasTurso ? describe : describe.skip;

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), '4cd68c4e-'));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out after ${ms}ms waiting for: ${what}`);
}

const WORDS = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi'.split(' ');
function doc(): string {
  return Array.from({ length: 30 }, () => WORDS[Math.floor(Math.random() * WORDS.length)]).join(' ');
}

async function seedFtsStore(dbPath: string): Promise<void> {
  const seed = await TursoAdapterImpl.connect({ dbPath });
  await seed.exec('CREATE TABLE node (id INTEGER PRIMARY KEY, content TEXT)');
  await seed.exec('CREATE INDEX idx_fts_node ON node USING fts (content)');
  await seed.close();
}

async function medianInsertMs(a: TursoAdapterImpl, n: number): Promise<number> {
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await a.executeRun('INSERT INTO node (content) VALUES (?)', [doc()]);
    xs.push(performance.now() - t);
  }
  xs.sort((x, y) => x - y);
  return xs[Math.floor(xs.length / 2)]!;
}

tursoDescribe('4cd68c4e — FTS segments are bounded by an idle-point OPTIMIZE INDEX pass', () => {
  it('after N segment-producing writes, the idle point runs OPTIMIZE INDEX (fts.optimize.start/finish) and resets the counter', async () => {
    const dbPath = join(tmpDir, 'bounded.db');
    await seedFtsStore(dbPath);
    const infoSpy = vi.spyOn(log, 'info');
    // Long idle window during the write burst so no pass runs mid-burst; the
    // threshold is small so the test stays fast.
    const a = await TursoAdapterImpl.connect({
      dbPath,
      idleFlushMs: 400,
      ftsOptimizeWriteThreshold: 200,
    });
    try {
      // The fresh-process "unknown backlog" pass: a new instance starts AT the
      // threshold, so its first idle point optimizes once.
      await a.executeGet('SELECT 1 AS one');
      await until(() => a.ftsMaintenance.last?.status === 'optimized', 60_000, 'first (catch-up) optimize');
      infoSpy.mockClear();

      // Accumulate 400 single-row commits = ~400 segments.
      for (let i = 0; i < 400; i++) {
        await a.executeRun('INSERT INTO node (content) VALUES (?)', [doc()]);
      }
      const before = await medianInsertMs(a, 15);
      expect(a.ftsMaintenance.writesSinceOptimize).toBeGreaterThanOrEqual(400);

      await until(
        () => infoSpy.mock.calls.some(([e]) => e === 'fts.optimize.finish'),
        120_000,
        'fts.optimize.finish after the burst',
      );
      const start = infoSpy.mock.calls.find(([e]) => e === 'fts.optimize.start');
      const finish = infoSpy.mock.calls.find(([e]) => e === 'fts.optimize.finish');
      expect(start?.[1]).toMatchObject({ index: 'idx_fts_node' });
      expect(finish?.[1]).toMatchObject({ index: 'idx_fts_node' });
      expect(typeof (finish?.[1] as { duration_ms: unknown }).duration_ms).toBe('number');
      expect(a.ftsMaintenance.last).toMatchObject({ status: 'optimized', indexes: ['idx_fts_node'] });
      // Reset by the pass; the idle release that follows writes its
      // clean-shutdown stamp through the tracked write path (+1).
      expect(a.ftsMaintenance.writesSinceOptimize).toBeLessThanOrEqual(2);

      // Secondary (wide tolerance, loaded box): inserts against the merged
      // index are not slower than against the ~400-segment one.
      const after = await medianInsertMs(a, 15);
      console.log(`[4cd68c4e] median insert ms: before=${before.toFixed(2)} after=${after.toFixed(2)}`);
      expect(after).toBeLessThan(before * 1.5);

      // The index still answers queries after the merge.
      const hits = await a.executeAll<{ id: number }>(
        "SELECT id FROM node WHERE fts_match(content, 'gamma') LIMIT 5",
      );
      expect(hits.rows.length).toBeGreaterThan(0);
    } finally {
      infoSpy.mockRestore();
      await a.close();
    }
  }, 300_000);

  it('with a live peer holding the store, the pass is SKIPPED (reason peers) and the counter is kept', async () => {
    const dbPath = join(tmpDir, 'peer.db');
    await seedFtsStore(dbPath);
    // Peer: long idle window, so it keeps its lease for the whole test.
    const peer = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: 600_000 });
    await peer.executeGet('SELECT 1 AS one');
    const infoSpy = vi.spyOn(log, 'info');
    const a = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: 200, ftsOptimizeWriteThreshold: 10 });
    try {
      for (let i = 0; i < 20; i++) {
        await a.executeRun('INSERT INTO node (content) VALUES (?)', [doc()]);
      }
      await until(() => a.ftsMaintenance.last !== null, 60_000, 'an optimize decision');
      expect(a.ftsMaintenance.last).toMatchObject({ status: 'skipped', reason: 'peers' });
      expect(a.ftsMaintenance.last!.peer_count).toBeGreaterThanOrEqual(1);
      expect(a.ftsMaintenance.writesSinceOptimize).toBeGreaterThanOrEqual(20);
      expect(infoSpy.mock.calls.some(([e]) => e === 'fts.optimize.skipped')).toBe(true);
      expect(infoSpy.mock.calls.some(([e]) => e === 'fts.optimize.start')).toBe(false);
    } finally {
      infoSpy.mockRestore();
      await a.close();
      await peer.close();
    }
  }, 120_000);
});
