/**
 * feat-023-policy-tx-scope.spec.ts — FEAT-023 (backlog ab760ab5).
 *
 * ## The contract
 *
 * `NodeUniquenessPolicy.check(meta, tx)` runs inside `writeNode` BEFORE the
 * INSERT, on the SAME handle the INSERT will use. The `tx` argument is the
 * point: inside `backend.transaction(...)` it is the LIVE transaction handle,
 * so the policy's `SELECT` observes rows this transaction has written but not
 * yet committed. A check-then-write composed through `tx` is therefore
 * atomic in one `BEGIN` (ADR-0012 §1) — the mechanism FEAT-023 promises.
 *
 * `transaction()` hands the callback a `GraphTransaction`, and its typed
 * `writeNode` delegates to the same policy-validating `writeNodeInTx` the bare
 * backend uses (`buildTxView`), so the injected policy runs at the write
 * boundary inside the transaction (ADR-0010 D2) — the tx path is not a
 * raw-SQL bypass.
 *
 * ## Teeth
 *
 * The first test FAILS if the `uniquenessPolicy.check(...)` call is removed
 * from `writeNodeInTx`: the second same-key write would then succeed, the
 * transaction would commit, and both `.rejects` and the rollback-to-0
 * assertions would be red. Negative control (recorded at closeout): comment
 * out the `this.uniquenessPolicy.check(meta, db)` call; the first test goes
 * RED; restore, and the suite is green again.
 */
import { describe, it, expect } from 'vitest';
import { SqliteAdapterImpl } from '@adhd/sox-store-adapter';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { createGraphBackend, ConstraintError } from './index.js';
import type { GraphBackend, TypePolicy, NodeUniquenessPolicy } from './index.js';

const permissivePolicy: TypePolicy = {
  validateKind: () => true,
  validateRel: () => true,
  validateEdge: () => true,
};

async function freshBackend(
  opts?: { uniquenessPolicy?: NodeUniquenessPolicy },
): Promise<{ backend: GraphBackend; adapter: StoreAdapter }> {
  const adapter = new SqliteAdapterImpl(':memory:');
  const backend = createGraphBackend(adapter, {
    typePolicy: permissivePolicy,
    ...(opts?.uniquenessPolicy !== undefined ? { uniquenessPolicy: opts.uniquenessPolicy } : {}),
  });
  await backend.applySchema();
  return { backend, adapter };
}

/** Flat-catalog policy: a (status, name) pair is unique. Reads through `tx`. */
function rejectDuplicateStatusPolicy(onSeen?: () => void): NodeUniquenessPolicy {
  return {
    async check(meta, tx) {
      if (meta.kind !== 'status' || meta.name === undefined) return;
      const dup = await tx.executeGet<{ rowid: number }>(
        'SELECT rowid FROM node WHERE kind = ? AND name = ? LIMIT 1',
        [meta.kind, meta.name],
      );
      if (dup) {
        onSeen?.();
        throw new ConstraintError(`Duplicate status "${meta.name}"`);
      }
    },
  };
}

describe('FEAT-023 — the uniqueness policy reads through the transaction handle', () => {
  it('a tx-aware policy sees an UNCOMMITTED sibling row, rejects the second same-key write, and the tx rolls back to 0', async () => {
    let sawUncommittedSibling = false;
    const { backend } = await freshBackend({
      uniquenessPolicy: rejectDuplicateStatusPolicy(() => { sawUncommittedSibling = true; }),
    });

    // Nothing is committed before the transaction — so the row the policy sees
    // below can only be the FIRST write of this transaction, still uncommitted.
    expect(await backend.countNodes({ kind: 'status', liveOnly: false })).toBe(0);

    await expect(
      backend.transaction(async (tx) => {
        await tx.writeNode('Open status', { kind: 'status', name: 'OPEN' });
        // Same (kind, name): the policy's SELECT runs on the tx handle and must
        // observe the row written immediately above (uncommitted) → reject.
        await tx.writeNode('Open status, again', { kind: 'status', name: 'OPEN' });
      }),
    ).rejects.toBeInstanceOf(ConstraintError);

    // The policy genuinely read tx-local state (not just committed rows).
    expect(sawUncommittedSibling).toBe(true);
    // The ConstraintError rolled back the WHOLE transaction — the first, would-be
    // row is gone too.
    expect(await backend.countNodes({ kind: 'status' })).toBe(0);
    expect(await backend.countNodes({ kind: 'status', liveOnly: false })).toBe(0);
  });

  it('with no policy the same-key write inside a transaction SUCCEEDS — the store enforces nothing itself', async () => {
    const { backend } = await freshBackend();

    await backend.transaction(async (tx) => {
      await tx.writeNode('one', { kind: 'status', name: 'OPEN' });
      await tx.writeNode('two', { kind: 'status', name: 'OPEN' });
    });

    expect(await backend.countNodes({ kind: 'status' })).toBe(2);
  });

  it('rollback is scoped to the failing transaction — an already-committed duplicate is untouched', async () => {
    const { backend } = await freshBackend({ uniquenessPolicy: rejectDuplicateStatusPolicy() });

    // First transaction commits a status row.
    await backend.transaction(async (tx) => {
      await tx.writeNode('committed', { kind: 'status', name: 'OPEN' });
    });
    expect(await backend.countNodes({ kind: 'status' })).toBe(1);

    // A SECOND transaction races the same key: the policy sees the COMMITTED row
    // across transactions, throws, and only this transaction rolls back.
    await expect(
      backend.transaction(async (tx) => {
        await tx.writeNode('contender', { kind: 'status', name: 'OPEN' });
      }),
    ).rejects.toBeInstanceOf(ConstraintError);

    expect(await backend.countNodes({ kind: 'status' })).toBe(1);
  });
});
