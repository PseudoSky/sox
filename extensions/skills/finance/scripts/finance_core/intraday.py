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
SIGNAL_UNDERLYING = "SPY"
MIN_RVOL = Decimal("1.2")
MAX_TREND_AGE = 15
MAX_TRADES_PER_DAY = 2
FRIDAY = 4
# The source's worked example is a $75 account: $30 per trade, $60 daily loss. Those ratios are a
# small-account all-in rule, so they apply by default only up to this size; above it the caller states limits.
TRADE_FRACTION, DAILY_LOSS_FRACTION = Decimal("0.4"), Decimal("0.8")
SOURCE_EXAMPLE_MAX_ACCOUNT = Decimal("1000")


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
                open_positions: int = 0, trades_today: int = 0, day_pnl: Any = None,
                account_size: Any = None, symbol: str | None = None, max_trade_pct: Any = None,
                max_daily_loss_pct: Any = None, premium: Any = None, contracts: int = 1, stop_premium: Any = None) -> dict[str, Any]:
    """Return every rule with its observed value; `allowed` only when all hold."""
    now, rv = _minutes(time_et), _dec(rvol, "rvol")
    pnl = _dec(day_pnl, "day_pnl") if day_pnl is not None else None
    size = _dec(account_size, "account_size") if account_size is not None else None
    trade_frac = _dec(max_trade_pct, "max_trade_pct") / 100 if max_trade_pct is not None else None
    loss_frac = _dec(max_daily_loss_pct, "max_daily_loss_pct") / 100 if max_daily_loss_pct is not None else None
    small = size is not None and size <= SOURCE_EXAMPLE_MAX_ACCOUNT
    trade_frac = trade_frac if trade_frac is not None else TRADE_FRACTION if small else None
    loss_frac = loss_frac if loss_frac is not None else DAILY_LOSS_FRACTION if small else None
    loss_cap = size * loss_frac if size is not None and loss_frac is not None else None
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
    if symbol is not None:
        rules.append(("signal_on_spy", symbol.upper() == SIGNAL_UNDERLYING, symbol))
    if loss_cap is not None and pnl is not None:
        rules.append(("daily_loss_not_reached", pnl > -loss_cap, str(pnl)))
    cost = _dec(premium, "premium") * 100 * contracts if premium is not None else None
    if cost is not None and size is not None and trade_frac is not None:
        rules.append(("order_cost_within_max_per_trade", cost <= size * trade_frac, str(cost.quantize(Decimal("0.01")))))
    failed = [name for name, ok, _ in rules if not ok]
    out: dict[str, Any] = {"allowed": not failed, "failed": failed,
                           "rules": [{"rule": n, "ok": ok, "observed": v} for n, ok, v in rules]}
    stop_warning = None
    if cost is not None and stop_premium is not None:
        stop = _dec(stop_premium, "stop_premium")
        stop_pct = (stop / _dec(premium, "premium") - 1) * 100
        out["stop_loss_pct"] = str(stop_pct.quantize(Decimal("0.01")))
        out["risk_if_stopped"] = str(((_dec(premium, "premium") - stop) * 100 * contracts).quantize(Decimal("0.01")))
        if stop_pct < Decimal("-50"):
            stop_warning = (
                f"the stop is {-stop_pct.quantize(Decimal('0.1'))}% below entry, past the -50% hard stop (S1): the "
                "exit cascade sells there first")
    if cost is not None:
        out["order_cost"] = str(cost.quantize(Decimal("0.01")))
        if size:
            out["order_cost_pct_of_account"] = str((cost / size * 100).quantize(Decimal("0.01")))
    if size is not None:
        out["warnings"] = []
        if trade_frac is not None:
            out["max_per_trade"] = str((size * trade_frac).quantize(Decimal("0.01")))
        if loss_cap is not None:
            out["max_daily_loss"] = str(loss_cap.quantize(Decimal("0.01")))
        if trade_frac is None or loss_frac is None:
            out["warnings"].append(
                f"no dollar caps: the source's 40% per trade and 80% daily loss come from a $75 example account and "
                f"are applied only to accounts up to ${SOURCE_EXAMPLE_MAX_ACCOUNT}. State your own limits with "
                "--max-trade-pct and --max-daily-loss-pct (percent of the account).")
        elif max_trade_pct is None or max_daily_loss_pct is None:
            out["warnings"].append("caps use the source's small-account ratios (40% per trade, 80% daily loss); "
                                   "override with --max-trade-pct and --max-daily-loss-pct")
        if pnl is None or loss_cap is None:
            out["warnings"].append("the daily-loss rule was NOT evaluated: it needs --day-pnl (0 on a fresh day) "
                                   "and a daily-loss limit")
    if stop_warning:
        out.setdefault("warnings", []).append(stop_warning)
    return out


def check_exit(pnl_pct: Any, grade: str, signal_flipped: bool, time_et: str, entry_grade: str | None = None) -> dict[str, Any]:
    """Walk the cascade in order; the first match wins. `hold` when nothing matches."""
    pnl, now, g = _dec(pnl_pct, "pnl_pct"), _minutes(time_et), _grade(grade)
    faded = g >= _grade("C") and (entry_grade is None or g > _grade(entry_grade))
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
