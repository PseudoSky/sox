/**
 * (BL-508) Client/engine version tracking — memory-core surface.
 *
 * openDb (the memory-core store open path) reads the store's engine identity
 * (`_sox_engine` marker row written by store-adapter on first open) and
 * surfaces it through `getStoreEngineIdentity(adapter)` — the helper the
 * memory_ping store block wires as `store_engine`. The marker row is DATA on
 * the health surface (HF-3 additive rule): an absent marker reads as `null`
 * (a legacy pre-marker store), never as a health failure.
 *
 * The marker mechanics themselves (write-once, refusal guard, version-mismatch
 * warning) are pinned by the store-adapter suite
 * (`store-adapter/src/__tests__/engine-guard.bl508.test.ts`) with real
 * engines. This suite pins the memory-core surface end-to-end through the
 * real `openDb` path.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb, getStoreEngineIdentity } from './db.js';
import type { StoreAdapter } from '@adhd/sox-store-adapter';

const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();
const tursoDescribe = hasTurso ? describe : describe.skip;

const openAdapters: StoreAdapter[] = [];

function tmpDbPath(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bl508-mc-${label}-`));
  return path.join(dir, 'memory.db');
}

afterEach(async () => {
  while (openAdapters.length > 0) {
    const a = openAdapters.pop()!;
    try {
      await a.close();
    } catch {
      // already closed
    }
  }
});

tursoDescribe('BL-508 engine identity — memory-core openDb surface (f)', () => {
  it('openDb on a fresh turso store yields a turso engine identity via getStoreEngineIdentity', async () => {
    // Force the real turso adapter (openDb → createStoreAdapter env default).
    const prev = process.env.STORE_ADAPTER;
    process.env.STORE_ADAPTER = 'turso';
    try {
      const dbPath = tmpDbPath('fresh');
      const adapter = await openDb(dbPath);
      openAdapters.push(adapter);

      expect(adapter.config.type).toBe('turso');

      const identity = await getStoreEngineIdentity(adapter);
      expect(identity, 'fresh turso store must carry the _sox_engine marker row').not.toBeNull();
      expect(identity!.engine).toBe('turso');
      expect(typeof identity!.sox_version).toBe('string');
      expect(identity!.sox_version.length).toBeGreaterThan(0);
      expect(typeof identity!.driver_version).toBe('string');
      expect(Number.isNaN(Date.parse(identity!.first_opened_at))).toBe(false);
      expect(Number.isNaN(Date.parse(identity!.last_opened_at))).toBe(false);
      // The identity is stable across reads (same marker row).
      const again = await getStoreEngineIdentity(adapter);
      expect(again!.first_opened_at).toBe(identity!.first_opened_at);
    } finally {
      if (prev === undefined) delete process.env.STORE_ADAPTER;
      else process.env.STORE_ADAPTER = prev;
    }
  });

  it('a raw store with no marker reads as null identity (legacy, not a health failure)', async () => {
    const prev = process.env.STORE_ADAPTER;
    process.env.STORE_ADAPTER = 'turso';
    try {
      const dbPath = tmpDbPath('unmarked');
      // Create the file WITHOUT the sox marker: raw better-sqlite3.
      const { default: Database } = await import('better-sqlite3');
      const raw = new Database(dbPath);
      raw.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      raw.close();

      const adapter = await openDb(dbPath);
      openAdapters.push(adapter);

      // The legacy heuristic classifies it sqlite (content, no turso rows),
      // so the turso adapter did NOT stamp it — it stays unmarked → null.
      const identity = await getStoreEngineIdentity(adapter);
      expect(identity).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.STORE_ADAPTER;
      else process.env.STORE_ADAPTER = prev;
    }
  });
});
