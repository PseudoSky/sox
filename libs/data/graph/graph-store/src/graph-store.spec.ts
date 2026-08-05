import { describe, it, expect, afterEach } from 'vitest';
import { SqliteAdapterImpl } from '@adhd/sox-store-adapter';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
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

afterEach(() => {});

describe('static exports', () => {
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
