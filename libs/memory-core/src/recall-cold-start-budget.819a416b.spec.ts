/**
 * 819a416b — the recall embed budget must be cold-start aware.
 *
 * With a flat 3 s `DEFAULT_RECALL_EMBED_TIMEOUT_MS`, the first recall after the
 * funnel host's 60 s idle exit (host respawn + model load ≈ 4.5 s) ALWAYS timed
 * out, opened the vec breaker and went BM25-only. Fix: `recallEmbedTimeoutMsFor`
 * gives a cold path (no successful embed yet in this process, or none within
 * `EMBED_HOST_IDLE_EXIT_MS`) `RECALL_EMBED_TIMEOUT_COLD_MS`; a warm path keeps
 * the 3 s read budget; the explicit `SOX_RECALL_EMBED_TIMEOUT_MS` override
 * governs both.
 *
 * RED (fix disabled — `recallEmbedTimeoutMsFor` returns the flat 3000): the
 * cold recall below times out (a `vec:` degradation) and the pure cases fail.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import type { EmbeddingProvider, EmbeddingHealth, EmbeddingProviderMetadata, EmbedRole } from '@adhd/sox-embedding-provider';
import { openDb } from './db.js';
import {
  memoryRecall,
  recallEmbedTimeoutMsFor,
  RECALL_EMBED_TIMEOUT_COLD_MS,
  RECALL_EMBED_TIMEOUT_WARM_MS,
  EMBED_HOST_IDLE_EXIT_MS,
  __resetRecallVecCircuitForTest,
} from './recall.js';
import { WriteQueue } from './write-queue.js';
import { _setEmbedProviderForTest, _resetLastEmbedSuccessForTest } from './embed.js';
import { DeterministicTestProvider, featureHashEmbed } from './embed-test-provider.js';

vi.mock('sqlite-vec', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, default: actual };
});

class SlowProvider implements EmbeddingProvider {
  delayMs = 0;
  readonly metadata: EmbeddingProviderMetadata = {
    modelId: 'slow-test',
    dimensions: 768,
    maxTokens: 512,
    isRemote: false,
    isDeterministic: true,
  };
  async embedSingle(text: string, _role?: EmbedRole): Promise<Float32Array> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    return featureHashEmbed(text);
  }
  async *embedBatch(texts: string[], _opts?: { role?: EmbedRole; batchSize?: number }): AsyncIterable<Float32Array> {
    for (const text of texts) yield featureHashEmbed(text);
  }
  async warmUp(_texts: string[]): Promise<void> {
    // no-op — test double, always "warm"
  }
  health(): EmbeddingHealth {
    return {
      configured: `test:${this.metadata.modelId}`,
      active: this.metadata.modelId,
      state: 'real',
      dimensions: this.metadata.dimensions,
      last_error: null,
    };
  }
}

describe('819a416b — recallEmbedTimeoutMsFor (pure)', () => {
  const now = 1_000_000_000;
  it('no successful embed yet → cold budget', () => {
    expect(recallEmbedTimeoutMsFor(now, 0)).toBe(RECALL_EMBED_TIMEOUT_COLD_MS);
  });
  it('last success within the host idle-exit window → warm budget', () => {
    expect(recallEmbedTimeoutMsFor(now, now - 1_000)).toBe(RECALL_EMBED_TIMEOUT_WARM_MS);
  });
  it('last success past the idle-exit window (host may have exited) → cold budget', () => {
    expect(recallEmbedTimeoutMsFor(now, now - EMBED_HOST_IDLE_EXIT_MS)).toBe(RECALL_EMBED_TIMEOUT_COLD_MS);
  });
  it('explicit SOX_RECALL_EMBED_TIMEOUT_MS governs both', () => {
    expect(recallEmbedTimeoutMsFor(now, 0, '150')).toBe(150);
    expect(recallEmbedTimeoutMsFor(now, now, '150')).toBe(150);
  });
  it('cold budget clears the measured cold p95 + host spawn; warm stays a read budget', () => {
    expect(RECALL_EMBED_TIMEOUT_COLD_MS).toBeGreaterThanOrEqual(3361 + 4500);
    expect(RECALL_EMBED_TIMEOUT_WARM_MS).toBe(3000);
  });
});

describe('819a416b — the first recall after idle keeps its vec channel', () => {
  let dir: string;
  let adapter: StoreAdapter;
  let provider: SlowProvider;
  let prevTimeout: string | undefined;

  beforeEach(async () => {
    process.env['STORE_ADAPTER'] = 'sqlite';
    prevTimeout = process.env['SOX_RECALL_EMBED_TIMEOUT_MS'];
    delete process.env['SOX_RECALL_EMBED_TIMEOUT_MS'];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), '819a416b-'));
    adapter = await openDb(path.join(dir, 'm.db'));
    await WriteQueue.clearInstances();
    __resetRecallVecCircuitForTest();
    _resetLastEmbedSuccessForTest();
    provider = new SlowProvider();
    _setEmbedProviderForTest(provider);
  });

  afterEach(async () => {
    await WriteQueue.clearInstances();
    await adapter.close();
    fs.rmSync(dir, { recursive: true, force: true });
    _setEmbedProviderForTest(new DeterministicTestProvider());
    __resetRecallVecCircuitForTest();
    if (prevTimeout === undefined) delete process.env['SOX_RECALL_EMBED_TIMEOUT_MS'];
    else process.env['SOX_RECALL_EMBED_TIMEOUT_MS'] = prevTimeout;
  });

  it('a cold 3.5 s query embed completes (no vec degradation); a warm 3.5 s one still hits the 3 s guard', async () => {
    provider.delayMs = 3500;
    const cold = await memoryRecall(adapter, 'project', { query: 'first recall after idle', limit: 5 });
    expect((cold.degradations ?? []).filter((d) => d.startsWith('vec:'))).toEqual([]);

    // Now warm (a success just landed): the read budget is 3 s again.
    __resetRecallVecCircuitForTest();
    const warm = await memoryRecall(adapter, 'project', { query: 'warm but slow', limit: 5 });
    expect(warm.degradations ?? []).toEqual(expect.arrayContaining([expect.stringMatching(/^vec: /)]));
  }, 30_000);
});
