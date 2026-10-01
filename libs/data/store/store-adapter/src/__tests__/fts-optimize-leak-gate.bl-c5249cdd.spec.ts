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
 *    version are asserted in ONE test: a driver bump turns this red, and the
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
    'BL-c5249cdd upgrade gate: the FTS segment leak no longer reproduces on the measured 0.8.1 driver (interleaved ≤ single)',
    async () => {
      const interleaved = await runArm('interleaved');
      const single = await runArm('single');
      const installed = installedTursoVersion();
      // Measured 0.8.1 on this corpus: 265 vs 266 pages. The interleaved
      // page_count NO LONGER exceeds the single-optimize control — 0.8.1's v2
      // segment registry does not orphan merged-away segments the way the
      // 0.7.1 Tantivy whole-index manifest did (0.7.1/0.7.2 measured 2,395 vs
      // 1,979 pages, +21%). `leak_reproduces` is asserted `false` here
      // deliberately: a driver that re-introduces the leak flips it back to
      // true and this gate goes red.
      //
      // BL-2bf0b7c8: both facts are asserted through ONE combined object —
      // vitest throws on the FIRST failing `expect`, so two separate `expect`s
      // can hide one of the two page_counts from the reported message (e.g. the
      // leak fact passes but the version-pin fact fails, and the interleaved
      // number never reaches the log). The combined object keeps the leak fact
      // (`leak_reproduces`) and the version-pin fact (`installed_matches`) as
      // SEPARATE fields, and the message embeds both raw page counts so a
      // failure on either fact always reports both numbers.
      const measuredOn = FTS_OPTIMIZE_LEAK_MEASURED_ON;
      expect(
        {
          leak_reproduces: interleaved > single * 1.1,
          installed_matches: installed === measuredOn,
          interleaved_pages: interleaved,
          single_pages: single,
        },
        `BL-c5249cdd / BL-2bf0b7c8: interleaved=${interleaved} single=${single} installed=${installed} ` +
          `measured_on=${measuredOn}. The leak is GONE on 0.8.1, so the interleaved page_count must NOT ` +
          `exceed 110% of the single-optimize control (leak_reproduces is expected false), and the ` +
          `installed driver must still be the version these facts were measured on. If a driver ` +
          `re-introduces the leak this gate goes red (leak_reproduces flips true) — re-measure and bump ` +
          `FTS_OPTIMIZE_LEAK_MEASURED_ON; if only the driver moved, re-measure and bump ` +
          `FTS_OPTIMIZE_LEAK_MEASURED_ON. Do not widen this comparison.`,
      ).toEqual({
        leak_reproduces: false,
        installed_matches: true,
        interleaved_pages: interleaved,
        single_pages: single,
      });
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
