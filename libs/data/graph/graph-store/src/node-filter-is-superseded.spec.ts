/**
 * node-filter-is-superseded.spec.ts — `NodeFilter.isSuperseded`.
 *
 * ## Why this filter has to exist in SQL
 *
 * `is_superseded` is an axis INDEPENDENT of `t_invalid`. `supersede()` mints a
 * new node, points a `SUPERSEDES` edge at the old one and sets
 * `is_superseded = 1` — but deliberately leaves `t_invalid` NULL. So a
 * superseded row is still "live" by `liveOnly`, the only predicate most
 * consumers apply, and it keeps surfacing in ordinary listings forever: one
 * content edit turns one logical record into two rows with the same name, and
 * every further edit adds another.
 *
 * A consumer could in principle drop those rows itself, after the read. It
 * cannot, in two ways this file pins down:
 *
 *  - `countNodes` is computed in SQL and never sees the caller's post-filter,
 *    so the reported total stays inflated no matter what the caller does with
 *    the rows.
 *  - keyset paging fetches `limit + 1` and slices, so removing rows after the
 *    fetch yields SHORT pages — the page-size invariant breaks for every page
 *    that contained a superseded row.
 *
 * Both are asserted below, because both are the reason the predicate is
 * pushed down rather than applied above.
 *
 * ## What has teeth
 *
 * The load-bearing assertions are the ones that FAIL if the clause is deleted
 * from `buildNodeFilterClause`: with no clause emitted, `queryNodes`
 * ({@link 'isSuperseded:false excludes a superseded row'}) returns 2 rows
 * where 1 is expected, and `countNodes` returns 2 where 1 is expected. The
 * default-behaviour test is the opposite guard — it fails if the clause is
 * ever made to emit when `isSuperseded` is omitted, which would silently
 * break every supersession-chain reader in the ecosystem.
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

describe('NodeFilter.isSuperseded', () => {
  it('is OPT-IN: omitting it returns superseded rows, as it always has', async () => {
    const { backend } = await freshBackend();
    const original = await backend.writeNode('original body', { kind: 'issue', name: 'the issue' });
    const replacement = await backend.supersede(original, 'edited body', { kind: 'issue', name: 'the issue' });

    // No clause emitted ⇒ both rows come back. Supersession-chain readers
    // depend on exactly this; a default-on filter would break them silently.
    const ids = (await backend.queryNodes({ kind: 'issue' })).map((n) => n.id);
    expect(ids).toContain(original);
    expect(ids).toContain(replacement);
    expect(await backend.countNodes({ kind: 'issue' })).toBe(2);
  });

  it('confirms the premise: a superseded row is NOT invalidated, so liveOnly alone cannot hide it', async () => {
    const { backend } = await freshBackend();
    const original = await backend.writeNode('original body', { kind: 'issue', name: 'the issue' });
    await backend.supersede(original, 'edited body', { kind: 'issue', name: 'the issue' });

    const row = (await backend.queryNodes({ ids: [original] }))[0]!;
    expect(row.isSuperseded).toBe(true);
    // The whole reason a second predicate is needed: still live.
    expect(row.tInvalid).toBeUndefined();
    expect((await backend.queryNodes({ kind: 'issue', liveOnly: true })).length).toBe(2);
  });

  it('isSuperseded:false excludes a superseded row — and corrects countNodes with it', async () => {
    const { backend } = await freshBackend();
    const original = await backend.writeNode('original body', { kind: 'issue', name: 'the issue' });
    const replacement = await backend.supersede(original, 'edited body', { kind: 'issue', name: 'the issue' });

    const rows = await backend.queryNodes({ kind: 'issue', liveOnly: true, isSuperseded: false });
    expect(rows.map((n) => n.id)).toEqual([replacement]);
    // The half no application-layer filter can reach.
    expect(await backend.countNodes({ kind: 'issue', liveOnly: true, isSuperseded: false })).toBe(1);
  });

  it('isSuperseded:true selects ONLY the superseded rows', async () => {
    const { backend } = await freshBackend();
    const original = await backend.writeNode('original body', { kind: 'issue', name: 'the issue' });
    await backend.supersede(original, 'edited body', { kind: 'issue', name: 'the issue' });

    const rows = await backend.queryNodes({ kind: 'issue', isSuperseded: true });
    expect(rows.map((n) => n.id)).toEqual([original]);
    expect(await backend.countNodes({ kind: 'issue', isSuperseded: true })).toBe(1);
  });

  it('keeps a row whose is_superseded is NULL — pre-column rows are not superseded', async () => {
    const { backend, adapter } = await freshBackend();
    const id = await backend.writeNode('never edited', { kind: 'issue', name: 'legacy' });
    // Reproduce a row written before the column existed. `= 0` would drop it;
    // `IS NOT 1` must keep it.
    await adapter.executeRun('UPDATE node SET is_superseded = NULL WHERE rowid = ?', [id]);

    const rows = await backend.queryNodes({ kind: 'issue', isSuperseded: false });
    expect(rows.map((n) => n.id)).toEqual([id]);
    expect(await backend.countNodes({ kind: 'issue', isSuperseded: false })).toBe(1);
  });

  it('composes with keyset paging without producing short pages', async () => {
    const { backend } = await freshBackend();
    // 6 current rows; every other one carries a superseded ancestor, so an
    // application-layer filter over a `limit + 1` slice would return short
    // pages. A pushed-down predicate cannot.
    const current: number[] = [];
    for (let i = 0; i < 6; i++) {
      const id = await backend.writeNode(`body ${i}`, { kind: 'issue', name: `issue ${i}` });
      if (i % 2 === 0) {
        current.push(await backend.supersede(id, `edited body ${i}`, { kind: 'issue', name: `issue ${i}` }));
      } else {
        current.push(id);
      }
    }

    const PAGE = 2;
    const seen: number[] = [];
    let after: number | undefined;
    let pages = 0;
    for (;;) {
      const batch = await backend.queryNodes({
        kind: 'issue',
        liveOnly: true,
        isSuperseded: false,
        limit: PAGE + 1,
        ...(after !== undefined ? { after } : {}),
      });
      pages++;
      const hasMore = batch.length > PAGE;
      const page = hasMore ? batch.slice(0, PAGE) : batch;
      // The assertion with teeth: a page that reports more to come must be
      // EXACTLY full. Post-filtering a `limit + 1` fetch fails right here.
      if (hasMore) expect(page).toHaveLength(PAGE);
      for (const n of page) seen.push(n.id);
      if (!hasMore) break;
      after = page[page.length - 1]!.id;
      if (pages > 6) throw new Error(`paging did not terminate after ${pages} pages`);
    }

    expect(seen).toEqual(current);
    expect(new Set(seen).size).toBe(current.length);
    expect(pages).toBe(Math.ceil(current.length / PAGE));
  });

  it('applies to the ranked/FTS read paths too, not just queryNodes', async () => {
    const { backend } = await freshBackend();
    const original = await backend.writeNode('distinctive haystack term, first draft', {
      kind: 'issue',
      name: 'searchable',
    });
    // Deliberately NOT byte-identical to the original: `writeNode` dedupes on
    // content hash, so re-writing the same body returns the SAME rowid and
    // there is no second node to find.
    const replacement = await backend.supersede(original, 'distinctive haystack term, revised', {
      kind: 'issue',
      name: 'searchable',
    });
    expect(replacement).not.toBe(original);

    const hits = await backend.searchNodes('haystack', {
      filter: { kind: 'issue', liveOnly: true, isSuperseded: false },
    });
    expect(hits.map((h) => h.id)).toEqual([replacement]);
    expect(await backend.countNodesFts('haystack', { kind: 'issue', liveOnly: true, isSuperseded: false })).toBe(1);
  });
});
