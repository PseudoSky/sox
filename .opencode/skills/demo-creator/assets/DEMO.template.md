<!--
═══════════════════════════════════════════════════════════════════════════════
  DEMO.template.md  —  Universal Demo-Script-as-Acceptance-Contract Template
═══════════════════════════════════════════════════════════════════════════════

  WHAT THIS FILE IS
  -----------------
  A reusable, project-agnostic skeleton for producing a project's DEMO.md.
  You (an LLM agent or a human author) are handed THIS template plus a specific
  project's context (spec, PRD, README, landing copy, code, tickets). You fill
  every replaceable segment using that context and emit a finished DEMO.md.

  The finished DEMO.md serves TWO masters at once:

    1. ACCEPTANCE CONTRACT  — It is the source of truth for the agent IMPLEMENTING
       the project. If a capability is not exercised somewhere in this document,
       the implementer has no signal to build it. Completeness here == scope there.

    2. EXECUTABLE VERIFICATION PASS — A person or agent can run it top-to-bottom,
       copy-pasting exact commands with exact data, comparing real output to the
       stated expected output, and checking off binary pass/fail assertions to
       prove the system works 100%.

  ...all while reading like a great product demo: it opens on a stranger's very first
  encounter with the product and ends on them sold. Think the narrative spine of a
  YouTube walkthrough or a TED demo — highlight the value, build tension, land the
  payoff.

  THE OUTPUT IS ALWAYS CONSISTENT — UNCERTAINTY GOES TO A SIDECAR
  --------------------------------------------------------------
  The finished DEMO.md reads the same whether the product is already built or is only
  a spec. You do NOT hedge the prose, add "(if implemented)" caveats, or switch into a
  different "mode" when the system doesn't exist yet. Instead, every time you must
  reference an interface (a command, flag, endpoint, field name, response shape, file
  path, error code) that you CANNOT ground in the project context — i.e. you are
  guessing how it works — you do two things and only these two:
    1. Write a concrete, plausible value inline so the demo stays uniform and runnable-
       looking, and tag it with a stub id  ⟦U#⟧  (U1, U2, U3 … unique per guess).
    2. Append an entry for that exact ⟦U#⟧ to a sibling file  UNRESOLVED.md  (created
       beside DEMO.md), recording the guess, where it's used, what you based it on (or
       "no basis — inferred"), and what would confirm it.
  This keeps you honest: anything not provably grounded becomes a visible, tracked stub
  instead of silent invention. Scope gaps, ambiguous requirements, and "I couldn't find
  how X works" notes ALSO go in UNRESOLVED.md. See R9, R10, the §0 legend, and §7.3.

  HOW TO USE THIS TEMPLATE
  ------------------------
  • Replace every  {{TOKEN}}  with concrete content derived from project context.
  • Wherever you see  <!-- FILL: ... -->  that is an instruction TO YOU. Follow it,
    then DELETE the comment from the finished file. No FILL comments survive.
  • Blocks marked  «REPEAT: ...»  ... «/REPEAT»  are repeated N times (one per beat,
    per requirement, etc.). Remove the markers; keep the realized copies.
  • Sections marked  [OPTIONAL — keep only if ...]  are conditional. Keep or cut per
    the condition, then remove the bracket note.
  •  ⟦U#⟧  is an UNRESOLVED stub marker — a guessed interface logged in UNRESOLVED.md.
    These DO survive into the finished DEMO.md (they're the honest-uncertainty signal).
  • Anything in this top comment block is template machinery — DELETE this entire
    HTML comment from the finished DEMO.md.

  AUTHORING RULES (non-negotiable — these define quality)
  -------------------------------------------------------
  R1  EXACT, NOT APPROXIMATE. Every command is copy-paste runnable verbatim. Every
      input value is literal (real usernames, real payloads, real file contents).
      Never write "<your-api-key>" without also stating exactly where it comes from
      and a concrete example value or how to generate one in this very script.
  R2  CONCRETE EXPECTED OUTPUT. Every action states what you will literally see —
      exact text, status code, row count, file, UI element. "It should work" is a
      defect. If output varies (timestamps, IDs), show the shape and mark the
      volatile parts with ⟨…⟩ and say what's stable about them.
  R3  BINARY ASSERTIONS. Every claim of correctness is a checkbox that is
      unambiguously true or false by observation. No "looks right."
  R4  TRACEABILITY. Every beat names the requirement ID(s) and capability ID(s) it
      proves. Every requirement and capability in the project MUST appear in the
      coverage matrix mapped to ≥1 beat. An unmapped requirement is a release gate.
  R5  EVERY PATH. Cover happy paths, negative/error paths, edge/limit cases, and
      recovery. Weave them into the story (a demo that survives adversity is more
      convincing), not bolted on as an afterthought — though a final resilience
      sweep may mop up whatever didn't fit the narrative.
  R6  COLD START → TEARDOWN. Reproducible from nothing: a reader with zero prior
      state can reach the same end state. Begin at the stranger's first encounter
      with the product, end at a clean teardown that proves no residue.
  R7  DETERMINISM & IDEMPOTENCY. Prefer fixed seed data and commands that can be
      re-run. Where the system is inherently nondeterministic, say so and give the
      invariant the reader checks instead of an exact value.
  R8  NARRATIVE IS LOAD-BEARING. The persona's goal pulls the reader through. Every
      beat advances their story; capabilities are revealed because the persona needs
      them, never as a feature checklist. Keep the customer-facing voice in the
      "🎬 Scene" lines and the rigor in the "✅ Verify" lines.
  R9  GROUND OR STUB — NEVER SILENTLY INVENT. Every capability, command, flag,
      endpoint, field, and expected output must trace to something in the project
      context. When the context is silent on an interface the demo needs, do NOT
      quietly make it up and do NOT hedge the prose: write a concrete plausible value,
      tag it ⟦U#⟧, and log that exact id in UNRESOLVED.md (the guess, where used, the
      basis or "inferred", and what would confirm it). If a whole capability has no
      basis at all, still log it in UNRESOLVED.md. The DEMO.md stays uniform and
      confident; UNRESOLVED.md carries every place you were guessing.
      STUB PLACEMENT (critical): the ⟦U#⟧ marker ANNOTATES a step — it lives on that
      step's 📎 Source line (e.g. "📎 Source: ⟦U3⟧ inferred — see UNRESOLVED.md") or as
      a trailing prose tag. It must NEVER be concatenated inside a runnable command,
      URL, request body, or JSON literal — doing so corrupts the literal and breaks R1
      copy-paste runnability. Inside the literal, use a normal plausible value; the
      stub id is recorded only in the annotation and the ledger.
  R10 SOURCE-ANNOTATE EVERY STEP. Each beat (and the cold-start and teardown steps)
      carries a 📎 Source line naming what grounds it — the spec section, doc heading,
      file path, ticket, or URL the command + expected output came from. A step whose
      Source is "⟦U#⟧ inferred — see UNRESOLVED.md" is by definition a guess and MUST
      have its stub logged. Source annotations make grounding auditable and make any
      ungrounded step impossible to hide.

  DERIVING CONTENT FROM PROJECT CONTEXT (your extraction checklist)
  ----------------------------------------------------------------
  Before filling anything, mine the project context and build these working lists:
    • VALUE PROP / HOOK: the one-sentence promise + the pain it kills. From landing
      copy, spec intro, "why" sections, goals.
    • PERSONAS: who uses this and what they're trying to accomplish. Pick 1 primary
      (carries the spine); add secondaries only if a path requires a different role.
    • REQUIREMENTS: enumerate every "shall/must/should" or acceptance criterion.
      Assign stable IDs (REQ-001…). If the spec already has IDs, reuse them.
    • CAPABILITIES: the distinct things the system can DO (verbs/features), more
      coarse-grained than requirements. Assign IDs (CAP-001…). Map caps→reqs.
    • DATA MODEL: the entities and fields you'll need to fabricate fixtures.
    • PATHS PER CAPABILITY: for each capability list its happy path, its error/edge
      cases (bad input, auth failure, limits, conflicts, empty states), and any
      recovery flow.
    • THE CLIMAX: the single most differentiating, "holy-shit" capability. The whole
      demo should build toward it.
    • SURFACE/MODALITY: CLI? HTTP API? Web UI? SDK? Daemon? This dictates whether a
      beat's "action" is a shell command, an HTTP request, a UI step, or code.
  Keep these lists; the coverage matrix at the end is literally them, checked off.

  DEFINITION OF DONE for the finished DEMO.md
  -------------------------------------------
    ☐ Every {{TOKEN}} replaced; every FILL/REPEAT/OPTIONAL marker removed.
    ☐ Every requirement ID and capability ID appears in the coverage matrix,
      mapped to at least one beat.
    ☐ Happy + negative + edge + recovery paths all present.
    ☐ Runs cold-start→teardown with only the prerequisites it declares.
    ☐ Every command verbatim-runnable; every expected output concrete; every
      assertion binary.
    ☐ Every beat/step has a 📎 Source line; every guessed interface is tagged ⟦U#⟧
      inline AND has a matching entry in the sibling UNRESOLVED.md (no orphan stubs in
      either direction).
    ☐ UNRESOLVED.md exists beside DEMO.md and lists every interface guess and scope
      gap (or states "none — every interface is grounded" if truly none).
    ☐ The skill's validator passes: run `validate_demo.py` (in the demo-creator
      skill's scripts/ dir) by its full path against <demo-dir> and it exits 0 (no
      machinery, no glued stubs, no stub↔ledger orphans, every beat sourced, every
      matrix id proven).
    ☐ Reads as a compelling demo to a stranger, AND verifies the system to an
      engineer. Both, not either.
═══════════════════════════════════════════════════════════════════════════════
-->

# 🎬 {{PROJECT_NAME}} — Live Demo & Acceptance Script

<!-- FILL: One-line subtitle = the value-prop promise, in the product's own
     positioning voice. e.g. "Ship production-ready APIs in one command." -->
> {{ONE_LINE_PROMISE}}

<!-- FILL: A short "what this document is" note for whoever opens it cold. Keep the
     two-purposes framing below but phrase it for this project. -->
**What this is.** A presentation-grade walkthrough of {{PROJECT_NAME}} that doubles
as its acceptance test. Follow it top to bottom and you will (a) experience the
product the way a brand-new user would and (b) prove every capability works, with
exact commands, exact data, and pass/fail checks. It is the contract for what
"done" means: if it's demonstrated here, it must work; if it must work, it's
demonstrated here.

---

## 0 · How to Read This Script

**Legend**

| Marker | Meaning |
|---|---|
| 🎬 **Scene** | The story beat — what's happening and why the persona cares. Read this aloud in a demo. |
| ▶️ **Do** | The exact action to take (command, request, or UI step) with literal input data. |
| 👀 **Expect** | The exact observable result. Volatile parts (IDs, timestamps) shown as ⟨…⟩. |
| ✅ **Verify** | Binary pass/fail assertions. Tick each only if it is literally true. |
| 🔗 **Proves** | Requirement and capability IDs this beat satisfies (traceability). |
| 📎 **Source** | What grounds this step — spec section, doc, file, ticket, or URL it came from. |
| ⟦U#⟧ | An **unresolved stub**: a value guessed because the context didn't specify it. Logged in `UNRESOLVED.md` beside this file. |
| ⚠️ **Edge / 🛟 Recovery** | A deliberately adversarial or failure-then-recover beat. |

**Conventions**
<!-- FILL: List the literal conventions a reader needs. Adjust to the project's
     surface. Examples to keep/cut/extend: shell prompt is `$`; commands are run
     from the repo root unless noted; ⟨...⟩ marks values that change between runs;
     base URL is {{BASE_URL}}; all sample data in this doc is fictional and safe. -->
- {{CONVENTION_1}}
- {{CONVENTION_2}}
- Values shown as ⟨like-this⟩ vary per run; the assertion next to them states what stays invariant.
- Tokens shown as ⟦U#⟧ are interfaces this script had to guess; each is listed in `UNRESOLVED.md` beside this file — confirm them before treating the step as authoritative.

---

## 1 · Cold Open — The Hook

<!-- FILL: This is the first 30 seconds of the demo. The reader knows NOTHING.
     Capture the moment a stranger first encounters this product — however that
     happens for THIS project (a landing page, a README, a teammate's pitch, a
     `--help` screen, a launch post). Do NOT assume there's a website. In the
     product's own voice: the pain the persona lives with today, the promise
     {{PROJECT_NAME}} makes, and the single sentence that makes them keep watching.
     Pull from the spec's intro/goals and any positioning copy. Make it exciting and
     true — no claims the system can't back up later. -->

🎬 **Scene.** {{COLD_OPEN_NARRATIVE — the hook: the problem, the promise, the why-now.}}

> **The promise we'll prove in the next {{N}} minutes:** {{HEADLINE_CLAIM}}

🔗 **Proves (framing):** {{REQ_IDS_FOR_VALUE_PROP}} · {{CAP_IDS_FOR_VALUE_PROP}}
📎 **Source:** {{WHERE_THE_HOOK_COMES_FROM — spec intro / positioning doc / README; or ⟦U#⟧ if inferred}}

---

## 2 · Cast, World & Cold-Start Setup

### 2.1 Meet {{PERSONA_PRIMARY_NAME}}
<!-- FILL: 2–4 sentences. Name, role, concrete goal, and the stakes. The reader
     should adopt this persona for the rest of the script. Add secondary personas
     ONLY if a later path needs a different role (e.g. an admin, a second user for
     a collaboration/permissions beat). -->
{{PERSONA_PRIMARY_BIO}}

[OPTIONAL — keep only if a multi-role path exists]
**Also appearing:** {{PERSONA_SECONDARY_NAME}} — {{PERSONA_SECONDARY_BIO}}

### 2.2 The Canonical Demo Dataset
<!-- FILL: Define the EXACT fixture data used throughout, derived from the project's
     data model. Use realistic but obviously-fictional values. This is the single
     source of data truth — every later beat refers back to these. Provide it in a
     copy-pasteable form (table, JSON, seed file, or .env) matching the surface. -->
{{FIXTURE_DATA_BLOCK}}

### 2.3 Prerequisites
<!-- FILL: The MINIMUM the reader must have before step 1. Exact versions. Anything
     not listed here must be installed/created by the script itself (R6). If the
     project is meant to need nothing but, say, Docker — say exactly that. -->
- {{PREREQ_1}}
- {{PREREQ_2}}

### 2.4 Cold Start — From Nothing to Running
<!-- FILL: The literal bootstrap. Clone/install/configure/launch, in order, with
     exact commands and exact expected output for each. This proves setup is real
     and reproducible. End on the strongest available proof the system is running:
     a health/readiness check if the context defines one; otherwise the best visible
     signal (a startup log line, a `--version`, a process/port check, a trivial call
     that succeeds). Do NOT invent a health route just to have one — if you must infer
     any probe or start command, give it a plausible value, annotate ⟦U#⟧ on the
     Source line, and log it (R9).
     BOUNDARY: §2.4 owns everything up to a running, verified system (install, config,
     start, running-proof). The persona's FIRST real task belongs in Act 1, not here. -->

▶️ **Do**
```bash
{{SETUP_COMMANDS}}
```

👀 **Expect**
```
{{SETUP_EXPECTED_OUTPUT}}
```

✅ **Verify**
- [ ] {{SETUP_ASSERTION_1}}
- [ ] {{SETUP_ASSERTION_2 — e.g. health endpoint returns 200 / process is listening on {{PORT}} }}

🔗 **Proves:** {{REQ_IDS_SETUP}} · {{CAP_IDS_SETUP}}
📎 **Source:** {{WHERE_SETUP_STEPS_COME_FROM — README/install doc/spec §; tag ⟦U#⟧ for any inferred command}}

---

## 3 · The Journey

<!-- FILL: This is the body. Organize as ACTS (chapters of the persona's story,
     each clustering related capabilities) made of BEATS (single demonstrable
     moments). Order acts so the story escalates toward the climax (Section 4).
     Weave error/edge/recovery beats inline wherever the persona would realistically
     hit them. Use the «REPEAT» blocks below as the unit of authoring. Aim for the
     story to NATURALLY touch every capability — if one has no natural home, that's
     a smell worth noting in OPEN QUESTIONS, not a reason to omit it. -->

«REPEAT ACT: one per capability cluster»
### Act {{ACT_NUMBER}} — {{ACT_TITLE}}
<!-- FILL: One sentence on where the persona is in their journey and what they're
     about to accomplish in this act. -->
{{ACT_INTRO}}

«REPEAT BEAT: one per demonstrable moment within the act»
#### {{ACT_NUMBER}}.{{BEAT_NUMBER}} · {{BEAT_TITLE}}   {{BEAT_TYPE_TAG — one of: (happy) | ⚠️ (edge) | 🛟 (recovery) }}

🎬 **Scene.** <!-- FILL: customer-facing narration. Why is the persona doing this
   now? What do they want? Keep it in the demo voice. For ⚠️/🛟 beats, set up the
   tension: what could go wrong, and why showing it builds trust. -->
{{BEAT_NARRATION}}

▶️ **Do**
<!-- FILL: exact action. Match the surface:
   • CLI:  ```bash``` block with the literal command and literal args/data.
   • HTTP: the method, URL, headers, and a literal request body.
   • UI:   numbered click-by-click steps with the literal text to type.
   • SDK:  a runnable code snippet with literal inputs.
   Use ONLY data defined in 2.2 or produced by an earlier beat (reference which). -->
```{{LANG}}
{{BEAT_ACTION}}
```

👀 **Expect**
<!-- FILL: the literal observable. Exact output text / status / payload / UI state.
   Mark volatile substrings with ⟨…⟩ and let the Verify block pin the invariant. -->
```
{{BEAT_EXPECTED}}
```

✅ **Verify**
<!-- FILL: 1–N binary assertions. Each is checkable by looking at the Expect result.
   For ⚠️ beats assert the error is handled gracefully (right code, clear message,
   no crash, no partial/corrupt state). For 🛟 beats assert full recovery to a good
   state. -->
- [ ] {{BEAT_ASSERTION_1}}
- [ ] {{BEAT_ASSERTION_2}}

🔗 **Proves:** {{BEAT_REQ_IDS}} · {{BEAT_CAP_IDS}}
📎 **Source:** <!-- FILL: what grounds this beat's command + expected output — spec §,
   doc heading, file path, ticket, or URL. If any value here was guessed, tag it ⟦U#⟧
   inline above and write "⟦U#⟧ inferred — see UNRESOLVED.md" here. -->{{BEAT_SOURCE}}
«/REPEAT BEAT»
«/REPEAT ACT»

---

## 4 · The Climax — {{CLIMAX_CAPABILITY_NAME}}

<!-- FILL: The payoff the whole demo built toward — the single most differentiating
     capability. Give it room. Same beat structure, but this is where the persona
     gets the big win and the reader thinks "holy shit." Make the Scene land the
     emotional value, and make the Verify prove it's real, not a mock. -->

🎬 **Scene.** {{CLIMAX_NARRATION}}

▶️ **Do**
```{{LANG}}
{{CLIMAX_ACTION}}
```

👀 **Expect**
```
{{CLIMAX_EXPECTED}}
```

✅ **Verify**
- [ ] {{CLIMAX_ASSERTION_1}}
- [ ] {{CLIMAX_ASSERTION_2}}

🔗 **Proves:** {{CLIMAX_REQ_IDS}} · {{CLIMAX_CAP_IDS}}
📎 **Source:** {{CLIMAX_SOURCE — spec §/doc/URL grounding this payoff; ⟦U#⟧ for anything inferred}}

---

## 5 · Resilience Sweep — Edges We Didn't Hit in the Story

[OPTIONAL — keep only if some negative/edge/limit/recovery paths weren't reachable
through the narrative. If the story already covered them all, delete this section
and say so in the coverage matrix.]

<!-- FILL: Systematically exercise the remaining adversarial cases so coverage is
     provably total. Each entry is a compact beat: trigger the condition, show the
     graceful handling, assert no corruption. Group sensibly (validation, auth,
     limits/quotas, concurrency/conflicts, empty/missing, malformed, timeouts). -->

«REPEAT EDGE: one per remaining adversarial case»
#### 5.{{N}} · ⚠️ {{EDGE_TITLE}}
▶️ **Do**
```{{LANG}}
{{EDGE_ACTION}}
```
👀 **Expect** — {{EDGE_EXPECTED}}
✅ **Verify**
- [ ] {{EDGE_ASSERTION}}
🔗 **Proves:** {{EDGE_REQ_IDS}} · {{EDGE_CAP_IDS}}
📎 **Source:** {{EDGE_SOURCE — spec §/doc/URL; ⟦U#⟧ if inferred}}
«/REPEAT EDGE»

---

## 6 · Teardown — Back to Zero

<!-- FILL: Cleanly stop and remove everything the script created, with exact
     commands. Then prove no residue (no orphaned processes, containers, data,
     temp files). This closes the cold-start→teardown loop and proves the system
     is a good citizen. -->

▶️ **Do**
```bash
{{TEARDOWN_COMMANDS}}
```

👀 **Expect**
```
{{TEARDOWN_EXPECTED}}
```

✅ **Verify**
- [ ] {{TEARDOWN_ASSERTION_1 — e.g. no process listening on {{PORT}} }}
- [ ] {{TEARDOWN_ASSERTION_2 — e.g. data dir / containers / temp files gone}}

🔗 **Proves:** {{REQ_IDS_TEARDOWN}} · {{CAP_IDS_TEARDOWN}}
📎 **Source:** {{WHERE_TEARDOWN_STEPS_COME_FROM — spec §/doc; ⟦U#⟧ for any inferred command}}

---

## 7 · Coverage & Traceability Matrix

<!-- FILL: This is the acceptance-contract's teeth. List EVERY requirement and EVERY
     capability from your extraction lists, and map each to the beat(s) that prove
     it. Any row with no beat is a build gap — either add a beat or flag it in
     OPEN QUESTIONS. The "Paths" column confirms you hit happy + edge + recovery
     where applicable. The implementing agent reads this as its scope checklist. -->

### 7.1 Requirements → Beats
| Req ID | Requirement (short) | Proven by beat(s) | Paths covered (H/E/R) | Status |
|---|---|---|---|---|
«REPEAT: one row per requirement»
| {{REQ_ID}} | {{REQ_SUMMARY}} | {{BEAT_REFS}} | {{H_E_R}} | ☐ |
«/REPEAT»

### 7.2 Capabilities → Beats
| Cap ID | Capability | Proven by beat(s) | Status |
|---|---|---|---|
«REPEAT: one row per capability»
| {{CAP_ID}} | {{CAP_NAME}} | {{BEAT_REFS}} | ☐ |
«/REPEAT»

### 7.3 Unresolved Interfaces & Gaps
<!-- FILL: The authoritative log of uncertainty lives in the sibling file
     UNRESOLVED.md (see spec below). Here, just summarize: the count of ⟦U#⟧ stubs,
     the count of scope gaps, and the few highest-impact ones the implementer should
     resolve first. Point the reader to UNRESOLVED.md for the full list. If there were
     genuinely none, say "None — every interface in this script is grounded in
     context." Never fabricate to make it empty. -->
- {{UNRESOLVED_SUMMARY — e.g. "7 unresolved interface stubs (⟦U1⟧–⟦U7⟧) and 2 scope gaps; full list in UNRESOLVED.md. Highest impact: ⟦U2⟧ server-start command."}}

<!-- ┌──────────────────────────────────────────────────────────────────────────┐
     │ SIDECAR FILE TO CREATE:  UNRESOLVED.md  (beside DEMO.md, NOT inside it)    │
     │                                                                            │
     │ Every guessed interface (⟦U#⟧) and every scope gap gets a row. This is the │
     │ honest-uncertainty ledger that keeps the confident DEMO.md from being a    │
     │ fabrication. Use this structure:                                           │
     │                                                                            │
     │   # UNRESOLVED — {{PROJECT_NAME}} Demo                                     │
     │   Interfaces this demo had to guess, and scope gaps found while authoring. │
     │   Resolve each before treating the corresponding DEMO.md step as truth.    │
     │                                                                            │
     │   ## Unresolved interfaces                                                 │
     │   | ID  | Guessed interface | Used in | Basis | What would confirm it |    │
     │   |-----|-------------------|---------|-------|-----------------------|    │
     │   | U1  | `tool x start`    | §2.4    | inferred from pkg layout | a CLI ref / --help |
     │   | ... |                   |         |       |                       |    │
     │                                                                            │
     │   ## Scope gaps & open questions                                           │
     │   - <capability/requirement with no natural beat, ambiguity, assumption>   │
     │                                                                            │
     │ DELETE this comment block from the finished DEMO.md. -->


---

## 8 · Sign-Off

<!-- FILL: Keep as-is; this is filled by the RUNNER, not the author. -->
| Field | Value |
|---|---|
| Environment | ⟨OS / version / commit SHA⟩ |
| Run by | ⟨name or agent ID⟩ |
| Date | ⟨date⟩ |
| Beats passed | ⟨X of Y⟩ |
| Requirements proven | ⟨X of Y⟩ |
| Result | ☐ PASS &nbsp;&nbsp; ☐ FAIL |
| Notes / defects filed | ⟨…⟩ |

> A run is **PASS** only if every ✅ assertion is checked and every requirement in
> §7 is proven. One unchecked binary assertion = FAIL until resolved.
