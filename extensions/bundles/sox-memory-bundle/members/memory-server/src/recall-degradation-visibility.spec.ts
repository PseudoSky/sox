/**
 * recall-degradation-visibility.spec.ts — the `memory_recall` MCP handler
 * dropped `RecallResponse.degradations` on the floor.
 *
 * recall.ts has, since BL-391, done two of the three things an operator
 * needs when a retrieval channel dies non-fatally:
 *   1. logged it  — `tlog.warn('recall.embed_failed', …)` (recall.ts:524);
 *   2. returned it — `degradations: string[]` on RecallResponse
 *                    (recall.ts:232 / :526 / :1143, federated :1433/:1511).
 *
 * The third was missing: index.ts's `memory_recall` case serialized exactly
 * `{ results, provider_call_count }`, so the field never crossed the MCP
 * boundary. An agent calling `memory_recall` received a normal-looking result
 * set with no way to distinguish "the vec channel found nothing" from "the
 * vec channel never ran because the query embed timed out". There was also no
 * counter anywhere, so the RATE was invisible without grepping the jsonl logs.
 *
 * This is not hypothetical. The read-path guard fires in production:
 *   $ rg -o '"error":"[^"]*"' ~/.adhd/sox-ecosystem/memory/logs/memory-core-2026-09-22.jsonl \
 *       | rg -i embed | sort | uniq -c | sort -rn
 *     31 "error":"embed() timed out after 3000ms (recall read-path guard)"
 *      4 "error":"shared fastembed process terminated"
 *
 * THIS FILE PROVES (all ACTUALLY RUN, no simulation):
 *   BL-391 AC-1: a `memory_recall` whose query-embed never settles returns a
 *         `degradations` array over the MCP boundary naming the vec channel
 *         and the timeout — asserted on the PARSED MCP RESPONSE TEXT, not on
 *         memoryRecall()'s in-process return value (which already carried the
 *         field before this change and would prove nothing). Pinned to the
 *         empty-corpus branch (recall.ts ~:694): `results` is asserted `[]`
 *         explicitly, not merely `toBeDefined()`, so a later fixture change
 *         cannot silently move the assertion onto a different code path.
 *   BL-391 AC-2: `memory_ping.recall_degradations` reports cumulative counters —
 *         `recalls_total`, `recalls_degraded`, `by_channel.vec`,
 *         `last_degraded_at` — so the rate is readable without the logs.
 *         Asserted to EXACT values (`toBe`, not `toBeGreaterThanOrEqual`):
 *         the counters reset in `beforeEach`, so with exactly 2 degraded
 *         calls the true values are knowable, and only an exact assertion
 *         can catch a double-increment or an off-by-one.
 *   BL-391 AC-3: a CLEAN recall omits `degradations` ENTIRELY (shape byte-identical
 *         to the pre-change response) and still increments `recalls_total`
 *         only — pinning the additive/non-breaking contract documented in
 *         CLAUDE.md and the denominator that makes the counter a rate.
 *   BL-391 AC-4: a recall against a POPULATED store still returns non-empty
 *         `results` alongside `degradations` when the vec channel alone
 *         degrades (BM25/temporal still answer) — the non-empty return path
 *         at recall.ts (the `if (degradations.length > 0) response.degradations
 *         = degradations;` line just above the function's final `return
 *         response;`, sibling to the empty-corpus branch AC-1 pins) had no
 *         coverage before this file; AC-1 alone cannot exercise it because a
 *         fresh `mkdtempSync` store is always empty-corpus.
 *
 * The 3000ms production default is NOT changed by this file or this fix. The
 * suite pins the guard to 150ms via `SOX_RECALL_EMBED_TIMEOUT_MS` — the
 * production-supported env override (recall.ts:82) — purely so the test does
 * not sleep 3s. The assertion is on the DEGRADATION being visible, not on the
 * number, so the shortened budget cannot weaken it.
 *
 * RED→GREEN PROCEDURE ACTUALLY PERFORMED (BL-225 — not "would fail"):
 *   Arm 1 (index.ts): with index.ts's `memory_recall` return reverted to the
 *   pre-fix `JSON.stringify({ results: filteredResults, provider_call_count })`
 *   and the `recordRecallDegradations(...)`/`recall_degradations` lines
 *   removed, AC-1 failed on `expect(parsed.degradations).toBeDefined()`
 *   (received `undefined`) and AC-2 failed on `expect(ping.recall_degradations)`
 *   (received `undefined`). Restoring both made all three pass.
 *
 *   Arm 2 (recall.ts propagation line, recall.ts's empty-corpus branch,
 *   `if (degradations.length > 0) response.degradations = degradations;`):
 *   NOT provable from this file. `memory-server`'s vitest.config.ts aliases
 *   `@adhd/sox-memory-core` to its BUILT ARTIFACT
 *   (`libs/memory-core/dist/index.js`), so editing `libs/memory-core/src/
 *   recall.ts` and re-running this spec would silently keep loading the old
 *   dist and prove nothing — reverting it here would be a false RED/GREEN.
 *   The load-bearing proof for that line lives instead in memory-core's OWN
 *   suite, which imports `recall.ts` as SOURCE (no dist alias for its own
 *   package): see `libs/memory-core/src/recall-degradation-empty-corpus-
 *   propagation.spec.ts`, whose header documents that RED/GREEN cycle
 *   verbatim.
 *
 * Gate: npx nx test memory-server -- --run recall-degradation-visibility.spec
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getDb,
  _setEmbedProviderForTest,
  DeterministicTestProvider,
  flushPendingEmbeds,
  WriteQueue,
} from '@adhd/sox-memory-core';
import { handleToolCall, _resetRecallDegradationCountersForTest } from './index.js';

/**
 * Locally-declared structural type, not imported from `@adhd/sox-embedding-provider` —
 * memory-server does not declare that package as a dependency (only
 * `@adhd/sox-memory-core` does, which re-exports `DeterministicTestProvider`
 * but not the `EmbedRole` type itself). This is used exactly once, to type
 * HangingProvider's `embedSingle` override parameter; it only needs to be
 * structurally identical to the real `EmbedRole = 'document' | 'query'`
 * (libs/data/embed/embedding-provider/src/index.ts:10) for the override to
 * type-check, which a literal union trivially is. Adding a real workspace
 * dependency for a single type-only, two-value union would be disproportionate
 * blast radius (new package.json edge + pnpm relock) for what a local alias
 * solves exactly.
 */
type EmbedRole = 'document' | 'query';

/**
 * Provider whose embedSingle NEVER settles — the live-incident failure mode
 * (a query-embed joining the tail of a saturated fastembed IPC queue). A
 * REJECTING provider would exercise the older BL-273 path; only a promise
 * that never settles exercises the wall-clock race this degradation comes
 * from. Same shape as memory-core's recall-live-incident.spec.ts
 * HangingProvider, duplicated per this suite's one-file-per-defect convention.
 */
class HangingProvider extends DeterministicTestProvider {
  override async embedSingle(_text: string, _role?: EmbedRole): Promise<Float32Array> {
    return new Promise<Float32Array>(() => {
      /* never settles, and never rejects — deliberately */
    });
  }
}

const cleanups: Array<() => void> = [];

function tmpStorePath(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-recall-degrade-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, 'store.db');
}

/** Parse the single text block an MCP tool result carries. */
function parseToolResult(res: { content: Array<{ type: string; text: string }> }): Record<string, unknown> {
  const block = res.content[0];
  if (!block) throw new Error('tool result carried no content block');
  return JSON.parse(block.text) as Record<string, unknown>;
}

let priorTimeout: string | undefined;

beforeEach(() => {
  priorTimeout = process.env['SOX_RECALL_EMBED_TIMEOUT_MS'];
  // Production-supported override (recall.ts:82). Keeps the suite fast; the
  // 3000ms production default is untouched by this fix.
  process.env['SOX_RECALL_EMBED_TIMEOUT_MS'] = '150';
  _resetRecallDegradationCountersForTest();
  _setEmbedProviderForTest(new DeterministicTestProvider());
});

afterEach(async () => {
  if (priorTimeout === undefined) delete process.env['SOX_RECALL_EMBED_TIMEOUT_MS'];
  else process.env['SOX_RECALL_EMBED_TIMEOUT_MS'] = priorTimeout;
  await flushPendingEmbeds();
  WriteQueue.clearInstances();
  _setEmbedProviderForTest(new DeterministicTestProvider());
  _resetRecallDegradationCountersForTest();
  for (const c of cleanups.splice(0)) c();
});

describe('memory_recall surfaces a degraded vec channel across the MCP boundary', () => {
  it('BL-391 AC-1: returns `degradations` naming the vec channel when the query embed never settles (empty-corpus branch)', async () => {
    const dbPath = tmpStorePath();
    await getDb(dbPath);
    await WriteQueue.forPath(dbPath);

    _setEmbedProviderForTest(new HangingProvider());

    const res = await handleToolCall('memory_recall', {
      db_path: dbPath,
      query: 'anything at all — the vec channel cannot answer this',
    });
    const parsed = parseToolResult(res as { content: Array<{ type: string; text: string }> });

    // THE CORE CLAIM: the field crosses the MCP boundary. Pre-fix this is
    // `undefined` — the handler serialized only results + provider_call_count.
    expect(parsed['degradations']).toBeDefined();
    const degradations = parsed['degradations'] as string[];
    expect(Array.isArray(degradations)).toBe(true);
    expect(degradations.length).toBeGreaterThanOrEqual(1);

    // It must name the channel and the reason — a bare "something failed"
    // string would leave the caller exactly as blind as before.
    const vec = degradations.find((d) => d.startsWith('vec:'));
    expect(vec).toBeDefined();
    expect(vec).toMatch(/timed out/i);

    // The recall still SUCCEEDED — a degradation is a partial result, never
    // an error. Callers that ignore the new field keep working unchanged.
    expect(res).not.toHaveProperty('isError', true);
    // Pin the branch explicitly: this store is a fresh mkdtempSync — nothing
    // was ever written to it — so this MUST be the empty-corpus branch
    // (recall.ts ~:694), and `results` MUST be `[]`, not merely present.
    // `toBeDefined()` alone would also pass on a populated result set, which
    // would let this test silently migrate off the branch it names if a
    // future edit seeded the fixture — see AC-4 for the populated-store arm.
    expect(parsed['results']).toEqual([]);
  });

  it('BL-391 AC-2: memory_ping reports cumulative recall-degradation counters', async () => {
    const dbPath = tmpStorePath();
    await getDb(dbPath);
    await WriteQueue.forPath(dbPath);

    _setEmbedProviderForTest(new HangingProvider());
    await handleToolCall('memory_recall', { db_path: dbPath, query: 'first degraded recall' });
    await handleToolCall('memory_recall', { db_path: dbPath, query: 'second degraded recall' });

    const ping = parseToolResult(
      (await handleToolCall('memory_ping', { db_path: dbPath })) as {
        content: Array<{ type: string; text: string }>;
      },
    );

    // THE CORE CLAIM: an operator can read the rate off ping alone.
    expect(ping['recall_degradations']).toBeDefined();
    const counters = ping['recall_degradations'] as {
      recalls_total: number;
      recalls_degraded: number;
      by_channel: Record<string, number>;
      last_degraded_at: string | null;
      last_degradations: string[];
    };

    // Exact values, not `toBeGreaterThanOrEqual` — counters reset in
    // `beforeEach` and exactly 2 calls happened above, so the true values are
    // knowable. A `>=` assertion here cannot catch a double-increment (e.g.
    // `recordRecallDegradations` firing twice per call) or the counter
    // silently absorbing a later test's calls; only an exact match can.
    expect(counters.recalls_total).toBe(2);
    expect(counters.recalls_degraded).toBe(2);
    // Channel attribution, not just a bare incident count. Exact: each of the
    // 2 calls above produces exactly one `vec:`-prefixed degradation string
    // (confirmed by reading recall.ts's embed-guard degradation push site —
    // one push per timed-out embed call, not per retry), so by_channel.vec
    // tracks 1:1 with recalls_degraded here. See the by_channel JSDoc in
    // index.ts for why that 1:1 is NOT a general guarantee — by_channel counts
    // degradation STRINGS, not calls, and a single call CAN carry more than
    // one string.
    expect(counters.by_channel['vec']).toBe(2);
    expect(counters.last_degraded_at).not.toBeNull();
    expect(counters.last_degradations.some((d) => d.startsWith('vec:'))).toBe(true);
  });

  it('BL-391 AC-3: a clean recall omits `degradations` entirely but still counts toward the denominator', async () => {
    const dbPath = tmpStorePath();
    await getDb(dbPath);
    await WriteQueue.forPath(dbPath);

    // Healthy provider — every channel runs.
    _setEmbedProviderForTest(new DeterministicTestProvider());

    const res = await handleToolCall('memory_recall', {
      db_path: dbPath,
      query: 'a query the healthy provider can embed',
    });
    const parsed = parseToolResult(res as { content: Array<{ type: string; text: string }> });

    // Non-breaking contract: the key is ABSENT, not present-and-empty, so a
    // clean response is byte-identical to the pre-change shape.
    expect('degradations' in parsed).toBe(false);
    expect(parsed['results']).toBeDefined();
    expect(parsed['provider_call_count']).toBeDefined();

    const ping = parseToolResult(
      (await handleToolCall('memory_ping', { db_path: dbPath })) as {
        content: Array<{ type: string; text: string }>;
      },
    );
    const counters = ping['recall_degradations'] as {
      recalls_total: number;
      recalls_degraded: number;
    };
    // The denominator moves even on a clean call — that is what makes the
    // counter a RATE rather than a bare incident tally. Exact (`toBe`, not
    // `toBeGreaterThanOrEqual`): exactly 1 call happened above and counters
    // reset in `beforeEach`, so the true value is knowable.
    expect(counters.recalls_total).toBe(1);
    expect(counters.recalls_degraded).toBe(0);
  });

  it('BL-391 AC-4: a populated store still returns non-empty `results` alongside `degradations` when only the vec channel degrades', async () => {
    const dbPath = tmpStorePath();
    await getDb(dbPath);
    await WriteQueue.forPath(dbPath);

    // Write with the HEALTHY provider first (vec + BM25 + temporal all index
    // normally), then flush the async embed so the document's vector is
    // durably committed before we ever switch providers.
    _setEmbedProviderForTest(new DeterministicTestProvider());
    const writeRes = parseToolResult(
      (await handleToolCall('memory_write', {
        db_path: dbPath,
        content:
          'BL-391 AC-4 fixture: the quarterly payments roadmap lists Q3 launch milestones.',
        project_path: '/test/project',
      })) as { content: Array<{ type: string; text: string }> },
    );
    expect(typeof writeRes['episode_uid']).toBe('string');
    await flushPendingEmbeds();

    // NOW degrade the vec channel for the READ. The write's document vector
    // already exists in the store; what fails is the QUERY-side embed that
    // memory_recall itself issues (recall.ts's `embedWithRecallTimeout` call
    // — the same call AC-1 exercises). BM25/temporal can still match this
    // query against the written content by shared keywords, so the recall
    // should succeed non-empty even though the vec channel never answers.
    _setEmbedProviderForTest(new HangingProvider());

    const res = await handleToolCall('memory_recall', {
      db_path: dbPath,
      query: 'quarterly payments roadmap Q3 launch milestones',
    });
    const parsed = parseToolResult(res as { content: Array<{ type: string; text: string }> });

    // THE CORE CLAIM this AC exists to cover: the non-empty return path
    // (recall.ts's final `if (degradations.length > 0) response.degradations
    // = degradations;`, sibling to the empty-corpus branch AC-1 pins) also
    // propagates `degradations` — AC-1 alone cannot prove this, since a fresh
    // `mkdtempSync` store is always empty-corpus.
    expect(parsed['degradations']).toBeDefined();
    const degradations = parsed['degradations'] as string[];
    expect(degradations.some((d) => d.startsWith('vec:'))).toBe(true);

    // And `results` is genuinely non-empty — not merely `toBeDefined()`,
    // which an empty array would also satisfy and would silently degrade
    // this into a duplicate of AC-1.
    const results = parsed['results'] as unknown[];
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(1);

    expect(res).not.toHaveProperty('isError', true);
  });
});
