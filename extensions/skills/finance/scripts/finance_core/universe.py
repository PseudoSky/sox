"""Keyless index constituent list for screening: the public datasets/s-and-p-500-companies CSV.

The list is cached for a week under `.finance/market/` with its source and fetch time. Tickers are
returned in Yahoo's form (BRK.B becomes BRK-B).
"""
from __future__ import annotations

import csv
import io
from datetime import datetime, timedelta, timezone
from typing import Any

from .errors import FinanceError
from .layout import Layout, atomic_write_json, read_json
from .marketdata import Opener, default_opener

SOURCES = {"sp500": "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv"}
TTL_DAYS = 7


def _parse(body: bytes) -> list[dict[str, str]]:
    rows = csv.DictReader(io.StringIO(body.decode("utf-8")))
    out = [{"symbol": r["Symbol"].strip().replace(".", "-").upper(), "name": r["Security"].strip(),
            "sector": r["GICS Sector"].strip()} for r in rows if r.get("Symbol")]
    if len(out) < 100:
        raise FinanceError(f"universe: the source returned {len(out)} rows, expected an index-sized list")
    return out


def get_universe(layout: Layout, index: str = "sp500", sector: str | None = None, limit: int | None = None,
                 opener: Opener | None = None, refresh: bool = False) -> dict[str, Any]:
    if index not in SOURCES:
        raise FinanceError(f"universe: index must be one of {sorted(SOURCES)}, got {index!r}")
    path = layout.base / "market" / f"universe-{index}.json"
    record = None
    if path.exists() and not refresh:
        cached = read_json(path)
        if datetime.now(timezone.utc) - datetime.fromisoformat(cached["fetched_at"]) < timedelta(days=TTL_DAYS):
            record = cached
    if record is None:
        status, body = (opener or default_opener)(SOURCES[index], {"User-Agent": "Mozilla/5.0"})
        if status != 200:
            raise FinanceError(f"universe: HTTP {status} from {SOURCES[index]}")
        record = {"index": index, "source": SOURCES[index], "fetched_at": datetime.now(timezone.utc).isoformat(),
                  "members": _parse(body)}
        layout.ensure_base()
        atomic_write_json(path, record)
    members = record["members"]
    if sector:
        members = [m for m in members if m["sector"].lower() == sector.lower()]
        if not members:
            known = sorted({m["sector"] for m in record["members"]})
            raise FinanceError(f"universe: no members in sector {sector!r}; sectors: {', '.join(known)}")
    if limit is not None:
        members = members[:limit]
    return {"index": index, "source": record["source"], "fetched_at": record["fetched_at"], "count": len(members),
            "symbols": [m["symbol"] for m in members],
            "sectors": sorted({m["sector"] for m in members})}
