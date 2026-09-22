/**
 * bug-032-empty-ids-filter.spec.ts — BUG-032 / ADR-0017.
 *
 * ## The defect
 *
 * A filter field that is PRESENT BUT EMPTY is a scope that resolves to zero
 * candidates. `buildNodeFilterClause` emitted each set-membership clause only
 * when the array was NON-empty, so `ids: []` (and `tags: []`, metadata
 * `in: []`, …) silently dropped the clause — widening the read into an
 * UNFILTERED scan. `searchRanked({filters:{kind:'issue', ids:[]}})` returned
 * the one issue on a single-issue store instead of ZERO.
 *
 * ## The contract (ADR-0017)
 *
 * Present-but-empty scoped membership filter ⇒ ZERO results, at every layer.
 * Absent stays unfiltered; non-empty stays exact. A present-but-empty array is
 * never "no filter".
 *
 * ## Teeth
 *
 * Every assertion below is written so it FAILS against the pre-fix
 * `buildNodeFilterClause`: the `ids: []` / `tags: []` / metadata `in: []`
 * cases returned the full store (1 or 2 rows) where 0 is expected, and
 * `kind: []` threw a SQLite syntax error (`IN ()`). The absent/non-empty cases
 * are the opposite guard — they fail if the fix over-reaches and makes an
 * ordinary filter match nothing.
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

describe('BUG-032 — present-but-empty NodeFilter scopes match nothing', () => {
  it('ids: [] returns ZERO rows, not an unfiltered scan', async () => {
    const { backend } = await freshBackend();
    await backend.writeNode('the only issue', { kind: 'issue', name: 'the issue' });

    // Pre-fix this returned 1 (the whole store). A present-but-empty scope is
    // a scope that resolves to zero candidates.
    expect(await backend.queryNodes({ ids: [] })).toEqual([]);
    expect(await backend.countNodes({ ids: [] })).toBe(0);
  });

  it('ids: [] composes with a non-empty sibling filter and still yields ZERO', async () => {
    const { backend } = await freshBackend();
    await backend.writeNode('the only issue', { kind: 'issue', name: 'the issue' });

    // The exact shape from the report: kind selects the issue, ids:[] must
    // still annihilate the result set rather than be dropped.
    expect(await backend.queryNodes({ kind: 'issue', ids: [] })).toEqual([]);
    expect(await backend.countNodes({ kind: 'issue', ids: [] })).toBe(0);
  });

  it('ids: [<absent rowid>] stays ZERO (the guard that already worked must not regress)', async () => {
    const { backend } = await freshBackend();
    const present = await backend.writeNode('the only issue', { kind: 'issue', name: 'the issue' });

    expect(await backend.queryNodes({ ids: [present + 9999] })).toEqual([]);
    expect(await backend.countNodes({ ids: [present + 9999] })).toBe(0);
  });

  it('ABSENT ids stays unfiltered (unchanged)', async () => {
    const { backend } = await freshBackend();
    const a = await backend.writeNode('first', { kind: 'issue', name: 'a' });
    const b = await backend.writeNode('second', { kind: 'issue', name: 'b' });

    const ids = (await backend.queryNodes({ kind: 'issue' })).map((n) => n.id).sort();
    expect(ids).toEqual([a, b].sort());
    expect(await backend.countNodes({ kind: 'issue' })).toBe(2);
  });

  it('NON-EMPTY ids stays exact (unchanged)', async () => {
    const { backend } = await freshBackend();
    const a = await backend.writeNode('first', { kind: 'issue', name: 'a' });
    await backend.writeNode('second', { kind: 'issue', name: 'b' });

    expect((await backend.queryNodes({ ids: [a] })).map((n) => n.id)).toEqual([a]);
    expect(await backend.countNodes({ ids: [a] })).toBe(1);
  });

  it('applies to the FTS read paths too (searchNodes / countNodesFts)', async () => {
    const { backend } = await freshBackend();
    await backend.writeNode('distinctive haystack term', { kind: 'issue', name: 'searchable' });

    expect(await backend.searchNodes('haystack', { filter: { ids: [] } })).toEqual([]);
    expect(await backend.countNodesFts('haystack', { ids: [] })).toBe(0);
  });

  it('other present-but-empty membership scopes match nothing: tags, kind, topic, confidence, name, metadata.in', async () => {
    const { backend } = await freshBackend();
    await backend.writeNode('a body', {
      kind: 'issue',
      name: 'named',
      topic: 't',
      confidence: 'confirmed',
      metadata: { colour: 'red' },
    });

    expect(await backend.queryNodes({ tags: [] })).toEqual([]);
    expect(await backend.queryNodes({ kind: [] })).toEqual([]);
    expect(await backend.queryNodes({ topic: [] })).toEqual([]);
    expect(await backend.queryNodes({ confidence: [] })).toEqual([]);
    expect(await backend.queryNodes({ name: [] })).toEqual([]);
    expect(await backend.queryNodes({ metadata: { colour: { in: [] } } })).toEqual([]);

    // …and the non-empty forms still select the row (over-reach guard).
    expect((await backend.queryNodes({ tags: ['red'] })).length).toBe(0); // no tags set on the row
    expect((await backend.queryNodes({ kind: ['issue'] })).length).toBe(1);
    expect((await backend.queryNodes({ topic: ['t'] })).length).toBe(1);
    expect((await backend.queryNodes({ confidence: ['confirmed'] })).length).toBe(1);
    expect((await backend.queryNodes({ name: ['named'] })).length).toBe(1);
    expect((await backend.queryNodes({ metadata: { colour: { in: ['red'] } } })).length).toBe(1);
  });
});
