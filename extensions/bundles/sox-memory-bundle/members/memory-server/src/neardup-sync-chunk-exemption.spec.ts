/**
 * neardup-sync-chunk-exemption.spec.ts — 2026-09-22 re-review finding 1.
 *
 * Blind-review finding on d3d97584: the DERIVED_FROM exemption added to
 * detectNearDup (libs/memory-core/src/neardup.ts) does NOT fire on the
 * SOX_SYNC_EMBED sync-embed auto-chunk path. On that path each chunk is
 * written with `await memoryWrite(writeDb, chunkParams(chunk))` INSIDE the
 * chunk loop (index.ts, sync branch), and `linkChunksToParent` — which
 * creates the parent<->chunk DERIVED_FROM edge — runs only AFTER the loop
 * completes. `memoryWrite` with a supplied embedding runs E8 (near-dup)
 * INLINE (write.ts:475-480), so when chunk_1's detectNearDup executes the
 * DERIVED_FROM edge to its parent does not exist yet: the exemption lookup
 * in neardup.ts finds nothing, and a SAME_AS edge lands on exactly the
 * parent<->own-chunk pair the exemption exists to keep out of the
 * memory_near_duplicates review queue (measured live at cosine 0.951,
 * docs/reporting/memory/findings/2026-09-22-neardup-invalidation-fix-plan.md).
 *
 * Fix: chunkParams(chunk, parentUid) on the sync branch passes
 * derived_from_uid — write.ts's E9 DERIVED_FROM write (:448-461) runs BEFORE
 * E8 (:475) inside that SAME memoryWrite call, so the edge exists by the
 * time the chunk's own near-dup pass scores its pair against the parent.
 *
 * This suite runs under SOX_SYNC_EMBED=1 (vitest.setup.ts, suite-wide default)
 * specifically to exercise the sync branch — the async default path already
 * has separate coverage (neardup-derived-from-exemption.spec.ts, memory-core)
 * proving the exemption works when linkChunksToParent runs before Phase B.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '@adhd/sox-memory-core';
import { handleToolCall } from './index.js';

describe('sync-embed auto-chunk: parent<->own-chunk is never reported as SAME_AS (2026-09-22 re-review finding 1)', () => {
  let tmpDir: string;
  let tmpDb: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-sync-chunk-neardup-'));
    tmpDb = path.join(tmpDir, 'sync-chunk.db');
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('writes DERIVED_FROM edges and zero SAME_AS edges between parent and any of its own chunks', async () => {
    // The DeterministicTestProvider (installed suite-wide) is a bag-of-words
    // feature-hash embedder: cosine tracks shared-token overlap. Each
    // sentence below is a cyclic word-order permutation of the SAME 20-word
    // vocabulary, so every sentence's own vector points in (numerically) the
    // identical direction as the others and as their concatenation — the
    // parent-vs-each-chunk cosine computes to 1.0 (verified with a
    // standalone harness against embed-test-provider.ts's exact algorithm
    // before wiring this in), comfortably above NEARDUP_THRESHOLD (0.95) and
    // reproducing the live 0.951 parent/chunk shape this test guards against.
    const words =
      'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango'.split(
        ' ',
      );
    const cyclicSentence = (offset: number): string =>
      words.slice(offset).concat(words.slice(0, offset)).join(' ') + '.';
    const longContent = [0, 5, 10, 15].map(cyclicSentence).join(' ');

    const result = await handleToolCall('memory_write', {
      db_path: tmpDb,
      content: longContent,
      chunk_size: 20, // small chunk size to force splitting into >=2 chunks
      project_path: '/test/sync-chunk-neardup',
    }) as { isError?: boolean; content?: Array<{ type: string; text: string }> };

    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.content![0]!.text) as {
      episode_uid: string;
      chunk_uids: string[];
      chunk_count: number;
    };
    expect(parsed.chunk_count).toBeGreaterThan(1);

    const adapter = await openDb(tmpDb);
    try {
      const db = adapter.unwrap() as Database.Database;

      const parentRow = db.prepare('SELECT rowid FROM node WHERE uid = ?').get(parsed.episode_uid) as
        | { rowid: number }
        | undefined;
      expect(parentRow).toBeDefined();

      // DERIVED_FROM: one edge per chunk, parent<->chunk.
      const derivedFromCount = (
        db
          .prepare(
            `SELECT COUNT(*) as cnt FROM edge
             WHERE rel = 'DERIVED_FROM' AND t_expired IS NULL
               AND dst = ?`,
          )
          .get(parentRow!.rowid) as { cnt: number }
      ).cnt;
      expect(derivedFromCount).toBe(parsed.chunk_count);

      // SAME_AS: the exemption must have fired for EVERY chunk against the
      // parent — zero SAME_AS edges touching the parent row at all. This is
      // the assertion that was RED before the chunkParams(chunk, parentUid)
      // fix (the parent<->chunk_1 pair landed a SAME_AS edge because E9 had
      // not yet run when chunk_1's E8 pass scored it).
      const sameAsTouchingParent = (
        db
          .prepare(
            `SELECT COUNT(*) as cnt FROM edge
             WHERE rel = 'SAME_AS' AND t_expired IS NULL
               AND (src = ? OR dst = ?)`,
          )
          .get(parentRow!.rowid, parentRow!.rowid) as { cnt: number }
      ).cnt;
      expect(sameAsTouchingParent).toBe(0);
    } finally {
      (adapter.unwrap() as Database.Database).close();
    }
  }, 30_000);
});
