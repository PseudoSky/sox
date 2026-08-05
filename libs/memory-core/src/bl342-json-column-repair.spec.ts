/**
 * BL-342 — the malformed JSON *data* is repaired, end to end.
 *
 * ── What this file is NOT ───────────────────────────────────────────────────
 *
 * It is not BL-343. BL-343 made `memory_stats` survive a malformed row by
 * gating every `json_extract` on `json_valid`, and
 * `stats-bl343-row-resilience.spec.ts` pins that. Surviving is not repairing:
 * a gated row is *excluded from every JSON-dependent aggregate*, silently and
 * forever, and the live store still reported
 * `malformed_rows: {count: 1, columns: ["tags"], sample_rowids: [9284]}` three
 * days after BL-343 shipped. This file pins the other half — the row goes away.
 *
 * ── The trap ────────────────────────────────────────────────────────────────
 *
 * The live sweep named `tags`, and `tags` is not the column that throws:
 * `with_tags` only tests `tags IS NOT NULL` (`stats.ts:98`) and never parses
 * the value. The column that kills `memory_stats` is **`enrich_ver`**, through
 * the `legacy_episodes` query's `json_extract(enrich_ver, '$.note')`. Repairing
 * only `tags` would leave the tool dead while appearing to fix it — so the
 * first test here seeds `enrich_ver`, and the second seeds all three columns
 * and asserts a single pass clears all of them.
 *
 * ── Why the repair is exercised through a plain reopen ──────────────────────
 *
 * Per the owner directive the repair belongs in the adapter's verify-and-repair
 * path (BL-352), never a manual write to `~/.memory/*`. The tests therefore
 * seed damage, close, and reopen with the ordinary `openDb` every caller uses.
 * No test here issues repair SQL — if the adapter did not do it, it did not
 * happen.
 *
 * The SEEDING open uses `openLegacyDb` (BL-430): a store created today carries
 * `CHECK (col IS NULL OR json_valid(col))` and cannot hold `''` at all, so the
 * damaged population this repair exists for is exactly the pre-constraint one.
 * The open under test is the plain `openDb` every caller performs.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { openLegacyDb } from './testing/legacy-store.js';
import { memoryGetStats } from './stats.js';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl342-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

let seq = 0;

/** A well-formed episode: every JSON column holds real JSON. */
async function seedGood(db: StoreAdapter, content: string): Promise<void> {
  const now = new Date().toISOString();
  await db.executeRun(
    `INSERT INTO node (uid, kind, content, tags, meta, topic, summary, project_path, enrich_ver, t_created, t_valid)
     VALUES (?, 'episode', ?, ?, ?, 'a-topic', 'a summary', '/p', ?, ?, ?)`,
    [
      `ok-${seq++}`,
      content,
      JSON.stringify(['x']),
      JSON.stringify({ source: 'test' }),
      JSON.stringify({ pass: 'v1' }),
      now,
      now,
    ],
  );
}

/**
 * The exact BL-342 restore shape: `''` in a JSON column, which is neither NULL
 * nor valid JSON. Returns the rowid so the repair can be checked on the row
 * itself rather than only through an aggregate.
 */
async function seedMalformed(
  db: StoreAdapter,
  column: 'tags' | 'enrich_ver' | 'meta',
): Promise<number> {
  const now = new Date().toISOString();
  const res = await db.executeRun(
    `INSERT INTO node (uid, kind, content, ${column}, t_created, t_valid)
     VALUES (?, 'episode', 'restored row', '', ?, ?)`,
    [`bad-${column}-${seq++}`, now, now],
  );
  return Number(res.lastInsertRowid);
}

let savedBackend: string | undefined;
afterEach(() => {
  if (savedBackend === undefined) delete process.env['SOX_EMBED_BACKEND'];
  else process.env['SOX_EMBED_BACKEND'] = savedBackend;
});

describe('BL-342 — malformed JSON columns are repaired, not merely tolerated', () => {
  it("BL-342: an enrich_ver = '' row is normalised to NULL on the next ordinary open", async () => {
    const { dir, cleanup } = tmpDir();
    savedBackend = process.env['SOX_EMBED_BACKEND'];
    process.env['SOX_EMBED_BACKEND'] = 'auto';
    const dbPath = path.join(dir, 't.db');
    try {
      const seedDb = await openLegacyDb(dbPath);
      let badRowid: number;
      try {
        for (let i = 0; i < 20; i++) await seedGood(seedDb, `good episode ${i}`);
        badRowid = await seedMalformed(seedDb, 'enrich_ver');

        // Pre-repair state, asserted so a passing test cannot mean "the fixture
        // never produced the shape". BL-343 keeps the tool alive; the row is
        // still there and still excluded from every JSON-dependent aggregate.
        const before = await memoryGetStats(seedDb, {}, ['memory_stats']);
        expect(before.malformed_rows.count).toBe(1);
        expect(before.malformed_rows.columns).toContain('enrich_ver');
      } finally {
        await seedDb.close();
      }

      // No repair SQL here — just the open every caller performs.
      const db = await openDb(dbPath);
      try {
        const row = await db.executeGet<{ enrich_ver: string | null }>(
          `SELECT enrich_ver FROM node WHERE rowid = ?`,
          [badRowid],
        );
        // NULL, not '{}': the schema and every reader spell "not enriched" as
        // NULL, and inventing a provenance stamp would claim a pass that never
        // ran.
        expect(row?.enrich_ver).toBeNull();

        const after = await memoryGetStats(db, {}, ['memory_stats']);
        expect(after.malformed_rows.count).toBe(0);
        expect(after.malformed_rows.columns).toEqual([]);
        expect(after.malformed_rows.sample_rowids).toEqual([]);
        // The row itself is preserved — repair normalises a column, it never
        // deletes an episode.
        expect(after.total_episodes).toBe(21);
      } finally {
        await db.close();
      }
    } finally {
      cleanup();
    }
  });

  it('BL-342: tags, meta and enrich_ver are all repaired — not just the column the live sweep named', async () => {
    const { dir, cleanup } = tmpDir();
    savedBackend = process.env['SOX_EMBED_BACKEND'];
    process.env['SOX_EMBED_BACKEND'] = 'auto';
    const dbPath = path.join(dir, 't.db');
    try {
      const seedDb = await openLegacyDb(dbPath);
      try {
        for (let i = 0; i < 20; i++) await seedGood(seedDb, `good episode ${i}`);
        await seedMalformed(seedDb, 'tags');
        await seedMalformed(seedDb, 'meta');
        await seedMalformed(seedDb, 'enrich_ver');

        const before = await memoryGetStats(seedDb, {}, ['memory_stats']);
        expect(before.malformed_rows.count).toBe(3);
        expect(before.malformed_rows.columns.sort()).toEqual(['enrich_ver', 'meta', 'tags']);
      } finally {
        await seedDb.close();
      }

      const db = await openDb(dbPath);
      try {
        const residual = await db.executeGet<{ c: number }>(
          `SELECT COUNT(*) AS c FROM node
            WHERE (tags       IS NOT NULL AND NOT json_valid(tags))
               OR (meta       IS NOT NULL AND NOT json_valid(meta))
               OR (enrich_ver IS NOT NULL AND NOT json_valid(enrich_ver))`,
        );
        expect(Number(residual?.c)).toBe(0);

        const after = await memoryGetStats(db, {}, ['memory_stats']);
        expect(after.malformed_rows.count).toBe(0);
        expect(after.total_episodes).toBe(23);
      } finally {
        await db.close();
      }
    } finally {
      cleanup();
    }
  });

  it('BL-342: a store that was never damaged is opened unchanged (the repair is not a no-op stamp)', async () => {
    const { dir, cleanup } = tmpDir();
    savedBackend = process.env['SOX_EMBED_BACKEND'];
    process.env['SOX_EMBED_BACKEND'] = 'auto';
    const dbPath = path.join(dir, 't.db');
    try {
      const seedDb = await openLegacyDb(dbPath);
      try {
        for (let i = 0; i < 20; i++) await seedGood(seedDb, `good episode ${i}`);
      } finally {
        await seedDb.close();
      }

      const db = await openDb(dbPath);
      try {
        const stats = await memoryGetStats(db, {}, ['memory_stats']);
        expect(stats.malformed_rows.count).toBe(0);
        expect(stats.total_episodes).toBe(20);
        // Every tags value still holds its array — the repair touched nothing.
        const kept = await db.executeGet<{ c: number }>(
          `SELECT COUNT(*) AS c FROM node WHERE tags = '["x"]'`,
        );
        expect(Number(kept?.c)).toBe(20);
      } finally {
        await db.close();
      }
    } finally {
      cleanup();
    }
  });
});
