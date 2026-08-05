# SDLC-v0.0.1 — CF vs RF A/B Experiment Design

> **Version:** v0.0.1 · **Date:** 2026-08-03 · **Status:** DESIGN — not yet run
> **Parent:** `docs/research/content-first/RESUME.md` §8 (Experiment Framework)
>
> First controlled A/B experiment: a multi-stage SDLC cycle executed identically
> under both CF (content-first rewrite) and RF (role-first passthrough), with
> strict isolation between the two arms.

---

## Hypothesis (CF vs RF)

**CF will show superior cross-agent cache reuse, lower per-turn token overhead,
and faster handoff recovery compared to RF, while producing equivalent-quality
deliverables.**

Specifically:

| Metric | Prediction (CF vs RF) |
|--------|----------------------|
| Cross-agent first-turn cache reuse | CF: 80–95% of prior agent's context cached<br>RF: 0–15% (position-0 SP differs per agent) |
| Per-turn SP loading overhead | CF: shared anchor loaded once per turn (~63K chars), mostly cached<br>RF: full per-agent SP loaded each turn, differs per stage |
| Handoff cold-start penalty | CF: ~3–20K uncached (persona'd user message only)<br>RF: full context recompute at every handoff |
| Within-stage cache efficiency | Equivalent (both ≥95% by turn 2) |
| Deliverable quality | Equivalent (same spec-driven workflow, independent review) |
| Total prompt tokens for equivalent work | CF < RF (eliminates per-agent SP redundancy) |
| Detected cross-agent context utilization | CF agents reference prior-agent outputs from conversation context more than RF (shared session preserves the chain of reasoning) |

---

## Experiment Design

### Isolation Rules

1. **Separate worktrees outside the repo.** Each arm gets a worktree under
   `~/dev/.sdlc-experiments/arm-{cf,rf}/` — unreachable by `grep -r` from
   the other arm's worktree or the main repo checkout.

2. **No shared state writes.** Agents are explicitly instructed:
   > "You MUST NOT write to any file or directory outside this worktree
   > (all paths must start with `.` relative to the worktree root). Do not
   > write to `~/.adhd/`, `~/dev/node/adhd/`, or any shared state."

3. **Worktree chroot.** Both arms start with `pwd` = their respective
   worktree root. The CF/RF session context includes the worktree path
   as the only workspace.

4. **Explicit backlog item.** Both arms implement the SAME feature. The
   product agent reads the item from a markdown file inside the worktree
   (not from `backlog get-item` — backlog is shared state). The feature
   description is written to `<worktree>/FEATURE.md` before the run.

5. **No shared tool access.** Backlog CLI is available for read-only
   discovery only; `backlog claim-item` and `backlog update-item` are
   prohibited. All deliverables stay within the worktree.

### Feature Selection

The feature is pre-selected and written to each worktree's `FEATURE.md`.
Candidates (pick one; both arms get the same):

- `FEAT-APIGEN-TS-TYPE-CODEGEN-001 (uid 475)` — JSON-Schema → TS type declarations
- `FEAT-002 (uid 628)` — extract-stage IR cache plugin
- `FEAT-001 (uid 620)` — configurable `usage(op)` full-schema command

The feature file contains the same `backlog get-item` body text for both arms.

### Agent Workflow

```
              ┌─────────────────────┐
              │  Product            │
              │  Reads FEATURE.md   │
              │  Writes:            │
              │  docs/acceptance.md │
              └────────┬────────────┘
                       │ handoff to architect
              ┌────────▼────────────┐
              │  Architect           │
              │  Reads acceptance.md │
              │  Writes:             │
              │  docs/spec.md        │
              └────────┬────────────┘
                       │ handoff to typescript
              ┌────────▼────────────┐
              │  Typescript          │
              │  Reads spec.md       │
              │  Implements feature  │
              │  Runs tests          │
              │  Writes: code + test │
              └────────┬────────────┘
                       │ handoff to review
              ┌────────▼────────────┐
              │  Review              │
              │  Reads acceptance.md │
              │  Reads spec.md       │
              │  Verifies code/test  │
              │  Runs fresh test gate│
              │  Writes: review.md   │
              └────────┬────────────┘
                       │ PASS or FAIL
           ┌───────────┴───────────┐
           ▼                       ▼
    ┌──────────────┐      ┌──────────────┐
    │  PASS        │      │  FAIL        │
    │  → product   │      │  → typescript │
    │    (final)   │      │    (correct)  │
    └──────────────┘      └──────┬───────┘
                                 │ handoff to review (again)
                                 └── ... repeat until PASS
                                 │ handoff to product (final)
                                 ▼
                          ┌──────────────┐
                          │  Product     │
                          │  (final sign-│
                          │   off)       │
                          │  Writes:     │
                          │  README.md   │
                          └──────────────┘
```

### Stage Specifications

**Stage 0 — Product (selection + acceptance criteria)**
- **Input:** `<worktree>/FEATURE.md` (pre-written feature description)
- **Output:** `<worktree>/docs/acceptance.md`
- **Format:**
  ```markdown
  # Acceptance Criteria — <feature title>
  - **Priority:** <MEDIUM|HIGH>
  - **Kind:** FEAT
  
  ## What "done" looks like
  1. <observable acceptance criterion — testable, specific, binary pass/fail>
  2. ...
  
  ## Out of scope
  - <explicit scope boundaries>
  
  ## Verification plan
  | Criterion | How to verify |
  |-----------|---------------|
  | ...       | ...           |
  ```
- **Handoff:** writes acceptance.md, then handsoff to architect with `input` summarizing the feature and linking to the acceptance doc.

**Stage 1 — Architect (implementation specification)**
- **Input:** `<worktree>/docs/acceptance.md` from product
- **Output:** `<worktree>/docs/spec.md`
- **Format:**
  ```markdown
  # Implementation Spec — <feature>
  - Chain: <chain-id>
  - Architect stage deliverable. Typescript stage implements this spec verbatim.
  - Review stage verifies against this spec AND docs/acceptance.md.
  
  ## Overview
  <feature summary, problem statement>
  
  ## Resolved questions
  1. ...
  
  ## Exact file changes
  <per-file change descriptions with code blocks, import paths, interface signatures>
  
  ## Package and test structure
  <package names, test file paths, what each suite must cover>
  
  ## Out of scope
  <unchanged packages, unmodified interfaces>
  ```
- **Handoff:** writes spec.md, then handsoff to typescript with `input` summarizing the spec.

**Stage 2 — Typescript (implementation)**
- **Input:** `<worktree>/docs/spec.md` from architect
- **Output:** source code + test files matching the spec exactly
- **Requirements:** `nx build <project>` must pass, `nx test <project>` must pass (fresh, no cache)
- **Handoff:** commits implementation, handsoff to review.

**Stage 3 — Review (verification)**
- **Input:** `<worktree>/docs/acceptance.md`, `<worktree>/docs/spec.md`, and all implementation files
- **Output:** `<worktree>/docs/review.md`
- **Activities:**
  1. Verify every acceptance criterion passes
  2. Verify every spec requirement is implemented
  3. Run fresh test gates (no nx cache)
  4. Verify no forbidden files touched
  5. Report PASS or FAIL with evidence
- **Format:**
  ```markdown
  # Review — <feature>
  - **Verdict:** PASS | PASS-WITH-NITS | FAIL
  - **Reviewer:** review stage
  
  ## Gates (real exit codes)
  | Command | Exit |
  |---------|------|
  | `nx test <project>` | 0 |
  | ... | ... |
  
  ## Acceptance criteria
  | Criterion | Status | Evidence |
  |-----------|--------|----------|
  | ... | PASS/FAIL | ... |
  
  ## Notes
  <findings, nits, recommendations>
  ```
- **If PASS:** handoff to product (final)
- **If FAIL:** handoff to typescript with correction notes

**Stage 4 (optional) — Typescript correction**
- Fix failures identified in review
- Re-run test gates
- Handoff back to review

**Stage 5 — Product (final sign-off)**
- Read acceptance.md, spec.md, review.md
- Confirm all criteria met
- Write final notes
- Handoff: done (no continuation)

---

## Expected Metrics — RF (Role-First)

Each stage is a separate opencode session. System prompt = full agent SP at position 0,
different per agent. Shared prefix = near zero (each SP is unique).

```
STAGE 0 — product (1 session)
  turns: ~15–30
  tokens: ~0.5–2M
  per-turn SP loading: full product SP (~71K chars) × turns, mostly cached within stage
  cross-stage: N/A (first stage)

STAGE 1 — architect (1 session, fresh)
  turns: ~15–30
  tokens: ~1–3M
  first turn: FULL context recompute (product context not cached)
  per-turn SP loading: full architect SP (~67K chars) × turns, fresh on turn 1
  cross-stage first-turn cache: ~0–5% (only generic boilerplate shared)

STAGE 2 — typescript (1 session, fresh)
  turns: ~100–180
  tokens: ~12–30M
  first turn: FULL context recompute (product + architect not cached)
  per-turn SP loading: full typescript SP (~67K chars) × turns
  cross-stage first-turn cache: ~0–5%

STAGE 3 — review (1 session, fresh)
  turns: ~15–40
  tokens: ~3–5M
  first turn: FULL context recompute (product + architect + typescript not cached)
  per-turn SP loading: full review SP (~67K chars) × turns
  cross-stage first-turn cache: ~0–5%
```

**RF total estimate (4 stages):** 150–250 turns, ~16–40M tokens
**Cross-agent cache reuse:** near 0%
**Per-run SP loading overhead:** sum of (per-agent SP size × per-stage turns) ≈ 25–45M chars

---

## Expected Metrics — CF (Content-First)

Single session. Shared anchor at position 0, persona as last-user-message suffix.
Warm handoffs embed task in persona suffix. Conversation prefix grows monotonically.

```
STAGE 0 — product (same session)
  turns: ~15–30
  tokens: ~0.5–2M
  first turn: shared anchor cached from prior sessions, conversation fresh
  saving: anchor reuse (13–16K tokens), within-stage builds to 90%+

STAGE 1 — architect (same session, warm handoff)
  turns: ~15–30
  tokens: ~1–3M
  first turn: shared anchor (cached) + product's conversation minus persona (~80–95%)
  per-turn SP loading: shared anchor (~63K) cached by turn 2, persona in tail
  cross-stage first-turn cache: ~80–95% of product's context

STAGE 2 — typescript (same session, warm handoff)
  turns: ~100–180
  tokens: ~12–30M
  first turn: shared + product + architect all cached (~90–98%)
  per-turn SP loading: shared anchor cached, persona only new
  cross-stage first-turn cache: ~90–98% of accumulated context

STAGE 3 — review (same session, warm handoff)
  turns: ~15–40  
  tokens: ~3–5M
  first turn: shared + product + architect + typescript all cached (~95–99%)
  per-turn SP loading: shared anchor cached since turn 1, persona only new
  cross-stage first-turn cache: ~95–99% of accumulated context
```

**CF total estimate (4 stages):** 150–250 turns, ~14–38M tokens (fewer than RF)
**Cross-agent cache reuse:** 80–99% on first turn after each handoff
**Per-run SP loading overhead:** shared anchor (63K chars), loaded once per turn, cached after turn 1

**Key CF advantage:** the shared anchor IS the SP loading per turn — same 63K for every agent.
In RF, each agent loads its own ~67–71K SP from scratch at least once per session.
CF eliminates per-agent SP redundancy entirely.

---

## Metrics to Collect (per run)

### Per-stage metrics
| Metric | How to measure | RF expected | CF expected |
|--------|---------------|-------------|-------------|
| `stage_turns` | count of turn events per agent | | |
| `stage_tokens` | sum of `tokens` per agent | | |
| `stage_cached` | sum of `cached` per agent | | |
| `stage_savings_pct` | `cached / tokens` | | |
| `stage_first_turn_tokens` | first turn `tokens` after handoff | | |
| `stage_first_turn_cached` | first turn `cached` after handoff | ~0% | 80–99% |
| `stage_first_turn_savings` | first turn savings after handoff | | |
| `stage_shared_chars` | sum of `shared_chars` per stage | varies by agent | constant |
| `stage_persona_chars` | sum of `persona_chars` per stage | | |
| `stage_context_chars` | sum of `context_chars` per stage | | |
| `stage_persona_turns` | `persona_turns` | | |
| `stage_persona_ctx_chars` | cumulative `persona_ctx_chars` | | |
| `stage_sp_loading_overhead` | shared_chars × turns (CF) or per-agent SP × turns (RF) | | |

### Per-run metrics
| Metric | RF actual | CF actual | Δ |
|--------|----------|----------|---|
| Total turns | | | |
| Total input tokens | | | |
| Total cached tokens | | | |
| Overall savings % | | | |
| Handoff cold-start penalty (uncached tokens at first turns) | | | |
| Total SP loading overhead (chars) | | | |
| Handoff count | | | |
| Hours elapsed | | | |
| Feature completed? (PASS/FAIL) | | | |
| Number of correction loops | | | |
| Review gate passes | | | |

### Quality metrics
| Metric | RF | CF |
|--------|----|----|
| Review verdict (PASS/PASS-WITH-NITS/FAIL) | | |
| Test gate failures | | |
| Acceptance criteria met (count/total) | | |
| Spec conformance | | |
| Detectable cross-agent context reuse (qualitative) | | |

### Cross-agent knowledge detection (stretch)
- Did the typescript agent re-read files that architect already opened? (re-read ratio)
- Did review cite findings from product's acceptance criteria vs re-discovering them?
- Did the agent reference "the spec" or "the architect's design" in conversation?
- Count of tool calls that reference prior agent's output files

---

## Results Template

```markdown
## Run v0.0.1 — [date]

### Configuration
- **Feature:** [FEAT-xxx]
- **Worktree RF:** `~/dev/.sdlc-experiments/arm-rf/<id>/`
- **Worktree CF:** `~/dev/.sdlc-experiments/arm-cf/<id>/`
- **Proxy commit:** `<hash>`
- **Model:** `deepseek-v4-flash` via `proxy/rf` / `proxy/cf`

### RF Run

| Metric | Product | Architect | Typescript | Review | (Correction?) |
|--------|---------|-----------|------------|--------|---------------|
| Turns | | | | | |
| Tokens | | | | | |
| Cached | | | | | |
| Savings % | | | | | |
| First-turn cached | — | | | | |
| First-turn savings | — | | | | |
| Shared chars | | | | | |
| Persona chars | | | | | |
| Context chars | | | | | |
| SP loading overhead | | | | | |
| Persona turns | | | | | |
| Persona ctx chars | | | | | |

**Handoff cold-start penalty (RF):** [sum of first-turn uncached]
**Total SP loading overhead (RF):** [sum stage_sp_loading_overhead]
**Total tokens:** [sum stage_tokens]
**Review verdict:** [PASS/FAIL]
**Correction loops:** [count]
**Deliverable:** `<worktree>/docs/` + implementation

### CF Run

| Metric | Product | Architect | Typescript | Review | (Correction?) |
|--------|---------|-----------|------------|--------|---------------|
| Turns | | | | | |
| Tokens | | | | | |
| Cached | | | | | |
| Savings % | | | | | |
| First-turn cached | — | | | | |
| First-turn savings | — | | | | |
| Shared chars | | | | | |
| Persona chars | | | | | |
| Context chars | | | | | |
| SP loading overhead | | | | | |
| Persona turns | | | | | |
| Persona ctx chars | | | | | |

**Handoff cold-start penalty (CF):** [sum of first-turn uncached — expected much lower than RF]
**Total SP loading overhead (CF):** [sum stage_sp_loading_overhead]
**Total tokens:** [sum stage_tokens]
**Review verdict:** [PASS/FAIL]
**Correction loops:** [count]
**Cross-agent cache reuse confirmed:** [yes/no — evidence from first-turn savings]
**Cross-agent context utilization (qualitative):**
- [observations]

### Comparison

| Metric | RF | CF | Δ | CF advantage? |
|--------|----|----|---|---------------|
| Total turns | | | | |
| Total tokens | | | | |
| Total cached | | | | |
| Handoff penalty | | | | |
| SP loading overhead | | | | |
| First-turn cache (avg) | | | | |
| Review verdict | | | | |

### Hypothesis assessment

- [ ] CF shows superior cross-agent first-turn cache reuse (80%+ vs <20%)
- [ ] CF has lower per-run SP loading overhead
- [ ] CF handoff cold-start penalty is 90%+ smaller than RF
- [ ] Both produce equivalent-quality deliverables
- [ ] Any additional observations

### Notes for v0.0.2

- What worked, what didn't
- Agent behaviors to adjust
- Metrics to add
- Isolation improvements needed
```

---

## Iteration Process

1. **Run v0.0.1** — execute both arms, fill in results template
2. **Analyze** — does the data support the hypothesis? what broke?
3. **Fix** — update proxy, experiment design, or agent prompts
4. **Increment** — create `SDLC-v0.0.2.md` with changes from v0.0.1 notes
5. **Repeat** — each version tightens the experiment and the proxy

Each version documents its own results. `RESUME.md` points to the latest version and
summarizes cumulative findings.

---

## Notes on Cross-Agent Knowledge Detection

Detecting whether an agent actually *uses* knowledge from a prior agent's context
is inherently qualitative. Possible automated signals:

1. **Re-read ratio**: typescript opens a file that architect already read. High re-read
   ratio = agent NOT using cached context (bad). Low = agent used conversation context.

2. **Reference pattern**: agent says "per the spec..." or "as the architect noted..."
   vs re-discovering facts independently.

3. **File access count**: fewer unique file reads by typescript = context from architect
   was sufficient. More reads = context not sufficient.

4. **First-turn tool calls**: if the new agent starts with a read of the prior agent's
   output (acceptance.md, spec.md), that's expected. If it starts by re-reading source
   files the prior agent already explored, that's inefficiency.

These cannot be automated from proxy logs alone — they require parsing the model's
tool calls and textual output. For v0.0.1, capture qualitative observations;
automation is a v0.0.2+ concern.

---

## RESULTS — v0.0.1 (2026-08-04) — THREE RUNS COMPLETED

> **Feature:** BUG-WORKSPACE-GEN-006 (workspace-codegen-nx plugin generator emits stale configs)
> **Model:** deepseek-v4-flash via `proxy/rf` / `proxy/cf`
> **Session IDs:** RF `035dd677…` (+5 subs) · CF-pre `035ef41f5…` · CF-fresh `031bd2a82…`
> **Full transcripts:** `proxy/transcripts/` · **Final file states:** `proxy/transcripts/file-writes/`
> **Re-aggregate:** `node aggregate-session.mjs --rf 035dd677effeBusfTjza6XePMw` / `--cf <id>`

### The three arms

| Arm | Proxy state | What ran | Delivered |
|---|---|---|---|
| **RF** | passthrough, dispatcher | 6 sessions (dispatcher + 5 stage subs) | `docs/{acceptance,spec,review,final-review}.md` + generator fix (committed `fa470a4f`) |
| **CF-pre** | Option C rewrite (pre-v4) | 1 session, 5 handoffs | `ACCEPTANCE.md` + `SPEC.md` + generator fix (in-tree) |
| **CF-fresh** | v4 rewrite (always-tail fix) | 1 session, 5 handoffs | `ACCEPTANCE.md` + `SPEC.md` + `VERIFICATION.md` + `FOLLOWUPS.md` + **canonical-template fix** (uncommitted) |

### Actual metrics (dead-time excluded)

| Metric | RF | CF-pre | CF-fresh |
|---|---|---|---|
| Turns | 212 | **101** | 113 |
| Total input tokens | 21,823,752 | **14,636,519** | 20,931,896 |
| Total cached | 21,186,176 | 13,589,888 | 20,015,104 |
| Total cache writes (miss) | 637,576 | 1,046,631 | 916,792 |
| Cached-read % | 97.1% | 92.8% | 95.6% |
| Output tokens | 194,462 | 107,898 | 182,112 |
| Output per 1M input | 8,911 | 7,372 | 8,700 |
| Handoff cold-start penalty (swap-seq, excl. first turn) | 166,395 | 248,151 (389,267 raw) | **42,311** |
| Handoff penalty — prior metric (per-stage first-turn, incl. cold start) | 152,201 | 217,643 | 37,771 |
| Cache wipes | 0 | **10 (643,712 re-charged)** | 0 |
| First-turn cache reuse | 6.8–9.1% | 26–86% | **92–98%** |
| Wall time (dead-excluded) | 38m 21s | **19m 10s** | 33m 50s |
| Real cost (hit $0.07 / miss $0.27 / out $1.10) | **$1.869** | **$1.353** | $1.849 |

> **Metric correction (2026-08-04):** the handoff cold-start penalty was recomputed
> after review findings M1/M2 — it now excludes the session's first turn (initial cold
> start, not a handoff) and counts every agent change in the chronological swap
> sequence (correction loops + orchestrator wake-ups). CF-PRE's value is
> data-source-dependent: the attribution-fixed live log reports 248,151 (the
> corruption turn is relabeled 'typescript', hiding the real persona swap), while
> the raw backup log reports the mechanically-correct 389,267 (corruption blow =
> 142,140 counted as the handoff it was). Raw backup: `/tmp/cf-session-backup.jsonl`.
> All other metrics (totals, cost, cached-read %, output) are unaffected.

> **Verified additions (2026-08-04, from raw-capture replay + transcript forensics):**
>
> **Wipe-tax counterfactual (CF-pre):** the 10 floor wipes reproduce exactly from the
> raw log — the 10 turns where provider cached-token count dropped, ΣΔcached =
> **643,712** (61.5% of all 1,046,631 uncached; 4.4% of 14.6M total). All 10 are
> handoff-adjacent (5 boundaries × 2 turns + 1 mid-stage corruption at g67) — zero
> scattered. Wipe tax at $0.07/$0.27/$1.10 = **$128.74 = 9.5%** of CF-pre's cost.
> No-wipe counterfactual: CachRd 97.25%, cost **$1,223.83** — would beat RF by 34.5%.
> Even with the bug, CF-pre beats RF by 27.6%. The wipe-tax explains only ~25% of the
> $0.516 cost gap; ~$0.39 of the saving is structural (turn count 101 vs 212).
>
> **Tool-call census (RF vs CF-pre, from transcripts):** RF made **306** tool calls vs
> CF-pre's **127** (2.4×). The gap is reading, not writing: `read` 81 vs 14 (**5.8×**),
> `bash` 149 vs 74 (2×), `grep` 15 vs 3 (5×), gitnexus 10 vs 0. edit+write nearly equal
> (RF 18, CF-pre 27) — both arms did comparable authoring. Per-stage cold starts are
> the read-tax: every RF stage re-uploaded its full SP and re-derived repo state.
>
> **Per-stage accounting (dead-time excluded, aggregator `--json`):** full stage tables
> (turns/tokens/cached/uncached/CachRd/out/cost per stage) are recorded in the
> forensics report; headline deltas: CF-pre typescript 54 turns/9.0M vs RF 80/10.7M;
> CF-pre review 10 turns/2.1M vs RF 50/4.7M; CF-pre orchestrator 5 turns/277K/$30 vs
> RF dispatcher 18 turns/1.03M/$100 (3.7× cheaper). CF-pre sends 41% more tokens/turn
> (144,916 vs 102,942) but has 52% fewer turns — turn count dominates the volume gap.
>
> **CF-fixed vs CF-pre cost inversion — the always-tail narration tax (verified):**
> v4's always-tail persona re-injection (cf-rewrite.mjs:176-183) makes the model
> re-narrate identity/protocol every turn: 71 identity-pattern lines + 23 tooling-
> disclosure blocks in CF-fixed vs 31 and 0 in CF-pre (persona sat at index 1, not
> re-salient). Output tokens: CF-fixed 182,112 vs CF-pre 107,898 (1.7×). This is a
> v4 design trade-off (documented v2 cost, RESUME.md:36) — the *better-cached* run is
> the more expensive one partly because its cache correctness re-triggers narration.
>
> **"RF brief mandated more work" claim — SUBSTANTIATED (2026-08-04):** RF's
> dispatcher briefs explicitly demanded independent gate re-runs ("Run the gates
> YOURSELF and record real exit codes" — rf-035dd677.md:8180; "Gates — all must exit
> 0... prove the templates end-to-end... `npx nx run <probe>:verify-dist-load` and
> report the exit codes" — rf-035dd677.md:4638-4643) and RF executed them: 77 nx
> test/build/lint runs, 14 gitnexus calls, gates table with real exit codes
> (rf-035dd677.md:677-692), "13/13 PASS — every criterion verified with file reads at
> exact paths and real exit codes" (:692). CF-pre's toolset lacked gitnexus/memory/
> task entirely (cf-prefix-035ef41f5.md msg 222). Part of the 212-vs-101 turn gap is
> mandated rigor, not pure session structure — v0.0.2 must control prompt/toolset
> equality before attributing the full gap to architecture.

### The three headline results

**1. CF-pre beat RF dramatically — implementing fundamentally the same solution.**
CF-pre delivered the same fix (regex-patch generator output, same `generator.ts` target,
committed-equivalent worktree state) at:
- **~72% of the dollar cost** ($1.353 vs $1.869)
- **half the wall time** (19m vs 38m)
- **half the turns** (101 vs 212)
- **67% of the total tokens** (14.6M vs 21.8M)
- similar output-per-million-tokens (7,372 vs 8,911 — within 17%)
- **despite dramatically lower cache reuse** (first-turn 26–86% vs RF's 6.8–9.1% is actually *higher*, but overall cached-read 92.8% vs 97.1% is lower, AND it paid 10 wipes = 643K re-charged tokens)

CF-pre won because the single shared session eliminated RF's per-stage cold starts:
RF re-computes its full context at every stage boundary (166K swap-sequence cold-start
penalty across 6 sessions); CF-pre carried the context forward but paid the wipe-tax at
handoffs (248K from the fixed log; 389K mechanically, incl. the 142K corruption blow —
worse than RF's 166K — the wipe bug made handoffs *more* expensive than RF's cold
starts) — yet the shared-context benefit on the *within-stage* turns still swamped it.

**2. CF-fresh implemented a dramatically better solution than either arm — but spent ~99% of RF's real cost.**
CF-fresh is the only arm that fixed the *root cause*: it replaced the regex-patching
approach with **canonical-template replacement** (`shared/templates.ts`), eliminating the
whole class of "regex silently misses after a migration" bugs (documented in
`templates.ts`'s own header). It also fixed the entrypoint `tsconfig` outDir that
RF and CF-pre both left stale (`../../dist/entrypoint`), added `ensurePlaceholderSpec`
(test-target guarantee), and produced deeper spec coverage (plugin + entrypoint + base
specs). But that superior solution cost **$1.849 = 98.9% ≈ 99% of RF's $1.869 real cost** (20.9M tokens = 96% of RF's 21.8M by volume) — the
shared-session design made every later-stage turn re-send the full accumulated context
(~266–282K/turn in review vs RF's ~125K), so the "better fix" burned nearly RF's entire
token budget.

**3. The token-efficiency ordering is INVERTED from the cache-efficiency ordering.**
- Cache efficiency: RF (97.1%) > CF-fresh (95.6%) > CF-pre (92.8%)
- Dollar cost: CF-pre ($1.35) < CF-fresh ($1.85) < RF ($1.87)
- Tokens to ship: CF-pre (14.6M) < CF-fresh (20.9M) < RF (21.8M)

The run that *shipped the solution cheapest* (CF-pre) had the *worst* cache efficiency.
The run with the *best solution* (CF-fresh) cost nearly as much as RF. Cache-read %
does not predict cost — total turn count and per-turn context size dominate.

### Quality comparison (from the delivered files)

| | RF | CF-pre | CF-fresh |
|---|---|---|---|
| Fix approach | regex-patch | regex-patch | **canonical template** |
| New template file | — | — | `shared/templates.ts` |
| Entrypoint tsconfig outDir | `../../dist/entrypoint` (stale) | `../../dist/entrypoint` (stale) | `dist` (fixed) |
| test target | patched | patched | `ensurePlaceholderSpec` |
| Spec files | plugin spec | plugin + dbg (tmp) | plugin + entrypoint + base |
| Git commit | `fa470a4f` | (uncommitted) | (uncommitted) |
| Correction loop (product#2) | 12 turns | 4 turns | 11 turns |

**User's quick assessment (2026-08-04):** CF-fresh implemented a dramatically better
solution than either of the other two — the only arm that fixed the root cause
(regex-patching was the bug) rather than patching symptoms. RF and CF-pre both
regex-patched; only CF-fresh replaced the contract.

**Verified three-arm code scores (2026-08-04, reviewer on verified ground truth — all 12
code files esbuild-parse-clean):**

| Criterion (weight) | RF | CF-pre | CF-fresh |
|---|---|---|---|
| Correctness/functionality (0.25) | 6.0 | 6.5 | 9.0 |
| Architecture/design (0.20) | 4.0 | 4.5 | 9.0 |
| Code quality/maintainability (0.15) | 6.0 | 6.5 | 8.5 |
| Edge-case robustness (0.15) | 6.0 | 6.5 | 8.5 |
| Completeness vs spec (0.15) | 5.0 | 5.5 | 9.0 |
| Tests (0.10) | 7.0 | 7.5 | 8.0 |
| **Weighted total** | **5.55** | **6.05** | **8.75** |

Scoring basis (byte-verified): RF = commit `fa470a4f` (transcript-confirmed);
CF-pre = raw-capture reconstruction in `file-writes/cf_pre_true/` (baseline 6f4d2c38 + 11
unique edits replayed, 0 failures); CF-fresh = byte-identical to cf-run worktree.

Notable verified findings: **CF-pre ships a real defect** — `release.version.
generatorOptions.packageRoot = '{projectRoot}/dist'` (generator.ts:179-181) contradicts
the reference's source-root convention (`apigen-plugin-batch/project.json:9`) and is
test-locked as ground truth (plugin/generator.spec.ts:108). **RF's `nx-release-publish`
dependsOn is truncated to `['build','test']` and gated on `!pub.dependsOn`** (committed
generator.ts:239-240) — silently drops verify-dist-load/dist-manifest/publish-hygiene in
the common case. **RF has the best test-teeth idea** — `@nx/vite/plugin` registration in
the spec's `beforeEach` (the only suite that catches the pre-fix state) — worth porting.
AC-8 gate-count note: the ground-truth reference lists FIVE gates (no `assets`);
CF-fresh matches it exactly, CF-pre's six-gate list is a superset.

**Attribution verdict (2026-08-04, decision-attribution forensics):** the persona system
explains **reliability** (0 wipes, 92-98% handoff reuse) and a per-turn narration tax
(CF-fixed 71 identity lines / 23 disclosure blocks vs CF-pre 31 / 0 → 1.7× output tokens).
It does NOT explain cost or quality. CF-pre's cost win = single-session structure +
replicable discipline (no re-reads, feasibility checks, one e2e) + two run-specific
factors (a skipped red→green gate, broken-cache narration suppression). CF-fixed's
quality win = replicable engineering (stage-0 full-file read, real-scaffold probing,
empirical teeth) by byte-identical personas. Session structure → the RF-beating cost win;
agent decisions + sampling variance → the quality gap. Full decision evidence: Q7 below.

---

## Open Questions — v0.0.1 (for v0.0.2 design)

**Q1 — How did CF-pre beat RF with almost identical behavior?** → **ANSWERED (2026-08-04, raw-capture replay).**
CF-pre's persona was placed at message-array index 1 ("Go") on **67 of 71 turns** (verified
by replaying the pre-fix rewrite against the exact captured message arrays — only the 4
handoff turns put it on the tail). That means CF-pre's forwarded requests had the persona
in nearly the same position as... what RF does with a full SP at position 0? The
*behavioral* difference between the arms is tiny (persona placement), yet the *cost*
difference is 33%. **Verdict: CF-pre's win is the single-session vs multi-session structure
(no per-stage cold start), independent of persona placement.** Evidence: the persona at
index 1 was byte-identical within each stage → provider prefix stayed valid → 99.5-100%
savings on ~90 of 101 turns; the 10 wipes all correlate exactly with handoffs (5
boundaries × 2 turns + 1 mid-stage corruption g67), zero scattered. The placement bug
concentrated its damage at stage boundaries and was inert elsewhere. The v4 fix's value is
reliability (0 wipes, 92-98% handoff reuse), not cost — the wipe-tax counterfactual
($1,223.83, 97.25% CachRd) matches the v4 run's behavior, but CF-fresh still spent more
because it did more work.

**Q2 — Is "cached read %" the right metric?** → **ANSWERED: no, it's a ratio that rewards
small contexts.** CF-pre had the *worst* cached-read % (92.8%) but the *lowest* cost.
Cached-read % doesn't capture total work. Total input tokens, total turns, and dollar cost
are the economically meaningful numbers — CF-pre wins all three. Cache ordering (RF 97.1 >
CF-fresh 95.6 > CF-pre 92.8) is fully INVERTED from cost ordering (CF-pre $1.35 < CF-fresh
$1.85 < RF $1.87). Cache-read % does not predict cost; turn count × per-turn context size
dominates.

**Q3 — Output tokens ≠ value.** (unchanged — open)

**Q4 — What does "more efficiently" mean when the best solution costs the most?** → sharpened
(2026-08-04): the cost/quality inversion is NOT caused by the persona system. CF-fixed's
superior solution was produced by replicable engineering decisions (full-file read at
stage 0, real-scaffold probing, empirical red→green teeth) made by agents whose personas
and tools were byte-identical to CF-pre's (registry `~/.config/opencode/agents/*.md`,
cf-proxy.mjs:66-100). CF-fixed's extra cost = more scope of work (entrypoint fix, nx.json
AC-7, placeholder spec, teeth experiment, pnpm install) + the always-tail narration tax.
The experiment design still does not define the value trade-off — v0.0.2 must.

**Q5 — The wipe-tax paradox.** → **ANSWERED: the fix's value is reliability, not raw cost.**
CF-pre paid 10 wipes / 643,712 re-charged tokens (a pure bug cost, $128.74 = 9.5% of its
cost) and STILL won at $1.353. The no-wipe counterfactual is $1,223.83 (97.25% CachRd).
The v4 fix eliminated the wipes but the fresh run cost more (20.9M) because it did more
work — and the always-tail re-injection adds a per-turn narration tax (~1.7× output tokens:
182K vs 108K). Reliability (0 wipes, 92-98% handoff reuse) is the fix's measurable value.

**Q6 — Tool behavior is orthogonal to cache efficiency.** → sharpened (2026-08-04): the
tool-call census shows CF-pre made 127 calls vs RF's 306 — so the CF-vs-RF delta IS
largely tool-call driven (RF's per-stage cold starts + mandated independent re-verification
produced 5.8× the reads). But WITHIN the two CF arms, cache efficiency does not drive tool
calls: CF-fixed made more calls/turn than CF-pre despite better caching. Cache saves
re-send tokens, not tool calls.

**Q7 — What decisions made CF-pre cheaper, and are they attributable to the persona system?**
→ **ANSWERED (2026-08-04, decision-attribution forensics): NO — the persona system explains
reliability only, not cost or quality.**
- CF-pre's cost decisions (each verified in-transcript): (D1) feasibility check
  (`node_modules: PRESENT` before planning, cf-prefix:1564 — CF-fixed's worktree lacked
  node_modules and the typescript stage had to pnpm install, cf-fresh:2904/2934);
  (D2) explicit cross-stage reuse of in-session reads ("already read" — cf-prefix:1712,
  2285, git diff instead of re-reads :4050); (D3) read @nx source to pin patch points
  (:1998) — quality-neutral; (D4) one exit-code-gated e2e + reference-package comparison
  that found the 4th stale artifact (:3432, :3567-3634); (D5) review accepted
  "structurally guaranteed" teeth without the empirical revert (:4506) — a verification
  skip, the repo's own BL-225 anti-pattern; (D6) broken-cache luck: persona at index 1
  suppressed per-turn identity narration (67/71 turns).
- D1/D2/D4 are REPLICABLE good engineering; D5/D6 are RUN-SPECIFIC (D5 is a skipped gate,
  D6 is the corruption bug itself).
- CF-fixed's quality decisions (Q2 chain): stage-0 full-file read found entrypoint outDir
  (cf-fresh:1103); product encoded it as AC-6 (:1613-1620); architect chose "own the
  emitted template" over "patch-and-drift" (cf-fresh:2015, SPEC.md:9) triggered by the
  FEATURE's "update the templates" direction (:337) + the drifted spec assertion (:1390);
  typescript's real-scaffold probes found the 4th artifact (:3719) and the `},,` bug
  (:3263); review ran the empirical red→green CF-pre declined (:4802/4840 vs :4506).
- **Attribution verdict:** personas are byte-identical between arms; the rewrite's only
  mechanism is cache placement; every quality decision's trigger is a code read, not
  persona text. Persona system → reliability (0 wipes, 92-98% reuse) and a per-turn
  narration tax. Session structure → the RF-beating cost win (shared by both CF arms).
  Agent decisions + sampling variance → the quality gap.
- Unverifiable confounds: per-run registry staleness (RESUME.md:120-121), LLM sampling
  variance.

**Q8 — How do we know the transcripts reflect what the arms actually executed?**
→ **ANSWERED: the cf_pre code snapshot is now reconstructed from the raw capture, not the
transcript.** The original `file-writes/cf_pre/` snapshot was corrupted (306/307 lines
line-number-prefixed, truncated .mjs, fabricated `ln:` regex at line 181 that exists in no
real tree). The verified reconstruction lives in `file-writes/cf_pre_true/`: baseline
6f4d2c38 + the session's 11 unique edit calls replayed in order (0 failures, esbuild-parse
clean). It contains the correct outDir regex (:195) and the full six-gate dependsOn
(:258-265) — NOT the fabricated `ln:` regex. The `~/dev/.sdlc-experiments/arm-{rf,cf}/
BUG-WORKSPACE-GEN-006` worktrees are from an EARLIER run (branched 15:16 vs session 23:58)
and must not be used as cf_pre/cf_fresh ground truth. rf/ snapshot = byte-identical to
commit fa470a4f (verified); cf_fresh/ = byte-identical to cf-run worktree (verified).
