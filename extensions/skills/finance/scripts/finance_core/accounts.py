"""Paper accounts: config, snapshots, the current pointer. Ledger lives in paper.py."""

from __future__ import annotations

import re

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .errors import FinanceError
from .layout import Layout, atomic_write_json, check_id, read_json
from .money import check_currency, parse_money

FILL_MODES = {"open", "limit", "trigger", "trigger_or_gap"}
DEFAULT_FILL_RULES = {
    "market": {"fill": "open", "slippage": True},
    "limit": {"fill": "limit", "slippage": False},
    "stop_entry": {"fill": "trigger", "slippage": True},
    "stop_loss": {"fill": "trigger_or_gap", "slippage": True},
}
ORDER_TYPES = set(DEFAULT_FILL_RULES)
OPTION_MODES = {"holdings_only", "full_fills"}
FORMATS = {"csv", "json"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def create_account(layout: Layout, account_id: str, base_currency: str,
                   account_mask: str | None = None, label: str | None = None,
                   commission: dict[str, str] | None = None, slippage_bps: str = "0",
                   fill_rules: dict[str, Any] | None = None, options: str = "holdings_only",
                   import_formats: list[str] | None = None) -> dict[str, Any]:
    check_id(account_id, "account_id")
    check_currency(base_currency, "base_currency")
    target = layout.account_dir(account_id)
    if (target / "account.json").exists():
        raise FinanceError(f"account already exists: {account_id}")
    if options not in OPTION_MODES:
        raise FinanceError(f"options: must be one of {sorted(OPTION_MODES)}")
    formats = list(import_formats or ["csv", "json"])
    if not set(formats) <= FORMATS:
        raise FinanceError(f"import_formats: subset of {sorted(FORMATS)} required")
    rules = _merge_rules(fill_rules or {})
    comm = commission or {"per_share": "0", "per_contract": "0"}
    for key in ("per_share", "per_contract"):
        parse_money(comm.get(key, "0"), f"commission.{key}")
    parse_money(slippage_bps, "slippage_bps")
    account = {
        "schema_version": 0,
        "account_id": account_id,
        "label": label or account_id,
        "account_mask": account_mask,
        "base_currency": base_currency,
        "commission": {"per_share": str(comm.get("per_share", "0")),
                       "per_contract": str(comm.get("per_contract", "0"))},
        "slippage_bps": str(slippage_bps),
        "fill_rules": rules,
        "options": options,
        "import_formats": formats,
        "created_at": utc_now(),
    }
    layout.ensure_base()
    atomic_write_json(target / "account.json", account)
    return account


def _merge_rules(overrides: dict[str, Any]) -> dict[str, Any]:
    merged = {k: dict(v) for k, v in DEFAULT_FILL_RULES.items()}
    for order_type, rule in overrides.items():
        if order_type not in ORDER_TYPES:
            raise FinanceError(f"fill_rules: unknown order type {order_type!r}")
        if "fill" in rule and rule["fill"] not in FILL_MODES:
            raise FinanceError(f"fill_rules.{order_type}.fill: must be one of {sorted(FILL_MODES)}")
        merged[order_type].update(rule)
    return merged


def load_account(layout: Layout, account_id: str) -> dict[str, Any]:
    return read_json(layout.account_dir(account_id) / "account.json")


def list_accounts(layout: Layout) -> list[str]:
    base = layout.base / "accounts"
    if not base.is_dir():
        return []
    return sorted(p.name for p in base.iterdir() if (p / "account.json").exists())


def update_config(layout: Layout, account_id: str, key: str, value: Any) -> dict[str, Any]:
    account = load_account(layout, account_id)
    if key == "slippage_bps":
        parse_money(value, "slippage_bps")
        account[key] = str(value)
    elif key == "options":
        if value not in OPTION_MODES:
            raise FinanceError(f"options: must be one of {sorted(OPTION_MODES)}")
        account[key] = value
    elif key == "commission":
        for field in ("per_share", "per_contract"):
            parse_money(value.get(field, "0"), f"commission.{field}")
        account[key] = {f: str(value.get(f, "0")) for f in ("per_share", "per_contract")}
    elif key == "fill_rules":
        account[key] = _merge_rules(value)
    elif key == "account_mask":
        if not re.fullmatch(r"[0-9A-Za-z]{1,8}", str(value)):
            raise FinanceError("account_mask: 1 to 8 letters or digits, the visible tail shown by the broker")
        account[key] = str(value)
    elif key == "import_formats":
        if not set(value) <= FORMATS:
            raise FinanceError(f"import_formats: subset of {sorted(FORMATS)} required")
        account[key] = list(value)
    else:
        raise FinanceError(f"unknown config key: {key}")
    atomic_write_json(layout.account_dir(account_id) / "account.json", account)
    return account


def write_snapshot(layout: Layout, account_id: str, record: dict[str, Any]) -> Path:
    """Immutable snapshot, then the current pointer. Callers do validation first."""
    directory = layout.account_dir(account_id) / "snapshots"
    name = f"{record['as_of']}-{record['source']['file_sha256'][:8]}.json"
    path = directory / name
    if path.exists():
        raise FinanceError(f"snapshot already exists: {name} (same file imported twice)")
    atomic_write_json(path, record)
    atomic_write_json(layout.account_dir(account_id) / "current.json",
                      {"snapshot": name, "imported_at": record["source"]["imported_at"]})
    return path


def load_current(layout: Layout, account_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    pointer_path = layout.account_dir(account_id) / "current.json"
    if not pointer_path.is_file():
        raise FinanceError(f"account {account_id} has no imported holdings snapshot; run `inlet ingest --account "
                           f"{account_id} --mapping <file> --source <export>` first (see references/inlet-mapping.md)")
    pointer = read_json(pointer_path)
    record = read_json(layout.account_dir(account_id) / "snapshots" / pointer["snapshot"])
    return record, pointer


def save_mapping(layout: Layout, account_id: str, broker_label: str, mapping: dict[str, Any]) -> Path:
    check_id(broker_label, "broker_label")
    path = layout.account_dir(account_id) / "mappings" / f"{broker_label}.json"
    atomic_write_json(path, mapping)
    return path


def load_mapping(layout: Layout, account_id: str, broker_label: str) -> dict[str, Any]:
    return read_json(layout.account_dir(account_id) / "mappings" / f"{broker_label}.json")


__all__ = [
    "create_account", "load_account", "list_accounts", "update_config", "write_snapshot",
    "load_current", "save_mapping", "load_mapping", "utc_now", "DEFAULT_FILL_RULES",
    "ORDER_TYPES", "FILL_MODES", "OPTION_MODES", "FORMATS",
]
