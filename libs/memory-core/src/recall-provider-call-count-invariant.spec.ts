/**
 * recall-provider-call-count-invariant.spec.ts — regression for the
 * `provider_call_count` / `degradations` contradiction (BL-391 follow-up).
 *
 * `provider_call_count` counts embed calls ATTEMPTED on this recall
 * (embed.ts increments the counter before `await provider.embedSingle()`,
 * not after it resolves — BL-254). It is NOT a "call succeeded" signal;
 * `degradations` is the field that tells a caller whether an attempted vec
 * embed actually returned a vector.
 *
 * INVARIANT: whenever `degradations` carries a `"vec: …"` entry (the query
 * embed was attempted and failed/timed out), `provider_call_count` must be
 * >0 — it must never contradict the degradation by reading 0, because a
 * `vec:` degradation is proof an embed call WAS attempted. The two fields
 * living in the same response must never tell opposite stories.
 *
 * Pre-fix, `memoryRecall`'s empty-corpus early return (the `allRowids.size
 * === 0` branch) hardcoded `provider_call_count: 0` unconditionally — even
 * when the query embed above it had already been attempted and timed out,
 * producing exactly this contradiction: `provider_call_count: 0` sitting
 * beside `degradations: ["vec: embed() timed out after …"]`. The non-empty
 * path (bottom of the function) already computed the real
 * `getProviderCallCount()` before/after delta, so it never had this bug —
 * §2 below pins that it stays correct, but only §1 is a genuine RED→GREEN
 * detector for this fix (verified by reverting the fix and re-running: see
 * PR/commit notes).
 *
 * Gate: run vitest DIRECTLY against this package (resolves
 * `@adhd/sox-embedding-provider` to its own dist, but `recall.ts`/`embed.ts`
 * themselves are consumed from SOURCE per libs/memory-core/vitest.config.ts
 * `include` — no memory-server dist alias involved).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EmbedRole } from '@adhd/sox-embedding-provider';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { memoryWrite } from './write.js';
import { memoryRecall } from './recall.js';
import { WriteQueue } from './write-queue.js';
import { _setEmbedProviderForTest } from './embed.js';
import { DeterministicTestProvider } from './embed-test-provider.js';

// See recall-live-incident.spec.ts for why this mock exists (BL-323,
// unrelated pre-existing sqlite-vec CJS interop issue — out of scope here).
import { vi } from 'vitest';
vi.mock('sqlite-vec', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, default: actual };
});

/** Provider whose embedSingle never settles — forces the recall read-path
 *  timeout guard (SOX_RECALL_EMBED_TIMEOUT_MS) to fire deterministically. */
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

/** The invariant under test: a `vec:` degradation is proof an embed call was
 *  attempted, so provider_call_count can never read 0 alongside one. */
function assertProviderCallCountConsistentWithDegradations(response: {
  provider_call_count: number;
  degradations?: string[];
}): void {
  const vecDegraded = (response.degradations ?? []).some((d) => d.startsWith('vec:'));
  if (vecDegraded) {
    expect(response.provider_call_count).toBeGreaterThan(0);
  }
}

describe('memoryRecall — provider_call_count must not contradict degradations', () => {
  let ctx: TestContext;
  const ORIGINAL_TIMEOUT_ENV = process.env['SOX_RECALL_EMBED_TIMEOUT_MS'];

  beforeEach(async () => {
    forceSqliteAdapter();
    ctx = await tmpDb('recall-pcc-invariant-');
    await WriteQueue.clearInstances();
    WriteQueue.setBypass(false);
    _setEmbedProviderForTest(new DeterministicTestProvider());
    process.env['SOX_RECALL_EMBED_TIMEOUT_MS'] = '150';
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
    // §1 — THE genuine RED→GREEN detector. Empty corpus (no writes at all):
    // every channel (vec/fts/temporal) legitimately finds nothing, so
    // `allRowids.size === 0` and the early-return branch fires. The query
    // embed was still attempted above it and timed out (HangingProvider),
    // so degradations carries `vec: …`. Pre-fix this branch hardcoded
    // `provider_call_count: 0` regardless — the exact contradiction this
    // test pins.
    '§1 empty-corpus early return: provider_call_count must be >0 when degradations reports a vec timeout',
    async () => {
      _setEmbedProviderForTest(new HangingProvider());

      const response = await memoryRecall(ctx.adapter, 'project', {
        query: 'nothing in this corpus matches anything',
        limit: 10,
      });

      // Sanity: this really is the empty-corpus branch.
      expect(response.results).toHaveLength(0);
      // Sanity: the degradation really fired (proves the embed was attempted).
      expect(response.degradations).toBeDefined();
      expect(response.degradations!.some((d) => d.startsWith('vec:'))).toBe(true);

      // THE regression assertion. Pre-fix: provider_call_count reads 0 here
      // (hardcoded), directly contradicting the vec: degradation above.
      assertProviderCallCountConsistentWithDegradations(response);
      expect(response.provider_call_count).toBe(1);
    },
    8000,
  );

  it(
    // §2 — companion coverage for the non-empty path (BL-225 asks both
    // paths be covered). This path already computed the real
    // getProviderCallCount() before/after delta pre-fix, so it is a
    // consistency pin rather than an independent RED→GREEN detector for
    // THIS bug — included so the invariant is asserted end-to-end, not just
    // on the branch that was broken.
    '§2 non-empty degraded recall: provider_call_count must be >0 when degradations reports a vec timeout',
    async () => {
      await memoryWrite(ctx.adapter, {
        content: 'widget alpha assembly procedure calibration notes for BL-391',
        project_path: '/test/project',
      });

      _setEmbedProviderForTest(new HangingProvider());

      const response = await memoryRecall(ctx.adapter, 'project', {
        query: 'widget alpha',
        limit: 10,
      });

      // Sanity: BM25/temporal still found the seeded episode.
      expect(response.results.length).toBeGreaterThan(0);
      expect(response.degradations).toBeDefined();
      expect(response.degradations!.some((d) => d.startsWith('vec:'))).toBe(true);

      assertProviderCallCountConsistentWithDegradations(response);
      expect(response.provider_call_count).toBe(1);
    },
    8000,
  );
});
