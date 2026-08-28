import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAdapterImpl, TursoAdapterImpl } from '@adhd/sox-store-adapter';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import {
  createGraphBackend,
  ConstraintError,
  NodeNotFoundError,
  DEFAULT_TYPE_POLICY,
} from './index.js';
import type { GraphBackend, TypePolicy, NodeRecord, NodeUniquenessPolicy } from './index.js';

// Default to a permissive policy: these tests exercise filter/sort/query
// mechanics over the v2 model's kinds, not the closed six-kind vocabulary (which
// graph-store.spec.ts already covers). DEFAULT_TYPE_POLICY is injected only
// where its validateEdge→validateRel delegation is the subject. Uniqueness
// (FEAT-023) is opt-in via `uniquenessPolicy` — without one the store enforces
// nothing.
async function freshBackend(
  opts?: { typePolicy?: TypePolicy; uniquenessPolicy?: NodeUniquenessPolicy },
): Promise<{ adapter: StoreAdapter; backend: GraphBackend }> {
  const adapter = new SqliteAdapterImpl(':memory:');
  const backend = createGraphBackend(adapter, {
    typePolicy: opts?.typePolicy ?? permissivePolicy,
    ...(opts?.uniquenessPolicy !== undefined ? { uniquenessPolicy: opts.uniquenessPolicy } : {}),
  });
  await backend.applySchema();
  return { adapter, backend };
}

function hasTursoDriver(): boolean {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
}

// ── FEAT-010 — NodeFilter.liveOnly ───────────────────────────────────────────

describe('FEAT-010 NodeFilter.liveOnly', () => {
  it('excludes invalidated nodes by default', async () => {
    const { backend } = await freshBackend();
    const live = await backend.writeNode('live', { kind: 'generic' });
    const dead = await backend.writeNode('dead', { kind: 'generic' });
    await backend.invalidate(dead);

    const ids = (await backend.queryNodes({ kind: 'generic' })).map((n) => n.id);
    expect(ids).toContain(live);
    expect(ids).not.toContain(dead);
    expect(await backend.countNodes({ kind: 'generic' })).toBe(1);
  });

  it('liveOnly:false includes invalidated nodes with tInvalid set', async () => {
    const { backend } = await freshBackend();
    const dead = await backend.writeNode('dead', { kind: 'generic' });
    await backend.invalidate(dead);

    const rows = await backend.queryNodes({ kind: 'generic', liveOnly: false });
    const deadRow = rows.find((n) => n.id === dead);
    expect(deadRow).toBeDefined();
    expect(deadRow!.tInvalid).toBeDefined();
    expect(await backend.countNodes({ kind: 'generic', liveOnly: false })).toBe(1);
  });

  it('default path compiles byte-identical SQL (liveOnly omitted)', async () => {
    // Indirect proof: a filter without liveOnly must still exclude tombstones —
    // the WHERE clause carries `t_invalid IS NULL` exactly as before.
    const { backend } = await freshBackend();
    const dead = await backend.writeNode('dead', { kind: 'generic' });
    await backend.invalidate(dead);
    expect(await backend.queryNodes({ kind: 'generic' })).toHaveLength(0);
  });
});

// ── FEAT-011 — name filter + findOrCreateNode ────────────────────────────────

describe('FEAT-011 name filter + findOrCreateNode', () => {
  it('filters by name equality and by IN-list', async () => {
    const { backend } = await freshBackend();
    await backend.writeNode('c1', { kind: 'generic', name: 'alpha' });
    await backend.writeNode('c2', { kind: 'generic', name: 'beta' });
    await backend.writeNode('c3', { kind: 'generic', name: 'gamma' });

    expect((await backend.queryNodes({ name: 'alpha' })).map((n) => n.name)).toEqual(['alpha']);
    const inNames = (await backend.queryNodes({ name: ['alpha', 'gamma'] })).map((n) => n.name).sort();
    expect(inNames).toEqual(['alpha', 'gamma']);
  });

  it('findOrCreateNode is idempotent', async () => {
    const { backend } = await freshBackend();
    const first = await backend.findOrCreateNode('status', 'OPEN', { content: 'open status' });
    const second = await backend.findOrCreateNode('status', 'OPEN', { content: 'open status' });
    expect(second).toBe(first);
    expect(await backend.countNodes({ kind: 'status', name: 'OPEN' })).toBe(1);
  });

  it('findOrCreateNode keeps distinct names with identical content distinct', async () => {
    const { backend } = await freshBackend();
    const a = await backend.findOrCreateNode('project', 'PseudoSky/adhd', { content: 'same' });
    const b = await backend.findOrCreateNode('project', 'PseudoSky/other', { content: 'same' });
    expect(a).not.toBe(b);
    expect(await backend.countNodes({ kind: 'project' })).toBe(2);
  });
});

// ── FEAT-023 — NodeUniquenessPolicy (replaces FEAT-012's unique index) ───────

const rejectDuplicateStatusPolicy: NodeUniquenessPolicy = {
  async check(meta, tx) {
    if (meta.kind !== 'status' || meta.name === undefined) return;
    const dup = await tx.executeGet<{ rowid: number }>(
      'SELECT rowid FROM node WHERE kind = ? AND name = ? LIMIT 1', [meta.kind, meta.name],
    );
    if (dup) throw new ConstraintError(`Duplicate status "${meta.name}"`);
  },
};

const componentWithinProjectPolicy: NodeUniquenessPolicy = {
  async check(meta, tx) {
    if (meta.kind !== 'component' || meta.name === undefined) return;
    const projectId = meta.metadata?.projectId;
    if (projectId === undefined) return;
    // Edge-scoped: a component name is unique within its owning project — read
    // through the MEMBER_OF edge. Expressible only via a policy; a column index
    // cannot express this (FEAT-023 acceptance 4).
    const dup = await tx.executeGet<{ rowid: number }>(
      `SELECT c.rowid FROM node c
        JOIN edge o ON o.src = c.rowid AND o.rel = 'MEMBER_OF'
       WHERE c.kind = 'component' AND c.name = ? AND o.dst = ?
       LIMIT 1`,
      [meta.name, projectId],
    );
    if (dup) throw new ConstraintError(`Duplicate component "${meta.name}" within project ${String(projectId)}`);
  },
};

describe('FEAT-023 NodeUniquenessPolicy', () => {
  it('with no policy, a second (kind, name) write SUCCEEDS — the store enforces nothing', async () => {
    const { backend } = await freshBackend();
    const a = await backend.writeNode('first', { kind: 'component', name: 'foo' });
    const b = await backend.writeNode('second', { kind: 'component', name: 'foo' });
    expect(b).not.toBe(a);
    expect(await backend.countNodes({ kind: 'component', name: 'foo' })).toBe(2);
  });

  it('an injected policy rejecting duplicate (status, OPEN) makes writeNode throw ConstraintError', async () => {
    const { backend } = await freshBackend({ uniquenessPolicy: rejectDuplicateStatusPolicy });
    await backend.writeNode('open', { kind: 'status', name: 'OPEN' });
    await expect(
      backend.writeNode('open-again', { kind: 'status', name: 'OPEN' }),
    ).rejects.toBeInstanceOf(ConstraintError);
  });

  it('the policy does not fire for kinds it does not guard', async () => {
    const { backend } = await freshBackend({ uniquenessPolicy: rejectDuplicateStatusPolicy });
    await backend.writeNode('c1', { kind: 'component', name: 'foo' });
    await backend.writeNode('c2', { kind: 'component', name: 'foo' });
    expect(await backend.countNodes({ kind: 'component', name: 'foo' })).toBe(2);
  });

  it('findOrCreateNode is idempotent without the index (SELECT-then-INSERT, single-writer)', async () => {
    const { backend } = await freshBackend();
    const id = await backend.findOrCreateNode('status', 'OPEN');
    expect(await backend.findOrCreateNode('status', 'OPEN')).toBe(id);
    expect(await backend.countNodes({ kind: 'status', name: 'OPEN' })).toBe(1);
  });

  it('an edge-scoped policy (component unique within project) is expressible via tx.executeGet', async () => {
    const { backend } = await freshBackend({ uniquenessPolicy: componentWithinProjectPolicy });
    const proj = await backend.writeNode('p', { kind: 'project', name: 'P1' });
    const otherProj = await backend.writeNode('q', { kind: 'project', name: 'P2' });

    const comp1 = await backend.writeNode('c', {
      kind: 'component', name: 'auth', metadata: { projectId: proj },
    });
    await backend.writeEdge(comp1, proj, 'MEMBER_OF');

    // same name in a DIFFERENT project is allowed
    const comp2 = await backend.writeNode('c2', {
      kind: 'component', name: 'auth', metadata: { projectId: otherProj },
    });
    await backend.writeEdge(comp2, otherProj, 'MEMBER_OF');

    // same name in the SAME project is rejected
    await expect(
      backend.writeNode('c3', { kind: 'component', name: 'auth', metadata: { projectId: proj } }),
    ).rejects.toBeInstanceOf(ConstraintError);
  });
});

// ── FEAT-013 — TypePolicy.validateEdge ───────────────────────────────────────

const edgePolicy: TypePolicy = {
  validateKind() { /* accept any kind in this test */ },
  validateRel() { /* accept any rel in this test */ },
  validateEdge(srcKind, rel, dstKind) {
    if (rel === 'DEPENDS_ON' && (srcKind !== 'component' || dstKind !== 'component')) {
      throw new ConstraintError(`depends_on requires component endpoints (got ${srcKind} -> ${dstKind})`);
    }
  },
};

// The DEFAULT_TYPE_POLICY enforces the closed six-kind vocabulary, so tests that
// exercise the v2 model's kinds (issue/project/component/status) inject a
// permissive policy — mirroring what the v2 application layer must do (FEAT-017).
const permissivePolicy: TypePolicy = {
  validateKind() {},
  validateRel() {},
};

describe('FEAT-013 TypePolicy.validateEdge', () => {
  it('rejects a rel between non-matching endpoint kinds', async () => {
    const { backend } = await freshBackend({ typePolicy: edgePolicy });
    const issue = await backend.writeNode('issue', { kind: 'issue' });
    const issue2 = await backend.writeNode('issue2', { kind: 'issue' });
    await expect(backend.writeEdge(issue, issue2, 'DEPENDS_ON')).rejects.toBeInstanceOf(ConstraintError);
  });

  it('accepts a rel between matching endpoint kinds', async () => {
    const { backend } = await freshBackend({ typePolicy: edgePolicy });
    const c1 = await backend.writeNode('c1', { kind: 'component' });
    const c2 = await backend.writeNode('c2', { kind: 'component' });
    await expect(backend.writeEdge(c1, c2, 'DEPENDS_ON')).resolves.toBeUndefined();
  });

  it('writeGraph validates with endpoint kinds (violating edge fails the batch)', async () => {
    const { backend } = await freshBackend({ typePolicy: edgePolicy });
    await expect(
      backend.writeGraph(
        [
          { content: 'i1', meta: { kind: 'issue' } },
          { content: 'i2', meta: { kind: 'issue' } },
        ],
        [{ srcIdx: 0, dstIdx: 1, rel: 'DEPENDS_ON' }],
      ),
    ).rejects.toBeInstanceOf(ConstraintError);
  });

  it('DEFAULT_TYPE_POLICY.validateEdge delegates to validateRel (closed vocabulary unchanged)', async () => {
    const { backend } = await freshBackend({ typePolicy: DEFAULT_TYPE_POLICY });
    const g1 = await backend.writeNode('g1', { kind: 'generic' });
    const g2 = await backend.writeNode('g2', { kind: 'generic' });
    await expect(backend.writeEdge(g1, g2, 'RELATES_TO')).resolves.toBeUndefined();
    // The default policy's validateEdge must still enforce the ten-rel vocabulary.
    await expect(backend.writeEdge(g1, g2, 'NOT_A_REL')).rejects.toBeInstanceOf(ConstraintError);
  });

  it('missing endpoint surfaces NodeNotFoundError', async () => {
    const { backend } = await freshBackend();
    const g = await backend.writeNode('g', { kind: 'generic' });
    await expect(backend.writeEdge(g, 999_999, 'RELATES_TO')).rejects.toBeInstanceOf(NodeNotFoundError);
  });
});

// ── FEAT-014 — metadata operators + generalized sort ─────────────────────────

describe('FEAT-014 metadata operators + sort', () => {
  it('range operators (gt/gte/lt/lte/between) on numeric metadata', async () => {
    const { backend } = await freshBackend();
    await backend.writeNode('p1', { kind: 'issue', metadata: { priority: 1 } });
    await backend.writeNode('p2', { kind: 'issue', metadata: { priority: 2 } });
    await backend.writeNode('p3', { kind: 'issue', metadata: { priority: 3 } });

    expect((await backend.queryNodes({ kind: 'issue', metadata: { priority: { gt: 1 } } })).length).toBe(2);
    expect((await backend.queryNodes({ kind: 'issue', metadata: { priority: { gte: 2 } } })).length).toBe(2);
    expect((await backend.queryNodes({ kind: 'issue', metadata: { priority: { lt: 3 } } })).length).toBe(2);
    expect((await backend.queryNodes({ kind: 'issue', metadata: { priority: { lte: 2 } } })).length).toBe(2);
    expect((await backend.queryNodes({ kind: 'issue', metadata: { priority: { between: [2, 3] } } })).length).toBe(2);
  });

  it('eq / neq / in / exists / contains', async () => {
    const { backend } = await freshBackend();
    await backend.writeNode('a', { kind: 'issue', metadata: { status: 'open', tags: ['x', 'y'] } });
    await backend.writeNode('b', { kind: 'issue', metadata: { status: 'closed', tags: ['z'] } });
    await backend.writeNode('c', { kind: 'issue', metadata: { status: 'open' } }); // no tags

    expect((await backend.queryNodes({ metadata: { status: { eq: 'open' } } })).length).toBe(2);
    expect((await backend.queryNodes({ metadata: { status: { neq: 'open' } } })).length).toBe(1);
    expect((await backend.queryNodes({ metadata: { status: { in: ['open', 'closed'] } } })).length).toBe(3);
    expect((await backend.queryNodes({ metadata: { tags: { exists: true } } })).length).toBe(2);
    expect((await backend.queryNodes({ metadata: { tags: { exists: false } } })).length).toBe(1);
    expect((await backend.queryNodes({ metadata: { tags: { contains: 'x' } } })).length).toBe(1);
  });

  it('eq:null / neq:null map to IS NULL / IS NOT NULL', async () => {
    const { backend } = await freshBackend();
    await backend.writeNode('has', { kind: 'generic', metadata: { note: 'hello' } });
    await backend.writeNode('none', { kind: 'generic' });
    expect((await backend.queryNodes({ metadata: { note: { eq: null } } })).length).toBe(1);
    expect((await backend.queryNodes({ metadata: { note: { neq: null } } })).length).toBe(1);
  });

  it('scalar metadata equality unchanged (back-compat)', async () => {
    const { backend } = await freshBackend();
    await backend.writeNode('a', { kind: 'issue', metadata: { repo: 'PseudoSky/adhd' } });
    await backend.writeNode('b', { kind: 'issue', metadata: { repo: 'Other/x' } });
    expect((await backend.queryNodes({ metadata: { repo: 'PseudoSky/adhd' } })).length).toBe(1);
  });

  it('sorts by a metadata key (asc and desc)', async () => {
    const { backend } = await freshBackend();
    await backend.writeNode('p1', { kind: 'issue', metadata: { priority: 1 } });
    await backend.writeNode('p3', { kind: 'issue', metadata: { priority: 3 } });
    await backend.writeNode('p2', { kind: 'issue', metadata: { priority: 2 } });

    const asc = await backend.queryNodes({ kind: 'issue', orderBy: { metadata: 'priority' }, orderDir: 'asc' });
    expect(asc.map((n) => n.metadata?.priority)).toEqual([1, 2, 3]);
    const desc = await backend.queryNodes({ kind: 'issue', orderBy: { metadata: 'priority' }, orderDir: 'desc' });
    expect(desc.map((n) => n.metadata?.priority)).toEqual([3, 2, 1]);
  });

  it('multi-key sort with per-key direction', async () => {
    const { backend } = await freshBackend();
    await backend.writeNode('a2', { kind: 'issue', metadata: { group: 'a', rank: 2 } });
    await backend.writeNode('a1', { kind: 'issue', metadata: { group: 'a', rank: 1 } });
    await backend.writeNode('b0', { kind: 'issue', metadata: { group: 'b', rank: 0 } });

    const rows = await backend.queryNodes({
      kind: 'issue',
      orderBy: [{ metadata: 'group' }, { metadata: 'rank' }],
      orderDir: ['asc', 'asc'],
    });
    expect(rows.map((n) => n.content)).toEqual(['a1', 'a2', 'b0']);
  });

  it('column sort back-compat (orderBy: string)', async () => {
    const { backend } = await freshBackend();
    await backend.writeNode('b', { kind: 'generic', name: 'b' });
    await backend.writeNode('a', { kind: 'generic', name: 'a' });
    const rows = await backend.queryNodes({ orderBy: 'name', orderDir: 'asc' });
    expect(rows.map((n) => n.name)).toEqual(['a', 'b']);
  });
});

// ── Turso parity (primary target) ────────────────────────────────────────────

describe('graph-store query-surface parity (turso)', () => {
  async function openTurso(
    opts?: { uniquenessPolicy?: NodeUniquenessPolicy },
  ): Promise<{ adapter: StoreAdapter; backend: GraphBackend }> {
    const dir = mkdtempSync(join(tmpdir(), 'graph-store-feat-'));
    const adapter = await TursoAdapterImpl.connect({ dbPath: join(dir, 't.db') });
    const backend = createGraphBackend(adapter, {
      typePolicy: permissivePolicy,
      ...(opts?.uniquenessPolicy !== undefined ? { uniquenessPolicy: opts.uniquenessPolicy } : {}),
    });
    await backend.applySchema();
    return { adapter, backend };
  }
  const skip = !hasTursoDriver();

  it('liveOnly + metadata range + sort agree on turso', { skip, timeout: 20000 }, async () => {
    const { adapter, backend } = await openTurso();
    try {
      await backend.writeNode('p1', { kind: 'issue', metadata: { priority: 1 } });
      await backend.writeNode('p3', { kind: 'issue', metadata: { priority: 3 } });
      await backend.writeNode('p2', { kind: 'issue', metadata: { priority: 2 } });
      const dead = await backend.writeNode('dead', { kind: 'issue', metadata: { priority: 0 } });
      await backend.invalidate(dead);

      const liveDesc = await backend.queryNodes({ kind: 'issue', orderBy: { metadata: 'priority' }, orderDir: 'desc' });
      expect(liveDesc.map((n) => n.metadata?.priority)).toEqual([3, 2, 1]);

      const withTombstones = await backend.queryNodes({ kind: 'issue', liveOnly: false, orderBy: { metadata: 'priority' }, orderDir: 'asc' });
      expect(withTombstones.map((n) => n.metadata?.priority)).toEqual([0, 1, 2, 3]);

      const gt1 = await backend.queryNodes({ kind: 'issue', metadata: { priority: { gt: 1 } } });
      expect(gt1.length).toBe(2);
    } finally {
      await adapter.close();
    }
  });

  it('uniqueness policy + findOrCreateNode on turso', { skip, timeout: 20000 }, async () => {
    const { adapter, backend } = await openTurso({ uniquenessPolicy: rejectDuplicateStatusPolicy });
    try {
      const id = await backend.findOrCreateNode('status', 'OPEN', { content: 'open' });
      expect(await backend.findOrCreateNode('status', 'OPEN')).toBe(id);
      // the injected policy still guards writeNode directly
      await expect(
        backend.writeNode('dup', { kind: 'status', name: 'OPEN' }),
      ).rejects.toBeInstanceOf(ConstraintError);
    } finally {
      await adapter.close();
    }
  });

  it('validateEdge resolves endpoint kinds on turso', { skip, timeout: 20000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'graph-store-feat-edge-'));
    const adapter = await TursoAdapterImpl.connect({ dbPath: join(dir, 't.db') });
    const backend = createGraphBackend(adapter, { typePolicy: edgePolicy });
    await backend.applySchema();
    try {
      const c1 = await backend.writeNode('c1', { kind: 'component' });
      const i1 = await backend.writeNode('i1', { kind: 'issue' });
      await expect(backend.writeEdge(c1, i1, 'DEPENDS_ON')).rejects.toBeInstanceOf(ConstraintError);
    } finally {
      await adapter.close();
    }
  });
});

// keep the imported NodeRecord referenced (parity of the shared NodeFilter type)
void (null as unknown as NodeRecord);
