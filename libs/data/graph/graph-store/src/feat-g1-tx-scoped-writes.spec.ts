import { describe, it, expect, afterEach } from 'vitest';
import { SqliteAdapterImpl } from '@adhd/sox-store-adapter';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createGraphBackend,
  ConstraintError,
  DEFAULT_TYPE_POLICY,
} from './index.js';
import type { GraphBackend, NodeMeta, TypePolicy } from './index.js';

/**
 * G1 (FEAT-SOXGRAPH-001) — tx-scoped write primitives.
 *
 * Before G1, `GraphBackend.transaction()` handed out only the raw
 * `AdapterTransaction`, and every typed write primitive (`writeNode`,
 * `writeEdge`, `invalidateEdge`, `touch`, `getNodeByUid`, …) ran against
 * `this.adapter`. A consumer composing an atomic multi-op write therefore had
 * to hand-compose the library's own INSERT column lists against the tx handle.
 *
 * G1 changes the callback parameter to a `GraphTransaction` — a structural
 * superset of `AdapterTransaction` that ADDS typed, tx-bound graph primitives.
 * These specs drive that surface the way a consumer does and pin the
 * behaviours that make it worth publishing.
 */

const permissivePolicy: TypePolicy = { validateKind() {}, validateRel() {} };

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function freshBackend(
  policy: TypePolicy = permissivePolicy,
): Promise<{ adapter: StoreAdapter; backend: GraphBackend }> {
  const adapter = new SqliteAdapterImpl(':memory:');
  const backend = createGraphBackend(adapter, { typePolicy: policy });
  await backend.applySchema();
  return { adapter, backend };
}

/** Two independent adapters over ONE on-disk store — the minimal rig for a
 *  cross-connection (serialization / negative-control) proof. */
async function twoConnections(policy: TypePolicy = permissivePolicy): Promise<{
  adapterA: StoreAdapter;
  backendA: GraphBackend;
  adapterB: StoreAdapter;
  backendB: GraphBackend;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'g1-tx-'));
  tmpDirs.push(dir);
  const dbPath = join(dir, 'g1.db');

  const adapterA = new SqliteAdapterImpl(dbPath);
  const backendA = createGraphBackend(adapterA, { typePolicy: policy });
  await backendA.applySchema();

  const adapterB = new SqliteAdapterImpl(dbPath);
  // A contending BEGIN must fail fast rather than block the event loop: this is
  // what makes the serialization assertion deterministic with no sleeps.
  await adapterB.pragmaSet('busy_timeout', 0);
  const backendB = createGraphBackend(adapterB, { typePolicy: policy });
  return { adapterA, backendA, adapterB, backendB };
}

/** Deferred signal — resolve/reject from anywhere, await where you need it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

// ── rollback / commit ────────────────────────────────────────────────────────

describe('G1 tx-scoped writes: rollback and commit', () => {
  it('rolls back every tx-scoped write when the callback throws', async () => {
    const { backend } = await freshBackend();
    await expect(
      backend.transaction(async (tx) => {
        await tx.writeNode('g1-a', { kind: 'issue', name: 'a' });
        await tx.writeNode('g1-b', { kind: 'issue', name: 'b' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await backend.countNodes({ kind: 'issue' })).toBe(0);
  });

  it('commits tx-scoped node + edge writes on success', async () => {
    const { backend } = await freshBackend();
    const id = await backend.transaction(async (tx) => {
      const issue = await tx.writeNode('g1-content', { kind: 'issue', name: 'i1' });
      const open = await tx.findOrCreateNode('status', 'OPEN');
      await tx.writeEdge(issue, open, 'MEMBER_OF');
      return issue;
    });
    expect(await backend.getNode(id)).not.toBeNull();
    expect((await backend.getEdges({ src: id })).length).toBe(1);
  });

  it('tx.getEdges sees this transaction\u2019s uncommitted edge writes (CAS read)', async () => {
    const { backend } = await freshBackend();
    await backend.transaction(async (tx) => {
      const a = await tx.writeNode('a', { kind: 'issue', name: 'a' });
      const b = await tx.writeNode('b', { kind: 'issue', name: 'b' });
      await tx.writeEdge(a, b, 'RELATES_TO');
      const seen = await tx.getEdges({ src: a, dst: b, rel: 'RELATES_TO' });
      expect(seen.length).toBe(1);
    });
  });

  it('rolls back a tx-scoped invalidateEdge together with the rest of the transaction', async () => {
    const { backend } = await freshBackend();
    const a = await backend.writeNode('a', { kind: 'issue', name: 'a' });
    const b = await backend.writeNode('b', { kind: 'issue', name: 'b' });
    await backend.writeEdge(a, b, 'RELATES_TO');

    await expect(
      backend.transaction(async (tx) => {
        await tx.invalidateEdge(a, b, 'RELATES_TO', 'rolled back');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // The edge must still be live — the invalidation was inside the rolled-back tx.
    expect((await backend.getEdges({ src: a })).length).toBe(1);
  });

  it('rolls back a tx-scoped touch', async () => {
    const { backend } = await freshBackend();
    const id = await backend.writeNode('a', { kind: 'issue', name: 'original' });
    await expect(
      backend.transaction(async (tx) => {
        await tx.touch(id, { name: 'renamed' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await backend.getNode(id))?.name).toBe('original');
  });
});

// ── structural compatibility with the old callback shape ─────────────────────

describe('G1 tx-scoped writes: existing raw-tx callbacks keep working', () => {
  it('the callback receives the tx-scoped graph view, not the bare AdapterTransaction', async () => {
    const { backend } = await freshBackend();
    await backend.transaction(async (tx) => {
      const surface = tx as unknown as Record<string, unknown>;
      for (const m of [
        'writeNode', 'findOrCreateNode', 'supersede', 'invalidate', 'touch',
        'writeEdge', 'invalidateEdge', 'writeNodeBatch', 'writeGraph', 'writeEdges',
        'getNode', 'getNodeByUid', 'getEdges', 'getNodesByIds',
        // raw AdapterTransaction surface is preserved alongside the typed one
        'executeGet', 'executeAll', 'executeRun', 'exec',
      ]) {
        expect(typeof surface[m]).toBe('function');
      }
    });
  });

  it('a callback using only the raw AdapterTransaction surface still compiles and works', async () => {
    const { backend } = await freshBackend();
    const id = await backend.writeNode('raw-tx', { kind: 'issue', name: 'raw' });
    const seen = await backend.transaction(async (tx) => {
      // The pre-G1 usage: hand-composed SQL on the tx handle.
      const row = await tx.executeGet<{ cnt: number }>(
        'SELECT COUNT(*) AS cnt FROM node WHERE rowid = ?', [id],
      );
      return row?.cnt ?? 0;
    });
    expect(seen).toBe(1);
  });
});

// ── ADR-0010 D2 — the injected write-boundary policy still runs ──────────────

describe('G1 tx-scoped writes: write-boundary policy is not bypassed (ADR-0010 D2)', () => {
  it('tx.writeNode validates kind through the injected TypePolicy and rolls back', async () => {
    const { backend } = await freshBackend(DEFAULT_TYPE_POLICY);
    await expect(
      backend.transaction(async (tx) => {
        await tx.writeNode('valid', { kind: 'episode', name: 'ok' });
        // 'issue' is outside DEFAULT_NODE_KINDS — the tx-bound path must reject
        // it exactly like the bare writeNode does, never a raw SQL CHECK failure.
        await tx.writeNode('invalid', { kind: 'issue', name: 'nope' });
      }),
    ).rejects.toBeInstanceOf(ConstraintError);
    expect(await backend.countNodes({ kind: 'episode' })).toBe(0);
  });

  it('tx.writeNode runs the injected NodeUniquenessPolicy inside the transaction', async () => {
    let policyRan = false;
    const adapter = new SqliteAdapterImpl(':memory:');
    const backend = createGraphBackend(adapter, {
      typePolicy: permissivePolicy,
      uniquenessPolicy: {
        async check() {
          policyRan = true;
          throw new ConstraintError('unique-policy-rejected');
        },
      },
    });
    await backend.applySchema();
    await expect(
      backend.transaction(async (tx) => {
        await tx.writeNode('x', { kind: 'issue', name: 'x' });
      }),
    ).rejects.toBeInstanceOf(ConstraintError);
    expect(policyRan).toBe(true);
    expect(await backend.countNodes({ kind: 'issue' })).toBe(0);
  });
});

// ── bulk paths are tx-safe (no nested transaction) ───────────────────────────

describe('G1 tx-scoped writes: bulk paths compose without a nested transaction', () => {
  it('tx.writeGraph and tx.writeEdges run inside the caller\u2019s transaction', async () => {
    const { backend } = await freshBackend();
    const result = await backend.transaction(async (tx) => {
      const ids = await tx.writeGraph(
        [
          { content: 'n1', meta: { kind: 'issue', name: 'n1' } },
          { content: 'n2', meta: { kind: 'issue', name: 'n2' } },
        ],
        [{ srcIdx: 0, dstIdx: 1, rel: 'RELATES_TO' }],
      );
      await tx.writeEdges([{ src: ids[0]!, dst: ids[1]!, rel: 'MENTIONS' }]);
      return ids;
    });
    expect((await backend.getEdges({ src: result[0]! })).length).toBe(2);
  });

  it('tx.writeGraph rolls back with the outer transaction', async () => {
    const { backend } = await freshBackend();
    await expect(
      backend.transaction(async (tx) => {
        await tx.writeGraph(
          [{ content: 'x1', meta: { kind: 'issue', name: 'x1' } }],
          [],
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await backend.countNodes({ kind: 'issue' })).toBe(0);
  });

  it('the bare writeGraph still works standalone (owns its own transaction)', async () => {
    const { backend } = await freshBackend();
    const ids = await backend.writeGraph(
      [{ content: 'solo', meta: { kind: 'issue', name: 'solo' } }],
      [],
    );
    expect(ids).toHaveLength(1);
    expect(await backend.getNode(ids[0]!)).not.toBeNull();
  });
});

// ── parity: tx-scoped write == bare write ────────────────────────────────────

describe('G1 tx-scoped writes: row parity with the bare write path', () => {
  it('a tx-scoped writeNode and a bare writeNode produce identical deterministic rows', async () => {
    const { backend, adapter } = await freshBackend();
    const meta: NodeMeta = {
      kind: 'issue',
      name: 'parity',
      summary: 'same',
      topic: 't',
      tags: ['x', 'y'],
      importance: 3,
      confidence: 'confirmed',
      namespace: 'global',
      metadata: { k: 'v' },
      agentId: 'agent-1',
      sessionId: 'sess-1',
      source: 'message',
      projectPath: 'p/x',
    };

    const bareId = await backend.writeNode('parity-content', meta, { skipDedupe: true });
    const txId = await backend.transaction(async (tx) =>
      tx.writeNode('parity-content', meta, { skipDedupe: true }),
    );

    // Columns that legitimately differ between two distinct inserts: identity
    // (uid, rowid) and wall-clock stamps. Everything else must match byte-for-byte.
    const columns = [
      'kind', 'content', 'name', 'summary', 'topic', 'tags', 'importance',
      'confidence', 'content_hash', 'namespace', 'meta', 'agent_id',
      'session_id', 'source', 'project_path', 'level', 'resume_state',
      't_expires', 't_invalid', 'is_superseded', 'access_count', 'last_access',
    ];
    const select = columns.join(', ');
    const bare = await adapter.executeGet<Record<string, unknown>>(
      `SELECT ${select} FROM node WHERE rowid = ?`, [bareId],
    );
    const viaTx = await adapter.executeGet<Record<string, unknown>>(
      `SELECT ${select} FROM node WHERE rowid = ?`, [txId],
    );
    expect(viaTx).toEqual(bare);
  });
});

// ── BEGIN IMMEDIATE serialization across connections ─────────────────────────

describe('G1 tx-scoped writes: BEGIN IMMEDIATE serializes across connections', () => {
  it('a second immediate transaction cannot enter while the first holds the lock, then succeeds', async () => {
    const { backendA, backendB, adapterA } = await twoConnections();

    const started = deferred();
    const release = deferred();

    // tx1: BEGIN IMMEDIATE, one write, then hold the lock until `release`.
    const tx1 = backendA.transaction(
      async (tx) => {
        await tx.writeNode('hold-A', { kind: 'issue', name: 'holdA' });
        started.resolve();
        await release.promise;
        await tx.writeNode('hold-B', { kind: 'issue', name: 'holdB' });
      },
      { mode: 'immediate' },
    );

    await started.promise; // tx1 has begun and written; the write lock is held.

    // tx2 (a DIFFERENT connection) must NOT be able to start an immediate tx.
    let enteredWhileHeld = false;
    const tx2Attempt = backendB
      .transaction(async (tx) => {
        enteredWhileHeld = true;
        await tx.writeNode('contend-C', { kind: 'issue', name: 'contendC' });
      }, { mode: 'immediate' })
      .then(() => 'committed' as const, (err: unknown) => err);

    const outcome = await tx2Attempt;
    expect(enteredWhileHeld).toBe(false); // never entered the body
    expect(outcome).toBeInstanceOf(Error); // contended → rejected, not silently interleaved

    // Release tx1; it must commit cleanly.
    release.resolve();
    await tx1;

    // Now the same second connection succeeds.
    await backendB.transaction(
      async (tx) => {
        await tx.writeNode('after-C', { kind: 'issue', name: 'afterC' });
      },
      { mode: 'immediate' },
    );

    // Both writers' committed rows are present — serialized, nothing lost.
    const names = (await adapterA.executeAll<{ name: string }>(
      'SELECT name FROM node WHERE kind = ? ORDER BY name', ['issue'],
    )).rows.map((r) => r.name);
    expect(names).toEqual(['afterC', 'holdA', 'holdB']);
  });
});

// ── negative control — the rollback assertion has teeth ──────────────────────

describe('G1 tx-scoped writes: negative control', () => {
  it('a write issued on a DIFFERENT connection survives the rollback — proving the test discriminates', async () => {
    const { backendA, backendB } = await twoConnections();

    // Deliberately non-tx variant: the write reaches a SEPARATE adapter, not the
    // transaction handle — the exact shape the pre-G1 API forced on consumers.
    await expect(
      backendA.transaction(async () => {
        await backendB.writeNode('negative-control', { kind: 'issue', name: 'nc' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // It SURVIVED the rollback. If a future regression routed tx.writeNode back
    // through a bare adapter, the positive assertions above would go red exactly
    // as this one shows they can.
    expect(await backendB.countNodes({ name: 'nc' })).toBe(1);

    // Contrast: the tx-scoped write does NOT survive.
    await expect(
      backendA.transaction(async (tx) => {
        await tx.writeNode('tx-scoped', { kind: 'issue', name: 'txscoped' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await backendA.countNodes({ name: 'txscoped' })).toBe(0);
  });
});
