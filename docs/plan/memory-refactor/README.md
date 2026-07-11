# Plan — Memory subsystem decomposition + agent-optimized workspace

**Status:** authored, execution-ready · **Branch:** `feat/memory-refactor` (off post-quickfix `main`)
**Entry gate:** ⛔ blocked on the [memory-embedding-quickfix](../memory-embedding-quickfix/SCOPE.md)
merging + an owner-gated npm republish landing real embeddings on the live user-scope server.

This is a resumable plan-state-machine plan (same artifact set as
`.workflow/plans/permission-enforcement/`). The **plan-orchestrator** dispatches it
state-by-state; no further design decisions are required to execute.

## What this plan does (and does not)

**Does** — decompose the memory subsystem into **reusable, independently-versioned
`data/*` packages** organized for agent discovery, with embeddings as a swappable provider
and a vector store that enforces its space invariant:
1. **Establishes the layout** — the two-level `area/group/package` taxonomy + module
   boundaries (`data↛platform`), tags existing libs into it in place.
2. **Consumes** the external nx generator (built by a separate team) + the
   `scripts/scaffold-data-packages.mjs` skeletons — it does **not build the generator**.
3. **Extracts** six `data/*` primitives from `memory-core`/`memory-enrich`
   (`embedding-provider`, `graph-store`, `vector-store`, `hybrid-search`, `analysis`,
   `ingest`), dissolves `memory-enrich`, and leaves a slim `memory-core` domain composer —
   with the external `memory_*` 19-tool contract **unchanged**.
4. **Adds the agent-routing layer** — a generated routing index (drift-gated), hierarchical
   CLAUDE.md, ROUTER.md, soft-memory advisory.

**Does not** — build the nx generator (external team); the quickfix's runtime repair
(separate, lands first); the physical `libs/platform/<group>/` folder relocation (a fast
follow-on — this plan tags platform/shared in place only); change the `memory_*` external
tool contract; OS-kernel sandboxing; rewrite host-runtime lifecycle.

## Key resolved decisions (see `references.json` for the full set)

- **A — platform migration:** tag-in-place now; physical relocation is a follow-on.
- **B — branch:** one long-lived `feat/memory-refactor`; the C2/C4 content-addressed
  registry gate makes a stacked-PR train un-mergeable.
- **C — connection seam:** the composer owns `openDb`; `graph-store` + `vector-store`
  accept an injected `Database`; `vector-store` ships a standalone `openVectorStore`; no
  `data/store` package. (`data/vectors ↛ data/graph`.)
- **D — dissolve:** facade-then-dissolve; slim `memory-core` REMAINS (name kept);
  `memory-enrich` dissolves into `analysis`+`ingest`.
- **E — re-embed core:** lives in `vector-store` (owns the space invariant); absorbs
  `scripts/reembed-memory.mjs`; one core, exposed as a daemon op AND a thin script wrapper.

**Financial posture:** F1 `data/*` public@0.x (unstable tier), publish action owner-gated ·
F2 no prebuild-CI matrix · F3 no paid/remote embedding provider (`inference` stays
named-but-empty).

## Hard invariants (see `contexts/_shared.md`)

`[inv:space]` modelId+dim define the vector space · `[inv:tool-contract-stable]` the 19
`memory_*` tools are byte-unchanged · `[inv:loud-fail]` no silent hash downgrade ·
`[inv:degrade-to-bm25]` retrieval survives missing vectors · `[inv:boundary]`
data→data|shared, platform→platform|shared, shared→shared · `[inv:registry-current]`
sync-index after artifact change, never hand-edit, never `git add -A` · `[inv:no-regress]`
nothing green goes red (e2e orphans reconciled vs BL-63) · `[inv:reality]` verified against
real built artifacts + live MCP.

## Layout

```
docs/plan/memory-refactor/
├── README.md            ← this file
├── SCOPE.md             ← strategic brief (input)
├── NX-GENERATOR-HANDOFF.md ← layout/standards spec (input)
├── dag.json             ← authoritative node graph + guards (15 nodes)
├── state.json           ← live status (resumable)
├── state-machine.md     ← waves, critical path, gate discipline
├── references.json      ← sources, source→package map, consumers, decisions
├── status.md            ← human-readable progress
├── session.md           ← running session log
├── contexts/
│   ├── _shared.md       ← glossary [def:*], invariants [inv:*], shapes, fixtures
│   └── <slug>.md        ← one self-contained work order per node
├── scripts/
│   └── audit_memrefactor.py ← phase-cumulative reality audit
└── baseline/            ← (produced by p0) tool-snapshot.json, baseline.md
```

## How to run

The orchestrator: `execute plan docs/plan/memory-refactor`. It reads `dag.json`/`state.json`,
dispatches each ready state to a `00-active` executor at the declared tier, runs the
state's `guard`, advances `state.json` on green, and halts on any non-clean gate. Start is
blocked until the quickfix entry gate clears (`state.json.entry_blocked_on`).

## Definition of Done

Observable, consumer-facing acceptance — each clause is a checkable signal, not a builder
mechanic. The plan is complete only when every clause holds against real built artifacts and
the live MCP (`[inv:reality]`).

- **[dod.1]** The 6 `data/*` packages (`embedding-provider`, `vector-store`, `graph-store`,
  `hybrid-search`, `analysis`, `ingest`) build, lint, and pass unit tests independently
  (`nx build|lint|test <name>` exits 0 for each).
- **[dod.2]** The module-boundary constraint `data↛platform` is enforced at lint time — a
  synthetic `data→platform` import fails `nx lint` (run in a sandbox copy, never landed).
- **[dod.3]** The 19 `memory_*` MCP tools are byte-unchanged from the `p0-baseline` snapshot
  (`tool-snapshot.json` diff-clean) — `[inv:tool-contract-stable]`.
- **[dod.4]** A real `memory_write` + `memory_recall` on the live user-scope server returns
  semantically ranked results; the `[fix:cosine-sanity]` probe shows cosine of unrelated
  strings ≈ 0, not ≈ 0.99.
  - `entrypoint: python3 docs/plan/memory-refactor/scripts/audit_memrefactor.py --phase final`
- **[dod.5]** `hybrid-search` degrades to BM25 when vectors are unavailable — returns
  results, no crash (`[def:degrade-to-bm25]`).
  - `entrypoint: npx nx test hybrid-search`
- **[dod.6]** `pack-smoke.mjs` passes: each public `data/*` tarball installs into a clean tmp
  dir outside the workspace and its native carriers (fastembed/onnxruntime-node +
  better-sqlite3/sqlite-vec) resolve from declared `dependencies` (the BL-87 affirmative guard).
  - `entrypoint: node docs/plan/memory-refactor/scripts/pack-smoke.mjs`
- **[dod.7]** The routing index `docs/routing/map.json` is generated (not hand-maintained);
  the drift gate fails on a synthetic metadata change and passes after regeneration.
- **[dod.8]** `feat/memory-refactor` merges to `main` with zero new red gates (e2e zero
  orphans reconciled vs BL-63; registry drift green) — `[inv:no-regress]`.
