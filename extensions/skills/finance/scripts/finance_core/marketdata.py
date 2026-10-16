"""Keyless daily bars from Yahoo's public chart endpoint (unofficial, personal use only).

Bars are cached under `.finance/market/` (git-ignored). `YahooFMPAdapter` has the shape of the
harvested screener's FMPClient so the screener runs without a key.
"""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Callable

from .errors import FinanceError
from .layout import Layout, atomic_write_json, read_json

HOSTS = ("query2.finance.yahoo.com", "query1.finance.yahoo.com")
USER_AGENT = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
SYMBOL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.^=-]{0,14}$")
RANGES = ("1mo", "3mo", "6mo", "1y", "2y", "5y")
RETRY_STATUS = {429, 500, 502, 503, 504}
BACKOFF_SECONDS = (1, 2, 4)
Opener = Callable[[str, dict[str, str]], "tuple[int, bytes]"]


def check_symbol(symbol: str) -> str:
    if not isinstance(symbol, str) or not SYMBOL_RE.match(symbol):
        raise FinanceError(f"symbol: must match {SYMBOL_RE.pattern}, got {symbol!r}")
    return symbol.upper()


def default_opener(url: str, headers: dict[str, str]) -> tuple[int, bytes]:
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except (urllib.error.URLError, TimeoutError) as exc:
        raise FinanceError(f"market-data: network error: {exc}") from exc


def _money(value: Any) -> str:
    return format(Decimal(str(value)).quantize(Decimal("0.0001")), "f")


def parse_chart(payload: dict[str, Any], symbol: str) -> dict[str, Any]:
    chart = payload.get("chart") or {}
    if chart.get("error"):
        raise FinanceError(f"market-data: {symbol}: {chart['error'].get('description', chart['error'])}")
    results = chart.get("result") or []
    if not results:
        raise FinanceError(f"market-data: {symbol}: no chart result")
    result = results[0]
    quote = (result.get("indicators", {}).get("quote") or [{}])[0]
    adj = ((result.get("indicators", {}).get("adjclose") or [{}])[0]).get("adjclose")
    bars = []
    for i, ts in enumerate(result.get("timestamp") or []):
        o, h, l, c, v = (quote.get(k, [None] * (i + 1))[i] for k in ("open", "high", "low", "close", "volume"))
        if None in (o, h, l, c):
            continue  # Yahoo emits null rows for non-trading intervals
        a = adj[i] if adj and adj[i] is not None else c
        bars.append({"date": datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d"),
                     "open": _money(o), "high": _money(h), "low": _money(l), "close": _money(c),
                     "adj_close": _money(a), "volume": int(v or 0)})
    if not bars:
        raise FinanceError(f"market-data: {symbol}: no usable bars")
    meta = result.get("meta") or {}
    events = result.get("events") or {}
    return {"symbol": symbol, "currency": meta.get("currency", "USD"),
            "name": meta.get("longName") or meta.get("shortName") or symbol,
            "bars": bars,
            "dividends": [{"date": datetime.fromtimestamp(e["date"], timezone.utc).strftime("%Y-%m-%d"),
                           "amount": _money(e["amount"])} for e in (events.get("dividends") or {}).values()],
            "splits": [{"date": datetime.fromtimestamp(e["date"], timezone.utc).strftime("%Y-%m-%d"),
                        "ratio": e.get("splitRatio", "")} for e in (events.get("splits") or {}).values()]}


def fetch_chart(symbol: str, range_: str = "1y", opener: Opener | None = None,
                sleep: Callable[[float], None] = time.sleep) -> dict[str, Any]:
    symbol = check_symbol(symbol)
    if range_ not in RANGES:
        raise FinanceError(f"range: must be one of {list(RANGES)}")
    opener = opener or default_opener
    query = urllib.parse.urlencode({"interval": "1d", "range": range_, "events": "div,split",
                                    "includeAdjustedClose": "true"})
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    last = 0
    for host in HOSTS:
        url = f"https://{host}/v8/finance/chart/{urllib.parse.quote(symbol)}?{query}"
        for attempt, delay in enumerate((0,) + BACKOFF_SECONDS):
            if delay:
                sleep(delay)
            status, body = opener(url, headers)
            last = status
            if status == 200:
                try:
                    return parse_chart(json.loads(body), symbol)
                except json.JSONDecodeError as exc:
                    raise FinanceError(f"market-data: {symbol}: response is not JSON") from exc
            if status == 404:
                raise FinanceError(f"market-data: {symbol}: not found (HTTP 404)")
            if status not in RETRY_STATUS:
                raise FinanceError(f"market-data: {symbol}: HTTP {status}")
    raise FinanceError(f"market-data: {symbol}: Yahoo returned HTTP {last} on every host after "
                       f"{len(BACKOFF_SECONDS) + 1} attempts each. Yahoo limits by network; retry later "
                       "or from another network.")


def _cache_path(layout: Layout, symbol: str):
    return layout.base / "market" / f"{symbol}.json"


def get_bars(layout: Layout, symbol: str, range_: str = "1y", ttl_hours: float = 12,
             refresh: bool = False, opener: Opener | None = None,
             sleep: Callable[[float], None] = time.sleep) -> dict[str, Any]:
    symbol = check_symbol(symbol)
    path = _cache_path(layout, symbol)
    if path.exists() and not refresh:
        cached = read_json(path)
        age = datetime.now(timezone.utc) - datetime.fromisoformat(cached["fetched_at"])
        if cached.get("range") == range_ and age < timedelta(hours=ttl_hours):
            return cached
    record = fetch_chart(symbol, range_, opener=opener, sleep=sleep)
    record.update({"range": range_, "source": "yahoo-chart (unofficial, personal use only)",
                   "fetched_at": datetime.now(timezone.utc).isoformat()})
    layout.ensure_base()
    atomic_write_json(path, record)
    return record


class YahooFMPAdapter:
    """Stands in for the harvested screener's FMPClient. Floats appear only here, at the boundary."""

    def __init__(self, layout: Layout, opener: Opener | None = None,
                 sleep: Callable[[float], None] = time.sleep) -> None:
        self.layout, self.opener, self.sleep = layout, opener, sleep
        self.cache: dict[str, Any] = {}
        self.api_calls_made = 0
        self.rate_limit_reached = False

    @staticmethod
    def _range_for(days: int) -> str:
        return "3mo" if days <= 60 else "1y" if days <= 250 else "2y"

    def _record(self, symbol: str, days: int) -> dict[str, Any] | None:
        key = f"{symbol}_{self._range_for(days)}"
        if key not in self.cache:
            self.api_calls_made += 1
            try:
                self.cache[key] = get_bars(self.layout, symbol, self._range_for(days),
                                           opener=self.opener, sleep=self.sleep)
            except FinanceError as exc:
                self.rate_limit_reached = self.rate_limit_reached or "429" in str(exc)
                self.cache[key] = None
        return self.cache[key]

    def get_historical_prices(self, symbol: str, days: int = 365) -> dict[str, Any] | None:
        record = self._record(symbol, days)
        if record is None:
            return None
        rows = [{"date": b["date"], "open": float(b["open"]), "high": float(b["high"]),
                 "low": float(b["low"]), "close": float(b["close"]), "adjClose": float(b["adj_close"]),
                 "volume": b["volume"]} for b in record["bars"]]
        return {"symbol": symbol, "historical": list(reversed(rows))[:days]}

    def get_quote(self, symbols: str) -> list[dict[str, Any]]:
        out = []
        for symbol in (s for s in symbols.split(",") if s):
            record = self._record(symbol, 365)
            if record is None:
                continue
            bars = record["bars"][-252:]
            volumes = [b["volume"] for b in record["bars"][-63:]]
            out.append({"symbol": symbol, "name": record["name"], "sector": "Unknown",
                        "price": float(bars[-1]["close"]),
                        "yearHigh": max(float(b["high"]) for b in bars),
                        "yearLow": min(float(b["low"]) for b in bars),
                        "avgVolume": sum(volumes) / len(volumes)})
        return out

    def get_batch_quotes(self, symbols: list[str]) -> dict[str, dict[str, Any]]:
        return {q["symbol"]: q for q in self.get_quote(",".join(symbols))}

    def get_sp500_constituents(self) -> None:
        return None  # no keyless constituent list; callers pass an explicit universe

    def get_api_stats(self) -> dict[str, Any]:
        return {"cache_entries": len(self.cache), "api_calls_made": self.api_calls_made,
                "rate_limit_reached": self.rate_limit_reached}
