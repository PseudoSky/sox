"""Fund look-through: what each held fund owns, and each underlying holding's share of an account.

Holdings come from the fund's own N-PORT filing on SEC EDGAR (keyless, public, lagged by the filing
schedule). N-PORT names securities by CUSIP, so tickers come from OpenFIGI's keyless mapping, cached
for good. Nothing here is a forecast: the weights are the fund's last reported portfolio, applied to
the position's current market value.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Callable

from . import paper
from .errors import FinanceError
from .layout import Layout, atomic_write_json, read_json, write_receipt
from .money import money_str, parse_money

Fetcher = Callable[[str, dict[str, str], bytes | None], tuple[int, bytes]]
FUND_TTL_DAYS = 30
MAP_TTL_DAYS = 7
MAX_FILINGS_SCANNED = 200
STALE_FILING_DAYS = 120
FIGI_BATCH = 10
FIGI_PAUSE_SECONDS = 2.6          # the keyless limit is 25 requests a minute
MF_MAP_URL = "https://www.sec.gov/files/company_tickers_mf.json"
PCT = Decimal("0.01")
EQUITY_CATEGORIES = {"EC", "EP"}  # N-PORT asset categories: common and preferred equity


def default_fetcher(url: str, headers: dict[str, str], data: bytes | None = None) -> tuple[int, bytes]:
    request = urllib.request.Request(url, headers=headers, data=data)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, b""
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise FinanceError(f"lookthrough: cannot reach {url}: {exc}") from exc


def _headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    contact = os.environ.get("FINANCE_SEC_CONTACT", "finance-skill@example.com")
    return {"User-Agent": f"finance-skill/0.1 ({contact})", **(extra or {})}


def _get(fetch: Fetcher, url: str, what: str, extra: dict[str, str] | None = None, pause: float = 0.12) -> bytes:
    time.sleep(pause)
    status, body = fetch(url, _headers(extra), None)
    if status not in (200, 206):
        hint = "; the SEC rejects anonymous clients, set FINANCE_SEC_CONTACT to your email" if status == 403 else ""
        raise FinanceError(f"lookthrough: {what} returned HTTP {status} ({url}){hint}")
    return body


def _fresh(record: dict[str, Any], days: int) -> bool:
    return datetime.now(timezone.utc) - datetime.fromisoformat(record["fetched_at"]) < timedelta(days=days)


def _fund_map(layout: Layout, fetch: Fetcher) -> dict[str, dict[str, Any]]:
    path = layout.base / "funds" / "series-map.json"
    if path.exists() and _fresh(read_json(path), MAP_TTL_DAYS):
        return read_json(path)["funds"]
    data = json.loads(_get(fetch, MF_MAP_URL, "fund list"))
    funds = {r[3].upper(): {"cik": r[0], "series": r[1], "class": r[2]} for r in data["data"]}
    atomic_write_json(path, {"fetched_at": datetime.now(timezone.utc).isoformat(), "source": MF_MAP_URL, "funds": funds})
    return funds


def _nport_filings(fetch: Fetcher, cik: int) -> list[tuple[str, str]]:
    top = json.loads(_get(fetch, f"https://data.sec.gov/submissions/CIK{cik:010d}.json", "filing list"))
    rows = [top["filings"]["recent"]]
    for extra in top["filings"].get("files", []):
        rows.append(json.loads(_get(fetch, f"https://data.sec.gov/submissions/{extra['name']}", "older filing list")))
    out: list[tuple[str, str]] = []
    for block in rows:
        out += [(block["accessionNumber"][i], block["filingDate"][i])
                for i in range(len(block["form"])) if block["form"][i] == "NPORT-P"]
    return sorted(out, key=lambda r: r[1], reverse=True)


def _parse_nport(xml: bytes) -> dict[str, Any]:
    root = ET.fromstring(xml)
    ns = {"n": root.tag.split("}")[0].strip("{")}
    period = root.findtext(".//n:repPdDate", namespaces=ns) or root.findtext(".//n:repPdEnd", namespaces=ns)
    holdings = []
    for s in root.findall(".//n:invstOrSec", ns):
        pct = s.findtext("n:pctVal", namespaces=ns)
        if pct is None:
            continue
        holdings.append({"name": (s.findtext("n:name", namespaces=ns) or "").strip(),
                         "cusip": next((c for c in [(s.findtext("n:cusip", namespaces=ns) or "").strip()] if len(c) == 9), None),
                         "category": s.findtext("n:assetCat", namespaces=ns) or "other",
                         "country": s.findtext("n:invCountry", namespaces=ns),
                         "pct": str(Decimal(pct))})
    return {"period_end": period, "holdings": holdings}


TICKERINSIDE = "https://tickerinside.com/api/v1/etf/{}.json"
ISSUER_TTL_DAYS = 2


def _issuer_file(symbol: str, fetch: Fetcher) -> dict[str, Any] | None:
    """The issuer's own daily holdings file via TickerInside (CC BY 4.0), or None when it only has a filing.

    A filing is no fresher than N-PORT itself, so only issuer-sourced funds use this layer.
    """
    try:
        status, body = fetch(TICKERINSIDE.format(symbol.lower().replace(".", "-")), _headers(), None)
        data = json.loads(body) if status == 200 else None
    except (FinanceError, ValueError) as exc:
        print(f"lookthrough: TickerInside unavailable for {symbol} ({exc}); using the SEC filing", file=sys.stderr)
        return None
    if not data or data.get("source_layer") != "issuer" or not data.get("holdings"):
        return None
    return {"symbol": symbol, "series": None, "cik": None, "accession": None, "filed": data["holdings_as_of"],
            "period_end": data["holdings_as_of"], "source_layer": "issuer-file",
            "holdings": [{"name": t, "cusip": None, "ticker": t, "category": "EC", "country": None, "pct": str(Decimal(str(w)))}
                         for t, w in data["holdings"].items()],
            "source": data.get("page_url"), "attribution": data.get("cite_as"),
            "fetched_at": datetime.now(timezone.utc).isoformat(), "filings_scanned": 0}


def fund_holdings(layout: Layout, symbol: str, fetch: Fetcher | None = None, refresh: bool = False,
                  issuer_files: bool = True) -> dict[str, Any]:
    """The fund's freshest holdings: the issuer's daily file when available, else the latest N-PORT filing.

    Cached under `.finance/funds/` (two days for an issuer file, a month for a filing).
    """
    fetch = fetch or default_fetcher
    symbol = symbol.upper()
    path = layout.base / "funds" / f"{symbol}.json"
    if path.exists() and not refresh:
        cached = read_json(path)
        issuer = cached.get("source_layer") == "issuer-file"
        usable = issuer == issuer_files if issuer else (not issuer_files or cached.get("issuer_file_checked"))
        if usable and _fresh(cached, ISSUER_TTL_DAYS if issuer else FUND_TTL_DAYS):
            return cached
    if issuer_files:
        record = _issuer_file(symbol, fetch)
        if record:
            atomic_write_json(path, record)
            return record
    entry = _fund_map(layout, fetch).get(symbol)
    if entry is None:
        raise FinanceError(f"lookthrough: {symbol} is not in the SEC's registered fund list (a stock, a foreign "
                           "fund or a non-registered product has no N-PORT filing)")
    scanned = 0
    for accession, filed in _nport_filings(fetch, entry["cik"])[:MAX_FILINGS_SCANNED]:
        scanned += 1
        url = f"https://www.sec.gov/Archives/edgar/data/{entry['cik']}/{accession.replace('-', '')}/primary_doc.xml"
        time.sleep(0.12)
        status, head = fetch(url, _headers({"Range": "bytes=0-6000"}), None)
        if status not in (200, 206):
            continue
        found = re.search(rb"<(?:\w+:)?seriesId>\s*(S\d{9})", head)
        if not found or found.group(1).decode() != entry["series"]:
            continue
        body = head if len(head) < 6001 else _get(fetch, url, "filing")
        parsed = _parse_nport(body)
        record = {"symbol": symbol, "series": entry["series"], "cik": entry["cik"], "accession": accession,
                  "filed": filed, "period_end": parsed["period_end"], "holdings": parsed["holdings"],
                  "source": url, "fetched_at": datetime.now(timezone.utc).isoformat(), "filings_scanned": scanned,
                  "issuer_file_checked": issuer_files}
        atomic_write_json(path, record)
        return record
    raise FinanceError(f"lookthrough: no N-PORT filing for {symbol} ({entry['series']}) among the newest {scanned} "
                       f"of CIK {entry['cik']}")


def _pick_listing(entries: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The US listing: the composite 'US' first, else any US exchange (codes start with U); never a '*' line."""
    us = [e for e in entries if e.get("exchCode", "").startswith("U") and "*" not in (e.get("ticker") or "*")
          and e.get("securityType2") in (None, "Common Stock", "Depositary Receipt", "REIT", "MLP")]
    us.sort(key=lambda e: e["exchCode"] != "US")
    return us[0] if us else None


def _map_cusips(layout: Layout, cusips: list[str], fetch: Fetcher) -> dict[str, dict[str, str | None]]:
    path = layout.base / "funds" / "cusip-ticker.json"
    known: dict[str, dict[str, str | None]] = read_json(path) if path.exists() else {}
    todo = sorted({c for c in cusips if c and c not in known})
    for i in range(0, len(todo), FIGI_BATCH):
        batch = todo[i:i + FIGI_BATCH]
        print(f"lookthrough: mapping tickers {i + len(batch)}/{len(todo)} (cached, so a rerun resumes)", file=sys.stderr, flush=True)
        body = json.dumps([{"idType": "ID_CINS" if c[0].isalpha() else "ID_CUSIP", "idValue": c} for c in batch]).encode()
        time.sleep(FIGI_PAUSE_SECONDS)
        status, reply = fetch("https://api.openfigi.com/v3/mapping", _headers({"Content-Type": "application/json"}), body)
        if status == 429:
            time.sleep(30)
            status, reply = fetch("https://api.openfigi.com/v3/mapping", _headers({"Content-Type": "application/json"}), body)
        if status != 200:
            raise FinanceError(f"lookthrough: ticker lookup returned HTTP {status}; rerun to resume (mapped tickers are cached)")
        for cusip, result in zip(batch, json.loads(reply)):
            data = _pick_listing(result.get("data") or [])
            known[cusip] = {"ticker": data["ticker"] if data else None, "name": data.get("name") if data else None}
        atomic_write_json(path, known)
    return known


_SUFFIX = re.compile(r"\b(class|cl|series|ser)\s+[a-z0-9]\b|\b(inc|corp|corporation|co|company|plc|nv|n v|ltd|sa|ag|holdings?|group|the)\b|[^a-z0-9 ]")


def issuer_key(name: str) -> str:
    """Name with share-class and legal-form words removed, so GOOGL and GOOG (Alphabet Class A/C) merge."""
    return " ".join(_SUFFIX.sub(" ", name.lower()).split())


def _position_values(layout: Layout, account_id: str) -> tuple[list[dict[str, Any]], Decimal, Decimal]:
    state = paper.positions_now(layout, account_id)
    rows, total = [], state["cash"]
    for pos in state["positions"].values():
        if pos.get("last_price") is None:
            continue
        mult = Decimal(pos["option"]["multiplier"]) if pos.get("option") else Decimal(1)
        value = parse_money(pos["qty"], "qty") * parse_money(pos["last_price"], "last_price") * mult
        rows.append({"symbol": pos["symbol"], "asset_type": pos["asset_type"], "option": bool(pos.get("option")),
                     "value": value})
        total += value
    return rows, state["cash"], total


def look_through(layout: Layout, account_ids: list[str], fetch: Fetcher | None = None, top: int = 25,
                 issuer_files: bool = True) -> dict[str, Any]:
    """Underlying exposure for one or several accounts, in each account's own equity and combined."""
    fetch = fetch or default_fetcher
    warnings: list[str] = []
    funds: dict[str, dict[str, Any]] = {}
    per_account, combined_value = [], Decimal(0)
    exposures: dict[str, dict[str, Any]] = {}

    def add(bucket: dict[str, dict[str, Any]], key: str, name: str, category: str, value: Decimal, via: str) -> None:
        row = bucket.setdefault(key, {"name": name, "category": category, "value": Decimal(0), "via": {}})
        row["value"] += value
        row["via"][via] = row["via"].get(via, Decimal(0)) + value

    account_exposures: dict[str, dict[str, dict[str, Any]]] = {}
    totals: dict[str, Decimal] = {}
    plan: list[tuple[str, list[dict[str, Any]], Decimal]] = []
    wanted: list[str] = []
    for account_id in account_ids:
        rows, cash, total = _position_values(layout, account_id)
        plan.append((account_id, rows, cash))
        totals[account_id] = total
        for r in rows:
            if r["asset_type"] in ("etf", "other") and not r["option"]:
                wanted.append(r["symbol"])
    for symbol in sorted(set(wanted)):
        try:
            funds[symbol] = fund_holdings(layout, symbol, fetch, issuer_files=issuer_files)
        except FinanceError as exc:
            warnings.append(f"{symbol}: {exc}; held as a single line")
    mapped = _map_cusips(layout, [h["cusip"] for f in funds.values() for h in f["holdings"]], fetch) if funds else {}
    names = {v["ticker"]: v["name"] for v in mapped.values() if v.get("ticker") and v.get("name")}
    by_issuer = {issuer_key(n): t for t, n in names.items()}
    for account_id, rows, cash in plan:
        bucket: dict[str, dict[str, Any]] = {}
        if cash:
            add(bucket, "CASH", "Cash", "cash", cash, "cash")
        for r in rows:
            sym, value = r["symbol"], r["value"]
            if r["option"]:
                add(bucket, f"OPTION:{sym}", f"{sym} options (not decomposed)", "option", value, sym)
            elif r["asset_type"] == "cash_equivalent":
                add(bucket, "CASH", "Cash", "cash", value, sym)
            elif sym in funds:
                for h in funds[sym]["holdings"]:
                    ticker = h.get("ticker") or ((mapped.get(h["cusip"]) or {}).get("ticker") if h["cusip"] else None)
                    ticker = ticker or (by_issuer.get(issuer_key(h["name"])) if not h["cusip"] else None)
                    key = ticker or (f"cusip:{h['cusip']}" if h["cusip"] else f"name:{h['name']}")
                    category = "equity" if h["category"] in EQUITY_CATEGORIES else f"other:{h['category']}"
                    add(bucket, key, names.get(key, h["name"]), category, value * Decimal(h["pct"]) / 100, sym)
                residual = Decimal(100) - sum((Decimal(h["pct"]) for h in funds[sym]["holdings"]), Decimal(0))
                if abs(residual) >= Decimal("0.5"):
                    add(bucket, "OTHER:" + sym, f"{sym} other net assets (cash, receivables, derivatives)", "other",
                        value * residual / 100, sym)
            else:
                add(bucket, sym, sym, "equity" if r["asset_type"] == "equity" else r["asset_type"], value, sym)
        account_exposures[account_id] = bucket
        for key, row in bucket.items():
            add(exposures, key, row["name"], row["category"], row["value"], account_id)
        combined_value += totals[account_id]

    def render(bucket: dict[str, dict[str, Any]], equity: Decimal, cash: bool = False) -> list[dict[str, Any]]:
        out = []
        for key, row in sorted(((k, r) for k, r in bucket.items() if (r["category"] == "cash") == cash), key=lambda kv: -kv[1]["value"]):
            out.append({"underlying": key, "name": row["name"], "category": row["category"],
                        "value": money_str(row["value"].quantize(PCT)),
                        "pct_of_equity": money_str((row["value"] / equity * 100).quantize(PCT)) if equity else None,
                        "via": {k: money_str(v.quantize(PCT)) for k, v in sorted(row["via"].items(), key=lambda kv: -kv[1])}})
        return out

    def issuers(bucket: dict[str, dict[str, Any]], equity: Decimal) -> list[dict[str, Any]]:
        merged: dict[str, dict[str, Any]] = {}
        for key, row in bucket.items():
            if row["category"] == "equity":
                m = merged.setdefault(issuer_key(row["name"]), {"name": row["name"], "value": Decimal(0), "tickers": []})
                m["value"] += row["value"]
                m["tickers"].append(key)
        rows = [m for m in merged.values() if len(m["tickers"]) > 1]
        return [{"issuer": m["name"], "tickers": sorted(m["tickers"]), "value": money_str(m["value"].quantize(PCT)),
                 "pct_of_equity": money_str((m["value"] / equity * 100).quantize(PCT)) if equity else None}
                for m in sorted(rows, key=lambda m: -m["value"])]

    stale = []
    for sym, f in funds.items():
        if f.get("period_end") and (date.today() - date.fromisoformat(f["period_end"][:10])).days > STALE_FILING_DAYS:
            stale.append(f"{sym} holdings are as of {f['period_end'][:10]}")
    unmapped = sorted({h["name"] for f in funds.values() for h in f["holdings"]
                       if h["category"] in EQUITY_CATEGORIES and h["cusip"] and not h.get("ticker") and not (mapped.get(h["cusip"]) or {}).get("ticker")})
    if funds and "FINANCE_SEC_CONTACT" not in os.environ:
        warnings.append("FINANCE_SEC_CONTACT is not set; SEC requests used a placeholder contact, set it to your email")
    if unmapped:
        warnings.append(f"{len(unmapped)} equity holdings have no current US listing (delisted, taken private or foreign-only) and are listed by CUSIP "
                        f"(for example {', '.join(unmapped[:3])})")
    if stale:
        warnings.append("older fund filings: " + "; ".join(stale) + "; the fund's weights have likely moved since")
    result = {
        "as_of": date.today().isoformat(), "accounts": account_ids,
        "basis": "--top counts non-cash rows (cash is listed apart); each fund's last reported N-PORT weights applied to the position's market value now; direct holdings "
                 "are 100% themselves; cash and money-market funds are cash; options are not decomposed; "
                 "a fund held inside another fund is not looked through",
        "funds": {s: {"period_end": f["period_end"], "filed": f["filed"], "securities": len(f["holdings"]), "layer": f.get("source_layer", "sec-nport"),
                      **({"attribution": f["attribution"]} if f.get("attribution") else {}),
                      "weight_sum": str(sum((Decimal(h["pct"]) for h in f["holdings"]), Decimal(0)).quantize(PCT)),
                      "source": f["source"]} for s, f in funds.items()},
        "per_account": [{"account_id": a, "equity": money_str(totals[a].quantize(PCT)),
                         "cash": render(account_exposures[a], totals[a], cash=True),
                         "exposure": render(account_exposures[a], totals[a])[:top],
                         "merged_share_classes": issuers(account_exposures[a], totals[a])} for a in account_ids],
        "warnings": warnings}
    if len(account_ids) > 1:
        result["combined"] = {"equity": money_str(combined_value.quantize(PCT)),
                              "cash": render(exposures, combined_value, cash=True),
                              "exposure": render(exposures, combined_value)[:top],
                              "merged_share_classes": issuers(exposures, combined_value),
                              "note": "accounts of different base currencies are not converted; combine only like currencies"}
    return result


def write_lookthrough(layout: Layout, result: dict[str, Any]) -> str:
    folder = layout.base / "lookthrough"
    folder.mkdir(parents=True, exist_ok=True)
    name = "-".join(result["accounts"]) if len(result["accounts"]) <= 3 else "combined"
    path = folder / f"{name}-{result['as_of']}.json"
    write_receipt(path, result)
    return str(path)
