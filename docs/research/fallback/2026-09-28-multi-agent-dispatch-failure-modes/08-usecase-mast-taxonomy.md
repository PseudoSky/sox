---
name: "MAST — Multi-Agent System Failure Taxonomy (Why Do Multi-Agent LLM Systems Fail?)"
topic: "tool-catalog"
tags: ["use-case:reference", "mast", "failure-taxonomy", "peer-reviewed", "neurips-2025"]
summary: "Peer-reviewed (NeurIPS 2025 Datasets & Benchmarks) taxonomy of multi-agent LLM failure modes, built from 150 expert-annotated traces (inter-annotator kappa=0.88) and validated on 1600+ traces across 7 frameworks. 14 modes in 3 categories: (i) system design, (ii) inter-agent misalignment, (iii) task verification. The most relevant modes for an orchestrator: FM-1.5 Unaware of stopping conditions (12.4%), FM-2.3 Task derailment (7.4%), FM-1.1 Disobey task specification (11.8%), FM-2.6 Reasoning-action mismatch (13.2%), FM-3.2 No/incomplete verification (8.2%), FM-3.3 Incorrect verification (6.2%). Notably, MAST has NO cost/budget category — cost governance is absent from the failure taxonomy."
importance: 9
data_quality: "verified"
type: "production-implementation"
metrics_source:
  abstract: "https://arxiv.org/abs/2503.13657 (fetched 2026-09-28, HTTP 200)"
  modes: "https://arxiv.org/html/2503.13657v3 (curl 2026-09-28; FM codes extracted via rg)"
  venue: "NeurIPS 2025 Datasets & Benchmarks (per MDPI survey citation + awesome-auditable-ai listing)"
---

# Use case / taxonomy (RQ2, RQ3, RQ4 — independent corroboration)

**Source:** Cemri, Pan, Yang, Agrawal, Chopra, Tiwari, Keutzer, Parameswaran, Klein, Ramchandran, Zaharia,
Gonzalez, Stoica. "Why Do Multi-Agent LLM Systems Fail?" arXiv:2503.13657 (v1 2025-03-17; v3 2025-10-26);
**NeurIPS 2025 Datasets & Benchmarks track**. ~784 citations. **Grade A** (peer-reviewed, top venue, high
inter-annotator agreement κ=0.88, released dataset).

## The 14 modes (extracted verbatim from the HTML, v3)

**Category 1 — System design issues**
- FM-1.1 Disobey task specification (11.8%)
- FM-1.2 Disobey role specification (1.5%)
- FM-1.3 Step repetition (15.7%)
- FM-1.4 Loss of conversation history
- FM-1.5 **Unaware of stopping conditions (12.4%)**

**Category 2 — Inter-agent misalignment**
- FM-2.1 Conversation reset (2.2%)
- FM-2.2 Fail to ask for clarification (6.8%)
- FM-2.3 **Task derailment (7.4%)**
- FM-2.4 Information withholding (0.85%)
- FM-2.5 Ignored other agent's input
- FM-2.6 **Reasoning-action mismatch (13.2%)**

**Category 3 — Task verification**
- FM-3.1 Premature termination
- FM-3.2 **No or incomplete verification (8.2%)**
- FM-3.3 **Incorrect verification (6.2%)**

## Mapping to the caller's RQs

- **RQ3 (scope control):** FM-1.5 (unaware of stopping conditions) + FM-2.3 (task derailment) are the exact
  mechanisms behind figure (1)'s off-objective dispatches.
- **RQ2 (review gates):** the entire "task verification" category, plus the paper's example of a chess program
  passing superficial checks but failing actual gameplay.
- **RQ4 (briefs):** FM-1.1 (disobey task specification) is the **highest-frequency system-design mode** —
  brief-induced failure.
- **RQ1 (cost):** **MAST has no cost/budget failure category.** This is itself a finding: cost overrun is
  under-represented in the leading failure taxonomy, consistent with figure (6)'s cost-blindness being a
  systemic blind spot, not a personal oversight.

## Caveats

- MAST measures *task failure*, not *cost*; it cannot corroborate the caller's dollar figures.
- Mode frequencies are from the paper's own trace sample, not a universal prior.
