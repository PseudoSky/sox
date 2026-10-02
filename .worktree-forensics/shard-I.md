# Shard I — abandoned-worktree forensics (read-only)

Repo: `sox-ecosystem`. Signals are HEAD-relative only (`diff main...HEAD --stat`, `diff --stat HEAD`); `diff main` phantom files ignored (pre-refactor fork).
Conflicts measured with `git merge-tree --write-tree --name-only` (no trial merge, no mutation).

| worktree | branch | ahead | main...HEAD diffstat | untracked | conflicts | backlog id | superseded? | verdict | one-line evidence |
|---|---|---|---|---|---|---|---|---|---|
| pkt45-finish-telemetry | feat/pkt45-finish-telemetry | 0 | (empty) | none (29 modified `package.json`, stamp only) | 0 | PKT-45, BL-466 | yes — HEAD `ee928285` is ancestor of main | junk-stamp | work merged; only dirt is redundant package metadata |
| pkt55-suite-variance | feat/pkt55-suite-variance | 0 | (empty) | none (29 stamp) | 0 | PKT-55, BL-202 | yes — HEAD `c76f283c` is ancestor of main | junk-stamp | work merged; only dirt is redundant package metadata |
| pkt56-orphan-branch-guard | feat/pkt56-orphan-branch-guard | 1 | `SPEC-PKT-56.md \| 466 +++` (1 file, +466) | none (29 stamp) | 0 | **PKT-56, BL-422** | **no** — HEAD `b6be4d65` not in main; spec absent from main | **useful** | 466-line orphan-worktree-sweep design spec exists only here; no implementation of BL-422 in main |
| pkt57-open-typing-adr | feat/pkt57-open-typing-adr | 0 | (empty) | none (29 stamp) | 0 | PKT-57, BL-438 | yes — HEAD `5792a7e1` is ancestor of main | junk-stamp | work merged; only dirt is redundant package metadata |
| pkt58-open-kind-check | feat/pkt58-open-kind-check | 0 | (empty) | none (29 stamp) | 0 | PKT-58, BL-439 | yes — HEAD `6b830db6` is ancestor of main | junk-stamp | work merged; only dirt is redundant package metadata |

## Bullets

- **pkt56-orphan-branch-guard — useful.** The single unmerged deliverable in this shard: `SPEC-PKT-56.md` (+466 lines, HEAD `b6be4d65`), absent from `main` (main carries SPEC-PKT-07/18/22/38/39/55/57/58/59/60/61/62/63/74/75/79 but not 56). It designs the sweep for **BL-422** — *"an agent's commits can land on a disposable worktree branch and be reachable from nowhere else"* (backlog uid `59c2cd66-ae12-474a-901d-1293a71a9656`, **open, HIGH, process**). Root cause it records: commits `af45f77` & `e275039` landed on `worktree-agent-a54e5171a1615a001`, reachable nowhere, because an external dispatch harness moved the committing agent's cwd. Design reuses the `tools/unstage-orphans.mjs` report/`--apply`/`--force` convention and sources `commit-mine.mjs`, `guards-manifest.mjs`, `run-guards.mjs`, `.husky/pre-commit`, `.github/workflows/ci.yml`, and the SAFE_GIT_ENV test harnesses. No implementation of BL-422 exists in main (no orphan-commit-sweep tool; only unrelated `unstage-orphans.mjs`=BL-463, `reap-memory-sidecars.cjs`, `reap-nx-daemons.mjs`). **Worth rescuing: the spec text itself.**

## Stamp artifact (all five worktrees)

Identical uncommitted metadata edit confined to `package.json` files: 29 paths, `29 files changed, 370 insertions(+), 29 deletions(-)` each. Two base variants differ only in the diff index line and the version fields (`memory-core` 0.6.0 in pkt45 vs 0.5.0 in pkt57); added metadata text is identical. Added keys (memory-core example): `keywords: ["memory","database","sqlite","embedding","typescript"]`, `repository: git+https://github.com/PseudoSky/adhd.git`, `homepage: https://github.com/PseudoSky/adhd`. **Redundant with `main`** — main's `libs/memory-core/package.json` already carries these exact values ⇒ the dirt is a `soxe upgrade` version stamp, `junk-stamp`.
