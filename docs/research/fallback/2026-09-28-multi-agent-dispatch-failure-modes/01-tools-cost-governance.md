---
name: "Agent cost attribution & budget enforcement — tooling catalog"
topic: "tool-catalog"
tags: ["agent:approved", "cost-governance", "observability", "budget", "opentelemetry"]
summary: "Per-dispatch cost visibility at decision time is served by (1) OpenTelemetry GenAI semantic conventions — the standard attribute vocabulary for token-usage spans; (2) OTel-based tracers (Langfuse) for attribution; (3) LLM gateways with key-level budgets/auto-routing (LiteLLM, Vercel AI Gateway) for ceilings. The category is real and tooled; most purpose-built 'budget guard' packages are small. Recommended substrate: OTel GenAI spans + a gateway budget, not a bespoke counter."
importance: 7
data_quality: "estimated"
---

# Finding (RQ1 — decision-time spend visibility)

**The phenomenon is established; the standard substrate exists.** Cost is made visible at decision time by
attaching token/usage attributes to per-unit spans and enforcing a ceiling at a gateway, not by a bespoke
in-process counter.

## The standard substrate — per-unit cost attribution

- **OpenTelemetry GenAI semantic conventions** are the canonical attribute vocabulary for LLM/agent spans
  (`gen_ai.*` token-usage attributes; dedicated `gen-ai-spans`, `gen-ai-agent-spans`, `gen-ai-metrics`,
  and MCP attributes). Verified live: the semconv page resolves (HTTP 200) and now points to a dedicated repo
  `github.com/open-telemetry/semantic-conventions-genai`. **Grade A** (open standard / spec).
  → A "per-dispatch cost attribution" requirement is a request for exactly this plumbing (one span per
  dispatch, usage attributes on it), not a novel mechanism.

- **Langfuse** — OTel-based tracing with cost/token tracking; published as `@langfuse/tracing` (npm
  `5.11.1`, observed via live registry search). **Grade B-primary** (product docs).

## Ceilings & routing at the gateway

- **LiteLLM** — OSS LLM gateway with keys/budgets and an "Auto Router"; docs site verified live (HTTP 200).
  **Grade B-primary**. (Specific budget page not fetched; the specific enforcement semantics are
  MEDIUM-confidence.)
- **Vercel AI Gateway** — documented framing (via search, **Grade C**): *"Budgets defend a ceiling. Routing
  and caching lower the floor, so the ceiling gets hit less often."* — the clearest one-line statement of the
  two complementary mechanisms.
- **Purpose-built budget guards on PyPI** (existence signal, mostly minor packages): `llm-budget`,
  `llm-budget-guard`, `llm-budget-proxy`, `llm-cost-guard`, `llm-cost-guardian`, `litellm-cost-tracker`,
  `llm-spend-tracker`, `tokenbudget`, `orchestra-llm-cost`, `claude-code-llm-router` (all observed live in
  PyPI search). **Grade C** (existence only; not download-vetted — do not recommend individually).

## Model-tier routing (the cost lever that matters most)

- **FrugalGPT** (Chen, Zaharia, Zou; arXiv:2305.05176, 2023) — heterogeneous LLM API fees "differ by two
  orders of magnitude"; a learned **LLM cascade** "can match the performance of the best individual LLM
  (e.g. GPT-4) with **up to 98% cost reduction**, or improve accuracy over GPT-4 by 4% at the same cost."
  **Grade B** (preprint, very widely cited). → Tier routing by task class is a ~2-orders-of-magnitude lever,
  not a rounding error.

## What this means for the caller's figures (6) and (2)

Fig (6) — *telemetry carried no $ or token figures* — is the textbook anti-pattern this tooling exists to
prevent: absence of the standard span attributes forces post-hoc guessing. Fig (2) — *a model tier set
against the spec default* — is the exact FrugalGPT lever (tier choice dominates spend).

## Weaknesses / what this does NOT settle

- None of these tools *force* a decision-time abort at a per-water per-wave granularity; per-wave budget
  semantics are an orchestration-design concern, not something the OTel/gateway layer provides out of the box.
- The PyPI budget packages are unvetted; recommending any specific one would be over-reach.
