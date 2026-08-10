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
 *   DEFECT 2 (this file, §2) — recall.ts's FTS channel query must be
 *   dialect-aware: SQLite uses the FTS5 `fts_node MATCH ?` virtual-table
 *   path, Turso uses the native Tantivy `fts_match(...)/fts_score(...)`
 *   functions directly on `node` (no `fts_node` shadow table exists on Turso
 *   — see libs/data/store/store-adapter/src/fts-dialect.ts). Since
 *   DEBT-SOXGRAPH-001 (P5), that dialect awareness lives ENTIRELY in
 *   store-adapter: recall.ts delegates to `adapter.ftsSearch(...)` and never
 *   assembles FTS SQL itself (the weave's "no custom SQL above
 *   store-adapter" rule). This suite pins the DELEGATION CONTRACT — the
 *   exact table/columns/query/opts memoryRecall passes — and asserts zero
 *   hand-assembled FTS SQL reaches executeAll on either dialect. The
 *   per-backend SQL shapes themselves are pinned by store-adapter's own
 *   fts-ops.spec.ts (buildFtsSearchSql, sqlite shadow join vs turso
 *   fts_match/fts_score).
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
import type { StoreAdapter, AllResult, RunResult, FtsEnsureResult, FtsSearchOptions } from '@adhd/sox-store-adapter';
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
 * assert that memoryRecall's FTS channel NEVER assembles FTS SQL itself —
 * it must delegate to `adapter.ftsSearch` (DEBT-SOXGRAPH-001), which this
 * double also records (table/columns/query/opts), returning empty rows.
 *
 * Returning empty rows from every call is safe: memoryRecall's
 * allRowids.size === 0 early-return path executes cleanly after the FTS
 * (and vec + temporal) queries have already been issued and recorded, so the
 * delegation-under-test runs in full before the function exits.
 */
class RecordingAdapter implements StoreAdapter {
  readonly calls: { sql: string; args: unknown[] }[] = [];
  readonly ftsCalls: {
    table: string;
    columns: string[];
    query: string;
    opts: FtsSearchOptions;
  }[] = [];
  constructor(readonly config: StoreAdapter['config']) {}
  readonly capabilities: StoreAdapter['capabilities'] = {
    multiprocessWrite: false,
    nativeVectors: true,
    concurrentTransactions: false,
    fts5: true,
    fts: true,
    needsWriteSerialization: false,
    recursiveCte: true,
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

  // (A2 — FEAT-SOXGRAPH-001) Required StoreAdapter members. This double
  // RECORDS the FTS delegation calls memoryRecall issues (DEBT-SOXGRAPH-001)
  // and returns empty results — it never issues FTS SQL itself.
  async ftsSearch<T = Record<string, unknown>>(
    table: string,
    columns: string[],
    query: string,
    opts?: FtsSearchOptions,
  ): Promise<Array<T & { rowid: number; score: number }>> {
    this.ftsCalls.push({ table, columns, query, opts: { ...(opts ?? {}) } });
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

describe('memoryRecall — Defect 2: FTS channel delegates to store-adapter ftsSearch (dialect-aware SQL lives in store-adapter)', () => {
  beforeEach(() => {
    _setEmbedProviderForTest(new DeterministicTestProvider());
  });

  it('delegates the FTS channel to adapter.ftsSearch with the canonical node shape — no hand-assembled FTS SQL on either dialect', async () => {
    const configs: StoreAdapter['config'][] = [
      { type: 'sqlite', dbPath: '/tmp/does-not-matter.db' },
      { type: 'turso', url: 'libsql://does-not-matter' },
    ];
    for (const config of configs) {
      const adapter = new RecordingAdapter(config);
      await memoryRecall(adapter, 'project', { query: 'turso adapter', limit: 5 });

      // DEBT-SOXGRAPH-001 (the weave): memory-core must NOT assemble FTS SQL
      // above store-adapter. Neither the SQLite fts_node MATCH statement nor
      // the Turso Tantivy fts_match/fts_score functions may appear in
      // executeAll traffic. (The vec channel's `embedding MATCH ?` is a
      // different, sanctioned dialect call — not matched here.)
      const ftsSql = adapter.calls.filter((c) => /fts_match\(|fts_score\(|fts_node|\.rank\b/i.test(c.sql));
      expect(ftsSql).toEqual([]);

      // Exactly one delegation per recall, with the canonical shape: table
      // `node`, the same three indexed columns on BOTH dialects, the raw
      // query text, and the recall arm's predicate/params/limit.
      expect(adapter.ftsCalls.length).toBe(1);
      const call = adapter.ftsCalls[0]!;
      expect(call.table).toBe('node');
      expect(call.columns).toEqual(['content', 'name', 'summary']);
      // The raw query text is delegated; token normalization (trim → lowercase
      // → split → drop-empties) and the BL-367 `"t1" OR "t2"` match-query form
      // are store-adapter's contract now (pinned by store-adapter's
      // fts-ops.spec.ts), not recall.ts's.
      expect(call.query).toBe('turso adapter');
      expect(call.opts.limit).toBe(20); // DEFAULT_FTS_LIMIT (no filters active)
      // The `n.`-prefixed validity + kind predicates are passed through
      // verbatim — no alias-stripping, because store-adapter aliases the base
      // table `n` on BOTH backends.
      expect(call.opts.where).toContain('n.t_invalid IS NULL');
      expect(call.opts.where).toContain('n.kind IN (?)');
      expect(Array.isArray(call.opts.params)).toBe(true);
      expect(call.opts.params).toEqual(['episode']);
    }
  });
});
