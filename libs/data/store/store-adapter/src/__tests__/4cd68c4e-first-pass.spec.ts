/**
 * 4cd68c4e follow-on — the in-service FTS optimize pass must never run the
 * one-time backlog merge.
 *
 * The first cut started `_ftsWritesSinceOptimize` AT the threshold, so every
 * freshly opened process ran `OPTIMIZE INDEX` at its first quiet point. On
 * prod's ~5,001-segment backlog that is a 27–34 s synchronous (main-thread)
 * merge, and the quiescence check guarding it is check-then-act under no lock,
 * so a peer opening mid-pass outlasts its 5 s busy timeout. Now:
 *
 *  - the counter starts at 0: the idle pass only ever merges steady-state
 *    growth (`threshold` writes' worth of segments);
 *  - the backlog merge is the explicit OFFLINE entry point
 *    `optimizeFtsIndexes(dbPath)`, which refuses while any lease peer is live;
 *  - a pass starved by live peers past 4× the threshold warns
 *    (`fts.optimize.starved`) once per crossing;
 *  - a failing pass backs off exponentially (capped at 1 h) instead of
 *    erroring at every idle point.
 *
 * "The idle point ran" is proven positively by the
 * `store_adapter.turso.idle_flush` event (emitted after the optimize decision),
 * never by a bare sleep — a sleep would pass on the broken code too.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { log } from '@adhd/sox-telemetry';
import {
  TursoAdapterImpl,
  optimizeFtsIndexes,
  ftsOptimizeBackoffMs,
  FTS_OPTIMIZE_BACKOFF_BASE_MS,
  FTS_OPTIMIZE_BACKOFF_CAP_MS,
  DEFAULT_FTS_OPTIMIZE_WRITE_THRESHOLD,
} from '../turso-adapter.js';

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
  tmpDir = mkdtempSync(join(tmpdir(), '4cd68c4e-first-'));
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

const WORDS = 'alpha beta gamma delta epsilon zeta eta theta iota kappa'.split(' ');
const doc = (): string =>
  Array.from({ length: 20 }, () => WORDS[Math.floor(Math.random() * WORDS.length)]).join(' ');

async function seedFtsStore(dbPath: string): Promise<void> {
  const seed = await TursoAdapterImpl.connect({ dbPath });
  await seed.exec('CREATE TABLE node (id INTEGER PRIMARY KEY, content TEXT)');
  await seed.exec('CREATE INDEX idx_fts_node ON node USING fts (content)');
  await seed.close();
}

type Spy = { mock: { calls: unknown[][] } };
const count = (spy: Spy, event: string): number => spy.mock.calls.filter(([e]) => e === event).length;

/** Resolve once one MORE idle point has completed on this process. */
async function nextIdlePoint(debugSpy: Spy, what: string): Promise<void> {
  const before = count(debugSpy, 'store_adapter.turso.idle_flush');
  await until(() => count(debugSpy, 'store_adapter.turso.idle_flush') > before, 60_000, what);
}

tursoDescribe('4cd68c4e — no first-pass optimize; backlog merge is offline', () => {
  it('a freshly opened adapter (DEFAULT threshold) does NOT run OPTIMIZE at its first idle point', async () => {
    const dbPath = join(tmpDir, 'fresh-default.db');
    await seedFtsStore(dbPath);
    const infoSpy = vi.spyOn(log, 'info');
    const debugSpy = vi.spyOn(log, 'debug');
    const a = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: 150 });
    try {
      expect(a.ftsMaintenance.threshold).toBe(DEFAULT_FTS_OPTIMIZE_WRITE_THRESHOLD);
      await a.executeGet('SELECT 1 AS one');
      await nextIdlePoint(debugSpy, 'first idle point');
      expect(count(infoSpy, 'fts.optimize.start')).toBe(0);
      expect(a.ftsMaintenance.last).toBeNull();
      expect(a.ftsMaintenance.writesSinceOptimize).toBeLessThan(DEFAULT_FTS_OPTIMIZE_WRITE_THRESHOLD);
    } finally {
      infoSpy.mockRestore();
      debugSpy.mockRestore();
      await a.close();
    }
  }, 120_000);

  it('with a threshold override: no pass at the first idle point, then a pass once `threshold` writes land', async () => {
    const dbPath = join(tmpDir, 'fresh-threshold.db');
    await seedFtsStore(dbPath);
    const infoSpy = vi.spyOn(log, 'info');
    const debugSpy = vi.spyOn(log, 'debug');
    const a = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: 150, ftsOptimizeWriteThreshold: 20 });
    try {
      await a.executeGet('SELECT 1 AS one');
      await nextIdlePoint(debugSpy, 'first idle point');
      expect(count(infoSpy, 'fts.optimize.start')).toBe(0);
      expect(a.ftsMaintenance.last).toBeNull();
      expect(a.ftsMaintenance.writesSinceOptimize).toBeLessThan(20);

      for (let i = 0; i < 20; i++) await a.executeRun('INSERT INTO node (content) VALUES (?)', [doc()]);
      await until(() => a.ftsMaintenance.last?.status === 'optimized', 60_000, 'steady-state optimize');
      expect(a.ftsMaintenance.last).toMatchObject({ status: 'optimized', indexes: ['idx_fts_node'] });
      expect(count(infoSpy, 'fts.optimize.finish')).toBe(1);
    } finally {
      infoSpy.mockRestore();
      debugSpy.mockRestore();
      await a.close();
    }
  }, 120_000);

  it('optimizeFtsIndexes(dbPath) — the offline entry point — merges every FTS index and reports', async () => {
    const dbPath = join(tmpDir, 'offline.db');
    await seedFtsStore(dbPath);
    const w = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: 600_000 });
    for (let i = 0; i < 60; i++) await w.executeRun('INSERT INTO node (content) VALUES (?)', [doc()]);
    await w.close();

    const report = await optimizeFtsIndexes(dbPath);
    expect(report).toMatchObject({ status: 'optimized', indexes: ['idx_fts_node'] });
    expect(typeof report.duration_ms).toBe('number');
    expect(report.per_index).toHaveLength(1);
    expect(report.per_index[0]).toMatchObject({ index: 'idx_fts_node', ok: true });

    const r = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: 600_000 });
    try {
      const hits = await r.executeAll<{ id: number }>(
        "SELECT id FROM node WHERE fts_match(content, 'gamma') LIMIT 5",
      );
      expect(hits.rows.length).toBeGreaterThan(0);
    } finally {
      await r.close();
    }
  }, 120_000);

  it('optimizeFtsIndexes(dbPath) REFUSES while a lease peer is live and runs no OPTIMIZE', async () => {
    const dbPath = join(tmpDir, 'offline-peer.db');
    await seedFtsStore(dbPath);
    const peer = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: 600_000 });
    await peer.executeGet('SELECT 1 AS one');
    const infoSpy = vi.spyOn(log, 'info');
    try {
      const report = await optimizeFtsIndexes(dbPath);
      expect(report.status).toBe('refused');
      expect(report.peer_count).toBeGreaterThanOrEqual(1);
      expect(report.indexes).toEqual([]);
      expect(count(infoSpy, 'fts.optimize.start')).toBe(0);
    } finally {
      infoSpy.mockRestore();
      await peer.close();
    }
  }, 120_000);

  it('a pass starved by a live peer warns fts.optimize.starved ONCE when the counter crosses 4x the threshold', async () => {
    const dbPath = join(tmpDir, 'starved.db');
    await seedFtsStore(dbPath);
    const peer = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: 600_000 });
    await peer.executeGet('SELECT 1 AS one');
    const warnSpy = vi.spyOn(log, 'warn');
    const debugSpy = vi.spyOn(log, 'debug');
    const a = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: 150, ftsOptimizeWriteThreshold: 5 });
    try {
      // 4 cycles of 10 writes: counter ≈ 10, 20, 30, 40 at the idle points;
      // it crosses 4×5 = 20 exactly once.
      for (let cycle = 1; cycle <= 4; cycle++) {
        for (let i = 0; i < 10; i++) await a.executeRun('INSERT INTO node (content) VALUES (?)', [doc()]);
        await nextIdlePoint(debugSpy, `idle point after cycle ${cycle}`);
        expect(a.ftsMaintenance.last).toMatchObject({ status: 'skipped', reason: 'peers' });
      }
      expect(a.ftsMaintenance.writesSinceOptimize).toBeGreaterThan(20);
      expect(count(warnSpy, 'fts.optimize.starved')).toBe(1);
      const payload = warnSpy.mock.calls.find(([e]) => e === 'fts.optimize.starved')?.[1];
      expect(payload).toMatchObject({ threshold: 5 });
    } finally {
      warnSpy.mockRestore();
      debugSpy.mockRestore();
      await a.close();
      await peer.close();
    }
  }, 180_000);

  it('a failing OPTIMIZE backs off exponentially: one attempt (one error) across several idle points', async () => {
    const dbPath = join(tmpDir, 'backoff.db');
    await seedFtsStore(dbPath);
    const errorSpy = vi.spyOn(log, 'error');
    const debugSpy = vi.spyOn(log, 'debug');
    const a = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: 150, ftsOptimizeWriteThreshold: 5 });
    // Inject an OPTIMIZE failure at the driver-handle level. The adapter
    // swaps its handle on every idle release / reconnect, so intercept the
    // assignment and wrap whichever handle is current.
    let optimizeCalls = 0;
    const wrap = (h: { exec: (sql: string) => Promise<unknown> }): object => {
      const w = Object.create(h) as { exec: (sql: string) => Promise<unknown> };
      w.exec = (sql: string) => {
        if (/^OPTIMIZE INDEX/i.test(sql)) {
          optimizeCalls++;
          return Promise.reject(new Error('injected optimize failure'));
        }
        return h.exec(sql);
      };
      return w;
    };
    const holder = a as unknown as { db: { exec: (sql: string) => Promise<unknown> } };
    let inner = wrap(holder.db);
    Object.defineProperty(holder, 'db', {
      configurable: true,
      get: () => inner,
      set: (v: { exec: (sql: string) => Promise<unknown> }) => {
        inner = wrap(v);
      },
    });
    try {
      for (let i = 0; i < 5; i++) await a.executeRun('INSERT INTO node (content) VALUES (?)', [doc()]);
      await until(() => a.ftsMaintenance.last?.status === 'failed', 60_000, 'first failed pass');
      const nextAt = a.ftsMaintenance.nextAttemptAt;
      expect(a.ftsMaintenance.consecutiveFailures).toBe(1);
      expect(nextAt).not.toBeNull();
      expect(nextAt! - Date.now()).toBeGreaterThan(FTS_OPTIMIZE_BACKOFF_BASE_MS - 5_000);

      for (let k = 0; k < 3; k++) {
        await a.executeRun('INSERT INTO node (content) VALUES (?)', [doc()]);
        await nextIdlePoint(debugSpy, `idle point ${k} inside the backoff window`);
      }
      expect(count(errorSpy, 'fts.optimize.failed')).toBe(1);
      expect(optimizeCalls).toBe(1);
    } finally {
      errorSpy.mockRestore();
      debugSpy.mockRestore();
      await a.close();
    }
  }, 180_000);

  it('ftsOptimizeBackoffMs doubles per consecutive failure and caps at 1 h', () => {
    expect(ftsOptimizeBackoffMs(1)).toBe(FTS_OPTIMIZE_BACKOFF_BASE_MS);
    expect(ftsOptimizeBackoffMs(2)).toBe(2 * FTS_OPTIMIZE_BACKOFF_BASE_MS);
    expect(ftsOptimizeBackoffMs(3)).toBe(4 * FTS_OPTIMIZE_BACKOFF_BASE_MS);
    expect(FTS_OPTIMIZE_BACKOFF_CAP_MS).toBe(3_600_000);
    expect(ftsOptimizeBackoffMs(50)).toBe(FTS_OPTIMIZE_BACKOFF_CAP_MS);
  });
});
