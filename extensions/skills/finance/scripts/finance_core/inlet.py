"""Inlet: ingest a brokerage export through an agent-authored mapping into a validated snapshot.

Never guesses. Everything is built and validated in memory; only a clean record reaches disk.
"""

from __future__ import annotations

import re

import csv
import hashlib
import io
import json
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from .accounts import FORMATS, load_account, save_mapping, utc_now, write_snapshot
from .errors import FinanceError
from .layout import Layout, check_id
from .money import money_str, parse_money, parse_qty

ASSET_TYPES = {"equity", "etf", "option", "cash_equivalent", "other"}
OPTION_FIELDS = ("option_underlying", "option_expiry", "option_strike", "option_right",
                 "option_multiplier")
OPTIONAL_FIELDS = ("avg_cost", "cost_basis", "last_price", "asset_type", "currency")
TOLERANCE = Decimal("0.05")


def _is_number(value: Any) -> bool:
    try:
        parse_money(value, "value")
    except FinanceError:
        return False
    return True


def _blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _dig(obj: Any, dotted: str) -> Any:
    cur = obj
    for part in dotted.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        elif isinstance(cur, list) and part.isdigit() and int(part) < len(cur):
            cur = cur[int(part)]
        else:
            return None
    return cur


def mask_account_number(raw: str) -> str:
    return "****" + raw.strip()[-4:]


def _mask_matches(raw: str, mask: str) -> bool:
    """Compare the trailing characters both sides show, up to four, so a file showing only "496" matches mask "0496"."""
    found = re.search(r"[0-9A-Za-z]+$", raw.strip())
    shown, stored = (found.group(0) if found else ""), mask.strip()
    n = min(len(shown), len(stored), 4)
    return n > 0 and shown[-n:] == stored[-n:]


# ---------------------------------------------------------------- mapping validation

def _ref_errors(ref: Any, name: str, kinds: set[str]) -> list[str]:
    if not isinstance(ref, dict):
        return [f"{name}: reference must be an object"]
    present = [k for k in ("column", "path", "value", "regex") if k in ref]
    if len(present) != 1 or present[0] not in kinds:
        return [f"{name}: exactly one of {sorted(kinds)} required, got {sorted(ref)}"]
    if "regex" in present:
        try:
            re.compile(ref["regex"])
        except (re.error, TypeError) as exc:
            return [f"{name}: bad regex: {exc}"]
        if "group" in ref and not isinstance(ref["group"], int):
            return [f"{name}: group must be an integer"]
    return []


def validate_mapping(mapping: Any) -> list[str]:
    if not isinstance(mapping, dict):
        return ["mapping: must be an object"]
    errors: list[str] = []
    if mapping.get("schema_version") != 0:
        errors.append("schema_version: must be 0")
    header_line = mapping.get("header_line", 1)
    if isinstance(header_line, bool) or not isinstance(header_line, int) or header_line < 1:
        errors.append("header_line: must be an integer >= 1 (1-based line holding the CSV header)")
    try:
        check_id(mapping.get("broker_label"), "broker_label")
    except FinanceError as exc:
        errors.append(str(exc))
    fmt = mapping.get("format")
    if fmt not in FORMATS:
        errors.append(f"format: must be one of {sorted(FORMATS)}, got {fmt!r}")
    scalar_kinds = {"value", "regex", "column"} if fmt == "csv" else {"value", "path", "regex"}
    for key in ("as_of", "cash"):
        if key not in mapping:
            errors.append(f"{key}: required")
        else:
            errors += _ref_errors(mapping[key], key, scalar_kinds)
    for key in ("account_number", "control_total"):
        if key in mapping:
            errors += _ref_errors(mapping[key], key, scalar_kinds)
    rows = mapping.get("rows") or {}
    if fmt == "json" and not (isinstance(rows, dict) and isinstance(rows.get("rows_path"), str)):
        errors.append("rows.rows_path: required for json")
    if fmt == "csv" and rows.get("row_filter") is not None:
        flt = rows["row_filter"]
        if not (isinstance(flt, dict) and "column" in flt and ("equals" in flt or "not_equals" in flt)):
            errors.append("rows.row_filter: needs column and one of equals / not_equals")
    if fmt == "csv" and rows.get("require_numeric") is not None:
        cols = rows["require_numeric"]
        if not (isinstance(cols, list) and cols and all(isinstance(c, str) for c in cols)):
            errors.append("rows.require_numeric: must be a non-empty list of column names")
    row_kinds = {"column", "value"} if fmt == "csv" else {"column", "path", "value"}
    fields = mapping.get("fields")
    if not isinstance(fields, dict):
        errors.append("fields: required object")
        fields = {}
    for key in ("symbol", "quantity"):
        if key not in fields:
            errors.append(f"fields.{key}: required")
    for key in ("symbol", "quantity", *OPTIONAL_FIELDS, *OPTION_FIELDS):
        if key in fields:
            errors += _ref_errors(fields[key], f"fields.{key}", row_kinds)
    have = [k for k in OPTION_FIELDS if k in fields]
    if have and len(have) != len(OPTION_FIELDS):
        errors.append("fields: option_* refs must all be given together, missing "
                      f"{[k for k in OPTION_FIELDS if k not in fields]}")
    amap = mapping.get("asset_type_map", {})
    if not isinstance(amap, dict) or any(v not in ASSET_TYPES for v in amap.values()):
        errors.append(f"asset_type_map: values must be in {sorted(ASSET_TYPES)}")
    return errors


# ---------------------------------------------------------------- reading

def _parse_source(fmt: str, text: str, header_line: int) -> tuple[Any, list[dict[str, Any]] | None]:
    if fmt == "json":
        try:
            return json.loads(text, parse_float=str), None
        except json.JSONDecodeError as exc:
            raise FinanceError(f"source is not valid JSON: {exc}") from exc
    body = "\n".join(text.splitlines()[header_line - 1:])
    rows = list(csv.DictReader(io.StringIO(body)))
    return None, rows


def _scalar(ref: dict[str, Any], name: str, text: str, data: Any, first_row: dict | None) -> Any:
    if "value" in ref:
        return ref["value"]
    if "path" in ref:
        got = _dig(data, ref["path"])
    elif "column" in ref:
        got = (first_row if first_row is not None else (data if isinstance(data, dict) else {})
               ).get(ref["column"])
    else:
        match = re.search(ref["regex"], text, re.MULTILINE)
        try:
            got = match.group(ref.get("group", 0)) if match else None
        except IndexError as exc:
            raise FinanceError(f"{name}: regex has no group {ref.get('group')}") from exc
    if _blank(got):
        where = (f"regex {ref['regex']!r}" if "regex" in ref else f"path {ref['path']!r}" if "path" in ref
                 else f"column {ref['column']!r}")
        raise FinanceError(f"{name}: {where} matched nothing in the file")
    return got


def _row_ref(ref: dict[str, Any], row: dict[str, Any]) -> Any:
    if "value" in ref:
        return ref["value"]
    if "column" in ref:
        return row.get(ref["column"])
    return _dig(row, ref["path"])


def _record_date(raw: Any, fmt: str | None, name: str) -> str:
    try:
        text = _text(raw)
        return (datetime.strptime(text, fmt).date() if fmt else date.fromisoformat(text)).isoformat()
    except (ValueError, TypeError) as exc:
        raise FinanceError(f"{name}: unparseable date {raw!r}") from exc


def _repo_root(start: Path) -> Path | None:
    for candidate in [start, *start.parents]:
        if (candidate / ".git").exists():
            return candidate
    return None


def _refuse_repo_source(layout: Layout, source: Path) -> None:
    repo = _repo_root(layout.root)
    if repo is not None and source.is_relative_to(repo):
        raise FinanceError("source export must live outside the repo")


# ---------------------------------------------------------------- row building

def _build_position(row: dict[str, Any], fields: dict[str, Any], amap: dict[str, str],
                    base_currency: str, as_of: str) -> dict[str, Any]:
    get = lambda key: _row_ref(fields[key], row) if key in fields else None  # noqa: E731
    symbol = _text(get("symbol"))
    qty_raw = get("quantity")
    if _blank(qty_raw):
        raise FinanceError(f"{symbol}: quantity missing")
    qty = parse_qty(qty_raw, f"{symbol}.quantity")
    raw_type = _text(get("asset_type"))
    if raw_type:
        asset_type = amap.get(raw_type, raw_type if raw_type in ASSET_TYPES else None)
        if asset_type is None:
            raise FinanceError(f"{symbol}: unmapped asset type {raw_type!r}")
    elif "asset_type" in fields:
        raise FinanceError(f"{symbol}: asset_type column is mapped but the cell is blank")
    else:
        asset_type = "equity"
    option_vals = {k: get(k) for k in OPTION_FIELDS}
    any_option = any(not _blank(v) for v in option_vals.values())
    option: dict[str, Any] | None = None
    key = symbol
    multiplier = Decimal(1)
    if any_option or asset_type == "option":
        missing = [k for k in OPTION_FIELDS if _blank(option_vals[k])]
        if missing:
            raise FinanceError(f"{symbol}: option row missing {missing}")
        right = _text(option_vals["option_right"]).upper()
        if right not in ("C", "P"):
            raise FinanceError(f"{symbol}: option right must be C or P, got {right!r}")
        expiry = _record_date(option_vals["option_expiry"], None, f"{symbol}.option_expiry")
        strike = parse_money(option_vals["option_strike"], f"{symbol}.option_strike")
        multiplier = parse_money(option_vals["option_multiplier"], f"{symbol}.option_multiplier")
        if multiplier <= 0:
            raise FinanceError(f"{symbol}: option multiplier must be positive")
        option = {"underlying": _text(option_vals["option_underlying"]), "expiry": expiry,
                  "strike": money_str(strike), "right": right, "multiplier": money_str(multiplier)}
        asset_type = "option"
        key = f"{symbol}|{expiry}|{right}|{money_str(strike)}|{money_str(multiplier)}"
    avg = get("avg_cost")
    total_cost = get("cost_basis")
    if not _blank(total_cost):
        # The broker's total cost is exact; a per-share column is rounded to cents. Prefer the total.
        avg = money_str((parse_money(total_cost, f"{key}.cost_basis") / (qty * multiplier)).quantize(Decimal("0.00000001")))
    last = get("last_price")
    currency = _text(get("currency")) or base_currency
    return {
        "key": key, "symbol": symbol, "asset_type": asset_type, "option": option,
        "qty": money_str(qty),
        "avg_cost": None if _blank(avg) else money_str(parse_money(avg, f"{key}.avg_cost")),
        "last_price": None if _blank(last) else money_str(parse_money(last, f"{key}.last_price")),
        "price_as_of": as_of if not _blank(last) else None,
        "currency": currency, "_multiplier": multiplier,
    }


def _reconcile(positions: list[dict[str, Any]], cash: Decimal, control: Decimal) -> str | None:
    total = cash
    for pos in positions:
        if pos["last_price"] is None:
            return f"{pos['key']}: no last_price, control_total cannot be reconciled"
        total += Decimal(pos["qty"]) * Decimal(pos["last_price"]) * pos["_multiplier"]
    if abs(total - control) > TOLERANCE:
        return f"control_total mismatch: computed {money_str(total)}, file says {money_str(control)}"
    return None


# ---------------------------------------------------------------- ingest

def ingest(layout: Layout, account_id: str, mapping_path: str | Path, source_path: str | Path,
           ledger_positions: dict[str, Any] | None = None) -> dict[str, Any]:
    source = Path(source_path).resolve()
    _refuse_repo_source(layout, source)
    account = load_account(layout, account_id)
    mapping = json.loads(Path(mapping_path).read_text(encoding="utf-8"))
    reasons = validate_mapping(mapping)
    if mapping.get("format") not in account.get("import_formats", []):
        reasons.append(f"format: {mapping.get('format')!r} not in account import_formats")
    if reasons:
        raise FinanceError("mapping rejected", reasons)
    try:
        raw_bytes = source.read_bytes()
    except OSError as exc:
        raise FinanceError(f"cannot read source: {exc}") from exc
    text = raw_bytes.decode("utf-8-sig")
    data, csv_rows = _parse_source(mapping["format"], text, int(mapping.get("header_line", 1)))
    reasons = []
    base = account["base_currency"]

    def attempt(fn, *args):
        try:
            return fn(*args)
        except FinanceError as exc:
            reasons.append(str(exc))
            return None

    first = csv_rows[0] if csv_rows else None
    as_of = attempt(lambda: _record_date(
        _scalar(mapping["as_of"], "as_of", text, data, first), mapping.get("as_of_format"), "as_of"))
    cash = attempt(lambda: parse_money(_text(_scalar(mapping["cash"], "cash", text, data, first)), "cash"))
    control = None
    if "control_total" in mapping:
        control = attempt(lambda: parse_money(
            _text(_scalar(mapping["control_total"], "control_total", text, data, first)), "control_total"))
    raw_number = None
    if "account_number" in mapping:
        raw_number = attempt(lambda: _text(_scalar(mapping["account_number"], "account_number",
                                                   text, data, first)))
        mask = account.get("account_mask")
        if raw_number and mask and not _mask_matches(raw_number, mask):
            reasons.append(f"account_number: file shows {mask_account_number(raw_number)}, which does not match "
                           f"account mask {mask}; fix with: account config --account {account_id} "
                           f"--key account_mask --value <visible digits>")

    non_numeric: list[str] = []
    if mapping["format"] == "json":
        rows = _dig(data, mapping["rows"]["rows_path"])
        if not isinstance(rows, list):
            reasons.append(f"rows.rows_path: {mapping['rows']['rows_path']!r} is not a list")
            rows = []
    else:
        rows = csv_rows or []
        rows_spec = mapping.get("rows") or {}
        flt = rows_spec.get("row_filter")
        if flt and "equals" in flt:
            rows = [r for r in rows if _text(r.get(flt["column"])) == _text(flt["equals"])]
        elif flt:
            rows = [r for r in rows if _text(r.get(flt["column"])) != _text(flt["not_equals"])]
        for col in rows_spec.get("require_numeric") or []:
            kept = []
            for r in rows:
                if _is_number(r.get(col)):
                    kept.append(r)
                else:
                    label = _text(r.get("Symbol") or r.get("symbol") or "?")
                    non_numeric.append(f"{label}[{col}={_text(r.get(col))!r}]")
            rows = kept

    fields, amap = mapping["fields"], mapping.get("asset_type_map", {})
    positions: list[dict[str, Any]] = []
    seen: set[str] = set()
    skipped = 0
    for row in rows:
        if not isinstance(row, dict) or _blank(_row_ref(fields["symbol"], row)):
            skipped += 1
            continue
        pos = attempt(_build_position, row, fields, amap, base, as_of or "")
        if pos is None:
            continue
        if pos["key"] in seen:
            reasons.append(f"duplicate position key: {pos['key']}")
            continue
        seen.add(pos["key"])
        positions.append(pos)

    if not positions and not reasons:
        seen_cols = sorted(rows[0]) if rows and isinstance(rows[0], dict) else []
        reasons.append(f"no position rows found: header_line {mapping.get('header_line', 1)} (counts every physical "
                       f"line, blanks included) gave columns {seen_cols} and {len(rows)} data rows after the rows "
                       f"filter; the symbol mapping is {fields['symbol']}")
    if control is not None and cash is not None and not reasons:
        problem = _reconcile(positions, cash, control)
        if problem:
            reasons.append(problem)
    if reasons:
        raise FinanceError(f"ingest rejected: {len(reasons)} problem(s)", reasons)

    warnings: list[str] = []
    if skipped:
        warnings.append(f"skipped {skipped} rows with no symbol")
    if non_numeric:
        warnings.append(f"skipped {len(non_numeric)} non-position rows (require_numeric): {', '.join(non_numeric)}")
    if ledger_positions is not None:
        statement = {p["key"]: Decimal(p["qty"]) for p in positions}
        for key in sorted(set(statement) | set(ledger_positions)):
            have = Decimal(str(ledger_positions.get(key, 0)))
            want = statement.get(key, Decimal(0))
            if have != want:
                warnings.append(f"{key}: ledger qty {money_str(have)} differs from statement qty "
                                f"{money_str(want)}; statement wins")
    out_positions = [{k: v for k, v in p.items() if k not in ("key", "_multiplier")}
                     for p in positions]
    record = {
        "schema_version": 0, "account_id": account_id, "as_of": as_of, "base_currency": base,
        "cash": money_str(cash), "positions": out_positions,
        "source": {"file_sha256": hashlib.sha256(raw_bytes).hexdigest(), "imported_at": utc_now()},
        "warnings": warnings,
    }
    if raw_number and len(raw_number) > 4:
        blob = json.dumps(record) + json.dumps(mapping)
        if raw_number in blob:
            raise FinanceError("raw account number would be persisted; refusing")
    path = write_snapshot(layout, account_id, record)
    save_mapping(layout, account_id, mapping["broker_label"], mapping)
    return {"snapshot": str(path), "as_of": as_of, "positions": len(out_positions),
            "cash": record["cash"], "warnings": warnings,
            "reconciled": control is not None}
