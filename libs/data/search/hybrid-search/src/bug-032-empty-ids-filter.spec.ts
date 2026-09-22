/**
 * bug-032-empty-ids-filter.spec.ts — BUG-032 / ADR-0017.
 *
 * The reported repro: `searchRanked({filters:{kind:'issue', ids:[]}})` returned
 * the one issue on a single-issue store instead of ZERO. The chain was
 * graph-store dropping the empty `ids` as "no filter", so hybrid-search's
 * `matchingIds.length === 0` guard could never fire.
 *
 * This file pins BOTH halves:
 *
 *  A. End-to-end against the REAL graph-store + vector-store (the consumer
 *     path) — present-but-empty `ids` yields zero results.
 *
 *  B. The hybrid-search LAYER's own guarantee, independent of whether the
 *     graph backend honors the invariant: a graph backend that (like the
 *     pre-fix graph-store) drops a present-but-empty `ids` must NOT widen the
 *     ranker into an unfiltered scan. This is the "at every layer" clause of
 *     ADR-0017, and it is the assertion with teeth for the hybrid-search
 *     hardening — it fails if the short-circuit is removed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { StoreGraphBackend } from '@adhd/sox-graph-store';
import type { GraphBackend, NodeFilter } from '@adhd/sox-graph-store';
import { SqliteVectorBackend } from '@adhd/sox-vector-store';
import type { VectorBackend } from '@adhd/sox-vector-store';
import { createSqliteAdapter } from '@adhd/sox-store-adapter';
import { StoreSearchBackend } from './index.js';

/** Strip a present-but-empty `ids` exactly as the pre-fix graph-store did. */
function dropEmptyIds(filter: NodeFilter | undefined): NodeFilter | undefined {
  if (!filter || filter.ids === undefined || filter.ids.length > 0) return filter;
  const { ids: _dropped, ...rest } = filter;
  return rest;
}

/**
 * A graph backend that violates the empty-ids clause by delegating with the
 * empty `ids` removed. Every other method is passed straight through.
 */
function nonConformingGraph(inner: GraphBackend): GraphBackend {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'queryNodes') {
        return (filter?: NodeFilter) => target.queryNodes(dropEmptyIds(filter));
      }
      if (prop === 'searchNodes') {
        return (
          query: string,
          opts?: { limit?: number; offset?: number; filter?: NodeFilter },
        ) => {
          const next: { limit?: number; offset?: number; filter?: NodeFilter } = {};
          if (opts?.limit !== undefined) next.limit = opts.limit;
          if (opts?.offset !== undefined) next.offset = opts.offset;
          const filter = dropEmptyIds(opts?.filter);
          if (filter !== undefined) next.filter = filter;
          return target.searchNodes(query, next);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as GraphBackend;
}

function createDb(): Database.Database {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  return db;
}

describe('BUG-032 — StoreSearchBackend: present-but-empty filters.ids matches nothing', () => {
  let db: Database.Database;
  let vec: VectorBackend;
  let graph: GraphBackend;
  let backend: StoreSearchBackend;

  beforeEach(async () => {
    db = createDb();
    vec = new SqliteVectorBackend(createSqliteAdapter(db));
    vec.ensureSpace({ modelId: 'test-model', dim: 4 });
    graph = new StoreGraphBackend(createSqliteAdapter(db));
    await graph.applySchema();
    backend = new StoreSearchBackend(vec, graph);
  });

  async function seedIssue(): Promise<number> {
    const id = await graph.writeNode('the single issue body', { kind: 'generic', name: 'the issue' });
    vec.upsert(id, new Float32Array([1.0, 0.0, 0.0, 0.0]), { modelId: 'test-model', dim: 4 });
    return id;
  }

  // ── A. real end-to-end consumer path ──────────────────────────────────────

  it('searchRanked: filters.ids=[] returns ZERO (the reported repro)', async () => {
    await seedIssue();
    const results = await backend.searchRanked(
      { text: 'issue', filters: { kind: 'generic', ids: [] } },
      10,
    );
    expect(results).toEqual([]);
  });

  it('searchRanked: filters.ids=[] on the vec channel returns ZERO', async () => {
    await seedIssue();
    const results = await backend.searchRanked(
      { vec: new Float32Array([1.0, 0.0, 0.0, 0.0]), filters: { kind: 'generic', ids: [] } },
      10,
    );
    expect(results).toEqual([]);
  });

  it('search (2-signal): filters.ids=[] returns ZERO', async () => {
    await seedIssue();
    const results = await backend.search(
      {
        text: 'issue',
        vec: new Float32Array([1.0, 0.0, 0.0, 0.0]),
        filters: { kind: 'generic', ids: [] },
      },
      10,
    );
    expect(results).toEqual([]);
  });

  it('ids:[<absent>] stays ZERO; absent ids stays unfiltered', async () => {
    const id = await seedIssue();
    const absent = await backend.searchRanked({ text: 'issue', filters: { ids: [id + 9999] } }, 10);
    expect(absent).toEqual([]);

    const unfiltered = await backend.searchRanked({ text: 'issue' }, 10);
    expect(unfiltered.map((r) => r.id)).toEqual([id]);
  });

  // ── B. the layer's own guarantee (hardening) ──────────────────────────────

  describe('independent of the graph backend (ADR-0017 "at every layer")', () => {
    it('searchRanked returns ZERO even when the graph backend drops a present-but-empty ids', async () => {
      await seedIssue();
      const hardened = new StoreSearchBackend(vec, nonConformingGraph(graph));

      const results = await hardened.searchRanked(
        { text: 'issue', filters: { kind: 'generic', ids: [] } },
        10,
      );
      expect(results).toEqual([]);
    });

    it('search (2-signal) returns ZERO even when the graph backend drops a present-but-empty ids', async () => {
      await seedIssue();
      const hardened = new StoreSearchBackend(vec, nonConformingGraph(graph));

      const results = await hardened.search(
        {
          text: 'issue',
          vec: new Float32Array([1.0, 0.0, 0.0, 0.0]),
          filters: { kind: 'generic', ids: [] },
        },
        10,
      );
      expect(results).toEqual([]);
    });

    it('the non-conforming wrapper is not itself vacuously empty — a real filter still finds the node', async () => {
      const id = await seedIssue();
      const hardened = new StoreSearchBackend(vec, nonConformingGraph(graph));

      const results = await hardened.searchRanked({ text: 'issue', filters: { kind: 'generic' } }, 10);
      expect(results.map((r) => r.id)).toEqual([id]);
    });
  });
});
