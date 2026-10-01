# s1 — Pre-flight spike (ENTRY-BLOCKING)

## Goal

Convert two UNVERIFIED facts into measured ones **before** any migration code is written.

## Work

1. In an isolated worktree, build a throwaway store with an FTS index under the pinned
   **0.7.1** driver.
2. Bump to **0.8.1** locally; open the 0.7 store; capture the exact error on
   `fts_match(...)` and on an `UPDATE` that touches the index.
3. **Cross-version VACUUM test:** from 0.8.1, `VACUUM INTO` a *v1* store and inspect
   whether the copy has a clean v2 index (expected: NOT clean — v1 rows copied raw beside
   a fresh v2 control row). Then `DROP INDEX` + `CREATE INDEX ... USING fts` + VACUUM and
   confirm the copy is clean and serves `fts_match`.
4. **Rollback test:** create a store under 0.8.1 (fts2); open under 0.7.1; record the
   failure mode exactly.
5. **`_key` probe:** on a 0.8.1 store, list `sqlite_master` rows for an FTS index and
   confirm whether `__turso_internal_fts_dir_<idx>_key` exists. If absent, confirm the
   consequence for `verifyTursoFtsMaterialization` (`fts-ops.ts:346`).

## Deliverable

A findings note appended to `../DESIGN.md` §6a (or `contexts/s1-findings.md`), each item
labelled measured vs inferred, with exact commands and observed output.

## Exit criteria

- Q2/Q3/Q4 in `../STATE.md` are resolved (verified or definitively unresolved).
- No migration code written yet.

## Constraints

Isolated worktree; nx targets only; quote `check-suite-tree-state`. No commits to
`registry/index.json`. Never write an empty catch — trace every error path.
