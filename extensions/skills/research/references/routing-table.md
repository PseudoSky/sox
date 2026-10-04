# Routing table

Phase 3 matches each `research` question to **one or more** playbooks — every domain the question
touches, never a single forced winner. Apply the rules in order, then union the matches into a list.

## 1. Domain → playbook (primary)

| domain | playbook |
|---|---|
| library-selection | P1 `dependency-adopt` |
| tooling-process | P1 `dependency-adopt` |
| api-usage | P1 `dependency-adopt` |
| db-storage | P2 `technical-forensics` |
| architecture-pattern | P2 `technical-forensics` |
| verification | P2 `technical-forensics` |
| codebase-navigation | P3 `codebase-evidence` |
| testing | P3 `codebase-evidence` |
| market-trend | P4 `market-intelligence` |
| finance-accounting | P4 `market-intelligence` |
| career-content | P4 `market-intelligence` |
| security | P5 `threat-security` |
| user-voice (ux/design/product feedback) | P6 `user-voice` |
| agent-orchestration | P7 `general-synthesis` |
| data-analysis | P7 `general-synthesis` |
| docs-writing | P7 `general-synthesis` |
| other | P7 `general-synthesis` |

## 2. Answer-category tie-break (when a domain straddles two playbooks)

| expected answer | playbook |
|---|---|
| dependency-verdict | P1 |
| comparison-table (of candidate tools/libraries) | P1 |
| root-cause (of a system or code failure) | P2 |
| trend-synthesis | P4 |
| file-paths / raw-tool-output | P3 |
| enumeration / explanation / pattern-recommendation | the domain's playbook, else P7 |
| design-artifact | P7 |
| root-distillation / open-problem-landscape (what is still unsolved in a domain and why) | P8 |

## 3. Precedence rules

1. **Answer-category beats domain** on the row above (e.g. a `db-storage` question whose expected
   answer is `dependency-verdict` for a database library routes to **P1**, not P2).
2. **Testing disambiguation:** running/reading/designing this repo's tests → **P3**; evaluating a
   *testing tool or library* to adopt → **P1**.
3. **Codebase-only questions leave the skill:** a `codebase-navigation` question answerable by
   reading this repo (`locate` / `file-paths`) is `not-research (code-intel)` — do not dispatch.
4. **Tool probes leave the skill:** `raw-tool-output` / `test-probe` plumbing checks are
   `not-research (ops)`.
5. **Ties break toward the lower-numbered playbook** only if the answer-category table does not
   decide.
6. root-distillation is an OUTPUT-SHAPING MODE reached only via the `mode: root-distillation`
   input; when set, it overrides the domain's primary playbook. Without that input the category
   does not trigger. It never applies to decision or eval questions.

## 4. Agent-specificity → playbook (for playbook tuning)

The aggregated research source agents map onto the playbooks as follows; each playbook's reference
file carries the process merge of its column.

| playbook | agent specialties (source) |
|---|---|
| P1 dependency-adopt | researcher (sox, claude), testing-tool-evaluator, ml-research-scout, project-idea-validator |
| P2 technical-forensics | scientific-literature-researcher, research-analyst, testing-test-results-analyzer, specialized-model-qa, gis-analyst |
| P3 codebase-evidence | search-specialist, explore |
| P4 market-intelligence | market-researcher, competitive-analyst, trend-analyst, product-trend-researcher, finance-financial-analyst, finance-investment-researcher, finance-fpa-analyst, sales-pipeline-analyst, marketing-x-twitter-intelligence-analyst, marketing-ai-citation-strategist, specialized-pricing-analyst, specialized-cultural-intelligence-strategist, specialized-french-consulting-market |
| P5 threat-security | security-threat-intelligence-analyst |
| P6 user-voice | ux-researcher, design-ux-researcher, product-feedback-synthesizer |
| P7 general-synthesis | research-analyst, workflow-researcher, data-researcher, support-analytics-reporter, specialized-business-strategist, business-analyst |

Unmapped-id guard: a research agent whose specialty is not in this table routes by its question's
domain, defaulting to P7.
