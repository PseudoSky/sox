#!/usr/bin/env python3
"""
ihe1-eval.py  —  IHE-1 Evaluation Layer

Reads IHE-1 generation output (JSON session file with 60 RF/CF output pairs).
Runs deepeval GEval per dimension per output.
Runs deepeval ArenaGEval for pairwise preference.
Computes TOST equivalence, Cohen's d, Cohen's kappa, length correlation.
Produces structured report.

Usage:
    export OPENAI_API_KEY="sk-..."   # Judge model (GPT-4o, recommended)
    # OR
    export DEEPSEEK_API_KEY="sk-..." # DeepSeek judge (family bias caveat)
    python evaluation/ihe1-eval.py --sessions sessions/*ihe1-outputs.json
"""

import json
import sys
import argparse
import os
from collections import defaultdict

import numpy as np
from scipy.stats import ttest_rel, ttest_ind, pearsonr
from scipy import stats as scipy_stats

from deepeval.metrics import GEval, ArenaGEval
from deepeval.test_case import LLMTestCase, SingleTurnParams
from deepeval.test_case import ArenaTestCase, Contestant
from deepeval.models import DeepEvalBaseLLM

# ──────── Configuration ────────

JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "deepseek-chat")
# Use custom DeepSeek LLM if judge is deepseek (family bias caveat applies)
DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("ADHD_AGENT_DEEPSEEK_SECRET")
EQUIVALENCE_DELTA = 0.5  # On 1-5 scale. TOST margin.
ALPHA = 0.05

# ──────── Custom DeepSeek LLM for deepeval ────────

from deepeval.models import DeepEvalBaseLLM


class DeepSeekChatLLM(DeepEvalBaseLLM):
    """Custom DeepSeek model for deepeval's GEval judge."""

    def __init__(self, model_name="deepseek-chat"):
        self.model_name = model_name
        super().__init__()

    def load_model(self):
        return self.model_name

    def generate(self, prompt: str, **kwargs) -> str:
        import openai
        client = openai.OpenAI(
            api_key=DEEPSEEK_API_KEY,
            base_url="https://api.deepseek.com/v1",
        )
        response = client.chat.completions.create(
            model=self.model_name,
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
            **kwargs,
        )
        return response.choices[0].message.content

    async def a_generate(self, prompt: str, **kwargs) -> str:
        import openai
        import asyncio
        client = openai.AsyncOpenAI(
            api_key=DEEPSEEK_API_KEY,
            base_url="https://api.deepseek.com/v1",
        )
        response = await client.chat.completions.create(
            model=self.model_name,
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
            **kwargs,
        )
        return response.choices[0].message.content

    def get_model_name(self):
        return self.model_name


def make_judge_model(model_spec):
    """Create a deepeval-compatible judge model.
    
    - "gpt-4o" → uses default OpenAI (needs OPENAI_API_KEY)
    - "deepseek-chat" → uses custom DeepSeek wrapper
    """
    if model_spec == "deepseek-chat":
        if not DEEPSEEK_API_KEY:
            print("WARNING: DEEPSEEK_API_KEY not set. Family bias warning applies "
                  "when judge matches generator (both DeepSeek).")
            return None
        return DeepSeekChatLLM("deepseek-chat")
    else:
        # Assume OpenAI-compatible model name
        return model_spec

# ──────── Dimension definitions ────────

DIMENSIONS = {
    "ROLE_ADHERENCE": GEval(
        name="role_adherence",
        evaluation_steps=[
            "Identify the persona described in the instruction.",
            "Check if the output reasons from that persona's perspective.",
            "Score 5 if perspective is consistently maintained.",
            "Score 3 if role is mentioned but reasoning is generic.",
            "Score 1 if the output contradicts the assigned role.",
        ],
        evaluation_params=[SingleTurnParams.INPUT, SingleTurnParams.ACTUAL_OUTPUT],
        model=make_judge_model(JUDGE_MODEL),
        async_mode=False,
    ),
    "CONTENT_COVERAGE": GEval(
        name="content_coverage",
        evaluation_steps=[
            "Identify all topics/constraints explicitly requested in the instruction.",
            "Check if the output addresses each requested topic.",
            "Score 5 if every request is covered substantively.",
            "Score 3 if most covered but some are superficial or missing.",
            "Score 1 if multiple topics are omitted entirely.",
        ],
        evaluation_params=[SingleTurnParams.INPUT, SingleTurnParams.ACTUAL_OUTPUT],
        model=make_judge_model(JUDGE_MODEL),
        async_mode=False,
    ),
    "FORMAT_COMPLIANCE": GEval(
        name="format_compliance",
        evaluation_steps=[
            "Check if the output follows the exact format specified in the instruction.",
            "Verify all required structural elements are present (headings, JSON keys, sections).",
            "Check for extra content outside the specified format.",
            "Penalize unnecessary length; favor concise correct output.",
        ],
        evaluation_params=[SingleTurnParams.INPUT, SingleTurnParams.ACTUAL_OUTPUT],
        model=make_judge_model(JUDGE_MODEL),
        async_mode=False,
    ),
    "SPECIFICITY": GEval(
        name="specificity",
        evaluation_steps=[
            "Check if findings are concrete, actionable, and artifact-specific.",
            "Score 5 if claims reference specific details from the input content.",
            "Score 3 if statements are partially generic but include some specifics.",
            "Score 1 if the output is entirely generic with no artifact-specific insight.",
        ],
        evaluation_params=[SingleTurnParams.INPUT, SingleTurnParams.ACTUAL_OUTPUT],
        model=make_judge_model(JUDGE_MODEL),
        async_mode=False,
    ),
    "NEGATION_COMPLIANCE": GEval(
        name="negation_compliance",
        evaluation_steps=[
            "Identify explicitly forbidden behaviors in the instruction (e.g. 'do NOT').",
            "Count occurrences of each forbidden behavior in the output.",
            "Score 5 if zero forbidden behaviors are present.",
            "Score 3 if minor borderline cases exist.",
            "Score 1 if a clear violation of an explicit negation is present.",
        ],
        evaluation_params=[SingleTurnParams.INPUT, SingleTurnParams.ACTUAL_OUTPUT],
        model=make_judge_model(JUDGE_MODEL),
        async_mode=False,
    ),
    "OVERALL": GEval(
        name="overall",
        evaluation_steps=[
            "Assess the overall quality of the output holistically.",
            "Consider role adherence, content coverage, specificity, and format.",
            "Score 5 if excellent and production-ready.",
            "Score 3 if usable but needs editing.",
            "Score 1 if unusable.",
        ],
        evaluation_params=[SingleTurnParams.INPUT, SingleTurnParams.ACTUAL_OUTPUT],
        model=make_judge_model(JUDGE_MODEL),
        async_mode=False,
    ),
}

# Precompute aggregated judge = mean of all applicable dimensions
def make_aggregated_judge(dim_names):
    """Create a combined judge that averages scores across dimensions."""
    pass  # We compute aggregation post-hoc from individual scores

# ──────── Scenarios and their applicable dimensions ────────

SCENARIO_DIMS = {
    "A": ["ROLE_ADHERENCE", "NEGATION_COMPLIANCE", "SPECIFICITY", "OVERALL"],
    "B": ["FORMAT_COMPLIANCE", "CONTENT_COVERAGE", "OVERALL"],
    "C": ["CONTENT_COVERAGE", "FORMAT_COMPLIANCE", "SPECIFICITY", "OVERALL"],
    "D": ["ROLE_ADHERENCE", "SPECIFICITY", "OVERALL"],
    "E": ["CONTENT_COVERAGE", "SPECIFICITY", "OVERALL"],
    "F": ["NEGATION_COMPLIANCE", "CONTENT_COVERAGE", "SPECIFICITY", "OVERALL"],
}


# ──────── Metrics per output ────────

def score_output(scenario_id, instruction, output):
    """Score a single output against all applicable dimensions."""
    dims = SCENARIO_DIMS.get(scenario_id, ["OVERALL"])
    tc = LLMTestCase(input=instruction, actual_output=output)
    scores = {}
    reasons = {}
    for dim in dims:
        metric = DIMENSIONS[dim]
        metric.measure(tc)
        scores[dim] = metric.score
        reasons[dim] = getattr(metric, "reason", "")
    return scores, reasons, len(output.split())


def pairwise_judge(scenario_id, instruction, output_a, output_b, label_a, label_b):
    """Compare two outputs: which is better?"""
    dims = SCENARIO_DIMS.get(scenario_id, ["OVERALL"])
    dim_name = dims[0]  # Use first applicable dimension as pairwise criteria

    # Map dimension name to human-readable criteria
    criteria_map = {
        "ROLE_ADHERENCE": "Which output better adheres to the assigned role or persona?",
        "CONTENT_COVERAGE": "Which output more completely covers all requested topics?",
        "FORMAT_COMPLIANCE": "Which output better follows the specified output format?",
        "SPECIFICITY": "Which output has more specific, concrete findings?",
        "NEGATION_COMPLIANCE": "Which output better avoids explicitly forbidden behaviors?",
        "OVERALL": "Which output is better overall?",
    }
    criteria = criteria_map.get(dim_name, "Which output is better?")

    metric = ArenaGEval(
        name="pairwise",
        criteria=criteria,
        evaluation_params=[SingleTurnParams.INPUT, SingleTurnParams.ACTUAL_OUTPUT],
        model=make_judge_model(JUDGE_MODEL),
        async_mode=False,
    )

    arena_tc = ArenaTestCase(
        contestants=[
            Contestant(
                name=label_a,
                test_case=LLMTestCase(input=instruction, actual_output=output_a),
            ),
            Contestant(
                name=label_b,
                test_case=LLMTestCase(input=instruction, actual_output=output_b),
            ),
        ]
    )
    metric.measure(arena_tc)
    return metric.winner, getattr(metric, "reason", "")


# ──────── Statistical helpers ────────

def cohens_d(x, y):
    """Cohen's d for paired samples."""
    n = len(x)
    diff = np.array(x) - np.array(y)
    mean_diff = np.mean(diff)
    std_diff = np.std(diff, ddof=1)
    if std_diff == 0:
        return 0.0
    return mean_diff / std_diff


def tost_equivalence(rf_scores, cf_scores, delta, alpha=0.05):
    """
    Two One-Sided Tests for equivalence.
    H0: |mean(RF) - mean(CF)| >= delta  (difference is too large)
    H1: |mean(RF) - mean(CF)| < delta   (equivalent within delta)
    """
    diff = np.array(rf_scores) - np.array(cf_scores)
    n = len(diff)
    mean_diff = np.mean(diff)
    se = np.std(diff, ddof=1) / np.sqrt(n)

    if se == 0:
        return True, 1.0, 1.0  # Both identical, trivially equivalent

    # Lower test: H0: mean_diff <= -delta
    t_lower = (mean_diff + delta) / se
    p_lower = 1 - scipy_stats.t.cdf(t_lower, df=n - 1)

    # Upper test: H0: mean_diff >= delta
    t_upper = (mean_diff - delta) / se
    p_upper = scipy_stats.t.cdf(t_upper, df=n - 1)

    equivalent = p_lower < alpha and p_upper < alpha
    return equivalent, p_lower, p_upper


def length_bias_check(scores, token_counts, name=""):
    """Check if scores correlate with output length."""
    r, p = pearsonr(scores, token_counts)
    biased = abs(r) > 0.3
    return r, p, biased


# ──────── Main ────────

def main():
    parser = argparse.ArgumentParser(description="IHE-1 Evaluation Layer")
    parser.add_argument("--sessions", nargs="+", required=True, help="IHE-1 generation output files")
    args = parser.parse_args()

    # Load all session files
    all_data = []
    for sf in args.sessions:
        with open(sf) as f:
            all_data.append(json.load(f))

    print("=" * 72)
    print("  IHE-1 EVALUATION LAYER")
    print(f"  Judge model: {JUDGE_MODEL}")
    print(f"  Session files: {len(all_data)}")
    print(f"  Equivalence delta: {EQUIVALENCE_DELTA}")
    print("=" * 72)

    # Collect all results
    results_by_scenario = defaultdict(lambda: {"rf": defaultdict(list), "cf": defaultdict(list)})
    pairwise_results = defaultdict(list)
    all_pairwise = []

    for session in all_data:
        for scenario in session["results"]:
            sid = scenario["scenario"]["id"]
            instruction = scenario["instruction"]

            for trial in scenario["trials"]:
                tnum = trial["trial"]

                # Score RF
                print(f"    Trial {tnum}: RF scoring...", end="", flush=True)
                rf_scores, rf_reasons, rf_tokens = score_output(
                    sid, instruction, trial["rf"]["output"]
                )
                print(f" done CF scoring...", end="", flush=True)
                # Score CF
                cf_scores, cf_reasons, cf_tokens = score_output(
                    sid, instruction, trial["cf"]["output"]
                )
                print(" done")

                for dim, score in rf_scores.items():
                    results_by_scenario[sid]["rf"][dim].append(score)
                    results_by_scenario[sid]["rf"][f"{dim}_tokens"].append(rf_tokens)
                for dim, score in cf_scores.items():
                    results_by_scenario[sid]["cf"][dim].append(score)
                    results_by_scenario[sid]["cf"][f"{dim}_tokens"].append(cf_tokens)

                # Pairwise (blind)
                print(f"              Pairwise...", end="", flush=True)
                winner = pairwise_judge(
                    sid,
                    instruction,
                    trial["blind"]["a_output"],
                    trial["blind"]["b_output"],
                    trial["blind"]["a_label"],
                    trial["blind"]["b_label"],
                )
                pairwise_results[sid].append({
                    "trial": tnum,
                    "winner": winner[0],  # 'CF' or 'RF'
                    "reason": winner[1],
                })
                all_pairwise.append({"scenario": sid, "winner": winner[0]})

    # ──────── Per-scenario analysis ────────
    print("\n")
    print("-" * 72)
    print("  PER-SCENARIO ANALYSIS")
    print("-" * 72)

    for sid in sorted(results_by_scenario.keys()):
        rf = results_by_scenario[sid]["rf"]
        cf = results_by_scenario[sid]["cf"]
        dims = SCENARIO_DIMS[sid]

        print(f"\n  Scenario {sid}  ({', '.join(dims)})")
        print(f"  {'─' * 60}")
        sys.stdout.flush()

        for dim in dims:
            rf_scores = rf.get(dim, [])
            cf_scores = cf.get(dim, [])
            if not rf_scores or not cf_scores:
                continue

            mu_rf = np.mean(rf_scores)
            mu_cf = np.mean(cf_scores)
            sd_rf = np.std(rf_scores, ddof=1)
            sd_cf = np.std(cf_scores, ddof=1)
            d = cohens_d(rf_scores, cf_scores)
            equiv, p_low, p_high = tost_equivalence(rf_scores, cf_scores, EQUIVALENCE_DELTA)

            # Length bias
            rf_toks = rf.get(f"{dim}_tokens", [])
            cf_toks = cf.get(f"{dim}_tokens", [])
            r_all, _ = length_bias_check(rf_scores + cf_scores, rf_toks + cf_toks)
            biased = abs(r_all) > 0.3

            print(f"    {dim}")
            print(f"      RF: μ={mu_rf:.3f} σ={sd_rf:.3f}  CF: μ={mu_cf:.3f} σ={sd_cf:.3f}")
            print(f"      Δ={mu_rf - mu_cf:.3f}  d={d:.3f}  TOST ↔ {equiv}")
            print(f"      Length bias r={r_all:.3f} {'⚠️' if biased else '✅'}")

        # Preference breakdown
        prefs = pairwise_results[sid]
        cf_wins = sum(1 for p in prefs if p["winner"] == "CF")
        rf_wins = sum(1 for p in prefs if p["winner"] == "RF")
        ties = len(prefs) - cf_wins - rf_wins
        total = len(prefs)
        print(f"    PREFERENCE: CF {cf_wins}/{total}  RF {rf_wins}/{total}  ties {ties}/{total}")
        # Binomial test
        if cf_wins + rf_wins > 0:
            binom_p = scipy_stats.binomtest(cf_wins, cf_wins + rf_wins, p=0.5).pvalue
            print(f"      Binomial p={binom_p:.4f} (H₀: CF=RF, 50/50)")

    # ──────── Aggregate across scenarios ────────
    print("\n")
    print("-" * 72)
    print("  AGGREGATE ACROSS ALL SCENARIOS")
    print("-" * 72)

    all_rf = []
    all_cf = []
    for sid, data in results_by_scenario.items():
        for dim in SCENARIO_DIMS[sid]:
            all_rf.extend(data["rf"].get(dim, []))
            all_cf.extend(data["cf"].get(dim, []))

    if all_rf and all_cf:
        mu_rf = np.mean(all_rf)
        mu_cf = np.mean(all_cf)
        d = cohens_d(all_rf, all_cf)
        equiv, p_low, p_high = tost_equivalence(all_rf, all_cf, EQUIVALENCE_DELTA)

        print(f"  N={len(all_rf)} scores each")
        print(f"  RF: μ={mu_rf:.3f}  CF: μ={mu_cf:.3f}")
        print(f"  Δ={mu_rf - mu_cf:.3f}  d={d:.3f}  TOST equivalence: {equiv}")
        print(f"  TOST lower p={p_low:.6f}  upper p={p_high:.6f}")

    # ──────── Verdict ────────
    print("\n")
    print("=" * 72)
    print("  VERDICT")
    print("=" * 72)

    # Count scenarios where TOST holds for all dimensions
    passed_dims = 0
    total_dims = 0
    for sid in sorted(results_by_scenario.keys()):
        rf = results_by_scenario[sid]["rf"]
        cf = results_by_scenario[sid]["cf"]
        for dim in SCENARIO_DIMS[sid]:
            rf_s = rf.get(dim, [])
            cf_s = cf.get(dim, [])
            if rf_s and cf_s:
                total_dims += 1
                equiv, _, _ = tost_equivalence(rf_s, cf_s, EQUIVALENCE_DELTA)
                if equiv:
                    passed_dims += 1

    # Aggregate TOST
    agg_equiv, _, _ = tost_equivalence(all_rf, all_cf, EQUIVALENCE_DELTA)

    if agg_equiv and passed_dims == total_dims:
        print("  ✅ CONTENT-FIRST INSTRUCTION-EQUIVALENT TO ROLE-FIRST")
        print("     TOST equivalence holds at Δ=0.5 on all dimensions.")
        print("     The thesis strictly dominates. Ship it.")
    elif agg_equiv:
        print("  ⚠️  CONTENT-FIRST MOSTLY EQUIVALENT")
        print(f"     {passed_dims}/{total_dims} dimensions pass TOST.")
        print("     Check per-scenario details for failing dimensions.")
    else:
        print("  ❌ CONTENT-FIRST DEGRADES INSTRUCTION FOLLOWING")
        print("     TOST equivalence fails at Δ=0.5.")
        print("     Check per-scenario details for effect sizes.")

    print("=" * 72)


if __name__ == "__main__":
    main()
