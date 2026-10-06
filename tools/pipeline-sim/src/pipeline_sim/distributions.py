"""Measured cost / token distributions from the operator's own ``opencode.db``.

These replace the single point estimates the model used to carry for dispatch
and per-step cost with the *measured* distributions (spec Appendix C, "REAL
MEASURED NUMBERS -- the operator's own ``opencode.db``").

Provenance (extracted read-only, 2026-10-05)::

    store    /Users/nix/.local/share/opencode/opencode.db
    window   ~3.2 months (2026-06-29 .. 2026-09-24)
    totals   184,841 model steps, 4,662 dispatches, $354.65

The numbers are records, not parameters: the model's point estimates
(``c_dispatch``, ``OC``) are calibrated to their medians, and the full
quantiles are surfaced in the harness report and the UI so a reader can see the
run-to-run spread (measured ~30x) rather than a misleading single value.

Nothing here mutates the model.  It is the measurement layer the calibration
constants are pinned to.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Dict, List, Optional


@dataclass(frozen=True)
class Quantiles:
    """A measured value's quantiles.  Missing quantiles are ``None``.

    ``maximum`` is spelled out because ``max`` shadows the builtin, and
    ``mean`` is carried only where the store reported one.
    """

    p50: float
    p90: Optional[float] = None
    p99: Optional[float] = None
    maximum: Optional[float] = None
    mean: Optional[float] = None
    #: Number of observations behind the quantiles, when known (the event-data
    #: calibration carries it; the opencode.db point estimates leave it None).
    count: Optional[int] = None

    def as_row(self) -> Dict[str, Optional[float]]:
        return asdict(self)


# ---------------------------------------------------------------------------
# Per-dispatch and per-step cost (spec Appendix C measured block)
# ---------------------------------------------------------------------------
PER_DISPATCH_COST = Quantiles(
    p50=0.0307, p90=0.1176, p99=0.8464, maximum=20.57, mean=0.0761,
)
PER_STEP_COST = Quantiles(
    p50=0.001124, p90=0.003247, p99=0.013332, maximum=0.266,
)

# ---------------------------------------------------------------------------
# Per-step token classes (fresh input / output / cache-read)
# ---------------------------------------------------------------------------
STEP_FRESH_INPUT = Quantiles(p50=500, p90=7_252)
STEP_OUTPUT = Quantiles(p50=220, p90=1_049)
STEP_CACHE_READ = Quantiles(p50=141_056, p90=388_864)

# ---------------------------------------------------------------------------
# Per-session token classes (>=10-step sessions)
# ---------------------------------------------------------------------------
SESSION_OUTPUT = Quantiles(p50=9_843)
SESSION_INPUT = Quantiles(p50=73_904, p90=231_325)
#: Cold-start first call of a >=10-step session: prompt = input + cache-read.
SESSION_COLD_START_PROMPT = Quantiles(p50=55_860)

# ---------------------------------------------------------------------------
# The two calibration points the model's constants are derived from
# ---------------------------------------------------------------------------
#: A fresh dispatch's first-step input, measured.  ``c_dispatch`` = this x P_IN.
DISPATCH_FIRST_STEP_INPUT = Quantiles(p50=14_470, mean=14_470)
#: A tool call's payload, measured.  ``OC`` = this x P_IN.
TOOL_CALL_TOKENS_MEASURED = Quantiles(p50=950, mean=950)
#: The billed per-fire / per-call dollar figures the calibration reproduces.
DISPATCH_FIRST_STEP_COST_MEASURED = Quantiles(p50=0.0022)
TOOL_CALL_COST_MEASURED = Quantiles(p50=0.000143)

# ---------------------------------------------------------------------------
# Measured LLM cost composition (shares of real spend)
# ---------------------------------------------------------------------------
#: Keys match :data:`pipeline_sim.config.LLM_COST_CLASSES`.
MEASURED_COST_COMPOSITION: Dict[str, float] = {
    "input": 0.407,
    "reasoning": 0.197,
    "cache_read": 0.289,
    "output": 0.158,
}

#: Store totals behind the distributions above.
MEASURED_TOTALS: Dict[str, float] = {
    "model_steps": 184_841,
    "dispatches": 4_662,
    "total_cost_usd": 354.65,
    "cache_read_tokens": 34_500_000_000,   # 34.5 BILLION
    "months": 3.2,
}

#: Name -> Quantiles registry, for the docs/UI table.
MEASURED: Dict[str, Quantiles] = {
    "per-dispatch cost ($)": PER_DISPATCH_COST,
    "per-step cost ($)": PER_STEP_COST,
    "step fresh input (tok)": STEP_FRESH_INPUT,
    "step output (tok)": STEP_OUTPUT,
    "step cache-read (tok)": STEP_CACHE_READ,
    "session output (tok)": SESSION_OUTPUT,
    "session input (tok)": SESSION_INPUT,
    "session cold-start prompt (tok)": SESSION_COLD_START_PROMPT,
    "dispatch first-step input (tok)": DISPATCH_FIRST_STEP_INPUT,
    "tool-call payload (tok)": TOOL_CALL_TOKENS_MEASURED,
    "dispatch first-step cost ($)": DISPATCH_FIRST_STEP_COST_MEASURED,
    "tool-call cost ($)": TOOL_CALL_COST_MEASURED,
}


def rows() -> List[Dict[str, object]]:
    """The measured distributions as UI/table rows (one per measurement)."""
    out: List[Dict[str, object]] = []
    for name, q in MEASURED.items():
        out.append({
            "measurement": name,
            "p50": q.p50,
            "p90": q.p90,
            "p99": q.p99,
            "max": q.maximum,
            "mean": q.mean,
        })
    return out


def composition_rows() -> List[Dict[str, object]]:
    """The measured LLM cost composition as ordered rows with shares.

    The store's percentages are rounded and sum to 105.1 %, so ``share`` is
    normalised to sum to 1.0 and ``measured_pct`` carries the raw store figure.
    """
    total = sum(MEASURED_COST_COMPOSITION.values())
    return [
        {
            "class": k,
            "share": v / total,
            "share_pct": 100.0 * v / total,
            "measured_pct": 100.0 * v,
        }
        for k, v in MEASURED_COST_COMPOSITION.items()
    ]
