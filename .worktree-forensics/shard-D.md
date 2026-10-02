# Worktree forensics — shard D

Repo `/Users/nix/dev/ai/sox-ecosystem`. Default branch `main` = `051d033cbb6358200a44cc913172356c50e001da`.
Read-only: no repo state changed; no merge trial performed (`git merge-tree --write-tree` only).

**Stamp artifact (shard variant):** all five worktrees carry the **identical 29 × `package.json`
unstaged-modified** set (+370/−29), the discoverability metadata stamp mandated by AGENTS.md rule 3 —
each file gains `repository` (`git+https://github.com/PseudoSky/adhd.git`), `homepage`
(`https://github.com/PseudoSky/adhd`) and `keywords`. Same class shard A recorded; **not** a version
bump and **not** the six-file `soxe upgrade` stamp. In worktree 1 it coexists with real commits; in
worktrees 2–5 it is the *only* working-tree dirt.

| worktree | branch | ahead | main...HEAD diffstat | untracked | conflicts | backlog id | superseded? | verdict | one-line evidence |
|---|---|---|---|---|---|---|---|---|---|
| bug-memory-006-community-affordance | feat/bug-memory-006-community-affordance | 6 | 5 files, +997/−8 (SPEC +601, spec.ts +312, index.ts +84/−8, PLAN +4, STATE +4) | none | 3 (PLAN.md, STATE.md, memory-server/src/index.ts) | BUG-MEMORY-006 | no | needs-owner | only unmerged unique work in shard; `main` lacks SPEC-BUG-MEMORY-006.md and the `E_WRONG_KIND`/`E_PENDING_CLUSTER`/`E_WRONG_ID_SPACE` codes; subject entangled with OPEN product-ruling `20b661a2` and RESOLVED triage `acb84de8` |
| bug008-verify | fix/bug008-verify | 0 | ∅ (0 files) | none | 0 | BUG-008 | yes | junk-stamp | HEAD `3cb6469b` already reachable from `main`; only dirt is the 29-file stamp |
| bug017-t1 | bug017/t1 | 0 | ∅ (0 files) | none | 0 | BUG-017 | yes | junk-stamp | HEAD `d1f44d14` already reachable from `main`; only dirt is the 29-file stamp |
| bug018-t4 | bug018/t4 | 0 | ∅ (0 files) | none | 0 | BUG-018 | yes | junk-stamp | HEAD `f127a8ff` already reachable from `main`; only dirt is the 29-file stamp |
| bug019-t5 | bug019/t5 | 0 | ∅ (0 files) | none | 0 | BUG-019 | yes | junk-stamp | HEAD `ac4b2259` already reachable from `main`; only dirt is the 29-file stamp |

## useful / needs-owner detail

- **bug-memory-006-community-affordance — `needs-owner`.** `git log main..HEAD` = 6 commits, all
  `BUG-MEMORY-006`, all dated 2026-08-08, tip `33481941`
  `fix(extensions): make community_uid ID-space check advisory (BUG-MEMORY-006)`; the tip is contained
  by **no other branch**. `git diff main...HEAD` = 5 files, **+997/−8**:
  - `SPEC-BUG-MEMORY-006.md` **+601** (new) — **absent from `main`** (`git cat-file -e` → missing).
  - `extensions/bundles/sox-memory-bundle/members/memory-server/src/…/bug-memory-006-community-affordance.spec.ts`
    **+312** (new regression suite).
  - `extensions/…/members/memory-server/src/index.ts` **+84/−8** — adds, on the `memory_get_community`
    miss path: `E_WRONG_KIND` (entity_uid resolves to a live non-episode node), `E_PENDING_CLUSTER`
    (episode exists but unclustered), and an **advisory** `E_WRONG_ID_SPACE` check
    (`/^[0-9a-f]{32}$/` vs `ULID_RE`) that never pre-query-rejects. `main`'s `index.ts` has
    `E_MISSING_INPUT`/`E_AMBIGUOUS`/`E_NOT_FOUND` but **none** of these — the branch's code is
    genuinely unmerged.
  - `docs/reporting/memory/PLAN.md` +4, `STATE.md` +4 — generated doc churn (the **only** conflicting
    paths besides `index.ts`).

  *Why needs-owner, not useful/merge:* `git merge-tree --write-tree --name-only main
  feat/bug-memory-006-community-affordance` → **3 content conflicts** (`PLAN.md`, `STATE.md`,
  `index.ts`); and the branch's subject is entangled with the backlog graph: the defect triage
  `acb84de8` ("`memory_get_community`'s `E_NOT_FOUND` still conflates wrong-kind-uid with genuinely-absent
  — BUG-MEMORY-002 pattern, different tool") is **resolved**, while the open item `20b661a2`
  ("PRODUCT RULING: do NOT build entity→community resolution … retire the advertised capability")
  may make the whole affordance moot. A human must decide **rebase vs rework vs drop**; the spec
  (+601) and the 312-line test are the rescue-worthy parts (drop the PLAN/STATE churn, regenerate).

## Notes

- The `git diff main` / `git diff --cached main` phantom-file trap was avoided throughout; all
  divergence figures above are from `main...HEAD` and HEAD-relative `git diff --stat HEAD`.
- Worktrees 2–5 are the same shape: `main..HEAD` empty, tip already in `main`, no untracked files,
  clean `merge-tree`, and the 29-file stamp as the sole working-tree change ⇒ safe to remove
  (superseded) with no unique content to rescue.
