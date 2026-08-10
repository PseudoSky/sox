/**
 * recall-live-incident.spec.ts — regression tests for the live-recall outage
 * (2026-07-30, TursoAdapter go-live incident, wip/turso-live-metrics).
 *
 * Two independent defects made `memory_recall` unusable on the live Turso
 * store:
 *
 *   DEFECT 1 (this file, §1) — recall.ts's query-embed had NO timeout, so a
 *   provider that never settles (a query-embed joining the tail of a
 *   backed-up fastembed IPC queue — live-observed embed_duration_ms p50 ≈
 *   1,515,425ms during an enrich-tick stampede) hangs `memory_recall`
 *   FOREVER. The pre-existing try/catch around `await embed(query)` (BL-273)
 *   only handles a REJECTED promise — it does nothing for a promise that
 *   never settles at all. Fixed by racing the query-embed against a
 *   configurable wall-clock timeout (`embedWithRecallTimeout` /
 *   `SOX_RECALL_EMBED_TIMEOUT_MS`, default 3000ms) so a stalled provider
 *   degrades gracefully to the BM25/temporal channels instead of hanging.
 *
 *   DEFECT 2 (this file, §2) — recall.ts's FTS channel query is dialect-aware
 *   (see recall.ts's `createFTSDialect(adapter.config.type)` branch): SQLite
 *   uses the FTS5 `fts_node MATCH ?` virtual-table path, Turso uses the
 *   native Tantivy `fts_match(...)/fts_score(...)` functions directly on
 *   `node` (no `fts_node` shadow table exists on Turso — TursoFTSDialect,
 *   see libs/data/store/store-adapter/src/fts-dialect.ts). This suite pins
 *   that both branches emit dialect-correct SQL and never regress to a
 *   hardcoded FTS5-only query that would throw "no such table: fts_node" on
 *   a live Turso store.
 *
 * Gate: npx nx test memory-core --exclude-task-dependencies
 *   (--exclude-task-dependencies is required while libs/data/store/store-adapter's
 *   build is mid-WIP-breakage by another agent on this branch; it is not
 *   this file's concern — see team coordination notes in BACKLOG.md.)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter, AllResult, RunResult, FtsEnsureResult } from '@adhd/sox-store-adapter';
import type { EmbedRole } from '@adhd/sox-embedding-provider';
import { openDb } from './db.js';
import { memoryWrite } from './write.js';
import { memoryRecall } from './recall.js';
import { WriteQueue } from './write-queue.js';
import { _setEmbedProviderForTest } from './embed.js';
import { DeterministicTestProvider } from './embed-test-provider.js';

// BL-323 (pre-existing, unrelated to this file's fix): db.ts:328 destructures
// a non-existent `default` export off the `sqlite-vec` CJS module
// (`const { default: sqliteVec } = await import('sqlite-vec')` — the
// installed sqlite-vec@0.1.9 exposes `load`/`getLoadablePath` as named
// exports only), so every `openDb()` on the sqlite adapter currently throws
// `Cannot read properties of undefined (reading 'load')` regardless of this
// fix. That bug is filed and owned separately (BACKLOG.md BL-323; db.ts is
// out of scope for this change). This mock exists ONLY to unblock §1's
// integration test against a real StoreAdapter in the meantime — it does
// not touch db.ts and has no effect outside this test file.
vi.mock('sqlite-vec', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, default: actual };
});

// ── §1: query-embed timeout guard ─────────────────────────────────────────────

/**
 * Provider whose embedSingle NEVER settles — the exact live-incident failure
 * mode. Not a rejecting provider (BL-273 already handles that); a promise
 * that simply never resolves or rejects, exactly like a query joining the
 * tail of a backed-up single-child-process IPC queue. A try/catch around
 * `await embed(...)` cannot save you from this — only a race against a
 * timeout can.
 */
class HangingProvider extends DeterministicTestProvider {
  override async embedSingle(_text: string, _role?: EmbedRole): Promise<Float32Array> {
    return new Promise<Float32Array>(() => {
      /* never settles — models the stuck-behind-a-stampede provider */
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

describe('memoryRecall — Defect 1: query-embed timeout guard (live-incident regression)', () => {
  let ctx: TestContext;
  const ORIGINAL_TIMEOUT_ENV = process.env['SOX_RECALL_EMBED_TIMEOUT_MS'];

  beforeEach(async () => {
    forceSqliteAdapter();
    ctx = await tmpDb('recall-guard-');
    await WriteQueue.clearInstances();
    WriteQueue.setBypass(false);
    _setEmbedProviderForTest(new DeterministicTestProvider());
    await memoryWrite(ctx.adapter, {
      content: 'turso adapter live-metrics compatibility notes for BL-319',
      project_path: '/test/project',
    });
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
    'degrades gracefully to BM25/temporal-only within the configured timeout instead of hanging forever',
    async () => {
      process.env['SOX_RECALL_EMBED_TIMEOUT_MS'] = '150';
      _setEmbedProviderForTest(new HangingProvider());

      const t0 = Date.now();
      const response = await memoryRecall(ctx.adapter, 'project', {
        query: 'turso',
        limit: 1,
      });
      const elapsedMs = Date.now() - t0;

      // Must resolve promptly — well under the vitest test timeout below —
      // and in the same order of magnitude as the configured 150ms guard.
      // Pre-fix, this call NEVER resolves (this exact assertion is what
      // times out the test under the disabled-fix run — see PR notes).
      expect(elapsedMs).toBeLessThan(3000);

      // Degraded, not empty: the BM25/temporal channels still find the
      // seeded episode via its text content even though the vec channel
      // was skipped because the provider never settled.
      expect(response.results.length).toBeGreaterThan(0);
      expect(response.results[0]?.content).toContain('turso adapter live-metrics');
    },
    8000,
  );

  it('a healthy (fast) provider is unaffected by the timeout guard', async () => {
    process.env['SOX_RECALL_EMBED_TIMEOUT_MS'] = '150';
    _setEmbedProviderForTest(new DeterministicTestProvider());

    const response = await memoryRecall(ctx.adapter, 'project', {
      query: 'turso',
      limit: 1,
    });

    expect(response.results.length).toBeGreaterThan(0);
  }, 8000);
});

// ── §2: FTS dialect correctness (sqlite vs turso) ────────────────────────────

/**
 * Minimal StoreAdapter test double that records every SQL statement passed
 * to executeAll/executeGet and returns empty result sets. This lets us
 * assert on the EXACT SQL text recall.ts emits for the FTS channel per
 * adapter dialect, without needing a live Turso connection (none is
 * available in this environment — see team coordination notes).
 *
 * Returning empty rows from every call is safe: memoryRecall's
 * allRowids.size === 0 early-return path executes cleanly after the FTS
 * (and vec + temporal) queries have already been issued and recorded, so the
 * dialect-selection logic under test runs in full before the function exits.
 */
class RecordingAdapter implements StoreAdapter {
  readonly calls: { sql: string; args: unknown[] }[] = [];
  constructor(readonly config: StoreAdapter['config']) {}
  readonly capabilities: StoreAdapter['capabilities'] = {
    multiprocessWrite: false,
    nativeVectors: true,
    concurrentTransactions: false,
    fts5: true,
    fts: true,
    needsWriteSerialization: false,
  };

  async executeGet<T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T | null> {
    this.calls.push({ sql, args });
    return null;
  }

  async executeAll<T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<AllResult<T>> {
    this.calls.push({ sql, args });
    return { columns: [], rows: [] };
  }

  async executeRun(sql: string, args: unknown[] = []): Promise<RunResult> {
    this.calls.push({ sql, args });
    return { rowsAffected: 0, lastInsertRowid: 0 };
  }

  async exec(sql: string): Promise<void> {
    this.calls.push({ sql, args: [] });
  }

  async pragmaSet(): Promise<void> {
    /* no-op */
  }

  async pragmaGet<T = unknown>(): Promise<T> {
    return undefined as T;
  }

  async transaction<T>(fn: (tx: never) => T | Promise<T>): Promise<T> {
    return fn(undefined as never);
  }

  async executeMany(stmts: { sql: string; args?: unknown[] }[]): Promise<RunResult[]> {
    return stmts.map((s) => {
      this.calls.push({ sql: s.sql, args: s.args ?? [] });
      return { rowsAffected: 0, lastInsertRowid: 0 };
    });
  }

  async close(): Promise<void> {
    /* no-op */
  }

  // (A2 — FEAT-SOXGRAPH-001) Required StoreAdapter members. This double only
  // records SQL issued by memoryRecall's own channels — it never issues FTS
  // SQL itself, so these return empty results and record nothing.
  async ftsSearch<T = Record<string, unknown>>(): Promise<Array<T & { rowid: number; score: number }>> {
    return [];
  }

  async ftsCount(): Promise<number> {
    return 0;
  }

  async ensureFtsIndex(): Promise<FtsEnsureResult> {
    return {
      ensured: false,
      adoptedExisting: null,
      indexName: null,
      backfilled: false,
      residueDropped: [],
      residueNeedsOutOfBand: false,
    };
  }

  unwrap(): unknown {
    return undefined;
  }
}

describe('memoryRecall — Defect 2: FTS channel is dialect-aware (sqlite vs turso)', () => {
  beforeEach(() => {
    _setEmbedProviderForTest(new DeterministicTestProvider());
  });

  it('emits SQLite FTS5 `fts_node MATCH` syntax on a sqlite-type adapter', async () => {
    const adapter = new RecordingAdapter({ type: 'sqlite', dbPath: '/tmp/does-not-matter.db' });

    await memoryRecall(adapter, 'project', { query: 'turso adapter', limit: 5 });

    const ftsCall = adapter.calls.find((c) => /FROM\s+fts_node/i.test(c.sql));
    expect(ftsCall).toBeDefined();
    expect(ftsCall?.sql).toMatch(/fts_node\s+MATCH\s+\?/i);
    // Must NEVER emit the Turso-only Tantivy function on sqlite.
    expect(ftsCall?.sql).not.toMatch(/fts_match\(/i);
    expect(ftsCall?.sql).not.toMatch(/fts_score\(/i);
  });

  it('emits Turso Tantivy `fts_match`/`fts_score` syntax on a turso-type adapter, never `fts_node`', async () => {
    const adapter = new RecordingAdapter({ type: 'turso', url: 'libsql://does-not-matter' });

    await memoryRecall(adapter, 'project', { query: 'turso adapter', limit: 5 });

    const ftsCall = adapter.calls.find((c) => /fts_match\(/i.test(c.sql));
    expect(ftsCall).toBeDefined();
    expect(ftsCall?.sql).toMatch(/FROM\s+node\b/i);
    // Query text is bound as a normal parameter (`?`), never inlined as a SQL
    // string literal — verified empirically (2026-07-30) that Turso's
    // fts_match/fts_score accept bound params identically to literal args,
    // so there's no reason to hand-roll quote-escaping and risk injection.
    expect(ftsCall?.sql).toMatch(/fts_match\(\s*"content",\s*"name",\s*"summary"\s*,\s*\?\s*\)/i);
    expect(ftsCall?.sql).toMatch(/fts_score\(\s*"content",\s*"name",\s*"summary"\s*,\s*\?\s*\)/i);
    // BL-367 (post-dates this test's original write): the bound param is the
    // dialect's tokenized `"tok1" OR "tok2"` match query, not the raw query
    // string — Turso's Tantivy fts_match matches on ANY token, so recall.ts
    // builds an explicit OR expression via FTSDialect.buildMatchQuery (see
    // fts-dialect.ts) for BOTH dialects, verified empirically 2026-07-30. The
    // raw string is still bound as a normal `?` param (never inlined/escaped
    // by hand) — just not byte-identical to the caller's query text anymore.
    expect(ftsCall?.args).toContain('"turso" OR "adapter"');
    // Must NEVER reference the sqlite-only shadow table on Turso — this is
    // the exact defect: fts_node does not exist on a live Turso store.
    expect(ftsCall?.sql).not.toMatch(/fts_node/i);
  });
});
