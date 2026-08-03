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
