# P2 — technical-forensics

**Decision class.** Root-cause a technical failure, explain or verify a technical mechanism, or do
upstream source forensics against a pinned revision.

**Scope domains:** `db-storage`, `architecture-pattern`, `verification`.
**Answer category:** `root-cause`, `explanation`, revision-pinned citations.

## Output contract

1. **Symptom → mechanism → evidence → root cause** chain. Each link carries a citation.
2. **Upstream citations are revision-pinned** — `file:line` at a tag/sha/version, or a permalink.
   A moving `main` link is not evidence.
3. **Reproduction** — the exact command/query and its result, or a stated reason it could not run.
4. **Confidence** per finding (HIGH/MEDIUM/LOW, anchors in SKILL.md).

## Verification rules (hard gate)

- Exact-quote claim tracing: a claim is verified against the primary source, quoted, not paraphrased.
- Reproducibility: where numeric or behavioural, re-run and report the delta (replicate; a delta
  within the playbook's tolerance is required before calling it confirmed).
- Statistical rigor where frequencies/samples appear — sample size and interval stated.
- Source tiering: primary (source/advisory/spec) over secondary (blog/aggregator).
- Inference is labelled as inference; it never enters the root cause as fact.

## Agent merge (process borrowed)

- `scientific-literature-researcher` — CRAAP, primary/secondary tiering.
- `research-analyst` — structured synthesis.
- `testing-test-results-analyzer` — statistical rigor (sample size, intervals).
- `specialized-model-qa` — replication delta tolerance (≤1%).
- `gis-analyst` — geometric/spatial QC spot-check, adapted to numeric/data QC.

## Fail conditions

- A prose root cause with no pinned citation.
- Inference presented as fact (leakage).
- A numeric claim with no reproduction or trace.
