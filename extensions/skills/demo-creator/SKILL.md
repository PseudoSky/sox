---
name: demo-creator
description: >
  Use this skill whenever you need to produce a project's demo script, DEMO.md,
  acceptance walkthrough, QA verification script, or end-to-end "prove it works"
  document — and especially when the user wants something that both tells the
  product's story like a live demo AND functions as a rigorous acceptance test.
  Trigger it even when the user doesn't say "demo": phrases like "walkthrough for
  QA", "exercise every path", "verify we built what the spec says", "acceptance
  script", "show the system works 100%", "a script I can hand to QA/an agent", or
  "a TED/YouTube-style demo of the project" all mean this skill. It turns a project
  spec (or PRD/README/landing copy/code) into a persona-narrated, presentation-grade
  DEMO.md with exact commands, exact data, binary pass/fail assertions, full
  happy/edge/recovery coverage, and requirement→capability traceability.
---

# Demo Creator

Turn a project's context into a **DEMO.md** that is two documents fused into one:

1. **An acceptance contract** for the agent (or team) *implementing* the project.
   If a capability isn't exercised somewhere in the DEMO.md, the implementer has no
   signal to build it — so completeness here defines scope there.
2. **An executable, presentation-grade verification pass.** A person or agent runs
   it top-to-bottom, copy-pasting exact commands with exact data, comparing real
   output to the stated expected output, and ticking binary pass/fail checks — and
   the whole thing reads like a great product demo: it opens on a stranger's first
   encounter with the product and builds to the payoff.

Holding both jobs at once is the entire point. A demo that doesn't verify is
marketing; a test plan that doesn't tell a story doesn't get watched or trusted.
This skill produces the rare artifact that does both.

> **Status: v0.1 (living).** This process is being validated against real demo
> builds. When a run teaches us something — a missing step, a better narrative
> move, a recurring failure mode — fold it back into this file. Keep it honest
> about what we actually do, not what we wish we did.

## When to use

Reach for this whenever the deliverable is "show + prove the project works":
- The user asks for a demo script, walkthrough, acceptance script, or QA
  verification doc for a project.
- Someone needs to confirm an implementation matches its spec by exercising every
  path naturally.
- You want a single artifact that markets the product *and* gates the release.

If the user only wants marketing copy (no verification) or only a dry test matrix
(no story), this skill is overkill — but those are rare. The default ask is both.

## Inputs you need

Gather as much project context as exists before authoring. In rough priority:
- **Spec / PRD / design doc** — the requirements and intended behavior (primary).
- **Landing page / marketing copy** — the value proposition and the voice of the hook.
- **README / docs** — setup, commands, surface area.
- **Code / API surface / CLI help** — ground truth for exact commands and outputs.
- **Tickets / acceptance criteria** — explicit pass/fail conditions.

If context is thin, author what you can and record the gaps in the DEMO.md's
"Gaps & Open Questions" section rather than fabricating behavior.

## The bundled template

`assets/DEMO.template.md` is the skeleton you fill in. **Read it in full before
authoring** — it carries:
- The fixed section structure (cold open → cast/cold-start → acts & beats → climax
  → resilience sweep → teardown → coverage matrix → sign-off).
- A placeholder grammar: `{{TOKEN}}` to replace, `<!-- FILL: … -->` instructions to
  follow then delete, `«REPEAT …»` blocks to realize N times, `[OPTIONAL — …]`
  conditional sections.
- The authoring rules **R1–R10** (exactness, concrete expected output, binary
  assertions, traceability, every-path coverage, cold-start→teardown, determinism,
  load-bearing narrative, ground-or-stub, source-annotate-every-step) and a
  Definition of Done.

The template is the detailed "how to fill each segment" reference. This SKILL.md is
the "how to run the whole job" workflow. Don't duplicate the template's rules here —
point to them and follow them.

## Process

Work through these phases. They're a sensible order, not a straitjacket — loop back
when a later phase exposes a gap in an earlier one.

### 1. Gather & read context
Pull together every input above. Read the bundled template end to end so the target
shape is in your head before you start extracting.

### 2. Extraction pass — build the working lists
Mine the context into the lists the template's coverage matrix will consume. This is
the load-bearing analytical step; do it explicitly, don't wing it:
- **Value prop / hook** — the one-sentence promise + the pain it kills.
- **Personas** — who uses this and their concrete goal. Pick one primary to carry
  the spine; add secondaries only where a path needs a different role.
- **Requirements** — every "shall/must/should"/acceptance criterion, each given a
  stable ID (`REQ-001…`; reuse the spec's IDs if it has them).
- **Capabilities** — the distinct things the system can *do*, coarser than
  requirements, each given an ID (`CAP-001…`). Map capabilities→requirements.
- **Data model** — entities/fields you'll fabricate fixtures from.
- **Paths per capability** — for each capability: happy path, error/edge cases
  (bad input, auth failure, limits, conflicts, empty/missing), and any recovery flow.
- **The climax** — the single most differentiating "holy-shit" capability.
- **Surface/modality** — CLI? HTTP API? Web UI? SDK? Daemon? This decides whether a
  beat's action is a shell command, an HTTP request, a UI step, or code.

### 3. Design the narrative arc
Choose the primary persona and sequence the **acts** (capability clusters) so the
story escalates toward the climax. Decide where negative/edge/recovery beats fall
*naturally* — a persona who hits a wall and recovers is more convincing than one who
never stumbles. The goal is for the story to touch every capability because the
persona needs it, not as a feature checklist.

### 4. Resolve the output location
Resolve this BEFORE filling anything — the template is copied straight into it. Always
write the demo into a plan-scoped demo directory:

```
docs/plan/<plan-slug>/demo/DEMO.md
```

Resolve `<plan-slug>` like this:
- **If the project already has a plan name or directory**, reuse its slug. Look for
  an existing `docs/plan/<slug>/` directory, a plan/PRD file that names the plan, a
  slug used by the project's planning tooling, or a name the user gave you. Match the
  existing slug exactly — don't invent a parallel one.
- **If there is no plan name or directory**, derive an appropriate slug from the
  context you read: take the project/initiative name (or its core feature) and
  kebab-case it (lowercase, words joined by `-`, no spaces or special characters,
  e.g. `realtime-collab-editor`). Keep it short and recognizable.

Create the directory tree if it doesn't exist. If you had to invent the slug, say so
in your summary so the user can rename it. Demo-support files (fixture seed files,
sample payloads, screenshots referenced by the script) live alongside `DEMO.md` in that
same `demo/` directory.

### 5. Fill the template, segment by segment
Copy `assets/DEMO.template.md` to the plan-scoped output path from phase 4
(`docs/plan/<plan-slug>/demo/DEMO.md`) and work through it, replacing every `{{TOKEN}}`,
following then deleting every `<!-- FILL -->`, realizing each `«REPEAT»` block per
beat/row, and resolving each `[OPTIONAL]`. Obey R1–R10 throughout — every command
verbatim-runnable, every expected output concrete, every assertion binary, every beat
carrying its `🔗 Proves` IDs and its `📎 Source`. Use consistent zero-padded IDs
(`REQ-001`, `CAP-001`) — the same width in beats and in the §7 matrix — so traceability
matches exactly.

### 6. Author the beats — weave every path, ground every step
For each beat: write the customer-facing `🎬 Scene`, the exact `▶️ Do` action with
literal data, the concrete `👀 Expect`, the binary `✅ Verify` assertions, the
`🔗 Proves` mapping, and the `📎 Source` line naming what grounds the step (spec §,
doc, file, ticket, or URL). Tag beats `(happy) / ⚠️ (edge) / 🛟 (recovery)`. Use only
data defined in the canonical fixture block or produced by an earlier beat.

**Ground or stub — never silently invent (R9).** The DEMO.md must read the same
whether the product is built or only a spec: confident, uniform, no "(if implemented)"
hedging. When you must reference an interface (command, flag, endpoint, field, response
shape, error code) the context doesn't specify, write a concrete plausible value in the
literal, record the `⟦U#⟧` tag on that step's `📎 Source` line (e.g. `📎 Source: ⟦U4⟧
inferred — see UNRESOLVED.md`), and append a row to the sibling `UNRESOLVED.md`. **Never
concatenate `⟦U#⟧` inside a runnable command, URL, or JSON literal** — that corrupts the
literal and breaks copy-paste runnability (R1/R9). The marker annotates; the literal
stays clean. This pushes every guess into a tracked ledger instead of invented prose.
Push remaining adversarial cases that didn't fit the story into the resilience sweep so
coverage is provably total.

### 7. Build the coverage matrix and the UNRESOLVED ledger
Roll the extraction lists into the traceability tables: every requirement ID and
every capability ID mapped to the beat(s) that prove it, with happy/edge/recovery
columns. **Any unmapped requirement or capability is a build gap** — either add a beat
or log it. Then reconcile `UNRESOLVED.md`: every `⟦U#⟧` stub used anywhere in DEMO.md
has exactly one matching row (no orphans either way), plus any scope gaps and
assumptions. §7.3 of the demo carries a short summary that points at this file. This —
the matrix plus the honest uncertainty ledger — is the acceptance contract's teeth.

### 8. Strip template machinery
Before validating, strip ALL scaffolding from DEMO.md: the top instruction comment,
every `<!-- FILL -->`, all `«REPEAT»`/`[OPTIONAL]` markers, and the §7.3 sidecar-spec
comment block. **Keep the `⟦U#⟧` stub markers** — they're the honest-uncertainty signal
and must survive (the §0 legend's literal `⟦U#⟧` documentation row also stays). Leave the
§8 sign-off table blank — it's filled by whoever *runs* the demo. Order matters: the
validator hard-fails on any leftover machinery, so strip first, validate second.

### 9. Validate — mechanical gate, then judgment
First run the bundled validator; **do not emit until it exits 0**. The validator lives
in this skill's own directory (the `scripts/` folder next to this SKILL.md), not in the
target project — invoke it by its full path, pointing it at the demo you just wrote:

```
python3 "<this-skill-dir>/scripts/validate_demo.py" docs/plan/<plan-slug>/demo
```

`<this-skill-dir>` is wherever you read this SKILL.md from (typically
`~/.claude/skills/demo-creator`). Use that absolute path — a bare `scripts/...` will not
resolve from the project's working directory.

It deterministically fails on the checks a model tends to self-certify wrong: leftover
template machinery, `⟦U#⟧` markers glued inside runnable literals, stub↔ledger orphans
(the inline set must equal the UNRESOLVED.md set), beats missing a `📎 Source`, and
coverage-matrix ids never proven by a beat. Fix every failure (warnings are advisory but
read them) and re-run until it passes. This is a gate, not a suggestion — a weaker model
will otherwise declare a broken demo "done."

Then apply the judgment half of the Definition of Done, which no script can check:
cold-start→teardown actually reproduces with only the declared prerequisites; expected
outputs are genuinely concrete; assertions are truly binary; and it reads as a
compelling demo to a stranger *and* verifies the system to an engineer. Both, not either.

### 10. Done — declare and report
You're done when every exit criterion holds: `DEMO.md` and `UNRESOLVED.md` both exist in
`docs/plan/<plan-slug>/demo/`; all template machinery is stripped while `⟦U#⟧` stubs and
`📎 Source` lines survive; the validator exits 0; every `REQ-`/`CAP-` is mapped to ≥1
beat; happy + edge + recovery paths are all present; and the judgment-half DoD holds
(reproducible cold-start→teardown, concrete outputs, binary assertions, demo +
verification both true). Report the output paths, the validator result, and whether you
invented the slug (so the user can rename it).

## Output

Written to `docs/plan/<plan-slug>/demo/` (slug resolved per phase 4):
- **`DEMO.md`** — the clean, story-driven acceptance document, free of template
  scaffolding, with `⟦U#⟧` stubs and `📎 Source` lines intact.
- **`UNRESOLVED.md`** — the ledger of every guessed interface and scope gap (or an
  explicit "none"). This is what keeps a confident DEMO.md from hiding fabrication.
- Any demo-support files (fixtures, sample payloads, screenshots) beside them.

Ready to hand to an implementing agent as scope (with UNRESOLVED.md as its "confirm
these first" list) and to a QA runner as a verification pass.

## Refining this skill (the living loop)

We are deliberately maturing this skill against real builds rather than synthetic
evals. After each real demo creation:
- Note what the process got wrong or left implicit, what the template lacked, and any
  failure mode that recurred.
- Update this SKILL.md and/or `assets/DEMO.template.md` to encode the fix — bump the
  version note when the change is material.
- Once the process is stable, we can run the formal skill-creator eval loop
  (test prompts, benchmark, description optimization) to harden triggering and
  quality. Until then, the real runs are the eval.
