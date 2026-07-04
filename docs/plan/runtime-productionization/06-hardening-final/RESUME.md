> **⛔ OBSOLETE (2026-07-04): context-06 is COMPLETE.** All shards (S8–S11), HF-5 forensics,
> and HF-6 closeout landed on main; ADR-0007 is ACCEPTED. Do not resume from this document —
> see [REPORT.md](./REPORT.md) for the final state and the root BACKLOG.md for remaining open items.

# RESUME — runtime-productionization context 06 (hardening + closeout)

**Read this first to resume.** Then read, in order: [`SHARDS.md`](./SHARDS.md) (the work queue),
[`progress.json`](./progress.json) (HF item status), and the root [`/BACKLOG.md`](../../../../BACKLOG.md)
(all BL items). Last updated 2026-07-04.

## Where we are

Contexts 01–05 are merged to main (write-path, reusable-subsystems, supervision SA-1..8, transport,
platform-integrity). **Context 06 is in progress.** Session commit range: `5da1856` (start) → the head
of `main`. Working tree is clean.

### Done + gate-verified this cycle
- **HF-1 chaos** (S1), **HF-2 soak/SLO** (S2), **HF-3 recall score legibility** (S3),
  **HF-4 compaction/quota/backup** (S4) — all merged, `progress.json` = complete.
- **BL-160** — reembed promoted to `memory-core.reembedStore()` + `memory-cli reembed` verb (merged).
- **S7 / BL-161** — deterministic test-embed seam: memory-core tests **140s → 19.7s (7×)**, no flake (merged).
- Current gates (all green): memory-core **280 pass / 6 skip** (19.7s), memory-server **82 pass**,
  real-bge opt-in passes, **smoke 16/0**.
- **Live system:** `memory-server` launchd user-unit is enabled + healthy (BL-156 fix — runs the
  `soxe serve --port` front-shim; `soxe status` shows HEALTHY). The `~/.memory` store's stale embed
  stamp was corrected (BL-158). memory-daemon is DEAD **by design** (ADR-0007) — see S9.

### Resolved BL this cycle
BL-151, 152, 153 (test stabilization) · **BL-154** (CRITICAL WriteQueue chunk deadlock) ·
**BL-155** (CRITICAL CJS-bundle `import.meta.url` crash) · BL-156 (os-unit proxy) · BL-158 (store
stamp) · BL-159 (reembed tool) · BL-160 (reembed→lib) · BL-161 (test perf) · BL-169 (`--extension`
stray dir + smoke-test arg guard).

## Remaining queue — DO THESE (owner directive: fix, don't defer)

All memory-core-touching shards are **serialized** (they share the test suite / `index.ts`). No agents
are running now. Recommended order:

| # | Shard | What | Fence | Gate |
|---|---|---|---|---|
| **S8** | BL-157 (HIGH) | headless `soxe serve --port` HTTP returns `proxy closed`; isolate real bug vs stale multi-backend live state, then fix (decouple HTTP from stdin EOF; reconcile to ONE current-code backend; ensure upgrade restarts stale backend). **Integrator does this (live-state; not agent-safe).** | `libs/service-proxy/`, `apps/sox` serve/upgrade | HTTP initialize+tools/call on :3099 succeed; e2e/smoke green |
| **S9** | BL-162 (MED) | **REMOVE** memory-daemon (don't leave "deprecated") — delete bundle member + manifest + registry + smoke surface + refs (host-runtime `runtime.ts`/`os-unit.ts`, memory-core `index.ts`/`extensions.ts`, memory-server, e2e). Verify in-process enrichment still runs. Owner publishes the bundle-major. | bundle + refs | registry sync + smoke 0-fail; `soxe status` no dead daemon |
| **S10** | BL-164 (MED) | loose `scripts/*-baseline.mjs` create an nx lint circular-dep + hide behind cache — promote into the graph or exclude. | scripts + nx config | `nx lint memory-core --skip-nx-cache` clean |
| **S11** | BL-165 (MED) | make `ingest` canonical (owner chose CONSOLIDATE): route memory-server chunking (`splitIntoChunks`) + write.ts SHA-256 through `ingest`; delete duplicates; verify chunk/dedup parity; then decide ingest public vs memory-core private. | `ingest`, `memory-core/write.ts`, `memory-server/index.ts` | memory-core + memory-server green, smoke 16/0, chunk/dedup parity |
| **HF-5** | — | forensics (owner machine, READ-ONLY): prove exactly one writer per store under final posture. Do AFTER S8 (final backend state). Account for session-serve vs os-unit both matching the entrypoint token. | REPORT.md only | forensic transcript |
| **HF-6** | — | closeout: flip ADR-0007 Status → ACCEPTED; sweep BACKLOG BL-118…169 to match reality (+ fix the BL-number collisions below); write `06-hardening-final/REPORT.md`. **Branch cleanup already DONE** (2026-07-04: all 21 merged plan branches deleted; only `main` remains). | ADR, BACKLOG, REPORT | reviewed sweep |

**Dispatch note:** if using worktree agents, ALWAYS include `nx build` in their gate (S2 slipped a
tsc-only error because its gate was lint+test only). Clean up worktrees after merge (`git worktree
remove` + `git branch -D`) — leftover worktree installs unlinked `node_modules/nx` this session,
requiring a clean-room `rm -rf node_modules && pnpm install` (sanctioned fix; no lockfile drift).

## Dispatch tiers — which model runs what

Two roles (the pattern that worked this cycle: S1–S4/S7/BL-160 were cheaper worktree agents; a
capable model orchestrated + verified). The **gates** (`nx build+lint+test` + `smoke 16/0` + negative
controls) are the safety net that catches a cheaper model's mistakes at merge time.

- **INTEGRATOR (capable model — e.g. Opus):** orchestrates, merges, runs the whole-repo gate + smoke,
  makes owner-facing decisions, and does anything that touches the LIVE system or spec-governed
  lifecycle code. Never delegate live/destructive steps.
- **WORKTREE AGENT (cheaper model — e.g. Sonnet):** executes a single fenced shard in an isolated
  worktree, runs its per-project gate (build+lint+test), commits to its branch, reports. Does NOT
  merge, does NOT touch the live system, does NOT run smoke/registry (integrator does those).

| Item | Tier | Notes |
|---|---|---|
| **S8** BL-157 | **INTEGRATOR (capable) + human oversight** | Hard `service-proxy` debugging + DESTRUCTIVE live backend reconciliation (kills backends on the live box) on spec-governed lifecycle code. Do NOT give a cheaper model live process-kill authority. |
| **S9** remove memory-daemon | Cheaper worktree agent → integrator merges | Mechanical but wide (host-runtime/memory-core/memory-server/registry/e2e). Enforce full gate + smoke on merge. |
| **S10** baseline scripts | Cheaper worktree agent | Well-scoped nx-graph fix; clear gate. Lowest risk. |
| **S11** ingest consolidation | Cheaper worktree agent (parity check enforced) | Must prove chunk-boundary + hash parity so recall/dedup don't shift; integrator verifies parity + smoke. |
| **HF-5** forensics | INTEGRATOR (read-only, live box) | Interpretation matters (session-serve vs os-unit; single-writer proof). |
| **HF-6** closeout | INTEGRATOR | ADR flip + BACKLOG sweep (judgment on statuses/collisions) + REPORT. Mechanical parts delegatable. |

**Hard rule for cheaper models:** STOP and hand back to the integrator before ANY live process touch
(enabling/disabling services, killing/restarting backends, `soxe service …`) — those are integrator-only.

## Known hygiene gaps for HF-6 closeout (non-blocking, no lost work)
- **BL-number collisions in root BACKLOG:** BL-58, BL-119, BL-120, BL-126, BL-127 each label TWO
  different items (reused across plans/sessions) — **all instances are FIXED/RESOLVED**, so no open
  work is lost; it's numbering debt. HF-6 sweep should renumber or annotate.
- **Context 06 has no `REPORT.md` yet** — contexts 01–05 do. HF-6 must write `06-hardening-final/
  REPORT.md` (this `RESUME.md` is the interim current-state source of truth).

## Open BL items still needing decisions/work (not in the S8–S11 queue)

- **BL-157** (HIGH) → S8. **BL-162** → S9. **BL-164** → S10. **BL-165** → S11.
- **BL-166** (HIGH) — orphaned packages **blob-store** (~1.8k LOC) + **claim-verification** (~1.1k LOC)
  + the **hybrid-search cross-encoder** (built, unwired, fake token-overlap not real ONNX, bundle
  worker-path bug): each needs an owner wire-in-or-remove decision. Per-package details in each
  package's `BACKLOG.md`.
- **BL-168** (HIGH) — systemic: audit the recurring module-resolution/bundling/workspace-tooling bug
  class (import.meta.url, worker paths, vite exports-map aliases, boundary-rule false positives, loose
  .mjs, pnpm build-approval, worktree link churn) and write ONE standard. High leverage.
- **BL-167** (LOW) — recall `score_breakdown` per-channel attribution wrong for the lowest-rank
  single-channel node (`total===score` still holds). HF-3 follow-up.
- **BL-163** (FEATURE, blocked) — generalized always-on-service Login-Items via SMAppService; needs a
  code-signing identity. Legitimately deferred.
- **BL-114** (vector-store, HIGH) LanceDB backend in-memory only · **BL-116** (hybrid-search, HIGH)
  fake cross-encoder · **BL-115/117** (ingest) — in per-package BACKLOGs + root.

## Per-package backlogs (RAG substrate)

Each data package now has its own `BACKLOG.md` + `AGENTS.md` (CLAUDE.md symlink), cross-referencing
root BL-IDs: `embedding-provider`, `vector-store`, `hybrid-search`, `ingest`, `blob-store`,
`claim-verification`. A RAG system is buildable from the 5 public data packages; `ingest` (private) +
`memory-core` (transitively 404s on it) are the gaps (BL-165).

## Invariants for the resuming agent
- Build/test/lint via **nx targets only**; run `node scripts/smoke-test.mjs` (0 failures) before any
  merge touching memory-server/host-runtime/install-engine/`libs/data/*`.
- memory-core tests are now FAST (deterministic provider) — the real-bge path is opt-in via
  `SOX_RUN_EMBED_DOWNLOAD_TESTS=1`. Don't reintroduce per-test ONNX warmups.
- Never `git add -A`; explicit paths only. Commit lockfile diffs with the change that caused them.
- Owner directive: **fix or remove — do not defer or label cleanup "deprecated"** (sole consumer).
