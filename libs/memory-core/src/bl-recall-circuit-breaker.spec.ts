/**
 * bl-recall-circuit-breaker.spec.ts — regression test for the per-process
 * recall vec circuit breaker (slug: recallCircuitBreaker; no exact backlog
 * uid found — closest candidates surfaced by adhd-backlog query were not
 * confirmed matches, see task report).
 *
 * Pre-fix behaviour: every recall paid the full vec embed timeout guard
 * even while the embed host was known to be slow/unresponsive, because
 * there was no breaker — each call independently raced embed() against
 * DEFAULT_RECALL_EMBED_TIMEOUT_MS with no memory of prior timeouts.
 *
 * Fix (recall.ts ~80-160, 590-635): after a vec embed timeout, the module
 * opens a circuit for SOX_RECALL_VEC_COOLDOWN_MS. While open, subsequent
 * recalls skip the query embed entirely and report degradation
 * 'vec: skipped, circuit open after embed timeout'. After the cooldown, the
 * next recall (half-open) attempts the embed again; success closes the
 * circuit, a further timeout reopens it.
 *
 * This spec drives the breaker through the real memoryRecall() call site
 * (no access to the private module-level state), using a test provider
 * whose embedSingle() delay is controlled by the test, and SOX_RECALL_EMBED
 * _TIMEOUT_MS / SOX_RECALL_VEC_COOLDOWN_MS set to small values so the test
 * runs in well under a second with real timers (no fake-timer interaction
 * with recall.ts's unref'd setTimeout is required).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import type { EmbeddingProvider, EmbeddingHealth, EmbedRole } from '@adhd/sox-embedding-provider';
import { openDb } from './db.js';
import { memoryRecall } from './recall.js';
import { WriteQueue } from './write-queue.js';
import { _setEmbedProviderForTest } from './embed.js';
import { DeterministicTestProvider, featureHashEmbed } from './embed-test-provider.js';

vi.mock('sqlite-vec', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, default: actual };
});

const EMBED_TIMEOUT_MS = 40;
const COOLDOWN_MS = 100;

/** Test provider whose embedSingle() delay is controlled per-call. */
class ControllableTestProvider implements EmbeddingProvider {
  delayMs = 0;
  calls = 0;
  metadata = { modelId: 'controllable-test', dim: 768 };

  async embedSingle(text: string, _role?: EmbedRole): Promise<Float32Array> {
    this.calls++;
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
    return featureHashEmbed(text);
  }

  async *embedBatch(
    texts: string[],
    _role?: EmbedRole,
  ): AsyncGenerator<{ index: number; vector: Float32Array }> {
    for (let i = 0; i < texts.length; i++) {
      yield { index: i, vector: featureHashEmbed(texts[i] as string) };
    }
  }

  health(): EmbeddingHealth {
    return { status: 'ready', model: 'controllable-test', dim: 768 };
  }
}

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

describe('memoryRecall — per-process vec circuit breaker (recallCircuitBreaker, no confirmed BL uid)', () => {
  let ctx: TestContext;
  let provider: ControllableTestProvider;
  let prevTimeout: string | undefined;
  let prevCooldown: string | undefined;

  beforeEach(async () => {
    forceSqliteAdapter();
    prevTimeout = process.env['SOX_RECALL_EMBED_TIMEOUT_MS'];
    prevCooldown = process.env['SOX_RECALL_VEC_COOLDOWN_MS'];
    process.env['SOX_RECALL_EMBED_TIMEOUT_MS'] = String(EMBED_TIMEOUT_MS);
    process.env['SOX_RECALL_VEC_COOLDOWN_MS'] = String(COOLDOWN_MS);
    ctx = await tmpDb('recall-circuit-');
    await WriteQueue.clearInstances();
    WriteQueue.setBypass(false);
    provider = new ControllableTestProvider();
    _setEmbedProviderForTest(provider);
  });

  afterEach(async () => {
    await WriteQueue.clearInstances();
    await ctx.adapter.close();
    ctx.cleanup();
    _setEmbedProviderForTest(new DeterministicTestProvider());
    if (prevTimeout === undefined) delete process.env['SOX_RECALL_EMBED_TIMEOUT_MS'];
    else process.env['SOX_RECALL_EMBED_TIMEOUT_MS'] = prevTimeout;
    if (prevCooldown === undefined) delete process.env['SOX_RECALL_VEC_COOLDOWN_MS'];
    else process.env['SOX_RECALL_VEC_COOLDOWN_MS'] = prevCooldown;
    vi.restoreAllMocks();
  });

  it('opens after an embed timeout, skips the next recall query embed, then closes on a half-open success', async () => {
    // 1) First recall: provider is slower than EMBED_TIMEOUT_MS -> vec embed
    //    times out -> circuit opens.
    provider.delayMs = EMBED_TIMEOUT_MS + 200;
    const r1 = await memoryRecall(ctx.adapter, 'project', {
      query: 'circuit breaker probe one',
      limit: 10,
    });
    expect(r1.degradations ?? []).toEqual(
      expect.arrayContaining([expect.stringMatching(/^vec: /)]),
    );
    const callsAfterTimeout = provider.calls;
    expect(callsAfterTimeout).toBeGreaterThan(0);

    // 2) Second recall, immediately after (circuit open): the query embed
    //    for THIS recall is skipped — its own vec channel never pays the
    //    embed-timeout cost — but under the immediate-probe design the
    //    circuit is probe-eligible right away (recallVecNextProbeAt is set
    //    to "now" on first open), so this recall claims the single-flight
    //    background probe and fires it (fire-and-forget, not awaited by
    //    this recall). That probe's own embed call is what bumps
    //    provider.calls here, not this recall's (skipped) query embed.
    provider.delayMs = 0; // probe succeeds instantly
    const r2 = await memoryRecall(ctx.adapter, 'project', {
      query: 'circuit breaker probe two',
      limit: 10,
    });
    expect(provider.calls).toBeGreaterThan(callsAfterTimeout);
    expect(r2.degradations ?? []).toEqual(
      expect.arrayContaining([expect.stringMatching(/^vec: skipped/)]),
    );

    // 3) Wait out the cooldown, then recall again (half-open probe). Provider
    //    now responds fast and successfully -> circuit closes, no vec
    //    degradation reported, and the embed IS attempted this time.
    await new Promise((r) => setTimeout(r, COOLDOWN_MS + 50));
    const r3 = await memoryRecall(ctx.adapter, 'project', {
      query: 'circuit breaker probe three',
      limit: 10,
    });
    expect(provider.calls).toBeGreaterThan(callsAfterTimeout);
    const vecDegradations3 = (r3.degradations ?? []).filter((d) => d.startsWith('vec:'));
    expect(vecDegradations3).toEqual([]);

    // 4) One more recall right after the successful half-open probe: circuit
    //    should be fully closed now (not still gating on a stale open state).
    const r4 = await memoryRecall(ctx.adapter, 'project', {
      query: 'circuit breaker probe four',
      limit: 10,
    });
    const vecDegradations4 = (r4.degradations ?? []).filter((d) => d.startsWith('vec:'));
    expect(vecDegradations4).toEqual([]);
  });
});
