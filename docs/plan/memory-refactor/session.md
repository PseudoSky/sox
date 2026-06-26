# Session log — memory-refactor plan authoring

## 2026-06-26 — plan authored (plan-builder ↔ plan-orchestrator)

**Inputs read:** `SCOPE.md` (Parts A–D), `NX-GENERATOR-HANDOFF.md`,
`docs/plan/memory-embedding-quickfix/SCOPE.md`, `scripts/scaffold-data-packages.mjs`, the
`.workflow/plans/permission-enforcement/` reference plan (dag/state/context/audit
conventions), and the live tree (`memory-core`/`memory-enrich` src, bundle members,
registry, eslint boundary rule, `db.ts`/`schema.ts`).

**Codebase facts established (de-risk the plan):**
- Platform subgraph imports neither `memory-core` nor `memory-enrich` → tagging platform
  libs `area:platform` in place is safe.
- The eslint boundary rule's `area:data` positive allowlist makes `data↛platform` bite
  regardless of the target's tags → boundary is real without moving folders.
- Consumers of the memory libs = the 4 bundle members (server/daemon/cli/flush) + the
  composer's internal use of `memory-enrich`.
- `scripts/reembed-memory.mjs` currently lives in the quickfix worktree (unmerged) → (E)
  absorbs it.
- `db.ts`/`schema.ts` entangle graph + vec; `vec_node` is the only vec piece →
  graph-store carves first, vector-store takes only `vec_node` (decision-C seam).

**Decisions ratified by the orchestrator** (baked into `references.json`):
A tag-in-place; B one long-lived branch; C composer-owns-openDb + injected db + standalone
`openVectorStore` (no `data/store`); D facade-then-dissolve, slim `memory-core` keeps its
name, `memory-enrich` dissolves; E re-embed core in `vector-store`. Financial F1/F2/F3 +
all 7 prior decisions confirmed.

**Quickfix caveat:** built-but-not-merged, half-state (live store re-embedded; user-scope
server still hash pending an owner-gated npm republish). `p0-baseline` hard-gates on
`embed_on_hash_fallback:false`; it is correct but cannot ENTER until the republish lands.

**Authored artifacts:** `dag.json` (15 nodes), `state.json`, `state-machine.md`,
`contexts/_shared.md` + 15 per-state contexts, `scripts/audit_memrefactor.py`,
`references.json`, `README.md`, `status.md`, this log.

**Next:** orchestrator dispatch once the entry gate clears. Plan-builder does not execute.
