"""Money is a Decimal string with an explicit currency. Floats are rejected."""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation

from .errors import FinanceError

_CLEAN = re.compile(r"[\s,$€£]")
CURRENCY_RE = re.compile(r"^[A-Z]{3}$")


def parse_money(value: object, field: str = "value") -> Decimal:
    if value is None or isinstance(value, bool):
        raise FinanceError(f"{field}: missing")
    if isinstance(value, float):
        raise FinanceError(f"{field}: float rejected, pass the value as a string")
    if isinstance(value, int):
        return Decimal(value)
    if not isinstance(value, str):
        raise FinanceError(f"{field}: unsupported type {type(value).__name__}")
    text = value.strip()
    negative = text.startswith("(") and text.endswith(")")
    if negative:
        text = text[1:-1]
    text = _CLEAN.sub("", text)
    try:
        number = Decimal(text)
    except InvalidOperation as exc:
        raise FinanceError(f"{field}: not a number: {value!r}") from exc
    if not number.is_finite():
        raise FinanceError(f"{field}: not finite: {value!r}")
    return -number if negative else number


def money_str(number: Decimal) -> str:
    return format(number, "f")


def parse_qty(value: object, field: str = "quantity") -> Decimal:
    number = parse_money(value, field)
    if number == 0:
        raise FinanceError(f"{field}: zero quantity is not a position")
    return number


def check_currency(code: object, field: str = "currency") -> str:
    if not isinstance(code, str) or not CURRENCY_RE.match(code):
        raise FinanceError(f"{field}: expected a 3-letter ISO currency, got {code!r}")
    return code
