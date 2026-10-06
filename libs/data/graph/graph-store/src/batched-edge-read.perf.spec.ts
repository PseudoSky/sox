/**
 * batched-edge-read.perf.spec.ts — ticket 89cc3a30 (spec
 * docs/spec/graph-store-batched-edge-read.md): the bounded, page-keyed edge
 * read `getEdges({ srcs, dsts, rels })`.
 *
 * Real store, real SQLite (SqliteAdapterImpl) — nothing under test is mocked.
 * The only instrumentation is a pass-through spy on `adapter.executeAll` that
 * records the statement, its bound args and the number of rows it fetched.
 *
 * Every `it` name carries `89cc3a30 AC-<n>`.
 *
 * Teeth (spec §5 negative control): `src/index.ts`'s batch branch was swapped
 * for a whole-relation `SELECT ... WHERE rel = ?` + in-memory `srcs` filter
 * (the pre-fix shape). That variant returns the CORRECT rows but fetches the
 * whole relation, so the AC-1 fetched-row bound and the AC-2 plan assertion go
 * red while the pure-result assertions stay green — proving the benchmark
 * detects exactly the regression e54afd3f describes. The run is recorded in
 * the dispatch return block; the variant is never left in the tree.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAdapterImpl } from '@adhd/sox-store-adapter';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { createGraphBackend, ConstraintError, EDGE_READ_CHUNK, EDGE_READ_MAX_RELS } from './index.js';
import type { GraphBackend, EdgeRecord, TypePolicy } from './index.js';

const permissivePolicy: TypePolicy = { validateKind() {}, validateRel() {} };

interface ISpyCall { sql: string; args: unknown[]; rows: number }

/** Pass-through spy on `executeAll`: records every statement + fetched row count. */
function spyOn(adapter: StoreAdapter): { calls: ISpyCall[]; reset(): void; restore(): void } {
  const calls: ISpyCall[] = [];
  const original = adapter.executeAll.bind(adapter);
  (adapter as { executeAll: unknown }).executeAll = async (sql: string, args?: unknown[]) => {
    const res = await original(sql, args);
    calls.push({ sql, args: args ?? [], rows: (res as { rows: unknown[] }).rows.length });
    return res;
  };
  return {
    calls,
    reset: () => { calls.length = 0; },
    restore: () => { (adapter as { executeAll: unknown }).executeAll = original; },
  };
}

const edgeSelects = (calls: ISpyCall[]): ISpyCall[] => calls.filter((c) => /FROM edge\b/.test(c.sql) && !/^EXPLAIN/i.test(c.sql));

async function plan(adapter: StoreAdapter, c: ISpyCall): Promise<string> {
  const res = await adapter.executeAll<{ detail: string }>(`EXPLAIN QUERY PLAN ${c.sql}`, c.args);
  return res.rows.map((r) => r.detail).join(' | ');
}

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), 'batched-edge-read-'));
  dirs.push(d);
  return join(d, 'store.db');
}

// ── Large store: >= 10 000 live edges in ONE relation ────────────────────────

const N_EDGES = 10_000;
let big: { adapter: StoreAdapter; backend: GraphBackend };

beforeAll(async () => {
  const adapter = new SqliteAdapterImpl(tmpDb());
  const backend = createGraphBackend(adapter, { typePolicy: permissivePolicy });
  await backend.applySchema();
  const now = new Date().toISOString();
  const nodes: { sql: string; args: unknown[] }[] = [];
  for (let i = 0; i <= N_EDGES; i++) {
    nodes.push({ sql: `INSERT INTO node (uid, kind, content, t_created) VALUES (?, 'issue', ?, ?)`, args: [`n-${i}`, `n ${i}`, now] });
  }
  await adapter.executeMany(nodes);
  // One relation, degree 1 out / 1 in: node i -> node i+1 (rowids are 1..N+1).
  const edges: { sql: string; args: unknown[] }[] = [];
  for (let i = 1; i <= N_EDGES; i++) {
    edges.push({ sql: `INSERT INTO edge (src, dst, rel, t_created) VALUES (?, ?, 'RELATES_TO', ?)`, args: [i, i + 1, now] });
  }
  await adapter.executeMany(edges);
  await adapter.executeRun('ANALYZE');
  big = { adapter, backend };
}, 120_000);

afterAll(async () => { await big?.adapter.close(); });

describe('89cc3a30 AC-1 — large-store / small-page row bound', () => {
  for (const pageSize of [1, 20]) {
    it(`89cc3a30 AC-1: page of ${pageSize} on a ${N_EDGES}-edge relation returns and fetches O(page) rows, < rows_old/100`, async () => {
      const spy = spyOn(big.adapter);
      try {
        const page = Array.from({ length: pageSize }, (_, i) => 5_000 + i * 7);

        spy.reset();
        const old = await big.backend.getEdges({ rel: 'RELATES_TO' });
        const rowsOld = edgeSelects(spy.calls).reduce((n, c) => n + c.rows, 0);
        expect(old.length).toBe(N_EDGES);
        expect(rowsOld).toBe(N_EDGES);

        spy.reset();
        const got = await big.backend.getEdges({ srcs: page });
        const fetched = edgeSelects(spy.calls).reduce((n, c) => n + c.rows, 0);

        // Returned rows are exactly the page's outgoing edges (degree 1 each).
        expect(got.map((e) => [e.src, e.dst])).toEqual(page.map((s) => [s, s + 1]));
        // Adapter-level fetched rows: the DB handed back only those rows.
        expect(fetched).toBe(pageSize);
        // Headline bound.
        expect(fetched).toBeLessThan(rowsOld / 100);

        // Incoming direction is bounded identically.
        spy.reset();
        const inc = await big.backend.getEdges({ dsts: page, rels: ['RELATES_TO'] });
        expect(inc.length).toBe(pageSize);
        expect(edgeSelects(spy.calls).reduce((n, c) => n + c.rows, 0)).toBe(pageSize);
        expect(edgeSelects(spy.calls).reduce((n, c) => n + c.rows, 0)).toBeLessThan(rowsOld / 100);
      } finally {
        spy.restore();
      }
    });
  }
});

describe('89cc3a30 AC-2 — index plan, never a table scan', () => {
  it('89cc3a30 AC-2: srcs uses SEARCH ... ix_edge_src_live; dsts uses SEARCH ... ix_edge_dst_live; neither SCANs edge', async () => {
    const spy = spyOn(big.adapter);
    try {
      spy.reset();
      await big.backend.getEdges({ srcs: [10, 20, 30] });
      const srcCall = edgeSelects(spy.calls)[0]!;
      const srcPlan = await plan(big.adapter, srcCall);
      expect(srcPlan).toMatch(/SEARCH\b.*\bix_edge_src_live\b/);
      expect(srcPlan).not.toMatch(/SCAN edge/);

      spy.reset();
      await big.backend.getEdges({ dsts: [10, 20, 30], rels: ['RELATES_TO'] });
      const dstCall = edgeSelects(spy.calls)[0]!;
      const dstPlan = await plan(big.adapter, dstCall);
      expect(dstPlan).toMatch(/SEARCH\b.*\bix_edge_dst_live\b/);
      expect(dstPlan).not.toMatch(/SCAN edge/);
    } finally {
      spy.restore();
    }
  });
});

describe('89cc3a30 AC-8 — parameter chunking', () => {
  it('89cc3a30 AC-8: a 5000-id srcs list (unsorted, with duplicates) returns the identical set and order, chunked, no variable-limit error', async () => {
    const ids = Array.from({ length: 5_000 }, (_, i) => i + 1);
    const shuffled = [...ids].reverse().concat(ids.slice(0, 50)); // reversed + duplicates
    const spy = spyOn(big.adapter);
    try {
      spy.reset();
      const got = await big.backend.getEdges({ srcs: shuffled });
      const calls = edgeSelects(spy.calls);
      // Ground truth straight from SQL, independent of the code under test.
      const { rows } = await big.adapter.executeAll<{ src: number; dst: number }>(
        `SELECT src, dst FROM edge WHERE t_invalid IS NULL AND src <= 5000 ORDER BY src, rel, rowid`,
      );
      expect(got.map((e) => [e.src, e.dst])).toEqual(rows.map((r) => [r.src, r.dst]));
      expect(got.length).toBe(5_000);
      // Chunked: ceil(5000/EDGE_READ_CHUNK) statements, each within the bound.
      expect(calls.length).toBe(Math.ceil(5_000 / EDGE_READ_CHUNK));
      for (const c of calls) expect(c.args.length).toBeLessThanOrEqual(EDGE_READ_CHUNK);
    } finally {
      spy.restore();
    }
  });

  it('89cc3a30 AC-8: chunk boundary — exactly EDGE_READ_CHUNK ids is one statement, EDGE_READ_CHUNK+1 is two, same rows', async () => {
    const spy = spyOn(big.adapter);
    try {
      for (const [n, stmts] of [[EDGE_READ_CHUNK, 1], [EDGE_READ_CHUNK + 1, 2]] as const) {
        spy.reset();
        const got = await big.backend.getEdges({ srcs: Array.from({ length: n }, (_, i) => i + 1) });
        expect(got.length).toBe(n);
        expect(got.map((e) => e.src)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
        expect(edgeSelects(spy.calls).length).toBe(stmts);
      }
    } finally {
      spy.restore();
    }
  });
});

// ── Small mixed corpus: differential equality, bi-temporal, back-compat ──────

async function freshBackend(): Promise<{ adapter: StoreAdapter; backend: GraphBackend; ids: number[] }> {
  const adapter = new SqliteAdapterImpl(':memory:');
  const backend = createGraphBackend(adapter, { typePolicy: permissivePolicy });
  await backend.applySchema();
  const ids: number[] = [];
  for (let i = 0; i < 24; i++) ids.push(await backend.writeNode(`node ${i}`, { kind: 'issue', name: `n${i}` }));
  return { adapter, backend, ids };
}

/** Deterministic PRNG (mulberry32) so the corpus is reproducible. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RELS = ['RELATES_TO', 'PART_OF', 'BLOCKS'] as const;

/** Mixed corpus: edges inserted in shuffled (src,dst,rel) order so rowid order != key order; some invalidated. */
async function seedMixed(backend: GraphBackend, ids: number[]): Promise<void> {
  const rnd = prng(0xc0ffee);
  const triples: Array<[number, number, string]> = [];
  for (const s of ids) for (const d of ids) {
    if (s !== d && rnd() < 0.18) triples.push([s, d, RELS[Math.floor(rnd() * RELS.length)]!]);
  }
  for (let i = triples.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [triples[i], triples[j]] = [triples[j]!, triples[i]!];
  }
  for (const [s, d, r] of triples) await backend.writeEdge(s, d, r);
  // Invalidate ~10% so the t_invalid filter has something to exclude.
  for (const [s, d, r] of triples.filter(() => rnd() < 0.1)) await backend.invalidateEdge(s, d, r, 'seed');
}

const key = (e: EdgeRecord): string => `${e.src}>${e.dst}:${e.rel}`;

describe('89cc3a30 AC-3 — ordering determinism / differential equality', () => {
  it('89cc3a30 AC-3: for every sampled page (and rels subset), srcs/dsts output deep-equals the concatenated single-key reads', async () => {
    const { backend, ids } = await freshBackend();
    await seedMixed(backend, ids);
    const rnd = prng(42);
    for (let trial = 0; trial < 40; trial++) {
      const page = ids.filter(() => rnd() < 0.3);
      const rels = rnd() < 0.5 ? undefined : RELS.filter(() => rnd() < 0.6);
      const sorted = [...page].sort((a, b) => a - b);
      const keep = (e: EdgeRecord): boolean => rels === undefined || (rels as readonly string[]).includes(e.rel);

      const expectedOut: EdgeRecord[] = [];
      for (const x of sorted) expectedOut.push(...(await backend.getEdges({ src: x })).filter(keep));
      const gotOut = await backend.getEdges({ srcs: page, ...(rels ? { rels } : {}) });
      expect(gotOut).toEqual(expectedOut);

      const expectedIn: EdgeRecord[] = [];
      for (const x of sorted) expectedIn.push(...(await backend.getEdges({ dst: x })).filter(keep));
      const gotIn = await backend.getEdges({ dsts: page, ...(rels ? { rels } : {}) });
      expect(gotIn).toEqual(expectedIn);
    }
  });

  it('89cc3a30 AC-3: order is pinned (src,rel,rowid) / (dst,rel,rowid) independent of insertion order', async () => {
    const { backend, ids } = await freshBackend();
    const [a, b, c, d] = ids as [number, number, number, number];
    // Insert deliberately against key order.
    await backend.writeEdge(b, d, 'RELATES_TO');
    await backend.writeEdge(a, d, 'PART_OF');
    await backend.writeEdge(a, c, 'RELATES_TO');
    await backend.writeEdge(a, b, 'PART_OF');
    await backend.writeEdge(b, c, 'BLOCKS');
    const out = await backend.getEdges({ srcs: [b, a] });
    // src asc; within src rel asc ('PART_OF' < 'RELATES_TO'); within rel rowid asc.
    expect(out.map(key)).toEqual([
      `${a}>${d}:PART_OF`, `${a}>${b}:PART_OF`, `${a}>${c}:RELATES_TO`,
      `${b}>${c}:BLOCKS`, `${b}>${d}:RELATES_TO`,
    ]);
    const inc = await backend.getEdges({ dsts: [d, c] });
    expect(inc.map(key)).toEqual([
      `${b}>${c}:BLOCKS`, `${a}>${c}:RELATES_TO`, // dst c: BLOCKS < RELATES_TO
      `${a}>${d}:PART_OF`, `${b}>${d}:RELATES_TO`,
    ]);
  });

  it('89cc3a30 AC-3: srcs AND dsts is the intersection', async () => {
    const { backend, ids } = await freshBackend();
    const [a, b, c] = ids as [number, number, number];
    await backend.writeEdge(a, b, 'RELATES_TO');
    await backend.writeEdge(a, c, 'RELATES_TO');
    await backend.writeEdge(b, c, 'RELATES_TO');
    const out = await backend.getEdges({ srcs: [a, b], dsts: [c] });
    expect(out.map(key).sort()).toEqual([`${a}>${c}:RELATES_TO`, `${b}>${c}:RELATES_TO`].sort());
  });
});

describe('89cc3a30 AC-4 — bi-temporal correctness', () => {
  it('89cc3a30 AC-4: invalidated edges are absent, including inside the same transaction; rollback restores them', async () => {
    const { backend, ids } = await freshBackend();
    const [a, b, c] = ids as [number, number, number];
    await backend.writeEdge(a, b, 'RELATES_TO');
    await backend.writeEdge(a, c, 'RELATES_TO');

    await backend.transaction(async (tx) => {
      expect((await tx.getEdges({ srcs: [a] })).length).toBe(2);
      await tx.invalidateEdge(a, b, 'RELATES_TO', 'gone');
      expect((await tx.getEdges({ srcs: [a] })).map(key)).toEqual([`${a}>${c}:RELATES_TO`]);
      expect((await tx.getEdges({ dsts: [b] })).length).toBe(0);
      // tx-scoped visibility of an uncommitted WRITE in the batch form.
      await tx.writeEdge(c, a, 'PART_OF');
      expect((await tx.getEdges({ srcs: [c], rels: ['PART_OF'] })).map(key)).toEqual([`${c}>${a}:PART_OF`]);
    });
    expect((await backend.getEdges({ srcs: [a] })).map(key)).toEqual([`${a}>${c}:RELATES_TO`]);

    await expect(backend.transaction(async (tx) => {
      await tx.invalidateEdge(a, c, 'RELATES_TO', 'rolled back');
      expect((await tx.getEdges({ srcs: [a] })).length).toBe(0);
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect((await backend.getEdges({ srcs: [a] })).length).toBe(1);
  });
});

describe('89cc3a30 AC-5 — concurrency (ADR-0012): plain snapshot SELECT, no lock, no E_BUSY', () => {
  it('89cc3a30 AC-5: a reader on a second connection is not blocked by an open invalidating writer and sees an all-or-nothing snapshot', async () => {
    const dbPath = tmpDb();
    const adapterA = new SqliteAdapterImpl(dbPath);
    const reader = createGraphBackend(adapterA, { typePolicy: permissivePolicy });
    await reader.applySchema();
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) ids.push(await reader.writeNode(`c${i}`, { kind: 'issue', name: `c${i}` }));
    const [hub, ...spokes] = ids as [number, ...number[]];
    for (const s of spokes) await reader.writeEdge(hub, s, 'RELATES_TO');

    const adapterB = new SqliteAdapterImpl(dbPath);
    await adapterB.pragmaSet('busy_timeout', 0); // any lock contention fails FAST (no sleep-based proof)
    const writer = createGraphBackend(adapterB, { typePolicy: permissivePolicy });
    const adapterR = new SqliteAdapterImpl(dbPath);
    await adapterR.pragmaSet('busy_timeout', 0);
    const reader2 = createGraphBackend(adapterR, { typePolicy: permissivePolicy });

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let invalidated!: () => void;
    const midTx = new Promise<void>((r) => { invalidated = r; });

    const write = writer.transaction(async (tx) => {
      for (const s of spokes) await tx.invalidateEdge(hub, s, 'RELATES_TO', 'concurrent');
      invalidated();
      await gate; // hold the write transaction open, uncommitted
    });
    try {
      await midTx;
      // Writer holds an open, uncommitted invalidating tx. The reader must neither block nor E_BUSY,
      // and must see the pre-commit snapshot in full (never a torn subset).
      const during = await reader2.getEdges({ srcs: [hub] });
      expect(during.length).toBe(spokes.length);
    } finally {
      release();
      await write;
    }
    const after = await reader2.getEdges({ srcs: [hub] });
    expect(after.length).toBe(0);
    await adapterA.close(); await adapterB.close(); await adapterR.close();
  });
});

describe('89cc3a30 AC-6 — back-compat of the existing getEdges forms', () => {
  it('89cc3a30 AC-6: {src} / {dst} / {rel} / {} / {src,dst,rel} are unchanged and still a single un-ORDERed statement', async () => {
    const { adapter, backend, ids } = await freshBackend();
    await seedMixed(backend, ids);
    const spy = spyOn(adapter);
    try {
      const forms: Array<[Parameters<GraphBackend['getEdges']>[0], string, unknown[]]> = [
        [{ src: ids[3]! }, 'src = ?', [ids[3]!]],
        [{ dst: ids[5]! }, 'dst = ?', [ids[5]!]],
        [{ rel: 'PART_OF' }, 'rel = ?', ['PART_OF']],
        [{}, '', []],
      ];
      for (const [opts, frag, args] of forms) {
        spy.reset();
        const got = await backend.getEdges(opts);
        const [call] = edgeSelects(spy.calls);
        expect(edgeSelects(spy.calls).length).toBe(1);
        expect(call!.sql).not.toMatch(/ORDER BY/i);
        expect(call!.sql).not.toMatch(/\bIN \(/);
        expect(call!.sql).toContain(`t_invalid IS NULL${frag ? ` AND ${frag}` : ''}`);
        expect(call!.args).toEqual(args);
        expect(got.length).toBe(call!.rows);
      }
    } finally {
      spy.restore();
    }
  });

  it('89cc3a30 AC-6: singular and plural on the same axis is a ConstraintError (no ambiguous union/intersect)', async () => {
    const { backend, ids } = await freshBackend();
    await expect(backend.getEdges({ src: ids[0]!, srcs: [ids[1]!] })).rejects.toBeInstanceOf(ConstraintError);
    await expect(backend.getEdges({ dst: ids[0]!, dsts: [ids[1]!] })).rejects.toBeInstanceOf(ConstraintError);
    await expect(backend.getEdges({ rel: 'PART_OF', rels: ['PART_OF'] })).rejects.toBeInstanceOf(ConstraintError);
  });
});

describe('89cc3a30 AC-7 — empty lists execute zero SQL', () => {
  it('89cc3a30 AC-7: srcs:[] / dsts:[] / rels:[] (alone and combined with a non-empty sibling) return [] with zero statements', async () => {
    const { adapter, backend, ids } = await freshBackend();
    await backend.writeEdge(ids[0]!, ids[1]!, 'RELATES_TO');
    const spy = spyOn(adapter);
    try {
      spy.reset();
      expect(await backend.getEdges({ srcs: [] })).toEqual([]);
      expect(await backend.getEdges({ dsts: [] })).toEqual([]);
      expect(await backend.getEdges({ rels: [] })).toEqual([]);
      expect(await backend.getEdges({ srcs: [ids[0]!], rels: [] })).toEqual([]);
      expect(await backend.getEdges({ srcs: [], dsts: [ids[1]!] })).toEqual([]);
      expect(await backend.getEdges({ src: ids[0]!, rels: [] })).toEqual([]);
      expect(spy.calls.length).toBe(0);
      // tx-scoped form too.
      await backend.transaction(async (tx) => {
        expect(await tx.getEdges({ srcs: [] })).toEqual([]);
      });
      expect(edgeSelects(spy.calls).length).toBe(0);
    } finally {
      spy.restore();
    }
  });
});

afterEach(() => { /* spies restore in finally blocks */ });

// ── 89cc3a30 AC-9..AC-12 — bind budget, linear srcs x dsts, id validation ────

const range = (from: number, n: number): number[] => Array.from({ length: n }, (_, i) => from + i);

describe('89cc3a30 AC-9 — srcs+dsts binds at most EDGE_READ_CHUNK variables per statement', () => {
  it('89cc3a30 AC-9: 500 srcs + 500 dsts: every statement binds <= EDGE_READ_CHUNK params and the intersection is exact', async () => {
    const spy = spyOn(big.adapter);
    try {
      spy.reset();
      const got = await big.backend.getEdges({ srcs: range(1, 500), dsts: range(2, 500) });
      const calls = edgeSelects(spy.calls);
      expect(got.map((e) => [e.src, e.dst])).toEqual(range(1, 500).map((i) => [i, i + 1]));
      expect(calls.length).toBeGreaterThan(0);
      expect(Math.max(...calls.map((c) => c.args.length))).toBeLessThanOrEqual(EDGE_READ_CHUNK);
    } finally {
      spy.restore();
    }
  });

  it('89cc3a30 AC-9: a small dsts list rides as a bounded IN; total params (srcs+dsts+rels) still <= EDGE_READ_CHUNK', async () => {
    const spy = spyOn(big.adapter);
    try {
      spy.reset();
      const got = await big.backend.getEdges({ srcs: range(1, 1200), dsts: range(2, 100), rels: ['RELATES_TO', 'PART_OF'] });
      const calls = edgeSelects(spy.calls);
      expect(got.map((e) => [e.src, e.dst])).toEqual(range(1, 100).map((i) => [i, i + 1]));
      expect(Math.max(...calls.map((c) => c.args.length))).toBeLessThanOrEqual(EDGE_READ_CHUNK);
    } finally {
      spy.restore();
    }
  });
});

describe('89cc3a30 AC-10 — rels is inside the same bind budget', () => {
  it('89cc3a30 AC-10: more than EDGE_READ_MAX_RELS distinct rels is a ConstraintError with zero statements', async () => {
    const spy = spyOn(big.adapter);
    try {
      spy.reset();
      const rels = range(0, EDGE_READ_MAX_RELS + 1).map((i) => `REL_${i}`);
      await expect(big.backend.getEdges({ srcs: [1], rels })).rejects.toBeInstanceOf(ConstraintError);
      expect(edgeSelects(spy.calls).length).toBe(0);
    } finally {
      spy.restore();
    }
  });

  it('89cc3a30 AC-10: EDGE_READ_MAX_RELS rels (duplicates collapsed) + 5000 srcs: every statement <= EDGE_READ_CHUNK params, rows exact', async () => {
    const spy = spyOn(big.adapter);
    try {
      spy.reset();
      const rels = [...range(0, EDGE_READ_MAX_RELS - 1).map((i) => `REL_${i}`), 'RELATES_TO'];
      const got = await big.backend.getEdges({ srcs: range(1, 5000), rels: [...rels, ...rels] });
      const calls = edgeSelects(spy.calls);
      expect(got.map((e) => e.src)).toEqual(range(1, 5000));
      expect(Math.max(...calls.map((c) => c.args.length))).toBeLessThanOrEqual(EDGE_READ_CHUNK);
      expect(calls.length).toBe(Math.ceil(5000 / (EDGE_READ_CHUNK - EDGE_READ_MAX_RELS)));
    } finally {
      spy.restore();
    }
  });
});

describe('89cc3a30 AC-11 — srcs x dsts is linear in the list sizes, not quadratic', () => {
  it('89cc3a30 AC-11: 5000 srcs x 5000 dsts: statement count is linear (<= 2*ceil(n/EDGE_READ_CHUNK)), rows equal the SQL ground truth in (src,rel,rowid) order', async () => {
    const n = 5_000;
    const spy = spyOn(big.adapter);
    try {
      spy.reset();
      const got = await big.backend.getEdges({ srcs: range(1, n), dsts: range(2, n) });
      const calls = edgeSelects(spy.calls);
      const { rows } = await big.adapter.executeAll<{ src: number; dst: number }>(
        `SELECT src, dst FROM edge WHERE t_invalid IS NULL AND src BETWEEN 1 AND ${n} AND dst BETWEEN 2 AND ${n + 1} ORDER BY src, rel, rowid`,
      );
      expect(got.map((e) => [e.src, e.dst])).toEqual(rows.map((r) => [r.src, r.dst]));
      expect(got.length).toBe(n);
      const chunks = Math.ceil(n / EDGE_READ_CHUNK);
      expect(calls.length).toBeLessThanOrEqual(2 * chunks); // chunk^2 would be 100
      for (const c of calls) expect(c.args.length).toBeLessThanOrEqual(EDGE_READ_CHUNK);
    } finally {
      spy.restore();
    }
  });

  it('89cc3a30 AC-11: differential — srcs+dsts equals the single-key reads filtered, on both the bounded-IN and JS-filter paths', async () => {
    const { backend, ids } = await freshBackend();
    await seedMixed(backend, ids);
    const rnd = prng(7);
    for (let trial = 0; trial < 30; trial++) {
      const s = ids.filter(() => rnd() < 0.5);
      const d = ids.filter(() => rnd() < 0.5);
      const dSet = new Set(d);
      const expected: EdgeRecord[] = [];
      for (const x of [...s].sort((a, b) => a - b)) expected.push(...(await backend.getEdges({ src: x })).filter((e) => dSet.has(e.dst)));
      expect(await backend.getEdges({ srcs: s, dsts: d })).toEqual(expected);
    }
  });

  it('89cc3a30 AC-14: JS-filter path (dsts > floor(avail/2)) on a mixed corpus deep-equals the single-key ground truth, same order, and the dsts IN-list is NOT in the SQL', async () => {
    const { adapter, backend, ids } = await freshBackend();
    await seedMixed(backend, ids); // mixed rels, ~10% invalidated edges
    const spy = spyOn(adapter);
    try {
      const rnd = prng(14);
      // Real dsts (a strict subset, so the Set filter has rows to drop) padded with
      // valid-but-non-existent ids so |dsts| exceeds the threshold.
      const realDsts = ids.filter(() => rnd() < 0.5);
      const pad = (n: number): number[] => range(1_000_000, n);
      const cases: Array<{ label: string; rels?: string[]; padTo: number }> = [
        { label: 'no filters: |dsts| = floor(500/2)+1', padTo: Math.floor(EDGE_READ_CHUNK / 2) + 1 },
        { label: 'rels filter (2 binds): |dsts| = floor(498/2)+1', rels: ['RELATES_TO', 'BLOCKS'], padTo: Math.floor((EDGE_READ_CHUNK - 2) / 2) + 1 },
        { label: 'far above threshold', padTo: 400 },
      ];
      for (const c of cases) {
        const dsts = [...realDsts, ...pad(c.padTo - realDsts.length)];
        expect(dsts.length).toBeGreaterThan(Math.floor((EDGE_READ_CHUNK - (c.rels?.length ?? 0)) / 2));
        const srcs = ids.filter((_, i) => i % 2 === 0 || rnd() < 0.3);
        const dSet = new Set(dsts);
        const keep = (e: EdgeRecord): boolean => dSet.has(e.dst) && (c.rels === undefined || c.rels.includes(e.rel));
        const expected: EdgeRecord[] = [];
        for (const x of [...srcs].sort((a, b) => a - b)) expected.push(...(await backend.getEdges({ src: x })).filter(keep));
        // Teeth precondition: the corpus has live matches AND edges the filter must drop.
        expect(expected.length).toBeGreaterThan(0);
        const unfiltered = (await backend.getEdges({ srcs, ...(c.rels ? { rels: c.rels } : {}) })).length;
        expect(unfiltered).toBeGreaterThan(expected.length);

        spy.reset();
        const got = await backend.getEdges({ srcs, dsts, ...(c.rels ? { rels: c.rels } : {}) });
        expect(got, c.label).toEqual(expected);
        const calls = edgeSelects(spy.calls);
        expect(calls.length).toBeGreaterThan(0);
        // JS-filter branch ran: no statement carries a dst IN-list, and no statement binds the dsts.
        for (const call of calls) {
          expect(call.sql).not.toMatch(/\bdst IN\b/);
          expect(call.args.some((a) => typeof a === 'number' && a >= 1_000_000)).toBe(false);
          expect(call.args.length).toBeLessThanOrEqual(EDGE_READ_CHUNK);
        }
      }

      // Control: below the threshold the SAME helper sees the bounded dst IN-list, so the assertion above discriminates the two branches.
      spy.reset();
      await backend.getEdges({ srcs: ids, dsts: realDsts });
      expect(edgeSelects(spy.calls).every((call) => /\bdst IN\b/.test(call.sql))).toBe(true);
    } finally {
      spy.restore();
    }
  });
});

describe('89cc3a30 AC-12 — unusable ids are rejected before any SQL', () => {
  it('89cc3a30 AC-12: NaN, +/-Infinity, fractions and negatives in srcs or dsts throw ConstraintError with zero statements', async () => {
    const spy = spyOn(big.adapter);
    try {
      for (const bad of [Number.NaN, Infinity, -Infinity, 1.5, -1, Number.MAX_SAFE_INTEGER + 2]) {
        for (const q of [{ srcs: [1, bad] }, { dsts: [bad] }, { srcs: [1], dsts: [bad] }]) {
          spy.reset();
          await expect(big.backend.getEdges(q)).rejects.toBeInstanceOf(ConstraintError);
          expect(spy.calls.length).toBe(0);
        }
      }
    } finally {
      spy.restore();
    }
  });
});

describe('89cc3a30 AC-16 — a metadata filter that exhausts the bind budget is a ConstraintError, not a malformed statement', () => {
  it('89cc3a30 AC-16: srcs + a metadata `in` list leaving avail < 2 throws ConstraintError with zero statements', async () => {
    const spy = spyOn(big.adapter);
    try {
      for (const q of [{ srcs: [1] }, { dsts: [2] }, { srcs: [1], dsts: [2] }]) {
        spy.reset();
        // `in` binds the path + every value: EDGE_READ_CHUNK - 1 values + path = EDGE_READ_CHUNK binds, so avail = 0.
        const metadata = { sha: { in: Array.from({ length: EDGE_READ_CHUNK + 100 }, (_, i) => `sha-${i}`) } };
        await expect(big.backend.getEdges({ ...q, metadata })).rejects.toBeInstanceOf(ConstraintError);
        expect(spy.calls.length).toBe(0);
      }
      // Boundary: baseParams = EDGE_READ_CHUNK - 2 leaves avail = 2 and is still served.
      spy.reset();
      const ok = { sha: { in: Array.from({ length: EDGE_READ_CHUNK - 3 }, (_, i) => `sha-${i}`) } };
      await expect(big.backend.getEdges({ srcs: [1], metadata: ok })).resolves.toEqual([]);
      expect(edgeSelects(spy.calls).length).toBe(1);
      // Boundary: baseParams = EDGE_READ_CHUNK - 1 leaves avail = 1 and is rejected.
      spy.reset();
      const tight = { sha: { in: Array.from({ length: EDGE_READ_CHUNK - 2 }, (_, i) => `sha-${i}`) } };
      await expect(big.backend.getEdges({ srcs: [1], metadata: tight })).rejects.toBeInstanceOf(ConstraintError);
      expect(spy.calls.length).toBe(0);
    } finally {
      spy.restore();
    }
  });
});
