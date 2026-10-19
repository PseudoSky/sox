"""P11 intraday rule checks: the 0dte-flow entry gate and exit cascade as deterministic code.

Decision support only. Nothing here reads a signal feed or places an order; the caller supplies the
observed values and places any order by hand (live order effects belong to the gated E playbook).
"""
from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Any

from .errors import FinanceError

GRADES = ("A+", "A", "B", "C", "D", "F")
MIN_GRADE = "B"
MEGA = ("mega_bull", "mega_bear")
ENTRY_OPEN, ENTRY_CLOSE = (9, 30), (11, 30)
HARD_CLOSE = (14, 30)
NOON = (12, 0)
AFTERNOON = (13, 0)
MIN_RVOL = Decimal("1.2")
MAX_TREND_AGE = 15
MAX_TRADES_PER_DAY = 2
FRIDAY = 4
# The skill's worked example is a $75 account: $30 per trade, $60 daily loss.
TRADE_FRACTION, DAILY_LOSS_FRACTION = Decimal("0.4"), Decimal("0.8")


def _minutes(value: str) -> int:
    try:
        hh, mm = value.split(":")
        h, m = int(hh), int(mm)
    except ValueError as exc:
        raise FinanceError(f"time must be HH:MM in 24-hour ET, got {value!r}") from exc
    if not (0 <= h < 24 and 0 <= m < 60):
        raise FinanceError(f"time must be HH:MM in 24-hour ET, got {value!r}")
    return h * 60 + m


def _at(pair: tuple[int, int]) -> int:
    return pair[0] * 60 + pair[1]


def _dec(value: Any, name: str) -> Decimal:
    try:
        return Decimal(str(value))
    except InvalidOperation as exc:
        raise FinanceError(f"{name} must be a number, got {value!r}") from exc


def _grade(value: str) -> int:
    if value not in GRADES:
        raise FinanceError(f"grade must be one of {', '.join(GRADES)}, got {value!r}")
    return GRADES.index(value)


def check_entry(grade: str, signal: str, rvol: Any, time_et: str, trend_age: int, weekday: int,
                open_positions: int = 0, trades_today: int = 0, day_pnl: Any = 0,
                account_size: Any = None) -> dict[str, Any]:
    """Return every rule with its observed value; `allowed` only when all hold."""
    now, rv, pnl = _minutes(time_et), _dec(rvol, "rvol"), _dec(day_pnl, "day_pnl")
    size = _dec(account_size, "account_size") if account_size is not None else None
    loss_cap = size * DAILY_LOSS_FRACTION if size is not None else None
    rules = [
        ("grade_at_least_B", _grade(grade) <= _grade(MIN_GRADE), grade),
        ("signal_is_mega", signal in MEGA, signal),
        ("rvol_above_1.2", rv > MIN_RVOL, str(rv)),
        ("entry_window_0930_1130", _at(ENTRY_OPEN) <= now <= _at(ENTRY_CLOSE), time_et),
        ("trend_age_under_15_bars", trend_age < MAX_TREND_AGE, trend_age),
        ("no_open_position", open_positions == 0, open_positions),
        ("under_two_trades_today", trades_today < MAX_TRADES_PER_DAY, trades_today),
        ("no_friday_0dte", weekday != FRIDAY, weekday),
    ]
    if loss_cap is not None:
        rules.append(("daily_loss_not_reached", pnl > -loss_cap, str(pnl)))
    failed = [name for name, ok, _ in rules if not ok]
    out: dict[str, Any] = {"allowed": not failed, "failed": failed,
                           "rules": [{"rule": n, "ok": ok, "observed": v} for n, ok, v in rules]}
    if size is not None:
        out["max_per_trade"] = str((size * TRADE_FRACTION).quantize(Decimal("0.01")))
        out["max_daily_loss"] = str(loss_cap.quantize(Decimal("0.01")))
    return out


def check_exit(pnl_pct: Any, grade: str, signal_flipped: bool, time_et: str, entry_grade: str | None = None) -> dict[str, Any]:
    """Walk the cascade in order; the first match wins. `hold` when nothing matches."""
    pnl, now, g = _dec(pnl_pct, "pnl_pct"), _minutes(time_et), _grade(grade)
    faded = entry_grade is not None and g >= _grade("C") and g > _grade(entry_grade)
    cascade = [
        ("S1", "hard stop", pnl <= Decimal("-50")),
        ("S2", "grade death", g >= _grade("D")),
        ("S3", "reversal", signal_flipped),
        ("T1", "end of day", now >= _at(HARD_CLOSE)),
        ("P1", "double", pnl >= Decimal("100")),
        ("P2", "fading", pnl >= Decimal("30") and faded),
        ("P3", "afternoon", pnl >= Decimal("50") and now > _at(AFTERNOON)),
        ("T2", "dead money", now >= _at(NOON) and abs(pnl) <= Decimal("10")),
    ]
    for code, name, hit in cascade:
        if hit:
            return {"action": "sell", "rule": code, "reason": name}
    return {"action": "hold", "rule": None, "reason": "no exit rule matched"}
