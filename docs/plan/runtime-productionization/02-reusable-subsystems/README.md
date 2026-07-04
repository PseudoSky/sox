# Context 02 — reusable subsystems migration

**Execute:** read `../_shared/RULES.md` → `../_shared/CONTRACTS.md` →
`../_shared/PROTOCOL.md`, then this file, then ADR 0007 D1/D2 and BACKLOG BL-119/120/
126/127/147/149. Worktree branch: `runtime-prod/02-reusable-subsystems`. Log to
`./progress.json`; finish with `./REPORT.md`.

**Mission:** finish the migration onto the already-existing reusable layer — after this
context, `data/*` owns embedding + enrichment, memory merely hosts them, and the
duplicate implementations are deleted. This is the owner's reusability requirement made
real. It is a MIGRATION, not new construction (see BL-147's reframe note).

**Depends on:** context 01 gate `passed` (its queue + taxonomy are what your outbox
writes ride on). Item RS-0 may run before that.

**Scope fence (may touch):** `libs/memory-core/**`, `libs/data/**`
(embedding-provider, analysis, graph-store, vector-store, hybrid-search),
`libs/data/verify/claim-verification/**` (worker swap ONLY),
`extensions/bundles/sox-memory-bundle/members/memory-server/**`,
`extensions/bundles/sox-memory-bundle/members/memory-daemon/**` (deprecation only),
`_shared/baselines/` (write your two baseline files). Nothing else.

## Items

| id | BL | Work | Acceptance | NC |
|---|---|---|---|---|
| RS-0 | — | **FIRST, before any code change:** capture `_shared/baselines/enrichment-parity.json` per CONTRACTS §K — one full daemon-driven batch pass over a snapshot COPY of a real store (never the live `~/.memory/memory.db`) | baseline file committed with store-snapshot sha | n/a |
| RS-1 | 147 | Migrate memory-core off private `embed.ts` onto `@adhd/sox-embedding-provider`; implement `provider.health()` per CONTRACTS §E in the provider; memory keeps a thin ping/stats adapter; delete `embed.ts` + `embedWorker.ts`; honor `SOX_EMBED_BACKEND` compat mapping | recall/write/update green on the provider; ping's embed block per contract; `embed.ts` gone | yes — force `state:'error'` in a test provider → ping reflects it, writes degrade per contract |
| RS-2 | 149c | One shared worker-thread ONNX host in embedding-provider; migrate hybrid-search `cross-encoder` + claim-verification `worker.ts` onto it | all three packages' suites green; exactly one worker implementation remains (grep) | no |
| RS-3 | 147 | Migrate the enrich hot path (`enrich.ts`, `neardup.ts`, `cluster.ts`, `autolink.ts`, `importance.ts`) off raw SQL onto `GraphBackend`/`VectorBackend` — the pattern six sibling read-path modules already use; reconcile `computeImportance` into `@adhd/sox-analysis.scoreImportance` (BL-149b) | enrichment outputs equivalent on a fixture store (node/edge diffs empty vs pre-migration run) | yes |
| RS-4 | 126 | Generic outbox orchestrator `runOutboxPass` in `@adhd/sox-analysis` per CONTRACTS §F (formalize `organizer_queue`: additive `attempts`/`last_error`/dead-letter migration); memory-server backend hosts it in-process (micro-txns ≤50 rows, embeddings outside txns) | orchestrator has ZERO memory-schema imports (lint/grep gate); dead-letter path covered by test | yes — poison item → lands in dead state after 5 attempts, pass continues |
| RS-5 | 127 | Watermark + `memory_flush` per CONTRACTS §F/§H | flush awaits a seeded backlog deterministically (no sleeps) | yes |
| RS-6 | 149a | Delete BOTH memoryd implementations (memory-core class + server-local copy); deprecate `memory-daemon` member (major-bump plan in REPORT.md — owner publishes) | no memoryd symbol remains (grep); bundle builds green without it | n/a |
| RS-7 | 119, 120 | Flip both to resolved-by-construction with evidence (no daemon exists to duplicate; single hosted orchestrator) | BACKLOG flips with one-line proofs | n/a |

## Gate

**Parity:** migrated orchestrator over the SAME RS-0 snapshot within ±2% on every
counter. **Soak:** enrichment-backlog soak (≥5k queued items) with zero `SQLITE_BUSY`
and zero `E_BUSY` surfaced to writes. **Reusability demo:** a test that composes
provider + backends + `runOutboxPass` over a NON-memory scratch SQLite store (different
schema) and enriches it — this is the owner's requirement, prove it. All five data/*
suites + memory suites green.

## Subdispatch notes

Good candidates: the mechanical raw-SQL→backend migrations per file (exact
transformations, one file per dispatch); the three-way worker swap; verifier pass with
its own negative control. Keep RS-0 (baseline), RS-4 (orchestrator design), and the
parity judgment yourself. Never let a subagent touch the live `~/.memory` store —
fixtures and snapshots only.
