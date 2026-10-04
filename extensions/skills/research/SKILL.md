# Skill: research — multi-domain research with memory-first resolution and hardened verification

**Version:** 5 (draft)

## What this is

A research process that carries the core of the `researcher` agent — generalize → memory-first
resolution → graded external search → per-finding memory writes — with **no tool-adoption goal in
the core**: evaluating and cataloguing tools is a domain concern (playbook P1) and, in time, a
separate tool-manager subroutine. The core adds:

1. a **playbook router** that segments work across every research domain (Phase 3);
2. a **structured sub-researcher prompt** the parent fills per playbook, so many domains are
   covered in parallel by the *minimum* number of dispatched researchers (Phase 4);
3. a **memory resolution loop** (≤2 regenerations per question) that deepens already-answered
   questions instead of re-researching them (Phase 2);
4. **hardened verification** that proves the process ran — on disk, in the memory store, and by
   recorded tool use — never by self-report (Phase 6).

The run directory is an **execution-provenance record** (evidence tracing: a typed graph
questions → routing → findings → memory writes → read-back), not a prose report: final-answer
quality alone cannot show how an answer was produced, which evidence supported each claim, or where
a failure originated. Phase 6 audits that graph.

Nothing here writes application code or edits project source.

## Domain-neutral core, pluggable domains

The **process is domain-neutral; domains are a separate layer.** The core — pre-commitment,
generalization, memory-first resolution, graded gathering, per-finding memory writes, verification,
audit — names no domain, no answer shape, and no verdict. The domain layer is the
`references/routing-table.md` + `references/playbooks/P*.md` pair: adding, changing, or splitting a
domain edits only that layer, never the core.

The process is **expansion-first, not convergent.** It broadens before it narrows: generate a spread
of questions, fan each out across every domain it touches, and gather broadly. It must never
collapse a question onto a single preferred framing, answer shape, or verdict. A multi-domain
question is the product, not noise to be smoothed away.

## Inputs

- **question** (required) — the research need.
- **domain_narrowing** (optional) — a domain or subset of domains the caller restricts the run to.
  When present, Phase 1 tags only within the allowed set and Phase 3 routes only to those domains'
  playbooks; the process still fans out across **every allowed** domain. When absent, all 16 domains
  are in play. Narrowing is an input, never a default.
- **mode** (optional) — set to `root-distillation` to shape the run as an open-problem
  landscape distillation (P8). Absent, the run routes P1–P7 by domain/answer-category as before.
  This mode is for "what is still unsolved in X and why", not for decision or eval questions.
- **run_id**, **max_sub_researchers** (optional) — as recorded in the manifest.

## Memory-first, and learned techniques

The first move is always memory. If memory **fully knows the answer as a fact**, the run is
terminal: return the memory answer with its episode uids, route nothing, dispatch nothing. Otherwise
the question is routed and formulated using the **generalization and blinding techniques the run has
learned and written to memory** — applied aggressively, as learned heuristics, never a fixed
template. Every run writes its learnings back, so later runs formulate better questions. This is how
the process broadens its domains instead of hard-coding one convergent framing.

## When to use — and when not to

Use when a question needs **external discovery** across one or more domains and the answer must be
**graded, cited, and persisted**.

Do **not** use for:

| If the question is… | Use instead |
|---|---|
| a local lookup / evidence gather / backlog revalidation | the **code-intel** or **backlog** capability directly, with a red→green evidence gate |
| a plumbing check of a tool or provider ("is X up?") | the ops routine for that capability, not research |
| a single-repo navigation ("where is symbol X?") | the **code-intel** capability |

A mixed batch is fine: route each question independently (Phase 3); non-research questions leave
the skill with a one-line reason recorded in `routing.json`.

## Capabilities (by need — ADR-0026)

State the **need**; the project's `## Capabilities` section binds it to the tool that serves it.
Never name a tool or host-qualified symbol here.

| need | used for | if absent |
|---|---|---|
| `memory` | prior knowledge; per-finding writes; read-back | **BLOCKED** — stop; never substitute a file or a direct store |
| `memory` (degraded) | a recall that fell back to a non-semantic channel | **retry once** (narrow/relax); if still degraded, record the degradation in the manifest + trace and continue — a degraded recall is **not** "nothing known" |
| `search` | external discovery, registries, scholarly | playbook may still run via deep-fetch; record the gap |
| `code-intel` | codebase-evidence playbook (P3) | questions needing it leave the skill as `not-research (capability code-intel absent)` |
| `backlog` | filing a confirmed defect or deferral | report it in the answer; do not block |
| `dispatch` | running playbooks in parallel sub-researchers | run the playbooks inline, sequentially; record the gap |

Phase 0 records which capabilities are **available** and which are **absent**; a question that
needs an absent capability is not dispatched — it routes out with that reason (ADR-0026 D6).

## Run directory — the evidence contract

Every run writes to `.research/runs/<run_id>/` and nothing here is optional; Phase 6 verifies it.

```
.research/runs/<run_id>/
  manifest.json          # top-level OBJECT: run_id, cwd, capabilities{available,absent}, min_*, phases, tool_use
  questions.json         # top-level ARRAY (each item: id, question, domain, resolution, regen_history, memory_uids)
  routing.json           # top-level OBJECT keyed by question id -> playbook list | "not-research (<reason>)" | "memory (resolved in Phase 2)"
  findings/<qid>.md      # answer, citations, confidence, memory_uid (one per research-resolved q)
  memory-readback.json   # top-level OBJECT { run_id, uids: { <uid>: { status } } }
  trace.md               # Position Declaration line per phase
```

**Shapes are part of the contract** — `manifest.json` and `routing.json` are objects; `questions.json`
is an array. The verifier fails on the wrong top-level shape.

`manifest.tool_use` records **real provenance, not a self-assessment**:

```json
{ "search_terms": 9, "sources_verified": 4, "rate_limit_events": 0,
  "calls": [ { "capability": "search", "tool": "<name>", "query": "<query or URL>", "outcome": "success" } ] }
```

`sources_verified` is a **global** distinct-source count for the whole run (never per-finding).
`calls` records every external call the run made. Every citation URL must match a successful entry
in `calls` — the verifier cross-checks it, so a fabricated citation cannot pass.

## Position Declaration (before **every** phase)

```
Current Phase: 0..7
Previous Phase completed: N/A | Yes | No — evidence: <one line>
Run: <run_id>
```

Phase 0 is the first phase: record `Previous Phase completed: N/A — first phase`. Every later
phase records `Yes`, or `No` and STOP. Append the line to `trace.md`; the verifier requires all
eight phases present.

---

## Phase 0 — Pre-Commitment

Before any search, declare and record in `manifest.json`:

- **Priors** — what you already believe about this topic (specific).
- **Bias surface** — what might make you favour a conclusion.
- **Known ground truth** — facts to calibrate against; if research contradicts them, trust is LOW.
- **Capabilities** — `{available: [...], absent: [{name, why}]}`, probed now, plus per-capability
  health. A capability is absent if the project has no binding for it or its health probe fails.
  Record this as the **top-level** `capabilities` key of `manifest.json` (nesting it under a phase
  object fails the verifier).

Then record the **run baselines** you will re-measure in Phase 7:

| metric | target |
|---|---|
| search terms used | ≥ 3 per research question (floor 3) |
| phases completed | 8 |
| capabilities available | ≥ 1 |
| confidence-labeled findings | ≥ 1 |
| sources verified / approved | ≥ 2 |
| rate-limit events | ≤ 2 |

## Phase 1 — Question generation + generalization

Turn the input into one or more atomic research questions, then generalize each so it is externally
researchable and not tied to this repo's specifics:

- **A — Collect observations:** `<thing>` does `<action>` which causes `<consequence>`.
- **B — Strip specifics:** remove project names, paths, versions → a statement true of any project.
- **C — Identify the tension:** what design decision does the generalized statement force?
- **D — Frame the question:** "What is the convention for…", "Should X or is it acceptable to…",
  "Under what conditions…", "How do established projects handle…".
- **E — Coverage check:** does it apply beyond this codebase? what are the boundary conditions?
  can it be answered from external sources? If not, it is not a research question — route it out.
- **F — Tag the domain:** one of `agent-orchestration, db-storage, verification, data-analysis,
  library-selection, api-usage, codebase-navigation, market-trend, security, testing,
  tooling-process, finance-accounting, architecture-pattern, career-content, docs-writing, other`
  (16; apply `domain_narrowing` here when the caller supplied it).

- **Fan-out (expansion):** for each question, name **every** domain it touches — not one. A question
  may be genuinely multi-domain (`db-storage` + `security` + `verification`). Listing one domain and
  discarding the rest is convergent drift; record all of them.

Write the questions to `questions.json`. Each question's `resolution` starts unset.

## Phase 2 — Memory resolution loop (≤2 regenerations per question)

**Memory first, always.** For each question `Q`:

```
for regen in 0..2:
    hits = <memory recall>(Q)                      # generous budget; topic/tags if known
    if hits fully resolve Q:
        record resolution "memory" + the episode uids
        if regen == 2: break                       # bounded — stop, do not search
        Q = revise(Q, deeper = the part hits did NOT resolve,
                      or one level more specific if hits resolved all of it)
        record the regeneration in Q.regen_history
        continue                                    # re-check memory with the revised Q
    else:
        record resolution "research"
        break                                       # externally researchable — go to Phase 3
```

Rules:

- **Resolution values are exactly** `memory`, `research`, `not-research`. `research` means
  "answers must be found externally"; it does **not** mean "was dispatched" — a `research` question
  may run inline (Phase 4). Findings exist for every `research` question.
- **A `memory` resolution cites the episode uid(s) it resolved from** (≥1). A question you merely
  believe you know, with no memory episode behind it, is **not** memory-resolved — record it as
  `research`.
- **Apply learned techniques.** Before revising `Q`, recall the run's own learned
  generalization/blinding heuristics from memory and apply them: **generalize** (strip repo
  specifics) and **blind** (strip anchoring identifiers) so the question is researched without
  convergent bias. These are learned, not a fixed template.
- **Loop bound:** the loop performs at most **3 memory checks** (the initial pass + 2
  regenerations); `regen_history` holds at most **2** entries, one per revision.
- **If the final `Q` is still fully resolved by memory**, do not dispatch: return the memory answer
  with episode uids — this is the whole point (keep the researcher count at the minimum).
- Record every regeneration (old question, reason, new question) in `Q.regen_history`.
- Never write a generated question to memory as a finding — only Phase 5 writes findings.

## Phase 3 — Route to playbooks

Write a `routing.json` entry for **every** question id. Match each retained question
(`resolution == "research"`) to **one or more** playbooks using `references/routing-table.md` —
every domain the question touches from Phase 1, not a single forced winner. A multi-playbook
question is researched across those domains in parallel (Phase 4); the answer carries all of them.
Set a question needing an absent capability to `"not-research (capability <name> absent)"`; any
other non-research question gets `"not-research (<reason>)"`. A question already resolved by memory
in Phase 2 gets `"memory (resolved in Phase 2)"` — do not relabel it `not-research`. Store the value
as a **list** when more than one playbook applies. Set a question's `resolution` to `not-research`
only when it actually leaves the skill.

The eight playbooks — together they cover all 16 domains:

| id | playbook | covers |
|---|---|---|
| P1 | `dependency-adopt` | library-selection, tooling-process, api-usage |
| P2 | `technical-forensics` | db-storage, architecture-pattern, verification |
| P3 | `codebase-evidence` | codebase-navigation, testing |
| P4 | `market-intelligence` | market-trend, finance-accounting, career-content |
| P5 | `threat-security` | security |
| P6 | `user-voice` | user/product/design feedback |
| P7 | `general-synthesis` | agent-orchestration, data-analysis, docs-writing, other (default) |
| P8 | `root-distillation` | any domain, via `mode: root-distillation` (open-problem / landscape) |

## Phase 4 — Dispatch sub-researchers (parallel, minimum count)

Group `research` questions **by playbook**. Scale effort to the work, never to the question count:

- **One playbook, few questions → run it inline.** No dispatch, no sub-researcher prompt; write the
  finding directly in Phase 5.
- **One playbook, many questions → one sub-researcher** for that playbook (all its questions).
- **N playbooks → N sub-researchers**, dispatched in parallel, capped at `max_sub_researchers`
  (default 4); overflow playbooks wait for a slot. A multi-domain question appears in each of its
  playbooks' prompts — breadth comes from the domain fan-out, not from more agents.

The dispatch count is the number of playbooks that actually have work — **never** the number of
questions, and never fewer than 1 when any question is `research`. There is no per-question agent.

For each dispatched playbook, fill `references/sub-researcher-prompt.md` once with:

`{PLAYBOOK, SCOPE_DOMAINS, ANSWER_CATEGORY, OUTPUT_CONTRACT, VERIFICATION_RULES, CAPABILITIES,
QUESTIONS[], MEMORY_CONTEXT}`

The prompt gives each sub-researcher **objective · output format · source guidance · task
boundaries** — a vague brief causes duplicated work and gaps. Each sub-researcher **writes its own
`findings/<qid>.md`** (answer · citations · confidence) and returns only a lightweight reference
(qid, confidence, sources_verified, file path). It never writes to memory (only the parent does,
Phase 5) and never invents a `memory_uid`. `MEMORY_CONTEXT` carries only the parent's Phase-2 recall;
an empty context is valid.

## Phase 5 — Aggregate + write findings to memory

1. Merge sub-researcher returns with inline results. When two domains answer differently, that
   disagreement is **signal** — keep both, name the domains, and record the conflict; never collapse
   it to one preferred verdict to look consistent.
2. Ensure every `research` question has `findings/<qid>.md`: **answer · citations (file:line or URL)
   · confidence (HIGH/MEDIUM/LOW) · `memory_uid`**.
   - HIGH = ≥2 independent verifiable sources, or 1 verified source with independently confirmed
     claims. MEDIUM = 1 verifiable source, or ≥2 supporting with verified claims. LOW = inferred,
     unverified, or partially read. **A LOW finding is never presented as settled.**
   - Citation form: pin the revision when the source is versioned (`file:line @ <sha/tag>` or a
     permalink); for a living document with no per-revision URL use `retrieved <ISO date> from
     <URL>` and label it `living-doc`.
3. Write each finding to memory as a **separate** episode (one finding = one write), tagged with
   `run:<run_id>` and the question id; include `data_quality: verified|estimated|unknown` and the
   exact source per metric. Append the returned `memory_uid` to the finding file.
   - **Default mode:** also tag exactly one of `agent:approved` / `agent:blocked`.
   - **`mode: root-distillation`:** instead tag `pattern:open-problem` + `root-complexity` +
     `research-space` + `residual-gap` + `domain/<name>` (no approved/blocked); see
     `references/playbooks/P8-root-distillation.md` for the full memory-recording contract.
4. **Read-back:** re-read what this run **wrote** — the `memory_uid:` recorded on each finding —
   and write the result to `memory-readback.json`. Uids recalled in Phase 2 for context are **not**
   re-read here; they belong to earlier runs.
   - Prefer a recall scoped to `run:<run_id>`; where the capability has no tag recall, re-read each
     written uid the way the capability allows and record its status. Never reach the store by any
     path other than the memory capability.
   - A written uid absent from the read-back, or present only as a failed/BLOCKED lookup, is a
     **failed write** — fix it or mark the finding BLOCKED; never claim success.

## Phase 6 — Hardened verification

Run the verifier:

```
node <skill-dir>/scripts/verify-research-run.mjs .research/runs/<run_id>/
```

It is the gate: it checks the evidence contract end to end and exits non-zero on any gap —

- **disk** — `manifest.json`, `questions.json`, `routing.json`, `trace.md` exist and parse; every
  `research` question has a non-empty `findings/<qid>.md`; every finding carries ≥1 citation and a
  confidence label; the finding carries a `memory_uid:` line whenever `memory` is available;
  `trace.md` names all eight phases; every `regen_history` length ≤ 2.
- **memory** — if the run declared `memory` available, `memory-readback.json` exists and every
  `memory_uid` cited across findings appears in it as a resolved (non-BLOCKED) entry.
- **tool (real provenance, not self-report)** — `tool_use.calls` records each external call
  (capability, tool, query/URL, outcome). Every citation URL must match a successful entry in
  `calls`; `tool_use.sources_verified` (a global distinct-source count) must be ≥ the number of
  distinct citations after trailing punctuation is normalised; `tool_use.search_terms` must be
  ≥ 3 × the number of `research` questions; a `code-intel`-absent run has no P3 findings.

If the verifier exits non-zero, the run is **not complete**. Fix the gap and re-run; never present
a run as complete while the verifier is red.

## Phase 7 — Process audit + self-consistency

1. **Re-measure** the Phase 0 baseline table (baseline / result / delta / target).
2. **Errors vs priors:** which findings contradicted a prior? was the bias surface confirmed?
3. **Process failure → classification:** search formulation · source selection · lateral triage ·
   claim tracing · inference leakage · C-grade numeric lift. Write one preventing rule each.
4. **Self-consistency:** read the answer as a fresh reader — no dangling "as discussed above", no
   unexplained abbreviations, complete URLs. Fix minimally. Pass = a caller reading only the output
   understands the full chain without the input.
5. Append the audit to `trace.md`.

**Outcome of the run — exactly one of:**

- **COMPLETE** — zero unresolved process failures, every finding MEDIUM or HIGH, and the baseline
  gate holds (≥2 sources verified; ≤2 rate-limits).
- **PARTIAL** — one or more findings are LOW or a baseline target is missed. The answer is produced,
  every LOW finding is listed unresolved, and the run is never labelled complete. A missing
  capability does not make a run PARTIAL; it moved those questions out as `not-research`.
- **INCOMPLETE** — a backing call failed or the verifier is red. Do not present an answer as settled.

## Output contract

The answer is ordered and closed:

```
## Answer
## Generalized question(s)
## Findings   (per question: answer · confidence · citations · memory uid)
## Conflicts / LOW-confidence items (explicitly unresolved)
## Build-vs-integrate   (Tool | Decision | Rationale — one sentence each; only for P1)
## Verification         (verifier result + run outcome: COMPLETE/PARTIAL/INCOMPLETE)
## Not-research items   (question | reason it left the skill)
```

Under `mode: root-distillation` (P8), `## Build-vs-integrate` is replaced by the P8 per-item table +
synthesis + recommendation — see `references/playbooks/P8-root-distillation.md`.

## Hard rules

- Never write application code or edit project source.
- Never skip Phase 2 — memory is checked before any external search.
- Never exceed 2 regenerations per question; never re-check memory a third time.
- Never write a finding to memory as anything but its own episode, tagged per Phase 5's
  mode-dependent tag set.
- Never reach the memory store by any path other than the memory capability (no direct store file,
  no spawned server, no HTTP).
- Never dispatch one sub-researcher per question; dispatches equal playbooks, not questions.
- Never let one domain's answer shape or ideology constrain another's; the core imposes none.
- Never name a tool or host-qualified symbol in this process — state the capability (ADR-0026).
- Never report a run COMPLETE while the verifier is red, a finding is LOW, or a backing call failed.
- Never fabricate a metric — an unverifiable number is `—`, and the claim is LOW.

## References

| file | read it when |
|---|---|
| `references/routing-table.md` | Phase 3 — mapping a question to a playbook |
| `references/sub-researcher-prompt.md` | Phase 4 — filling the dispatch prompt |
| `references/verification.md` | Phase 6 — the evidence contract in full |
| `references/corpus-evidence.md` | tuning the playbooks against real question data |
| `references/playbooks/P*.md` | the chosen playbook's scope + answer-category contract |
