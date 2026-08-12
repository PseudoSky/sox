# Injecting a Research Process into an Agent Spec

How to take a generic research process and adapt it to a specific agent's
specification, prompt, or configuration.

## The problem

A generic research process defines *how* to research. An agent spec defines
*what* the agent should do. They live at different abstraction levels.
Injecting means: translating the generic process into concrete rules,
constraints, and behaviors that the agent executes without knowing it's
following a meta-process.

## The translation table

When the target is a researcher agent's spec file (prompt, instructions,
agent.md), map each generic element to the spec's context:

| Generic element | Injected into agent spec as |
|----------------|---------------------------|
| Position declaration | A required header block at the top of every response: "Current phase: X" |
| Iteration Manifest | Not needed — the spec doesn't iterate itself, it executes. The manifest lives at the meta level (the person revising the spec). |
| Pre-Commitment | A required step before any search: "State what you believe about this topic BEFORE searching." Enforced in the spec as a rule, not a suggestion. |
| Observation Generalization | If the agent receives raw evidence, the spec should include the generalization steps (strip specifics → identify tension → frame as RQ). If the agent receives already-generalized RQs, this step is handled by the person sending the request. |
| Precision search | A rule: "Try at least 3 search formulations before concluding no source exists." |
| Click restraint | A rule: "Do not cite a source you have not laterally triaged." |
| Lateral triage | Explicit grading rubric in the spec: A/B/C/D/E with definitions. Required before citing any source. |
| Deep read | A rule: "Only cite A/B sources. If citing C, state why no better source exists." |
| Trace claims | A rule: "For every factual claim, cite the original source — not a secondary account of it. If you cannot find the original, flag the claim as unverified." |
| Self-feedback + Audit | A required closing section per source: "What the source said / What I inferred / Confidence (HIGH/MEDIUM/LOW with anchored definitions)." |
| Confidence anchors | Embedded in the spec as a table, not a narrative instruction. |
| Source grades | Embedded in the spec as a table with concrete examples per grade. |
| No direct output | A rule: "Never go from search results directly to conclusions. You must pass through at least lateral triage first." |

## How injection changes the form

Generic instructions in the meta skill are phrased as methodology ("Phase 0 — Precision Search: generate search terms targeting the research question"). Injected into an agent spec, they become **constraints and enforcement rules**:

- "You MUST state your current phase before every search."
- "You MUST grade each source before citing it."
- "You MAY NOT cite a source you have not laterally triaged — a lateral triage record is required."
- "You MUST distinguish what the source said from what you inferred."
- "If confidence is LOW, state: 'I believe this but cannot verify it from my research.'"

The agent doesn't know it's following a research methodology. It knows it has hard rules about what it can and cannot do.

## What NOT to inject

- **The meta-loop structure** (Loops 1-4). The agent executes a single research pass — it does not iterate on its own spec. The iteration happens at the meta level (the person revising the spec).
- **The Iteration Manifest**. This belongs in the meta-layer's tracking system, not in the agent's prompt.
- **The skill's self-improvement goal**. The agent should not know it's part of an iterative improvement cycle. It should only know the execution rules.

## Verification

After injecting, test with: "Does the agent's output contain any unsourced claim, any inferred-but-not-labeled inference, or any confidence label without an anchor definition?" If yes, the injection missed a constraint.
