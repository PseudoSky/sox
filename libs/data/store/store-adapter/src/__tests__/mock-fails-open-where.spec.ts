/**
 * BUG-STOREADAPTER-MOCK-FAILS-OPEN-WHERE — a scoped UPDATE silently became
 * unscoped in MockAdapter.
 *
 * `handleUpdate` resolved the WHERE value from the SQL literal or the bound
 * args. When neither yielded a value it fell through to the "No WHERE — update
 * all rows" branch. So `UPDATE t SET x = ? WHERE id = ?` with a binding the
 * mock's parser could not resolve rewrote EVERY ROW in the table and reported
 * success.
 *
 * Why that is severe rather than cosmetic: it INVERTS the meaning of a passing
 * test. A migration guard, a claim update, or any scoped write authored against
 * the mock goes green in CI while the production adapter touches a different —
 * and in this case unbounded — row set. The suite actively certifies behaviour
 * the real system does not have. This is the same shape as BL-167's skip-guards:
 * a test named for an invariant that cannot fail.
 *
 * SCOPE CORRECTION (the item as filed was broader than the code): only the
 * UPDATE path failed open. `handleDelete` ALREADY fails closed — an unresolvable
 * WHERE returns `rowsAffected: 0` and deletes nothing. That existing branch is
 * the correct model, and the fix brings UPDATE in line with it rather than
 * inventing a new policy. The delete arm below pins that behaviour so a future
 * refactor cannot regress it into symmetry with the old, wrong UPDATE.
 *
 * The two cases are genuinely different and only one is an error:
 *   - WHERE present, value unresolvable -> THROW (caller asked to scope the
 *     write and we cannot honour it; silently widening it is data loss)
 *   - WHERE absent entirely             -> update all rows, which is what
 *     `UPDATE t SET x = 1` legitimately means in SQL
 *
 * RED→GREEN staging (BL-225): the first arm FAILS against the pre-fix mock (the
 * update silently succeeds and rewrites every row) and PASSES once the
 * unresolvable-WHERE case throws.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MockAdapter } from '../mock-adapter.js';

// MockAdapter populates a row from the BOUND ARGS positionally against the
// column list — it does not read SQL value literals on INSERT. Seeding with
// literals yields three rows of nulls, which silently defeats the assertions.
async function seed(mock: MockAdapter): Promise<void> {
  await mock.executeRun('INSERT INTO t (id, v) VALUES (?, ?)', [1, 'one']);
  await mock.executeRun('INSERT INTO t (id, v) VALUES (?, ?)', [2, 'two']);
  await mock.executeRun('INSERT INTO t (id, v) VALUES (?, ?)', [3, 'three']);
}

async function values(mock: MockAdapter): Promise<string[]> {
  const res = await mock.executeAll<{ v: string }>('SELECT v FROM t');
  return res.rows.map((r) => r.v);
}

describe('BUG-STOREADAPTER-MOCK-FAILS-OPEN-WHERE', () => {
  let mock: MockAdapter;
  beforeEach(async () => {
    mock = new MockAdapter();
    await seed(mock);
  });

  it('REFUSES a scoped UPDATE whose WHERE value cannot be resolved (never widens it)', async () => {
    // A WHERE is present, but no args are supplied to bind it. Pre-fix this fell
    // through to update-all and rewrote all three rows while reporting success.
    await expect(
      mock.executeRun('UPDATE t SET v = ? WHERE id = ?'),
    ).rejects.toThrow(/WHERE clause .* could not be resolved|Refusing to update all/i);

    // The decisive assertion: nothing was modified. A throw that still mutated
    // would be worse than the original bug.
    expect((await values(mock)).sort()).toEqual(['one', 'three', 'two']);
  });

  it('still performs a genuinely unscoped UPDATE when there is NO WHERE at all', async () => {
    // `UPDATE t SET v = 'x'` legitimately means every row. The fix must not
    // over-correct into refusing valid SQL.
    const res = await mock.executeRun("UPDATE t SET v = 'x'");
    expect(res.rowsAffected).toBe(3);
    expect(await values(mock)).toEqual(['x', 'x', 'x']);
  });

  it('still performs a resolvable scoped UPDATE (control)', async () => {
    const res = await mock.executeRun("UPDATE t SET v = 'updated' WHERE id = 2");
    expect(res.rowsAffected).toBe(1);
    expect((await values(mock)).sort()).toEqual(['one', 'three', 'updated']);
  });

  it('DELETE already fails closed on an unresolvable WHERE — pin it', async () => {
    // This arm passes before AND after the fix. It exists so the correct
    // pre-existing behaviour cannot be "unified" with the old broken UPDATE.
    const res = await mock.executeRun('DELETE FROM t WHERE id = ?');
    expect(res.rowsAffected).toBe(0);
    expect((await values(mock)).sort()).toEqual(['one', 'three', 'two']);
  });

  it('still performs a genuinely unscoped DELETE when there is NO WHERE at all', async () => {
    const res = await mock.executeRun('DELETE FROM t');
    expect(res.rowsAffected).toBe(3);
    expect(await values(mock)).toEqual([]);
  });
});
