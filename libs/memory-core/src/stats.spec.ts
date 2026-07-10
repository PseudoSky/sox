/**
 * stats.spec.ts — regression coverage for BL-250 on memoryGetStats().
 *
 * `StatsResult` carried an `embed_on_hash_fallback: boolean` field that was
 * ALWAYS the hardcoded constant `false` (`const onHashFallback = false;`,
 * stats.ts:180 pre-fix) — never derived from any real state. The hash backend
 * itself does not exist (EmbedBackend = 'auto' | 'real' only; embedWorker.ts
 * was deleted). This suite proves:
 *   1. `embed_on_hash_fallback` is gone from the StatsResult shape entirely
 *      (removing a lying constant, not replacing it with another lie).
 *   2. `embed_backend_configured` is derived from the SAME validated resolver
 *      embed.ts uses (getConfiguredEmbedBackend()) rather than a second,
 *      unchecked raw `process.env['SOX_EMBED_BACKEND']` read — an unknown
 *      value now throws instead of being silently reported.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from './db.js';
import { memoryGetStats } from './stats.js';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-spec-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function createDb(dbPath: string): Database.Database {
  return openDb(dbPath);
}

function seedEpisode(db: Database.Database, content: string): string {
  const uid = `ep-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO node (uid, kind, content, t_created, t_valid) VALUES (?, 'episode', ?, ?, ?)`,
  ).run(uid, content, now, now);
  return uid;
}

let savedBackend: string | undefined;
afterEach(() => {
  if (savedBackend === undefined) {
    delete process.env['SOX_EMBED_BACKEND'];
  } else {
    process.env['SOX_EMBED_BACKEND'] = savedBackend;
  }
});

describe('memoryGetStats (BL-250)', () => {
  it('does not expose embed_on_hash_fallback (the hash backend does not exist)', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      savedBackend = process.env['SOX_EMBED_BACKEND'];
      process.env['SOX_EMBED_BACKEND'] = 'auto';
      const db = createDb(path.join(dir, 't.db'));
      seedEpisode(db, 'BL-250 regression fixture episode.');

      const result = await memoryGetStats(db, {}, ['memory_ping', 'memory_stats']);

      expect(Object.prototype.hasOwnProperty.call(result, 'embed_on_hash_fallback')).toBe(false);
      expect(result.embed_backend_configured).toBe('auto');
      db.close();
    } finally {
      cleanup();
    }
  });

  it('propagates a clear error for an unknown SOX_EMBED_BACKEND value instead of reporting it as-is', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      savedBackend = process.env['SOX_EMBED_BACKEND'];
      process.env['SOX_EMBED_BACKEND'] = 'hash';
      const db = createDb(path.join(dir, 't.db'));
      seedEpisode(db, 'BL-250 regression fixture episode.');

      // Pre-fix: memoryGetStats read process.env directly and would have happily
      // returned `embed_backend_configured: "hash"` here instead of throwing.
      await expect(memoryGetStats(db, {}, ['memory_ping'])).rejects.toThrow(
        /Invalid SOX_EMBED_BACKEND.*"hash"/,
      );
      db.close();
    } finally {
      cleanup();
    }
  });
});
