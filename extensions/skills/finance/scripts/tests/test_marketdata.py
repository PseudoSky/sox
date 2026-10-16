"""Market-data tests. Payloads are SYNTHETIC and shaped like Yahoo's chart response; no network."""
from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from finance_core import marketdata  # noqa: E402
from finance_core.errors import FinanceError  # noqa: E402
from finance_core.layout import Layout  # noqa: E402

DAY = 86400
T0 = 1_760_000_000  # SYNTHETIC timestamps


def payload(rows, adj=None, dividends=None, splits=None):
    """rows: list of (open, high, low, close, volume) or None for a null row."""
    quote = {k: [None if r is None else r[i] for r in rows]
             for i, k in enumerate(("open", "high", "low", "close", "volume"))}
    result = {"meta": {"currency": "USD", "longName": "SYNTHETIC CO"},
              "timestamp": [T0 + i * DAY for i in range(len(rows))],
              "indicators": {"quote": [quote]}}
    if adj is not None:
        result["indicators"]["adjclose"] = [{"adjclose": adj}]
    events = {}
    if dividends:
        events["dividends"] = {str(T0): {"date": T0, "amount": dividends}}
    if splits:
        events["splits"] = {str(T0): {"date": T0, "splitRatio": splits}}
    if events:
        result["events"] = events
    return {"chart": {"result": [result], "error": None}}


ROWS = [(10, 11, 9, 10.5, 1000), None, (10.5, 12, 10, 11.25, 2000), (11, 13, 10.5, 12.0, 3000)]


class FakeOpener:
    def __init__(self, *statuses_and_bodies):
        self.script = list(statuses_and_bodies)
        self.calls = []

    def __call__(self, url, headers):
        self.calls.append(url)
        status, body = self.script.pop(0) if len(self.script) > 1 else self.script[0]
        return status, json.dumps(body).encode() if isinstance(body, dict) else body


def test_parse_skips_null_rows_and_falls_back_adj_close():
    rec = marketdata.parse_chart(payload(ROWS), "SYN")
    assert [b["close"] for b in rec["bars"]] == ["10.5000", "11.2500", "12.0000"]
    assert rec["bars"][0]["adj_close"] == "10.5000"
    assert rec["name"] == "SYNTHETIC CO" and rec["bars"][2]["volume"] == 3000


def test_parse_reads_adjclose_dividends_splits():
    rec = marketdata.parse_chart(payload(ROWS, adj=[10.4, 10.9, 11.1, 11.9], dividends=0.5, splits="2:1"), "SYN")
    assert rec["bars"][1]["adj_close"] == "11.1000"
    assert rec["dividends"][0]["amount"] == "0.5000" and rec["splits"][0]["ratio"] == "2:1"


def test_parse_surfaces_yahoo_error_and_empty_results():
    with pytest.raises(FinanceError, match="Not Found"):
        marketdata.parse_chart({"chart": {"result": None, "error": {"description": "Not Found"}}}, "SYN")
    with pytest.raises(FinanceError, match="no usable bars"):
        marketdata.parse_chart(payload([None, None]), "SYN")


@pytest.mark.parametrize("bad", ["../x", "AAPL;rm", "", "a" * 40, None, "A B"])
def test_symbol_validation_blocks_injection(bad):
    with pytest.raises(FinanceError):
        marketdata.check_symbol(bad)


def test_retry_with_backoff_then_success():
    sleeps = []
    op = FakeOpener((429, b"Too Many Requests"), (429, b""), (200, payload(ROWS)))
    rec = marketdata.fetch_chart("syn", opener=op, sleep=sleeps.append)
    assert rec["symbol"] == "SYN" and sleeps == [1, 2] and len(op.calls) == 3


def test_all_hosts_rate_limited_fails_with_actionable_message():
    sleeps = []
    op = FakeOpener((429, b"Too Many Requests"))
    with pytest.raises(FinanceError) as exc:
        marketdata.fetch_chart("SYN", opener=op, sleep=sleeps.append)
    assert "HTTP 429" in str(exc.value) and "another network" in str(exc.value)
    assert len(op.calls) == 8 and {u.split("/")[2] for u in op.calls} == set(marketdata.HOSTS)


def test_404_is_not_retried():
    op = FakeOpener((404, b"{}"))
    with pytest.raises(FinanceError, match="not found"):
        marketdata.fetch_chart("NOPE", opener=op, sleep=lambda s: None)
    assert len(op.calls) == 1


def test_cache_hit_refresh_and_ttl(tmp_path):
    layout = Layout(tmp_path)
    op = FakeOpener((200, payload(ROWS)))
    marketdata.get_bars(layout, "SYN", opener=op, sleep=lambda s: None)
    marketdata.get_bars(layout, "SYN", opener=op, sleep=lambda s: None)
    assert len(op.calls) == 1  # second call served from cache
    marketdata.get_bars(layout, "SYN", refresh=True, opener=op, sleep=lambda s: None)
    assert len(op.calls) == 2
    path = tmp_path / ".finance" / "market" / "SYN.json"
    cached = json.loads(path.read_text())
    cached["fetched_at"] = (datetime.now(timezone.utc) - timedelta(hours=13)).isoformat()
    path.write_text(json.dumps(cached))
    marketdata.get_bars(layout, "SYN", opener=op, sleep=lambda s: None)
    assert len(op.calls) == 3  # stale cache refetched
    assert (tmp_path / ".finance" / ".gitignore").read_text().strip() == "*"


def test_cache_miss_on_different_range(tmp_path):
    layout = Layout(tmp_path)
    op = FakeOpener((200, payload(ROWS)))
    marketdata.get_bars(layout, "SYN", "1y", opener=op, sleep=lambda s: None)
    marketdata.get_bars(layout, "SYN", "2y", opener=op, sleep=lambda s: None)
    assert len(op.calls) == 2


def test_adapter_shapes_match_fmp_client(tmp_path):
    rows = [(10 + i * 0.1, 11 + i * 0.1, 9 + i * 0.1, 10.5 + i * 0.1, 1_000_000) for i in range(300)]
    adapter = marketdata.YahooFMPAdapter(Layout(tmp_path), opener=FakeOpener((200, payload(rows))),
                                         sleep=lambda s: None)
    hist = adapter.get_historical_prices("SYN", days=260)
    assert len(hist["historical"]) == 260
    newest, older = hist["historical"][0], hist["historical"][1]
    assert newest["date"] > older["date"] and isinstance(newest["close"], float) and "adjClose" in newest
    quote = adapter.get_batch_quotes(["SYN"])["SYN"]
    assert quote["price"] == pytest.approx(10.5 + 299 * 0.1)
    assert quote["yearHigh"] >= quote["price"] >= quote["yearLow"] > 0
    assert quote["avgVolume"] == 1_000_000 and quote["name"] == "SYNTHETIC CO"
    assert adapter.get_sp500_constituents() is None
    assert adapter.get_api_stats()["api_calls_made"] >= 1


def test_adapter_failure_returns_none_and_flags_rate_limit(tmp_path):
    adapter = marketdata.YahooFMPAdapter(Layout(tmp_path), opener=FakeOpener((429, b"x")), sleep=lambda s: None)
    assert adapter.get_historical_prices("SYN", days=260) is None
    assert adapter.get_batch_quotes(["SYN"]) == {}
    assert adapter.get_api_stats()["rate_limit_reached"] is True


# ---------------------------------------------------------------- Nasdaq fallback

def nasdaq_payload(rows):
    return {"data": {"symbol": "SYN", "totalRecords": len(rows), "tradesTable": {"rows": rows}}, "status": None}


NASDAQ_ROWS = [  # newest first, as Nasdaq lists them (SYNTHETIC values)
    {"date": "10/15/2026", "close": "$12.00", "volume": "3,000", "open": "11.00", "high": "13.00", "low": "10.50"},
    {"date": "10/14/2026", "close": "N/A", "volume": "N/A", "open": "N/A", "high": "N/A", "low": "N/A"},
    {"date": "10/13/2026", "close": "10.50", "volume": "1,000", "open": "10.00", "high": "11.00", "low": "9.00"},
]
NASDAQ_NOT_FOUND = {"data": None, "message": None,
                    "status": {"rCode": 400, "bCodeMessage": [{"code": 1001, "errorMessage": "Symbol not exists."}]}}


class HostRouter:
    """Routes by URL host; a value of (status, body) or a callable taking the URL."""

    def __init__(self, yahoo, nasdaq):
        self.yahoo, self.nasdaq, self.calls = yahoo, nasdaq, []

    def __call__(self, url, headers):
        self.calls.append(url)
        target = self.nasdaq if "api.nasdaq.com" in url else self.yahoo
        status, body = target(url) if callable(target) else target
        return status, json.dumps(body).encode() if isinstance(body, dict) else body


def test_parse_nasdaq_strips_symbols_skips_na_and_orders_ascending():
    rec = marketdata.parse_nasdaq(nasdaq_payload(NASDAQ_ROWS), "SYN")
    assert [b["date"] for b in rec["bars"]] == ["2026-10-13", "2026-10-15"]
    assert rec["bars"][1]["close"] == "12.0000" and rec["bars"][1]["volume"] == 3000
    assert all(b["adj_close"] == b["close"] for b in rec["bars"])
    assert rec["adjusted"] is False and rec["dividends"] == [] and rec["splits"] == []


def test_parse_nasdaq_returns_none_for_unknown_symbol_and_errors_on_empty():
    assert marketdata.parse_nasdaq(NASDAQ_NOT_FOUND, "SYN") is None
    with pytest.raises(FinanceError, match="no usable bars"):
        marketdata.parse_nasdaq(nasdaq_payload([]), "SYN")


def test_auto_falls_back_to_nasdaq_when_yahoo_is_rate_limited(tmp_path):
    router = HostRouter((429, b"Too Many Requests"), (200, nasdaq_payload(NASDAQ_ROWS)))
    rec = marketdata.get_bars(Layout(tmp_path), "SYN", opener=router, sleep=lambda s: None)
    assert rec["provider"] == "nasdaq" and rec["adjusted"] is False and rec["source"].startswith("nasdaq")
    cached = json.loads((tmp_path / ".finance" / "market" / "SYN.json").read_text())
    assert cached["provider"] == "nasdaq" and cached["adjusted"] is False


def test_yahoo_success_is_adjusted_and_never_touches_nasdaq(tmp_path):
    router = HostRouter((200, payload(ROWS)), (500, b""))
    rec = marketdata.get_bars(Layout(tmp_path), "SYN", opener=router, sleep=lambda s: None)
    assert rec["provider"] == "yahoo" and rec["adjusted"] is True
    assert not any("api.nasdaq.com" in u for u in router.calls)


def test_nasdaq_retries_other_asset_class_when_symbol_not_in_first(tmp_path):
    def nasdaq(url):
        return (200, NASDAQ_NOT_FOUND) if "assetclass=stocks" in url else (200, nasdaq_payload(NASDAQ_ROWS))
    router = HostRouter((429, b""), nasdaq)
    rec = marketdata.get_bars(Layout(tmp_path), "SYN", opener=router, sleep=lambda s: None)
    assert rec["provider"] == "nasdaq"
    classes = [u.split("assetclass=")[1].split("&")[0] for u in router.calls if "api.nasdaq.com" in u]
    assert classes == ["stocks", "etf"]


def test_all_providers_failing_reports_each_cause(tmp_path):
    router = HostRouter((429, b""), (200, NASDAQ_NOT_FOUND))
    with pytest.raises(FinanceError) as exc:
        marketdata.get_bars(Layout(tmp_path), "SYN", opener=router, sleep=lambda s: None)
    message = str(exc.value)
    assert "all providers failed" in message and "yahoo:" in message and "429" in message
    assert "not found on Nasdaq" in message


def test_explicit_provider_is_respected(tmp_path):
    only_yahoo = HostRouter((429, b""), (200, nasdaq_payload(NASDAQ_ROWS)))
    with pytest.raises(FinanceError, match="yahoo:"):
        marketdata.get_bars(Layout(tmp_path), "SYN", provider="yahoo", opener=only_yahoo, sleep=lambda s: None)
    assert not any("api.nasdaq.com" in u for u in only_yahoo.calls)
    only_nasdaq = HostRouter((200, payload(ROWS)), (200, nasdaq_payload(NASDAQ_ROWS)))
    rec = marketdata.get_bars(Layout(tmp_path), "SYN", provider="nasdaq", opener=only_nasdaq)
    assert rec["provider"] == "nasdaq" and not any("yahoo.com" in u for u in only_nasdaq.calls)
    with pytest.raises(FinanceError, match="provider"):
        marketdata.get_bars(Layout(tmp_path), "SYN", provider="bogus")


def test_nasdaq_http_error_is_reported(tmp_path):
    router = HostRouter((429, b""), (503, b"down"))
    with pytest.raises(FinanceError, match="Nasdaq returned HTTP 503"):
        marketdata.get_bars(Layout(tmp_path), "SYN", opener=router, sleep=lambda s: None)


def test_yahoo_rate_limit_is_remembered_so_later_symbols_skip_it(tmp_path):
    layout = Layout(tmp_path)
    router = HostRouter((429, b"Too Many Requests"), (200, nasdaq_payload(NASDAQ_ROWS)))
    marketdata.get_bars(layout, "SYN", opener=router, sleep=lambda s: None)
    assert (tmp_path / ".finance" / "market" / "_yahoo_blocked.json").exists()
    before = len([u for u in router.calls if "yahoo.com" in u])
    marketdata.get_bars(layout, "SYN2", opener=router, sleep=lambda s: None)
    assert len([u for u in router.calls if "yahoo.com" in u]) == before  # no new Yahoo attempts


def test_expired_block_marker_retries_yahoo_and_explicit_provider_bypasses_it(tmp_path):
    layout = Layout(tmp_path)
    router = HostRouter((429, b""), (200, nasdaq_payload(NASDAQ_ROWS)))
    marketdata.get_bars(layout, "SYN", opener=router, sleep=lambda s: None)
    marker = tmp_path / ".finance" / "market" / "_yahoo_blocked.json"
    old = (datetime.now(timezone.utc) - timedelta(minutes=marketdata.YAHOO_BLOCK_MINUTES + 1)).isoformat()
    marker.write_text(json.dumps({"at": old, "reason": "x"}))
    healthy = HostRouter((200, payload(ROWS)), (500, b""))
    rec = marketdata.get_bars(layout, "SYN3", opener=healthy, sleep=lambda s: None)
    assert rec["provider"] == "yahoo"  # expired marker: Yahoo was tried again
    fresh_block = {"at": datetime.now(timezone.utc).isoformat(), "reason": "x"}
    marker.write_text(json.dumps(fresh_block))
    forced = HostRouter((200, payload(ROWS)), (500, b""))
    assert marketdata.get_bars(layout, "SYN4", provider="yahoo", opener=forced)["provider"] == "yahoo"
