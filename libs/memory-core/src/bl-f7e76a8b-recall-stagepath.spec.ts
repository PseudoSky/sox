/**
 * bl-f7e76a8b-recall-stagepath.spec.ts — regression for recall's query embed
 * being labeled stagePath 'write' instead of 'recall' (backlog f7e76a8b).
 *
 * `MEMORY_CORE_STAGES` (stages.ts) declares embed's valid stagePaths as a
 * closed union. Pre-fix it was `['write', 'heal', 'reembed']` and
 * `embedWithRecallTimeout()` in recall.ts called `embed(query)` with no
 * second argument, defaulting to 'write' — so read-path (recall) embed
 * latency was indistinguishable from write-path embed latency in telemetry,
 * and there was no 'recall' member to even pass.
 *
 * Fix: stages.ts adds 'recall' to embed's paths, and recall.ts's
 * `embedWithRecallTimeout` now calls `embed(query, 'recall')`.
 *
 * This test pins BOTH halves of the fix:
 *  1. The stage declaration accepts 'recall' as a valid embed stagePath.
 *  2. `memoryRecall`'s actual query-embed call site tags itself 'recall',
 *     not 'write' — verified by spying on `MEMORY_CORE_STAGES.withContendedStage`
 *     (the function `embed()` funnels every call through) during a real
 *     `memoryRecall()` call, so this is a genuine call-site regression
 *     detector, not just a static list check.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { memoryRecall } from './recall.js';
import { WriteQueue } from './write-queue.js';
import { _setEmbedProviderForTest } from './embed.js';
import { DeterministicTestProvider } from './embed-test-provider.js';
import { MEMORY_CORE_STAGES } from './stages.js';

// See recall-live-incident.spec.ts for why this mock exists (BL-323,
// unrelated pre-existing sqlite-vec CJS interop issue — out of scope here).
vi.mock('sqlite-vec', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, default: actual };
});

function forceSqliteAdapter(): void {
  process.env['STORE_ADAPTER'] = 'sqlite';
}

interface TestContext {
  dir: string;
  dbPath: string;
  adapter: StoreAdapter;
  cleanup: () => void;
}

async function tmpDb(prefix: string): Promise<TestContext> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, 'm.db');
  const adapter = await openDb(dbPath);
  return {
    dir,
    dbPath,
    adapter,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe('MEMORY_CORE_STAGES — embed stage declares recall as a valid path (BL f7e76a8b)', () => {
  it("'recall' is a declared stagePath for the embed stage", () => {
    // Static half of the fix: the closed union must include 'recall'
    // (pre-fix: ['write', 'heal', 'reembed'] — no 'recall' member existed).
    // `MEMORY_CORE_STAGES` has no `getStagePaths` introspection accessor —
    // the real (and only) surface is `.stages.<name>.paths`, same as
    // bl401-stage-migration.spec.ts and cluster-metrics.spec.ts use.
    const paths = MEMORY_CORE_STAGES.stages.embed.paths;
    expect(paths).toContain('recall');
  });
});

describe("memoryRecall — query embed must tag stagePath 'recall', not 'write' (BL f7e76a8b)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    forceSqliteAdapter();
    ctx = await tmpDb('recall-stagepath-');
    await WriteQueue.clearInstances();
    WriteQueue.setBypass(false);
    _setEmbedProviderForTest(new DeterministicTestProvider());
  });

  afterEach(async () => {
    await WriteQueue.clearInstances();
    await ctx.adapter.close();
    ctx.cleanup();
    _setEmbedProviderForTest(new DeterministicTestProvider());
    vi.restoreAllMocks();
  });

  it("calls embed's withContendedStage with stagePath 'recall' for the query embed", async () => {
    const spy = vi.spyOn(MEMORY_CORE_STAGES, 'withContendedStage');

    await memoryRecall(ctx.adapter, 'project', {
      query: 'stagepath regression probe',
      limit: 10,
    });

    const embedCalls = spy.mock.calls.filter((args) => args[0] === 'embed');
    expect(embedCalls.length).toBeGreaterThan(0);

    // THE regression assertion. Pre-fix, recall.ts's embedWithRecallTimeout
    // called embed(query) with no stagePath argument, defaulting to 'write'
    // — so this call site would show up tagged 'write', not 'recall'.
    const stagePaths = embedCalls.map((args) => args[1]);
    expect(stagePaths).toContain('recall');
    expect(stagePaths).not.toContain('write');
  });
});
