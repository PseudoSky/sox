# P1 — dependency-adopt

**Decision class.** Adopt, replace, or reject a tool, library, framework, or API.

**Scope domains:** `library-selection`, `tooling-process`, `api-usage`.
**Answer category:** `dependency-verdict` (primary), `comparison-table` (of candidates).

## Output contract

1. **Candidate table** — one row per candidate:
   `| Tool | Maintained? | Weekly downloads | License | Last release | Fit | Decision |`
   Every numeric cell cites where it came from (registry/API URL), never a blog.
2. **Per-candidate verdict** — exactly `approved` or `blocked`, each with a one-sentence rationale.
   At least one `blocked` is expected; an all-approved run means triage was skipped.
3. **Build-vs-integrate** — one row per slot: `| Slot | Decision | Rationale |` (rationale ≤1 sentence).
4. **Version pin** — the exact version the verdict applies to.

## Verification rules (hard gate)

- Every metric traced to a primary registry/API (`npm view`, crates/pypi/maven API, GitHub API).
  A number lifted from a C-grade page is traced to primary or marked LOW.
- License fetched, not assumed; a missing/forbidden license is a `blocked`.
- The candidate's own claim is not evidence — independently exercised or third-party verified.
- The verdict states the problem the candidate *does* solve even when blocked.

## Agent merge (process borrowed)

- `researcher` (sox-ecosystem, canonical) — build-vs-integrate verdict, per-candidate
  `agent:approved`/`agent:blocked`, registry/metrics primitives.
- `testing-tool-evaluator` — independent vendor-claim testing.
- `ml-research-scout` — model/arXiv scouting for ML candidates.
- `project-idea-validator` — fatal-flaw / anti-sycophancy pass before approving.

## Fail conditions

- All approved, no block.
- A metric with no primary source.
- No version pin.
