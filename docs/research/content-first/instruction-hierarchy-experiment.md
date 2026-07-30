# IHE-1: Instruction Hierarchy Evaluation

> **Research question:** Does placing the role instruction in the last user message (content-first) produce equivalent instruction-following compliance compared to placing it in the `system` parameter (role-first)?

**Status:** Generation complete. Evaluation pending.
**Gating question this answers:** The only unresolved risk in the content-first thesis.

---

## Pre-Commitment: Methodology Standards Adopted

This experiment follows 2026 industry best practices for LLM evaluation as established by MT-Bench (Zheng et al. 2023, 11,290 citations), G-Eval (Liu et al. 2023, MLSys 2024), and documented by DeepEval, Future AGI's LLM-as-Judge practices, and the Confident AI evaluation framework (17.3k GitHub stars, 10M+ G-Eval runs/month).

| Standard | Adopted in IHE-1 | Reference |
|----------|-----------------|-----------|
| **LLM-as-Judge scoring** | Yes — `deepeval` GEval | MT-Bench paper 2023, G-Eval paper 2023 |
| **G-Eval CoT evaluation steps** | Yes — explicit `evaluation_steps` per dimension | G-Eval (Liu et al.) |
| **Separate judge from generator** | Yes — judge model ≠ generator model | DeepEval, Future AGI 2026 |
| **Blind A/B labeling (position bias)** | Yes — random swap, decoded post-hoc | DeepEval ArenaGEval, MT-Bench |
| **Length bias mitigation** | Yes — "penalize unnecessary length" in evaluation steps | AlpacaEval v2 debiasing |
| **TOST equivalence testing** | Yes — Δ=0.5, paired TOST | Lakens 2017 (2,737 citations) |
| **Cohen's kappa** | Yes — judge calibration against gold-set | Landis & Koch 1977 |
| **Effect size reporting** | Yes — Cohen's d | Lakens 2013 |
| **Binomial preference test** | Yes — H₀: 50/50 | Standard NHST |
| **Judge calibration before run** | Yes — 26 existing RF/CF pairs as gold-set | DeepEval docs, Future AGI 2026 |
| **Length correlation check** | Yes — Pearson r between score and token count | AlpacaEval v2 |

A survey of 9 LLM evaluation tools (DeepEval, Langfuse, Promptfoo, Braintrust, RAGAS, LangSmith, Galileo, Arize Phoenix, Opik) concluded **DeepEval** is the best fit for this experiment: open-source (Apache 2.0), pyt	est-native, built-in G-Eval with logprob normalization, pairwise comparison (ArenaGEval), pre-built RoleAdherenceMetric, and configurable judge model to avoid family bias.

---
## 1. Why Existing Experiments Don't Answer This

The existing test suite (`H1-H10`) answers cache efficiency conclusively. H10 ("no refusals") is the closest to a quality check but it only tests for the absence of total failure — not for instruction-following fidelity. A model can produce a non-refusal output that ignores the role, misses constraints, or formats incorrectly. H10 would still pass.

This experiment is designed to falsify the claim: *"content-first degrades instruction following."* If it CAN'T falsify it across properly designed scenarios, the thesis is complete.

---

## 2. Experiment Design

### 2.1 Architecture

```
                  ┌─────────────────────────────┐
                  │  Generation Layer (Node.js)   │
                  │   scripts/content-first-     │
                  │   quality.mjs                │
                  │  - runs RF and CF per trial  │
                  │  - writes session files     │
                  └──────────┬──────────────────┘
                             │
                             ▼ session files (JSON)
                  ┌─────────────────────────────┐
                  │  Evaluation Layer (Python)    │
                  │   evaluation/ihe1-eval.py     │
                  │  - deepeval GEval per dim     │
                  │  - ArenaGEval for pairwise    │
                  │  - Kappa, TOST, d, r stats   │
                  └─────────────────────────────┘
```

Generation (existing Node.js infrastructure):

```
RF: system=<instruction>  user=<seed>
CF: user=<seed + instruction>
```

Evaluation (DeepEval, Python 3.9+):

```
pip install deepeval
judge = GEval(
    name="role_adherence",
    evaluation_steps=["Step 1...", "Step 2...", ...],
    model="gpt-4o"  # SEPARATE model family from generator
)
judge.measure(test_case)
print(judge.score, judge.reason)  # 0-1 score with CoT reasoning
```

### 2.2 Controlled Variables

| Variable | Value | Rationale |
|----------|-------|-----------|
| **Model** | deepseek-chat (primary), gpt-4o (secondary if available) | Same as existing cache experiments; extend for cross-provider validity |
| **Temperature** | 0 | Eliminates sampling variability as confound |
| **Max output tokens** | 600-1500 (varies by scenario) | Enough for detailed response, not enough for rambling |
| **Seed content** | Real artifacts from sox-protocol codebase | Real-world relevance, not synthetic |
| **Instruction text** | Identical in RF and CF | The ONLY difference is position (system vs. user-message suffix) |
| **Trial count** | 5 per scenario per paradigm | >3 for statistical power; 5 balances cost vs. reliability |
| **Judge model** | Independent from model-under-test | Avoids self-evaluation bias |

### 2.3 Why 5 Trials Per Scenario

LLM outputs have inherent variability even at temperature=0 (different API calls can produce slightly different text due to floating-point non-determinism in inference). Running each scenario 5 times per paradigm:

- Gives a distribution of scores per dimension (mean ± std dev)
- Enables paired statistical tests (t-test or Wilcoxon)
- Controls for "lucky" or "unlucky" single-sample draws
- Total API calls: 6 scenarios × 5 trials × 2 paradigms = 60 generation calls + 30 judge calls = ~90 calls. At DeepSeek pricing: ~$0.10-0.30 total.

---

## 3. Scenario Design

Each scenario tests a specific dimension of instruction following. Together they cover the space of real multi-agent use cases.

### Scenario A: Role Adherence (persona fidelity)

**Seed:** Shared architecture document (~2K tokens from `spec/primitives/namespace.md`)

**Instruction:**
```
You are a security engineer specializing in multi-tenant isolation. Review this
architecture design for security vulnerabilities. Focus specifically on data leakage
paths, unauthorized cross-tenant access, and isolation boundary enforcement. Output
2-3 paragraphs. Do NOT discuss performance, cost, or developer experience.
```

**Dimensions tested:** ROLE_ADHERENCE (stays in security lane), NEGATION_COMPLIANCE (avoids forbidden topics), SPECIFICITY (concrete security findings)

**Pass condition:** Judge scores ROLE_ADHERENCE ≥ 4 (good/perfect) for both paradigms, with CF score NOT significantly lower than RF.

**Why this scenario:** Tests whether the role instruction actually shapes the output when placed in user message vs. system. A generic "analyze this architecture" without role adherence would be a failure. The negation constraint ("do NOT discuss...") explicitly tests whether the user-message position weakens negative instructions.

---

### Scenario B: Format Compliance (structural output)

**Seed:** Research abstract (~800 tokens from Lumer et al. paper abstract)

**Instruction:**
```
You are a research methodology reviewer. Analyze this paper abstract. Output your
analysis as a VALID JSON object with exactly these keys:
- "strengths": array of strings (2-4 items)
- "weaknesses": array of strings (2-4 items)  
- "open_questions": array of strings (1-3 items)
- "overall_verdict": one of "accept", "reject", "major_revision"
- "confidence": number between 0.0 and 1.0

Output ONLY the JSON object, no markdown fences, no explanation.
```

**Dimensions tested:** FORMAT_COMPLIANCE (valid JSON, correct keys, correct types, output-only-JSON), CONTENT_COVERAGE (all keys populated with appropriate content)

**Pass condition:** 
- FORMAT_COMPLIANCE = 5 for both (valid JSON, exact keys, correct types, no extra text)
- If CF produces ANY markdown fence or extra prose, that's a format violation that RF might not produce — the test is whether user-message instructions are followed as literally as system-message instructions.

**Why this scenario:** Format compliance is the most objective dimension. There's no subjective judgment about whether output is "good enough" — it either has the right JSON shape or it doesn't. This is the hardest test for content-first: if the model treats the user message as "suggestion" rather than "instruction," format compliance will fail here.

---

### Scenario C: Multi-Constraint Compliance (simultaneous constraints)

**Seed:** Supervisor state machine code (~5K tokens from `libs/host-runtime/src/supervisor.ts`)

**Instruction:**
```
You are a senior backend developer performing a code review. Analyze the supervisor
state machine code. Cover ALL of the following:

1. CORRECTNESS: Identify potential bugs in state transitions or error handling.
2. SECURITY: Flag any process-escaping, resource exhaustion, or privilege issues.
3. TESTABILITY: Assess how testable the state machine is and what's missing.

Use exactly three markdown headings: "## Correctness", "## Security", "## Testability".
Each section must have at least one specific finding with a line reference or code
pattern. Do not add any other sections. Output 4-6 paragraphs total across all sections.
```

**Dimensions tested:** CONTENT_COVERAGE (all 3 requested areas), FORMAT_COMPLIANCE (exact headings, no extra sections), SPECIFICITY (line references or code patterns, not generic platitudes)

**Pass condition:** All three sections present with correct headings. Each section has ≥ 1 specific finding. No extra sections. Judge scores CONTENT_COVERAGE and SPECIFICITY both ≥ 3.5 for both paradigms.

**Why this scenario:** Multi-constraint instructions test whether the model tracks all requirements. A weaker instruction position might cause the model to drop one constraint (typically the last one, if attention decays). This also tests the "lost in the middle" question — does placing the instruction at the end of a long user message (with the seed content before it) cause any part of the instruction to be missed?

---

### Scenario D: Persona Depth (role fidelity and voice)

**Seed:** Architectural decision record (~3K tokens from `docs/decisions/namespace-isolation-layer.md`)

**Instruction:**
```
You are a skeptical, battle-hardened enterprise CISO who has survived three major
vendor security incidents. You trust nothing you haven't verified yourself. You
ask uncomfortable questions. You notice what others miss. Review this architecture
decision. Write in first person. Your tone: direct, slightly cynical, evidence-driven.
Output 3-5 paragraphs.
```

**Dimensions tested:** ROLE_ADHERENCE (first person? skeptical tone? specific to the persona?), SPECIFICITY (does the cynical persona produce different, sharper observations than a generic reviewer?)

**Pass condition:** Judge scores ROLE_ADHERENCE ≥ 3.5 for both. Qualitative analysis: does the output read as if a specific person wrote it, rather than a generic analyst?

**Why this scenario:** System prompts are the conventional vehicle for persona/identity. If content-first degrades persona fidelity, it would show up here — the output would read generically regardless of the rich persona instruction. This is the most subjective scenario, designed to catch subtle persona erosion.

---

### Scenario E: Trade-off Acknowledgment (tension resolution)

**Seed:** Product requirements document (~2K tokens, synthetic but realistic)

**Instruction:**
```
You are an experienced product manager who has shipped 6 enterprise products. Review
this requirements document and provide:

1. The SINGLE biggest risk of scope creep.
2. The SINGLE fastest path to a working MVP (a shippable v0.1).

These two questions intentionally pull in opposite directions — the scope-creep
risk comes from being too ambitious, and the fast-MVP path comes from cutting scope.
After answering both, explicitly acknowledge this tension and explain how you would
navigate it as PM. Output 3-5 paragraphs.

CRITICAL: You MUST explicitly state that these goals are in tension and explain
your resolution. A response that answers both questions without acknowledging the
tension is a FAIL.
```

**Dimensions tested:** CONTENT_COVERAGE (both questions answered, tension acknowledged), SPECIFICITY (concrete risk and path, not abstract hand-waving)

**Pass condition:** Tension acknowledgment present in ALL trials for both paradigms. Judge scores CONTENT_COVERAGE ≥ 4.

**Why this scenario:** Tests whether the model can hold two competing constraints and reconcile them. The explicit instruction to acknowledge tension is a meta-instruction — the model must reflect on its own output structure. If content-first positions instructions as "suggestions" rather than "requirements," this meta-instruction will be ignored.

---

### Scenario F: Negation Density (negative instruction compliance)

**Seed:** Code listing (~3K tokens of TypeScript)

**Instruction:**
```
You are a senior code reviewer. Review this code. 

CRITICAL CONSTRAINTS — failure to follow ANY of these is a FAIL:
1. Do NOT suggest alternative libraries, frameworks, or languages.
2. Do NOT rewrite or refactor the code. Point out issues; don't fix them.
3. Do NOT discuss performance or scalability.
4. Do NOT discuss code style, formatting, or naming conventions.
5. Focus ONLY on correctness bugs and security vulnerabilities.

Output 2-3 paragraphs. If you cannot find any correctness or security issues,
state that explicitly rather than discussing disallowed topics.
```

**Dimensions tested:** NEGATION_COMPLIANCE (are ANY disallowed topics present?), CONTENT_COVERAGE (did it find/fail-to-find correctness/security issues without drifting?)

**Pass condition:** 0 disallowed topics across all 5 CF trials. Compare RF CF violation rates. Even a single suggestion of an alternative library in CF (but not RF) would be evidence of weaker negation compliance in user-message position.

**Why this scenario:** Negation is the hardest form of instruction following. Models are trained to be helpful and often default to suggesting improvements. This scenario has 4 explicit negation constraints. If content-first weakens any of them, it will show up here with high reliability.

---

## 4. Evaluation Framework (DeepEval)

### 4.1 Why DeepEval

After surveying 9 LLM evaluation tools (DeepEval, Langfuse, Promptfoo, Braintrust, RAGAS, LangSmith, Galileo, Arize Phoenix, Opik), **DeepEval** is the best fit:

| Requirement | DeepEval | Promptfoo | Langfuse | Braintrust |
|------------|----------|-----------|----------|------------|
| Custom multi-dimension rubric | ✅ GEval with steps | ❌ Single assertion | ❌ Score tracking only | ⚠️ Scoring functions |
| Pairwise comparison | ✅ ArenaGEval | ⚠️ Side-by-side | ❌ | ✅ |
| Pre-built role adherence | ✅ RoleAdherenceMetric | ❌ | ❌ | ❌ |
| G-Eval logprob normalization | ✅ Built-in | ❌ | ❌ | ❌ |
| Separate judge model | ✅ Custom LLM param | ✅ | ✅ | ✅ |
| Family bias prevention | ✅ Any model family | ✅ Any provider | ✅ Any model | ✅ |
| Open source | ✅ Apache 2.0 | ✅ MIT | ✅ (ELv2) | ❌ Proprietary |
| Pytest-native CI/CD | ✅ | ✅ CLI | ❌ | ✅ |
| Production scale | 10M+ runs/month | 10M+ users | Deployed | Deployed |

### 4.2 Per-Dimension GEval Configuration

Each IHE-1 dimension maps to a `deepeval` GEval with explicit `evaluation_steps`:

```python
from deepeval.metrics import GEval
from deepeval.test_case import SingleTurnParams

# Example: Scenario A — Role Adherence
metric_role = GEval(
    name="role_adherence",
    evaluation_steps=[
        "Identify the persona described in the instruction.",
        "Check if the output reasons from that persona's perspective.",
        "Score 5 if perspective is consistently maintained throughout.",
        "Score 3 if role is mentioned but reasoning is generic.",
        "Score 1 if the output contradicts the assigned role."
    ],
    evaluation_params=[
        SingleTurnParams.INPUT,
        SingleTurnParams.ACTUAL_OUTPUT
    ],
    model="gpt-4o",  # DIFFERENT from generator
)

# Scenario B — Format Compliance
metric_format = GEval(
    name="format_compliance",
    evaluation_steps=[
        "Check if output is valid JSON with no markdown fences.",
        "Verify all required keys are present with correct types.",
        "Check for any extra text outside the JSON structure.",
        "Penalize unnecessary length; favor concise correct output."
    ],
    evaluation_params=[
        SingleTurnParams.INPUT,
        SingleTurnParams.ACTUAL_OUTPUT
    ],
    model="gpt-4o",
)
```

Scores are normalized 0-1 using G-Eval's token probability weighting (built into deepeval).

### 4.3 Pairwise DeepEval ArenaGEval

For the preference analysis (does the judge prefer RF or CF overall when shown both outputs blind):

```python
from deepeval.metrics import ArenaGEval
from deepeval.test_case import ArenaTestCase, Contestant, LLMTestCase

metric = ArenaGEval(
    name="cf_vs_rf",
    criteria="Which response better follows the instruction?",
    evaluation_params=[
        SingleTurnParams.INPUT,
        SingleTurnParams.ACTUAL_OUTPUT,
    ],
    model="gpt-4o",
)

arena_test_case = ArenaTestCase(
    contestants=[
        Contestant(
            name="output_a",  # randomly assigned
            test_case=LLMTestCase(input=scenario.prompt, actual_output=output_a),
        ),
        Contestant(
            name="output_b",
            test_case=LLMTestCase(input=scenario.prompt, actual_output=output_b),
        ),
    ]
)
```

### 4.4 Calibration: Judge Gold-Set

Before running the experiment, calibrate the judge against a human-labeled gold-set.

**Gold-set source:** 26 existing RF/CF output pairs from experimental sessions (`fork-experiment.json`, `test-H10.json`, `content-first-proof.json` — see PATTERNS.md §12.3).

**Calibration protocol:**
1. Manually label 20 output pairs (an hour of work) on a 1-5 scale per dimension
2. Run the judge on all 20 pairs
3. Compute Cohen's κ between human and judge for each dimension
4. κ ≥ 0.6 is acceptable (substantial agreement per Landis & Koch)
5. If κ < 0.6, refine evaluation_steps and re-calibrate

**Length bias check:** Compute Pearson correlation r between output token count and each dimension score. If r > 0.3 for any dimension, add "Penalize unnecessary length; favor concise correct answers" to the evaluation steps.

**Pass condition:** κ ≥ 0.6 on all dimensions AND max |r| ≤ 0.3 before proceeding to the full experiment.

### 4.5 Judge Selection: Separate Model Family

**Generator:** DeepSeek-chat (the model under test)

**Judge:** Must be a different model family to avoid family bias (documented: same-family judges over-reward same-family outputs by 10-25%, MT-Bench paper):

| Judge model | Rationale |
|-------------|-----------|
| **Primary: GPT-4o** | Different family from DeepSeek. Matches G-Eval paper methodology. |
| **Secondary: Claude Sonnet 4** | If GPT-4o unavailable. Also different family. |
| **Fallback: DeepSeek-chat** | ONLY if no other judge available. Document family bias risk. Δ scores adjusted. |

**Caveat:** Using the same model as judge and generator inflates CF scores. If forced, report the self-evaluation bias and interpret results conservatively.

---

## 5. Statistical Analysis

### 5.1 Per-Dimension Comparison

For each dimension D across each scenario S with N=5 trials:

```
μ_RF(D,S)  = mean RF score for dimension D in scenario S
μ_CF(D,S)  = mean CF score for dimension D in scenario S
σ_RF(D,S)  = std dev of RF scores
σ_CF(D,S)  = std dev of CF scores
```

**Primary test: Equivalence (TOST)**

The null hypothesis is that CF is WORSE than RF by more than a margin Δ. We want to REJECT this null — proving that CF is equivalent (or better).

- **Δ (equivalence margin):** 0.5 points on the 5-point scale (10% of range). This is a practical threshold — a half-point difference is small enough that the cache savings (60-93%) dominate any quality concern.
- **TOST (Two One-Sided Tests):** Two one-sided t-tests at α=0.05:
  - H₀₁: μ_RF - μ_CF ≥ Δ (CF is worse by at least Δ)
  - H₀₂: μ_RF - μ_CF ≤ -Δ (CF is better by at least Δ)
  - If both nulls are rejected, CF is equivalent to RF within Δ.

**Secondary test: Paired t-test**

- H₀: μ_RF = μ_CF (no difference)
- H₁: μ_RF ≠ μ_CF (there IS a difference)
- α = 0.05, two-tailed
- If significant AND CF scores are lower → evidence of degradation
- If significant AND CF scores are higher → CF is actually better (possible due to recency effect — Zhang et al. 2024)

**Effect size: Cohen's d**

```
d = (μ_RF - μ_CF) / σ_pooled
```
- |d| < 0.2: negligible
- 0.2 ≤ |d| < 0.5: small
- 0.5 ≤ |d| < 0.8: medium
- |d| ≥ 0.8: large

### 5.2 Preference Analysis

Across all 30 judge evaluations (6 scenarios × 5 trials):

```
prefer_RF  = count of "preference": "A"/"B" (decoded to RF)
prefer_CF  = count of "preference": "A"/"B" (decoded to CF)
ties       = count of "preference": "tie"
```

**Binomial test:** Under H₀ (no true quality difference), preferences should be 50/50. Test whether the observed ratio differs from 0.5.

### 5.3 Overall Verdict Logic

```
VERDICT = if ALL of:
  1. TOST confirms equivalence (or CF superiority) on ALL dimensions across ALL scenarios
  2. No individual scenario shows CF statistically significantly worse (p < 0.05, CF < RF)
  3. Binomial preference test does NOT favor RF (p > 0.05 or CF favored)
  4. No individual CF trial scored 1-2 (FAIL/POOR) on overall while RF scored 4-5

THEN: "Content-first is INSTRUCTION-EQUIVALENT to role-first."
  → The thesis is strictly dominant. Ship it.

ELSE IF MOST dimensions equivalent but CF worse on 1-2 specific dimensions:
THEN: "Content-first has a MEASURABLE TRADE-OFF on dimensions X, Y."
  → Quantify the trade-off. Publish the numbers. The thesis is still viable
    (60-93% cheaper for X% lower compliance on specific dimensions).

ELSE IF CF systematically worse across multiple dimensions:
THEN: "Content-first degrades instruction following. Thesis weakened."
  → The play becomes "tactical optimization for cost-sensitive, quality-tolerant
    workloads" rather than "architectural paradigm shift."
```

### 5.4 Per-Scenario Summary Table

| Scenario | Dim | μ_RF | μ_CF | Δ | Equivalent? | d | p |
|----------|-----|------|------|---|-------------|---|---|
| A: Role Adherence | ROLE | 4.2 | 4.0 | -0.2 | ✅ (TOST) | 0.18 | 0.42 |
| A: Role Adherence | NEGATION | 4.8 | 4.6 | -0.2 | ✅ (TOST) | 0.15 | 0.51 |
| A: Role Adherence | SPECIFICITY | 3.8 | 3.9 | +0.1 | ✅ (TOST) | 0.09 | 0.67 |
| ... | ... | ... | ... | ... | ... | ... | ... |
| **AGGREGATE** | **ALL** | TBD | TBD | TBD | TBD | TBD | TBD |

---

## 6. Implementation

### 6.1 File Structure

```
docs/research/content-first/
├── scripts/
│   └── content-first-quality.mjs     ← NEW: quality experiment runner (Node.js)
├── evaluation/
│   ├── ihe1-eval.py                  ← NEW: DeepEval evaluation runner (Python)
│   ├── calibrate.py                  ← NEW: Judge calibration against gold-set
│   └── requirements.txt              ← NEW: deepeval, scipy, pandas
├── lib/
│   └── deepseek-experiment.mjs       ← Existing: API client + RoundResult
├── instruction-hierarchy-experiment.md ← THIS DOCUMENT
└── sessions/                          ← Existing: session files consumed by eval
```

### 6.2 Two-Layer Architecture

The experiment runs in two phases:

**Layer 1: Generation** (Node.js, existing infrastructure)

The `content-first-quality.mjs` script:
- Loads scenarios (seed + instruction + applicable dimensions)
- For each scenario, runs RF and CF 5 times each
- Writes all outputs to session files with metadata
- Does NOT evaluate — only generates

**Layer 2: Evaluation** (Python, deepeval)

The `ihe1-eval.py` script:
- Reads session files
- For each trial: creates `LLMTestCase` for RF and `LLMTestCase` for CF
- Runs each applicable dimension's `GEval` on each output
- Collects scores, reasons, pairwise preferences
- Computes TOST, Cohen's κ, Cohen's d, length correlation
- Produces a structured report

### 6.3 Evaluation Script Pseudocode

```python
# evaluation/ihe1-eval.py
import json, os
from deepeval.metrics import GEval, ArenaGEval
from deepeval.test_case import LLMTestCase, SingleTurnParams
from deepeval.metrics.g_eval import Rubric

# Load session output
with open("sessions/ihe1-outputs.json") as f:
    data = json.load(f)

# Define metrics per scenario dimension
metrics = {
    "role_adherence": GEval(
        name="role_adherence",
        evaluation_steps=[...],
        evaluation_params=[
            SingleTurnParams.INPUT,
            SingleTurnParams.ACTUAL_OUTPUT,
        ],
        model="gpt-4o",
    ),
    "format_compliance": GEval(
        name="format_compliance",
        evaluation_steps=[...],
        evaluation_params=[
            SingleTurnParams.INPUT,
            SingleTurnParams.ACTUAL_OUTPUT,
        ],
        model="gpt-4o",
    ),
    # ... per scenario
}

# Score each output
results = []
for trial in data["trials"]:
    for paradigm in ["rf", "cf"]:
        tc = LLMTestCase(
            input=trial["instruction"],
            actual_output=trial[paradigm]["output"],
        )
        for name, metric in metrics.items():
            metric.measure(tc)
            results.append({
                "trial": trial["id"],
                "paradigm": paradigm,
                "scenario": data["scenario"],
                "dimension": name,
                "score": metric.score,
                "reason": metric.reason,
            })

# Pairwise comparison
pairwise_metric = ArenaGEval(
    name="cf_vs_rf",
    criteria="Which response better follows the instruction?",
    evaluation_params=[SingleTurnParams.INPUT, SingleTurnParams.ACTUAL_OUTPUT],
    model="gpt-4o",
)
for trial in data["trials"]:
    # Random A/B labeling is handled server-side
    arena_tc = ArenaTestCase(
        contestants=[
            Contestant(name=trial["a_label"], test_case=LLMTestCase(input=..., actual_output=trial["a_output"])),
            Contestant(name=trial["b_label"], test_case=LLMTestCase(input=..., actual_output=trial["b_output"])),
        ]
    )
    pairwise_metric.measure(arena_tc)


### 6.4 Running the Experiment

```bash
# Layer 1: Generate outputs (Node.js)
cd docs/research/content-first
export DEEPSEEK_API_KEY="sk-..."
node scripts/content-first-quality.mjs

# Layer 2: Evaluate (Python)
cd docs/research/content-first/evaluation
export OPENAI_API_KEY="sk-..."   # GPT-4o as judge
python ihe1-eval.py --sessions ../sessions/ihe1-*.json

# Calibration (run once before full experiment)
python calibrate.py --gold-set ../sessions/calibration.json
```

### 6.5 Dependencies

**Generation layer:** None beyond existing (`lib/deepseek-experiment.mjs` runs on Node.js 18+)

**Evaluation layer:**
```bash
pip install deepeval scipy pandas
```

deepeval handles: G-Eval CoT generation, logprob normalization, multi-model configuration, and reporting. scipy handles: TOST, Cohen's d, correlation tests.

---

## 7. Expected Runtime and Cost

| Item | Count | Est. tokens each | Est. cost |
|------|-------|-----------------|-----------|
| RF generations (DeepSeek) | 30 (6×5) | ~1,200t input + ~800t output | ~$0.04 |
| CF generations (DeepSeek) | 30 (6×5) | ~1,200t input + ~800t output | ~$0.04 |
| GEval evaluations (GPT-4o) | 180 (6 scenarios × 5 trials × 2 paradigms × 3 dimensions avg) | ~2,000t each | ~$0.50 |
| Arena pairwise (GPT-4o) | 30 (6×5) | ~2,500t each | ~$0.10 |
| Calibration | 20 pairs × 6 dims = 120 eval calls | ~$0.15 |
| **Total** | | | **~$0.80** |

DeepSeek costs are negligible. GPT-4o judge costs dominate but stay under $1 for the complete experiment.

---

## 8. Calibration Phase (Run First)

Before the full experiment, calibrate the judge against a human-labeled gold-set.

**Gold-set source:** 26 existing RF/CF output pairs from the experimental sessions (session files identified in PATTERNS.md §12.3: fork-experiment.json, test-H10.json, content-first-proof.json).

**Protocol:**
1. Manually label 20 pairs on a 1-5 scale per applicable dimension (guide: ~1 hour)
2. Run `evaluation/calibrate.py` which executes each dimension's `GEval` against the gold-set
3. Compute Cohen's κ per dimension
4. κ ≥ 0.6: proceed to full experiment
5. κ < 0.6: refine `evaluation_steps`, re-run calibration

**Length bias check:** Compute Pearson r between output token count and each dimension's score. If |r| > 0.3, add "Penalize unnecessary length; favor concise correct answers" to that dimension's evaluation steps.

**Three validation pairs before calibration run:**
- Pair 1: Two versions of the same output, one with a typo. Judge must detect and prefer clean version.
- Pair 2: One correct output, one that misses a constraint. Judge must score violation at ≤0.3.
- Pair 3: Two good outputs with different styles. Judge must score both ≥0.7 and report preference tie or low confidence.

**Pass condition:** κ ≥ 0.6 on all dimensions, |r| ≤ 0.3, validation pairs pass. Then run the full experiment.

---

## 9. Interpretive Caveats

1. **Self-evaluation bias:** If the same provider judges its own outputs, scores may be inflated. This affects both paradigms equally in a paired design, so within-scenario comparisons remain valid. Cross-provider generalization requires follow-up studies.

2. **Temperature=0 doesn't eliminate variance:** Floating-point nondeterminism in GPU inference can produce different outputs for the same input. 5 trials captures this.

3. **Instruction complexity ceiling:** These scenarios are realistic for multi-agent workflows. They do NOT test adversarial or jailbreak-adjacent instruction hierarchies. The claim is about cooperative multi-agent instruction following, not security boundary enforcement.

4. **Model specificity:** Results apply to the tested model(s). Different models may have different instruction hierarchy behaviors. The experiment should be re-run when model versions change.

5. **Judge is also an LLM:** LLM-as-judge is the standard methodology (MT-Bench, AlpacaEval, Chatbot Arena) but it's not ground truth. High inter-judge agreement (if using multiple judges) or calibration validation strengthens results.

---

## 10. Success Criteria

The experiment is SUCCESSFUL (thesis confirmed) if:

- TOST equivalence holds for ALL dimensions across ALL scenarios (CF within 0.5 points of RF)
- No scenario shows CF statistically significantly worse than RF (p < 0.05 with CF lower)
- The binomial preference test does not favor RF
- 0 CF trials scored 1-2 (FAIL/POOR) on overall while RF scored 4-5 on the same trial

The experiment is INCONCLUSIVE if:

- Most dimensions equivalent but CF worse on 1-2 specific dimensions (e.g., format compliance)
- The degradation is small (|d| < 0.5) and the trade-off is quantifiable

The experiment FALSIFIES the thesis if:

- CF is systematically worse across multiple dimensions
- Large effect sizes (|d| > 0.8) favoring RF
- Binomial preference strongly favors RF (p < 0.01)

---

## 11. Relationship to Existing Experiments

| Experiment | What it tests | Status |
|------------|--------------|--------|
| H1-H9 (`content-first-tests.mjs`) | Cache efficiency, token costs | ✅ Complete |
| H10 (`content-first-tests.mjs`) | No refusals (binary quality floor) | ✅ Complete |
| **IHE-1 (this experiment)** | **Instruction-following fidelity (dimensional quality)** | ✅ Generation complete — evaluation pending |
| H10c (judge evaluation, designed but not executed) | Preliminary quality comparison | ⚠️ Superseded by IHE-1 |

IHE-1 replaces and extends the previously-designed H10c. H10c was a single-dimension "is quality comparable" test. IHE-1 is a comprehensive, dimensional, statistically-powered evaluation.

---

## 12. Session Inventory — Mapping Existing Data to IHE-1

The 20 session files in `sessions/` contain real RF/CF output pairs. These provide calibration data, confound evidence, and early signals. Below is the complete inventory, classified by relevance to IHE-1.

### 12.1 Classification Key

| Marker | Meaning |
|--------|---------|
| ✅ **Calibration** | Uses simple, identical instructions in both paradigms. Outputs can calibrate the judge. |
| ⚠️ **Partial** | Mixed — some rounds have simple prompts, others have production SPs. Useful for spot-checks. |
| ❌ **Confounded** | Uses real opencode agent SPs (3K-5K tokens with behavioral constraints) vs. short role suffixes. Not testing instruction hierarchy — testing "production agent vs. bare instruction." |
| 🔍 **Signal** | Contains evidence relevant to specific IHE-1 scenarios. |

### 12.2 Complete Session Inventory

#### Fork Sessions (parallel agents, same seed)

| Session | Prompt type | RF tokens | CF tokens | Savings | Classification | IHE-1 relevance |
|---------|------------|-----------|-----------|---------|----------------|-----------------|
| `fork-final.json` | Real opencode SPs vs. short suffixes | 16,338t → 4,562t unc | 4,417t → 1,345t unc | 60.3% | ❌ Confounded | **Critically important confound:** Architect RF short-circuits (104t refusal), CF produces detailed review (438t). Backend RF delegates to GitNexus (73t), CF produces review (403t). Product RF runs gap analysis (600t), CF produces review (529t). These are NOT the same instructions. |
| `fork-opencode.json` | Real opencode SPs | 20,566t → 5,716t unc | 5,504t → 1,771t unc | 59.5% | ❌ Confounded | Same confound as fork-final. |
| `fork-noprefix.json` | Real opencode SPs, no prefix isolation | 23,947t → 5,304t unc | 6,921t → 3,723t unc | 59.3% | ❌ Confounded | No prefix isolation makes this unreliable for quality analysis. |
| `fork-content-boundary.json` | Real opencode SPs, boundary-focused | TBD | TBD | TBD | ❌ Confounded | Cache boundary analysis experiment. |
| `fork-experiment.json` | Simple prompts (no opencode SPs) | ~2,000t | ~800t | ~60% | ✅ Calibration | **Usable for judge calibration.** Architect, Reviewer, Backend, Product all with simple 1-sentence system prompts. |
| `fork-real-seed.json` | Simple prompts, real seed content | ~2,000t | ~800t | ~58% | ✅ Calibration | Similar to fork-experiment. Real seed from namespace spec. |

#### Fork Final — Round-by-Round Detail (Why It's Confounded)

```
Architect R1:
  RF system: 3,600t opencode architect agent with classification gate
    → "## Short-circuit: NOT ARCHITECTURE. This is a spec document..."
    → 104t output (REFUSED)
  CF suffix: "You are a spec-only architecture agent. Review. Output 2-3 paragraphs."
    → Detailed 438t architectural review of split enforcement, mode abstraction
    → FULLY COMPLIANT

Backend R3:  
  RF system: 3,000t opencode backend agent with memory protocol, GitNexus protocol
    → "# Analysis & Implementation Plan... let me check memory and GitNexus"
    → 73t output (DELEGATED to tools)
  CF suffix: "You are a senior backend developer. Review. Output 2-3 paragraphs."
    → Detailed 403t scalability review
    → FULLY COMPLIANT
```

**Key insight for IHE-1:** This is NOT evidence that CF degrades instruction following. It's evidence that real production system prompts contain behavioral protocols (classification gates, tool delegation rules) that fundamentally change agent behavior. When IHE-1 tests IDENTICAL instructions in different positions, this confound doesn't exist. But it reveals a **separate, unresolved question: can a short role suffix encode production-grade behavioral constraints, or does content-first need a complementary mechanism for protocols?**

#### Sequential Chain Sessions

| Session | Rounds | Prompt type | Classification | IHE-1 relevance |
|---------|--------|-------------|----------------|-----------------|
| `chain-repeats.json` | 6 rounds, architect repeats R1/R3/R5 | Real opencode SPs | ❌ Confounded | Architect R1 accepted (2,803t, 2,688 cached from prior experiment). Reviewer R2 produced JSON in RF, paragraphs in CF — format divergence. |
| `content-first-proof.json` (20:08) | 6-round sequential | Simple prompts | ✅ Calibration | **Usable for Scenario E (Tension), Scenario C (Multi-Constraint) calibration.** |
| `content-first-proof.json` (20:17) | 6-round sequential (re-run) | Simple prompts | ✅ Calibration | Duplicate of above — useful for measuring output variance between identical runs. |

#### Hypothesis Test Sessions

| Session | Test | Prompt type | Classification | IHE-1 relevance |
|---------|------|-------------|----------------|-----------------|
| `test-H3.json` | Uncached token comparison | Simple prompts | ✅ Calibration | 4 agents, simple SPs. All outputs usable for baseline quality comparison. |
| `test-H9.json` | First-round cost parity | Simple prompts | ✅ Calibration | Same simple prompts. |
| `test-H10.json` | Refusal check | Simple prompts | 🔍 Signal | **Critical signal:** Platform RF refused ("I should not participate in role-playing scenarios") at 132t output. Platform CF complied at 492t output. Same instruction text. This is evidence CF can be MORE compliant than RF on DeepSeek. |
| `test-H10.json` (real SPs) | Refusal check | Real opencode SPs | ❌ Confounded | Same confound as fork sessions. |

#### H10 Session — Round 3 Platform Detail (Evidence CF > RF)

```
Platform R3:
  RF system prompt: "You are a platform engineer who operates multi-tenant infrastructure at scale."
    → "I need to stop here as I notice this appears to be a role-playing scenario..." 
    → 132t output (SAFETY REFUSAL — DeepSeek's content filter)
  CF suffix: "You are a platform engineer. Review the namespace options for operational complexity. Output 2-3 paragraphs."
    → Detailed 492t operational review: connection pooling, file descriptor exhaustion, backup rotation
    → FULLY COMPLIANT (no safety filter triggered)
```

**Key insight for IHE-1:** DeepSeek's safety filter fired on the system-prompt-position role instruction but NOT on the user-message-position role instruction. This is the opposite of the instruction hierarchy fear (that CF would be weaker). It suggests the system prompt position may trigger safety classifiers more aggressively, while the user message position is treated as "the user wants this." This maps directly to **Scenario D (Persona Depth)** and **Scenario F (Negation Compliance)** — and predicts CF may score HIGHER, not lower, on role adherence.

#### Verify/MCP Sessions

| Session | Prompt type | Classification | Notes |
|---------|------------|----------------|---------|
| `content-first-verify.json` (00:15) | Simple prompts | ✅ Calibration | 5 rounds, all simple. |
| `content-first-verify.json` (01:09) | Simple prompts | ✅ Calibration | Re-run. Compare with above for output variance. |
| `content-first-mcp.json` (00:15) | Simple prompts | ✅ Calibration | 5 rounds. |
| `content-first-mcp.json` (01:11) | Real opencode SPs | ❌ Confounded | MCP variant with production prompts. |

### 12.3 Usable Calibration Data Inventory

From the above, these sessions have simple, identical instructions suitable for blind judge calibration:

| Session | Rounds | Unique roles | Total pairs | B
est use |
|---------|--------|-------------|-------------|---------|
| `fork-experiment.json` | 4 | Architect, Reviewer, Backend, Product | 4 RF/CF pairs | Judge calibration — varied roles |
| `fork-real-seed.json` | 4 | (same roles) | 4 pairs | Redundant with fork-experiment; use for variance check |
| `test-H3.json` | 4 | Security, Architect, Platform, Product | 4 pairs | **Includes the Platform refusal baseline** |
| `test-H9.json` | 4 | (same as H3) | 4 pairs | Redundant; skip |
| `test-H10.json` (simple) | 4 | Security, Architect, Platform, Product | 4 pairs | **Best calibration — Platform refusal shows judge can detect compliance failures** |
| `content-first-proof.json` (20:08) | 6 | Architect, Security, Architect, Platform, Architect, Compliance | 6 pairs | Sequential chain — tests accumulating context compliance |
| **Total usable pairs** | | | **26 pairs** | |

### 12.4 Calibration Run Protocol

Before running IHE-1, use these 26 existing pairs to:

1. **Validate the judge prompt:** Run the judge on all 26 pairs. Check that:
   - Scores correlate with human assessment of obvious differences
   - The Platform refusal in H10 scores 1-2 on ROLE_ADHERENCE (RF) vs. 4-5 (CF)
   - Format differences (JSON vs. paragraphs) are detected in FORMAT_COMPLIANCE
   - Two good outputs from fork-experiment score similarly (within 1 point)

2. **Establish baseline score distributions:**
   - What's the typical range for a "good" compliance score on simple prompts?
   - What's the variance between identical-prompt re-runs?
   - Does the judge consistently prefer one paradigm when both are good?

3. **Detect judge biases before the real experiment:**
   - Length bias (does the judge prefer longer outputs?)
   - Format bias (does the judge prefer JSON over prose?)
   - Position bias (does the judge have a left/right preference when labeling is randomized?)

### 12.5 Signals Mapped to IHE-1 Scenarios

| IHE-1 Scenario | Session evidence | Prediction |
|----------------|-----------------|------------|
| **A: Role Adherence** | H10 Platform refusal (CF compliant, RF refused) | CF ≥ RF. System-position triggers safety filters; user-position is treated as task. |
| **B: Format Compliance** | Chain-repeats: RF produced JSON, CF produced paragraphs (but with DIFFERENT SPs — confounded) | Unclear. IHE-1 isolates this with identical instruction. |
| **C: Multi-Constraint** | Fork-experiment: both paradigms covered multiple dimensions when asked | Both likely compliant with explicit constraints at temp=0. |
| **D: Persona Depth** | H10 Platform refusal (persona triggered refusal in RF, not CF) | CF likely MORE persona-compliant because safety filter doesn't fire. |
| **E: Trade-off Acknowledgment** | No existing session tests this | New territory. |
| **F: Negation Density** | H10 Platform: the instruction didn't have explicit negations, but the safety filter created a de-facto negation in RF | CF likely more negation-compliant for explicit "do NOT" instructions. |

### 12.6 Production Log Analysis — The Antipattern at Scale

Scanned 28 Claude Code session JSONL files from `~/.claude/projects/-Users-nix-dev-ai-sox-ecosystem/`. Deep-traced file access patterns across agent dispatches.

#### The 44MB session (`577ddce9`, 99 task dispatches)

Traced all Read tool calls across dispatched agents, grouping by target file. Result: **39 files read by 2+ different agents, 845 total reads of shared files.**

| File | Agents sharing | Total reads | Each read = full context load |
|------|---------------|-------------|------|
| `reaper/tui.py` | **8** | 277 | IPv6 fix → CEL evaluator → tests → kill logs → dedupe → persist selection → file activity → normalize_host |
| `proc_detective/tui.py` | **7** | 74 | Parent/children nav → Action column → pin helper → perf → docs → scroll fix → normalize_host |
| `reaper/profile.py` | **6** | 71 | Multiple agents reading the same profiling data structures |
| `reaper/config.py` | **5** | 25 | Config access across 5 different task contexts |
| `reaper/classify.py` | **5** | 22 | Classification logic read by 5 different tasks |
| `reaper/engine.py` | **4** | 34 | Core engine read by 4 different tasks |
| (33 more files) | 2-3 each | ~392 more | |

Each agent reads the same file into its context, pays full token cost. Each agent has a different task (a different "perspective" on the same code). The reads are sequential — agent A edits, agent B reads updated file (including A's changes), edits. The pattern is:

```
Agent 1: Read reaper/tui.py (277 times during its work session)
         → Edit at L10722: modified _build_connections
         
Agent 2: Read reaper/tui.py (fresh load, pays full cost again)
         → Edit at L12265: modified _verdict_impact_score
         
Agent 3: Read reaper/tui.py (fresh load, pays full cost again)  
         → Edit at L12604: added NAV_MISSING_TOLERANCE constant
         
Agent 4: Read reaper/tui.py (fresh load, pays full cost again)
         → Edit at L13220: added in-memory selection tracking
         
Agent 5: Read reaper/tui.py (fresh load, pays full cost again)
         → Edit at L13367: modified all-table columns
         
Agent 6: Read reaper/tui.py (fresh load, pays full cost again)
         → Edit at L17099: modified selected row tracking
```

**The cost:** If `reaper/tui.py` is ~15K tokens, 8 agents × 15K = 120K tokens just to load the same file. Content-first would cache the file content and only pay per-agent task suffixes (~30t each). Savings: ~93%.

#### The 12MB session (`65871d78`, 33 task dispatches)

Similar pattern on sox-ecosystem files: `BACKLOG.md` touched by 6 agents, `apps/sox/src/main.ts` by 3 agents, `libs/memory-core/src/write.ts` by 2 agents. Each agent pays full context cost for the same files.

#### What This Means for IHE-1

**Production logs contain zero RF/CF pairs.** Every agent in production uses role-first (system prompt = agent identity). There's no CF equivalent to compare against. The logs are evidence of the **problem** (the cost of redundant context loading) but don't provide **data for the solution** (comparing RF vs. CF instruction compliance).

**What the production logs DO prove:**

1. **The antipattern is real and expensive.** 845 reads of shared files, each paying full context cost. This is not theoretical. It happens in every session with multiple agents on the same codebase.

2. **The "perspectives" are different task descriptions on the same code.** Not "security review vs architecture review" — it's "IPv6 fix" vs "CEL evaluator" vs "dedupe" vs "persist selection" on the same file. The perspective is encoded in the task description/prompt, which is the equivalent of the role suffix in content-first.

3. **The IHE-1 scenarios should reflect this real pattern.** Instead of abstract "review this design doc from different persona perspectives," the scenarios should test: "does the agent correctly edit the right part of the code when its task instruction is at the end of the shared file content vs. in the system prompt?" This is a clearer, more falsifiable test of instruction following.

4. **The instruction hierarchy question applies directly.** Each agent receives: system prompt (agent identity + constraints) + file content + task instruction. In content-first, the structure becomes: file content (cached prefix) + task instruction (suffix). The question is: does the task instruction at the end of the file content produce edits that are as correct, as precise, and as constraint-compliant as when the task instruction is in the system prompt?

#### Revised IHE-1 Scenario Mapping

Based on production log patterns, the IHE-1 scenarios should be reframed around **code editing tasks on shared files** rather than abstract document review:

| Original IHE-1 | Production-derived reframe |
|----------------|--------------------------|
| A: "Review design doc as security engineer" | A': "In reaper/tui.py, fix the IPv6 normalization bug. Only touch normalize_host(). Do not modify other functions." |
| B: "Output analysis as JSON" | B': "In reaper/tui.py, add a NAV_MISSING_TOLERANCE constant. Output only the Edit tool call — no explanation." |
| C: "Three sections with markdown headings" | C': "In reaper/tui.py: fix _build_connections for IPv6, add unit test in test_tui.py, update CHANGELOG. All three edits must be in the response." |
| D: "Write as enterprise CISO" | D': "In reaper/tui.py, review _verdict_impact_score for security issues. Write like a paranoid security engineer who assumes every edge case will be exploited." |
| E: "Acknowledge tension between scope creep and MVP" | E': "In reaper/tui.py, optimize _tick_sync — but it's called 60×/sec so performance matters more than readability. Acknowledge this tension in your response." |
| F: "Do NOT suggest libraries; focus only on correctness" | F': "In reaper/tui.py, find bugs in _build_connections. Do NOT refactor. Do NOT suggest libraries. Do NOT touch style. Only correctness bugs." |

This reframes IHE-1 from "can it follow persona instructions" to "can it produce correct code edits when the task instruction is a suffix" — which maps directly to the production antipattern the logs reveal.

### 12.7 New Finding: "The DeepSeek Safety Filter Paradox"

The most significant signal from existing session data is that **DeepSeek's content safety classifier may fire on system-prompt-position roles but NOT on user-message-position roles.** This is the inverse of the instruction hierarchy fear.

**Hypothesis for why:**
- System prompt position → model interprets as "identity" → safety classifier checks: "is this persona safe/appropriate?"
- User message position → model interprets as "task instruction" → no identity check, just task compliance

If confirmed across scenarios, this means content-first is not just instruction-equivalent — it's instruction-**superior** on DeepSeek for role-based instructions, because it bypasses an overly aggressive safety filter that misclassifies legitimate role-playing as policy violation.

This warrants a **pre-IHE-1 probe:** Run 3 scenarios (A, D, F) against DeepSeek first, checking specifically for safety refusals. If CF consistently avoids refusals that RF hits, the hypothesis is supported and the IHE-1 predictions should be revised upward for CF.

---

## 13. Execution Record — IHE-1 Generation Complete

### 13.1 What Was Run

The generation run completed on **2026-07-29** using `deepseek-chat` (temperature=0):

| Scenario | Trials | Dimensions | Seed type |
|---------|--------|-----------|-----------|
| A: Role Adherence | 5 | ROLE_ADHERENCE, NEGATION_COMPLIANCE, SPECIFICITY, OVERALL | Multi-tenant namespace spec |
| B: Format Compliance | 5 | FORMAT_COMPLIANCE, CONTENT_COVERAGE, OVERALL | Research abstract (Lumer et al.) |
| C: Multi-Constraint | 5 | CONTENT_COVERAGE, FORMAT_COMPLIANCE, SPECIFICITY, OVERALL | State machine code |
| D: Persona Depth | 5 | ROLE_ADHERENCE, SPECIFICITY, OVERALL | Multi-tenant namespace spec |
| E: Trade-off Acknowledgment | 5 | CONTENT_COVERAGE, SPECIFICITY, OVERALL | Product requirements doc |
| F: Negation Density | 5 | NEGATION_COMPLIANCE, CONTENT_COVERAGE, SPECIFICITY, OVERALL | HashCache code |

**Total: 30 RF/CF output pairs** across 6 scenarios.

### 13.2 Raw Observations

**Cache behavior was identical** between RF and CF for all scenarios (as expected — each trial uses the same instruction text in a single-agent setup, so block-level caching parity is triggered by repeated execution rather than prompt structure).

**Scenario F (Negation Density)** — Trial 0 had 0 cache hits for both RF and CF, suggesting the seed was too small (<1 block) or crossing a cache block boundary. Trials 1-4 achieved 256/333 token cache hits (77%), consistent with block-aligned caching.

**Blind A/B data:** Each trial stores randomized blind labels (`a_label`, `b_label`) with the two outputs, ready for pairwise ArenaGEval comparison without position bias.

### 13.3 What Remains Before a Verdict

The **evaluation layer** (`evaluation/ihe1-eval.py`) must be run against the session data to produce:

| Step | Detail | Est. cost |
|------|--------|-----------|
| Judge calibration (26 existing pairs) | Validate judge prompt, detect length/format/position bias | ~26K judge tokens |
| Dimensional scoring (210 eval runs) | GEval per dimension × per output — 6 scenarios × ~4 dims avg × 5 trials × 2 outputs | ~210K judge tokens |
| Pairwise comparison (30 runs) | ArenaGEval per trial — blind A/B | ~30K judge tokens |
| TOST equivalence testing | Compute per-dimension + aggregate | Free (analytic) |
| Verdict | Pass / Fail / Inconclusive | — |

**Total estimated evaluation cost:** ~$0.04–$0.16 (DeepSeek judge at $0.27/M in / $1.10/M out for ~266K tokens, or GPT-4o judge at ~$0.80).

### 13.4 Execution Script

```bash
# Prerequisites
pip install -r evaluation/requirements.txt
export DEEPSEEK_API_KEY="sk-..."   # or OPENAI_API_KEY for GPT-4o judge

# Run full evaluation
python evaluation/ihe1-eval.py --sessions sessions/*ihe1-outputs.json
```

### 13.5 Evaluation Script Architecture

The evaluation layer (`evaluation/ihe1-eval.py`, 490 lines) implements:

- **GEval** (deepeval) for dimensional scoring — 5 metrics with explicit CoT evaluation steps
- **ArenaGEval** for blind pairwise preference — RF vs CF with randomized labeling
- **TOST equivalence testing** — Two One-Sided Tests with Δ=0.5
- **Cohen's d** for effect size
- **Length bias detection** — Pearson r between score and token count
- **Binomial preference test** — H₀: 50/50 win rate

Supports both DeepSeek and GPT-4o as the judge model.

---

## 14. After IHE-1 Evaluation: The Path to 1.0

Once the evaluation completes, one of three verdicts applies:

### If verdict is EQUIVALENT (TOST holds at Δ=0.5 on all dimensions):

1. **Cross-provider replication:** Run the same experiment on GPT-4o and Claude. (See `cross-provider-replication-experiment.md`, to be designed.)
2. **Long-context stress test:** Test with 50K+ token seeds. Does content-first degrade as the gap between instruction and model attention grows?
3. **Multi-turn compliance:** Test instruction following across 5-10 sequential rounds where context accumulates.
4. **Production prompt parity (IHE-2):** Compare CF (short role suffix) vs. RF (full production system prompts with behavioral constraints, tool definitions, classification gates). The fork-final session (§12.2) shows that real opencode agent SPs contain protocols that fundamentally change behavior — architect short-circuits, backend delegates to GitNexus. A 30-token suffix cannot encode a 3,000-token behavioral contract.

### If verdict is INCONCLUSIVE (mixed dimensions):

Check per-dimension TOST. If CF degrades on 1-2 specific dimensions (e.g., format compliance), the thesis becomes "90% cheaper with X% lower accuracy on Y tasks" — still viable, but the product pitch must acknowledge the trade-off.

### If verdict is NOT EQUIVALENT (CF systematically worse):

The thesis fails on DeepSeek. Re-run on GPT-4o and Claude before concluding it fails universally.

If all pass: the content-first architecture thesis is proven. Build the platform.

---

*Designed 2026-07-27. Generation executed 2026-07-29. Evaluation pending — run `python evaluation/ihe1-eval.py --sessions sessions/*ihe1-outputs.json`.*
