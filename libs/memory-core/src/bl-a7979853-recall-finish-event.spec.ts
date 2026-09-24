/**
 * bl-a7979853-recall-finish-event.spec.ts — regression for backlog a7979853:
 * every recall must emit exactly one persisted 'recall.finish' outcome event
 * (via tlog), so embed-vs-degraded searches are countable from the log
 * across restarts, without depending on the in-memory response shape alone.
 *
 * Pattern follows recall-provider-call-count-invariant.spec.ts (harness) and
 * bl384-search-entities-fts-dialect.spec.ts (tlog spy).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EmbedRole } from '@adhd/sox-embedding-provider';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { memoryWrite } from './write.js';
import { memoryRecall, federatedRecall, closeFederationConnections, __resetRecallVecCircuitForTest } from './recall.js';
import { WriteQueue } from './write-queue.js';
import { _setEmbedProviderForTest } from './embed.js';
import { DeterministicTestProvider } from './embed-test-provider.js';
import { log as tlog } from './telemetry.js';

// See recall-live-incident.spec.ts for why this mock exists (BL-323).
vi.mock('sqlite-vec', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, default: actual };
});

class HangingProvider extends DeterministicTestProvider {
  override async embedSingle(_text: string, _role?: EmbedRole): Promise<Float32Array> {
    return new Promise<Float32Array>(() => {
      /* never settles */
    });
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

describe('memoryRecall — a7979853 persisted recall.finish outcome event', () => {
  let ctx: TestContext;
  const ORIGINAL_TIMEOUT_ENV = process.env['SOX_RECALL_EMBED_TIMEOUT_MS'];

  beforeEach(async () => {
    forceSqliteAdapter();
    ctx = await tmpDb('recall-finish-event-');
    await WriteQueue.clearInstances();
    WriteQueue.setBypass(false);
    _setEmbedProviderForTest(new DeterministicTestProvider());
    process.env['SOX_RECALL_EMBED_TIMEOUT_MS'] = '150';
    // (BL-a7979853) The embed circuit breaker is module-level state that
    // otherwise leaks between tests in this file — a prior test's hung
    // provider opens it, which then makes the NEXT test's recall skip its
    // own embed entirely (degradation path) instead of exercising it.
    __resetRecallVecCircuitForTest();
  });

  afterEach(async () => {
    await WriteQueue.clearInstances();
    await ctx.adapter.close();
    ctx.cleanup();
    _setEmbedProviderForTest(new DeterministicTestProvider());
    if (ORIGINAL_TIMEOUT_ENV === undefined) {
      delete process.env['SOX_RECALL_EMBED_TIMEOUT_MS'];
    } else {
      process.env['SOX_RECALL_EMBED_TIMEOUT_MS'] = ORIGINAL_TIMEOUT_ENV;
    }
  });

  it(
    // BL-a7979853 review item 1: federatedRecall previously derived vec_used
    // from `providerDelta > 0` (getProviderCallCount() before/after), but
    // embed.ts's providerCallCount is incremented BEFORE the embed settles
    // (BL-254) — a query embed that HANGS/times out for the entire recall
    // still bumps that counter, so the old logic reported vec_used:true for
    // a federated recall whose vec channel never produced a usable vector.
    // Placed as the FIRST test in this file (deliberately, no beforeEach
    // reset added — dropped per review scope-narrowing) so the module-level
    // embed circuit breaker (recall.ts) is still closed: a later test in
    // this file opens it via a real timeout, which would short-circuit the
    // embed call entirely and mask this exact regression.
    'federatedRecall vec_used reflects actual per-store vec use, not provider_call_count, when a provider hangs',
    async () => {
      _setEmbedProviderForTest(new HangingProvider());
      const infoSpy = vi.spyOn(tlog, 'info');
      try {
        const response = await federatedRecall(
          [{ scope: 'project', dbPath: ctx.dbPath }],
          { query: 'nothing matches, provider is hanging', limit: 10 },
        );

        // Fixed behavior: no store ever produced a usable query vector, so
        // vec_used must be false and stores_vec_used must be 0 — regardless
        // of how many embed-call ATTEMPTS provider_call_count recorded.
        expect(response.vec_used).toBe(false);
        expect(response.stores_vec_used).toBe(0);

        const finishCalls = infoSpy.mock.calls.filter((c) => c[0] === 'recall.federated_finish');
        expect(finishCalls).toHaveLength(1);
        const [, payload] = finishCalls[0]!;
        const p = payload as { vec_used: boolean; stores_vec_used: number };
        expect(p.vec_used).toBe(false);
        expect(p.stores_vec_used).toBe(0);
      } finally {
        infoSpy.mockRestore();
        await closeFederationConnections();
      }
    },
    8000,
  );

  it(
    'emits exactly one recall.finish with vec_used:true when the provider embeds',
    async () => {
      await memoryWrite(ctx.adapter, {
        content: 'widget alpha assembly procedure calibration notes for a7979853',
        project_path: '/test/project',
      });

      const infoSpy = vi.spyOn(tlog, 'info');

      const response = await memoryRecall(ctx.adapter, 'project', {
        query: 'widget alpha',
        limit: 10,
      });

      expect(response.results.length).toBeGreaterThan(0);

      const finishCalls = infoSpy.mock.calls.filter((c) => c[0] === 'recall.finish');
      expect(finishCalls).toHaveLength(1);
      const [, payload] = finishCalls[0]!;
      expect(payload).toMatchObject({
        vec_used: true,
        result_count: response.results.length,
        scope: 'project',
      });
      expect(Array.isArray((payload as { degradations: unknown }).degradations)).toBe(true);
      expect(typeof (payload as { total_ms: unknown }).total_ms).toBe('number');
      expect(typeof (payload as { provider_call_count: unknown }).provider_call_count).toBe('number');

      infoSpy.mockRestore();
    },
    8000,
  );

  it(
    'emits exactly one recall.finish with vec_used:false plus a degradation when the provider times out',
    async () => {
      _setEmbedProviderForTest(new HangingProvider());

      const infoSpy = vi.spyOn(tlog, 'info');

      const response = await memoryRecall(ctx.adapter, 'project', {
        query: 'nothing in this corpus matches anything',
        limit: 10,
      });

      expect(response.degradations).toBeDefined();
      expect(response.degradations!.some((d) => d.startsWith('vec:'))).toBe(true);

      const finishCalls = infoSpy.mock.calls.filter((c) => c[0] === 'recall.finish');
      expect(finishCalls).toHaveLength(1);
      const [, payload] = finishCalls[0]!;
      const p = payload as { vec_used: boolean; degradations: string[] };
      expect(p.vec_used).toBe(false);
      expect(p.degradations.some((d) => d.startsWith('vec:'))).toBe(true);

      infoSpy.mockRestore();
    },
    8000,
  );
});
