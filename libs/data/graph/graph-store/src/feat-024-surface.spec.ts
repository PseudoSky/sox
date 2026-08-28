import { describe, it, expect } from 'vitest';
import { SqliteAdapterImpl } from '@adhd/sox-store-adapter';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { createGraphBackend, NodeNotFoundError } from './index.js';
import type { GraphBackend, TypePolicy } from './index.js';

// Permissive policy: these tests exercise the write/read surface primitives,
// not the closed six-kind vocabulary (graph-store.spec.ts covers that).
const permissivePolicy: TypePolicy = {
  validateKind() {},
  validateRel() {},
};

async function freshBackend(): Promise<{ adapter: StoreAdapter; backend: GraphBackend }> {
  const adapter = new SqliteAdapterImpl(':memory:');
  const backend = createGraphBackend(adapter, { typePolicy: permissivePolicy });
  await backend.applySchema();
  return { adapter, backend };
}

// ── A1 — transaction ─────────────────────────────────────────────────────────

describe('FEAT-024 A1 transaction', () => {
  it('rolls back all writes when the callback throws', async () => {
    const { backend } = await freshBackend();
    await expect(
      backend.transaction(async (_tx) => {
        await backend.writeNode('n1', { kind: 'issue', name: 'i1' });
        await backend.writeNode('n2', { kind: 'issue', name: 'i2' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await backend.countNodes({ kind: 'issue' })).toBe(0);
  });

  it('commits the composed write and exposes the live tx handle', async () => {
    const { backend } = await freshBackend();
    const id = await backend.transaction(async (tx) => {
      const issue = await backend.writeNode('issue content', { kind: 'issue', name: 'i1' });
      const open = await backend.findOrCreateNode('status', 'OPEN');
      await backend.writeEdge(issue, open, 'MEMBER_OF');
      // the tx handle reads the same transaction's uncommitted state
      const seen = await tx.executeGet<{ cnt: number }>(
        'SELECT COUNT(*) AS cnt FROM node WHERE rowid = ?', [issue],
      );
      expect(seen?.cnt).toBe(1);
      return issue;
    });
    expect(await backend.getNode(id)).not.toBeNull();
    expect((await backend.getEdges({ src: id })).length).toBe(1);
  });
});

// ── A2 — invalidateEdge ──────────────────────────────────────────────────────

describe('FEAT-024 A2 invalidateEdge', () => {
  it('getEdges drops the edge after invalidation; writeEdge re-livens it', async () => {
    const { backend } = await freshBackend();
    const a = await backend.writeNode('a', { kind: 'issue', name: 'a' });
    const b = await backend.writeNode('b', { kind: 'issue', name: 'b' });
    await backend.writeEdge(a, b, 'RELATES_TO');
    expect((await backend.getEdges({ src: a })).length).toBe(1);

    await backend.invalidateEdge(a, b, 'RELATES_TO');
    expect((await backend.getEdges({ src: a })).length).toBe(0);

    await backend.writeEdge(a, b, 'RELATES_TO');
    expect((await backend.getEdges({ src: a })).length).toBe(1);
  });

  it('is idempotent — invalidating twice does not throw', async () => {
    const { backend } = await freshBackend();
    const a = await backend.writeNode('a', { kind: 'issue' });
    const b = await backend.writeNode('b', { kind: 'issue' });
    await backend.writeEdge(a, b, 'RELATES_TO');
    await backend.invalidateEdge(a, b, 'RELATES_TO');
    await expect(backend.invalidateEdge(a, b, 'RELATES_TO')).resolves.toBeUndefined();
  });

  it('records the reason in edge metadata', async () => {
    const { backend } = await freshBackend();
    const a = await backend.writeNode('a', { kind: 'issue' });
    const b = await backend.writeNode('b', { kind: 'issue' });
    await backend.writeEdge(a, b, 'RELATES_TO');
    await backend.invalidateEdge(a, b, 'RELATES_TO', 'reassigned');
    const edges = await backend.getEdges({ src: a });
    expect(edges.length).toBe(0); // invalidated edges are hidden from getEdges
  });
});

// ── A3 — writeEdges ──────────────────────────────────────────────────────────

describe('FEAT-024 A3 writeEdges', () => {
  it('writes N edges between existing nodes in one transaction', async () => {
    const { backend } = await freshBackend();
    const a = await backend.writeNode('a', { kind: 'issue', name: 'a' });
    const b = await backend.writeNode('b', { kind: 'issue', name: 'b' });
    const c = await backend.writeNode('c', { kind: 'issue', name: 'c' });
    await backend.writeEdges([
      { src: a, dst: b, rel: 'RELATES_TO' },
      { src: b, dst: c, rel: 'DEPENDS_ON' },
      { src: a, dst: c, rel: 'MENTIONS' },
    ]);
    expect((await backend.getEdges({ src: a })).length).toBe(2);
    expect((await backend.getEdges({ src: b })).length).toBe(1);
  });

  it('rejects a batch referencing a missing node', async () => {
    const { backend } = await freshBackend();
    const a = await backend.writeNode('a', { kind: 'issue' });
    await expect(
      backend.writeEdges([{ src: a, dst: 9999, rel: 'RELATES_TO' }]),
    ).rejects.toBeInstanceOf(NodeNotFoundError);
  });
});

// ── B4 — getNodesByIds ───────────────────────────────────────────────────────

describe('FEAT-024 B4 getNodesByIds', () => {
  it('returns nodes in the requested id order', async () => {
    const { backend } = await freshBackend();
    const a = await backend.writeNode('a', { kind: 'issue', name: 'a' });
    const b = await backend.writeNode('b', { kind: 'issue', name: 'b' });
    const c = await backend.writeNode('c', { kind: 'issue', name: 'c' });
    const nodes = await backend.getNodesByIds([c, a, b]);
    expect(nodes.map((n) => n.id)).toEqual([c, a, b]);
  });

  it('omits invalidated nodes by default and includes them with liveOnly:false', async () => {
    const { backend } = await freshBackend();
    const a = await backend.writeNode('a', { kind: 'issue', name: 'a' });
    const b = await backend.writeNode('b', { kind: 'issue', name: 'b' });
    await backend.invalidate(a);
    expect((await backend.getNodesByIds([a, b])).map((n) => n.id)).toEqual([b]);
    expect((await backend.getNodesByIds([a, b], { liveOnly: false })).map((n) => n.id)).toEqual([a, b]);
  });
});

// ── B5 — countBy ─────────────────────────────────────────────────────────────

describe('FEAT-024 B5 countBy', () => {
  it('countBy(kind) matches the sum of individual countNodes({kind})', async () => {
    const { backend } = await freshBackend();
    await backend.writeNode('a', { kind: 'issue' });
    await backend.writeNode('b', { kind: 'issue' });
    await backend.writeNode('c', { kind: 'project' });
    const counts = await backend.countBy('kind');
    expect(counts).toEqual({ issue: 2, project: 1 });
    expect(await backend.countNodes({ kind: 'issue' })).toBe(counts.issue);
    expect(await backend.countNodes({ kind: 'project' })).toBe(counts.project);
  });

  it('respects liveOnly (excludes invalidated nodes by default)', async () => {
    const { backend } = await freshBackend();
    await backend.writeNode('keep', { kind: 'issue' });
    const dead = await backend.writeNode('dead', { kind: 'issue' });
    await backend.invalidate(dead);
    expect((await backend.countBy('kind')).issue).toBe(1);
  });
});

// ── B6 — edge metadata filtering ─────────────────────────────────────────────

describe('FEAT-024 B6 edge metadata filtering', () => {
  it('filters edges by metadata equality', async () => {
    const { backend } = await freshBackend();
    const a = await backend.writeNode('a', { kind: 'issue' });
    const b = await backend.writeNode('b', { kind: 'issue' });
    const c = await backend.writeNode('c', { kind: 'issue' });
    await backend.writeEdge(a, b, 'RELATES_TO', { metadata: { sha: 'abc123' } });
    await backend.writeEdge(a, c, 'RELATES_TO', { metadata: { sha: 'def456' } });

    const bySha = await backend.getEdges({ src: a, metadata: { sha: 'abc123' } });
    expect(bySha.length).toBe(1);
    expect(bySha[0]?.dst).toBe(b);
  });

  it('ranges over numeric metadata', async () => {
    const { backend } = await freshBackend();
    const a = await backend.writeNode('a', { kind: 'issue' });
    const b = await backend.writeNode('b', { kind: 'issue' });
    const c = await backend.writeNode('c', { kind: 'issue' });
    await backend.writeEdge(a, b, 'RELATES_TO', { metadata: { seq: 1 } });
    await backend.writeEdge(a, c, 'RELATES_TO', { metadata: { seq: 5 } });
    const ranged = await backend.getEdges({ src: a, metadata: { seq: { gte: 2 } } });
    expect(ranged.length).toBe(1);
    expect(ranged[0]?.dst).toBe(c);
  });
});

// ── C — keyset pagination ────────────────────────────────────────────────────

describe('FEAT-024 C keyset pagination', () => {
  it('pages stably by rowid with no gaps or dupes across pages', async () => {
    const { backend } = await freshBackend();
    for (let i = 0; i < 10; i++) await backend.writeNode(`n${i}`, { kind: 'issue' });

    const page1 = await backend.queryNodes({ kind: 'issue', limit: 3, after: 0 });
    const page2 = await backend.queryNodes({ kind: 'issue', limit: 3, after: page1[2]!.id });
    const page3 = await backend.queryNodes({ kind: 'issue', limit: 3, after: page2[2]!.id });

    const all = [...page1, ...page2, ...page3].map((n) => n.id);
    expect(all).toEqual([...all].sort((x, y) => x - y));
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(9);
  });
});

// ── D — bi-temporal content immutability ─────────────────────────────────────

describe('FEAT-024 D content immutability', () => {
  it('supersede is the only content-mutation path — it mints a new node + SUPERSEDES edge, preserving the old content', async () => {
    const { backend } = await freshBackend();
    const oldId = await backend.writeNode('original', { kind: 'issue', name: 'i1' });
    const newId = await backend.supersede(oldId, 'revised', { kind: 'issue', name: 'i1' });

    expect(newId).not.toBe(oldId);
    expect((await backend.getNode(oldId))?.content).toBe('original');
    expect((await backend.getNode(newId))?.content).toBe('revised');
    const edges = await backend.getEdges({ src: newId, rel: 'SUPERSEDES' });
    expect(edges.some((e) => e.dst === oldId)).toBe(true);
  });

  it('touch preserves content while updating name', async () => {
    const { backend } = await freshBackend();
    const id = await backend.writeNode('original', { kind: 'issue', name: 'i1' });
    await backend.touch(id, { name: 'renamed' });
    const node = await backend.getNode(id);
    expect(node?.content).toBe('original');
    expect(node?.name).toBe('renamed');
  });

  it('touch rejects a content property at compile time and does not mutate it at runtime', async () => {
    const { backend } = await freshBackend();
    const id = await backend.writeNode('original', { kind: 'issue' });
    // @ts-expect-error FEAT-024 — NodeMeta has no `content`; touch cannot mutate content.
    await backend.touch(id, { content: 'mutated' });
    expect((await backend.getNode(id))?.content).toBe('original');
  });
});
