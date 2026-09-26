/**
 * 819a416b (follow-up) — recall's cold budget must follow the HOST, not only
 * this process's last-success stamp, and one cold start must not open the
 * vec breaker.
 *
 * Production 2026-09-26 03:06:18Z (memory-server 1.3.5, pid 55791): the warmup
 * embed had stamped a success 15 s earlier, so the first recall got the 3 s
 * WARM budget — but its query embed queued behind an in-flight write and heal
 * embed on the single-member host and lost by 212 ms, opening the breaker for
 * the next recall. The stamp alone also cannot see a host that retired (ADR-0022
 * W = 60 s) or died while this process's client stayed initialized.
 *
 * RED observed (fix disabled — `recallEmbedBudgetFor` ignoring `readiness` and
 * RECALL_VEC_COLD_TIMEOUTS_TO_OPEN = 1): 6 failed / 4 passed — the host-retired
 * and contended recalls degrade with `vec: embed() timed out after 3000ms`, and
 * with only the threshold reverted the two breaker-count cases fail (the
 * breaker is open after a single cold-start timeout).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import type { EmbeddingProvider, EmbeddingHealth, EmbedReadiness, EmbedRole } from '@adhd/sox-embedding-provider';
import { openDb } from './db.js';
import {
  memoryRecall,
  recallEmbedBudgetFor,
  recallEmbedTimeoutMsFor,
  RECALL_EMBED_TIMEOUT_COLD_MS,
  RECALL_EMBED_TIMEOUT_WARM_MS,
  EMBED_HOST_IDLE_EXIT_MS,
  RECALL_VEC_COLD_TIMEOUTS_TO_OPEN,
  __resetRecallVecCircuitForTest,
  __recallVecCircuitStateForTest,
} from './recall.js';
import { WriteQueue } from './write-queue.js';
import { embed, _setEmbedProviderForTest, _resetLastEmbedSuccessForTest, getEmbedReadiness } from './embed.js';
import { DeterministicTestProvider, featureHashEmbed } from './embed-test-provider.js';

vi.mock('sqlite-vec', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, default: actual };
});

/** A provider whose readiness is scripted, standing in for the funnel client. */
class ScriptedHostProvider implements EmbeddingProvider {
  delayMs = 0;
  state: EmbedReadiness = { warm: true, pending: 0 };
  metadata = {
    modelId: 'scripted-host',
    dimensions: 768,
    maxTokens: 512,
    isRemote: false,
    isDeterministic: true,
    providerUri: 'test:scripted-host',
  };
  async embedSingle(text: string, _role?: EmbedRole): Promise<Float32Array> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    return featureHashEmbed(text);
  }
  async *embedBatch(texts: string[]): AsyncIterable<Float32Array> {
    for (const t of texts) yield featureHashEmbed(t);
  }
  async warmUp(): Promise<void> {
    /* nothing to warm: scripted */
  }
  health(): EmbeddingHealth {
    return { configured: 'scripted-host', active: 'scripted-host', state: 'real', dimensions: 768, last_error: null };
  }
  readiness(): EmbedReadiness {
    return this.state;
  }
}

const vecDegradations = (r: { degradations?: string[] }): string[] =>
  (r.degradations ?? []).filter((d) => d.startsWith('vec:') || d.includes('breaker'));

describe('819a416b — recallEmbedBudgetFor consults provider readiness (pure)', () => {
  const now = 1_000_000_000;
  const recent = now - 1_000;
  it('recent success + warm, idle host → warm budget', () => {
    expect(recallEmbedBudgetFor(now, recent, undefined, { warm: true, pending: 0 })).toEqual({
      timeoutMs: RECALL_EMBED_TIMEOUT_WARM_MS,
      cold: false,
      reason: 'warm',
    });
  });
  it('recent success but the host retired/died (readiness not warm) → cold budget', () => {
    expect(recallEmbedBudgetFor(now, recent, undefined, { warm: false, pending: 0 })).toEqual({
      timeoutMs: RECALL_EMBED_TIMEOUT_COLD_MS,
      cold: true,
      reason: 'host_not_warm',
    });
  });
  it('warm host with embeds already in flight (the 2026-09-26 incident) → cold budget', () => {
    expect(recallEmbedBudgetFor(now, recent, undefined, { warm: true, pending: 2 })).toMatchObject({
      timeoutMs: RECALL_EMBED_TIMEOUT_COLD_MS,
      cold: true,
      reason: 'contended',
    });
  });
  it('provider cannot tell (null) → the last-success stamp decides, as before', () => {
    expect(recallEmbedTimeoutMsFor(now, recent, undefined, null)).toBe(RECALL_EMBED_TIMEOUT_WARM_MS);
    expect(recallEmbedBudgetFor(now, 0, undefined, null).reason).toBe('no_success_yet');
    expect(recallEmbedBudgetFor(now, now - EMBED_HOST_IDLE_EXIT_MS, undefined, null).reason).toBe('idle_exit');
  });
  it('the explicit override governs every case and is never cold', () => {
    expect(recallEmbedBudgetFor(now, recent, '150', { warm: false, pending: 5 })).toEqual({
      timeoutMs: 150,
      cold: false,
      reason: 'override',
    });
  });
});

describe('819a416b — recall survives a cold host without degrading or tripping the breaker', () => {
  let dir: string;
  let adapter: StoreAdapter;
  let provider: ScriptedHostProvider;
  let prevTimeout: string | undefined;

  beforeEach(async () => {
    process.env['STORE_ADAPTER'] = 'sqlite';
    prevTimeout = process.env['SOX_RECALL_EMBED_TIMEOUT_MS'];
    delete process.env['SOX_RECALL_EMBED_TIMEOUT_MS'];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), '819a416b-host-'));
    adapter = await openDb(path.join(dir, 'm.db'));
    await WriteQueue.clearInstances();
    __resetRecallVecCircuitForTest();
    _resetLastEmbedSuccessForTest();
    provider = new ScriptedHostProvider();
    _setEmbedProviderForTest(provider);
    // A previously initialized client: one fast, successful recall embed
    // stamps a success moments ago — the stamp alone now says "warm".
    const first = await memoryRecall(adapter, 'project', { query: 'prime the client', limit: 5 });
    expect(vecDegradations(first)).toEqual([]);
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

  it('host retired while the client stayed initialized: a 3.5 s cold embed contributes, no degradation', async () => {
    provider.state = { warm: false, pending: 0 };
    expect(getEmbedReadiness()).toEqual({ warm: false, pending: 0 });
    provider.delayMs = 3500;
    const r = await memoryRecall(adapter, 'project', { query: 'first recall after the host retired', limit: 5 });
    expect(vecDegradations(r)).toEqual([]);
    expect(__recallVecCircuitStateForTest().open).toBe(false);
  }, 30_000);

  it('warm host with embeds in flight (incident shape): a 3.5 s queued embed contributes, no degradation', async () => {
    provider.state = { warm: true, pending: 2 };
    provider.delayMs = 3500;
    const r = await memoryRecall(adapter, 'project', { query: 'queued behind write and heal', limit: 5 });
    expect(vecDegradations(r)).toEqual([]);
    expect(__recallVecCircuitStateForTest().open).toBe(false);
  }, 30_000);

  it('a warm, idle host keeps the 3 s read budget (a slow warm embed still degrades and opens the breaker)', async () => {
    provider.state = { warm: true, pending: 0 };
    provider.delayMs = 3500;
    const r = await memoryRecall(adapter, 'project', { query: 'warm but slow', limit: 5 });
    expect(r.degradations ?? []).toEqual(
      expect.arrayContaining([expect.stringMatching(/^vec: embed\(\) timed out after 3000ms/)]),
    );
    expect(__recallVecCircuitStateForTest().open).toBe(true);
  }, 30_000);

  it(`one cold timeout does not open the breaker; ${RECALL_VEC_COLD_TIMEOUTS_TO_OPEN} consecutive ones do`, async () => {
    provider.state = { warm: false, pending: 0 };
    provider.delayMs = RECALL_EMBED_TIMEOUT_COLD_MS + 1500;

    const a = await memoryRecall(adapter, 'project', { query: 'host cannot come up (1)', limit: 5 });
    expect(a.degradations ?? []).toEqual(
      expect.arrayContaining([expect.stringMatching(new RegExp(`^vec: embed\\(\\) timed out after ${RECALL_EMBED_TIMEOUT_COLD_MS}ms`))]),
    );
    expect(__recallVecCircuitStateForTest()).toEqual({ open: false, coldTimeouts: 1 });

    const b = await memoryRecall(adapter, 'project', { query: 'host cannot come up (2)', limit: 5 });
    expect(b.degradations ?? []).toEqual(expect.arrayContaining([expect.stringMatching(/^vec: embed\(\) timed out/)]));
    expect(__recallVecCircuitStateForTest().open).toBe(true);
  }, 60_000);

  it('a CONTENDED timeout (warm host, queue ahead) still opens the breaker at once — a backlog is not a cold start', async () => {
    provider.state = { warm: true, pending: 2 };
    provider.delayMs = RECALL_EMBED_TIMEOUT_COLD_MS + 1500;
    const r = await memoryRecall(adapter, 'project', { query: 'sustained backlog', limit: 5 });
    expect(r.degradations ?? []).toEqual(
      expect.arrayContaining([expect.stringMatching(new RegExp(`^vec: embed\\(\\) timed out after ${RECALL_EMBED_TIMEOUT_COLD_MS}ms`))]),
    );
    expect(__recallVecCircuitStateForTest()).toEqual({ open: true, coldTimeouts: 0 });
  }, 60_000);

  it('a success between cold timeouts resets the count', async () => {
    provider.state = { warm: false, pending: 0 };
    provider.delayMs = RECALL_EMBED_TIMEOUT_COLD_MS + 1500;
    await memoryRecall(adapter, 'project', { query: 'cold timeout', limit: 5 });
    expect(__recallVecCircuitStateForTest().coldTimeouts).toBe(1);

    provider.delayMs = 0;
    const ok = await memoryRecall(adapter, 'project', { query: 'host is back', limit: 5 });
    expect(vecDegradations(ok)).toEqual([]);
    expect(__recallVecCircuitStateForTest()).toEqual({ open: false, coldTimeouts: 0 });
  }, 60_000);

  // (819a416b follow-up, defect 1) `recallVecColdTimeouts` was a single
  // module counter bumped by every in-flight recall — two recalls racing the
  // SAME post-restart cold host spawn both time out and the counter reached
  // RECALL_VEC_COLD_TIMEOUTS_TO_OPEN, opening the breaker for what is really
  // ONE cold start, not two. Fixed by keying each cold timeout to the
  // episode (the cold window) it belongs to, so concurrent timeouts in the
  // same episode count once.
  it('two concurrent recalls that both cold-timeout on the SAME host-spawn episode count once — the breaker stays closed', async () => {
    provider.state = { warm: false, pending: 0 };
    provider.delayMs = RECALL_EMBED_TIMEOUT_COLD_MS + 1500;

    const [a, b] = await Promise.all([
      memoryRecall(adapter, 'project', { query: 'concurrent cold recall (1)', limit: 5 }),
      memoryRecall(adapter, 'project', { query: 'concurrent cold recall (2)', limit: 5 }),
    ]);
    const timeoutPattern = new RegExp(`^vec: embed\\(\\) timed out after ${RECALL_EMBED_TIMEOUT_COLD_MS}ms`);
    expect(a.degradations ?? []).toEqual(expect.arrayContaining([expect.stringMatching(timeoutPattern)]));
    expect(b.degradations ?? []).toEqual(expect.arrayContaining([expect.stringMatching(timeoutPattern)]));
    // Two recalls, one cold episode: the breaker must still be closed with
    // exactly ONE counted cold timeout, not two.
    expect(__recallVecCircuitStateForTest()).toEqual({ open: false, coldTimeouts: 1 });
  }, 60_000);

  // (819a416b follow-up, defect 2) The cold-timeout count never expired —
  // only a foreground recall SUCCESS reset it, so a lone background embed
  // success (write/heal/warmup — anything that stamps
  // getLastEmbedSuccessAtMs() without going through memoryRecall) never
  // cleared a prior cold timeout, letting it silently carry forward toward
  // the breaker threshold. Fixed by also resetting the count when any embed
  // success is newer than the last counted cold timeout.
  it('a cold timeout, then a BACKGROUND embed success, then a later cold timeout — the breaker stays closed', async () => {
    provider.state = { warm: false, pending: 0 };
    provider.delayMs = RECALL_EMBED_TIMEOUT_COLD_MS + 1500;

    const a = await memoryRecall(adapter, 'project', { query: 'cold timeout before background success', limit: 5 });
    expect(a.degradations ?? []).toEqual(
      expect.arrayContaining([expect.stringMatching(new RegExp(`^vec: embed\\(\\) timed out after ${RECALL_EMBED_TIMEOUT_COLD_MS}ms`))]),
    );
    expect(__recallVecCircuitStateForTest()).toEqual({ open: false, coldTimeouts: 1 });

    // A background embed succeeds WITHOUT going through memoryRecall at all
    // (e.g. a write/heal/warmup embed) — only the last-success stamp moves;
    // the provider's own readiness still reports the host as not warm.
    provider.delayMs = 0;
    await embed('background write embed', 'write');
    expect(getEmbedReadiness()).toEqual({ warm: false, pending: 0 });

    provider.delayMs = RECALL_EMBED_TIMEOUT_COLD_MS + 1500;
    const b = await memoryRecall(adapter, 'project', { query: 'cold timeout after background success', limit: 5 });
    expect(b.degradations ?? []).toEqual(
      expect.arrayContaining([expect.stringMatching(new RegExp(`^vec: embed\\(\\) timed out after ${RECALL_EMBED_TIMEOUT_COLD_MS}ms`))]),
    );
    // The background success reset the counter — this is a fresh episode's
    // FIRST cold timeout (count 1), not the second, so the breaker stays
    // closed.
    expect(__recallVecCircuitStateForTest()).toEqual({ open: false, coldTimeouts: 1 });
  }, 60_000);
});
