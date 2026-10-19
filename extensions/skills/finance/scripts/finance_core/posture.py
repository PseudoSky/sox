"""P2 market posture from index price action: a deterministic, dated read of trend and drawdown.

Reads daily bars through the market-data capability. It does not use breadth, news or macro feeds;
the receipt lists exactly the signals that set the posture.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from .errors import FinanceError
from .layout import Layout, atomic_write_json
from .marketdata import UNADJUSTED_WARNING, get_bars, unadjusted_symbols

DEFAULT_INDICES = ("SPY", "QQQ", "IWM")
LEADER = "SPY"
SMA_SLOW, SMA_FAST = 200, 50
REDUCED_DRAWDOWN_PCT = Decimal("5")
BLOCK_DRAWDOWN_PCT = Decimal("10")
MIN_INDICES_ABOVE_SLOW = 2
HIGH_WINDOW = 252
PCT = Decimal("0.01")


def _signal(layout: Layout, symbol: str) -> dict[str, Any]:
    record = get_bars(layout, symbol, "2y")
    closes = [Decimal(b["adj_close"]) for b in record["bars"]]
    if len(closes) < SMA_SLOW:
        raise FinanceError(f"posture: {symbol} has {len(closes)} bars; {SMA_SLOW} are needed for the {SMA_SLOW}-day average")
    last = closes[-1]
    slow = sum(closes[-SMA_SLOW:]) / SMA_SLOW
    fast = sum(closes[-SMA_FAST:]) / SMA_FAST
    high = max(closes[-HIGH_WINDOW:])
    return {
        "symbol": symbol, "as_of": record["bars"][-1]["date"], "close": str(last.quantize(PCT)),
        "vs_50d_pct": str(((last / fast - 1) * 100).quantize(PCT)),
        "vs_200d_pct": str(((last / slow - 1) * 100).quantize(PCT)),
        "drawdown_from_52w_high_pct": str(((1 - last / high) * 100).quantize(PCT)),
        "above_50d": last > fast, "above_200d": last > slow,
    }


def compute_posture(layout: Layout, symbols: tuple[str, ...] = DEFAULT_INDICES) -> dict[str, Any]:
    if LEADER not in symbols:
        raise FinanceError(f"posture: {LEADER} must be among the symbols; it sets the primary trend")
    signals = {s: _signal(layout, s) for s in symbols}
    lead = signals[LEADER]
    lead_dd = Decimal(lead["drawdown_from_52w_high_pct"])
    above_slow = sum(1 for s in signals.values() if s["above_200d"])
    blockers, reducers = [], []
    if not lead["above_200d"]:
        blockers.append(f"{LEADER} below its {SMA_SLOW}-day average")
    if lead_dd >= BLOCK_DRAWDOWN_PCT:
        blockers.append(f"{LEADER} {lead_dd}% below its 52-week high")
    if not lead["above_50d"]:
        reducers.append(f"{LEADER} below its {SMA_FAST}-day average")
    if lead_dd >= REDUCED_DRAWDOWN_PCT:
        reducers.append(f"{LEADER} {lead_dd}% below its 52-week high")
    if above_slow < min(MIN_INDICES_ABOVE_SLOW, len(signals)):
        reducers.append(f"only {above_slow} of {len(signals)} indices above their {SMA_SLOW}-day average")
    posture = "no-new-entries" if blockers else "reduced" if reducers else "full"
    flagged = unadjusted_symbols(layout, list(symbols))
    result = {"posture": posture, "as_of": max(s["as_of"] for s in signals.values()),
              "reasons": blockers + reducers or ["trend and drawdown checks all clear"],
              "signals": list(signals.values()), "sources": ["market-data daily bars"],
              "rules": {"no-new-entries": f"{LEADER} below {SMA_SLOW}d or drawdown >= {BLOCK_DRAWDOWN_PCT}%",
                        "reduced": f"{LEADER} below {SMA_FAST}d, drawdown >= {REDUCED_DRAWDOWN_PCT}%, or fewer than "
                                   f"{MIN_INDICES_ABOVE_SLOW} indices above {SMA_SLOW}d"}}
    if flagged:
        result["warnings"] = [{"symbols": flagged, "warning": UNADJUSTED_WARNING}]
    return result


def write_posture(layout: Layout, result: dict[str, Any]) -> str:
    layout.ensure_base()
    out = layout.base / "posture"
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"{result['as_of']}.json"
    atomic_write_json(path, result)
    return str(path)
