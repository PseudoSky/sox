# Worktree inventory — forensics assembly

Read-only forensics of every agent worktree in this repository, assembled from the fourteen shard
fragments (A–N) written to `.worktree-forensics/`. This document is the union of those fragments,
deduplicated. It is an assembly: no worktree was modified, and no measurement was re-run.

---

## Summary

**Totals: 67 worktrees triaged, across 14 shards (A–N).**

| verdict | count | worktrees |
|---|---|---|
| useful | 2 | `agmd-constraints`, `pkt56-orphan-branch-guard` |
| superseded | 19 | A×4, C×5, G×2, H×5, K×1, L×2 |
| junk-stamp | 40 | B×4, D×4, E×4, F×5, G×2, I×4, J×5, K×4, L×2, M×4, N×2 |
| needs-owner | 6 | `bl466-wire-guards`, `bug-memory-006-community-affordance`, `cf-test`, `migration-fails-open`, `rf-test`, `turso-adapter` |
| empty | 0 | — |
| **total** | **67** | |

### Methodology findings

1. **`git diff main` is base-divergence noise; only `main...HEAD` (plus HEAD-relative numstats) shows
   real work.** Every branch here forks from a pre-refactor base, so a plain `git diff main` against
   *the working tree* reports hundreds of phantom files that are simply how far `main` has since
   advanced. The signal is `git diff main...HEAD` (committed work, by merge-base) and
   `git diff --shortstat HEAD` (HEAD-relative dirt). Where the two disagree — e.g. shard K's
   `pkt74` shows 712 lines under `git diff main` but **0 files** under `main...HEAD` — the
   `main...HEAD` number is the truth and the other is the artifact.

2. **The "stamp artifact" is a 28–29-file `package.json` metadata set** — each file gaining
   `keywords` + `repository` (`git+https://github.com/PseudoSky/adhd.git`) + `homepage`
   (`https://github.com/PseudoSky/adhd`), path-set sha1
   `0c96070b78ff928cf7a06704dc4d910ae6e80686`, `+370/−29` — whose fields **are already on `main`**.
   Believed to be a `soxe upgrade` version stamp. It is the *only* dirt on 40 of the 67 worktrees
   (`junk-stamp`); on `main` the identical fields are already present, so the stamp is redundant.

### Rescue list — worktrees holding real work

| worktree | what to rescue |
|---|---|
| `agmd-constraints` | `AGENTS.md` `+20` (two new ⛔ sections: commitlint + `--skip-nx-cache`); drop the PLAN/STATE churn |
| `pkt56-orphan-branch-guard` | `SPEC-PKT-56.md` `+466` (orphan-worktree-sweep design for `BL-422`) |
| `bug-memory-006-community-affordance` | `SPEC-BUG-MEMORY-006.md` `+601`, `spec.ts` `+312`, `index.ts` `+84/−8`; drop PLAN/STATE |
| `migration-fails-open` | `SPEC-MIGRATE-UNSAFE.md` `+487` (`BUG-STOREADAPTER-MIGRATE-UNSAFE-001`) |
| `turso-adapter` | `81 files, +5655/−4437` plus uncommitted source/registry edits (59-conflict merge) |
| `cf-test` / `rf-test` | uncommitted `libs/memory-core/src/cluster.ts` draft (vector-presence filter) at detached `6de81319` |

*`cf-test` (shard E) and `rf-test` (shard L) are both detached at `6de81319` with the same
`cluster.ts` draft — reported independently by two shards. They are kept as distinct rows below and
cross-referenced; coordinate before discarding either.*

### Hazard list

| worktree | hazard |
|---|---|
| `bl466-wire-guards` | **revert bomb** — the index is 1433-of-1454 tracked files staged-deleted (`−326997`, 0 insertions; 1432 on-disk files untracked). A bare `git commit` in that worktree would wipe the repository. It holds **zero unique content** and needs an owner before removal. Related graph item `22f4f8ab` still OPEN. |

---

## Master table — all 67 worktrees

Columns: worktree · branch · ahead · `main...HEAD` · untracked · conflicts · backlog id · superseded? · verdict · one-line evidence.

### Shard A

| worktree | branch | ahead | main...HEAD | untracked | conflicts | backlog id | superseded? | verdict | evidence |
|---|---|---|---|---|---|---|---|---|---|
| `adapter-connection-recycle` | `feat/adapter-connection-recycle` | 0 | ∅ (0 files) | none | 0 | — | yes | superseded | HEAD `92435f2c` already reachable from `main`; only dirt = 29-file stamp |
| `adr0011-backlog-cutover` | `feat/adr0011-backlog-cutover` | 0 | ∅ | none | 0 | ADR-0011 | yes | superseded | HEAD `894e2b14` already in `main`; stamp-only |
| `adr0011-stage2-write-off` | `feat/adr0011-stage2-write-off` | 0 | ∅ | none | 0 | ADR-0011 (commit refs BL-479) | yes | superseded | HEAD `5bea16c1` already in `main`; stamp-only |
| `agent-ir-3` | `feat/agent-ir-batch-3` | 0 | ∅ | node_modules/ (1) | 0 | — | yes | superseded | HEAD `655e9a0f` already in `main`; only leftover untracked `node_modules/`, no stamp |
| `agmd-constraints` | `docs/agmd-constraints` | 2 | 3 files, +24/−4 | none | 2 (PLAN.md, STATE.md) | — | partly | **useful** | 2 commits; `AGENTS.md` `+20` (two ⛔ sections) NOT in `main`; PLAN/STATE churn |

### Shard B

| worktree | branch | ahead | main...HEAD | untracked | conflicts | backlog id | superseded? | verdict | evidence |
|---|---|---|---|---|---|---|---|---|---|
| `bl373-sidecar-staleness` | `fix/bl373-sidecar-staleness` | 0 | empty | 0 | 0 | BL-373 | yes | junk-stamp | HEAD `7aface91` ancestor; stamp (+370/−29) ≈`main` one version behind |
| `bl447-ddl-substring-probe` | `feat/bl447-ddl-substring-probe` | 0 | empty | 0 | 0 | BL-447 | yes | junk-stamp | HEAD `75690df6` ancestor; identical dirty set sha1 `0c96070b…`; no unique content |
| `bl460-changeset-backfill` | `feat/bl460-changeset-backfill` | 0 | empty | 0 | 0 | BL-460 | yes | junk-stamp | HEAD `658f68cc` ancestor; identical dirty set; graph item `d01c0c86` resolved |
| `bl460-changeset-close` | `feat/bl460-changeset-close` | 0 | empty | 0 | 0 | BL-460 | yes | junk-stamp | HEAD `8608c86d` ancestor; identical dirty set; no unique content |
| `bl466-wire-guards` | `feat/bl466-wire-guards` | 0 | empty | 1432 | 0 | BL-466 | yes | **needs-owner** | HEAD `88a9cee3` ancestor; index mass-unstaged — 1433 staged deletions (`−326997`, 0 insertions), 1432 on-disk files untracked; no unique content |

### Shard C

| worktree | branch | ahead | main...HEAD | untracked | conflicts | backlog id | superseded? | verdict | evidence |
|---|---|---|---|---|---|---|---|---|---|
| `bl472-shutdown-drain` | `feat/bl472-shutdown-drain` | 0 | ∅ (0 files) | none | 0 | BL-472 | yes | superseded | tip `b3d27b27` + fix `08bec739` + test `d3645d39` all reachable from `main`; dirt = 29-file stamp |
| `bl474-bgslot-contention` | `feat/bl474-bgslot-contention` | 0 | ∅ | none | 0 | BL-474 | yes | superseded | tip `4d06f755` + fixes `7edf8540`/`e96c9eea`/`c7409c0e` in `main`; stamp + stale `pnpm-lock.yaml` relock |
| `bug-memory-001-write-loss` | `feat/bug-memory-001-write-loss` | 0 | ∅ | none | 0 | BUG-MEMORY-001 | yes | superseded | tip `df012ec9` (instrumentAdapter snapshot fix) reachable from `main`; dirt = 29-file stamp |
| `bug-memory-002-004-error-and-doc-surface` | `feat/bug-memory-002-004-error-and-doc-surface` | 0 | ∅ | `check-probe-uids.mjs` | 0 | BUG-MEMORY-002, BUG-MEMORY-004 | yes | superseded | tip `80d963fe` + fix `af684ac0` in `main`; dirt = stamp + 1 throwaway probe script |
| `bug-memory-003-recall-null-rows` | `feat/bug-memory-003-recall-null-rows` | 0 | ∅ | none | 0 | BUG-MEMORY-003 | yes | superseded | tip `9b475841` + fixes `c8fe93f0`/`d6bfaa4e` reachable from `main`; dirt = 29-file stamp |

### Shard D

| worktree | branch | ahead | main...HEAD | untracked | conflicts | backlog id | superseded? | verdict | evidence |
|---|---|---|---|---|---|---|---|---|---|
| `bug-memory-006-community-affordance` | `feat/bug-memory-006-community-affordance` | 6 | 5 files, +997/−8 (SPEC +601, spec.ts +312, index.ts +84/−8, PLAN +4, STATE +4) | none | 3 (PLAN.md, STATE.md, memory-server/src/index.ts) | BUG-MEMORY-006 | no | **needs-owner** | only unmerged unique work in shard; `main` lacks `SPEC-BUG-MEMORY-006.md` and the `E_WRONG_KIND`/`E_PENDING_CLUSTER`/`E_WRONG_ID_SPACE` codes; entangled with OPEN product-ruling `20b661a2` + RESOLVED triage `acb84de8` |
| `bug008-verify` | `fix/bug008-verify` | 0 | ∅ (0 files) | none | 0 | BUG-008 | yes | junk-stamp | HEAD `3cb6469b` already reachable from `main`; only dirt = 29-file stamp |
| `bug017-t1` | `bug017/t1` | 0 | ∅ | none | 0 | BUG-017 | yes | junk-stamp | HEAD `d1f44d14` already reachable from `main`; only dirt = 29-file stamp |
| `bug018-t4` | `bug018/t4` | 0 | ∅ | none | 0 | BUG-018 | yes | junk-stamp | HEAD `f127a8ff` already reachable from `main`; only dirt = 29-file stamp |
| `bug019-t5` | `bug019/t5` | 0 | ∅ | none | 0 | BUG-019 | yes | junk-stamp | HEAD `ac4b2259` already reachable from `main`; only dirt = 29-file stamp |

### Shard E

| worktree | branch | ahead | main...HEAD | untracked | conflicts | backlog id | superseded? | verdict | evidence |
|---|---|---|---|---|---|---|---|---|---|
| `bug021-t3` | `bug021/t3` | 0 | empty | none | 0 | BUG-021 | yes — HEAD `e68e9224` ancestor of `main` | junk-stamp | commits already in `main`; sole dirt = 29×package.json stamp (+370/−29) |
| `c-fix-fts` | `fix/c-fts-object` | 0 | empty | none | 0 | BL-507 | yes — `7343ee0c` ancestor; landed via `c2f1baee` (BL-506/507/508) | junk-stamp | sole dirt = 29×stamp |
| `cf-test` | (detached HEAD @ `6de81319`) | 0 | empty | none | 0 | none (draft cites `BL-NNN` placeholder) | yes — `6de81319` ancestor of `main` | **needs-owner** | DETACHED + DIRTY; dirt = 28×package.json stamp + real uncommitted `libs/memory-core/src/cluster.ts` draft (+12/−2) not in `main` |
| `cluster-full-pass-schedule` | `feat/cluster-full-pass-schedule` | 0 | empty | none | 0 | BL-215 | yes — BL-215 landed (`55574ae7`, `1d2251b0`) | junk-stamp | sole dirt = 29×stamp |
| `debt-soxgraph-002` | `fix/debt-soxgraph-002` | 0 | empty | none | 0 | DEBT-SOXGRAPH-002 | yes — `9ca26d51` ancestor, merged via `8e747a17` | junk-stamp | sole dirt = 29×stamp |

### Shard F

| worktree | branch | ahead | main...HEAD | untracked | conflicts | backlog id | superseded? | verdict | evidence |
|---|---|---|---|---|---|---|---|---|---|
| `debt003-t2` | `debt003/t2` | 0 | ∅ | none | 0 | DEBT-003 | yes | junk-stamp | tip `89350ada` in `main`; only dirt = 29-file stamp (+370/−29) |
| `debt031-telemetry` | `telemetry/debt031` | 0 | ∅ | none | 0 | DEBT-031, BL-569, BUG-014 | yes | junk-stamp | tip `d89ffcf6` in `main`; stamp + stale PLAN/STATE count-drift on obsolete base (+4/−4) |
| `delete-markdown-backlog` | `feat/delete-markdown-backlog` | 0 | ∅ | none | 0 | BL-482, BL-441, BL-443 | yes | junk-stamp | tip `1c6a9db2` in `main`; stamp + redundant `pnpm-lock.yaml` importer (+9) already on `main:341` |
| `embed-warmup-cold-retry` | `feat/embed-warmup-cold-retry` | 0 | ∅ | none | 0 | bl376, BUG-EMBED-WARMUP-CACHEHIT-ASSUMES-FAST-LOAD-001, BL-215 | yes | junk-stamp | tip `5850c81a` in `main`; only dirt = 29-file stamp (+370/−29) |
| `engine-guard` | `fix/engine-guard` | 0 | ∅ | none | 0 | BL-508, BL-505, BL-504, BL-500, DEBT-SOXGRAPH-001 | yes | junk-stamp | tip `bcd190f2` in `main`; only dirt = 29-file stamp (+370/−29) |

### Shard G

| worktree | branch | ahead | main...HEAD | untracked | conflicts | backlog id | superseded? | verdict | evidence |
|---|---|---|---|---|---|---|---|---|---|
| `fix-fk-heal-fts-residue` | `fix/fk-heal-fts-residue` | 0 | empty | 0 | 0 | BL-506 / BL-507 / BL-508 | yes | junk-stamp | `main..HEAD` empty; only working-tree dirt = 29-file stamp, redundant with `main` |
| `memory-scope-empty` | `feat/memory-scope-empty` | 0 | empty | 0 | 0 | none unique (tip `76289093` = BL-215, shared w/ `cluster-full-pass-schedule`) | yes | junk-stamp | only dirt is the stamp |
| `memory-state-stale-prose` | `docs/memory-state-stale-prose` | 1 | `docs/reporting/memory/{PLAN.md,STATE.md}` +75/−80 | 0 | 2 (PLAN.md, STATE.md) | bl435 (BL-435) | yes — 400 behind; `main` has 8+ later commits on same two files | superseded | unique commit `d6b72c2d` resyncs prose; `main` evolved those docs → overtaken |
| `migration-fails-open` | `feat/migration-fails-open` | 1 | `SPEC-MIGRATE-UNSAFE.md` +487/−0 (new file) | 0 | 0 | BUG-STOREADAPTER-MIGRATE-UNSAFE-001 | no — spec absent from `main` (956 behind) | **needs-owner** | unmerged 487-line spec; `main` calls bug "not verified either way"; no code fix in store-adapter |
| `perf-memory-004` | `fix/perf-memory-004` | 0 | empty | 1 (`perf-memory-004-write-importance-default.spec.ts`, 155 lines) | 0 | PERF-MEMORY-004 | yes | superseded | uncommitted `write.ts` +19/−3 re-implements PERF-MEMORY-004, but `main:write.ts` already fixes (lines 203/311/324, `effectiveImportance = computeImportance`) and is refactored +229/−49 → spec stale |

### Shard H

| worktree | branch | ahead | main...HEAD | untracked | conflicts | backlog id | superseded? | verdict | evidence |
|---|---|---|---|---|---|---|---|---|---|
| `pkt07-lancedb-adapter-boundary` | `feat/pkt07-lancedb-adapter-boundary` | 0 | empty | none | 0 | PKT-07, BL-389 | yes | superseded | HEAD `b720488a` (+`6a0ad4df`,`53594644`,`d4209543`) reachable from `main`; merge = `main`'s tree |
| `pkt18-reheal-stale` | `feat/pkt18-reheal-stale` | 0 | empty | none | 0 | PKT-18, BL-215, BL-88 | yes | superseded | HEAD `1d2251b0` (+`5c18b70e`,`55574ae7`,`76289093`) reachable; merge = `main` tree |
| `pkt22-vec-distance-metric` | `feat/pkt22-vec-distance-metric` | 0 | empty | none | 0 | PKT-22, BL-392 | yes | superseded | HEAD `a03b576b` (+`a81145a3`,`f495a58f`,`ea75a2cb`,`fb7638a1`) reachable; merge = `main` tree |
| `pkt38-service-enable-env` | `feat/pkt38-service-enable-env` | 0 | empty | none | 0 | PKT-38, BL-375 (+BL-489 filed) | yes | superseded | HEAD `053049ef` (+`abe5ae95`,`89d0cc86`,`1a618c63`) reachable; merge = `main` tree |
| `pkt39-list-never-lies` | `feat/pkt39-list-never-lies` | 0 | empty | none | 0 | PKT-39, BL-332 | yes | superseded | HEAD `bcfc5dde` (+`fa4d2301`,`31434b33`) reachable; merge = `main` tree |

### Shard I

| worktree | branch | ahead | main...HEAD | untracked | conflicts | backlog id | superseded? | verdict | evidence |
|---|---|---|---|---|---|---|---|---|---|
| `pkt45-finish-telemetry` | `feat/pkt45-finish-telemetry` | 0 | empty | none (29 stamp) | 0 | PKT-45, BL-466 | yes — HEAD `ee928285` ancestor | junk-stamp | work merged; only dirt = redundant package metadata |
| `pkt55-suite-variance` | `feat/pkt55-suite-variance` | 0 | empty | none (29 stamp) | 0 | PKT-55, BL-202 | yes — HEAD `c76f283c` ancestor | junk-stamp | work merged |
| `pkt56-orphan-branch-guard` | `feat/pkt56-orphan-branch-guard` | 1 | `SPEC-PKT-56.md` | 466 +++ (1 file, +466) | 0 | PKT-56, BL-422 | no — HEAD `b6be4d65` not in `main`; spec absent | **useful** | 466-line orphan-worktree-sweep design spec exists only here; no impl of BL-422 in `main` |
| `pkt57-open-typing-adr` | `feat/pkt57-open-typing-adr` | 0 | empty | none (29 stamp) | 0 | PKT-57, BL-438 | yes — HEAD `5792a7e1` ancestor | junk-stamp | work merged |
| `pkt58-open-kind-check` | `feat/pkt58-open-kind-check` | 0 | empty | none (29 stamp) | 0 | PKT-58, BL-439 | yes — HEAD `6b830db6` ancestor | junk-stamp | work merged |

### Shard J

| worktree | branch | ahead | main...HEAD | untracked | conflicts | backlog id | superseded? | verdict | evidence |
|---|---|---|---|---|---|---|---|---|---|
| `pkt59-type-policy` | `feat/pkt59-type-policy` | 0 | empty (0 files) | 0 | 0 | PKT-59 / BL-440 | yes | junk-stamp | HEAD `77ecc308` ancestor of `main` (0 ahead, 1077 behind) |
| `pkt60-memory-ontology-seam` | `feat/pkt60-memory-ontology-seam` | 0 | empty | 0 | 0 | PKT-60 / BL-441 | yes | junk-stamp | HEAD `291535f8` (1052 behind) |
| `pkt61-operator-migration` | `feat/pkt61-operator-migration` | 0 | empty | 0 | 0 | PKT-61 / BL-442 | yes | junk-stamp | HEAD `e5917c27` (1054 behind) |
| `pkt62-tarball-conformance` | `feat/pkt62-tarball-conformance` | 0 | empty | 0 | 0 | PKT-62 / BL-443 | yes | junk-stamp | HEAD `741d04f5` (1056 behind) |
| `pkt63-release-060` | `feat/pkt63-release-060` | 0 | empty | 0 | 0 | PKT-63 / BL-444 | yes | junk-stamp | HEAD `c58b5c14` (1002 behind) |

### Shard K

| worktree | branch | ahead | main...HEAD | untracked | conflicts | backlog id | superseded? | verdict | evidence |
|---|---|---|---|---|---|---|---|---|---|
| `pkt74-open-edge-rel` | `feat/pkt74-open-edge-rel` | 0 | empty (0 files) | 0 | 0 | PKT-74 / BL-448 | yes | junk-stamp | HEAD=`befb1ee5` ancestor of `main`; only dirt = 29 pkg.json stamp (adds keywords/repository/homepage), fields already in `main` |
| `pkt75-backlog-tooling` | `feat/pkt75-backlog-tooling` | 0 | empty | 0 | 0 | PKT-75 / BL-473 | yes | junk-stamp | HEAD=`9a951cc4` ancestor; 29 pkg.json stamp, fields already in `main` |
| `pkt79-release-cascade` | `feat/pkt79-release-cascade` | 0 | empty | 0 | 0 | PKT-79 / BL-452 | yes | junk-stamp | HEAD=`c97f3ab6` ancestor; 29 pkg.json stamp, fields already in `main` |
| `recall-degradation-proof` | `proof/recall-degradation-proof` | 0 | empty | 0 | 0 | BL-391 | yes | superseded | HEAD=`b5a90314` ancestor of `main`; uncommitted 4-file/+475 recall-degradation feature + spec already fully in `main` (main spec 343 lines vs worktree 335; main index.ts has `recall_degradations` + `_resetRecallDegradationCountersForTest`) |
| `recall-golden-set` | `feat/recall-golden-set` | 0 | empty | 0 | 0 | PKT-55 / BL-215 | yes | junk-stamp | HEAD=`76289093` ancestor; 29 pkg.json stamp, fields already in `main` |

### Shard L

| worktree | branch | ahead | main...HEAD | untracked | conflicts | backlog id | superseded? | verdict | evidence |
|---|---|---|---|---|---|---|---|---|---|
| `rf-test` | (detached HEAD @ `6de81319`) | 0 | empty | none | 0 | BL-259 (cluster.ts draft) | yes — `6de81319` ancestor of `main` | **needs-owner** | DETACHED + DIRTY; dirt = 28×package.json stamp (byte-identical to `main`) + real uncommitted `libs/memory-core/src/cluster.ts` draft (+22/−5) absent from `main` |
| `staging-combined` | `staging/combined-merge` | 0 | empty | none | 0 | BL-507 / BL-508 | yes — HEAD `47d46799` ancestor of `main` | junk-stamp | merged staging branch (`fix/engine-guard`, `fix/c-fts-object` both in `main`); only dirt = redundant package metadata |
| `staging-gate` | `staging/gate-merge` | 2 | 9 files, +910/−105 | none | 0 | BL-373, BL-507, DEBT-SOXGRAPH-002 | yes — `git diff main HEAD` on all 9 paths = 0 | superseded | 2 merge commits `e2836e35`, `e66193ff` NOT ancestors of `main`, yet content byte-identical to `main` (`7343ee0c` BL-507, `5cf35bc7`/`3fc9923b` BL-373 landed independently) |
| `state-truthtelling` | `feat/state-truthtelling` | 0 | empty | none | 0 | BL-487 | yes — HEAD `2320455d` ancestor of `main` | junk-stamp | merged; only dirt = redundant package metadata |
| `store-adapter-a` | `feat/store-adapter-a` | 0 | empty | 15 (`libs/data/store/store-adapter/**`) | 0 | none | yes — untracked pkg v0.1.0 ⊂ `main`'s v0.13.2 (~150 files) | superseded | early scaffold copy (7 src files, all present in `main`); `main` has advanced package; only non-stamp dirt = scaffold-residue `@libsql/client` dep + pnpm-lock |

### Shard M

| worktree | branch | ahead | main...HEAD | untracked | conflicts | backlog id | superseded? | verdict | evidence |
|---|---|---|---|---|---|---|---|---|---|
| `store-adapter-critical` | `fix/store-adapter-critical` | 0 | empty | 0 | 0 | BUG-STOREADAPTER-QUIESCENCE-TOCTOU (tip commit, already in `main`) | yes | junk-stamp | HEAD `cc5744da` ancestor of `main`; only dirt = 29-file stamp (+370/−29) |
| `turso-adapter` | `feat/turso-adapter` | 1 | 81 files, +5655/−4437 | 9 | 59 | none in unique commit (branch = "full store-adapter migration") | no | **needs-owner** | 1 unmerged commit; 16 non-stamp source files edited uncommitted (`turso-adapter.ts` +72, `contract.test.ts` +89, `registry/index.json` +140); 9 untracked `.opencode/artifacts/{reports,reviews}/*.json`; merge-tree 59 conflicts |
| `typecheck-bundle-authoring` | `feat/typecheck-bundle-authoring` | 0 | empty | 0 | 0 | none (`main` already carries authoring typecheck target) | yes | junk-stamp | HEAD `ef0afb52` ancestor of `main`; only dirt = stamp |
| `typecheck-install-manifest` | `feat/typecheck-install-manifest` | 0 | empty | 0 | 0 | none (`main` already carries install-engine/manifest/registry typecheck* targets) | yes | junk-stamp | HEAD `d7587a55` ancestor of `main`; only dirt = stamp |
| `typecheck-runtime-core` | `feat/typecheck-runtime-core` | 0 | empty | 0 | 0 | BL-494 (tip commit, already in `main`) | yes | junk-stamp | HEAD `f9792224` ancestor of `main`; only dirt = stamp |

### Shard N

| worktree | branch | ahead | main...HEAD | untracked | conflicts | backlog id | superseded? | verdict | evidence |
|---|---|---|---|---|---|---|---|---|---|
| `typecheck-tooling` | (branch not stated in return) | 0 | ∅ (0 files) | 0 | 0 | BL-493, BL-248, BL-325, SPEC-PKT-62 | yes | junk-stamp | HEAD `63755e17` ancestor of `main` (0 ahead, 921 behind); `main...HEAD` empty; 29-file stamp byte-identical and stale (net −75 vs `main`, e.g. `0.2.0` vs `main`'s `0.2.1`) |
| `typecheck-transport-sources` | (branch not stated in return) | 0 | ∅ (0 files) | 0 | 0 | BL-248, BUG-SERVICE-PROXY-NOOP-ASSERTION-001 | yes | junk-stamp | HEAD `4ccd44fd` ancestor of `main` (0 ahead, 921 behind); same 29-file stamp; nothing to rescue |

---

## Per-shard evidence (verbatim)

### Shard A

Stamp: 29×package.json +370/−29 — the only dirt in rows 1–3, co-resident with real commits in row 5.
Commits `c6df35d7` ("docs(authoring): add commitlint and --skip-nx-cache agent constraints") +
`2867c8cc` ("chore(memory-core): regenerate plan docs from backlog graph"). `AGENTS.md` `+20` = the two
new ⛔ sections (commit messages must satisfy commitlint; never pass `--skip-nx-cache` without approval,
BL-456-class). `main` already **enforces** commitlint (`commitlint.config.js` dated Sep 29 + executable
`.husky/commit-msg`) so the enforcement half is superseded; `main`'s `AGENTS.md` has **no**
commitlint/skip-nx-cache heading (only unrelated `--skip-nx-cache` prose at `AGENTS.md:341`), so the doc
half is genuinely unmerged. **Rescue** = cherry-pick `AGENTS.md` `+20`, drop PLAN/STATE churn.

### Shard B

Four worktrees share one identical dirty set: 29 package.json, +370/−29, name-list sha1
`0c96070b78ff928cf7a06704dc4d910ae6e80686`. **Hazard — `bl466-wire-guards`:** `git ls-files` (index) = 21;
`git ls-tree -r HEAD` = 1454 → **1433/1454 tracked files are staged-deleted** (whole-repo revert bomb;
a bare `git commit` would wipe the repo). Staged deletions by top dir: `libs` 553, `docs` 274,
`.workflow` 156, `extensions` 151, `.opencode` 102, `tools` 64, `scripts` 36, `.claude` 23, `apps` 21,
`packages` 15, `schemas` 3, `.github` 2, plus all root files. The 21 surviving index entries are the
BL-466 guard surface: `tools/run-guards.mjs`, `guards-manifest.mjs`, `verify-native-abi.mjs`,
`test-bl{222,409,416,446,454,456,457,463,464,465,466}-*.mjs`, `.github/workflows/ci.yml`,
`.husky/pre-commit`, `BACKLOG.md`, `CHANGELOG.md`, `docs/reporting/memory/{PLAN,STATE}.md`,
`project.json`. No salvageable content (untracked bytes == HEAD blobs; reflog empty). Related graph item
`22f4f8ab` OPEN. Backlog refs: BL-373, BL-447, BL-460 (×2), BL-466; `d01c0c86` resolved; `0d7c23c9`
BLOCKED; `c5e4753e` resolved.

### Shard C

Stamp variant adds `repository` (`git+https://github.com/PseudoSky/adhd.git`), `homepage`
(`https://github.com/PseudoSky/adhd`), `keywords` — redundant with `main`. `bl474` `pnpm-lock.yaml` +9
(30 modified files) adds a `libs/data/graph/graph-store/conformance-fixture` importer already on
`main:pnpm-lock.yaml:341` = stale relock. `bug-memory-002-004` untracked
`libs/data/store/store-adapter/check-probe-uids.mjs` (14 lines) = throwaway debug probe
(`/private/tmp/...` path). All 5 branches fully contained in `main` (`rev-list --count main..HEAD` = 0
each); rescue value zero.

### Shard D

`bug-memory-006` tip `33481941` ("fix(extensions): make community_uid ID-space check advisory
(BUG-MEMORY-006)"); 6 commits all 2026-08-08; `SPEC-BUG-MEMORY-006.md` +601 absent from `main`;
`spec.ts` +312; `index.ts` adds, on the `memory_get_community` miss path, `E_WRONG_KIND` /
`E_PENDING_CLUSTER` + advisory `E_WRONG_ID_SPACE` (`/^[0-9a-f]{32}$/` vs `ULID_RE`). merge-tree yields
3 content conflicts. `acb84de8` resolved, `20b661a2` OPEN (do **not** build entity→community
resolution). **Rescue-worthy** = spec +601 + 312-line test; drop PLAN/STATE.

### Shard E

`cf-test` draft: `buildClusterResults` gains
`membersWithVecs = members.filter((r) => rowidToVec.has(r)); if (membersWithVecs.length < 2) continue;`
and drops the trailing `.filter(Boolean)` from `memberVecs`; references `(BL-NNN)`. `main` does **not**
contain `membersWithVecs` (`git grep` rc=1); `main`'s caller already filters rowids to rows present in
`rowidToVec` upstream.

### Shard F

Uncommitted HEAD-relative totals: `debt003-t2` +370/−29 · `debt031-telemetry` +374/−33 ·
`delete-markdown-backlog` +379/−29 · `embed-warmup-cold-retry` +370/−29 · `engine-guard` +370/−29.
`main` carries `libs/data/store/store-adapter/src/engine-guard.ts` +
`__tests__/engine-guard.bl508.test.ts` (BL-508) and `lazy-connect.debt003.spec.ts` (DEBT-003). No
useful/needs-owner in F.

### Shard G

Shard committed total +562/−80. `migration-fails-open` @ `944034a9`; `main` grep finds no fail-open fix
in `libs/data/store/store-adapter/src` (only an unrelated comment at `integrity.ts:3281`); owner decides
adopt / port into `docs/plan/turso-fts-migration/` (`main` `051d033c`) / discard. `memory-state-stale-prose`
and `perf-memory-004` carry 2 and 0 merge conflicts respectively; the rest 0.

### Shard H

Stamp 29 files +370/−29, sha1 `0c9607…`. Merge-tree for each yields tree
`2a8fb7e2077e6ef5650e5eee16b45aa0306c3a27` == `main^{tree}`, 0 conflicts.

### Shard I

Stamp 29 paths +370/−29; `memory-core` `0.6.0` in `pkt45` vs `0.5.0` in `pkt57`. `pkt56` designs the
sweep for BL-422 (uid `59c2cd66-ae12-474a-901d-1293a71a9656`, OPEN, HIGH, process — "an agent's commits
can land on a disposable worktree branch and be reachable from nowhere else"); root cause: commits
`af45f77` & `e275039` landed on `worktree-agent-a54e5171a1615a001` reachable nowhere because the external
dispatch harness moved the committing agent's cwd; the design reuses `tools/unstage-orphans.mjs`
(report/`--apply`/`--force`), `commit-mine.mjs`, `guards-manifest.mjs`, `run-guards.mjs`,
`.husky/pre-commit`, `.github/workflows/ci.yml`, `SAFE_GIT_ENV` harnesses. **Rescue** = the spec text.

### Shard J

Stamp 29 files +370/−29; `git diff main -- <those 29 paths>` = 0 lines (byte-identical to `main`); raw
`git diff HEAD | shasum` = `ec4acb8a…` (`pkt59`/`60`/`61`/`62`) and `3863317c…` (`pkt63`, base-blob index
lines only).

### Shard K

Stamp 29 files +370/−29 sha1 `0c9607…`; `git diff main -- <29 stamp paths>` is nonzero (712 lines on
`pkt74`) = pre-refactor base divergence, NOT work (`main:libs/memory-core/package.json` reads
`version 0.12.3` / `workspace:^` where the worktree working copy reads `0.5.0` / `workspace:*`).
`recall-degradation-proof` carries **no** stamp; its uncommitted dirt is 4 files, +475/−1, path-set sha1
`d4fc39d5490ccdac667187ad4c4c98871f55f023` (`libs/memory-core/src/recall.ts` +13 empty-corpus degradation
emit; `memory-server/src/index.ts` +117 handler passthrough + `RecallDegradationCounters` exposed as
`recall_degradations` in `memory_ping`; new `recall-degradation-visibility.spec.ts` 335 lines;
`memory-server/CLAUDE.md` +11). `main` is one refinement ahead.

### Shard L

Stamp 29 paths +370/−29; `git diff main -- <changed package.json paths>` = 0 lines each. `rf-test` draft
adds a `validMembers` loop in `buildClusterResults` keeping only rowids carrying a vector, re-checks
`<2`, and derives `communityUid(validMembers, salt)` / `member_rowids: validMembers`; comments cite
BL-259 + singleton rule D1.6. `main`'s `cluster.ts` still uses unfiltered
`communityUid(sortedMembers, salt)` / `member_rowids: sortedMembers`. **Cross-reference:** peer shard E's
`cf-test` is the same detached `6de81319` with the stamp + a `cluster.ts` draft (there +12/−2) —
coordinate before discarding either.

### Shard M

Shard committed-unique total +5655/−4437. `turso-adapter`: commit `f17b6193` 2026-07-27 ("feat: full
store-adapter migration — all data packages + extensions"); 59 conflicted paths add/add across
`libs/data/store/store-adapter/*`, `libs/memory-core/src/*`, graph-store, vector-store, hybrid-search,
pnpm-lock. Uncommitted (non-stamp): `store-adapter/src/{factory,retry,sqlite-adapter,turso-adapter,types}.ts`,
`store-adapter/test/contract.test.ts`, `vector-store/src/index.ts`,
`memory-core/src/{cluster,compaction,curate,quota,stats}.ts`, `registry/index.json` +140, + spec files;
9 untracked `.opencode/artifacts/reports|reviews/*.json` (2026-07-26/27 wave). `main` already carries its
own newer store-adapter/turso-adapter. M stamp: 29 package.json +370/−29; the `typecheck-*` stamp hashes
to `009f689c…`.

### Shard N

Both worktrees carry the same canonical 28–29-file package.json stamp (path-set sha1 `0c9607…`),
byte-identical across the two HEADs and **stale**: net −75 vs `main` (e.g. `0.2.0` where `main` reads
`0.2.1`). `main...HEAD` is empty on both; no committed work. **Confirmed:** the `typecheck` target
layering is already complete in `main` — every project these branches touched (`tokenguard-core`,
`sox-nx`, `baseline-capture`, `service-proxy`, `host-registry`, `source-provider`) has a `typecheck`
target in `main` plus `tools/baseline-capture/tsconfig.typecheck.json`, and `main`'s log carries the
later `noop → typecheck-tests → typecheck-src` refactor (`86de3108`, `b1d71619`), superseding both.
**Worth rescuing: nothing.**

---

## Fragment provenance & gaps

- **On disk:** 13 fragments — `shard-A.md` … `shard-M.md`. All 13 pairwise-distinct (sha256 prefixes:
  A `74c6bd46bacc0b79`, B `5694a343147ba3de`, C `b90ae7a050f988c5`, D `28465db87854e3e7`,
  E `8f21079126c97078`, F `053d6b037de84369`, G `d333209c6d298a0c`, H `9d5953ed7b4ec7a2`,
  I `9b097b702c9e69ed`, J `8138a8561a2d540d`, K `88f149b9c571d362`, L `a8565c1557f528e7`,
  M `4eb97c16e4685a2e`).
- **Collision (K/N):** shard N's agent mis-wrote its fragment to `shard-K.md`. On disk, `shard-K.md`
  holds **shard K's own correct content** (rows `pkt74`/`pkt75`/`pkt79`/`recall-degradation-proof`/
  `recall-golden-set`) and matches the authoritative K exactly; it does **not** hold shard N's content.
  Tokens `typecheck-tooling` / `typecheck-transport-sources` appear nowhere on disk. Net effect: shard N's
  fragment was **lost**; K's was intact. Both were rewritten during assembly — `shard-N.md` recreated from
  the authoritative shard-N return, `shard-K.md` re-verified and rewritten preserving its evidence.
- **First batch:** the six worktrees triaged in the first batch — `sibling-scratch-cache`,
  `embedding-model-tier-spec`, `wt-sr79-substrate`, `fix-researcher-hitl-prompt`,
  `recover-stash-typecheck-src`, `invalidation-reason` — have **no fragment** on disk (their names appear
  in none of A–N), so they cannot be included in this union. Their absence is recorded here as a gap.
