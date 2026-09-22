/**
 * neardup-async-chunk-exemption.spec.ts — 2026-09-22 second re-review,
 * finding C.
 *
 * aaf7442e fixed the SYNC-embed auto-chunk path's DERIVED_FROM exemption gap
 * (chunkParams(chunk, parentUid) — E9's edge write races E8's near-dup pass
 * within a single memoryWrite call). It added NO coverage of the DEFAULT
 * async path's version of the same invariant. Async safety rests entirely on
 * `linkChunksToParent` (index.ts) running INSIDE the queue task BEFORE
 * `schedulePhaseBAndWake` fires — Phase B (which runs E8) is deliberately
 * deferred until AFTER the queue slot returns, so by construction the
 * DERIVED_FROM edge already exists by the time any chunk's near-dup pass
 * runs. That ordering is TRUE TODAY but was pinned by NOTHING: the blind
 * reviewer gave a concrete mutation — delete the `await linkChunksToParent`
 * call from the ASYNC branch only — and confirmed every existing test stays
 * green (the sync spec pins SOX_SYNC_EMBED=1; the derived-from exemption
 * spec seeds the edge with raw SQL directly, never exercising the write
 * path's own ordering; async-embed.spec.ts's chunk test only asserts
 * `chunk_count > 0`). The default path could regress silently.
 *
 * This suite deletes SOX_SYNC_EMBED (mirrors async-embed.spec.ts) to
 * exercise the ASYNC DEFAULT specifically, writes chunked content
 * engineered so DeterministicTestProvider's bag-of-words cosine between
 * parent and every chunk is exactly 1.0 (same cyclic-permutation construction
 * as neardup-sync-chunk-exemption.spec.ts), drains Phase B with
 * `flushPendingEmbeds()`, and asserts zero SAME_AS edges touch the parent.
 *
 * RED (linkChunksToParent call temporarily removed from the async branch,
 * index.ts ~line 1776): FAILS — SAME_AS edges land on the parent, because
 * E8 (in Phase B) no longer finds a DERIVED_FROM edge to exempt against.
 * GREEN (as shipped): 0 SAME_AS edges touch the parent.
 *
 * Gate: npx nx test memory-server --skip-nx-cache -- neardup-async-chunk-exemption
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getDb, _setEmbedProviderForTest, DeterministicTestProvider, flushPendingEmbeds, WriteQueue } from '@adhd/sox-memory-core';
import { handleToolCall } from './index.js';

function tmpStorePath(): { dbPath: string; cleanup: () => void } {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-async-chunk-neardup-'));
  return { dbPath: path.join(d, 'store.db'), cleanup: () => fs.rmSync(d, { recursive: true, force: true }) };
}

const cleanups: Array<() => void> = [];

beforeAll(() => {
  // This file tests the ASYNC DEFAULT — undo the suite-wide SOX_SYNC_EMBED=1
  // kill-switch pin (vitest.setup.ts), same as async-embed.spec.ts.
  delete process.env['SOX_SYNC_EMBED'];
  _setEmbedProviderForTest(new DeterministicTestProvider());
});

afterAll(async () => {
  await flushPendingEmbeds();
  WriteQueue.clearInstances();
  process.env['SOX_SYNC_EMBED'] = '1'; // restore the suite-wide pin
});

afterEach(async () => {
  await flushPendingEmbeds();
  _setEmbedProviderForTest(new DeterministicTestProvider());
  for (const c of cleanups.splice(0)) c();
});

describe('async-default auto-chunk: parent<->own-chunk is never reported as SAME_AS (2026-09-22 second re-review finding C)', () => {
  it('writes DERIVED_FROM edges and zero SAME_AS edges between parent and any of its own chunks, after Phase B drains', async () => {
    // Env precondition — this test is worthless if it silently ran under the
    // sync kill-switch instead of the async default it claims to cover.
    expect(process.env['SOX_SYNC_EMBED']).toBeUndefined();

    const { dbPath, cleanup } = tmpStorePath();
    cleanups.push(cleanup);

    // Same construction as neardup-sync-chunk-exemption.spec.ts: 4 cyclic
    // word-order permutations of one 20-word vocabulary — every sentence's
    // own bag-of-words vector points in the identical direction as the
    // others and as their concatenation, so parent-vs-each-chunk cosine
    // computes to 1.0 under DeterministicTestProvider, comfortably above
    // NEARDUP_THRESHOLD (0.95).
    const words =
      'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango'.split(
        ' ',
      );
    const cyclicSentence = (offset: number): string =>
      words.slice(offset).concat(words.slice(0, offset)).join(' ') + '.';
    const longContent = [0, 5, 10, 15].map(cyclicSentence).join(' ');

    const result = await handleToolCall('memory_write', {
      db_path: dbPath,
      content: longContent,
      chunk_size: 20, // small chunk size to force splitting into >=2 chunks
      project_path: '/test/async-chunk-neardup',
    }) as { isError?: boolean; content?: Array<{ type: string; text: string }> };

    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.content![0]!.text) as {
      episode_uid: string;
      chunk_uids: string[];
      chunk_count: number;
    };
    expect(parsed.chunk_count).toBeGreaterThan(1);

    // near_dup detection for the async path is deferred to Phase B — drain
    // it before inspecting SAME_AS edges.
    await flushPendingEmbeds();

    const db = (await getDb(dbPath)).unwrap() as Database.Database;

    const parentRow = db
      .prepare<[string], { rowid: number }>('SELECT rowid FROM node WHERE uid = ?')
      .get(parsed.episode_uid);
    expect(parentRow).toBeDefined();

    const derivedFromCount = db
      .prepare<[number], { cnt: number }>(
        `SELECT COUNT(*) as cnt FROM edge WHERE rel = 'DERIVED_FROM' AND t_expired IS NULL AND dst = ?`,
      )
      .get(parentRow!.rowid)!.cnt;
    expect(derivedFromCount).toBe(parsed.chunk_count);

    // THE assertion: the exemption must have fired for EVERY chunk against
    // the parent on the ASYNC path too — zero SAME_AS edges touching the
    // parent row at all.
    const sameAsTouchingParent = db
      .prepare<[number, number], { cnt: number }>(
        `SELECT COUNT(*) as cnt FROM edge WHERE rel = 'SAME_AS' AND t_expired IS NULL AND (src = ? OR dst = ?)`,
      )
      .get(parentRow!.rowid, parentRow!.rowid)!.cnt;
    expect(sameAsTouchingParent).toBe(0);
  }, 30_000);
});
