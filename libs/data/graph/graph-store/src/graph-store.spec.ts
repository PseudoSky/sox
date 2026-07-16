/**
 * @adhd/sox-graph-store — comprehensive tests
 */
import Database from 'better-sqlite3';
import { describe, it, expect, afterEach } from 'vitest';
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
  rebuildTable,
} from './index.js';
import type { GraphBackend, NodeMeta, NodeRecord, EdgeRel } from './index.js';

function freshBackend(): { db: Database.Database; backend: GraphBackend } {
  const db = new Database(':memory:');
  const backend = createGraphBackend(db);
  backend.applySchema();
  return { db, backend };
}

afterEach(() => {
});

// ─── Schema & static exports ─────────────────────────────────────────────────

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

  it('createGraphBackend returns an SqliteGraphBackend', () => {
    const db = new Database(':memory:');
    const backend = createGraphBackend(db);
    expect(backend).toBeInstanceOf(SqliteGraphBackend);
    db.close();
  });
});

describe('applySchema', () => {
  it('creates node and edge tables', () => {
    const { db } = freshBackend();
    const tables = db
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )
      .all()
      .map((r) => r.name);
    expect(tables).toContain('node');
    expect(tables).toContain('edge');
    expect(tables).toContain('fts_node');
    db.close();
  });

  it('creates FTS virtual table', () => {
    const { db } = freshBackend();
    const row = db
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='fts_node'`,
      )
      .get();
    expect(row).toBeTruthy();
    db.close();
  });

  it('creates FTS sync triggers', () => {
    const { db } = freshBackend();
    const triggers = db
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name`,
      )
      .all()
      .map((r) => r.name);
    expect(triggers).toContain('fts_node_ai');
    expect(triggers).toContain('fts_node_ad');
    expect(triggers).toContain('fts_node_au');
    db.close();
  });

  it('is idempotent', () => {
    const { backend, db } = freshBackend();
    backend.applySchema();
    backend.applySchema();
    backend.applySchema();
    const tables = db
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='node'`,
      )
      .get();
    expect(tables).toBeTruthy();
    db.close();
  });

  it('creates indexes', () => {
    const { db } = freshBackend();
    const indexes = db
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type='index' ORDER BY name`,
      )
      .all()
      .map((r) => r.name);
    expect(indexes.some((i) => i.includes('node_kind'))).toBe(true);
    expect(indexes.some((i) => i.includes('node_hash'))).toBe(true);
    expect(indexes.some((i) => i.includes('edge_src'))).toBe(true);
    expect(indexes.some((i) => i.includes('edge_unique'))).toBe(true);
    db.close();
  });

  it('has capabilities with all flags true', () => {
    const { backend, db } = freshBackend();
    expect(backend.capabilities.bitemporal).toBe(true);
    expect(backend.capabilities.fullTextSearch).toBe(true);
    expect(backend.capabilities.metadataFilter).toBe(true);
    db.close();
  });
});

// ─── Node writes ──────────────────────────────────────────────────────────────

describe('writeNode', () => {
  it('inserts a node and returns rowid', () => {
    const { backend, db } = freshBackend();
    const id = backend.writeNode('hello world', { topic: 'greetings' });
    expect(id).toBeGreaterThan(0);
    const node = backend.getNode(id);
    expect(node).not.toBeNull();
    expect(node!.content).toBe('hello world');
    expect(node!.topic).toBe('greetings');
    db.close();
  });

  it('returns same rowid for duplicate content (dedup)', () => {
    const { backend, db } = freshBackend();
    const id1 = backend.writeNode('hello world', {});
    const id2 = backend.writeNode('hello world', { topic: 'different' });
    expect(id1).toBe(id2);
    const count = backend.countNodes();
    expect(count).toBe(1);
    db.close();
  });

  it('dedup is case-insensitive and whitespace-insensitive', () => {
    const { backend, db } = freshBackend();
    const id1 = backend.writeNode('Hello World', {});
    const id2 = backend.writeNode('  hello world  ', {});
    expect(id1).toBe(id2);
    db.close();
  });

  it('stores metadata as JSON', () => {
    const { backend, db } = freshBackend();
    const id = backend.writeNode('test', {
      metadata: { key: 'value', num: 42 },
    });
    const node = backend.getNode(id);
    expect(node!.metadata).toEqual({ key: 'value', num: 42 });
    db.close();
  });

  it('stores tags as JSON array', () => {
    const { backend, db } = freshBackend();
    const id = backend.writeNode('tagged content', {
      tags: ['foo', 'bar'],
    });
    const node = backend.getNode(id);
    expect(node!.tags).toEqual(['foo', 'bar']);
    db.close();
  });

  it('defaults namespace to "global"', () => {
    const { backend, db } = freshBackend();
    const id = backend.writeNode('test', {});
    const node = backend.getNode(id);
    expect(node!.namespace).toBe('global');
    db.close();
  });

  it('respects explicit namespace', () => {
    const { backend, db } = freshBackend();
    const id = backend.writeNode('test', { namespace: 'custom-ns' });
    const node = backend.getNode(id);
    expect(node!.namespace).toBe('custom-ns');
    db.close();
  });

  it('sets tValid and tCreated', () => {
    const { backend, db } = freshBackend();
    const id = backend.writeNode('test', {});
    const node = backend.getNode(id);
    expect(node!.tValid).toBeTruthy();
    expect(node!.tCreated).toBeTruthy();
    expect(node!.tInvalid).toBeUndefined();
    db.close();
  });

  it('stores confidence and importance', () => {
    const { backend, db } = freshBackend();
    const id = backend.writeNode('test', {
      confidence: 'confirmed',
      importance: 7.5,
    });
    const node = backend.getNode(id);
    expect(node!.confidence).toBe('confirmed');
    expect(node!.importance).toBe(7.5);
    db.close();
  });

  it('stores tExpires and isStale', () => {
    const { backend, db } = freshBackend();
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    const futureDate = new Date(Date.now() + 86400000).toISOString();

    const staleId = backend.writeNode('stale', { tExpires: pastDate });
    const freshId = backend.writeNode('fresh', { tExpires: futureDate });
    const noExpiryId = backend.writeNode('no expiry', {});

    expect(backend.getNode(staleId)!.isStale).toBe(true);
    expect(backend.getNode(freshId)!.isStale).toBe(false);
    expect(backend.getNode(noExpiryId)!.isStale).toBe(false);
    db.close();
  });
});

// ─── node kind (BL-295, sox-ecosystem's Option A — kind:'generic' escape hatch) ─
//
// Per BACKLOG.md BL-295's own resolution: the node.kind CHECK constraint is a fixed
// enum (episode/entity/claim/community/session/generic) that is NEVER extended per
// consumer. A non-memory reuse case (e.g. a component registry) writes with
// kind:'generic' and carries its own sub-kind (e.g. 'component') in tags/metadata.
// There is no constructor-level kind allowlist — createGraphBackend(db) takes no opts.

describe('node kind', () => {
  it('defaults to "episode" when kind is omitted', () => {
    const { backend, db } = freshBackend();
    const id = backend.writeNode('untyped content', {});
    const node = backend.getNode(id);
    expect(node!.kind).toBe('episode');
    db.close();
  });

  it('accepts every DEFAULT_NODE_KINDS value, including "generic" (BL-295 criterion 1)', () => {
    const { backend, db } = freshBackend();
    for (const kind of ['episode', 'entity', 'claim', 'community', 'session', 'generic']) {
      const id = backend.writeNode(`content for ${kind}`, { kind });
      expect(backend.getNode(id)!.kind).toBe(kind);
    }
    db.close();
  });

  it('writes a kind:"generic" node carrying its own sub-kind in metadata/tags — the intended non-memory reuse contract', () => {
    const { backend, db } = freshBackend();
    const id = backend.writeNode('A reusable Button component', {
      kind: 'generic',
      name: 'Button',
      tags: ['component', 'ui-primitives'],
      metadata: { subKind: 'component' },
    });
    const node = backend.getNode(id);
    expect(node!.kind).toBe('generic');
    expect(node!.tags).toContain('component');
    expect(node!.metadata).toEqual({ subKind: 'component' });
    db.close();
  });

  it('rejects a kind outside DEFAULT_NODE_KINDS with ConstraintError, not a raw SQLite error (BL-295 criterion 2)', () => {
    const { backend, db } = freshBackend();
    expect(() => backend.writeNode('bogus kind', { kind: 'nonsense' })).toThrow(ConstraintError);
    db.close();
  });

  it('still rejects an out-of-enum kind after this fix — CHECK is additive, not removed (negative control for criterion 2)', () => {
    const { backend, db } = freshBackend();
    // The five original memory kinds plus 'generic' still round-trip...
    for (const kind of ['episode', 'entity', 'claim', 'community', 'session', 'generic']) {
      expect(() => backend.writeNode(`ok-${kind}`, { kind })).not.toThrow();
    }
    // ...while a kind that was never in the enum is still hard-rejected, proving the
    // fix (surfacing writeNode's kind param) did not loosen the domain-integrity guarantee.
    expect(() => backend.writeNode('still rejected', { kind: 'component' })).toThrow(
      ConstraintError,
    );
    db.close();
  });

  it('queryNodes filters by kind (string and array forms)', () => {
    const { backend, db } = freshBackend();
    const genericId = backend.writeNode('generic node', { kind: 'generic' });
    const episodeId = backend.writeNode('episode node', { kind: 'episode' });
    backend.writeNode('entity node', { kind: 'entity' });

    const generics = backend.queryNodes({ kind: 'generic' });
    expect(generics.map((n) => n.id)).toEqual([genericId]);

    const genericsAndEpisodes = backend.queryNodes({ kind: ['generic', 'episode'] });
    expect(new Set(genericsAndEpisodes.map((n) => n.id))).toEqual(
      new Set([genericId, episodeId]),
    );
    db.close();
  });
});

// ─── supersede ────────────────────────────────────────────────────────────────

describe('supersede', () => {
  it('creates new node and SUPERSEDES edge', () => {
    const { backend, db } = freshBackend();
    const oldId = backend.writeNode('v1 content', {});
    const newId = backend.supersede(oldId, 'v2 content', { name: 'v2' });

    expect(newId).toBeGreaterThan(0);
    expect(newId).not.toBe(oldId);

    const oldNode = backend.getNode(oldId);
    expect(oldNode!.isSuperseded).toBe(true);

    const edges = backend.getEdges({ rel: 'SUPERSEDES' });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.src).toBe(newId);
    expect(edges[0]!.dst).toBe(oldId);
    db.close();
  });

  it('throws BitemporalConflictError if old node is already invalidated', () => {
    const { backend, db } = freshBackend();
    const id = backend.writeNode('content', {});
    backend.invalidate(id, 'no longer valid');
    expect(() => backend.supersede(id, 'new', {})).toThrow(BitemporalConflictError);
    db.close();
  });

  it('throws NodeNotFoundError if old node does not exist', () => {
    const { backend, db } = freshBackend();
    expect(() => backend.supersede(99999, 'new', {})).toThrow(NodeNotFoundError);
    db.close();
  });
});

// ─── invalidate ───────────────────────────────────────────────────────────────

describe('invalidate', () => {
  it('sets t_invalid on the node', () => {
    const { backend, db } = freshBackend();
    const id = backend.writeNode('test', {});
    backend.invalidate(id, 'obsolete');
    const node = backend.getNode(id);
    expect(node!.tInvalid).toBeTruthy();
    db.close();
  });

  it('node no longer appears in queryNodes', () => {
    const { backend, db } = freshBackend();
    const id = backend.writeNode('test', {});
    backend.invalidate(id);
    const results = backend.queryNodes();
    expect(results).toHaveLength(0);
    db.close();
  });

  it('getNode still returns the invalidated node', () => {
    const { backend, db } = freshBackend();
    const id = backend.writeNode('test', {});
    backend.invalidate(id, 'reason');
    const node = backend.getNode(id);
    expect(node).not.toBeNull();
    expect(node!.tInvalid).toBeTruthy();
    db.close();
  });

  it('throws NodeNotFoundError for missing node', () => {
    const { backend, db } = freshBackend();
    expect(() => backend.invalidate(99999)).toThrow(NodeNotFoundError);
    db.close();
  });

  it('stores reason in metadata', () => {
    const { backend, db } = freshBackend();
    const id = backend.writeNode('test', {});
    backend.invalidate(id, 'my reason');
    const node = backend.getNode(id);
    expect(node!.metadata).toBeDefined();
    expect((node!.metadata as Record<string, unknown>).invalidatedReason).toBe('my reason');
    db.close();
  });
});

// ─── touch ────────────────────────────────────────────────────────────────────

describe('touch', () => {
  it('updates mutable fields on a live node', () => {
    const { backend, db } = freshBackend();
    const id = backend.writeNode('original', {
      name: 'before',
      importance: 1.0,
    });

    backend.touch(id, {
      name: 'after',
      tags: ['updated'],
      importance: 8.0,
      confidence: 'confirmed',
      tExpires: new Date(Date.now() + 3600000).toISOString(),
      metadata: { touched: true },
    });

    const node = backend.getNode(id);
    expect(node!.name).toBe('after');
    expect(node!.tags).toEqual(['updated']);
    expect(node!.importance).toBe(8.0);
    expect(node!.confidence).toBe('confirmed');
    expect(node!.tExpires).toBeTruthy();
    expect(node!.metadata).toEqual({ touched: true });
    expect(node!.content).toBe('original');
    db.close();
  });

  it('does not change tCreated', () => {
    const { backend, db } = freshBackend();
    const id = backend.writeNode('test', {});
    const before = backend.getNode(id)!.tCreated;
    backend.touch(id, { name: 'renamed' });
    expect(backend.getNode(id)!.tCreated).toBe(before);
    db.close();
  });

  it('throws NodeNotFoundError on invalidated node', () => {
    const { backend, db } = freshBackend();
    const id = backend.writeNode('test', {});
    backend.invalidate(id);
    expect(() => backend.touch(id, { name: 'nope' })).toThrow(NodeNotFoundError);
    db.close();
  });

  it('throws NodeNotFoundError on missing node', () => {
    const { backend, db } = freshBackend();
    expect(() => backend.touch(99999, { name: 'nope' })).toThrow(NodeNotFoundError);
    db.close();
  });

  it('updates summary and topic', () => {
    const { backend, db } = freshBackend();
    const id = backend.writeNode('test', {});
    backend.touch(id, { summary: 'new summary', topic: 'new topic' });
    const node = backend.getNode(id);
    expect(node!.summary).toBe('new summary');
    expect(node!.topic).toBe('new topic');
    db.close();
  });

  it('removes tags when empty array passed', () => {
    const { backend, db } = freshBackend();
    const id = backend.writeNode('test', { tags: ['old'] });
    backend.touch(id, { tags: [] });
    const node = backend.getNode(id);
    expect(node!.tags).toEqual([]);
    db.close();
  });
});

// ─── writeNodeBatch ───────────────────────────────────────────────────────────

describe('writeNodeBatch', () => {
  it('returns IDs for all nodes', () => {
    const { backend, db } = freshBackend();
    const ids = backend.writeNodeBatch([
      { content: 'a', meta: {} },
      { content: 'b', meta: {} },
      { content: 'c', meta: {} },
    ]);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBeGreaterThan(0);
    expect(ids[1]).toBeGreaterThan(0);
    expect(ids[2]).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(3);
    db.close();
  });

  it('all or nothing on error', () => {
    const { backend, db } = freshBackend();
    // First insert a node so the batch has a dedup plus new nodes
    backend.writeNode('existing', {});
    try {
      backend.writeNodeBatch([
        { content: 'new1', meta: {} },
        { content: 'existing', meta: {} },
        { content: 'new2', meta: {} },
      ]);
    } catch {
      // Should not throw — dedup just returns existing ID
    }
    // All 3 should be committed atomically via transaction
    expect(backend.countNodes()).toBe(3);
    db.close();
  });
});

// ─── writeGraph ───────────────────────────────────────────────────────────────

describe('writeGraph', () => {
  it('writes nodes and edges atomically', () => {
    const { backend, db } = freshBackend();
    const ids = backend.writeGraph(
      [
        { content: 'node a', meta: { name: 'A' } },
        { content: 'node b', meta: { name: 'B' } },
      ],
      [
        { srcIdx: 0, dstIdx: 1, rel: 'MENTIONS' },
      ],
    );
    expect(ids).toHaveLength(2);

    const edges = backend.getEdges({});
    expect(edges).toHaveLength(1);
    expect(edges[0]!.src).toBe(ids[0]);
    expect(edges[0]!.dst).toBe(ids[1]);
    db.close();
  });

  it('throws ConstraintError for out-of-range srcIdx', () => {
    const { backend, db } = freshBackend();
    expect(() =>
      backend.writeGraph(
        [{ content: 'a', meta: {} }],
        [{ srcIdx: 5, dstIdx: 0, rel: 'MENTIONS' }],
      ),
    ).toThrow(ConstraintError);
    db.close();
  });

  it('all-or-nothing: no partial writes on error', () => {
    const { backend, db } = freshBackend();
    try {
      backend.writeGraph(
        [{ content: 'a', meta: {} }],
        [{ srcIdx: 0, dstIdx: 5, rel: 'MENTIONS' }],
      );
    } catch {
      // expected
    }
    expect(backend.countNodes()).toBe(0);
    db.close();
  });
});

// ─── writeEdge ────────────────────────────────────────────────────────────────

describe('writeEdge', () => {
  it('creates an edge between two nodes', () => {
    const { backend, db } = freshBackend();
    const srcId = backend.writeNode('src', {});
    const dstId = backend.writeNode('dst', {});

    backend.writeEdge(srcId, dstId, 'MENTIONS');

    const edges = backend.getEdges({});
    expect(edges).toHaveLength(1);
    expect(edges[0]!.src).toBe(srcId);
    expect(edges[0]!.dst).toBe(dstId);
    expect(edges[0]!.rel).toBe('MENTIONS');
    db.close();
  });

  it('is idempotent (upsert)', () => {
    const { backend, db } = freshBackend();
    const srcId = backend.writeNode('src', {});
    const dstId = backend.writeNode('dst', {});

    backend.writeEdge(srcId, dstId, 'MENTIONS', { weight: 1.0 });
    backend.writeEdge(srcId, dstId, 'MENTIONS', { weight: 2.0 });

    const edges = backend.getEdges({});
    expect(edges).toHaveLength(1);
    // The weight should be updated by upsert
    const edge = backend.getEdges({ src: srcId, dst: dstId, rel: 'MENTIONS' });
    expect(edge).toHaveLength(1);
    db.close();
  });

  it('rejects unknown rel values (CHECK constraint)', () => {
    const { backend, db } = freshBackend();
    const srcId = backend.writeNode('src', {});
    const dstId = backend.writeNode('dst', {});
    expect(() => backend.writeEdge(srcId, dstId, 'INVALID_REL' as EdgeRel)).toThrow(
      ConstraintError,
    );
    db.close();
  });

  it('rejects edge with non-existent nodes (FK constraint)', () => {
    const { backend, db } = freshBackend();
    const srcId = backend.writeNode('src', {});
    expect(() => backend.writeEdge(srcId, 99999, 'MENTIONS')).toThrow(ConstraintError);
    db.close();
  });

  it('stores edge metadata', () => {
    const { backend, db } = freshBackend();
    const srcId = backend.writeNode('src', {});
    const dstId = backend.writeNode('dst', {});
    backend.writeEdge(srcId, dstId, 'SUPPORTS', {
      metadata: { reason: 'test', confidence: 0.9 },
    });

    const edges = backend.getEdges({});
    expect(edges).toHaveLength(1);
    expect(edges[0]!.metadata).toEqual({ reason: 'test', confidence: 0.9 });
    db.close();
  });
});

// ─── getNode ──────────────────────────────────────────────────────────────────

describe('getNode', () => {
  it('returns null for missing node', () => {
    const { backend, db } = freshBackend();
    expect(backend.getNode(99999)).toBeNull();
    db.close();
  });

  it('returns node with derived isStale', () => {
    const { backend, db } = freshBackend();
    const past = new Date(Date.now() - 60000).toISOString();
    const id = backend.writeNode('stale node', { tExpires: past });
    const node = backend.getNode(id);
    expect(node!.isStale).toBe(true);
    db.close();
  });

  it('returns invalidated node (never deletes)', () => {
    const { backend, db } = freshBackend();
    const id = backend.writeNode('test', {});
    backend.invalidate(id);
    const node = backend.getNode(id);
    expect(node).not.toBeNull();
    expect(node!.tInvalid).toBeTruthy();
    db.close();
  });
});

// ─── queryNodes ───────────────────────────────────────────────────────────────

describe('queryNodes', () => {
  it('returns only live nodes by default', () => {
    const { backend, db } = freshBackend();
    backend.writeNode('live1', {});
    const id2 = backend.writeNode('live2', {});
    backend.invalidate(id2);
    const results = backend.queryNodes();
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toBe('live1');
    db.close();
  });

  it('filters by topic (string)', () => {
    const { backend, db } = freshBackend();
    backend.writeNode('a', { topic: 'foo' });
    backend.writeNode('b', { topic: 'bar' });
    backend.writeNode('c', { topic: 'foo' });

    const results = backend.queryNodes({ topic: 'foo' });
    expect(results).toHaveLength(2);
    db.close();
  });

  it('filters by topic (array)', () => {
    const { backend, db } = freshBackend();
    backend.writeNode('a', { topic: 'foo' });
    backend.writeNode('b', { topic: 'bar' });
    backend.writeNode('c', { topic: 'baz' });

    const results = backend.queryNodes({ topic: ['foo', 'bar'] });
    expect(results).toHaveLength(2);
    db.close();
  });

  it('filters by tags (ANY)', () => {
    const { backend, db } = freshBackend();
    backend.writeNode('a', { tags: ['tag1', 'tag2'] });
    backend.writeNode('b', { tags: ['tag2', 'tag3'] });
    backend.writeNode('c', { tags: ['tag3'] });

    const results = backend.queryNodes({ tags: ['tag1'] });
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toBe('a');
    db.close();
  });

  it('filters by tags (ALL)', () => {
    const { backend, db } = freshBackend();
    backend.writeNode('a', { tags: ['tag1', 'tag2'] });
    backend.writeNode('b', { tags: ['tag2', 'tag3'] });
    backend.writeNode('c', { tags: ['tag1'] });

    const results = backend.queryNodes({ tags: ['tag1', 'tag2'], tagsMatchAll: true });
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toBe('a');
    db.close();
  });

  it('filters by importanceMin', () => {
    const { backend, db } = freshBackend();
    backend.writeNode('low', { importance: 3.0 });
    backend.writeNode('high', { importance: 8.0 });
    backend.writeNode('mid', { importance: 5.0 });

    const results = backend.queryNodes({ importanceMin: 5.0 });
    expect(results).toHaveLength(2);
    db.close();
  });

  it('filters by namespace', () => {
    const { backend, db } = freshBackend();
    backend.writeNode('global', { namespace: 'global' });
    backend.writeNode('ns1', { namespace: 'ns-one' });
    backend.writeNode('ns2', { namespace: 'ns-one' });

    const results = backend.queryNodes({ namespace: 'ns-one' });
    expect(results).toHaveLength(2);
    db.close();
  });

  it('filters by confidence (single)', () => {
    const { backend, db } = freshBackend();
    backend.writeNode('a', { confidence: 'confirmed' });
    backend.writeNode('b', { confidence: 'unverified' });
    backend.writeNode('c', { confidence: 'disputed' });

    const results = backend.queryNodes({ confidence: 'confirmed' });
    expect(results).toHaveLength(1);
    db.close();
  });

  it('filters by confidence (array, OR)', () => {
    const { backend, db } = freshBackend();
    backend.writeNode('a', { confidence: 'confirmed' });
    backend.writeNode('b', { confidence: 'unverified' });
    backend.writeNode('c', { confidence: 'disputed' });

    const results = backend.queryNodes({ confidence: ['confirmed', 'disputed'] });
    expect(results).toHaveLength(2);
    db.close();
  });

  it('filters by tCreatedAfter / tCreatedBefore', () => {
    const { backend, db } = freshBackend();
    const id1 = backend.writeNode('old', {});
    const t1 = backend.getNode(id1)!.tCreated;
    const id2 = backend.writeNode('new', {});
    const t2 = backend.getNode(id2)!.tCreated;

    const after = backend.queryNodes({ tCreatedAfter: t2 });
    expect(after.length).toBeGreaterThanOrEqual(1);

    const before = backend.queryNodes({ tCreatedBefore: t1 });
    expect(before.length).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it('filters by isStale', () => {
    const { backend, db } = freshBackend();
    const past = new Date(Date.now() - 60000).toISOString();
    const future = new Date(Date.now() + 60000).toISOString();

    backend.writeNode('stale', { tExpires: past });
    backend.writeNode('fresh', { tExpires: future });
    backend.writeNode('noexpiry', {});

    const staleOnly = backend.queryNodes({ isStale: true });
    expect(staleOnly).toHaveLength(1);
    expect(staleOnly[0]!.content).toBe('stale');

    const freshOnly = backend.queryNodes({ isStale: false });
    expect(freshOnly).toHaveLength(2);
    db.close();
  });

  it('honors limit and offset', () => {
    const { backend, db } = freshBackend();
    backend.writeNode('a', {});
    backend.writeNode('b', {});
    backend.writeNode('c', {});
    backend.writeNode('d', {});

    const results = backend.queryNodes({ limit: 2, offset: 1 });
    expect(results).toHaveLength(2);
    db.close();
  });

  it('orders by importance desc', () => {
    const { backend, db } = freshBackend();
    backend.writeNode('low', { importance: 1.0 });
    backend.writeNode('high', { importance: 10.0 });
    backend.writeNode('mid', { importance: 5.0 });

    const results = backend.queryNodes({ orderBy: 'importance', orderDir: 'desc' });
    expect(results[0]!.importance).toBeGreaterThanOrEqual(results[1]!.importance ?? 0);
    expect(results[1]!.importance).toBeGreaterThanOrEqual(results[2]!.importance ?? 0);
    db.close();
  });

  it('orders by tCreated', () => {
    const { backend, db } = freshBackend();
    backend.writeNode('first', {});
    backend.writeNode('second', {});
    backend.writeNode('third', {});

    const asc = backend.queryNodes({ orderBy: 'tCreated', orderDir: 'asc' });
    expect(asc.length).toBe(3);
    expect(new Date(asc[0]!.tCreated).getTime()).toBeLessThanOrEqual(
      new Date(asc[2]!.tCreated).getTime(),
    );

    const desc = backend.queryNodes({ orderBy: 'tCreated', orderDir: 'desc' });
    expect(new Date(desc[0]!.tCreated).getTime()).toBeGreaterThanOrEqual(
      new Date(desc[2]!.tCreated).getTime(),
    );
    db.close();
  });

  it('filters by ids', () => {
    const { backend, db } = freshBackend();
    const id1 = backend.writeNode('a', {});
    const id2 = backend.writeNode('b', {});
    backend.writeNode('c', {});

    const results = backend.queryNodes({ ids: [id1, id2] });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.content).sort()).toEqual(['a', 'b']);
    db.close();
  });

  it('validAt honors bi-temporal point-in-time', () => {
    const { backend, db } = freshBackend();
    const id = backend.writeNode('test', {});
    const node = backend.getNode(id)!;

    const results = backend.queryNodes({ validAt: node.tValid });
    expect(results.length).toBeGreaterThanOrEqual(1);

    const past = new Date(Date.now() - 86400000 * 365).toISOString();
    const none = backend.queryNodes({ validAt: past });
    expect(none).toHaveLength(0);
    db.close();
  });

  it('metadataFilter works', () => {
    const { backend, db } = freshBackend();
    backend.writeNode('a', { metadata: { status: 'active', priority: 1 } });
    backend.writeNode('b', { metadata: { status: 'inactive', priority: 2 } });

    const results = backend.queryNodes({
      metadata: { status: 'active' },
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toBe('a');
    db.close();
  });
});

// ─── searchNodes ──────────────────────────────────────────────────────────────

describe('searchNodes', () => {
  it('returns scored results', () => {
    const { backend, db } = freshBackend();
    backend.writeNode('apple banana cherry', { name: 'fruits' });
    backend.writeNode('dog elephant fox', { name: 'animals' });
    backend.writeNode('apple cider vinegar', {});

    const results = backend.searchNodes('apple');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.score).toBeDefined();
    expect(typeof results[0]!.score).toBe('number');
    db.close();
  });

  it('respects limit', () => {
    const { backend, db } = freshBackend();
    backend.writeNode('apple 1', {});
    backend.writeNode('apple 2', {});
    backend.writeNode('apple 3', {});

    const results = backend.searchNodes('apple', { limit: 2 });
    expect(results).toHaveLength(2);
    db.close();
  });

  it('applies NodeFilter', () => {
    const { backend, db } = freshBackend();
    backend.writeNode('apple tech', { topic: 'tech' });
    backend.writeNode('apple food', { topic: 'food' });

    const results = backend.searchNodes('apple', {
      filter: { topic: 'tech' },
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.topic).toBe('tech');
    db.close();
  });

  it('filters out invalidated nodes', () => {
    const { backend, db } = freshBackend();
    backend.writeNode('apple exists', {});
    const id = backend.writeNode('apple gone', {});
    backend.invalidate(id);

    const results = backend.searchNodes('apple');
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toBe('apple exists');
    db.close();
  });
});

// ─── countNodes ───────────────────────────────────────────────────────────────

describe('countNodes', () => {
  it('counts live nodes', () => {
    const { backend, db } = freshBackend();
    backend.writeNode('a', {});
    backend.writeNode('b', {});
    const id = backend.writeNode('c', {});
    backend.invalidate(id);

    expect(backend.countNodes()).toBe(2);
    db.close();
  });

  it('counts with filter', () => {
    const { backend, db } = freshBackend();
    backend.writeNode('a', { topic: 'foo' });
    backend.writeNode('b', { topic: 'foo' });
    backend.writeNode('c', { topic: 'bar' });

    expect(backend.countNodes({ topic: 'foo' })).toBe(2);
    db.close();
  });
});

// ─── getSupersessionChain ─────────────────────────────────────────────────────

describe('getSupersessionChain', () => {
  it('returns chain from oldest to newest', () => {
    const { backend, db } = freshBackend();
    const v1 = backend.writeNode('v1', { name: 'v1' });
    const v2 = backend.supersede(v1, 'v2', { name: 'v2' });
    const v3 = backend.supersede(v2, 'v3', { name: 'v3' });

    const chain = backend.getSupersessionChain(v2);
    expect(chain).toHaveLength(3);
    expect(chain[0]!.name).toBe('v1');
    expect(chain[1]!.name).toBe('v2');
    expect(chain[2]!.name).toBe('v3');
    db.close();
  });

  it('returns chain from newest node', () => {
    const { backend, db } = freshBackend();
    const v1 = backend.writeNode('v1', { name: 'v1' });
    const v2 = backend.supersede(v1, 'v2', { name: 'v2' });
    const v3 = backend.supersede(v2, 'v3', { name: 'v3' });

    const chain = backend.getSupersessionChain(v3);
    expect(chain).toHaveLength(3);
    expect(chain[0]!.name).toBe('v1');
    db.close();
  });

  it('returns single node for unversioned node', () => {
    const { backend, db } = freshBackend();
    const id = backend.writeNode('solo', { name: 'only' });
    const chain = backend.getSupersessionChain(id);
    expect(chain).toHaveLength(1);
    expect(chain[0]!.name).toBe('only');
    db.close();
  });

  it('includes invalidated nodes', () => {
    const { backend, db } = freshBackend();
    const v1 = backend.writeNode('v1', { name: 'v1' });
    const v2 = backend.supersede(v1, 'v2', { name: 'v2' });
    // Manually invalidate v1 for testing
    backend.invalidate(v1);

    const chain = backend.getSupersessionChain(v2);
    expect(chain).toHaveLength(2);
    expect(chain[0]!.tInvalid).toBeTruthy();
    db.close();
  });
});

// ─── getEdges ─────────────────────────────────────────────────────────────────

describe('getEdges', () => {
  it('filters by src', () => {
    const { backend, db } = freshBackend();
    const a = backend.writeNode('a', {});
    const b = backend.writeNode('b', {});
    const c = backend.writeNode('c', {});
    backend.writeEdge(a, b, 'MENTIONS');
    backend.writeEdge(a, c, 'MENTIONS');

    const edges = backend.getEdges({ src: a });
    expect(edges).toHaveLength(2);
    db.close();
  });

  it('filters by dst', () => {
    const { backend, db } = freshBackend();
    const a = backend.writeNode('a', {});
    const b = backend.writeNode('b', {});
    const c = backend.writeNode('c', {});
    backend.writeEdge(a, b, 'MENTIONS');
    backend.writeEdge(c, b, 'SUPPORTS');

    const edges = backend.getEdges({ dst: b });
    expect(edges).toHaveLength(2);
    db.close();
  });

  it('filters by rel', () => {
    const { backend, db } = freshBackend();
    const a = backend.writeNode('a', {});
    const b = backend.writeNode('b', {});
    const c = backend.writeNode('c', {});
    backend.writeEdge(a, b, 'MENTIONS');
    backend.writeEdge(a, c, 'SUPPORTS');

    const edges = backend.getEdges({ rel: 'MENTIONS' });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.rel).toBe('MENTIONS');
    db.close();
  });
});

// ─── getNeighbors ─────────────────────────────────────────────────────────────

describe('getNeighbors', () => {
  it('returns out-neighbors by default', () => {
    const { backend, db } = freshBackend();
    const a = backend.writeNode('a', {});
    const b = backend.writeNode('b', {});
    const c = backend.writeNode('c', {});
    backend.writeGraph(
      [
        { content: 'a', meta: {} },
        { content: 'b', meta: {} },
        { content: 'c', meta: {} },
      ],
      [
        { srcIdx: 0, dstIdx: 1, rel: 'MENTIONS' },
        { srcIdx: 0, dstIdx: 2, rel: 'RELATES_TO' },
      ],
    );
    const ids = backend.queryNodes().map((n) => n.id);
    const aId = ids.find((id) => backend.getNode(id)!.content === 'a')!;

    const neighbors = backend.getNeighbors(aId);
    expect(neighbors).toHaveLength(2);
    db.close();
  });

  it('returns in-neighbors with direction: in', () => {
    const { backend, db } = freshBackend();
    const a = backend.writeNode('a', {});
    const b = backend.writeNode('b', {});
    const c = backend.writeNode('c', {});
    backend.writeEdge(a, b, 'MENTIONS');
    backend.writeEdge(c, b, 'MENTIONS');

    const neighbors = backend.getNeighbors(b, { direction: 'in' });
    expect(neighbors).toHaveLength(2);
    db.close();
  });

  it('returns both with direction: both', () => {
    const { backend, db } = freshBackend();
    const a = backend.writeNode('a', {});
    const b = backend.writeNode('b', {});
    const c = backend.writeNode('c', {});
    backend.writeEdge(a, b, 'MENTIONS');
    backend.writeEdge(b, c, 'RELATES_TO');

    const neighbors = backend.getNeighbors(b, { direction: 'both' });
    // a→b→c, so from b: out=c, in=a
    expect(neighbors).toHaveLength(2);
    db.close();
  });

  it('filters by rel', () => {
    const { backend, db } = freshBackend();
    const a = backend.writeNode('a', {});
    const b = backend.writeNode('b', {});
    const c = backend.writeNode('c', {});
    backend.writeEdge(a, b, 'MENTIONS');
    backend.writeEdge(a, c, 'SUPPORTS');

    const neighbors = backend.getNeighbors(a, { rel: 'MENTIONS' });
    expect(neighbors).toHaveLength(1);
    db.close();
  });

  it('handles depth > 1', () => {
    const { backend, db } = freshBackend();
    const ids = backend.writeGraph(
      [
        { content: 'root', meta: {} },
        { content: 'mid', meta: {} },
        { content: 'leaf', meta: {} },
      ],
      [
        { srcIdx: 0, dstIdx: 1, rel: 'RELATES_TO' },
        { srcIdx: 1, dstIdx: 2, rel: 'RELATES_TO' },
      ],
    );
    const rootId = ids[0];

    const d1 = backend.getNeighbors(rootId, { depth: 1 });
    expect(d1).toHaveLength(1);

    const d2 = backend.getNeighbors(rootId, { depth: 2 });
    expect(d2).toHaveLength(2);
    db.close();
  });

  it('returns empty for depth 0', () => {
    const { backend, db } = freshBackend();
    const a = backend.writeNode('a', {});
    const b = backend.writeNode('b', {});
    backend.writeEdge(a, b, 'MENTIONS');

    expect(backend.getNeighbors(a, { depth: 0 })).toHaveLength(0);
    db.close();
  });
});

// ─── getNeighborsWithEdges ────────────────────────────────────────────────────

describe('getNeighborsWithEdges', () => {
  it('returns node and edge for each neighbor', () => {
    const { backend, db } = freshBackend();
    const a = backend.writeNode('a', {});
    const b = backend.writeNode('b', {});
    backend.writeEdge(a, b, 'MENTIONS', { weight: 0.5 });

    const results = backend.getNeighborsWithEdges(a);
    expect(results).toHaveLength(1);
    expect(results[0]!.node.content).toBe('b');
    expect(results[0]!.edge.rel).toBe('MENTIONS');
    db.close();
  });

  it('handles direction: both', () => {
    const { backend, db } = freshBackend();
    const a = backend.writeNode('a', {});
    const b = backend.writeNode('b', {});
    backend.writeEdge(a, b, 'MENTIONS');
    backend.writeEdge(b, a, 'RELATES_TO');

    const results = backend.getNeighborsWithEdges(b, { direction: 'both' });
    expect(results).toHaveLength(2);
    db.close();
  });
});

// ─── isReachable ──────────────────────────────────────────────────────────────

describe('isReachable', () => {
  it('returns true for direct connection', () => {
    const { backend, db } = freshBackend();
    const a = backend.writeNode('a', {});
    const b = backend.writeNode('b', {});
    backend.writeEdge(a, b, 'RELATES_TO');

    expect(backend.isReachable(a, b)).toBe(true);
    db.close();
  });

  it('returns true for transitive connection', () => {
    const { backend, db } = freshBackend();
    const ids = backend.writeGraph(
      [
        { content: 'root', meta: {} },
        { content: 'mid', meta: {} },
        { content: 'leaf', meta: {} },
      ],
      [
        { srcIdx: 0, dstIdx: 1, rel: 'RELATES_TO' },
        { srcIdx: 1, dstIdx: 2, rel: 'RELATES_TO' },
      ],
    );

    expect(backend.isReachable(ids[0]!, ids[2]!)).toBe(true);
    db.close();
  });

  it('returns false for unreachable nodes', () => {
    const { backend, db } = freshBackend();
    const a = backend.writeNode('a', {});
    const b = backend.writeNode('b', {});
    const c = backend.writeNode('c', {});
    backend.writeEdge(a, b, 'RELATES_TO');

    expect(backend.isReachable(a, c)).toBe(false);
    db.close();
  });

  it('works in reverse direction', () => {
    const { backend, db } = freshBackend();
    const a = backend.writeNode('a', {});
    const b = backend.writeNode('b', {});
    backend.writeEdge(a, b, 'RELATES_TO');

    expect(backend.isReachable(b, a, { direction: 'in' })).toBe(true);
    expect(backend.isReachable(b, a, { direction: 'out' })).toBe(false);
    db.close();
  });

  it('filters by rel', () => {
    const { backend, db } = freshBackend();
    const a = backend.writeNode('a', {});
    const b = backend.writeNode('b', {});
    backend.writeEdge(a, b, 'MENTIONS');

    expect(backend.isReachable(a, b, { rel: 'MENTIONS' })).toBe(true);
    expect(backend.isReachable(a, b, { rel: 'SUPPORTS' })).toBe(false);
    db.close();
  });

  it('is cycle-safe', () => {
    const { backend, db } = freshBackend();
    const a = backend.writeNode('a', {});
    const b = backend.writeNode('b', {});
    backend.writeEdge(a, b, 'RELATES_TO');
    backend.writeEdge(b, a, 'RELATES_TO');

    expect(backend.isReachable(a, b)).toBe(true);
    expect(backend.isReachable(b, a)).toBe(true);
    db.close();
  });
});

// ─── getSubgraph ──────────────────────────────────────────────────────────────

describe('getSubgraph', () => {
  it('returns nodes and edges reachable from root', () => {
    const { backend, db } = freshBackend();
    const ids = backend.writeGraph(
      [
        { content: 'root', meta: {} },
        { content: 'child1', meta: {} },
        { content: 'child2', meta: {} },
        { content: 'leaf', meta: {} },
      ],
      [
        { srcIdx: 0, dstIdx: 1, rel: 'RELATES_TO' },
        { srcIdx: 0, dstIdx: 2, rel: 'RELATES_TO' },
        { srcIdx: 1, dstIdx: 3, rel: 'RELATES_TO' },
      ],
    );

    const subgraph = backend.getSubgraph(ids[0]!);
    expect(subgraph.nodes).toHaveLength(4);
    expect(subgraph.edges.length).toBeGreaterThanOrEqual(3);
    db.close();
  });

  it('handles depth limit', () => {
    const { backend, db } = freshBackend();
    const ids = backend.writeGraph(
      [
        { content: 'root', meta: {} },
        { content: 'mid', meta: {} },
        { content: 'leaf', meta: {} },
      ],
      [
        { srcIdx: 0, dstIdx: 1, rel: 'RELATES_TO' },
        { srcIdx: 1, dstIdx: 2, rel: 'RELATES_TO' },
      ],
    );

    const subgraph = backend.getSubgraph(ids[0]!, { depth: 1 });
    expect(subgraph.nodes).toHaveLength(2);
    db.close();
  });

  it('handles direction: in', () => {
    const { backend, db } = freshBackend();
    const ids = backend.writeGraph(
      [
        { content: 'root', meta: {} },
        { content: 'mid', meta: {} },
        { content: 'leaf', meta: {} },
      ],
      [
        { srcIdx: 0, dstIdx: 1, rel: 'RELATES_TO' },
        { srcIdx: 1, dstIdx: 2, rel: 'RELATES_TO' },
      ],
    );

    // From 'leaf' (ids[2]), direction:in should traverse backward
    const subgraph = backend.getSubgraph(ids[2]!, { direction: 'in' });
    expect(subgraph.nodes).toHaveLength(3);
    db.close();
  });

  it('is cycle-safe', () => {
    const { backend, db } = freshBackend();
    const ids = backend.writeGraph(
      [
        { content: 'a', meta: {} },
        { content: 'b', meta: {} },
      ],
      [
        { srcIdx: 0, dstIdx: 1, rel: 'RELATES_TO' },
        { srcIdx: 1, dstIdx: 0, rel: 'RELATES_TO' },
      ],
    );

    const subgraph = backend.getSubgraph(ids[0]!);
    expect(subgraph.nodes).toHaveLength(2);
    expect(subgraph.edges).toHaveLength(2);
    db.close();
  });

  it('filters by rel', () => {
    const { backend, db } = freshBackend();
    const ids = backend.writeGraph(
      [
        { content: 'root', meta: {} },
        { content: 'mentioned', meta: {} },
        { content: 'related', meta: {} },
      ],
      [
        { srcIdx: 0, dstIdx: 1, rel: 'MENTIONS' },
        { srcIdx: 0, dstIdx: 2, rel: 'RELATES_TO' },
      ],
    );

    const subgraph = backend.getSubgraph(ids[0]!, { rel: 'MENTIONS' });
    expect(subgraph.nodes).toHaveLength(2); // root + mentioned
    db.close();
  });
});

// ─── Namespace isolation ──────────────────────────────────────────────────────

describe('namespace isolation', () => {
  it('queryNodes with namespace only returns matching nodes', () => {
    const { backend, db } = freshBackend();
    backend.writeNode('a', { namespace: 'ns-a' });
    backend.writeNode('b', { namespace: 'ns-b' });
    backend.writeNode('c', { namespace: 'ns-a' });

    const resultsA = backend.queryNodes({ namespace: 'ns-a' });
    expect(resultsA).toHaveLength(2);

    const resultsB = backend.queryNodes({ namespace: 'ns-b' });
    expect(resultsB).toHaveLength(1);
    db.close();
  });

  it('no namespace filter returns all', () => {
    const { backend, db } = freshBackend();
    backend.writeNode('a', { namespace: 'ns-a' });
    backend.writeNode('b', { namespace: 'ns-b' });

    expect(backend.queryNodes()).toHaveLength(2);
    db.close();
  });
});

// ─── Migration runner ──────────────────────────────────────────────────────────

/**
 * Minimal v1 schema DDL — represents the schema before any migration.
 * No level/resume_state on node, no t_expired on edge, old CHECK
 * constraints (no 'generic' kind, no 'DEPENDS_ON' rel).
 */
const V1_NODE_DDL = `CREATE TABLE IF NOT EXISTS node (
  rowid        INTEGER PRIMARY KEY,
  uid          TEXT UNIQUE NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('episode','entity','claim','community','session')),
  content      TEXT,
  name         TEXT,
  summary      TEXT,
  topic        TEXT,
  tags         TEXT,
  importance   REAL DEFAULT 1.0,
  confidence   REAL,
  content_hash TEXT,
  namespace    TEXT DEFAULT 'global',
  meta         TEXT,
  agent_id     TEXT,
  session_id   TEXT,
  source       TEXT CHECK (source IN ('message','tool_output','observation','document','reflection','import')),
  project_path TEXT,
  t_occurred   TEXT,
  t_expires    TEXT,
  t_created    TEXT NOT NULL,
  t_valid      TEXT,
  t_invalid    TEXT,
  is_superseded INTEGER DEFAULT 0,
  access_count INTEGER DEFAULT 0,
  last_access  TEXT,
  t_updated    TEXT
)`;

const V1_EDGE_DDL = `CREATE TABLE IF NOT EXISTS edge (
  rowid     INTEGER PRIMARY KEY,
  src       INTEGER NOT NULL REFERENCES node(rowid) ON DELETE CASCADE,
  dst       INTEGER NOT NULL REFERENCES node(rowid) ON DELETE CASCADE,
  rel       TEXT NOT NULL CHECK (rel IN ('MENTIONS','SUPPORTS','RELATES_TO','SUPERSEDES','DERIVED_FROM','MEMBER_OF','PART_OF','SAME_AS','ASSIGNED_TO')),
  weight    REAL DEFAULT 1.0,
  confidence REAL,
  origin    TEXT CHECK (origin IN ('extracted','inferred','user_asserted')),
  meta      TEXT,
  t_created TEXT NOT NULL,
  t_valid   TEXT,
  t_invalid TEXT
)`;

const V1_FTS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS fts_node USING fts5(content, name, summary,
  content='node', content_rowid='rowid', tokenize='unicode61')`;

const V1_FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS fts_node_ai AFTER INSERT ON node BEGIN
  INSERT INTO fts_node(rowid, content, name, summary)
    VALUES (new.rowid, new.content, new.name, new.summary);
END;
CREATE TRIGGER IF NOT EXISTS fts_node_ad AFTER DELETE ON node BEGIN
  INSERT INTO fts_node(fts_node, rowid, content, name, summary)
    VALUES ('delete', old.rowid, old.content, old.name, old.summary);
END;
CREATE TRIGGER IF NOT EXISTS fts_node_au AFTER UPDATE ON node BEGIN
  INSERT INTO fts_node(fts_node, rowid, content, name, summary)
    VALUES ('delete', old.rowid, old.content, old.name, old.summary);
  INSERT INTO fts_node(rowid, content, name, summary)
    VALUES (new.rowid, new.content, new.name, new.summary);
END;
`;

const V1_INDEXES = [
  `CREATE INDEX IF NOT EXISTS ix_node_kind       ON node(kind)`,
  `CREATE INDEX IF NOT EXISTS ix_node_hash       ON node(content_hash)`,
  `CREATE INDEX IF NOT EXISTS ix_node_agent      ON node(agent_id)`,
  `CREATE INDEX IF NOT EXISTS ix_node_session    ON node(session_id)`,
  `CREATE INDEX IF NOT EXISTS ix_node_validity   ON node(t_invalid) WHERE t_invalid IS NULL`,
  `CREATE INDEX IF NOT EXISTS ix_node_importance ON node(importance)`,
  `CREATE INDEX IF NOT EXISTS ix_node_temporal   ON node(t_invalid, t_created DESC) WHERE t_invalid IS NULL`,
  `CREATE INDEX IF NOT EXISTS ix_node_topic      ON node(topic) WHERE topic IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS ix_node_project    ON node(project_path) WHERE project_path IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS ix_node_namespace  ON node(namespace)`,
  `CREATE INDEX IF NOT EXISTS ix_node_expires    ON node(t_expires) WHERE t_expires IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS ix_edge_src        ON edge(src, rel)`,
  `CREATE INDEX IF NOT EXISTS ix_edge_dst        ON edge(dst, rel)`,
  `CREATE INDEX IF NOT EXISTS ix_edge_live       ON edge(t_invalid) WHERE t_invalid IS NULL`,
];

/**
 * Create a database with the v1 schema (no migrations applied).
 * Returns an open Database handle. The caller must close it.
 */
function createV1Store(): Database.Database {
  const db = new Database(':memory:');
  for (const pragma of PRAGMAS) {
    db.exec(pragma);
  }
  db.exec(V1_NODE_DDL);
  db.exec(V1_EDGE_DDL);
  db.exec(V1_FTS_DDL);
  db.exec(V1_FTS_TRIGGERS);
  for (const idx of V1_INDEXES) {
    db.exec(idx);
  }
  // Rebuild FTS index for any pre-existing data
  db.exec(
    `INSERT INTO fts_node(rowid, content, name, summary)
     SELECT rowid, content, name, summary FROM node`,
  );
  return db;
}

describe('migrations', () => {
  it('v1→latest migration: preserves data and adds all columns', () => {
    const db = createV1Store();

    // Seed a row before migration
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO node (uid, kind, content, name, t_created)
       VALUES (?, 'episode', ?, ?, ?)`,
    ).run('test-uid-1', 'original content', 'test-name', now);

    // Also insert a v1 edge (without t_expired column — old store)
    db.prepare(
      `INSERT INTO edge (src, dst, rel, t_created)
       VALUES (1, 1, 'MENTIONS', ?)`,
    ).run(now);

    // Apply schema with Drizzle migration
    const backend = new SqliteGraphBackend(db);
    backend.applySchema();

    // Row survived
    const row1 = db.prepare(`SELECT * FROM node WHERE rowid = 1`).get() as Record<string, unknown>;
    expect(row1).not.toBeUndefined();
    expect(row1!.uid).toBe('test-uid-1');
    expect(row1!.content).toBe('original content');

    // New columns exist on node
    for (const col of ['level', 'resume_state']) {
      const ci = db
        .prepare(`SELECT * FROM pragma_table_info('node') WHERE name = ?`)
        .get(col) as { name: string } | undefined;
      expect(ci).toBeDefined();
    }

    // New column exists on edge
    const tExpiredCol = db
      .prepare(`SELECT * FROM pragma_table_info('edge') WHERE name = 't_expired'`)
      .get() as { name: string } | undefined;
    expect(tExpiredCol).toBeDefined();

    // ix_edge_unique index exists
    const uniqueIndex = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name='ix_edge_unique'`,
      )
      .get() as { name: string } | undefined;
    expect(uniqueIndex).toBeDefined();

    // Schema migration tracking table exists
    const drizzleMigrations = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'`)
      .get() as { name: string } | undefined;
    expect(drizzleMigrations).toBeDefined();

    db.close();
  });

  it('v1→latest migration: kind=generic is accepted after migration', () => {
    const db = createV1Store();
    const backend = new SqliteGraphBackend(db);
    backend.applySchema();

    // Attempt to insert a node with kind='generic' (would fail under old CHECK
    // on v1 store). The migration should have updated the CHECK constraint.
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO node (uid, kind, content, t_created)
       VALUES (?, ?, ?, ?)`,
    ).run('generic-uid-1', 'generic', 'generic content', now);

    const row = db.prepare(`SELECT uid, kind FROM node WHERE uid = 'generic-uid-1'`).get() as {
      uid: string;
      kind: string;
    };
    expect(row).toBeDefined();
    expect(row.kind).toBe('generic');

    db.close();
  });

  it('v1→latest migration: DEPENDS_ON edge is accepted after migration', () => {
    const db = createV1Store();
    const backend = new SqliteGraphBackend(db);
    backend.applySchema();

    // Insert two nodes first
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO node (uid, kind, content, t_created)
       VALUES (?, 'episode', ?, ?)`,
    ).run('dep-src-1', 'source node', now);
    db.prepare(
      `INSERT INTO node (uid, kind, content, t_created)
       VALUES (?, 'episode', ?, ?)`,
    ).run('dep-dst-1', 'target node', now);

    // Insert edge with DEPENDS_ON (would fail under old CHECK on v1 store)
    db.prepare(
      `INSERT INTO edge (src, dst, rel, t_created)
       VALUES (1, 2, 'DEPENDS_ON', ?)`,
    ).run(now);

    const edgeRow = db.prepare(`SELECT * FROM edge WHERE rel = 'DEPENDS_ON'`).get() as {
      src: number;
      dst: number;
      rel: string;
    };
    expect(edgeRow).toBeDefined();
    expect(edgeRow.rel).toBe('DEPENDS_ON');

    db.close();
  });

  it('Drizzle __drizzle_migrations table is created and tracked', () => {
    const db = createV1Store();

    // Verify __drizzle_migrations does not exist yet
    let tbl = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'`)
      .get() as { name: string } | undefined;
    expect(tbl).toBeUndefined();

    // Apply schema — Drizzle creates and stamps the migration
    const backend = new SqliteGraphBackend(db);
    backend.applySchema();

    // __drizzle_migrations now exists and has one entry
    tbl = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'`)
      .get() as { name: string } | undefined;
    expect(tbl).toBeDefined();

    const rows = db
      .prepare(`SELECT * FROM __drizzle_migrations`)
      .all() as Array<{ hash: string; created_at: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);

    db.close();
  });

  it('re-applying schema is idempotent', () => {
    const db = createV1Store();

    const backend = new SqliteGraphBackend(db);
    backend.applySchema(); // first call

    // Count migration rows before second call
    const rowsBefore = db
      .prepare(`SELECT COUNT(*) AS cnt FROM __drizzle_migrations`)
      .get() as { cnt: number };

    backend.applySchema(); // second call — should be no-op (schemaApplied guard)

    const rowsAfter = db
      .prepare(`SELECT COUNT(*) AS cnt FROM __drizzle_migrations`)
      .get() as { cnt: number };
    expect(rowsAfter.cnt).toBe(rowsBefore.cnt);

    // All CHECK constraints still work after idempotent re-apply
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO node (uid, kind, content, t_created)
       VALUES (?, 'generic', ?, ?)`,
    ).run('idempotent-generic', 'generic content', now);

    db.close();
  });
});
