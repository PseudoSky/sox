"""Keyless daily bars: Yahoo's public chart endpoint, with Nasdaq's public historical-quotes
endpoint as an automatic fallback. Both are unofficial and for personal use only.

Yahoo bars are split- and dividend-adjusted. Nasdaq bars are NOT adjusted (adj_close equals close,
no dividends or splits); the cached record says which provider produced it. Bars are cached under
`.finance/market/` (git-ignored). `YahooFMPAdapter` has the shape of the harvested screener's
FMPClient so the screener runs without a key.
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
# Yahoo answers HTTP 200 to exactly this bare token and HTTP 429 to curl, python-urllib, and
# full browser strings, measured 2026-10-19 from one network; the value is deliberate.
YAHOO_USER_AGENT = "Mozilla/5.0"
USER_AGENT = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
SYMBOL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.^=-]{0,14}$")
RANGES = ("1mo", "3mo", "6mo", "1y", "2y", "5y")
RETRY_STATUS = {429, 500, 502, 503, 504}
BACKOFF_SECONDS = (1, 2, 4)
PROVIDERS = ("auto", "yahoo", "nasdaq")
NASDAQ_HOST = "api.nasdaq.com"
NASDAQ_CLASSES = ("stocks", "etf")
YAHOO_BLOCK_MINUTES = 30
RANGE_DAYS = {"1mo": 31, "3mo": 92, "6mo": 183, "1y": 366, "2y": 731, "5y": 1827}
Opener = Callable[[str, dict[str, str]], "tuple[int, bytes]"]


def check_symbol(symbol: str) -> str:
    if not isinstance(symbol, str) or not SYMBOL_RE.match(symbol):
        raise FinanceError(f"symbol: must match {SYMBOL_RE.pattern}, got {symbol!r}")
    return symbol.upper()


def bar_in_progress(bar_date: str, now: datetime | None = None) -> bool:
    """True when `bar_date` is today's US-Eastern date and the regular session has not closed (16:00 ET)."""
    from zoneinfo import ZoneInfo
    eastern = (now or datetime.now(timezone.utc)).astimezone(ZoneInfo("America/New_York"))
    return bar_date == eastern.date().isoformat() and (eastern.hour, eastern.minute) < (16, 0)


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
    headers = {"User-Agent": YAHOO_USER_AGENT, "Accept": "application/json"}
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


def _num(text: str) -> Decimal:
    return Decimal(re.sub(r"[$,\s]", "", text))


def parse_nasdaq(payload: dict[str, Any], symbol: str) -> dict[str, Any] | None:
    """Return a record, or None when Nasdaq says the symbol does not exist in this asset class."""
    if payload.get("data") is None:
        return None
    rows = ((payload["data"].get("tradesTable") or {}).get("rows")) or []
    bars = []
    for row in reversed(rows):  # Nasdaq lists newest first
        try:
            o, h, l, c = (_num(row[k]) for k in ("open", "high", "low", "close"))
            v = int(_num(row["volume"]))
            day = datetime.strptime(row["date"], "%m/%d/%Y").strftime("%Y-%m-%d")
        except (KeyError, ValueError, ArithmeticError):
            continue  # "N/A" cells and malformed rows
        bars.append({"date": day, "open": _money(o), "high": _money(h), "low": _money(l),
                     "close": _money(c), "adj_close": _money(c), "volume": v})
    if not bars:
        raise FinanceError(f"market-data: {symbol}: Nasdaq returned no usable bars")
    return {"symbol": symbol, "currency": "USD", "name": symbol, "bars": bars,
            "dividends": [], "splits": [], "adjusted": False}


def fetch_nasdaq(symbol: str, range_: str = "1y", opener: Opener | None = None,
                 today: datetime | None = None) -> dict[str, Any]:
    symbol = check_symbol(symbol)
    if range_ not in RANGES:
        raise FinanceError(f"range: must be one of {list(RANGES)}")
    opener = opener or default_opener
    end = (today or datetime.now(timezone.utc)).date()
    start = end - timedelta(days=RANGE_DAYS[range_])
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json, text/plain, */*",
               "Origin": "https://www.nasdaq.com", "Referer": "https://www.nasdaq.com/"}
    for asset_class in NASDAQ_CLASSES:
        query = urllib.parse.urlencode({"assetclass": asset_class, "fromdate": start.isoformat(),
                                        "todate": end.isoformat(), "limit": 5000})
        url = f"https://{NASDAQ_HOST}/api/quote/{urllib.parse.quote(symbol)}/historical?{query}"
        status, body = opener(url, headers)
        if status != 200:
            raise FinanceError(f"market-data: {symbol}: Nasdaq returned HTTP {status}")
        try:
            record = parse_nasdaq(json.loads(body), symbol)
        except json.JSONDecodeError as exc:
            raise FinanceError(f"market-data: {symbol}: Nasdaq response is not JSON") from exc
        if record is not None:
            return record
    raise FinanceError(f"market-data: {symbol}: not found on Nasdaq ({', '.join(NASDAQ_CLASSES)})")


def _cache_path(layout: Layout, symbol: str):
    return layout.base / "market" / f"{symbol}.json"


def get_bars(layout: Layout, symbol: str, range_: str = "1y", ttl_hours: float = 12,
             refresh: bool = False, opener: Opener | None = None,
             sleep: Callable[[float], None] = time.sleep, provider: str = "auto") -> dict[str, Any]:
    symbol = check_symbol(symbol)
    if provider not in PROVIDERS:
        raise FinanceError(f"provider: must be one of {list(PROVIDERS)}")
    path = _cache_path(layout, symbol)
    if path.exists() and not refresh:
        cached = read_json(path)
        age = datetime.now(timezone.utc) - datetime.fromisoformat(cached["fetched_at"])
        covers = cached.get("range") in RANGES and RANGES.index(cached["range"]) >= RANGES.index(range_)
        if covers and age < timedelta(hours=ttl_hours):
            return cached
    block = layout.base / "market" / "_yahoo_blocked.json"
    yahoo_blocked = False
    if provider == "auto" and block.exists():
        since = datetime.fromisoformat(read_json(block)["at"])
        yahoo_blocked = datetime.now(timezone.utc) - since < timedelta(minutes=YAHOO_BLOCK_MINUTES)
    order = ("nasdaq",) if yahoo_blocked else ("yahoo", "nasdaq") if provider == "auto" else (provider,)
    failures: list[str] = []
    record = None
    for name in order:
        try:
            if name == "yahoo":
                record = fetch_chart(symbol, range_, opener=opener, sleep=sleep)
                record["adjusted"] = True
            else:
                record = fetch_nasdaq(symbol, range_, opener=opener)
            record["provider"] = name
            break
        except FinanceError as exc:
            failures.append(f"{name}: {exc}")
            if name == "yahoo" and provider == "auto" and "HTTP 429" in str(exc):
                layout.ensure_base()
                atomic_write_json(block, {"at": datetime.now(timezone.utc).isoformat(), "reason": str(exc)})
    if record is None:
        raise FinanceError("market-data: all providers failed: " + " | ".join(failures))
    record.update({"range": range_, "source": f"{record['provider']} (unofficial, personal use only)",
                   "fetched_at": datetime.now(timezone.utc).isoformat()})
    layout.ensure_base()
    atomic_write_json(path, record)
    return record


def unadjusted_symbols(layout: Layout, symbols: list[str]) -> list[str]:
    """Symbols whose cached bars came from a provider without adjusted closes, dividends or splits."""
    out = []
    for symbol in symbols:
        path = _cache_path(layout, symbol)
        if path.exists() and read_json(path).get("adjusted") is False:
            out.append(symbol)
    return out


UNADJUSTED_WARNING = ("these symbols use unadjusted prices (no dividends or splits): returns, gaps and "
                      "moving averages near a split or ex-dividend date are unreliable; rerun when Yahoo answers")


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
