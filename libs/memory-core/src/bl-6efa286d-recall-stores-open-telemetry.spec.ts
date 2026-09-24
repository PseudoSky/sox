/**
 * bl-6efa286d — memoryRecall() (the non-federated recall path) never emitted
 * a 'recall.stores_open' telemetry event; only federatedRecall() did (see
 * recall.ts ~1703). Fixed in 3016c3d6: memoryRecall now emits the same
 * event/shape immediately after 'recall.start', so a consumer keyed on
 * 'recall.stores_open' sees it on every recall, not only federated ones.
 *
 * This spec spies on the module's `log` (aliased `tlog` in recall.ts) and
 * asserts the event fires, in order, with the documented shape
 * ({ elapsed_ms, opened: 1, total: 1 }), on a real memoryRecall() call
 * against a real sqlite-backed store.
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
import { log } from './telemetry.js';

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

describe('bl-6efa286d — memoryRecall emits recall.stores_open on the non-federated path', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    forceSqliteAdapter();
    ctx = await tmpDb('recall-stores-open-');
    await WriteQueue.clearInstances();
    WriteQueue.setBypass(false);
    _setEmbedProviderForTest(new DeterministicTestProvider());
  });

  afterEach(async () => {
    await WriteQueue.clearInstances();
    await ctx.adapter.close();
    ctx.cleanup();
    vi.restoreAllMocks();
  });

  it('logs recall.stores_open with { opened: 1, total: 1 } right after recall.start', async () => {
    const infoSpy = vi.spyOn(log, 'info');

    await memoryRecall(ctx.adapter, 'project', { query: 'stores open telemetry', limit: 10 });

    const eventNames = infoSpy.mock.calls.map((c) => c[0]);
    const startIdx = eventNames.indexOf('recall.start');
    const storesOpenIdx = eventNames.indexOf('recall.stores_open');
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(storesOpenIdx).toBeGreaterThan(startIdx);

    const storesOpenCall = infoSpy.mock.calls[storesOpenIdx] as [string, Record<string, unknown>];
    expect(storesOpenCall[1]['opened']).toBe(1);
    expect(storesOpenCall[1]['total']).toBe(1);
    expect(typeof storesOpenCall[1]['elapsed_ms']).toBe('number');
  });
});
