import { describe, it, expect, afterEach } from 'vitest';
import { SqliteAdapterImpl, TursoAdapterImpl } from '@adhd/sox-store-adapter';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SqliteGraphBackend,
  createGraphBackend,
  ConstraintError,
  BitemporalConflictError,
  NodeNotFoundError,
  GRAPH_DDL,
  FTS_DDL,
  FTS_TRIGGERS,
  PRAGMAS,
  PUBLIC_EDGE_RELS,
} from './index.js';
import type { GraphBackend, EdgeRel } from './index.js';

async function freshBackend(): Promise<{ adapter: StoreAdapter; backend: GraphBackend }> {
  const adapter = new SqliteAdapterImpl(':memory:');
  const backend = createGraphBackend(adapter);
  await backend.applySchema();
  return { adapter, backend };
}

/** BUG-SOXGRAPH-001: patch a read-only capabilities field BEFORE the backend
 *  constructor reads it (TS readonly is compile-time only). */
function patchCapability<K extends keyof NonNullable<StoreAdapter['capabilities']>>(
  adapter: StoreAdapter,
  key: K,
  value: NonNullable<StoreAdapter['capabilities']>[K],
): void {
  (adapter.capabilities as unknown as Record<K, unknown>)[key] = value;
}

function hasTursoDriver(): boolean {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {});

describe('static exports', () => {
  // PKT-74/BL-448: this assertion is deliberately UNAFFECTED by BL-448/ADR-0010 D4. The CHECK's
  // vocabulary (still 10 rels — DEFAULT_EDGE_RELS, unchanged by this packet) and PUBLIC_EDGE_RELS
  // (still 7 rels, unchanged by this packet) were never the same constant — PUBLIC_EDGE_RELS has
  // always been memory-core's own tool-surface subset, not "the rels this store permits" (see
  // DEFAULT_EDGE_RELS's own doc comment above its declaration in index.ts, added by PKT-59). This
  // packet does not move, rename, or resize PUBLIC_EDGE_RELS: which set MemoryOntologyPolicy
  // carries is PKT-60/BL-441's decision, not this packet's; see ADR-0010's "Architect
  // recommendations… not owner decisions" section for why the DI wiring shape (and by extension,
  // PKT-60's exact vocabulary choice) is not ruled here.
  it('PUBLIC_EDGE_RELS contains 7 values', () => {
    expect(PUBLIC_EDGE_RELS).toHaveLength(7);
    expect(PUBLIC_EDGE_RELS).toContain('MENTIONS');
    expect(PUBLIC_EDGE_RELS).toContain('SUPPORTS');
    expect(PUBLIC_EDGE_RELS).toContain('RELATES_TO');
    expect(PUBLIC_EDGE_RELS).toContain('DERIVED_FROM');
    expect(PUBLIC_EDGE_RELS).toContain('SUPERSEDES');
    expect(PUBLIC_EDGE_RELS).toContain('SAME_AS');
    expect(PUBLIC_EDGE_RELS).toContain('ASSIGNED_TO');
    expect(PUBLIC_EDGE_RELS).not.toContain('MEMBER_OF');
    expect(PUBLIC_EDGE_RELS).not.toContain('PART_OF');
    expect(PUBLIC_EDGE_RELS).not.toContain('DEPENDS_ON');
  });

  it('PRAGMAS is a non-empty string array', () => {
    expect(PRAGMAS.length).toBeGreaterThan(0);
    expect(PRAGMAS.every((p) => typeof p === 'string')).toBe(true);
  });

  it('GRAPH_DDL is a non-empty string', () => {
    expect(typeof GRAPH_DDL).toBe('string');
    expect(GRAPH_DDL.length).toBeGreaterThan(0);
  });

  it('FTS_DDL is a non-empty string', () => {
    expect(typeof FTS_DDL).toBe('string');
    expect(FTS_DDL.length).toBeGreaterThan(0);
  });

  it('FTS_TRIGGERS is a non-empty string', () => {
    expect(typeof FTS_TRIGGERS).toBe('string');
    expect(FTS_TRIGGERS.length).toBeGreaterThan(0);
  });

  it('createGraphBackend returns an SqliteGraphBackend', async () => {
    const adapter = new SqliteAdapterImpl(':memory:');
    const backend = createGraphBackend(adapter);
    expect(backend).toBeInstanceOf(SqliteGraphBackend);
    await adapter.close();
  });
});

describe('applySchema', () => {
  it('creates node and edge tables', async () => {
    const { adapter } = await freshBackend();
    const tables = (await adapter.executeAll<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
    )).rows.map((r) => r.name);
    expect(tables).toContain('node');
    expect(tables).toContain('edge');
    expect(tables).toContain('fts_node');
    await adapter.close();
  });

  it('creates FTS virtual table', async () => {
    const { adapter } = await freshBackend();
    const row = await adapter.executeGet<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='fts_node'`,
    );
    expect(row).toBeTruthy();
    await adapter.close();
  });

  it('creates FTS sync triggers', async () => {
    const { adapter } = await freshBackend();
    const triggers = (await adapter.executeAll<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name`,
    )).rows.map((r) => r.name);
    expect(triggers).toContain('fts_node_ai');
    expect(triggers).toContain('fts_node_ad');
    expect(triggers).toContain('fts_node_au');
    await adapter.close();
  });

  it('is idempotent', async () => {
    const { backend, adapter } = await freshBackend();
    await backend.applySchema();
    await backend.applySchema();
    await backend.applySchema();
    const tables = await adapter.executeGet<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='node'`,
    );
    expect(tables).toBeTruthy();
    await adapter.close();
  });

  it('creates indexes', async () => {
    const { adapter } = await freshBackend();
    const indexes = (await adapter.executeAll<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='index' ORDER BY name`,
    )).rows.map((r) => r.name);
    expect(indexes.some((i) => i.includes('node_kind'))).toBe(true);
    expect(indexes.some((i) => i.includes('node_hash'))).toBe(true);
    expect(indexes.some((i) => i.includes('edge_src'))).toBe(true);
    expect(indexes.some((i) => i.includes('edge_unique'))).toBe(true);
    await adapter.close();
  });

  it('has capabilities with all flags true', async () => {
    const { backend, adapter } = await freshBackend();
    expect(backend.capabilities.bitemporal).toBe(true);
    expect(backend.capabilities.fullTextSearch).toBe(true);
    expect(backend.capabilities.metadataFilter).toBe(true);
    await adapter.close();
  });
});

const V1_NODE_DDL = `CREATE TABLE IF NOT EXISTS node (
  rowid INTEGER PRIMARY KEY, uid TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('episode','entity','claim','community','session')),
  content TEXT, name TEXT, summary TEXT, topic TEXT, tags TEXT, importance REAL DEFAULT 1.0,
  confidence REAL, content_hash TEXT, namespace TEXT DEFAULT 'global', meta TEXT,
  agent_id TEXT, session_id TEXT,
  source TEXT CHECK (source IN ('message','tool_output','observation','document','reflection','import')),
  project_path TEXT, t_occurred TEXT, t_expires TEXT, t_created TEXT NOT NULL,
  t_valid TEXT, t_invalid TEXT, is_superseded INTEGER DEFAULT 0,
  access_count INTEGER DEFAULT 0, last_access TEXT, t_updated TEXT
)`;

const V1_EDGE_DDL = `CREATE TABLE IF NOT EXISTS edge (
  rowid INTEGER PRIMARY KEY,
  src INTEGER NOT NULL REFERENCES node(rowid) ON DELETE CASCADE,
  dst INTEGER NOT NULL REFERENCES node(rowid) ON DELETE CASCADE,
  rel TEXT NOT NULL CHECK (rel IN ('MENTIONS','SUPPORTS','RELATES_TO','SUPERSEDES','DERIVED_FROM','MEMBER_OF','PART_OF','SAME_AS','ASSIGNED_TO')),
  weight REAL DEFAULT 1.0, confidence REAL,
  origin TEXT CHECK (origin IN ('extracted','inferred','user_asserted')),
  meta TEXT, t_created TEXT NOT NULL, t_valid TEXT, t_invalid TEXT
)`;

const V1_FTS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS fts_node USING fts5(content, name, summary,
  content='node', content_rowid='rowid', tokenize='unicode61')`;

const V1_FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS fts_node_ai AFTER INSERT ON node BEGIN
  INSERT INTO fts_node(rowid, content, name, summary) VALUES (new.rowid, new.content, new.name, new.summary);
END;
CREATE TRIGGER IF NOT EXISTS fts_node_ad AFTER DELETE ON node BEGIN
  INSERT INTO fts_node(fts_node, rowid, content, name, summary) VALUES ('delete', old.rowid, old.content, old.name, old.summary);
END;
CREATE TRIGGER IF NOT EXISTS fts_node_au AFTER UPDATE ON node BEGIN
  INSERT INTO fts_node(fts_node, rowid, content, name, summary) VALUES ('delete', old.rowid, old.content, old.name, old.summary);
  INSERT INTO fts_node(rowid, content, name, summary) VALUES (new.rowid, new.content, new.name, new.summary);
END;`;

const V1_INDEXES = [
  `CREATE INDEX IF NOT EXISTS ix_node_kind ON node(kind)`,
  `CREATE INDEX IF NOT EXISTS ix_node_hash ON node(content_hash)`,
  `CREATE INDEX IF NOT EXISTS ix_node_agent ON node(agent_id)`,
  `CREATE INDEX IF NOT EXISTS ix_node_session ON node(session_id)`,
  `CREATE INDEX IF NOT EXISTS ix_node_validity ON node(t_invalid) WHERE t_invalid IS NULL`,
  `CREATE INDEX IF NOT EXISTS ix_node_importance ON node(importance)`,
  `CREATE INDEX IF NOT EXISTS ix_node_temporal ON node(t_invalid, t_created DESC) WHERE t_invalid IS NULL`,
  `CREATE INDEX IF NOT EXISTS ix_node_topic ON node(topic) WHERE topic IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS ix_node_project ON node(project_path) WHERE project_path IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS ix_node_namespace ON node(namespace)`,
  `CREATE INDEX IF NOT EXISTS ix_node_expires ON node(t_expires) WHERE t_expires IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS ix_edge_src ON edge(src, rel)`,
  `CREATE INDEX IF NOT EXISTS ix_edge_dst ON edge(dst, rel)`,
  `CREATE INDEX IF NOT EXISTS ix_edge_live ON edge(t_invalid) WHERE t_invalid IS NULL`,
];

async function createV1Store(): Promise<StoreAdapter> {
  const adapter = new SqliteAdapterImpl(':memory:');
  for (const pragma of PRAGMAS) await adapter.exec(pragma);
  await adapter.exec(V1_NODE_DDL);
  await adapter.exec(V1_EDGE_DDL);
  await adapter.exec(V1_FTS_DDL);
  await adapter.exec(V1_FTS_TRIGGERS);
  for (const idx of V1_INDEXES) await adapter.exec(idx);
  await adapter.exec(`INSERT INTO fts_node(rowid, content, name, summary) SELECT rowid, content, name, summary FROM node`);
  return adapter;
}

describe('writeNode', () => {
  it('inserts a node', async () => {
    const { backend, adapter } = await freshBackend();
    const id = await backend.writeNode('hello world', { topic: 'greetings' });
    expect(id).toBeGreaterThan(0);
    const node = await backend.getNode(id);
    expect(node!.content).toBe('hello world');
    await adapter.close();
  });

  it('dedup', async () => {
    const { backend, adapter } = await freshBackend();
    const id1 = await backend.writeNode('hello world', {});
    const id2 = await backend.writeNode('hello world', { topic: 'different' });
    expect(id1).toBe(id2);
    await adapter.close();
  });

  it('stores tags', async () => {
    const { backend, adapter } = await freshBackend();
    const id = await backend.writeNode('tagged', { tags: ['foo', 'bar'] });
    expect((await backend.getNode(id))!.tags).toEqual(['foo', 'bar']);
    await adapter.close();
  });

  it('defaults namespace', async () => {
    const { backend, adapter } = await freshBackend();
    expect((await backend.getNode(await backend.writeNode('test', {})))!.namespace).toBe('global');
    await adapter.close();
  });

  it('tExpires and isStale', async () => {
    const { backend, adapter } = await freshBackend();
    const staleId = await backend.writeNode('stale', { tExpires: new Date(Date.now() - 86400000).toISOString() });
    const freshId = await backend.writeNode('fresh', { tExpires: new Date(Date.now() + 86400000).toISOString() });
    expect((await backend.getNode(staleId))!.isStale).toBe(true);
    expect((await backend.getNode(freshId))!.isStale).toBe(false);
    await adapter.close();
  });

  it('rejects bad kind', async () => {
    const { backend, adapter } = await freshBackend();
    await expect(backend.writeNode('bogus', { kind: 'nonsense' })).rejects.toThrow(ConstraintError);
    await adapter.close();
  });

  it('accepts generic kind', async () => {
    const { backend, adapter } = await freshBackend();
    const id = await backend.writeNode('generic node', { kind: 'generic' });
    expect((await backend.getNode(id))!.kind).toBe('generic');
    await adapter.close();
  });
});

describe('supersede', () => {
  it('creates chain', async () => {
    const { backend, adapter } = await freshBackend();
    const oldId = await backend.writeNode('v1', {});
    const newId = await backend.supersede(oldId, 'v2', { name: 'v2' });
    expect((await backend.getNode(oldId))!.isSuperseded).toBe(true);
    const chainEdges = await backend.getEdges({ rel: 'SUPERSEDES' });
    expect(chainEdges).toHaveLength(1);
    // The edge must connect the two nodes DIRECTIONALLY: supersede() writes
    // src=newId -> dst=oldId. `newId` was previously bound and never read, so nothing
    // checked what the chain pointed at; an endpoint-SET assertion still passes with the
    // direction reversed, and the direction is the semantics of the chain.
    expect({ src: chainEdges[0]!.src, dst: chainEdges[0]!.dst }).toEqual({ src: newId, dst: oldId });
    await adapter.close();
  });

  it('rejects invalidated node', async () => {
    const { backend, adapter } = await freshBackend();
    const id = await backend.writeNode('x', {});
    await backend.invalidate(id);
    await expect(backend.supersede(id, 'new', {})).rejects.toThrow(BitemporalConflictError);
    await adapter.close();
  });
});

describe('invalidate', () => {
  it('sets t_invalid', async () => {
    const { backend, adapter } = await freshBackend();
    const id = await backend.writeNode('test', {});
    await backend.invalidate(id);
    expect((await backend.getNode(id))!.tInvalid).toBeTruthy();
    await adapter.close();
  });

  it('hides from queryNodes', async () => {
    const { backend, adapter } = await freshBackend();
    const id = await backend.writeNode('test', {});
    await backend.invalidate(id);
    expect(await backend.queryNodes()).toHaveLength(0);
    await adapter.close();
  });
});

describe('touch', () => {
  it('updates fields', async () => {
    const { backend, adapter } = await freshBackend();
    const id = await backend.writeNode('original', { name: 'before', importance: 1 });
    await backend.touch(id, { name: 'after', importance: 8, metadata: { touched: true } });
    const node = await backend.getNode(id);
    expect(node!.name).toBe('after');
    expect(node!.importance).toBe(8);
    expect(node!.metadata).toEqual({ touched: true });
    expect(node!.content).toBe('original');
    await adapter.close();
  });

  it('rejects invalidated', async () => {
    const { backend, adapter } = await freshBackend();
    const id = await backend.writeNode('test', {});
    await backend.invalidate(id);
    await expect(backend.touch(id, { name: 'nope' })).rejects.toThrow(NodeNotFoundError);
    await adapter.close();
  });
});

describe('writeNodeBatch', () => {
  it('returns IDs', async () => {
    const { backend, adapter } = await freshBackend();
    const ids = await backend.writeNodeBatch([{ content: 'a', meta: {} }, { content: 'b', meta: {} }]);
    expect(ids).toHaveLength(2);
    await adapter.close();
  });
});

describe('writeGraph', () => {
  it('writes nodes + edges', async () => {
    const { backend, adapter } = await freshBackend();
    const ids = await backend.writeGraph(
      [{ content: 'a', meta: { name: 'A' } }, { content: 'b', meta: { name: 'B' } }],
      [{ srcIdx: 0, dstIdx: 1, rel: 'MENTIONS' }],
    );
    const edges = await backend.getEdges({});
    expect(edges).toHaveLength(1);
    expect(edges[0]!.src).toBe(ids[0]);
    await adapter.close();
  });

  it('all-or-nothing', async () => {
    const { backend, adapter } = await freshBackend();
    try { await backend.writeGraph([{ content: 'a', meta: {} }], [{ srcIdx: 0, dstIdx: 5, rel: 'MENTIONS' }]); } catch {}
    expect(await backend.countNodes()).toBe(0);
    await adapter.close();
  });
});

describe('writeEdge', () => {
  it('upserts', async () => {
    const { backend, adapter } = await freshBackend();
    const a = await backend.writeNode('a', {}), b = await backend.writeNode('b', {});
    await backend.writeEdge(a, b, 'MENTIONS');
    await backend.writeEdge(a, b, 'MENTIONS', { weight: 2.0 });
    expect(await backend.getEdges({})).toHaveLength(1);
    await adapter.close();
  });

  it('rejects bad rel', async () => {
    const { backend, adapter } = await freshBackend();
    const a = await backend.writeNode('a', {}), b = await backend.writeNode('b', {});
    await expect(backend.writeEdge(a, b, 'INVALID_REL' as EdgeRel)).rejects.toThrow(ConstraintError);
    await adapter.close();
  });
});

describe('queryNodes', () => {
  it('filters by topic', async () => {
    const { backend, adapter } = await freshBackend();
    await backend.writeNode('a', { topic: 'foo' });
    await backend.writeNode('b', { topic: 'bar' });
    expect(await backend.queryNodes({ topic: 'foo' })).toHaveLength(1);
    await adapter.close();
  });

  it('filters by tags', async () => {
    const { backend, adapter } = await freshBackend();
    await backend.writeNode('a', { tags: ['tag1'] });
    await backend.writeNode('b', { tags: ['tag2'] });
    expect(await backend.queryNodes({ tags: ['tag1'] })).toHaveLength(1);
    await adapter.close();
  });

  it('limit and offset', async () => {
    const { backend, adapter } = await freshBackend();
    for (const c of ['a', 'b', 'c', 'd']) await backend.writeNode(c, {});
    expect(await backend.queryNodes({ limit: 2, offset: 1 })).toHaveLength(2);
    await adapter.close();
  });

  it('filters by tUpdatedAfter', async () => {
    const { backend, adapter } = await freshBackend();
    const id1 = await backend.writeNode('a', {});
    await backend.writeNode('b', {}); // control: untouched node with null t_updated
    const beforeTouch = new Date().toISOString();
    await backend.touch(id1, { name: 'updated' });
    // id1 has t_updated >= beforeTouch; untouched node has null t_updated
    const results = await backend.queryNodes({ tUpdatedAfter: beforeTouch });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(id1);
    await adapter.close();
  });

  it('filters by tUpdatedBefore excludes untouched nodes', async () => {
    const { backend, adapter } = await freshBackend();
    const id1 = await backend.writeNode('a', {});
    await backend.writeNode('b', {}); // control: untouched node with null t_updated
    await backend.touch(id1, { name: 'updated' });
    // NULL t_updated rows are excluded by <= predicate
    const results = await backend.queryNodes({ tUpdatedBefore: '3000-01-01T00:00:00.000Z' });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(id1);
    await adapter.close();
  });
});

describe('searchNodes', () => {
  it('returns scored', async () => {
    const { backend, adapter } = await freshBackend();
    await backend.writeNode('apple banana', {});
    await backend.writeNode('dog cat', {});
    const r = await backend.searchNodes('apple');
    expect(r.length).toBeGreaterThan(0);
    expect(typeof r[0]!.score).toBe('number');
    await adapter.close();
  });

  it('supports offset', async () => {
    const { backend, adapter } = await freshBackend();
    await backend.writeNode('apple one', {});
    await backend.writeNode('apple two', {});
    await backend.writeNode('apple three', {});
    await backend.writeNode('apple four', {});
    await backend.writeNode('apple five', {});
    const page1 = await backend.searchNodes('apple', { limit: 2, offset: 0 });
    const page2 = await backend.searchNodes('apple', { limit: 2, offset: 2 });
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    expect(page1[0]!.id).not.toBe(page2[0]!.id);
    expect(page1[0]!.id).not.toBe(page2[1]!.id);
    await adapter.close();
  });

  // ── Multi-token OR semantics (BL-498 review, CAVEAT 2) ─────────────────────
  // b5c2c50f made searchNodes/countNodesFts tokenize + lowercase + OR-join the
  // query (index.ts: searchNodes — tokens.map quoted, joined ' OR ') via
  // FTSDialect.buildMatchQuery, aligning the sqlite path with BL-367 (the same
  // OR of quoted tokens recall.ts:583-604 emits). Before these tests the
  // semantics were UNASSERTED — only single-token queries were covered, so a
  // revert to implicit FTS5 bareword AND (or to AND-joined tokens) would have
  // gone green. Each test below pins ONE observable consequence of the OR join:
  // (1) either token matches; (2) a multi-word query no longer requires both
  // words; (3) the query is lowercased before MATCH. They assert what the code
  // does — deliberately not what a hypothetical reviewer guessed it does.
  it('ORs multi-token queries — a row containing EITHER quoted token matches', async () => {
    const { backend, adapter } = await freshBackend();
    await backend.writeNode('apple pie', {});
    await backend.writeNode('banana split', {});
    await backend.writeNode('cherry cobbler', {});
    // 'apple banana' → buildMatchQuery(['apple','banana']) → `"apple" OR "banana"`
    const hits = await backend.searchNodes('apple banana');
    const contents = hits.map((r) => r.content);
    expect(contents).toEqual(expect.arrayContaining(['apple pie', 'banana split']));
    expect(contents).not.toContain('cherry cobbler');
    expect(await backend.countNodesFts('apple banana')).toBe(2);
    await adapter.close();
  });

  it('multi-word query does NOT require both words — apple-only row matches "apple banana"', async () => {
    const { backend, adapter } = await freshBackend();
    await backend.writeNode('apple pie', {});
    await backend.writeNode('durian', {}); // control: contains neither token
    const hits = await backend.searchNodes('apple banana');
    expect(hits.map((r) => r.content)).toContain('apple pie');
    expect(hits.map((r) => r.content)).not.toContain('durian');
    expect(await backend.countNodesFts('apple banana')).toBe(1);
    await adapter.close();
  });

  it('matching is case-insensitive — mixed-case query matches lowercase content', async () => {
    const { backend, adapter } = await freshBackend();
    await backend.writeNode('Apple Pie Dessert', {});
    // searchNodes lowercases the whole query before tokenizing (index.ts), and
    // the unicode61 tokenizer lowercases indexed tokens — either way the
    // observable contract is: 'APPLE' finds 'Apple Pie Dessert'.
    const hits = await backend.searchNodes('APPLE');
    expect(hits.map((r) => r.content)).toContain('Apple Pie Dessert');
    expect(await backend.countNodesFts('APPLE')).toBe(1);
    await adapter.close();
  });
});

describe('countNodes', () => {
  it('counts live', async () => {
    const { backend, adapter } = await freshBackend();
    await backend.writeNode('a', {});
    const id = await backend.writeNode('b', {});
    await backend.invalidate(id);
    expect(await backend.countNodes()).toBe(1);
    await adapter.close();
  });
});

describe('countNodesFts', () => {
  it('counts FTS matches', async () => {
    const { backend, adapter } = await freshBackend();
    await backend.writeNode('apple banana', {});
    await backend.writeNode('apple cherry', {});
    await backend.writeNode('dog cat', {});
    const count = await backend.countNodesFts('apple');
    expect(count).toBe(2);
    await adapter.close();
  });
});

describe('getSupersessionChain', () => {
  it('returns chain', async () => {
    const { backend, adapter } = await freshBackend();
    const v1 = await backend.writeNode('v1', { name: 'v1' });
    const v2 = await backend.supersede(v1, 'v2', { name: 'v2' });
    const v3 = await backend.supersede(v2, 'v3', { name: 'v3' });
    const chain = await backend.getSupersessionChain(v2);
    expect(chain).toHaveLength(3);
    expect(chain[0]!.name).toBe('v1');
    // `v3` was bound and never read — assert the chain actually reaches the head.
    expect(chain.map((n) => n.id)).toEqual([v1, v2, v3]);
    await adapter.close();
  });
});

describe('getEdges', () => {
  it('filters', async () => {
    const { backend, adapter } = await freshBackend();
    const a = await backend.writeNode('a', {}), b = await backend.writeNode('b', {});
    await backend.writeEdge(a, b, 'MENTIONS');
    expect(await backend.getEdges({ rel: 'MENTIONS' })).toHaveLength(1);
    expect(await backend.getEdges({ rel: 'SUPPORTS' })).toHaveLength(0);
    await adapter.close();
  });
});

describe('getNeighbors', () => {
  it('out default', async () => {
    const { backend, adapter } = await freshBackend();
    const a = await backend.writeNode('a', {}), b = await backend.writeNode('b', {});
    await backend.writeEdge(a, b, 'MENTIONS');
    expect(await backend.getNeighbors(a)).toHaveLength(1);
    expect(await backend.getNeighbors(b)).toHaveLength(0);
    await adapter.close();
  });
});

describe('isReachable', () => {
  it('finds path', async () => {
    const { backend, adapter } = await freshBackend();
    const a = await backend.writeNode('a', {}), b = await backend.writeNode('b', {});
    await backend.writeEdge(a, b, 'RELATES_TO');
    expect(await backend.isReachable(a, b)).toBe(true);
    expect(await backend.isReachable(b, a)).toBe(false);
    await adapter.close();
  });
});

describe('getSubgraph', () => {
  it('returns nodes + edges', async () => {
    const { backend, adapter } = await freshBackend();
    const ids = await backend.writeGraph(
      [{ content: 'root', meta: {} }, { content: 'leaf', meta: {} }],
      [{ srcIdx: 0, dstIdx: 1, rel: 'RELATES_TO' }],
    );
    const sub = await backend.getSubgraph(ids[0]!);
    expect(sub.nodes).toHaveLength(2);
    expect(sub.edges).toHaveLength(1);
    await adapter.close();
  });
});

// ── SOXGRAPH-001 — recursive-CTE iterative fallback ───────────────────────────
//
// The same fixtures and assertions run against BOTH real adapters: the sqlite
// path executes the recursive `WITH RECURSIVE` SQL verbatim; the turso path
// (Turso Database Rust < 0.8.0 rejects recursive CTEs at prepare — see
// store-adapter's recursive-cte.probe.test.ts) executes the iterative BFS
// fallback. Parity is the contract: the fallback must be observationally
// identical to the recursive SQL on these shapes.

async function seedSupersessionChain(backend: GraphBackend): Promise<{ v1: number; v2: number; v3: number }> {
  const v1 = await backend.writeNode('v1 content', { name: 'v1' });
  const v2 = await backend.supersede(v1, 'v2 content', { name: 'v2' });
  const v3 = await backend.supersede(v2, 'v3 content', { name: 'v3' });
  return { v1, v2, v3 };
}

describe('recursive-cte fallback parity (SOXGRAPH-001)', () => {
  async function openSqliteParity(): Promise<{ adapter: StoreAdapter; backend: GraphBackend }> {
    const adapter = new SqliteAdapterImpl(':memory:');
    const backend = createGraphBackend(adapter);
    await backend.applySchema();
    return { adapter, backend };
  }

  async function openTursoParity(): Promise<{ adapter: StoreAdapter; backend: GraphBackend }> {
    const dir = mkdtempSync(join(tmpdir(), 'graph-store-parity-'));
    const adapter = await TursoAdapterImpl.connect({ dbPath: join(dir, `parity-${Date.now()}.db`) });
    const backend = createGraphBackend(adapter);
    await backend.applySchema();
    return { adapter, backend };
  }

  const tursoAvailable = hasTursoDriver();

  const parityArms: Array<
    [string, () => Promise<{ adapter: StoreAdapter; backend: GraphBackend }>, boolean]
  > = [
    ['sqlite — recursive SQL path', openSqliteParity, false],
    ['turso — iterative fallback path', openTursoParity, !tursoAvailable],
  ];

  for (const [label, open, skip] of parityArms) {
    describe(label, () => {
      it('getSupersessionChain returns oldest-first [v1, v2, v3] by name', { skip, timeout: 20000 }, async () => {
        const { backend, adapter } = await open();
        try {
          const { v2 } = await seedSupersessionChain(backend);
          const chain = await backend.getSupersessionChain(v2);
          expect(chain.map((n) => n.name)).toEqual(['v1', 'v2', 'v3']);
        } finally {
          await adapter.close();
        }
      });

      it('getSupersessionChain terminates on a SUPERSEDES cycle and returns []', { skip, timeout: 20000 }, async () => {
        const { backend, adapter } = await open();
        try {
          const { v1, v2 } = await seedSupersessionChain(backend);
          // Close the cycle: v1 supersedes v2 as well. Both connected nodes now
          // have an outbound SUPERSEDES edge → no head exists on either path.
          await backend.writeEdge(v1, v2, 'SUPERSEDES');
          expect(await backend.getSupersessionChain(v1)).toEqual([]);
        } finally {
          await adapter.close();
        }
      });

      it('getNeighbors depth-2 walks depth-unbounded under the total budget — same id-set both paths', { skip, timeout: 20000 }, async () => {
        const { backend, adapter } = await open();
        try {
          const a = await backend.writeNode('a', {});
          const b = await backend.writeNode('b', {});
          const c = await backend.writeNode('c', {});
          const d = await backend.writeNode('d', {});
          const e = await backend.writeNode('e', {});
          await backend.writeEdge(a, b, 'RELATES_TO');
          await backend.writeEdge(b, c, 'RELATES_TO');
          await backend.writeEdge(c, d, 'RELATES_TO');
          await backend.writeEdge(a, e, 'RELATES_TO');
          // depth=2 → budget depth*100=200 rows total (seed included). The walk
          // is depth-unbounded (verified empirically): b, e at level 1, c at
          // level 2, d at level 3 — all within budget on this small graph.
          const ids = new Set((await backend.getNeighbors(a, { depth: 2, direction: 'out' })).map((n) => n.id));
          expect(ids).toEqual(new Set([b, c, d, e]));
        } finally {
          await adapter.close();
        }
      });

      it('isReachable walks out/in edges, terminates on cycles, and honors direction', { skip, timeout: 20000 }, async () => {
        const { backend, adapter } = await open();
        try {
          const a = await backend.writeNode('a', {});
          const b = await backend.writeNode('b', {});
          const c = await backend.writeNode('c', {});
          await backend.writeEdge(a, b, 'RELATES_TO');
          await backend.writeEdge(b, c, 'RELATES_TO');
          await backend.writeEdge(c, b, 'RELATES_TO'); // cycle c→b→c
          expect(await backend.isReachable(a, c)).toBe(true);
          expect(await backend.isReachable(c, a)).toBe(false);
          expect(await backend.isReachable(c, a, { direction: 'in' })).toBe(true);
          expect(await backend.isReachable(a, a)).toBe(true); // seed is on its own path
        } finally {
          await adapter.close();
        }
      });

      it('getSubgraph includes an invalidated node behind a live edge, plus its edges (no liveness filter)', { skip, timeout: 20000 }, async () => {
        const { backend, adapter } = await open();
        try {
          const root = await backend.writeNode('root', {});
          const mid = await backend.writeNode('mid', {});
          const leaf = await backend.writeNode('leaf', {});
          await backend.writeEdge(root, mid, 'RELATES_TO');
          await backend.writeEdge(mid, leaf, 'RELATES_TO');
          await backend.invalidate(leaf); // edge mid→leaf stays LIVE
          const sub = await backend.getSubgraph(root, { direction: 'out' });
          // The recursive `sub` CTE never joins node, so the invalidated leaf
          // is part of the subgraph — the iterative fallback must match.
          expect(new Set(sub.nodes.map((n) => n.id))).toEqual(new Set([root, mid, leaf]));
          expect(sub.edges.map((e) => `${e.src}:${e.dst}:${e.rel}`).sort()).toEqual(
            [`${mid}:${leaf}:RELATES_TO`, `${root}:${mid}:RELATES_TO`].sort(),
          );
        } finally {
          await adapter.close();
        }
      });

      it('getSubgraph honors maxDepth', { skip, timeout: 20000 }, async () => {
        const { backend, adapter } = await open();
        try {
          const a = await backend.writeNode('a', {});
          const b = await backend.writeNode('b', {});
          const c = await backend.writeNode('c', {});
          await backend.writeEdge(a, b, 'RELATES_TO');
          await backend.writeEdge(b, c, 'RELATES_TO');
          const sub = await backend.getSubgraph(a, { direction: 'out', depth: 1 });
          expect(new Set(sub.nodes.map((n) => n.id))).toEqual(new Set([a, b]));
          expect(sub.edges.map((e) => `${e.src}:${e.dst}`)).toEqual([`${a}:${b}`]);
        } finally {
          await adapter.close();
        }
      });
    });
  }
});

// ── Forced fallback on sqlite (BL-225 red→green host) ─────────────────────────
//
// The parity arms above exercise the fallback through the REAL turso engine.
// These force the same iterative code onto REAL sqlite by patching
// capabilities.recursiveCte to false before the backend constructor reads it —
// a fast loop (no turso) that isolates the fallback's own logic. Test names
// carry the SOXGRAPH-001 / BL-225 ids so a regression is attributable.

describe('recursive-cte forced fallback on sqlite, recursiveCte:false (SOXGRAPH-001, BL-225)', () => {
  async function forcedFallbackBackend(): Promise<{ adapter: StoreAdapter; backend: GraphBackend }> {
    const adapter = new SqliteAdapterImpl(':memory:');
    patchCapability(adapter, 'recursiveCte', false);
    const backend = createGraphBackend(adapter);
    await backend.applySchema();
    return { adapter, backend };
  }

  it('SOXGRAPH-001: getSupersessionChain head phase — lowest-rowid connected node with no outbound SUPERSEDES', async () => {
    const { backend, adapter } = await forcedFallbackBackend();
    try {
      const { v1, v2, v3 } = await seedSupersessionChain(backend);
      const chain = await backend.getSupersessionChain(v2);
      expect(chain.map((n) => n.id)).toEqual([v1, v2, v3]);
      expect(chain.map((n) => n.name)).toEqual(['v1', 'v2', 'v3']);
    } finally {
      await adapter.close();
    }
  });

  it('SOXGRAPH-001: getSupersessionChain terminates on a cycle (head phase + visited chain)', async () => {
    const { backend, adapter } = await forcedFallbackBackend();
    try {
      const { v1, v2 } = await seedSupersessionChain(backend);
      await backend.writeEdge(v1, v2, 'SUPERSEDES');
      expect(await backend.getSupersessionChain(v1)).toEqual([]);
    } finally {
      await adapter.close();
    }
  });

  it('BL-225: getNeighbors visited set terminates cycles — no hang, no duplicate results', async () => {
    const { backend, adapter } = await forcedFallbackBackend();
    try {
      const a = await backend.writeNode('a', {});
      const b = await backend.writeNode('b', {});
      await backend.writeEdge(a, b, 'RELATES_TO');
      await backend.writeEdge(b, a, 'RELATES_TO');
      // depth=10000 → budget 1,000,000. With the visited set the 2-node cycle
      // terminates in a handful of queries; WITHOUT it (deliberate break,
      // BL-225 red→green demo) the walk spins one getEdges round-trip per
      // budget unit — ~1M DB calls → vitest timeout → RED.
      const ids = new Set((await backend.getNeighbors(a, { depth: 10000, direction: 'out' })).map((n) => n.id));
      expect(ids).toEqual(new Set([b]));
    } finally {
      await adapter.close();
    }
  }, 3000);

  it('SOXGRAPH-001: getNeighbors budget mirrors the recursive LIMIT — depth*100 TOTAL rows incl. the seed (depth-unbounded walk)', async () => {
    const { backend, adapter } = await forcedFallbackBackend();
    try {
      // Chain a→b→c→d→e. depth=2 → budget 200; the recursive walk is NOT
      // depth-capped (empirical finding), so all four downstream nodes are
      // returned — budget 200 never binds on a 5-node chain. (depth=1 would
      // short-circuit to the dedicated getNeighborsDepth1 hop, so the walk
      // under test requires depth >= 2.)
      const a = await backend.writeNode('a', {});
      const b = await backend.writeNode('b', {});
      const c = await backend.writeNode('c', {});
      const d = await backend.writeNode('d', {});
      const e = await backend.writeNode('e', {});
      await backend.writeEdge(a, b, 'RELATES_TO');
      await backend.writeEdge(b, c, 'RELATES_TO');
      await backend.writeEdge(c, d, 'RELATES_TO');
      await backend.writeEdge(d, e, 'RELATES_TO');
      const ids = new Set((await backend.getNeighbors(a, { depth: 2, direction: 'out' })).map((n) => n.id));
      expect(ids).toEqual(new Set([b, c, d, e]));

      // Budget BIND: fan-out 15×15 = 240 level-2 rows with depth=2 → budget
      // 200 total (seed + 15 + 184). Both paths must stop at exactly 199
      // discovered live nodes (200 minus the seed).
      const root = await backend.writeNode('root', {});
      const children: number[] = [];
      for (let i = 0; i < 15; i++) children.push(await backend.writeNode(`child${i}`, {}));
      for (const ch of children) await backend.writeEdge(root, ch, 'RELATES_TO');
      for (let i = 0; i < 15; i++) {
        for (let j = 0; j < 15; j++) {
          const g = await backend.writeNode(`g${i}-${j}`, {});
          await backend.writeEdge(children[i]!, g, 'RELATES_TO');
        }
      }
      const bounded = await backend.getNeighbors(root, { depth: 2, direction: 'out' });
      expect(bounded).toHaveLength(199); // budget 200 − seed
    } finally {
      await adapter.close();
    }
  }, 20000);

  it('BL-225: isReachable early-exit BFS — discovers dst without walking the whole graph', async () => {
    const { backend, adapter } = await forcedFallbackBackend();
    try {
      const a = await backend.writeNode('a', {});
      const b = await backend.writeNode('b', {});
      const c = await backend.writeNode('c', {});
      await backend.writeEdge(a, b, 'RELATES_TO');
      await backend.writeEdge(b, c, 'RELATES_TO');
      expect(await backend.isReachable(a, c)).toBe(true);
      expect(await backend.isReachable(c, a)).toBe(false);
    } finally {
      await adapter.close();
    }
  });

  it('SOXGRAPH-001: getSubgraph level-by-level BFS — maxDepth, cycle termination, invalidated quirk, both-direction merge', async () => {
    const { backend, adapter } = await forcedFallbackBackend();
    try {
      // root → mid → leaf (leaf at depth 2), root → ghost (ghost at depth 1),
      // ghost → root (cycle). ghost is INVALIDATED — but neither path filters
      // node liveness, so it stays in the subgraph behind its live edge.
      const root = await backend.writeNode('root', {});
      const mid = await backend.writeNode('mid', {});
      const leaf = await backend.writeNode('leaf', {});
      const ghost = await backend.writeNode('ghost', {});
      await backend.writeEdge(root, mid, 'RELATES_TO');
      await backend.writeEdge(mid, leaf, 'RELATES_TO');
      await backend.writeEdge(root, ghost, 'RELATES_TO');
      await backend.writeEdge(ghost, root, 'RELATES_TO'); // cycle back to root
      await backend.invalidate(ghost);
      const sub = await backend.getSubgraph(root, { direction: 'out', depth: 2 });
      expect(new Set(sub.nodes.map((n) => n.id))).toEqual(new Set([root, mid, leaf, ghost]));
      expect(sub.edges.map((e) => `${e.src}:${e.dst}`).sort()).toEqual(
        [`${root}:${mid}`, `${mid}:${leaf}`, `${root}:${ghost}`, `${ghost}:${root}`].sort(),
      );
    } finally {
      await adapter.close();
    }
  }, 20000);
});

// ── BUG-SOXGRAPH-001: fullTextSearch must derive from the adapter ─────────────

describe('BUG-SOXGRAPH-001: capabilities.fullTextSearch derives from adapter.capabilities.fts', () => {
  it('an fts:false adapter reports fullTextSearch:false and searchNodes/countNodesFts return empty/0, never throwing', async () => {
    const adapter = new SqliteAdapterImpl(':memory:');
    patchCapability(adapter, 'fts', false);
    const backend = createGraphBackend(adapter);
    await backend.applySchema(); // FTS schema step must be a no-op, not a throw
    expect(backend.capabilities.fullTextSearch).toBe(false);
    expect(backend.capabilities.bitemporal).toBe(true);
    expect(await backend.searchNodes('apple')).toEqual([]);
    expect(await backend.countNodesFts('apple')).toBe(0);
    // the store still functions for non-FTS reads/writes
    await backend.writeNode('apple pie', {});
    expect(await backend.queryNodes()).toHaveLength(1);
    expect(await backend.searchNodes('apple')).toEqual([]);
    expect(await backend.countNodesFts('apple')).toBe(0);
    await adapter.close();
  });
});

// ── BUG-SOXGRAPH-002: busy_timeout is adapter-owned ───────────────────────────

describe('BUG-SOXGRAPH-002: PRAGMA busy_timeout is adapter-owned, not graph-store-owned', () => {
  it('PRAGMAS no longer contains busy_timeout (SqliteAdapter owns it at connect: 3000ms)', () => {
    expect(PRAGMAS.some((p) => p.includes('busy_timeout'))).toBe(false);
    expect(PRAGMAS).toContain('PRAGMA journal_mode = WAL;');
  });
});

describe('migrations', () => {
  it('preserves data + adds columns', async () => {
    const adapter = await createV1Store();
    await adapter.executeRun(`INSERT INTO node (uid, kind, content, t_created) VALUES (?, 'episode', ?, ?)`, ['uid-1', 'orig', new Date().toISOString()]);
    await adapter.executeRun(`INSERT INTO edge (src, dst, rel, t_created) VALUES (1, 1, 'MENTIONS', ?)`, [new Date().toISOString()]);
    const backend = new SqliteGraphBackend(adapter);
    await backend.applySchema();
    const row = await adapter.executeGet<Record<string, unknown>>(`SELECT * FROM node WHERE rowid = 1`);
    expect(row!.content).toBe('orig');
    for (const col of ['level', 'resume_state']) {
      expect(await adapter.executeGet(`SELECT * FROM pragma_table_info('node') WHERE name = ?`, [col])).toBeDefined();
    }
    await adapter.close();
  });

  it('accepts generic kind after migration', async () => {
    const adapter = await createV1Store();
    const backend = new SqliteGraphBackend(adapter);
    await backend.applySchema();
    await adapter.executeRun(`INSERT INTO node (uid, kind, content, t_created) VALUES (?, 'generic', ?, ?)`, ['generic-1', 'g', new Date().toISOString()]);
    const row = await adapter.executeGet<{ kind: string }>(`SELECT kind FROM node WHERE uid = 'generic-1'`);
    expect(row!.kind).toBe('generic');
    await adapter.close();
  });

  it('accepts DEPENDS_ON edge after migration', async () => {
    const adapter = await createV1Store();
    const backend = new SqliteGraphBackend(adapter);
    await backend.applySchema();
    const now = new Date().toISOString();
    await adapter.executeRun(`INSERT INTO node (uid, kind, content, t_created) VALUES (?, 'episode', ?, ?)`, ['s', 'src', now]);
    await adapter.executeRun(`INSERT INTO node (uid, kind, content, t_created) VALUES (?, 'episode', ?, ?)`, ['d', 'dst', now]);
    await adapter.executeRun(`INSERT INTO edge (src, dst, rel, t_created) VALUES (1, 2, 'DEPENDS_ON', ?)`, [now]);
    expect((await adapter.executeGet<{ rel: string }>(`SELECT rel FROM edge WHERE rel = 'DEPENDS_ON'`))!.rel).toBe('DEPENDS_ON');
    await adapter.close();
  });

  it('idempotent', async () => {
    const adapter = await createV1Store();
    const backend = new SqliteGraphBackend(adapter);
    await backend.applySchema();
    await backend.applySchema();
    await adapter.executeRun(`INSERT INTO node (uid, kind, content, t_created) VALUES (?, 'generic', ?, ?)`, ['idem', 'g', new Date().toISOString()]);
    await adapter.close();
  });

  it('BL-313 cascade-delete', async () => {
    const adapter = await createV1Store();
    const now = new Date().toISOString();
    for (let i = 0; i < 10; i++)
      await adapter.executeRun(`INSERT INTO node (rowid, uid, kind, content, t_created) VALUES (?, ?, 'episode', ?, ?)`, [i + 1, `uid-${i}`, `c${i}`, now]);
    let cnt = 0;
    for (let i = 1; i <= 10; i++)
      for (let j = 1; j <= 10; j++)
        if (i !== j) { await adapter.executeRun(`INSERT INTO edge (src, dst, rel, t_created) VALUES (?, ?, 'RELATES_TO', ?)`, [i, j, now]); cnt++; }
    const backend = new SqliteGraphBackend(adapter);
    await backend.applySchema();
    expect((await adapter.executeGet<{ c: number }>(`SELECT COUNT(*) AS c FROM edge`))!.c).toBe(cnt);
    await adapter.close();
  });

  it('BL-313 is_superseded backfill', async () => {
    const adapter = new SqliteAdapterImpl(':memory:');
    for (const p of PRAGMAS) await adapter.exec(p);
    await adapter.exec(`CREATE TABLE node (
      rowid INTEGER PRIMARY KEY, uid TEXT UNIQUE NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('episode','entity','claim','community','session','generic')),
      content TEXT, name TEXT, summary TEXT, topic TEXT, tags TEXT, importance REAL DEFAULT 1.0,
      confidence REAL, content_hash TEXT, namespace TEXT DEFAULT 'global', meta TEXT,
      agent_id TEXT, session_id TEXT,
      source TEXT CHECK (source IN ('message','tool_output','observation','document','reflection','import')),
      project_path TEXT, level INTEGER, resume_state TEXT,
      t_occurred TEXT, t_expires TEXT, t_created TEXT NOT NULL, t_valid TEXT, t_invalid TEXT,
      access_count INTEGER DEFAULT 0, last_access TEXT, t_updated TEXT
    )`);
    await adapter.exec(`CREATE TABLE edge (
      rowid INTEGER PRIMARY KEY,
      src INTEGER NOT NULL REFERENCES node(rowid) ON DELETE CASCADE,
      dst INTEGER NOT NULL REFERENCES node(rowid) ON DELETE CASCADE,
      rel TEXT NOT NULL CHECK (rel IN ('MENTIONS','SUPPORTS','RELATES_TO','SUPERSEDES','DERIVED_FROM','MEMBER_OF','PART_OF','SAME_AS','ASSIGNED_TO','DEPENDS_ON')),
      weight REAL DEFAULT 1.0, confidence REAL,
      origin TEXT CHECK (origin IN ('extracted','inferred','user_asserted')),
      meta TEXT, t_created TEXT NOT NULL, t_expired TEXT, t_valid TEXT, t_invalid TEXT
    )`);
    await adapter.executeRun(`INSERT INTO node (uid, kind, content, t_created) VALUES (?, 'episode', ?, ?)`, ['uid-1', 'pre-existing', new Date().toISOString()]);
    const backend = new SqliteGraphBackend(adapter);
    await backend.applySchema();
    expect(await adapter.executeGet(`SELECT * FROM pragma_table_info('node') WHERE name = 'is_superseded'`)).toBeDefined();
    const row = await adapter.executeGet<{ is_superseded: number }>(`SELECT is_superseded FROM node WHERE uid = 'uid-1'`);
    expect(row!.is_superseded).toBe(0);
    await adapter.close();
  });
});
