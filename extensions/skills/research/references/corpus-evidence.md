# Corpus evidence — why these seven playbooks

The playbook segmentation is derived from two gathered datasets, both under
`.opencode/artifacts/research-skill/`.

## Question corpus (`questions.json`, 553 questions)

Extracted from the opencode session store and Claude Code transcripts; synthesized and classified in
`corpus-synthesis.json`.

- **Domains (16):** agent-orchestration 107 · db-storage 84 · verification 64 · data-analysis 43 ·
  library-selection 40 · codebase-navigation 38 · market-trend 38 · security 28 · testing 25 ·
  tooling-process 22 · other 21 · finance-accounting 15 · architecture-pattern 14 · career-content 8 ·
  docs-writing 5 · api-usage 1.
- **Answer categories (12):** fact-with-citation 217 · explanation 115 · pattern-recommendation 62 ·
  dependency-verdict 39 · trend-synthesis 33 · file-paths 27 · root-cause 18 · comparison-table 16 ·
  enumeration 11 · raw-tool-output 8 · design-artifact 4 · dataset 3.
- **Key observations:** 53% of questions are local lookups / evidence work, not external research
  (hence the explicit out-of-scope routes for `code-intel` and ops); all `explore` questions are
  codebase navigation; `db-storage` is the largest coherent technical theme; `library-selection`
  is a distinct adopt/replace/reject class; `fact-with-citation` is the dominant answer shape.
- **Coverage gaps encoded as rules:** dependency-verdict schema (P1 output contract); revision-pinned
  citations (P2); red→green evidence gate for backlog revalidation (routes to backlog, not prose);
  tool probes route to ops; no statistical-analysis playbook exists because the corpus contains no
  such question.

## Agent aggregation (`researchers.json`, 32 agents)

12 from `claude-agents/categories`, 1 canonical sox `researcher`, 19 from `_reference/agency-agents`.

- **Universal process steps** (all agents): scope/plan → collect multiple sources → analyze/synthesize
  → evaluate evidence quality → structured output → verification gate. These are the spine of
  `SKILL.md` Phases 0–7.
- **Unique steps folded in:** pre-commitment/bias surfacing · observation generalization ·
  memory health-check before search · ADR-catalog-first · open-facet vocabulary · per-finding memory
  write tagged `agent:approved`/`agent:blocked` · build-vs-integrate verdict · exact-quote claim
  tracing · process audit + promotion gate + self-consistency · quantitative scoring rubrics ·
  scenario construction · fatal-flaw anti-sycophancy · independence principle.
- **Distinct verification mechanisms folded into the playbooks / verifier:** multi-source
  triangulation · source grading A–E · CRAAP · lateral triage · exact-quote claim tracing ·
  PRIMARY/SECONDARY tiering · post-write memory validation recall · ADR-vs-memory conflict
  resolution · Admiralty confidence-before-publication · facts-vs-projections separation ·
  reproducibility/version control · independence principle · peer/methodology review ·
  bias detection / anti-sycophancy · geometric/spatial QC spot-check · in-report confidence.

## How the playbooks were segmented

Domain frequencies × the 32 agents' specialties were clustered into seven groups whose sub-researcher
prompts differ materially (different evidence bar, answer shape, and source universe): an
adopt/reject decision class (P1), an internal-systems forensics class (P2), a repo-read class (P3),
an external market/synthesis class (P4), a threat-intel class (P5), a user-voice class (P6), and a
default synthesis class (P7). Every one of the 16 domains maps to exactly one — see
`routing-table.md`.
