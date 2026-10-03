# P4 — market-intelligence

**Decision class.** Multi-source synthesis across market, competitive, trend, finance/accounting,
pricing, and career/positioning questions.

**Scope domains:** `market-trend`, `finance-accounting`, `career-content`.
**Answer category:** `trend-synthesis`, `comparison-table`.

## Output contract

1. **Normalized cross-source table** — `| Source | Date | Claim | Evidence | Confidence |`, so claims
   are comparable question-to-question.
2. **Facts vs projections** in separate sections. A dated, sourced observation is a fact; a forecast
   is a projection, labelled with its author and horizon.
3. **Scenario / sensitivity** — best/base/worst with the assumption each turns on.
4. **Weighted comparison** (when selecting among options) — a scored matrix with explicit axes.

## Verification rules (hard gate)

- ≥2 independent sources per trend claim; a single vendor/PR source is never sufficient.
- **Every source is dated**; an undated claim is LOW at best and flagged.
- A projection is never stated as fact.
- Confidence is stated before publication (Admiralty-style source/credibility grading).
- No vendor's own claim is treated as independent verification.

## Agent merge (process borrowed)

- `market-researcher`, `competitive-analyst`, `trend-analyst`, `product-trend-researcher` —
  market/trend synthesis.
- `finance-financial-analyst`, `finance-investment-researcher`, `finance-fpa-analyst` — financial
  analysis, forecasts, variance.
- `sales-pipeline-analyst`, `marketing-x-twitter-intelligence-analyst`,
  `marketing-ai-citation-strategist` — pipeline and channel signals.
- `specialized-pricing-analyst`, `specialized-cultural-intelligence-strategist`,
  `specialized-french-consulting-market` — pricing, cultural adaptation, MCDA scoring.

## Fail conditions

- Undated sources.
- A projection presented as fact.
- A single-source trend claim.
