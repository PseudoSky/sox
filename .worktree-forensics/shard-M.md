# Shard M — worktree forensics

Read-only. No repo state changed. `main` @ 051d033c. Signals: `main...HEAD --stat` (committed work), `git diff --stat HEAD` (HEAD-relative dirt), `merge-tree --write-tree --name-only main HEAD` (conflict count, non-mutating).

| worktree | branch | ahead | main...HEAD diffstat | untracked | conflicts | backlog id | superseded? | verdict | one-line evidence |
|---|---|---|---|---|---|---|---|---|---|
| store-adapter-critical | fix/store-adapter-critical | 0 | (empty) | 0 | 0 | BUG-STOREADAPTER-QUIESCENCE-TOCTOU (tip commit, already in main) | yes | junk-stamp | HEAD cc5744da is an ancestor of main; only dirt = the 29-file `package.json` stamp (+370/−29) |
| turso-adapter | feat/turso-adapter | 1 | 81 files, +5655/−4437 | 9 | 59 | none in unique commit (branch = "full store-adapter migration") | no | needs-owner | 1 unmerged commit; 16 non-stamp source files edited uncommitted (turso-adapter.ts +72, contract.test.ts +89, registry/index.json +140); 9 untracked `.opencode/artifacts/{reports,reviews}/*.json`; merge-tree 59 conflicts |
| typecheck-bundle-authoring | feat/typecheck-bundle-authoring | 0 | (empty) | 0 | 0 | none (main already carries authoring `typecheck` target) | yes | junk-stamp | HEAD ef0afb52 is an ancestor of main; only dirt = the stamp |
| typecheck-install-manifest | feat/typecheck-install-manifest | 0 | (empty) | 0 | 0 | none (main already carries install-engine/manifest/registry `typecheck*` targets) | yes | junk-stamp | HEAD d7587a55 is an ancestor of main; only dirt = the stamp |
| typecheck-runtime-core | feat/typecheck-runtime-core | 0 | (empty) | 0 | 0 | BL-494 (tip commit, already in main) | yes | junk-stamp | HEAD f9792224 is an ancestor of main; only dirt = the stamp |

## Details — `useful` / `needs-owner`

- **turso-adapter (`needs-owner`)** — the only worktree in this shard holding work not already in `main`. `feat/turso-adapter` is 1 commit ahead (`f17b6193`, 2026-07-27, "feat: full store-adapter migration — all data packages + extensions"; `main...HEAD` = 81 files, +5655/−4437) and is **NOT** an ancestor of `main`. It does **not** merge cleanly: `merge-tree` reports **59 conflicted paths**, heavily add/add across `libs/data/store/store-adapter/*` (both sides independently added the package), plus `libs/memory-core/src/*`, `graph-store`, `vector-store`, `hybrid-search`, `pnpm-lock.yaml`. Beyond the commit it carries real **uncommitted** source edits (not the stamp): `store-adapter/src/{factory,retry,sqlite-adapter,turso-adapter,types}.ts`, `store-adapter/test/contract.test.ts`, `vector-store/src/index.ts`, `memory-core/src/{cluster,compaction,curate,quota,stats}.ts`, `registry/index.json` (+140), plus spec files — and 9 untracked `.opencode/artifacts/reports|reviews/*.json` from the 2026-07-26/27 store-adapter wave. **Owner decision required**: `main` already carries its own (newer) `store-adapter/turso-adapter`, and memory holds the verdict that the Turso 0.7.x→0.8.x pin move is a one-way FTS data migration — so whether this pre-0.8 migration is still wanted (vs. mining its uncommitted edits only) is an owner call, not a mechanical merge.

## Stamp artifact (measured)

All five worktrees carry the identical uncommitted stamp: **29 `package.json` files** each gaining only `keywords`/`repository` (`git+https://github.com/PseudoSky/adhd.git`)/`homepage`, `+370/−29` per worktree, same file list in every one. Redundant with `main` — `main` already carries `keywords`+`repository`+`homepage` for the sampled packages (`libs/authoring`, `libs/host-runtime`, `apps/sox`, `.../memory-server`). The three `typecheck-*` worktrees' stamp diff hashes to the same object (`009f689c…`); `store-adapter-critical` and `turso-adapter` differ only in surrounding context (different base-branch package.json bodies). This is a `soxe upgrade` stamp, not authored work.

## Backlog ids

- store-adapter-critical → `BUG-STOREADAPTER-QUIESCENCE-TOCTOU` (in tip body, already in `main`).
- typecheck-runtime-core → `BL-494` (tip subject, already in `main`).
- typecheck-bundle-authoring / typecheck-install-manifest → none attributable (ahead=0; `BL-248`/`BL-480` seen only in shared history).
- turso-adapter → none in the unique commit; branch is the "full store-adapter migration".
- (No `BL-*` in any worktree name; no ids invented.)

## Total lines

- Committed work unique to this shard: turso-adapter only — **+5655 / −4437**.
- Uncommitted stamp dirt: **+370 / −29** per worktree × 5.
