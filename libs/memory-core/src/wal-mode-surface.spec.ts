/**
 * wal-mode-surface.spec.ts — BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001
 *
 * The store-concurrency contract is surfaced on the health/coverage read a CI
 * gate actually calls: `memoryGetStats` (→ `memory_stats`) now reports
 * `wal_mode` and `wal_mode_verified`, read from the adapter's OWN capability
 * surface (the ONE source of truth), never re-derived. This spec pins both
 * arms:
 *
 *   - sqlite  → `wal_mode: 'single-writer'`, `wal_mode_verified: true` (the
 *     mode is intrinsic to a single in-process connection; nothing to probe).
 *   - turso   → `wal_mode: 'multiprocess-wal'`, `wal_mode_verified: true`
 *     (the open ceremony verified the `-tshm` coordinator before the stats
 *     read).
 *
 * HF-3 additive: the fields only ADD to `StatsResult` — the existing
 * `enrich_version`/`total_episodes`/etc. fields are untouched.
 *
 * RED→GREEN (BL-225): before this contract, `StatsResult` had no `wal_mode`
 * field at all — `result.wal_mode` was `undefined` on every backend. The
 * `toBe('single-writer')`/`toBe('multiprocess-wal')` assertions fail against
 * that pre-contract shape and pass here.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { openDb } from './db.js';
import { memoryGetStats } from './stats.js';

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

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-mode-surface-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

let savedAdapter: string | undefined;
afterEach(() => {
  if (savedAdapter === undefined) delete process.env['STORE_ADAPTER'];
  else process.env['STORE_ADAPTER'] = savedAdapter;
});

async function statsFor(dbPath: string): Promise<{ wal_mode: unknown; wal_mode_verified: unknown; db: StoreAdapter }> {
  const db = await openDb(dbPath);
  const result = await memoryGetStats(db, {}, ['memory_stats']);
  return { wal_mode: result.wal_mode, wal_mode_verified: result.wal_mode_verified, db };
}

describe('memoryGetStats — wal_mode surface (sqlite arm, deterministic)', () => {
  it('reports wal_mode single-writer + wal_mode_verified true on the sqlite backend', async () => {
    savedAdapter = process.env['STORE_ADAPTER'];
    process.env['STORE_ADAPTER'] = 'sqlite';

    const { dir, cleanup } = tmpDir();
    try {
      const { wal_mode, wal_mode_verified, db } = await statsFor(path.join(dir, 't.db'));
      expect(wal_mode).toBe('single-writer');
      expect(wal_mode_verified).toBe(true);
      await db.close();
    } finally {
      cleanup();
    }
  });
});

tursoDescribe('memoryGetStats — wal_mode surface (turso arm)', () => {
  it('reports wal_mode multiprocess-wal + wal_mode_verified true on the turso backend', async () => {
    savedAdapter = process.env['STORE_ADAPTER'];
    process.env['STORE_ADAPTER'] = 'turso';

    const { dir, cleanup } = tmpDir();
    try {
      const { wal_mode, wal_mode_verified, db } = await statsFor(path.join(dir, 't.db'));
      expect(wal_mode).toBe('multiprocess-wal');
      expect(wal_mode_verified).toBe(true);
      await db.close();
    } finally {
      cleanup();
    }
  });
});
