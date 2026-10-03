# P7 — general-synthesis

**Decision class.** Catch-all for explain / enumerate / design / summarize across
agent-orchestration, data-analysis, docs-writing, and anything unclassified.

**Scope domains:** `agent-orchestration`, `data-analysis`, `docs-writing`, `other`.
**Answer category:** `explanation`, `enumeration`, `pattern-recommendation`, `design-artifact`.

## Output contract

1. **Structured answer** — one section per sub-question, each claim carrying a citation.
2. **Enumerations are partitioned** with a stated axis (why the list is complete for the question).
3. **Design artifacts** state the decision, the constraints it satisfies, and the rejected
   alternatives in one line each.
4. **Confidence** per finding (HIGH/MEDIUM/LOW, anchors in SKILL.md).

## Verification rules (hard gate)

- Multi-source triangulation: a claim rests on ≥2 independent sources before HIGH.
- Every claim has a resolvable citation; an uncited explanation is LOW.
- Primary sources over aggregators; a summary of a source is not the source.
- When superseding prior knowledge, the new finding states what it supersedes.

## Agent merge (process borrowed)

- `research-analyst` — structured synthesis and trend framing.
- `workflow-researcher` — in-progress stub + supersede discipline.
- `data-researcher` — dataset identification and provenance.
- `support-analytics-reporter` — analytics reporting.
- `specialized-business-strategist` — MCDA-style option scoring.
- `business-analyst` — requirements and business rules trace to their source; gap analysis compares
  current vs. to-be process; acceptance criteria are testable conditions; process maps name improvements.

## Fail conditions

- An uncited explanation.
- An enumeration with no stated axis.
- A superseding finding that does not name what it supersedes.
