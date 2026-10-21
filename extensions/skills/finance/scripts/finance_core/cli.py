"""CLI for the finance core. Every command prints JSON on stdout; rejections print JSON on stderr and exit 2.

Usage: python3 -m finance_core --root <dir> <group> <command> [options]
--root is the directory that holds .finance/ (default: current directory).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

from . import accounts, analyze, breakout, edge, income, inlet, intraday, marketdata, paper, plans, posture, recommend, report, screen, universe
from .errors import FinanceError
from .layout import Layout, read_json


def _jsonable(obj: Any) -> Any:
    if isinstance(obj, Decimal):
        return format(obj, "f")
    if isinstance(obj, dict):
        return {k: _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(v) for v in obj]
    if isinstance(obj, Path):
        return str(obj)
    return obj


def _emit(obj: Any) -> None:
    sys.stdout.write(json.dumps(_jsonable(obj), indent=2, sort_keys=True) + "\n")


def _load_json_arg(value: str) -> Any:
    if value == "-":
        return json.load(sys.stdin)
    if value.startswith("{") or value.startswith("["):
        return json.loads(value)
    return read_json(Path(value))


def cmd_account(args: argparse.Namespace, layout: Layout) -> Any:
    if args.action == "create":
        commission = json.loads(args.commission) if args.commission else None
        fill_rules = json.loads(args.fill_rules) if args.fill_rules else None
        formats = args.import_formats.split(",") if args.import_formats else None
        return accounts.create_account(
            layout, args.account, args.base_currency, account_mask=args.account_mask,
            label=args.label, commission=commission, slippage_bps=args.slippage_bps,
            fill_rules=fill_rules, options=args.options, import_formats=formats)
    if args.action == "list":
        return {"accounts": accounts.list_accounts(layout)}
    if args.action == "show":
        return accounts.load_account(layout, args.account)
    if args.action == "config":
        literal = args.value if args.key == "account_mask" else _load_json_arg(args.value)
        return accounts.update_config(layout, args.account, args.key, literal)
    raise FinanceError(f"unknown account action {args.action}")


def cmd_inlet(args: argparse.Namespace, layout: Layout) -> Any:
    if args.action == "check-mapping":
        errors = inlet.validate_mapping(_load_json_arg(args.mapping))
        if errors:
            raise FinanceError("mapping invalid", errors)
        return {"valid": True, "errors": []}
    if args.action == "ingest":
        ledger = None
        if (layout.account_dir(args.account) / "current.json").exists():
            held = paper.positions_now(layout, args.account)["positions"]
            ledger = {key: pos["qty"] for key, pos in held.items()}
        return inlet.ingest(layout, args.account, Path(args.mapping), Path(args.source),
                            ledger_positions=ledger)
    raise FinanceError(f"unknown inlet action {args.action}")


def _latest_bar(layout: Layout, account_id: str, order_id: str) -> dict[str, Any]:
    """Most recent daily bar of the order's symbol; `partial` is True while that session is still open."""
    order = next((o for o in paper.open_orders(layout, account_id) if o["order_id"] == order_id), None)
    if order is None:
        raise FinanceError(f"order {order_id} is not open")
    if order.get("option"):
        raise FinanceError("paper fill --latest-bar covers equity orders; pass --bar for an option")
    last = marketdata.get_bars(layout, order["symbol"], "1y")["bars"][-1]
    return {"open": last["open"], "high": last["high"], "low": last["low"], "close": last["close"], "ts": last["date"],
            "partial": marketdata.bar_in_progress(last["date"])}


def cmd_paper(args: argparse.Namespace, layout: Layout) -> Any:
    if args.action == "order":
        order = _load_json_arg(args.order)
        if "quantity" in order and "qty" not in order:
            raise FinanceError("order: the quantity field is 'qty', not 'quantity'")
        return {"order_id": paper.place_order(layout, args.account, order)}
    if args.action == "fill":
        if args.latest_bar:
            bar = _latest_bar(layout, args.account, args.order_id)
        elif args.bar:
            bar = _load_json_arg(args.bar)
        else:
            raise FinanceError("paper fill: pass --bar <json> or --latest-bar")
        partial = bool(bar.pop("partial", False))
        result = paper.fill_bar(layout, args.account, args.order_id, bar)
        if partial:
            result["warnings"] = [f"the {bar['ts']} bar is still forming (the session closes 16:00 ET): its high, low "
                                  "and close will change; the fill used what is cached now. Refetch after the close "
                                  "with `market bars --refresh` for a final bar."]
        return result
    if args.action == "cancel":
        paper.cancel_order(layout, args.account, args.order_id)
        return {"cancelled": args.order_id}
    if args.action == "positions":
        return paper.positions_now(layout, args.account)
    if args.action == "open-orders":
        return {"open_orders": paper.open_orders(layout, args.account)}
    if args.action == "reconcile":
        record = read_json(Path(args.statement))
        return {"discrepancies": paper.reconcile(layout, args.account, record)}
    raise FinanceError(f"unknown paper action {args.action}")


def cmd_plan(args: argparse.Namespace, layout: Layout) -> Any:
    if args.action == "validate":
        errors = plans.validate_plan(_load_json_arg(args.plan))
        return {"valid": not errors, "errors": errors}
    if args.action == "put":
        approval = _load_json_arg(args.approval) if args.approval else None
        path = plans.put_plan(layout, _load_json_arg(args.plan), approval=approval)
        return {"written": path}
    if args.action == "list":
        return {"plans": plans.list_plans(layout, args.account, args.status, args.as_of)}
    if args.action == "get":
        return plans.get_plan(layout, args.plan_id)
    raise FinanceError(f"unknown plan action {args.action}")


def cmd_intraday(args: argparse.Namespace, layout: Layout) -> Any:
    if args.action == "entry":
        weekday = args.weekday if args.weekday is not None else datetime.now().weekday()
        return intraday.check_entry(args.grade, args.signal, args.rvol, args.time, args.trend_age, weekday,
                                    args.open_positions, args.trades_today, args.day_pnl, args.account_size, args.symbol,
                                    args.max_trade_pct, args.max_daily_loss_pct, args.premium, args.contracts)
    return intraday.check_exit(args.pnl_pct, args.grade, args.signal_flipped, args.time, args.entry_grade)


def cmd_market(args: argparse.Namespace, layout: Layout) -> Any:
    if args.action == "bars":
        record = marketdata.get_bars(layout, args.symbol, args.range, refresh=args.refresh, provider=args.provider)
        bars = record["bars"]
        cutoff = (date.fromisoformat(bars[-1]["date"]) - timedelta(days=marketdata.RANGE_DAYS[args.range])).isoformat()
        shown_bars = [b for b in bars if b["date"] >= cutoff] or bars
        out = {"symbol": record["symbol"], "range": record["range"], "bars": len(shown_bars), "cached_bars": len(bars),
                "first": shown_bars[0]["date"], "last": bars[-1]["date"], "last_close": bars[-1]["close"],
                "fetched_at": record["fetched_at"], "source": record["source"],
                "provider": record["provider"], "adjusted": record["adjusted"],
                "cache": str(layout.base / "market" / f"{record['symbol']}.json")}
        if marketdata.bar_in_progress(bars[-1]["date"]):
            out["warnings"] = [f"the {bars[-1]['date']} bar is still forming (before 16:00 ET): last_close is an intraday "
                               "price that changes on every refresh; run `market bars --refresh` after the close for the final bar"]
        return out
    if args.action == "universe":
        return universe.get_universe(layout, args.index, sector=args.sector, limit=args.limit, refresh=args.refresh)
    if args.action == "screen":
        if bool(args.symbols) == bool(args.index):
            raise FinanceError("screen: pass exactly one of --symbols or --index")
        symbols = ([s for s in args.symbols.split(",") if s] if args.symbols
                   else universe.get_universe(layout, args.index, sector=args.sector, limit=args.limit)["symbols"])
        return screen.run_screen(layout, symbols, max_candidates=args.max_candidates, top=args.top)
    if args.action == "posture":
        result = posture.compute_posture(layout, tuple(s for s in args.symbols.split(",") if s))
        result["receipt"] = posture.write_posture(layout, result)
        return result
    if args.action == "edge":
        return edge.run_edge(layout, [x for x in args.symbols.split(",") if x], args.range,
                             dry_run=not args.export, as_of=args.as_of)
    raise FinanceError(f"unknown market action {args.action}")


def _plan_breakouts(args: argparse.Namespace, layout: Layout) -> Any:
    equity = analyze.analyze_account(layout, args.account)["equity"]
    risk_pct, state = args.risk_pct, None
    current = None if args.ignore_posture else posture.latest_posture(layout)
    if current is not None:
        state = {"posture": current["posture"], "as_of": current["as_of"]}
        if current["posture"] == "no-new-entries":
            raise FinanceError(f"posture is no-new-entries ({current['as_of']}): new entries stop at P5; "
                               "pass --ignore-posture to size anyway", current["reasons"])
        if current["posture"] == "reduced":
            risk_pct = str(Decimal(risk_pct) * posture.REDUCED_RISK_FACTOR)
            state["risk_pct_used"] = risk_pct
    planner = screen.run_planner(layout, args.screen, equity, risk_pct)
    built = screen.plans_from_planner(layout, args.account, planner, write=args.write)
    return {"account_equity": equity, "posture": state, "planner_output": planner["planner_output"],
            "summary": planner["result"]["summary"],
            "plans": [{"plan_id": p["plan_id"], "symbol": p["symbol"], "status": p["status"]} for p in built],
            "written": args.write}


def cmd_breakout(args: argparse.Namespace, layout: Layout) -> Any:
    if args.action == "plan":
        return _plan_breakouts(args, layout)
    if args.action == "size":
        equity = analyze.analyze_account(layout, args.account)["equity"]
        sized = screen.run_sizer(layout, equity, args.entry, args.stop, args.risk_pct, args.max_position_pct)
        r = sized["result"]
        return {"account_equity": equity, "entry": args.entry, "stop": args.stop, "risk_pct": args.risk_pct,
                "max_position_pct": args.max_position_pct, "shares": r["final_recommended_shares"],
                "position_value": r["final_position_value"], "risk_dollars": r.get("final_risk_dollars"),
                "risk_pct_of_equity": r.get("final_risk_pct"), "binding_constraint": r.get("binding_constraint") or "none: the risk budget and the position cap allow the same share count",
                "sizer_output": sized["sizer_output"],
                "note": "shares are floored; the stop is the caller's, nothing here places an order or stores a plan"}
    item = _load_json_arg(args.item)
    digest = hashlib.sha256(json.dumps(item, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    plan = breakout.translate_breakout(item, args.account, args.plan_id, digest, mode=args.mode)
    if args.write:
        return {"written": plans.put_plan(layout, plan), "plan_id": args.plan_id}
    return plan


def cmd_analyze(args: argparse.Namespace, layout: Layout) -> Any:
    if args.consolidated:
        return analyze.consolidated(layout)
    if args.income:
        result = income.income_for_account(layout, args.account, as_of=args.as_of)
        if args.write:
            result["receipt"] = income.write_income(layout, result)
        return result
    result = analyze.analyze_account(layout, args.account, as_of=args.as_of)
    age = analyze.snapshot_age_warning(result["snapshot_as_of"], date.fromisoformat(args.as_of) if args.as_of else date.today())
    if age:
        result["warnings"].append(age)
    if args.write:
        result["receipt"] = analyze.write_analysis(layout, result)
    return result


def cmd_recommend(args: argparse.Namespace, layout: Layout) -> Any:
    result = recommend.recommend_for_account(layout, args.account, args.screen, args.limit_pct)
    result["receipt"] = recommend.write_recommendations(layout, result)
    return result


def cmd_report(args: argparse.Namespace, layout: Layout) -> Any:
    built = report.build_report(layout, as_of=args.as_of, account_id=args.account)
    written = report.write_report(layout, built)
    return {"as_of": built["as_of"], **written, "warnings": built["warnings"]}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="finance_core", description=__doc__.split("\n")[0])
    parser.add_argument("--root", default=".", help="directory that holds .finance/")
    groups = parser.add_subparsers(dest="group", required=True)

    acct = groups.add_parser("account")
    acct_sub = acct.add_subparsers(dest="action", required=True)
    c = acct_sub.add_parser("create")
    c.add_argument("--account", required=True)
    c.add_argument("--base-currency", required=True)
    c.add_argument("--account-mask")
    c.add_argument("--label")
    c.add_argument("--commission", help='JSON, e.g. {"per_share":"0.005","per_contract":"0.65"}')
    c.add_argument("--slippage-bps", default="0")
    c.add_argument("--fill-rules", help="JSON overrides per order type")
    c.add_argument("--options", default="holdings_only", choices=["holdings_only", "full_fills"])
    c.add_argument("--import-formats", help="comma list: csv,json")
    acct_sub.add_parser("list")
    s = acct_sub.add_parser("show")
    s.add_argument("--account", required=True)
    cfg = acct_sub.add_parser("config")
    cfg.add_argument("--account", required=True)
    cfg.add_argument("--key", required=True)
    cfg.add_argument("--value", required=True, help="JSON or literal")

    inl = groups.add_parser("inlet")
    inl_sub = inl.add_subparsers(dest="action", required=True)
    cm = inl_sub.add_parser("check-mapping")
    cm.add_argument("--mapping", required=True, help="path, JSON string, or -")
    ing = inl_sub.add_parser("ingest")
    ing.add_argument("--account", required=True)
    ing.add_argument("--mapping", required=True)
    ing.add_argument("--source", required=True, help="path outside the repo")

    pap = groups.add_parser("paper")
    pap_sub = pap.add_subparsers(dest="action", required=True)
    po = pap_sub.add_parser("order")
    po.add_argument("--account", required=True)
    po.add_argument("--order", required=True, help="JSON, path, or -")
    pf = pap_sub.add_parser("fill")
    pf.add_argument("--account", required=True)
    pf.add_argument("--order-id", required=True)
    pf.add_argument("--bar", help="JSON bar: open, high, low, close, ts")
    pf.add_argument("--latest-bar", action="store_true",
                    help="use the most recent cached or fetched daily bar of the order's symbol")
    pc = pap_sub.add_parser("cancel")
    pc.add_argument("--account", required=True)
    pc.add_argument("--order-id", required=True)
    for name in ("positions", "open-orders"):
        p = pap_sub.add_parser(name)
        p.add_argument("--account", required=True)
    pr = pap_sub.add_parser("reconcile")
    pr.add_argument("--account", required=True)
    pr.add_argument("--statement", required=True, help="path to a portfolio record JSON")

    pl = groups.add_parser("plan")
    pl_sub = pl.add_subparsers(dest="action", required=True)
    pv = pl_sub.add_parser("validate")
    pv.add_argument("--plan", required=True)
    pp = pl_sub.add_parser("put")
    pp.add_argument("--plan", required=True)
    pp.add_argument("--approval", help="JSON or path; required for live: mode")
    pli = pl_sub.add_parser("list")
    pli.add_argument("--account")
    pli.add_argument("--status")
    pli.add_argument("--as-of")
    pg = pl_sub.add_parser("get")
    pg.add_argument("--plan-id", required=True)

    bo = groups.add_parser("breakout")
    bo_sub = bo.add_subparsers(dest="action", required=True)
    bt = bo_sub.add_parser("translate")
    bt.add_argument("--account", required=True)
    bt.add_argument("--item", required=True, help="one planner actionable item, JSON or path")
    bt.add_argument("--plan-id", required=True)
    bt.add_argument("--mode", default="planned")
    bt.add_argument("--write", action="store_true", help="store the plan (default: print only)")
    bz = bo_sub.add_parser("size", help="P6: shares for one long trade from entry, stop and risk percent")
    bz.add_argument("--account", required=True)
    bz.add_argument("--entry", required=True)
    bz.add_argument("--stop", required=True)
    bz.add_argument("--risk-pct", default="0.5", help="percent of equity risked (default 0.5)")
    bz.add_argument("--max-position-pct", default="10", help="largest single position as percent of equity (default 10)")
    bp = bo_sub.add_parser("plan")
    bp.add_argument("--account", required=True)
    bp.add_argument("--screen", required=True, help="screener JSON from `market screen`")
    bp.add_argument("--risk-pct", default="0.5")
    bp.add_argument("--write", action="store_true", help="store the plans (default: print only)")
    bp.add_argument("--ignore-posture", action="store_true", help="size even when the latest posture is no-new-entries")

    mk = groups.add_parser("market")
    mk_sub = mk.add_subparsers(dest="action", required=True)
    mb = mk_sub.add_parser("bars")
    mb.add_argument("--symbol", required=True)
    mb.add_argument("--range", default="1y", choices=list(marketdata.RANGES))
    mb.add_argument("--refresh", action="store_true")
    mb.add_argument("--provider", default="auto", choices=list(marketdata.PROVIDERS))
    ms = mk_sub.add_parser("screen")
    ms.add_argument("--symbols", help="comma list; the screener never needs a key")
    ms.add_argument("--index", choices=sorted(universe.SOURCES), help="screen an index's constituents instead (see `market universe`)")
    ms.add_argument("--sector", help="with --index: one GICS sector")
    ms.add_argument("--limit", type=int, help="with --index: first N constituents")
    ms.add_argument("--max-candidates", type=int, default=100)
    ms.add_argument("--top", type=int, default=20, help="keep the N best-scoring symbols in `results`")
    mu = mk_sub.add_parser("universe", help="list an index's constituents (keyless) for `market screen --symbols`")
    mu.add_argument("--index", default="sp500", choices=sorted(universe.SOURCES))
    mu.add_argument("--sector")
    mu.add_argument("--limit", type=int)
    mu.add_argument("--refresh", action="store_true")

    mp = mk_sub.add_parser("posture", help="P2: full / reduced / no-new-entries from index trend and drawdown")
    mp.add_argument("--symbols", default=",".join(posture.DEFAULT_INDICES))

    me = mk_sub.add_parser("edge", help="P10: run the edge research pipeline on cached bars")
    me.add_argument("--symbols", required=True, help="comma list, at least three")
    me.add_argument("--range", default="1y", choices=list(marketdata.RANGES))
    me.add_argument("--as-of")
    me.add_argument("--export", action="store_true", help="export eligible strategies (default: dry run)")

    it = groups.add_parser("intraday", help="P11: 0DTE entry gate and exit cascade (decision support)")
    it_sub = it.add_subparsers(dest="action", required=True)
    ie = it_sub.add_parser("entry")
    ie.add_argument("--grade", required=True)
    ie.add_argument("--signal", required=True, help="mega_bull | mega_bear | other")
    ie.add_argument("--rvol", required=True)
    ie.add_argument("--time", required=True, help="HH:MM Eastern, 24-hour")
    ie.add_argument("--trend-age", type=int, required=True)
    ie.add_argument("--weekday", type=int, help="0=Mon..4=Fri; default today")
    ie.add_argument("--open-positions", type=int, default=0)
    ie.add_argument("--trades-today", type=int, default=0)
    ie.add_argument("--day-pnl", help="today's realized P&L in account currency, 0 on a fresh day; omitted = rule not evaluated")
    ie.add_argument("--account-size")
    ie.add_argument("--max-trade-pct", help="per-trade cap as percent of --account-size; the source's 40%% only up to $1,000")
    ie.add_argument("--max-daily-loss-pct", help="daily-loss cap as percent of --account-size; the source's 80%% only up to $1,000")
    ie.add_argument("--premium", help="option price per share (for example 1.10); with --account-size, checks the order cost against the per-trade cap")
    ie.add_argument("--contracts", type=int, default=1, help="contracts in the order (default 1; 100 shares each)")
    ie.add_argument("--symbol", help="underlying the signal fired on; the playbook requires SPY")
    ix = it_sub.add_parser("exit")
    ix.add_argument("--pnl-pct", required=True)
    ix.add_argument("--grade", required=True)
    ix.add_argument("--entry-grade")
    ix.add_argument("--signal-flipped", action="store_true")
    ix.add_argument("--time", required=True)

    an = groups.add_parser("analyze")
    an.add_argument("--account")
    an.add_argument("--as-of")
    an.add_argument("--consolidated", action="store_true")
    an.add_argument("--income", action="store_true", help="P4: trailing-12-month dividend income per position")
    an.add_argument("--write", action="store_true", help="write the analysis receipt")

    rc = groups.add_parser("recommend", help="decision support: trims, entry policy, watchlist, sized proposals")
    rc.add_argument("--account", required=True)
    rc.add_argument("--screen", help="screener JSON from `market screen`; adds the watchlist and sized proposals")
    rc.add_argument("--limit-pct", default="25", help="single-position limit used for trims")

    rp = groups.add_parser("report")
    rp.add_argument("--as-of")
    rp.add_argument("--account", help="report one account (default: every account)")
    return parser


DISPATCH = {
    "account": cmd_account, "inlet": cmd_inlet, "paper": cmd_paper, "plan": cmd_plan,
    "breakout": cmd_breakout, "recommend": cmd_recommend, "market": cmd_market, "intraday": cmd_intraday, "analyze": cmd_analyze, "report": cmd_report,
}


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    layout = Layout(args.root)
    try:
        if args.group == "analyze" and not args.consolidated and not args.account:
            raise FinanceError("analyze: pass --account or --consolidated")
        _emit(DISPATCH[args.group](args, layout))
        return 0
    except FinanceError as exc:
        sys.stderr.write(json.dumps({"error": str(exc), "reasons": exc.reasons}, indent=2) + "\n")
        return 2


if __name__ == "__main__":
    sys.exit(main())
