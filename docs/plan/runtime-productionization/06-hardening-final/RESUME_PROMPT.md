# Resume prompt — copy/paste into a fresh session

> Paste the block below verbatim to resume runtime-productionization context 06. It bootstraps into
> [`RESUME.md`](./RESUME.md) (the authoritative state doc) and states the immediate queue + invariants.

---

You are resuming the **sox-ecosystem runtime-productionization plan** (context 06 — hardening + closeout). Working dir: `/Users/nix/dev/ai/sox-ecosystem`, branch `main`.

**Bootstrap (read in this order, then stop and confirm your plan):**
1. `docs/plan/runtime-productionization/06-hardening-final/RESUME.md` — the authoritative current-state + queue doc. **Read this first.**
2. `docs/plan/runtime-productionization/06-hardening-final/SHARDS.md` — full work orders for S8–S11 + HF-5/HF-6.
3. `docs/plan/runtime-productionization/06-hardening-final/progress.json` — HF item status/evidence.
4. `BACKLOG.md` (root) — all BL-118…169; plus each `libs/data/*/BACKLOG.md`.
5. First: `git log --oneline -15`, `git status --short`.

**Ground truth (verified, don't re-derive):**
- Contexts 01–05 merged. Context-06 HF-1..4 + S7(BL-161) + BL-160 done & gate-verified: memory-core **280 pass / 19.7s**, memory-server **82 pass**, smoke **16/0**, real-bge opt-in passes.
- Tree clean; **only `main` exists** (all merged plan branches deleted); no worktrees.
- Live: `memory-server` launchd user-unit is HEALTHY; `~/.memory` store stamp fixed; `memory-daemon` is dead **by design** (ADR-0007).

**Remaining queue** (memory-core-touching shards are serialized; no agents running):
- **S8** — BL-157: fix headless `soxe serve --port` `proxy closed` + reconcile to one current-code writer backend. *Integrator does this (live-state, not agent-safe).*
- **S9** — BL-162: **remove** the obsolete `memory-daemon` extension (delete member + manifest + registry + smoke surface + refs; verify in-process enrichment still runs).
- **S10** — BL-164: promote/exclude loose `scripts/*-baseline.mjs` to kill the nx lint circular-dep.
- **S11** — BL-165: make `ingest` the canonical ingestion layer (route memory-server `splitIntoChunks` + write.ts SHA-256 through it; verify parity).
- **HF-5** forensics (after S8) → **HF-6** closeout (flip ADR-0007→ACCEPTED, sweep BACKLOG incl. BL-number collisions, write `06-hardening-final/REPORT.md`; branch cleanup already done).

**Also open (owner decisions):** BL-166 (orphaned blob-store / claim-verification / cross-encoder — wire-in-or-remove), BL-168 (systemic module-resolution/tooling-debt audit), BL-163 (SMAppService feature, blocked on signing).

**Dispatch tiers (see RESUME.md → "Dispatch tiers"):** run as INTEGRATOR (capable model) — you orchestrate, merge, run smoke, and do all live/spec-governed work. Delegate the fenced implementation shards to cheaper worktree agents (Sonnet): **S10** (safe), **S9** and **S11** (with full gate + parity verified on merge). **Keep S8 (live backend reconciliation), HF-5 (forensics), and HF-6 (closeout judgment) on the capable model.** Cheaper models must STOP before ANY live process touch (`soxe service …`, killing/restarting backends).

**Rules:** nx targets only; run `node scripts/smoke-test.mjs` (0 fail) before any merge touching memory-server/host-runtime/install-engine/`libs/data/*`; include `nx build` in any dispatched agent's gate; explicit-path `git add` only; **fix or remove — don't defer or label cleanup "deprecated"** (sole consumer). Start at **S8** (or reorder S8–S11 as you prefer) after confirming the plan.
