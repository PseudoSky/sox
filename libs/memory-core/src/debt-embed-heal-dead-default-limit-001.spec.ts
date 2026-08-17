/**
 * debt-embed-heal-dead-default-limit-001.spec.ts — DEBT-EMBED-HEAL-DEAD-DEFAULT-LIMIT-001
 *
 * Regression coverage for making `limit` a REQUIRED field on both
 * `healMissingVectors` and `healStaleVectors`, rather than an optional field
 * that silently fell back to an unreachable `?? 500` default.
 *
 * Two arms, per BL-225 (a status marker records a verified outcome):
 *
 *   1. TYPE-LEVEL (checked by `npx nx typecheck-tests memory-core`, which
 *      typechecks *.spec.ts — plain `npx nx typecheck memory-core` excludes
 *      spec files and would NOT catch this): calling either function without
 *      `opts.limit` must fail to compile. Before the fix, `opts?: { limit?:
 *      number }` made this call legal — the omission silently exercised the
 *      dead `?? 500` branch. The `_typeOnlyRequiredLimitAssertion` function
 *      below is never invoked (wrapped in `it.skip` so it type-checks without
 *      running); its only job is to make the `@ts-expect-error` comments
 *      meaningful — if `limit` ever regresses to optional, tsc reports
 *      "Unused '@ts-expect-error' directive" and typecheck-tests fails.
 *
 *   2. RUNTIME: an explicit `limit` smaller than the row count is honored
 *      exactly — proving the value passed in is what governs the pass, not
 *      some other fallback. (embed-provenance.spec.ts already covers this
 *      shape for healStaleVectors at "is bounded by opts.limit"; this file's
 *      runtime arm adds the missing healMissingVectors case with a limit
 *      value picked specifically to differ from the removed dead default of
 *      500, so a regression to `?? 500` would show up as `scanned: 500`
 *      wrapping a too-small fixture, not as a silent pass.)
 *
 * Gate: npx nx typecheck-tests memory-core && npx nx test memory-core --skip-nx-cache
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { healMissingVectors, healStaleVectors, flushPendingEmbeds, _resetEmbedPipelineMetricsForTest } from './embed-pipeline.js';
import { WriteQueue } from './write-queue.js';
import { _setEmbedProviderForTest } from './embed.js';
import { DeterministicTestProvider } from './embed-test-provider.js';

// ── 1. Type-level: `limit` is required, not optional ──────────────────────────

/**
 * Never called at runtime (see `it.skip` below) — exists purely so tsc has
 * something to check. If `limit` regresses to optional, these two
 * `@ts-expect-error` directives become unused and tsc fails with TS2578.
 */
function _typeOnlyRequiredLimitAssertion(adapter: StoreAdapter, wq: WriteQueue): void {
  // @ts-expect-error DEBT-EMBED-HEAL-DEAD-DEFAULT-LIMIT-001: opts (and opts.limit) must be required — omitting it must not compile.
  void healMissingVectors(adapter, wq);
  // @ts-expect-error DEBT-EMBED-HEAL-DEAD-DEFAULT-LIMIT-001: opts (and opts.limit) must be required — omitting it must not compile.
  void healStaleVectors(adapter, wq);
  // @ts-expect-error DEBT-EMBED-HEAL-DEAD-DEFAULT-LIMIT-001: opts.limit specifically must be required, not just opts.
  void healMissingVectors(adapter, wq, {});
  // @ts-expect-error DEBT-EMBED-HEAL-DEAD-DEFAULT-LIMIT-001: opts.limit specifically must be required, not just opts.
  void healStaleVectors(adapter, wq, {});
}

describe('DEBT-EMBED-HEAL-DEAD-DEFAULT-LIMIT-001 — limit is a required parameter', () => {
  it.skip('type-only: omitting opts.limit must not compile (see _typeOnlyRequiredLimitAssertion above)', () => {
    // Never executed. The function reference below only exists so the
    // declaration above is not itself flagged as an unused local by
    // noUnusedLocals — the actual assertion is the @ts-expect-error pair.
    void _typeOnlyRequiredLimitAssertion;
  });
});

// ── 2. Runtime: the passed-in limit is exactly what governs the pass ──────────

interface TestContext {
  dir: string;
  dbPath: string;
  adapter: StoreAdapter;
  cleanup: () => void;
}

async function tmpDb(): Promise<TestContext> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-embed-heal-limit-'));
  const dbPath = path.join(dir, 'm.db');
  const adapter = await openDb(dbPath);
  return {
    dir,
    dbPath,
    adapter,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function insertOrphanEpisode(adapter: StoreAdapter, content: string): Promise<void> {
  await adapter.executeRun(
    `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid)
     VALUES (?, 'episode', ?, ?, datetime('now'), datetime('now'))`,
    [`orphan-${Math.random().toString(36).slice(2)}`, content, `hash-${Math.random()}`],
  );
}

let ctx: TestContext;

function forceSqliteAdapter(): void {
  process.env.STORE_ADAPTER = 'sqlite';
}

beforeEach(async () => {
  forceSqliteAdapter();
  ctx = await tmpDb();
  await WriteQueue.clearInstances();
  WriteQueue.setBypass(false);
  _resetEmbedPipelineMetricsForTest();
  _setEmbedProviderForTest(new DeterministicTestProvider());
});

afterEach(async () => {
  await flushPendingEmbeds();
  await WriteQueue.clearInstances();
  _resetEmbedPipelineMetricsForTest();
  ctx.cleanup();
  _setEmbedProviderForTest(new DeterministicTestProvider());
});

describe('DEBT-EMBED-HEAL-DEAD-DEFAULT-LIMIT-001 — the caller-supplied limit governs the pass, not a hidden default', () => {
  it('healMissingVectors: with 7 orphans and an explicit limit of 3, exactly 3 are scanned (never a removed-default 500 or the full 7)', async () => {
    for (let i = 0; i < 7; i++) {
      await insertOrphanEpisode(ctx.adapter, `heal limit regression orphan ${i}`);
    }
    const wq = await WriteQueue.forPath(ctx.dbPath);
    const heal = await healMissingVectors(ctx.adapter, wq, { limit: 3 });
    expect(heal.scanned).toBe(3);
    expect(heal.healed).toBe(3);

    const remaining = await ctx.adapter.executeGet<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM node n
       WHERE n.kind = 'episode' AND n.t_invalid IS NULL
         AND NOT EXISTS (SELECT 1 FROM vec_node v WHERE v.node_id = n.rowid)`,
    );
    expect(remaining?.cnt).toBe(4); // the other 4 orphans are untouched, awaiting the next pass
  });
});
