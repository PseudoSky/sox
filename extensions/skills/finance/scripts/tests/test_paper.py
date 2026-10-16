"""Tests for finance_core.paper. Every fixture here is SYNTHETIC: invented symbols, prices and
statements, never real account data."""

import json
import sys
from decimal import Decimal
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from finance_core import accounts, paper  # noqa: E402
from finance_core.errors import FinanceError  # noqa: E402
from finance_core.layout import Layout  # noqa: E402

IMPORTED_AT = "2020-01-01T00:00:00.000000+00:00"
BAR_TS = "2026-01-05T14:30:00+00:00"


def bar(o, h, l, c, ts=BAR_TS):
    return {"open": o, "high": h, "low": l, "close": c, "ts": ts}


def make_account(tmp_path, options="holdings_only", positions=None, cash="10000", **kwargs):
    """SYNTHETIC account + snapshot (label SYNTHETIC in the snapshot data too)."""
    layout = Layout(tmp_path)
    accounts.create_account(layout, "acct", "USD", options=options, **kwargs)
    record = {"as_of": "2019-12-31", "account_id": "acct", "base_currency": "USD",
              "source": {"file_sha256": "ab" * 32, "imported_at": IMPORTED_AT, "note": "SYNTHETIC"},
              "cash": cash, "positions": positions if positions is not None else [], "warnings": []}
    accounts.write_snapshot(layout, "acct", record)
    return layout


def equity(symbol="SYNA", qty="100", avg="10"):
    return {"symbol": symbol, "asset_type": "equity", "option": None, "qty": qty, "avg_cost": avg,
            "last_price": avg, "price_as_of": "2019-12-31", "currency": "USD"}


def test_market_buy_fills_at_open_with_slippage_and_commission(tmp_path):
    layout = make_account(tmp_path, slippage_bps="100", commission={"per_share": "0.01", "per_contract": "0.65"})
    oid = paper.place_order(layout, "acct", {"symbol": "SYNA", "side": "buy", "qty": "10", "type": "market"})
    assert oid == "ord-1"
    result = paper.fill_bar(layout, "acct", oid, bar("50", "52", "49", "51"))
    assert result["status"] == "filled"
    assert Decimal(result["price"]) == Decimal("50.5")
    assert Decimal(result["fee"]) == Decimal("0.10")
    state = paper.positions_now(layout, "acct")
    assert state["cash"] == Decimal("10000") - Decimal("505") - Decimal("0.10")
    assert Decimal(state["positions"]["SYNA"]["qty"]) == 10
    assert Decimal(state["positions"]["SYNA"]["avg_cost"]) == Decimal("50.5")
    assert state["open_orders"] == []


def test_limit_buy_not_triggered_then_fills_at_min_open_limit(tmp_path):
    layout = make_account(tmp_path)
    oid = paper.place_order(layout, "acct", {"symbol": "SYNA", "side": "buy", "qty": "5", "type": "limit",
                                             "limit_price": "40"})
    assert paper.fill_bar(layout, "acct", oid, bar("45", "46", "41", "44")) == {"status": "open"}
    assert len(paper.open_orders(layout, "acct")) == 1
    result = paper.fill_bar(layout, "acct", oid, bar("38", "42", "37", "41"))
    assert result["status"] == "filled" and Decimal(result["price"]) == 38
    # A later bar that opens above the limit fills at the limit.
    oid2 = paper.place_order(layout, "acct", {"symbol": "SYNA", "side": "buy", "qty": "1", "type": "limit",
                                              "limit_price": "40"})
    assert Decimal(paper.fill_bar(layout, "acct", oid2, bar("45", "46", "39", "44"))["price"]) == 40


def test_stop_loss_gap_down_fills_at_open(tmp_path):
    layout = make_account(tmp_path, positions=[equity(qty="20")])
    oid = paper.place_order(layout, "acct", {"symbol": "SYNA", "side": "sell", "qty": "20", "type": "stop_loss",
                                             "stop_price": "9"})
    assert paper.fill_bar(layout, "acct", oid, bar("10", "11", "9.5", "10")) == {"status": "open"}
    result = paper.fill_bar(layout, "acct", oid, bar("7", "8", "6", "7"))  # gap below the stop
    assert result["status"] == "filled" and Decimal(result["price"]) == 7
    assert "SYNA" not in paper.positions_now(layout, "acct")["positions"]


def test_stop_loss_intrabar_fills_at_stop(tmp_path):
    layout = make_account(tmp_path, positions=[equity(qty="20")])
    oid = paper.place_order(layout, "acct", {"symbol": "SYNA", "side": "sell", "qty": "5", "type": "stop_loss",
                                             "stop_price": "9"})
    result = paper.fill_bar(layout, "acct", oid, bar("10", "11", "8", "9"))
    assert Decimal(result["price"]) == 9
    assert Decimal(paper.positions_now(layout, "acct")["positions"]["SYNA"]["qty"]) == 15  # partial reduction


def test_stop_entry_buy_triggers_at_max_open_stop(tmp_path):
    layout = make_account(tmp_path)
    oid = paper.place_order(layout, "acct", {"symbol": "SYNB", "side": "buy", "qty": "3", "type": "stop_entry",
                                             "stop_price": "20"})
    assert paper.fill_bar(layout, "acct", oid, bar("18", "19.5", "17", "19")) == {"status": "open"}
    assert Decimal(paper.fill_bar(layout, "acct", oid, bar("19", "21", "18", "20.5"))["price"]) == 20
    oid2 = paper.place_order(layout, "acct", {"symbol": "SYNB", "side": "buy", "qty": "1", "type": "stop_entry",
                                              "stop_price": "20"})
    assert Decimal(paper.fill_bar(layout, "acct", oid2, bar("22", "23", "21", "22"))["price"]) == 22


def test_sell_exceeding_held_refused_at_place_time(tmp_path):
    layout = make_account(tmp_path, positions=[equity(qty="5")])
    with pytest.raises(FinanceError):
        paper.place_order(layout, "acct", {"symbol": "SYNA", "side": "sell", "qty": "6", "type": "market"})
    with pytest.raises(FinanceError):
        paper.place_order(layout, "acct", {"symbol": "NOPE", "side": "sell", "qty": "1", "type": "market"})
    assert paper.open_orders(layout, "acct") == []


def test_fill_that_would_go_negative_is_rejected_at_fill_time(tmp_path):
    layout = make_account(tmp_path, positions=[equity(qty="10")])
    first = paper.place_order(layout, "acct", {"symbol": "SYNA", "side": "sell", "qty": "10", "type": "market"})
    second = paper.place_order(layout, "acct", {"symbol": "SYNA", "side": "sell", "qty": "10", "type": "market"})
    assert paper.fill_bar(layout, "acct", first, bar("10", "11", "9", "10"))["status"] == "filled"
    assert paper.fill_bar(layout, "acct", second, bar("10", "11", "9", "10"))["status"] == "rejected"
    events = [json.loads(x) for x in (layout.account_dir("acct") / "ledger.jsonl").read_text().splitlines()]
    assert events[-1]["type"] == "reject" and events[-1]["order_id"] == second
    assert paper.open_orders(layout, "acct") == []
    assert "SYNA" not in paper.positions_now(layout, "acct")["positions"]


def test_cancel_open_order_and_cancel_filled_raises(tmp_path):
    layout = make_account(tmp_path)
    oid = paper.place_order(layout, "acct", {"symbol": "SYNA", "side": "buy", "qty": "1", "type": "limit",
                                             "limit_price": "5"})
    paper.cancel_order(layout, "acct", oid)
    assert paper.open_orders(layout, "acct") == []
    with pytest.raises(FinanceError):
        paper.cancel_order(layout, "acct", oid)
    filled = paper.place_order(layout, "acct", {"symbol": "SYNA", "side": "buy", "qty": "1", "type": "market"})
    paper.fill_bar(layout, "acct", filled, bar("5", "6", "4", "5"))
    with pytest.raises(FinanceError):
        paper.cancel_order(layout, "acct", filled)
    with pytest.raises(FinanceError):
        paper.fill_bar(layout, "acct", filled, bar("5", "6", "4", "5"))


OPTION = {"underlying": "SYNA", "expiry": "2026-06-19", "strike": "55.00", "right": "C", "multiplier": "100"}


def test_option_order_refused_under_holdings_only(tmp_path):
    layout = make_account(tmp_path, options="holdings_only")
    with pytest.raises(FinanceError, match="holdings_only"):
        paper.place_order(layout, "acct", {"symbol": "SYNA", "side": "buy", "qty": "1", "type": "market",
                                           "asset": OPTION})


def test_option_order_accepted_under_full_fills(tmp_path):
    layout = make_account(tmp_path, options="full_fills", commission={"per_share": "0", "per_contract": "0.65"})
    oid = paper.place_order(layout, "acct", {"symbol": "SYNA", "side": "buy", "qty": "2", "type": "market",
                                             "asset": OPTION})
    result = paper.fill_bar(layout, "acct", oid, bar("1.5", "2", "1.2", "1.8"))
    assert result["status"] == "filled" and Decimal(result["fee"]) == Decimal("1.30")
    state = paper.positions_now(layout, "acct")
    key = "SYNA|2026-06-19|C|55|100"
    assert key in state["positions"]
    assert state["cash"] == Decimal("10000") - Decimal("1.5") * 2 * 100 - Decimal("1.30")
    assert paper.position_key(state["positions"][key]) == key


def test_positions_now_equals_snapshot_plus_ledger_replay(tmp_path):
    layout = make_account(tmp_path, positions=[equity(qty="10", avg="10")], cash="1000")
    buy = paper.place_order(layout, "acct", {"symbol": "SYNA", "side": "buy", "qty": "10", "type": "market"})
    paper.fill_bar(layout, "acct", buy, bar("20", "21", "19", "20"))
    sell = paper.place_order(layout, "acct", {"symbol": "SYNA", "side": "sell", "qty": "5", "type": "market"})
    paper.fill_bar(layout, "acct", sell, bar("30", "31", "29", "30"))
    state = paper.positions_now(layout, "acct")
    pos = state["positions"]["SYNA"]
    assert Decimal(pos["qty"]) == 15
    assert Decimal(pos["avg_cost"]) == 15  # (10*10 + 10*20) / 20, unchanged on the sell
    assert state["cash"] == Decimal("1000") - 200 + 150
    # the snapshot itself is untouched
    record, _ = accounts.load_current(layout, "acct")
    assert record["cash"] == "1000" and record["positions"][0]["qty"] == "10"


def test_events_before_snapshot_import_are_ignored(tmp_path):
    layout = make_account(tmp_path, positions=[equity(qty="10")], cash="1000")
    stale = {"type": "fill", "seq": 1, "ts": "2019-06-01T00:00:00.000000+00:00", "order_id": "ord-0",
             "price": "100", "qty": "10", "fee": "0", "side": "buy", "symbol": "SYNA", "option": None,
             "multiplier": "1", "bar_ts": None, "currency": "USD"}
    with (layout.account_dir("acct") / "ledger.jsonl").open("a") as handle:
        handle.write(json.dumps(stale) + "\n")
    state = paper.positions_now(layout, "acct")
    assert state["cash"] == Decimal("1000") and Decimal(state["positions"]["SYNA"]["qty"]) == 10
    oid = paper.place_order(layout, "acct", {"symbol": "SYNA", "side": "buy", "qty": "1", "type": "market"})
    assert oid == "ord-2"  # seq continues after the stale line


def test_reconcile_reports_discrepancies(tmp_path):
    layout = make_account(tmp_path, positions=[equity("SYNA", "10"), equity("SYNC", "4")], cash="500")
    statement = {"cash": "450", "positions": [equity("SYNA", "12"), equity("SYND", "7"),
                                              {"symbol": "SYNA", "asset_type": "option", "qty": "1",
                                               "option": {**OPTION, "strike": "55"}}]}
    found = {(d["kind"], d.get("key")) for d in paper.reconcile(layout, "acct", statement)}
    assert ("qty_mismatch", "SYNA") in found
    assert ("missing_in_ledger", "SYND") in found
    assert ("missing_in_ledger", "SYNA|2026-06-19|C|55|100") in found
    assert ("missing_in_statement", "SYNC") in found
    assert ("cash_mismatch", None) in found
    clean = {"cash": "500", "positions": [equity("SYNA", "10"), equity("SYNC", "4")]}
    assert paper.reconcile(layout, "acct", clean) == []
    # reconcile never mutates state
    assert Decimal(paper.positions_now(layout, "acct")["positions"]["SYNA"]["qty"]) == 10


def test_ledger_is_append_only(tmp_path):
    layout = make_account(tmp_path)
    path = layout.account_dir("acct") / "ledger.jsonl"
    oid = paper.place_order(layout, "acct", {"symbol": "SYNA", "side": "buy", "qty": "1", "type": "market"})
    before = path.read_text().splitlines()
    paper.fill_bar(layout, "acct", oid, bar("5", "6", "4", "5"))
    paper.place_order(layout, "acct", {"symbol": "SYNA", "side": "buy", "qty": "1", "type": "limit",
                                       "limit_price": "1"})
    after = path.read_text().splitlines()
    assert len(after) == len(before) + 2
    assert after[: len(before)] == before
    assert [json.loads(x)["seq"] for x in after] == [1, 2, 3]


def test_validation_errors(tmp_path):
    layout = make_account(tmp_path)
    base = {"symbol": "SYNA", "side": "buy", "qty": "1", "type": "market"}
    for patch in ({"type": "bogus"}, {"side": "short"}, {"qty": "0"}, {"qty": "-1"},
                  {"type": "limit"}, {"type": "stop_entry"}, {"type": "stop_loss"}):
        with pytest.raises(FinanceError):
            paper.place_order(layout, "acct", {**base, **patch})
