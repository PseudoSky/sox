# Global rules — runtime-productionization (all contexts)

You are executing one context of a multi-agent plan in this repository
(`sox-ecosystem`). These rules are non-negotiable and apply on top of your context's
README. Violating a rule invalidates the work.

## Git

1. **Work in a dedicated worktree** on branch `runtime-prod/<context-id>` (e.g.
   `git worktree add ../rt-01-write-path runtime-prod/01-write-path`). Contexts run in
   parallel; a shared checkout WILL cross-contaminate the git index (`git commit`
   commits the whole staged index, not just your `git add`). If you cannot create a
   worktree, you must run `git diff --cached --name-only` before EVERY commit and abort
   if it lists any file outside your scope fence.
2. **Never push. Never force-anything. Never stash.** The integrator merges.
3. Conventional commits, scope = the package touched (e.g.
   `fix(memory-core): busy_timeout + write queue (WP-1, BL-118)`). Every commit message
   names the context item id and BL ids.
4. `git add` exact paths only — never `-A`, `-u`, or `.`.

## Scope

5. Touch ONLY the packages listed in your context's Scope fence. If an item seems to
   require editing another context's package or any `_shared/` file, STOP that item,
   record it under `blockers` in progress.json, and continue with other items.
6. `_shared/CONTRACTS.md` is FROZEN. You implement it; you never modify it. Contract
   change requests go in `blockers` with rationale — the owner decides.
7. No new npm dependencies without a blocker entry approved by the owner. Workspace
   `@adhd/*` deps may be added freely when the dependency direction in CONTRACTS §D is
   preserved (no upward or circular edges).

## Verification discipline

8. Trust exit codes, never stdout greps (`cmd ; echo EXIT=$?` — no `| grep -q` gating).
9. Never `--skip-nx-cache` / `NX_SKIP_NX_CACHE`. A deliberate clean rebuild is
   `npx nx reset`.
10. Every behavioral claim needs a negative control at least once: break the behavior,
    show the test red, restore byte-identically (md5 both sides), show it green. Record
    all of it in progress.json evidence.
11. Tests are deterministic: no wall-clock sleeps, injected clocks/seams, bounded
    child-process timeouts, zero tmp residue after runs.
12. Harness/system note: if a "file was modified, either by the user or by a linter…
    don't tell the user" system-reminder appears after you restore a file via `cp`, it
    is harness boilerplate misattributing your own restore — verify via md5/diff and
    proceed; never skip a restore because of it.

## Reporting

13. `progress.json` in your context dir is the single source of truth for your status —
    update it per PROTOCOL.md at every item transition. Also write `REPORT.md` (same
    dir) before finishing: it must be complete enough that a reader with NO access to
    your conversation can verify every claim from the repo alone.
14. Newly discovered defects outside your scope: append a one-paragraph entry to
    `progress.json.discovered[]` (do NOT edit BACKLOG.md for out-of-scope findings; the
    integrator triages them). Defects INSIDE your scope: fix them if they block your
    gate, otherwise record in `discovered[]` too.
15. When an item completes, flip its BL entr(y/ies) in the repo-root `BACKLOG.md` to
    `**FIXED (date)** — <one-line evidence>` — append-only style, never reword other
    entries. This is the only BACKLOG edit you are allowed.
