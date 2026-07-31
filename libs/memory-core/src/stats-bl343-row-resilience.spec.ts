/**
 * stats-bl343-row-resilience.spec.ts — one malformed row must not disable an
 * entire aggregate.
 *
 * BL-342 is the data defect: the 2026-07-30 restore wrote `tags = ''` — the
 * empty string, which is not valid JSON — where it should have written NULL.
 * BL-343 is the far more important structural defect it exposed: `memory_stats`
 * runs `json_extract(...)` across every episode row with no row-level
 * resilience, so a SINGLE malformed row takes the WHOLE tool offline:
 *
 *   memory_stats → Tool error: Error: step failed: Parse error: malformed JSON
 *
 * That is still the live behaviour of `~/.memory/memory.db` as of 2026-07-31.
 * Half the new integrity status surface landed in `memory_stats` and is
 * unreachable because of it.
 *
 * The contract this file pins:
 *   1. `memoryGetStats` RETURNS on a store containing malformed JSON — never throws.
 *   2. The good rows are still counted correctly (the bad row is skipped, not
 *      the whole aggregate).
 *   3. The skipped rows are REPORTED. A silently-skipped row is its own defect:
 *      it converts a loud failure into a quiet wrong number, which is worse.
 *      `malformed_rows` must be non-zero and name the affected columns.
 */
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { memoryGetStats } from './stats.js';

function raw(a: StoreAdapter): Database.Database {
  return a.unwrap() as Database.Database;
}

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl343-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Insert a well-formed episode. */
async function seedGood(db: StoreAdapter, content: string): Promise<void> {
  const uid = `ok-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  await db.executeRun(`INSERT INTO node (uid, kind, content, tags, topic, summary, project_path, enrich_ver, t_created, t_valid)
       VALUES (?, 'episode', ?, ?, 'a-topic', 'a summary', '/p', ?, ?, ?)`, [uid, content, JSON.stringify(['x']), JSON.stringify({ pass: 'v1' }), now, now]);
}

/**
 * Insert an episode whose JSON column holds the empty string — the exact shape
 * BL-342's restore produced. `''` is not valid JSON, so any json_extract /
 * json_each touching it aborts the statement.
 */
async function seedMalformed(db: StoreAdapter, column: 'tags' | 'enrich_ver' | 'meta'): Promise<void> {
  const uid = `bad-${column}-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  await db.executeRun(`INSERT INTO node (uid, kind, content, ${column}, t_created, t_valid)
       VALUES (?, 'episode', 'malformed row fixture', '', ?, ?)`, [uid, now, now]);
}

let savedBackend: string | undefined;
afterEach(() => {
  if (savedBackend === undefined) delete process.env['SOX_EMBED_BACKEND'];
  else process.env['SOX_EMBED_BACKEND'] = savedBackend;
});

describe('BL-343 — memory_stats survives malformed JSON rows', () => {
  it('BL-343: returns stats instead of throwing when a row has tags = \'\' (the BL-342 shape)', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      savedBackend = process.env['SOX_EMBED_BACKEND'];
      process.env['SOX_EMBED_BACKEND'] = 'auto';
      const db = await openDb(path.join(dir, 't.db'));
      try {
        seedGood(db, 'first good episode');
        seedGood(db, 'second good episode');
        seedMalformed(db, 'tags');

        // Pre-fix this rejects with "Parse error: malformed JSON".
        const result = await memoryGetStats(db, {}, ['memory_stats']);

        expect(result.total_episodes).toBe(3);
        expect(result.malformed_rows.count).toBeGreaterThan(0);
        expect(result.malformed_rows.columns).toContain('tags');
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  });

  it('BL-343: returns stats when a row has enrich_ver = \'\' (the column stats.ts:120 actually parses)', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      savedBackend = process.env['SOX_EMBED_BACKEND'];
      process.env['SOX_EMBED_BACKEND'] = 'auto';
      const db = await openDb(path.join(dir, 't.db'));
      try {
        seedGood(db, 'good one');
        seedMalformed(db, 'enrich_ver');

        const result = await memoryGetStats(db, {}, ['memory_stats']);

        expect(result.total_episodes).toBe(2);
        expect(result.malformed_rows.count).toBeGreaterThan(0);
        expect(result.malformed_rows.columns).toContain('enrich_ver');
        // BL-343's acceptance requires naming the offending row, not just
        // counting it — diagnosing BL-342 needed a bespoke json_valid() sweep
        // precisely because the error named neither row nor column.
        expect(result.malformed_rows.sample_rowids.length).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  });

  it('BL-343: a clean store reports zero malformed rows (the counter is not a constant)', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      savedBackend = process.env['SOX_EMBED_BACKEND'];
      process.env['SOX_EMBED_BACKEND'] = 'auto';
      const db = await openDb(path.join(dir, 't.db'));
      try {
        seedGood(db, 'only good rows here');

        const result = await memoryGetStats(db, {}, ['memory_stats']);

        expect(result.total_episodes).toBe(1);
        expect(result.malformed_rows.count).toBe(0);
        expect(result.malformed_rows.columns).toEqual([]);
        expect(result.malformed_rows.sample_rowids).toEqual([]);
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  });
});
