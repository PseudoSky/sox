# Worktree forensics — shard A

Repo `/Users/nix/dev/ai/sox-ecosystem`. Default branch `main` = `051d033cbb6358200a44cc913172356c50e001da`.
Read-only: no repo state changed; no merge trial performed (`git merge-tree --write-tree` only).

**Stamp artifact (shard variant):** 29 × `package.json` unstaged-modified (+370/−29), being the
discoverability metadata stamp mandated by AGENTS.md rule 3 — each file gains `repository`
(`git+https://github.com/PseudoSky/adhd.git`), `homepage` (`https://github.com/PseudoSky/adhd`) and
`keywords`. **Not** a version bump. It is the *only* dirt in worktrees 1–3 and co-resident with real
commits in worktree 5.

| worktree | branch | ahead | main...HEAD diffstat | untracked | conflicts | backlog id | superseded? | verdict | one-line evidence |
|---|---|---|---|---|---|---|---|---|---|
| adapter-connection-recycle | feat/adapter-connection-recycle | 0 | ∅ (0 files) | none | 0 | — | yes | superseded | HEAD `92435f2c` already reachable from `main`; only dirt is the 29-file stamp |
| adr0011-backlog-cutover | feat/adr0011-backlog-cutover | 0 | ∅ (0 files) | none | 0 | ADR-0011 | yes | superseded | HEAD `894e2b14` already in `main`; dirt is stamp-only |
| adr0011-stage2-write-off | feat/adr0011-stage2-write-off | 0 | ∅ (0 files) | none | 0 | ADR-0011 (commit refs BL-479) | yes | superseded | HEAD `5bea16c1` already in `main`; dirt is stamp-only |
| agent-ir-3 | feat/agent-ir-batch-3 | 0 | ∅ (0 files) | `node_modules/` (1) | 0 | — | yes | superseded | HEAD `655e9a0f` already in `main`; only leftover is untracked `node_modules`, no stamp |
| agmd-constraints | docs/agmd-constraints | 2 | 3 files, +24/−4 | none | 2 (PLAN.md, STATE.md) | — | partly | useful | `main..HEAD` = 2 commits; AGENTS.md +20 (two new ⛔ constraint sections) NOT in `main`; generated PLAN/STATE churn conflicts |

## useful / needs-owner detail

- **agmd-constraints — `useful`.** `git log main..HEAD` = 2 commits: `c6df35d7`
  `docs(authoring): add commitlint and --skip-nx-cache agent constraints` and `2867c8cc`
  `chore(memory-core): regenerate plan docs from backlog graph`. `git diff main...HEAD` = 3 files,
  +24/−4:
  - `AGENTS.md` **+20** — two new ⛔ sections that are **absent from `main`**:
    - *COMMIT MESSAGES MUST SATISFY COMMITLINT* — `commitlint.config.js` extends
      `@commitlint/config-conventional`, enforced via `.husky/commit-msg` installed by
      `tools/install-git-hooks.mjs`; scope enum warn-level.
    - *NEVER PASS `--skip-nx-cache` WITHOUT APPROVAL* — default banned (user directive 2026-08-12,
      BL-456-class misattribution).
  - `docs/reporting/memory/PLAN.md` and `STATE.md` — **generated** plan docs regenerated from an
    older backlog snapshot (open in-scope 71→72, in-scope-without-packet 44→45, BL-569 newly added).
    These are the **only conflicting paths** (`git merge-tree --write-tree --name-only main
    docs/agmd-constraints` → content conflict in both); `AGENTS.md` merges clean.

  *Supersession nuance:* `main` **already enforces** commitlint (`commitlint.config.js` dated
  Sep 29 and executable `.husky/commit-msg` are present on `main`), so the **enforcement half is
  superseded**. But `main`'s `AGENTS.md` contains **no** commitlint/skip-nx-cache heading
  (only a pre-existing unrelated `--skip-nx-cache` prose mention at `AGENTS.md:341`) — so the
  **documentation half is genuinely unmerged**. Rescue value = cherry-pick the `AGENTS.md` +20 lines
  and **drop** the generated PLAN/STATE churn (regenerate from current `main` instead).
