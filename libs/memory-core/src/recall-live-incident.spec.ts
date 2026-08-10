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
 * Gate: npx nx test memory-core --skip-nx-cache (verified green against the
 *   built store-adapter dependency — the interim
 *   `--exclude-task-dependencies` note below was removed once store-adapter's
 *   build recovered on this branch; the suite runs with real dependencies).
 *   §3 exercises real sqlite + real turso.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter, AllResult, RunResult, FtsEnsureResult, FtsSearchOptions } from '@adhd/sox-store-adapter';
import type { EmbedRole } from '@adhd/sox-embedding-provider';
import { openDb, closeAllAdapters } from './db.js';
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

// ── §3: F1 (reviewer finding, fix/debt-soxgraph-001) — the delegated FTS
// where clause was built by TIGHT concatenation ────────────────────────────────
//
// `memoryRecall` with `agent_id` set MUST keep the FTS/BM25 channel alive on
// BOTH backends. Pre-fix, recall.ts:594 assembled the delegated FTS where as
// `${validityPred}${agentFilter}${filterSql}${kindClause}`. validityPred ends
// with `IS NULL` (no trailing space) while agentFilter starts with
// `AND n.agent_id = ...` (no leading space), producing
// `n.t_invalid IS NULLAND n.agent_id = '...'` — a syntax error on sqlite AND
// turso, swallowed by the BL-391 catch into `degradations.push('fts: ...')`,
// which silently zeroed the entire FTS channel for every agent-scoped recall.
// memory-server accepts top-level agent_id (index.ts:353,420,1244,1256) and
// BL-229 documents it as a HARD scope filter on every channel;
// memory-usage/SKILL.md instructs agents to pass it. No spec exercised
// agent-scoped FTS, so the suite stayed green.
//
// Fix: the FTS arm now joins the fragments with spaces exactly like the vec
// channel already did (`[validityPred, agentFilter, filterSql, kindClause]
// .filter(Boolean).join(' ')`, recall.ts:546). The as_of validity form
// (`)AND`) is lexically valid; the bug is specific to the default `IS NULL`
// predicate combined with a non-empty agentFilter.
//
// The `extensions.ts` entity arm (memory_search_entities) is NOT affected: its
// `where` is a single literal (`t_invalid IS NULL AND kind = 'entity'`,
// extensions.ts:1115) — no fragment concatenation.
//
// RED→GREEN (BL-225): pre-fix, both backends push `fts: near "n": syntax
// error` into degradations and every result's bm25 breakdown is 0 (the whole
// channel is dead). Post-fix, the agent-scoped rows are FTS-matched (bm25 > 0)
// with zero fts: degradations. Real sqlite + real turso, seeded exactly as
// debt-soxgraph-001.spec.ts seeds (raw node INSERT → FTS index synced by the
// table triggers), which is the proven-on-both-backends pattern on this
// branch.

// ── Turso availability — resolved SYNCHRONOUSLY at module load (same reason
// as debt-soxgraph-001.spec.ts / fts-query-parity.spec.ts: an async
// beforeAll + `{ skip }` option is evaluated before the flag is set and
// always skips).
const F1_TURSO_DRIVER_PATH = path.resolve(
  __dirname,
  '../../../node_modules/@tursodatabase/database/dist/promise.js',
);
const F1_HAS_TURSO = (() => {
  try {
    return fs.existsSync(F1_TURSO_DRIVER_PATH);
  } catch {
    return false;
  }
})();

const F1_BACKENDS = ['sqlite', 'turso'] as const;

describe('F1 — agent_id hard filter must not corrupt the FTS where clause (IS NULLAND concatenation)', () => {
  let dir: string | undefined;
  const priorAdapterEnv = process.env['STORE_ADAPTER'];

  afterEach(async () => {
    await closeAllAdapters();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
    else process.env['STORE_ADAPTER'] = priorAdapterEnv;
  });

  /** Raw node INSERT (agent-scoped) — the debt-soxgraph-001.spec.ts seeding
   *  pattern: the FTS index syncs via the table triggers on BOTH backends,
   *  and vec_node intentionally stays empty so this test isolates the FTS
   *  channel (the only arm F1 broke). */
  const seedAgentEpisode = async (
    adapter: StoreAdapter,
    row: { uid: string; content: string; agent_id: string },
  ): Promise<void> => {
    await adapter.executeRun(
      `INSERT INTO node (uid, kind, name, content, summary, content_hash, importance, agent_id, t_created, t_valid)
       VALUES (?, 'episode', ?, ?, NULL, ?, 1, ?, datetime('now'), datetime('now'))`,
      [row.uid, `seed-${row.uid}`, row.content, `hash-${row.uid}`, row.agent_id],
    );
  };

  const ftsDegradations = (d: string[] | undefined): string[] =>
    (d ?? []).filter((x) => x.startsWith('fts:'));

  for (const backend of F1_BACKENDS) {
    const itB = backend === 'turso' ? (F1_HAS_TURSO ? it : it.skip) : it;

    itB('agent-scoped recall returns FTS matches with NO fts: degradation, and agent_id is a hard filter', async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), `f1-agent-fts-${backend}-`));
      process.env['STORE_ADAPTER'] = backend;
      const adapter = await openDb(path.join(dir, 'm.db'));
      expect(adapter.config.type).toBe(backend);

      // agent-x owns two query-relevant episodes; agent-y owns one carrying
      // the SAME tokens — the hard agent filter must admit x and exclude y.
      await seedAgentEpisode(adapter, {
        uid: 'x1',
        content: 'widget alpha assembly procedure calibration notes',
        agent_id: 'agent-x',
      });
      await seedAgentEpisode(adapter, {
        uid: 'x2',
        content: 'widget beta calibration sequence alpha verified',
        agent_id: 'agent-x',
      });
      await seedAgentEpisode(adapter, {
        uid: 'y1',
        content: 'widget alpha assembly calibration procedure second pass',
        agent_id: 'agent-y',
      });

      const response = await memoryRecall(adapter, 'project', {
        query: 'widget alpha',
        agent_id: 'agent-x',
        limit: 10,
        depth: 0,
      });

      // 1. Non-empty and STRICTLY agent-scoped — the hard filter works, and
      //    the agent-y row (same tokens) never leaks in.
      expect(response.results.length).toBeGreaterThan(0);
      expect(response.results.every((r) => r.agent_id === 'agent-x')).toBe(true);
      expect(response.results.some((r) => r.uid === 'y1')).toBe(false);

      // 2. BL-391: NO fts: degradation. Pre-fix the syntax error was swallowed
      //    into degradations here, zeroing the entire FTS channel.
      expect(ftsDegradations(response.degradations)).toEqual([]);

      // 3. The FTS channel actually CONTRIBUTED: at least the top BM25-ranked
      //    result carries bm25 > 0 (min-max normalisation makes the channel's
      //    max candidate 1.0 and its min candidate 0.0, so `some` is the
      //    channel-alive signal). Pre-fix this is 0 for every result.
      expect(response.results.some((r) => r.score_breakdown.bm25 > 0)).toBe(true);
    }, 60_000);

    itB('companion: agent-scoped recall with NO matches returns empty with NO fts: degradation — empty is genuine, not a masked syntax error', async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), `f1-agent-empty-${backend}-`));
      process.env['STORE_ADAPTER'] = backend;
      const adapter = await openDb(path.join(dir, 'm.db'));
      expect(adapter.config.type).toBe(backend);

      await seedAgentEpisode(adapter, {
        uid: 'x1',
        content: 'widget alpha assembly procedure calibration notes',
        agent_id: 'agent-x',
      });

      // agent-z owns nothing — every channel filters to zero candidates.
      const response = await memoryRecall(adapter, 'project', {
        query: 'widget alpha',
        agent_id: 'agent-z',
        limit: 10,
        depth: 0,
      });

      expect(response.results).toHaveLength(0);
      expect(ftsDegradations(response.degradations)).toEqual([]);
    }, 60_000);
  }
});
