"""Per-ticket acceptance-criteria **distribution** (real backlog; spec App. E / C4).

The original model treated acceptance criteria as a scalar *floor*: ``a_bk >= 1``
for every ticket (constraint C4).  That is the wrong shape for a real backlog.
The operator's own ``sox-ecosystem`` backlog graph (read-only, 2026-10-05;
spec Appendix E, 1,271 live issues / 880 open) shows:

* the **MODAL ticket carries ZERO acceptance criteria**;
* only **2.4 %** carry an explicit AC section (median 4, range 2-6);
* only **7.2 %** carry any AC-ish marker at all;
* therefore the expected AC per ticket is **~0.3**, not ``>= 1``.

This module models ``alpha`` as that distribution, dominated by 0: ~93 % of
tickets carry none and a ~7 % tail carries ~3-5 (median 4).  The revised C4 is
a *distribution, not a floor*.

Why it matters downstream
-------------------------
The suite / test machinery keys off ACs: test-writing, test-running and the
per-AC compounding suite are all proportional to the AC count.  A ticket with
**0 ACs must generate no test-write / test-run work at all** -- otherwise the
model overstates the test load for ~93 % of real tickets (exactly the defect
Appendix E flags).  :func:`pipeline_sim.model.build_task_graph` honours that by
instantiating no test task for a 0-AC ticket.

Reproducibility
---------------
The counts are drawn from a seeded :class:`random.Random`, so a given
``(M, seed)`` always yields the same vector (the engine's determinism contract).
The AC stream uses its own seed mix (:data:`_AC_SEED_MIX`) so it never perturbs
the A1 rework sequence, which draws from ``random.Random(cfg.seed)`` directly.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Dict, List, Tuple

# ---------------------------------------------------------------------------
# Real-population constants (spec Appendix E -- operator backlog, 2026-10-05)
# ---------------------------------------------------------------------------
#: Live issues in the source backlog graph.
REAL_TOTAL_BACKLOG = 1_271
#: The takeable (open) set -- the full open backlog, not one sprint.
REAL_OPEN_BACKLOG = 880
#: A sprint-sized batch: the realistic *default* takeable set.  40-60 tickets is
#: what a team commits to in a sprint; the full 880 is the whole open backlog.
REAL_SPRINT_BATCH_MIN = 40
REAL_SPRINT_BATCH_MAX = 60
#: The shipped default ticket count (mid-sprint).
REAL_SPRINT_TICKETS = 60

#: Real ticket-kind mix (spec Appendix E / the task brief).  The simulator
#: treats tickets *homogeneously* (one work-per-ticket), so this is carried as
#: documented CONTEXT -- it explains why the workload is bug-heavy -- not as a
#: per-kind cost axis (that would misrepresent a model that has no such axis).
REAL_TICKET_KIND_MIX: Dict[str, float] = {
    "bug": 0.45,
    "BL": 0.20,
    "debt": 0.15,
    "issue": 0.07,
    "feature": 0.13,
}

#: Separate RNG stream for the AC draw, so it cannot perturb the rework stream.
_AC_SEED_MIX = 1_000_003


@dataclass(frozen=True)
class AcDistribution:
    """A per-ticket acceptance-criteria distribution, dominated by zero.

    ``zero_share`` is the fraction of tickets that carry **no** ACs (the modal
    ticket).  The remaining ``1 - zero_share`` draw a positive count from
    ``tail_counts`` with probability ``tail_weights``.

    The default realises Appendix E: ``zero_share = 0.925`` (≈93 % zero), a
    7.5 % tail of 3-5 criteria (median 4), giving ``expected_ac ≈ 0.30``.
    """

    zero_share: float = 0.925
    tail_counts: Tuple[int, ...] = (3, 4, 5)
    tail_weights: Tuple[float, ...] = (0.25, 0.50, 0.25)

    def __post_init__(self) -> None:  # frozen dataclass: validation only
        if not (0.0 <= self.zero_share <= 1.0):
            raise ValueError(
                "AcDistribution.zero_share must be in [0, 1] "
                f"(got {self.zero_share!r})"
            )
        if not self.tail_counts:
            raise ValueError("AcDistribution.tail_counts must be non-empty")
        if any(c < 1 for c in self.tail_counts):
            raise ValueError(
                "AcDistribution.tail_counts must be positive integers "
                f"(got {self.tail_counts!r})"
            )
        if len(self.tail_counts) != len(self.tail_weights):
            raise ValueError(
                "AcDistribution.tail_counts and tail_weights must be the same "
                f"length (got {len(self.tail_counts)} vs {len(self.tail_weights)})"
            )
        if any(w < 0 for w in self.tail_weights) or sum(self.tail_weights) <= 0:
            raise ValueError(
                "AcDistribution.tail_weights must be non-negative and not all "
                f"zero (got {self.tail_weights!r})"
            )

    # -- derived shape ----------------------------------------------------
    @property
    def tail_share(self) -> float:
        """Fraction of tickets that carry >= 1 AC (``1 - zero_share``)."""
        return 1.0 - self.zero_share

    @property
    def expected_tail(self) -> float:
        """Mean AC count **given** the ticket carries any."""
        total = sum(self.tail_weights)
        return sum(c * w for c, w in zip(self.tail_counts, self.tail_weights)) / total

    @property
    def expected_ac(self) -> float:
        """Expected AC per ticket over ALL tickets (the modelled ``alpha``)."""
        return self.tail_share * self.expected_tail

    @property
    def modal_ac(self) -> int:
        """The modal per-ticket AC count (the whole point: it is 0)."""
        return 0

    @property
    def median_tail(self) -> int:
        """Median positive AC count (from the tail weights)."""
        order = sorted(zip(self.tail_counts, self.tail_weights), key=lambda cw: cw[0])
        total = sum(self.tail_weights)
        cum = 0.0
        for count, weight in order:
            cum += weight
            if cum >= total / 2.0:
                return int(count)
        return int(order[-1][0])

    # -- sampling ---------------------------------------------------------
    def sample_counts(self, M: int, seed: int = 0) -> List[int]:
        """A length-``M`` vector of per-ticket AC counts (seeded, deterministic).

        **Stratified**: exactly ``round((1 - zero_share) * M)`` tickets draw a
        value from the weighted tail; the rest carry 0.  *Which* tickets carry
        ACs and each positive ticket's count are drawn from the seeded RNG.

        AC counts are a structural *input* (not an outcome we study), so the
        zero/positive split is realised in aggregate rather than left to
        Bernoulli variance -- this keeps a sprint-sized run (M=60) faithfully
        ~93 % zero instead of drifting run-to-run.  The result is still a
        realisation of the tail distribution and is deterministic per seed.
        """
        m = int(M)
        if m <= 0:
            return []
        rng = random.Random(int(seed) * _AC_SEED_MIX + 0xAC)
        # expected positive count, realised with the fractional part sampled so
        # the mean is unbiased even for a small sprint batch (M=60 -> x=4.5).
        x = self.tail_share * m
        n_pos = int(x)
        if rng.random() < (x - n_pos):
            n_pos += 1
        n_pos = max(0, min(m, n_pos))
        idx = list(range(m))
        rng.shuffle(idx)
        counts: List[int] = [0] * m
        for t in idx[:n_pos]:
            counts[t] = self._draw_tail(rng)
        return counts

    def _draw_tail(self, rng: random.Random) -> int:
        total = sum(self.tail_weights)
        r = rng.random() * total
        cum = 0.0
        for count, weight in zip(self.tail_counts, self.tail_weights):
            cum += weight
            if r < cum:
                return int(count)
        return int(self.tail_counts[-1])

    # -- reporting --------------------------------------------------------
    @staticmethod
    def histogram(counts: List[int]) -> Dict[int, int]:
        """``{ac_count: #tickets}`` over a sampled vector."""
        out: Dict[int, int] = {}
        for c in counts:
            out[c] = out.get(c, 0) + 1
        return out

    @property
    def zero_pct(self) -> float:
        return 100.0 * self.zero_share

    @property
    def tail_pct(self) -> float:
        return 100.0 * self.tail_share

    def describe(self) -> str:
        """One-line plain-English summary (UI / report / docs)."""
        lo, hi = min(self.tail_counts), max(self.tail_counts)
        return (
            f"{self.zero_pct:.1f}% of tickets carry 0 ACs; a "
            f"{self.tail_pct:.1f}% tail carries {lo}-{hi} (median "
            f"{self.median_tail}); expected ~{self.expected_ac:.2f} AC/ticket"
        )


#: The shipped real-backlog distribution (Appendix E): the modal ticket has 0.
REAL_AC_DISTRIBUTION = AcDistribution(
    zero_share=0.925,
    tail_counts=(3, 4, 5),
    tail_weights=(0.25, 0.50, 0.25),
)


def sample_counts(M: int, seed: int = 0,
                  dist: AcDistribution = REAL_AC_DISTRIBUTION) -> List[int]:
    """Module-level convenience wrapper around :meth:`AcDistribution.sample_counts`."""
    return dist.sample_counts(M, seed)


def histogram(counts: List[int]) -> Dict[int, int]:
    """Module-level convenience wrapper around :meth:`AcDistribution.histogram`."""
    return AcDistribution.histogram(counts)
