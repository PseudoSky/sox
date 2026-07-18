/**
 * memory-recall-listing.spec.ts — regression coverage for BL-240 and BL-241.
 *
 * `memory_recall`'s no-query (importance-ranked listing) branch in index.ts
 * accepted two top-level params into its schema and silently ignored both:
 *
 *   BL-240 `as_of`         — hardcoded `n.t_invalid IS NULL` (today's live state
 *                            only). The query path (recall.ts) instead swaps in a
 *                            bi-temporal validity window:
 *                              (t_valid IS NULL OR t_valid <= as_of)
 *                              AND (t_invalid IS NULL OR t_invalid > as_of)
 *                            "List my memories as of last week" silently
 *                            returned today's state.
 *
 *   BL-241 `token_budget`  — a plain SQL `LIMIT` by row count. The query path
 *                            (recall.ts:602-619) instead trims by cumulative
 *                            estimated tokens (1 token ≈ 4 chars).
 *
 * Both are fixed to mirror the query path's semantics on the listing branch.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WriteQueue } from '@adhd/sox-memory-core';
import { handleToolCall } from './index.js';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-memory-recall-listing-'));
const DB_PATH = path.join(TEST_DIR, 'test.db');

function parseResult(resp: { content: Array<{ text?: string }> }): Record<string, unknown> {
  return JSON.parse(resp.content[0]?.text ?? '{}') as Record<string, unknown>;
}

afterAll(() => {
  WriteQueue.clearInstances();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── BL-240: as_of on the no-query listing branch ─────────────────────────────

describe('memory_recall (no query) — as_of (BL-240)', () => {
  let uid: string;
  let invalidatedAtIso: string;
  let beforeInvalidationIso: string;

  beforeAll(async () => {
    const w = parseResult(
      await handleToolCall('memory_write', {
        db_path: DB_PATH,
        content: 'BL-240 regression fixture: an episode that will be invalidated.',
        importance: 9,
        project_path: '/test/project',
      }),
    );
    uid = w['episode_uid'] as string;
    expect(uid).toBeTruthy();

    // A moment strictly AFTER the episode's own t_valid/t_created (the write just
    // completed) but strictly BEFORE the invalidation transition below — as_of
    // this instant must still see the episode as live (bi-temporal window).
    // The transition is deliberately a few seconds in the FUTURE relative to
    // "now": memory_invalidate stores whatever t_transition it is given as a
    // plain column value, so a future-dated transition is a safe, deterministic
    // way to guarantee `beforeInvalidationIso < invalidatedAtIso` without a race
    // against wall-clock time elapsing between these two lines and the assertions.
    beforeInvalidationIso = new Date().toISOString();
    invalidatedAtIso = new Date(Date.now() + 5_000).toISOString();

    const inv = parseResult(
      await handleToolCall('memory_invalidate', {
        db_path: DB_PATH,
        claim_uid: uid,
        reason: 'BL-240 regression fixture: superseded.',
        t_transition: invalidatedAtIso,
      }),
    );
    expect(inv['ok']).toBe(true);
  });

  it('omitting as_of reflects TODAY\'s state — the invalidated episode is absent', async () => {
    const out = parseResult(
      await handleToolCall('memory_recall', { db_path: DB_PATH, limit: 50 }),
    );
    const results = out['results'] as Array<{ uid: string }>;
    expect(results.some((r) => r.uid === uid)).toBe(false);
  });

  it('as_of a moment BEFORE invalidation still surfaces the episode (bi-temporal window)', async () => {
    const out = parseResult(
      await handleToolCall('memory_recall', {
        db_path: DB_PATH,
        limit: 50,
        as_of: beforeInvalidationIso,
      }),
    );
    const results = out['results'] as Array<{ uid: string }>;
    // Pre-fix: as_of was silently ignored, so this would ALSO return today's
    // state (episode absent) — indistinguishable from the omitted-as_of case.
    expect(results.some((r) => r.uid === uid)).toBe(true);
  });

  it('as_of a moment AFTER invalidation does NOT surface the episode', async () => {
    const afterIso = new Date(Date.parse(invalidatedAtIso) + 60_000).toISOString();
    const out = parseResult(
      await handleToolCall('memory_recall', {
        db_path: DB_PATH,
        limit: 50,
        as_of: afterIso,
      }),
    );
    const results = out['results'] as Array<{ uid: string }>;
    expect(results.some((r) => r.uid === uid)).toBe(false);
  });
});

// ── BL-241: token_budget on the no-query listing branch ──────────────────────

describe('memory_recall (no query) — token_budget (BL-241)', () => {
  const uids: string[] = [];

  beforeAll(async () => {
    // Three episodes, descending importance (deterministic ORDER BY), ~10 tokens
    // of content each (40 chars / 4). summary: '' suppresses the E10 extractive
    // fallback so the per-row token estimate is driven by `content` alone.
    for (const [content, importance] of [
      ['A'.repeat(40), 10],
      ['B'.repeat(40), 9],
      ['C'.repeat(40), 8],
    ] as const) {
      const w = parseResult(
        await handleToolCall('memory_write', {
          db_path: DB_PATH,
          content,
          summary: '',
          importance,
          project_path: '/test/project',
        }),
      );
      const u = w['episode_uid'] as string;
      expect(u).toBeTruthy();
      uids.push(u);
    }
  });

  it('a small token_budget truncates the listing by CUMULATIVE tokens, not row count', async () => {
    // Each row ~10 tokens. Budget 15 admits row 1 (cum=10<=15) but not row 2
    // (cum 10+10=20>15) — pre-fix this was a no-op and `limit` alone (50) would
    // have returned all three rows regardless of token_budget.
    const out = parseResult(
      await handleToolCall('memory_recall', {
        db_path: DB_PATH,
        limit: 50,
        token_budget: 15,
      }),
    );
    const results = out['results'] as Array<{ uid: string }>;
    const returnedUids = results.map((r) => r.uid).filter((u) => uids.includes(u));
    expect(returnedUids).toEqual([uids[0]]);
  });

  it('always includes at least one row even if it alone exceeds the budget', async () => {
    const out = parseResult(
      await handleToolCall('memory_recall', {
        db_path: DB_PATH,
        limit: 50,
        token_budget: 1,
      }),
    );
    const results = out['results'] as Array<{ uid: string }>;
    const returnedUids = results.map((r) => r.uid).filter((u) => uids.includes(u));
    expect(returnedUids).toEqual([uids[0]]);
  });

  it('a generous token_budget returns all rows (bounded only by limit, as before)', async () => {
    const out = parseResult(
      await handleToolCall('memory_recall', {
        db_path: DB_PATH,
        limit: 50,
        token_budget: 10_000,
      }),
    );
    const results = out['results'] as Array<{ uid: string }>;
    const returnedUids = results.map((r) => r.uid).filter((u) => uids.includes(u));
    expect(returnedUids).toEqual(uids);
  });
});
