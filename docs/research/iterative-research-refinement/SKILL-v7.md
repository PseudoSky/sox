# Iterative Research Refinement Skill

**Version:** 7 (proposed) — Consolidated 8 structural issues identified in v6 meta-audit:
cross-reference pointers, binary gate fallback, file-editing contradiction,
first-iteration trace handling, subagent/editor role clarity, unrecoverable recovery path,
unmeasurable exit criterion.

**Changelog:**
- v7: Added explicit "see below" pointer for Confidence Anchors cross-reference (Proposal 1).
  Replaced binary pass/restart gate with graduated fallback (Proposal 2).
  Resolved "do NOT edit" vs "write new file" contradiction (Proposal 3).
  Clarified first-iteration Meta-cognitive trace handling (Proposal 4).
  Clarified subagent vs editor role boundaries in Loop 3a Step 4 (Proposal 5).
  Fixed unreachable "return to Loop 3" recovery path (Proposal 6).
  Added measurable procedure for self-consistency exit check (Proposal 7).
- v6: Consolidated gap fixes (17 items from meta-loop audit). Normalized Unicode,
  added baseline sequencing note, clarified dispatch actor, replaced soft language
  with hard gates, added empty-trace and filing guidance.
- v5: Added Meta-cognitive trace field to Iteration Manifest. Pre-Commitment
  references prior traces. Phase C checks trace. Loop 2 updates trace.
  Exit criteria include trace review.
- v4: Added Loop 3a (real execution test) + Loop 3b (conditional commit).
  Loop 3 → propose-only. Loop 4 → structural verification only.
  Requires exact measurement procedures in dispatch payload.
- v3: Added scope boundary on Self-Refine (same-agent vs dispatched).
  Requires mandatory subagent dispatch for Loop 4.
- v2: Added self-analysis mode, artifact output section, iteration exit criteria.
- v1: Original.

A meta-cognitive research process that improves itself through nested feedback loops.
Use when you need to research a question, produce findings, audit your own process,
and iteratively refine the methodology — not just the answer.

**Self-Refine basis:** This process follows the Self-Refine pattern (Madaan et al., NeurIPS 2023, cited 4,865×):
generate → self-feedback → refine → repeat. Each loop generates, critiques itself, and refines.
The same agent performs all roles — generator, critic, and refiner.

**Scope boundary:** Self-Refine's same-agent pattern is validated for WITHIN-TURN output
refinement (improving a single response within one context window). Empirical research
(ACL 2024; arxiv 2607.04277, 2026) shows same-agent evaluation exhibits self-preference
bias (+4% to +37% delta across tested models) and saturates after 2-3 iterations.
For CROSS-TURN structural edits to process artifacts (Loop 3a real execution test),
a separate subagent MUST perform evaluation — same-agent evaluation is
structurally incapable of detecting its own blind spots (quasi-introspection gap,
arxiv 2607.04277 §4.6).

---

## Before Starting: Position Declaration

State which Loop and Phase you are currently in. This is a runtime guard against skipping.

```
Current Loop: Pre-Loop-1 / 1 / 2 / 3 / 3a / 3b / 4
Current Phase: 0 / 1 / 2 / 3 / 4 / 5
Previous Phase completed: Yes/No — evidence: <one-line summary of what was done>
```

If Previous Phase is No, STOP. Complete it before proceeding.

The evidence record is a free-text field stored inline in the position declaration.
It is NOT persisted to an external file. Its purpose is to force the agent to
articulate completion concretely rather than skipping.
**Example:** "Completed Phase 3: deep-read Self-Refine paper (A-grade), recorded CRAAP
evaluation, flagged partial read of section 4."

## Before Starting: Iteration Manifest

Before beginning any iteration, declare what you are iterating on and what this
iteration targets. This follows the prompt versioning pattern (braintrust.dev, 2026):
each iteration is an immutable version with a unique ID, a changelog, and promotion
gates that must be met before the version is accepted.

```
Iteration target: <the specific file, process, or prompt being improved>
Artifact version: <current version identifier — e.g., v3 or a date> 
Target version:   <version identifier this iteration should produce>
CWD: <absolute path to the current working directory from the calling agent>

Known gaps from prior work:
- <gap 1 — what was identified but not yet fixed>
- <gap 2>
- <gap N>

Baseline measurement (taken before any changes — see §Baseline Measurement below):
- Metric 1 — <name>: <value>   (e.g., "Blind test findings missed by self-eval: 0")
- Metric 2 — <name>: <value>   (e.g., "Structural gaps identified: 0")
**Note:** Fill metric names here first, then measure and return to fill values after reading
§Baseline Measurement. Do not skip measurement — without values the delta is unknown.

Meta-cognitive trace (accumulated across iterations — do NOT reset each iteration):
- Pattern 1 — <recurring tension or heuristic learned from prior iteration>
- Pattern 2 —
- Pattern <N>

This iteration's objective:
  <one sentence stating what specific improvement this iteration makes>

Success criteria — each MUST include a quantified threshold and baseline reference:
- [ ] <metric>: <baseline_value> → <target_value>, measured by <method>
      Example: "Blind test findings: 0 (self-eval) → >=3 (dispatched subagent), measured by subagent report"
- [ ] <metric>: <baseline_value> → <target_value>, measured by <method>

Changelog (filled during execution — each change is a new entry):
- [ ] <change 1>
- [ ] <change 2>

Measured delta (filled at iteration end — see §Re-Measurement below):
- [ ] <metric 1>: baseline <value> → result <value> → delta <+/-value>
- [ ] <metric 2>: baseline <value> → result <value> → delta <+/-value>
```

### Promotion gate
The iteration is complete only when:
1. All success criteria are met, including quantified thresholds
2. The measured delta meets or exceeds every threshold in the success criteria
3. The changelog has at least one entry
4. No success criterion was retroactively weakened to pass
5. The measured delta record is populated

If any criterion fails, the iteration does NOT produce a new version.
File the gap in "Known gaps from prior work" for the next iteration.
The gap remains open for the next iteration.

If an iteration completes with no changelog entries, it was not actually
an iteration — it was a dry run. Do not increment the version.

### Artifact Output

The iteration produces ONE output artifact at the iteration target path.
Record changes in the Changelog above as they are applied. The final
artifact SHOULD be the iteration target with all changelog entries
applied — no separate patch file, no sidecar document. If the iteration
target defines its own internal version number, bump it after all
changes are applied.

If the iteration target is this skill file itself, the artifact output
IS the skill file at the iteration target path. In that case the
changelog entries ARE the changes made to the skill, and the promotion
gate requires a self-consistency check: all instructions in the new
version must be executable by an agent reading it fresh (no dependency
on the iteration context).

## Baseline Measurement (taken before any changes)

This is the MEASURE phase following DMAIC (Define→Measure→Analyze→Improve→Control;
adapted from Six Sigma and DORA PDCA framework). Before making any changes,
establish a quantified baseline for each success criterion metric.

Baseline rules:
- Each metric must be a concrete, countable value (not subjective "seems fine")
- Take the measurement BEFORE editing the iteration target
- Record it in the Iteration Manifest's Baseline measurement field
- If a metric cannot be measured before changes, it is not a valid success criterion
- After identifying a potential issue, verify it by re-reading the artifact to confirm
  the issue actually exists. This prevents "phantom" errors from counting.

Examples of valid baseline metrics:
- "Number of structural gaps the current artifact would cause a fresh agent" →
  measured by dispatching a fresh subagent to review the artifact before changes
- "Self-evaluation gap (findings missed when same agent evaluates own work)" →
  measured by running the proposed version through a dispatched execution test
  (Loop 3a) and comparing findings count against the baseline
- "Confidence anchor violations" → measured by scanning the artifact
  for claims labeled HIGH that fail the confidence anchor definition

Examples of INVALID baseline metrics (rejected):
- "Artifact quality" — not countable
- "Agent confusion" — not measured before changes
- "Code review score" — requires external system not defined here

Record the baseline. Without it, the delta is unknown and the iteration
cannot prove improvement.

## Before Loop 1: Pre-Commitment

Before any search, declare:

**Priors — what I currently believe about this topic:**
[State your existing assumptions. Be specific.]

**Bias surface — what might make me favor certain conclusions:**
[Personal experience, prior work, known preferences that could bias interpretation.]

**Known ground truth — what I already know is factually correct about this topic:**
[Facts you can use as calibration. If the research contradicts these, trust is LOW.]

**Relevant meta-cognitive traces from prior iterations:**
[Reference patterns in the Meta-cognitive trace field that apply to this iteration.
If the trace is empty (first iteration), state "First iteration — no prior patterns."
If none of the existing patterns apply, state which patterns were considered and why
they don't match.]

---

## Before Loop 1: Observation Generalization

Before you can research, you need a research question. This step converts raw evidence
into generalized questions. Based on the generalization framework for software engineering
research (Wieringa & Daneva, 2015, "Six strategies for generalizing software engineering
theories," Science of Computer Programming, cited 282×), adapted for pre-research question
formulation rather than post-research finding generalization.

### Phase A — Collect Observations
Gather specific evidence. Each observation is one concrete fact:
- A file overrides a repo-wide default in its local config
- A package with async-native code broke a CJS consumer
- Two packages solved the same problem with 90% identical code

Format: `<thing>` does `<action>` which causes `<consequence>`. No interpretations yet.

### Phase B — Strip Specifics (Analytic Generalization)
Remove project-specific names, versions, paths. Replace concrete with generic:

| Concrete | Abstracted to |
|----------|---------------|
| `memory-core/tsconfig.lib.json` overrides `module:CommonJS` | A package opts into a different build format from the repo standard |
| `sox-ingest` has TLA that can't emit as CJS | A package has a native/async constraint that conflicts with the default format |
| `blob-store` uses `await import()` inside `open()` | A package defers native/heavy loading to the call site instead of module scope |

The goal: statements that could apply to any project, not just yours.

### Phase C — Identify the Tension
For each generalized statement, ask: "What design decision does this force?"

After identifying the tension, check the Meta-cognitive trace: has this tension appeared before?
- If the Meta-cognitive trace has entries: reference the existing pattern. If this tension
  contradicts a prior trace, flag it for trace revision — do not create a duplicate entry.
- If the Meta-cognitive trace is empty (this is the first iteration ever for this user):
  this is expected behavior. The trace accumulates only after at least one full iteration
  completes. In this case, skip the trace check. After the first iteration completes, the
  trace field will be updated with patterns discovered.

**Example tensions:**
- Per-package format override vs repo-wide standard → **centralization vs autonomy**
- ESM-only surface vs CJS consumers → **modern features vs backward compatibility**
- Static import at module scope vs dynamic import at call site → **eager loading vs deferred loading**

### Phase D — Frame as Research Questions
Turn each tension into a question about the PATTERN, using these stems:
- "What is the convention for ..."
- "Should every package ... or is it acceptable to ..."
- "What are the conditions under which ..."
- "How do established projects handle ..."

Example:
- Tension: centralization vs autonomy
- Question: "Should every publishable package ship a dual require/import surface,
  or is ESM-only acceptable given a mandated engines floor?"

### Phase E — Coverage Check (Contingency Generalization)
- Does the question apply beyond your project? If it only applies to your specific codebase,
  broaden it.
- What are the boundary conditions? (Wieringa's contingency strategy — specify when the
  pattern holds and when it doesn't.)
- Can the question be researched using external sources? If it requires internal knowledge,
  it's not a research question — it's a design question.

### Phase F — Domain Categorization
Group related RQs into domains (e.g., PKG, BUILD, PERF). Each domain should cover a
coherent area. This enables searching for patterns across related questions together.

**Proceed gate:**
If all phases A-F are complete and the RQs are researchable externally, proceed to Application Mode.
- If any phase A-F is incomplete, restart that specific phase. Do NOT restart from
  Pre-Commitment unless more than 2 phases are incomplete.
- If RQs are not externally researchable, note this in the Iteration Manifest under
  "Known gaps" and proceed with the understanding that not all RQs can be externally validated.
- If uncertain about any single phase, return to that phase only.
- If uncertain about more than 2 phases simultaneously, restart from Position Declaration.

---

## Application Mode: Self-Analysis vs External Research

Before proceeding to Loop 1, determine the mode of this iteration:

- **External Research mode** (default): The subject is a topic, domain, or question
  external to the skill itself. Loop 1 Phases 0-4 (search, triage, deep read) apply
  in full.
- **Self-Analysis mode**: The subject IS this skill file (or another process
  definition). The iteration studies the process artifact itself, not an external
  topic. In this mode, Loop 1 Phases 0-4 serve a SUPPORTING role (finding external
  frameworks, patterns, and failure modes for comparison) — the PRIMARY analysis is
  structural, done by applying the skill's phases to the artifact's own content.

Mode decision rule: If the Observation Generalization produces RQs that can ONLY be
answered by reading the artifact itself (not by external sources), you are in
**Self-Analysis mode**.

Record the mode and adjust Loop 1 expectations accordingly:
- Phase 0 (search): Target external frameworks/standards that the artifact can be
  compared against, not the artifact's own domain.
- Phase 1-3 (click, triage, read): Sources should cover pattern libraries, design
  heuristics, and failure-mode catalogs relevant to the artifact type.
- The artifact is a PRIMARY source for structural analysis — its own content is the
  main evidence base for findings.
- **In Self-Analysis mode, limit external searches to 2 queries totaling no more than
  5 candidates.** The primary evidence is the artifact's own content. If search results
  are unparseable (HTML-only, truncated), do NOT infer content — instead, document the
  source URL and note "external verification incomplete."

---

## Loop 1 — Empirical Research

### Phase 0 — Precision Search
- Generate search terms targeting the research question
- Use operators: quotes for exact phrases, `site:` for domain scope, `-` for exclusion
- Try multiple formulations if the first returns nothing useful
- Record the query actually used

### Phase 1 — Click Restraint
- Scan ALL results on the SERP (not just the first 3)
- Note: domain does NOT equal credibility
- Identify obvious duplicates (ResearchGate copy of journal article, etc.)
- Select 3-5 candidates for lateral triage. Do NOT click through yet.
- Record the candidates and why each was selected

### Phase 2 — Lateral Triage
For each candidate, BEFORE reading:
- Open a tab and search the source/publication as a whole
- Open a tab and search the author(s): are they qualified on this topic?
- Open a tab and check what other institutions or authorities cite this source
- Open a tab and find CRITIQUES of the source — what do detractors say?
- Verify the publication venue's reputation (peer review, known controversies)

Grade each using anchored definitions:
- **A** = peer-reviewed + multiple institutions cite it + author is known expert on this topic
- **B** = peer-reviewed or institutional publication + cited by some
- **C** = exists but venue/author has quality concerns
- **D/E** = anonymous, known unreliable, or pure opinion

Record the grade and whether you will proceed to Phase 3.

### Phase 3 — Deep Read + CRAAP
Only deep-read A/B sources. For C sources, only use if no better option exists and key claims can be independently verified.

While reading, evaluate:
- **Currency**: When published? Is timeliness important?
- **Relevance**: Does it directly address the research question?
- **Authority**: Who wrote it? What credentials? What publication?
- **Accuracy**: Are sources cited? Can claims be verified elsewhere?
- **Purpose**: Informing, teaching, persuading, or selling?

If you only read PART of the source, flag this clearly.

### Phase 4 — Trace Claims
- For each factual claim: open a new tab and verify it independently
- For each citation: confirm the cited source actually exists and says what is claimed
- Trace claims to their ORIGINAL context — do not rely on a secondary source's account
- Pay special attention to claims that CONTRADICT your declared priors from the Pre-Commitment step
- If a claim references a source that cannot be verified with available tools, state explicitly:
  "This claim references source X. I cannot verify it because [reason]. Treating as LOW confidence."
  Do NOT flag it as "possibly speculative" without stating the specific verification block.

### Phase 5 — Self-Feedback + Audit
**Self-feedback (generate before reading):** What do I expect this source to say? What would confirm or contradict my priors?

**Audit record:**
- Search query used
- Source(s) selected and their grades
- Whether you read FULL or only part
- What the source ACTUALLY said (direct quote or close paraphrase)
- What you INFERRED (your own reasoning not in the source)
- What you added from PRIOR KNOWLEDGE (which may be wrong)
- Did this source CORRECT any error from your Pre-Commitment priors?
- **Confidence** (anchored):
  - **HIGH** = claim supported by >=2 independent A-grade sources
  - **MEDIUM** = claim supported by 1 A-grade source or >=2 B-grade sources
  - **LOW** = claim inferred from prior knowledge, or supported by only B-grade sources
- What would you do differently next time? Record actionable changes in the Meta-cognitive trace.

**Compliance gate before proceeding to Loop 2:**
- All 5 phases completed? Yes/No
- Phase 5 self-feedback recorded? Yes/No
- If NO to either, STOP. Complete missing phases.

---

## Loop 2 — Process Audit

After completing Loop 1, audit the execution itself:

1. **Identify errors in the FINDINGS**: Were any conclusions wrong, unsupported, or exaggerated? Compare against your Pre-Commitment priors — was your bias confirmed or contradicted?
2. **Trace each error back to a PROCESS failure**: Was it a bad search query? Skipping lateral triage? Failing to trace a claim? Adding prior knowledge without verification?
3. **Classify each process failure**:
   - **Search formulation** — query was too narrow/broad, wrong terms
   - **Source selection** — chose based on domain, not credibility
   - **Lateral triage** — skipped verification of author/venue/critiques
   - **Claim tracing** — didn't verify a cited claim independently
   - **Inference leakage** — added prior knowledge without labeling it as such
4. **Self-feedback**: What pattern in YOUR OWN execution produced this error? Is this a recurring pattern? If you identify a recurring pattern, record it as a new entry in the Meta-cognitive trace (e.g., "Pattern: every time I search with broad terms, I get irrelevant results. Heuristic: use the framework's own vocabulary.").
5. **Patch the process**: For each failure, write a rule that prevents recurrence.

**Stopping criterion:** If Loop 2 identifies zero process failures AND all findings pass the
confidence anchors (see Confidence Anchors section below — all findings must be MEDIUM or HIGH
confidence; if any LOW-confidence findings remain, record them in "Known gaps from prior work"
and proceed to Loop 3), the process is stable. Stop and log completion. Otherwise, proceed to
Loop 3.

---

## Loop 3 — Propose Changes (do NOT edit the file — write to a NEW file)

Render the patched process as a proposal. Do NOT apply changes to the iteration target file
yet — the proposal must be tested by real execution first.

The proposal is written to a NEW versioned file at the path:
`<CWD>/<iteration-target-basename>-v<N+1>.<ext>`
- `CWD` = the calling agent's current working directory (provided in the Iteration Manifest)
- `iteration-target-basename` = the iteration target filename without extension (e.g., `SKILL`)
- `N` = the current artifact version number
- `ext` = the iteration target's file extension (e.g., `md`)

Example: if CWD is `/Users/nix/dev/ai/sox-ecosystem` and the target is `SKILL.md` at v7,
the output is `/Users/nix/dev/ai/sox-ecosystem/SKILL-v8.md`.

This file is NOT the iteration target — it is a separate test artifact. The iteration target
(the original file) remains unedited until Loop 3b.

1. Take the process failures identified and patched in Loop 2
2. For each patch, render the proposed new version of the affected section(s) as
   candidate text. Do NOT edit the iteration target file.
3. The proposed version must be self-contained — a DIFFERENT agent (unaware of
   prior loop context) must be able to execute it from the proposal alone.
4. Structure changes as sequential phases with checklists, not narrative inserts.
5. Maintain the runtime guard (position declaration) pattern throughout.

Output:
- A list of proposed section replacements, each clearly marked as PROPOSED (these are
  descriptions of what will change, listed in this section)
- The COMPLETE reconstructed artifact written to the path `<CWD>/<basename>-v<N+1>.<ext>`.
  This file is created by applying all proposed section replacements to a copy of the current
  iteration target. It is a SECOND file, not a modification of the original.
- This new file is the input to Loop 3a Step 1. Verify it exists before proceeding.

**Self-feedback before writing:** What did Loop 2 reveal about which parts of the
process are fragile? Focus the formalization on those parts.

**Differentiator: This is NOT Loop 1.** Loop 1 searches for external knowledge.
Loop 3 renders proposals. If you find yourself searching or citing sources in
Loop 3, you skipped back to Loop 1 — stop and re-declare your position.

---

## Loop 3a — Real Execution Test (dispatched)

Before committing any change, prove the proposal works by having a fresh subagent
execute it against the full scope used for baseline measurement.

### Step 1 — Use the complete artifact file from Loop 3

Loop 3 already wrote the complete proposed artifact to `<CWD>/<basename>-v<N+1>.<ext>`.
Use that file as the record of what will be tested. Never edit the original file.

Verify the file exists at the computed path before proceeding.
- If the file exists, proceed to Step 2.
- If the file does NOT exist: Loop 3 was not completed. Do NOT return to Loop 3 (which
  would start a new proposal cycle). Instead, complete the missing Loop 3 action: create
  the new versioned file at the computed path by applying the proposed replacements to a
  copy of the current iteration target. Once the file exists, proceed to Step 2.

### Step 2 — Editor generates a full real-world example task

The editing agent (not the subagent) creates a concrete task that exercises the
ENTIRE process from Position Declaration through to the final iteration exit
criterion. The task must:

- Be a real problem that requires research (not a toy example)
- Include a pre-populated Meta-cognitive trace with at least one entry
- Require the subagent to complete ALL phases and loops of the proposed process
- Have a measurable expected outcome that can be compared against the baseline

The task MUST NOT constrain the subagent to stop partway. "Complete Phase C
only" or "stop after identifying the tension" are explicitly forbidden. The
subagent must execute from Position Declaration through to the end of the
process or a clearly defined natural stopping point that exercises every phase.

Example task structure:
```
Meta-cognitive trace (pre-populated):
- Pattern 1: <pattern from prior iteration>

Your task: Execute the process below on the question <real research question>.
Complete ALL phases from Pre-Commitment through Loop 2. Produce a final report
with your Position Declaration, Pre-Commitment, research findings, and audit.
```

### Step 3 — Dispatch the subagent

Read the complete artifact file at `<CWD>/<basename>-v<N+1>.<ext>` from Step 1.
Dispatch a general-purpose subagent (not a domain-specific agent — use the most
flexible available agent type) with ALL of the following inlined in their prompt:

```
CWD: <CWD value from the Iteration Manifest>

Your process is as follows:

--- BEGIN FULL PROCESS ---
<COMPLETE proposed artifact — every section, every word>
--- END FULL PROCESS ---

Your Task is:

<Task from Step 2>
```

The subagent receives:
- NO file path, NO reference to the original file
- NO reference to the changelog, the editor's reasoning, or which parts
  of the inlined text are new vs original
- ONLY the block above: process + task. Nothing else.

If the inlined artifact is too large for a single prompt, the agent splits
it across multiple calls but never references the file.

### Step 4 — Subagent executes every section of the proposed process

The subagent MUST read and process EVERY section of the proposed artifact,
including sections that reference editor-level actions. The subagent must understand
which sections they execute personally vs which sections describe actions the EDITOR
(the person who dispatched the subagent) should take.

Specifically:
- **Execute fully** (the subagent does these): Pre-Commitment, Observation Generalization
  (Phases A-F), Loop 1 (Phases 0-5), Loop 2 (Process Audit). These are the research and
  analysis phases that the subagent performs in full using the proposed instructions.
- **Read and process, but simulate instead of executing** (the subagent reads these for
  consistency, but the EDITOR will do them): Loop 3 (Propose Changes), Loop 3a (Real
  Execution Test), Loop 3b (Commit Changes), Loop 4 (Structural Verification), and any
  "dispatch a subagent" or "edit the file" instructions. For each such instruction, the
  subagent records in their report what they would expect the editor to do, and whether
  the instructions are clear enough to follow.
- **The subagent is NOT expected to dispatch a sub-agent or edit any file.** These actions
  belong to the editor.
- **The subagent IS expected to evaluate** whether the editor-only sections are internally
  consistent, reference real sections, and could be followed by the editing agent. Any
  contradictions or errors found in these sections are reported as part of the test results.

The subagent performs real research (search, triage, read, trace claims). This is
NOT a review or a simulation — it is a real run using the proposed instructions.

### Step 5 — Subagent reports

The subagent returns a single message containing ALL of the following:
- The measured value for each baseline metric from the Iteration Manifest
- Any structural issues encountered during execution (contradictions, missing sections,
  ambiguous instructions)
- Evidence that every phase was completed (Position Declaration records, phase outputs, etc.)
- **If the subagent itself dispatched a sub-agent** (creating a vN+2 proposed artifact
  and execution test), the vN+2 subagent's full results MUST be included verbatim in
  this message — either inlined or attached.
- No interpretation, no recommendations beyond what is explicitly requested. The editing
  agent makes all decisions.

### Step 6 — Editor computes deltas

The editing agent computes `proposed_result − baseline` for every metric.
Compare each delta against the success criterion threshold from the
Iteration Manifest.

### Step 7 — Decision

The editing agent receives the subagent's return message (Step 5). This message
is the authoritative record of the execution test, including any vN+2 subagent
results. The editing agent preserves this message as part of the iteration record.

- **All deltas meet or exceed thresholds** and the subagent completed all phases
  → proceed to Loop 3b (commit). Record the real deltas in the Iteration
  Manifest's Measured delta field. Attach the subagent's return message as evidence.
- **Any delta falls below threshold**, OR the subagent did not complete all
  phases, OR the subagent had to reference the original file → do NOT commit.
  Return to Loop 2. The subagent's return message is diagnostic evidence.
  Include the measured-but-insufficient delta as a known gap.

**Scope rule:** The execution test covers ALL baseline metrics, not just the ones
the proposal targets. A fix for metric A that regresses metric B must be caught
before commit. Testing only the targeted metrics is insufficient.

**No-shortcut rule:** The task must cover the FULL process. "Go to Phase C only,"
"stop after identifying the tension," or any other partial-execution instruction
is forbidden. The subagent either executes the complete process or the test is
invalid. If the test was invalid, do NOT proceed to Loop 3b.

**Rationale:** Self-evaluation of proposed changes is structurally unreliable
(quasi-introspection gap, arxiv 2607.04277 4.6). A proposal that appears correct
to its author may not produce improvement when a fresh agent executes it literally.
The only valid test of a process change is whether a fresh agent following the new
instructions produces better results than the baseline across ALL measured
dimensions. Prior iterations of this skill proved that the editing agent always
finds zero issues with its own proposals, while a dispatched subagent finds 8+.
Partial execution tests (e.g., "stop after Phase C") are not valid — they cannot
detect failures in later phases that earlier phases may cause.

---

## Loop 3b — Commit Changes (conditional on 3a passing)

Only reach this step if Loop 3a passed for all proposals.

1. Apply each proposed section replacement as an edit to the iteration target file
2. Record each change in the Changelog in the Iteration Manifest
3. The modified artifact must be self-contained — a DIFFERENT agent (unaware of
   prior loop context) must be able to execute it from the artifact alone.
4. Include explicit grading rubrics, confidence anchors, and fallback rules where
   they were missing.

Output: modified iteration target artifact with changelog populated.

**Differentiator: Editing the file happens here, not in Loop 3.** If you edited
the file before Loop 3a completed, you violated the measurement integrity rule —
the baseline is no longer valid.

---

## Loop 4 — Structural Verification (committed artifact)

The execution test (Loop 3a) already proved the proposed changes work. Loop 4
verifies the committed artifact is structurally sound after the edits in Loop 3b.

1. **Read the committed artifact** (the file after Loop 3b edits). Verify:
   - All proposed changes from Loop 3 were applied correctly (no transcription errors)
   - No new contradictions were introduced by the edit process
   - The position declaration, phase numbering, and cross-references remain consistent
   - A fresh agent reading only this artifact can follow the instructions without
     external context
2. **If the artifact passes structural verification**, proceed to Iteration Exit.
3. **If structural issues are found**, fix them directly (these are transcription or
   formatting errors, not process failures). The execution test results from Loop 3a
   remain valid — the fix is cosmetic only.
4. **Stopping criterion**: Loop 4 passes when all structural checks pass. If structural
   issues require re-running the execution test (because the fix changes the meaning
   of the proposals), return to Loop 3.

---

---

## Re-Measurement (from Loop 3a execution test)

The real execution test in Loop 3a already measured every metric against the baseline.
This section collects those measurements into the Iteration Manifest.

1. Take the deltas computed in Loop 3a step 6 for every baseline metric
2. Record each delta in the Iteration Manifest's "Measured delta" field
3. Verify each delta against the corresponding success criterion threshold

If any delta falls below the threshold:
- The iteration is INCOMPLETE (do not promote)
- The Loop 3a execution test already prevents this — if it didn't, the gap is
  in the threshold definition, not the measurement. Review and adjust thresholds.
- File the threshold gap in "Known gaps from prior work" for the next iteration

If all deltas meet or exceed thresholds, proceed to Iteration Exit Criteria.

**Measurement integrity rule:** The re-measurement method must be identical to the
baseline method (enforced by Loop 3a step 6). If the method changes between baseline
and re-measurement, the delta is invalid. Document the measurement method explicitly
in each success criterion.

---

## Iteration Exit Criteria

The overall iteration (all 4 loops) is complete only when:

1. Loop 2 identified zero process failures OR all identified failures have been
   patched in Loop 3.
2. The Changelog in the Iteration Manifest has at least one entry (proving a change
   was actually made — not a dry run).
3. The promotion gate (all success criteria met, no retroactive weakening) has passed.
4. The artifact output exists at the iteration target path with all changelog entries
   applied.
5. In Self-Analysis mode: a self-consistency check has passed — the modified artifact
   can be followed as instructions by a fresh agent without dependency on iteration
   context.

   Procedure for the self-consistency check:
   a. Have a fresh agent read ONLY the artifact (no additional context, no iteration backstory).
   b. Ask the agent: "What loop should you start in? What is your first action?"
   c. **Pass condition:** The agent identifies the correct starting position
      (Pre-Loops → Position Declaration) AND can describe their first action without asking
      clarifying questions about the process structure.
   d. **Fail condition:** The agent asks any question about what version they're reading,
      what has come before, or what they're supposed to do.
   e. If the check fails, fix the ambiguity in the artifact and repeat. The check can use
      any capable agent — it does not create a dependency.
6. The Meta-cognitive trace was reviewed and updated with any new patterns discovered
   during this iteration.

If any criterion is unmet, the iteration is INCOMPLETE. Do NOT increment the version.
File the remaining gaps in the next iteration's "Known gaps from prior work" section.

---

## Runtime Guards

These apply at ALL times during execution of this skill:

1. **Position declaration**: Before ANY action, state your current loop and phase. If you cannot state it, you have skipped a step.
2. **Phase completion check**: Before moving to the next phase, confirm the previous phase record exists. If it doesn't, complete it first.
3. **Baseline before change**: The Baseline Measurement must be recorded before any edit to the iteration target. If a success criterion's baseline was not recorded, the criterion is invalid — remove or defer it.
4. **Proposal before edit**: The iteration target file must NOT be edited before Loop 3a (real execution test) completes with all deltas meeting thresholds. Edits made before the execution test invalidate the baseline. If you are in Loop 3 and tempted to edit, you are in the wrong loop — re-declare.
5. **Pre-commitment preservation**: Before drawing a conclusion, check it against your declared priors. If it contradicts a prior but you have no source to verify, flag it as LOW confidence.
6. **No direct output**: Never go from search results (Phase 0-1) directly to writing conclusions. You must pass through all intermediate phases.

---

## Confidence Anchors (use everywhere)

| Level | Definition |
|-------|-----------|
| **HIGH** | Claim supported by >=2 independent A-grade sources, or 1 A-grade source with independently verified claims |
| **MEDIUM** | Claim supported by 1 A-grade source, or >=2 B-grade sources with verified claims |
| **LOW** | Claim inferred from prior knowledge, or supported by B-grade sources only, or partially read source |

If confidence is LOW, state explicitly: "I believe this, but I cannot verify it from my research."

**"Pass" definition for confidence anchors (referenced by Loop 2 stopping criterion):**
- A finding "passes" confidence if its confidence level is MEDIUM or HIGH.
- LOW confidence findings do NOT pass. They must be flagged as unresolved.
- The Loop 2 stopping criterion ("all findings pass the confidence anchors") is
  met only when zero LOW-confidence findings remain unresolved for that loop's output.
  If any LOW-confidence finding exists, record it in "Known gaps from prior work" and
  proceed to Loop 3 (do not stop even if no process failures were identified).
