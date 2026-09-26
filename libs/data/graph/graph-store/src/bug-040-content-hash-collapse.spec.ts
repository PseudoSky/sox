/**
 * bug-040-content-hash-collapse.spec.ts — BUG-040 (backlog 35fc20de).
 *
 * ## The defect
 *
 * `writeNode` deduped by a GLOBAL, case-insensitive content hash:
 * `hashContent = sha256(content.trim().toLowerCase())`, looked up as
 * `SELECT rowid FROM node WHERE content_hash = ?` with no `kind`/`name`
 * predicate (`index.ts` — `writeNodeInTx`). Distinct entity nodes of DIFFERENT
 * kinds whose content happened to be identical therefore collapsed onto one
 * row. Observed in the v2 ETL: project `unknown` collapsed onto status
 * `UNKNOWN`; 1339 transitions collapsed to 40; 7 identical-title issues lost.
 *
 * ## The fix
 *
 * `WriteNodeOpts.skipDedupe` (default `false`, back-compat) opts a write out of
 * the content-hash dedupe. Identity for entity/catalog rows is the DB-generated
 * `uid`; uniqueness — where a caller wants it — is consumer-declared via
 * `NodeUniquenessPolicy` (FEAT-023), never a global `(kind, name)` DDL index
 * (FEAT-012 was reverted, precisely because it collapses 7 identical-title
 * issues just as hard). `findOrCreateNode` keys on `(kind, name)` and always
 * writes its create branch with `skipDedupe: true`.
 *
 * ## Teeth
 *
 * Every assertion in the first three tests FAILS if the `skipDedupe` guard is
 * removed. Negative control (recorded at closeout): flip
 * `if (!opts?.skipDedupe)` to an unconditional dedupe in `writeNodeInTx`; the
 * first three tests go RED (each observes 1 row where 2/7/2 are expected),
 * while the two `DEFAULT`-dedupe tests stay green. Restore, and the suite is
 * green again.
 */
import { describe, it, expect } from 'vitest';
import { SqliteAdapterImpl } from '@adhd/sox-store-adapter';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { createGraphBackend } from './index.js';
import type { GraphBackend, TypePolicy } from './index.js';

const permissivePolicy: TypePolicy = {
  validateKind: () => true,
  validateRel: () => true,
  validateEdge: () => true,
};

async function freshBackend(): Promise<{ backend: GraphBackend; adapter: StoreAdapter }> {
  const adapter = new SqliteAdapterImpl(':memory:');
  const backend = createGraphBackend(adapter, { typePolicy: permissivePolicy });
  await backend.applySchema();
  return { backend, adapter };
}

describe('BUG-040 — skipDedupe keeps distinct entities distinct', () => {
  it('distinct docs of different kinds with identical content stay distinct (2 rows)', async () => {
    const { backend } = await freshBackend();

    // The exact incident shape: content `unknown` written for both a project and
    // a status. With the global content hash these collapsed to ONE row; with
    // skipDedupe they must be two.
    const project = await backend.writeNode(
      'unknown', { kind: 'project', name: 'unknown' }, { skipDedupe: true },
    );
    const status = await backend.writeNode(
      'unknown', { kind: 'status', name: 'unknown' }, { skipDedupe: true },
    );

    expect(project).not.toBe(status);
    expect(await backend.countNodes({ kind: 'project' })).toBe(1);
    expect(await backend.countNodes({ kind: 'status' })).toBe(1);
    expect(await backend.countNodes({})).toBe(2);
  });

  it('7 identical-title issues are 7 distinct rows (identity is the DB uid, not the title)', async () => {
    const { backend } = await freshBackend();

    const ids: number[] = [];
    for (let i = 0; i < 7; i++) {
      // Same title, same content — only the DB-generated uid differs. An issue's
      // identity is its uid (v2 model §0), so all 7 must survive.
      ids.push(await backend.writeNode(
        'same title', { kind: 'issue', name: 'same title' }, { skipDedupe: true },
      ));
    }

    expect(new Set(ids).size).toBe(7);
    expect(await backend.countNodes({ kind: 'issue' })).toBe(7);
  });

  it('findOrCreateNode keys on (kind, name), so cross-kind same-name rows stay distinct', async () => {
    const { backend } = await freshBackend();

    // findOrCreateNode's create branch always writes with skipDedupe: true, so
    // two same-name rows of different kinds are two rows — the (kind, name) probe
    // misses on each and the content-hash dedupe cannot collapse them.
    const a = await backend.findOrCreateNode('project', 'unknown', { content: 'unknown' });
    const b = await backend.findOrCreateNode('status', 'unknown', { content: 'unknown' });

    expect(a).not.toBe(b);
    expect(await backend.countNodes({ kind: 'project' })).toBe(1);
    expect(await backend.countNodes({ kind: 'status' })).toBe(1);
  });

  it('DEFAULT writeNode still content-dedupes — idempotency is preserved', async () => {
    const { backend } = await freshBackend();

    // Content-hash dedupe is a legitimate idempotency feature for CONTENT nodes:
    // writing the same episode twice returns the same node. skipDedupe defaults
    // to false, so this path is unchanged.
    const a = await backend.writeNode('idempotent content', { kind: 'episode' });
    const b = await backend.writeNode('idempotent content', { kind: 'episode' });

    expect(b).toBe(a);
    expect(await backend.countNodes({ kind: 'episode' })).toBe(1);
  });

  it('the default dedupe is still global + case-insensitive — which is exactly why entity writes opt out', async () => {
    const { backend } = await freshBackend();

    // Pins the wrong-key behaviour BUG-040 names: absent skipDedupe, `Unknown`
    // and `  unknown  ` collapse regardless of kind/name. This is documented, not
    // a defect in the opt-out design — it is the reason catalog/entity writes
    // must set skipDedupe: true.
    const a = await backend.writeNode('Unknown', { kind: 'project', name: 'p' });
    const b = await backend.writeNode('  unknown  ', { kind: 'status', name: 's' });

    expect(b).toBe(a);
    expect(await backend.countNodes({ kind: 'project' })).toBe(1);
    expect(await backend.countNodes({ kind: 'status' })).toBe(0);
  });
});
