# P3 — codebase-evidence

**Decision class.** Produce *evidence* about this repo (read-only) to satisfy a verification or
testing contract — not a plain lookup, which leaves the skill to `code-intel`.

**Scope domains:** `codebase-navigation` (evidence-grade only), `testing`.
**Answer category:** `file-paths`, `raw-tool-output`, `root-cause` (local), red→green evidence.

## Output contract

1. **Claim → `file:line`** for every assertion. A grep hit is not a reading; the file is opened and
   the line quoted.
2. **Command evidence** — the exact command and its **exit status**; a failing command's first
   failing assertion or error line.
3. **Red→green evidence gate** — when the question is a fix/revalidation, a test naming the item
   that fails with the fix disabled and passes with it restored, with both outputs.
4. **Provenance** — the git revision and tree state the evidence was taken at
   (`git status --porcelain`, or the tree-state check for the project).

## Verification rules (hard gate)

- No unsourced assertion: every claim resolves to a `file:line` or a command with exit status.
- Exit status decides success/failure; a zero exit is reported as success, never as "could not verify".
- The revision is pinned with the evidence so it is reproducible.
- A search hit, rendered tool output, or summary never substitutes for the read.

## Agent merge (process borrowed)

- `search-specialist` — retrieval-query design (targeted, not broad).
- `explore` — navigation technique (locate the surface fast, then read it).

## Fail conditions

- A claim with no `file:line`.
- A command reported without its exit status.
- A fix marked done with no red→green pair.
