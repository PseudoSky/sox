"""On-disk layout under <root>/.finance/. Ids are validated so they cannot escape the tree."""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

from .errors import FinanceError

ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def check_id(value: object, field: str) -> str:
    if not isinstance(value, str) or not ID_RE.match(value):
        raise FinanceError(f"{field}: must match {ID_RE.pattern}, got {value!r}")
    return value


class Layout:
    def __init__(self, root: str | os.PathLike[str]):
        self.root = Path(root).resolve()
        self.base = self.root / ".finance"

    def account_dir(self, account_id: str) -> Path:
        return self.base / "accounts" / check_id(account_id, "account_id")

    def plans_dir(self) -> Path:
        return self.base / "plans"

    def analysis_dir(self) -> Path:
        return self.base / "analysis"

    def reports_dir(self) -> Path:
        return self.base / "reports"

    def ensure_base(self) -> None:
        self.base.mkdir(parents=True, exist_ok=True)
        ignore = self.base / ".gitignore"
        if not ignore.exists():
            atomic_write_text(ignore, "*\n")


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def atomic_write_json(path: Path, obj: Any) -> None:
    atomic_write_text(path, json.dumps(obj, indent=2, sort_keys=True, default=str) + "\n")


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise FinanceError(f"not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise FinanceError(f"invalid JSON in {path}: {exc}") from exc
