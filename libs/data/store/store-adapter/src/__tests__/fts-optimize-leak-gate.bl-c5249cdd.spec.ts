/**
 * BL-c5249cdd — the Turso FTS segment leak: its upgrade gate, and the
 * persisted pass counter the growth gauge reads.
 *
 * 1. UPGRADE GATE. Interleaved insert + `OPTIMIZE INDEX` rounds grow
 *    `page_count` past a control that inserts the same corpus and optimizes
 *    once: each round's merged-away segments are orphaned, never freed or
 *    reused. A FIXED-corpus optimize loop never grows (nothing new to merge),
 *    so it cannot show this — the corpus must grow between optimizes, which is
 *    exactly what the in-service idle pass does. The leak and the driver
 *    version are asserted in ONE test (the `SUPPRESSION_VALID_FOR` precedent,
 *    integrity-selfheal.test.ts): a driver bump turns this red, and the
 *    response is to re-measure — if the leak is gone, `memory fts-rebuild` and
 *    the growth gauge's pass alarm can be retired; if it persists, bump
 *    `FTS_OPTIMIZE_LEAK_MEASURED_ON`.
 *
 * 2. PASS COUNTER. Every successful in-service pass increments
 *    `_adapter_meta.fts_optimize_passes_since_rebuild`, persisted across
 *    reopen — the driver of the leak, surfaced by `memory_ping`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { log } from '@adhd/sox-telemetry';
import { readStoreGrowthMeta } from '../adapter-meta.js';
import { FTS_OPTIMIZE_LEAK_MEASURED_ON } from '../store-rebuild.js';
import { TursoAdapterImpl } from '../turso-adapter.js';

const require = createRequire(import.meta.url);

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'bl-c5249cdd-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function installedTursoVersion(): string {
  let dir = dirname(require.resolve('@tursodatabase/database'));
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string };
      if (pkg.name === '@tursodatabase/database' && typeof pkg.version === 'string') return pkg.version;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate the installed @tursodatabase/database package.json');
}

const WORDS = 'alpha beta gamma delta epsilon zeta theta kappa lambda omicron sigma upsilon'.split(' ');
function doc(i: number): string {
  let s = '';
  for (let j = 0; j < 60; j++) s += `${WORDS[(i * 7 + j * 13) % WORDS.length]} `;
  return `${s} tok${i}`;
}

interface RawDb {
  exec(sql: string): Promise<unknown>;
  prepare(sql: string): Promise<{ run(...a: unknown[]): Promise<unknown>; get(...a: unknown[]): Promise<Record<string, unknown>> }>;
  close(): Promise<unknown>;
}

const ROUNDS = 20;
const PER_ROUND = 100;

/** Raw driver (no adapter, no open-time integrity/repair): the leak itself. */
async function runArm(mode: 'interleaved' | 'single'): Promise<number> {
  const { connect } = (await import('@tursodatabase/database')) as unknown as {
    connect(p: string, o: Record<string, unknown>): Promise<RawDb>;
  };
  const db = join(tmp, `${mode}.db`);
  const d = await connect(db, { timeout: 5000, experimental: ['index_method', 'multiprocess_wal'] });
  try {
    await d.exec('CREATE TABLE node (rowid INTEGER PRIMARY KEY, content TEXT)');
    await d.exec('CREATE INDEX idx_fts_node ON node USING fts (content)');
    const ins = await d.prepare('INSERT INTO node (content) VALUES (?)');
    for (let r = 0; r < ROUNDS; r++) {
      for (let j = 0; j < PER_ROUND; j++) await ins.run(doc(r * PER_ROUND + j));
      if (mode === 'interleaved') await d.exec('OPTIMIZE INDEX idx_fts_node');
    }
    if (mode === 'single') await d.exec('OPTIMIZE INDEX idx_fts_node');
    const pc = await (await d.prepare('PRAGMA page_count')).get();
    return Number(Object.values(pc)[0]);
  } finally {
    await d.close();
  }
}

describe('BL-c5249cdd — Turso FTS segment leak', () => {
  it(
    'BL-c5249cdd upgrade gate: interleaved insert+OPTIMIZE rounds grow page_count past a single-optimize control, on the measured driver',
    async () => {
      const interleaved = await runArm('interleaved');
      const single = await runArm('single');
      // Measured 0.7.1/0.7.2 on this corpus: 2,395 vs 1,979 pages (+21%).
      expect(
        interleaved,
        `interleaved=${interleaved} single=${single}: the leak no longer reproduces. If the driver was ` +
          `upgraded and fixed it, retire the pass alarm / re-evaluate memory fts-rebuild (BL-c5249cdd).`,
      ).toBeGreaterThan(single * 1.1);
      expect(
        installedTursoVersion(),
        `BL-c5249cdd: the FTS segment leak (and the rebuild + growth gauge that manage it) was measured on ` +
          `@tursodatabase/database ${FTS_OPTIMIZE_LEAK_MEASURED_ON}; the installed driver has moved. Re-run this ` +
          `gate's measurement on the new version: if the leak is gone, retire the pass alarm and re-evaluate ` +
          `memory fts-rebuild; if it persists, bump FTS_OPTIMIZE_LEAK_MEASURED_ON with the new date. Do not ` +
          `widen this comparison.`,
      ).toBe(FTS_OPTIMIZE_LEAK_MEASURED_ON);
    },
    600_000,
  );

  it('BL-c5249cdd: every in-service OPTIMIZE pass is counted in _adapter_meta and the count survives reopen', async () => {
    const dbPath = join(tmp, 'counter.db');
    const seed = await TursoAdapterImpl.connect({ dbPath });
    await seed.exec('CREATE TABLE node (id INTEGER PRIMARY KEY, content TEXT)');
    await seed.exec('CREATE INDEX idx_fts_node ON node USING fts (content)');
    await seed.close();

    const infoSpy = vi.spyOn(log, 'info');
    const finishes = (): number => infoSpy.mock.calls.filter(([e]) => e === 'fts.optimize.finish').length;
    const a = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: 300, ftsOptimizeWriteThreshold: 40 });
    try {
      for (let pass = 1; pass <= 2; pass++) {
        for (let i = 0; i < 60; i++) await a.executeRun('INSERT INTO node (content) VALUES (?)', [doc(pass * 1000 + i)]);
        const deadline = Date.now() + 120_000;
        while (finishes() < pass && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
        expect(finishes()).toBe(pass);
      }
      // Let the idle release that follows the second pass settle.
      await new Promise((r) => setTimeout(r, 700));
    } finally {
      await a.close();
      infoSpy.mockRestore();
    }

    const ro = await TursoAdapterImpl.connect({ dbPath, readonly: true, allowFtsInReadonly: true });
    try {
      const meta = await readStoreGrowthMeta(ro);
      expect(meta.ftsOptimizePassesSinceRebuild).toBe(2);
      expect(meta.lastRebuildAt).toBeNull();
    } finally {
      await ro.close();
    }
  }, 300_000);
});
