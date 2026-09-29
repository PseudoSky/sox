---
name: "Corroboration matrix — the caller's 7 self-reported figures"
topic: "tool-catalog"
tags: ["agent:approved", "corroboration", "self-report", "evidence-audit"]
summary: "External evidence corroborates the MECHANISM behind all 7 of the caller's figures, but corroborates NO specific number — every figure is a self-report with no primary telemetry, which is itself consistent with a real, documented instrumentation gap. Three figures (2, 5, 6) are the most strongly externally corroborated as mechanisms; figures 1/3/4 are mechanism-corroborated via MAST/Anthropic; figure 7 is corroborated by analogy to optimistic-concurrency/provenance but has no named agent-pattern home."
importance: 8
data_quality: "estimated"
---

# Cross-cutting audit

**All 7 figures are the orchestrator's own self-reports with no primary telemetry.** That is itself finding
(6). The distinction below: **mechanism corroborated** (an external source independently establishes that this
class of failure is real and named) vs **numbers corroborated** (would require the caller's raw logs).

| # | Figure (self-report) | Mechanism corroborated by | Numbers |
|---|---|---|---|
| 1 | 128/417 dispatches off-objective from a no-filter "never shelve" rule | MAST FM-1.5 "Unaware of stopping conditions" (12.4%) + FM-2.3 "Task derailment" (7.4%) **[A]**; triage-gate practice **[A/B]** | unverifiable (no external dataset) |
| 2 | `model:opus` on 108 dispatches; $449/$679; opus $7.65 vs sonnet $2.30 | FrugalGPT: API fees "differ by two orders of magnitude"; cascade = up to 98% saving **[B]**; model-routing literature **[C]** | unverifiable externally (provider price sheets + harness accounting are private) |
| 3 | main loop $292.91 / 3,469 turns / 460.6M cache-read tokens ≈ 43% | Anthropic: "token usage alone explains 80% of variance"; monotonic-context loop is the documented mechanism; plan-persistence + filesystem handoff are the fixes **[B-primary]** | unverifiable |
| 4 | 412 briefs / 845k chars; fixed-playbook briefs same median length as implementer briefs | Anthropic "scale effort to query complexity" + required brief fields **[B-primary]**; MAST FM-1.1 "Disobey task specification" (11.8%) **[A]** | unverifiable; no external brief-length benchmark exists |
| 5 | 62 reviews; 55 returned findings; only 22 ≥HIGH; 156/181 sub-HIGH; 15 on test tooling | Google eng-practices: approve-on-improvement + "Nit:" non-blocking **[A]**; lint baseline/ratchet "may only shrink" **[B-primary]**; MAST verification category **[A]** | unverifiable |
| 6 | telemetry rows had no $ / token figures; cost invisible; first explanation a guess (suspected cause ~3%) | OTel GenAI semconv exists precisely to attach token/cost to spans **[A]**; Langfuse/LiteLLM/AI-Gateway budgets **[B-primary]**; Splunk "hidden cost of agentic AI" **[C]** | unverifiable |
| 7 | 3 of ~10 proposed fixes already implemented before the reflection | ETag/If-Match OCC (lost update) **[A]**; ADR "never edit, only supersede" **[A/B]**; build provenance **[A]** | unverifiable; **no named agent-pattern exists** |

## Bottom line

- **Corroborated as mechanisms, not as numbers:** all 7.
- **Strongest external footing:** 2 (cost-tier lever, quantitatively established by FrugalGPT), 5 (review-gate
  convergence, canonically established by Google eng-practices + lint ratchet), 6 (instrumentation gap, the
  exact reason OTel GenAI semconv exists).
- **Most novel / least externally documented:** 7 (no named agent pattern for "cite the revision you read")
  and 1 (the interaction of "never shelve" with a no-filter rule is an application, not a documented pattern).
- **Cannot be externally verified at all:** every dollar/token/date number. These require the orchestrator's
  own logs and the provider price sheet at the time of the run.
