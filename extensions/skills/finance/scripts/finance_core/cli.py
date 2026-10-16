"""CLI for the finance core. Every command prints JSON on stdout; rejections print JSON on stderr and exit 2.

Usage: python3 -m finance_core --root <dir> <group> <command> [options]
--root is the directory that holds .finance/ (default: current directory).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from decimal import Decimal
from pathlib import Path
from typing import Any

from . import accounts, analyze, breakout, inlet, marketdata, paper, plans, report, screen
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


def cmd_paper(args: argparse.Namespace, layout: Layout) -> Any:
    if args.action == "order":
        order = _load_json_arg(args.order)
        if "quantity" in order and "qty" not in order:
            raise FinanceError("order: the quantity field is 'qty', not 'quantity'")
        return {"order_id": paper.place_order(layout, args.account, order)}
    if args.action == "fill":
        return paper.fill_bar(layout, args.account, args.order_id, _load_json_arg(args.bar))
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


def cmd_market(args: argparse.Namespace, layout: Layout) -> Any:
    if args.action == "bars":
        record = marketdata.get_bars(layout, args.symbol, args.range, refresh=args.refresh)
        bars = record["bars"]
        return {"symbol": record["symbol"], "range": record["range"], "bars": len(bars),
                "first": bars[0]["date"], "last": bars[-1]["date"], "last_close": bars[-1]["close"],
                "fetched_at": record["fetched_at"], "source": record["source"],
                "cache": str(layout.base / "market" / f"{record['symbol']}.json")}
    if args.action == "screen":
        return screen.run_screen(layout, [s for s in args.symbols.split(",") if s],
                                 max_candidates=args.max_candidates, top=args.top)
    raise FinanceError(f"unknown market action {args.action}")


def _plan_breakouts(args: argparse.Namespace, layout: Layout) -> Any:
    equity = analyze.analyze_account(layout, args.account)["equity"]
    planner = screen.run_planner(layout, args.screen, equity, args.risk_pct)
    built = screen.plans_from_planner(layout, args.account, planner, write=args.write)
    return {"account_equity": equity, "planner_output": planner["planner_output"],
            "summary": planner["result"]["summary"],
            "plans": [{"plan_id": p["plan_id"], "symbol": p["symbol"], "status": p["status"]} for p in built],
            "written": args.write}


def cmd_breakout(args: argparse.Namespace, layout: Layout) -> Any:
    if args.action == "plan":
        return _plan_breakouts(args, layout)
    item = _load_json_arg(args.item)
    digest = hashlib.sha256(json.dumps(item, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    plan = breakout.translate_breakout(item, args.account, args.plan_id, digest, mode=args.mode)
    if args.write:
        return {"written": plans.put_plan(layout, plan), "plan_id": args.plan_id}
    return plan


def cmd_analyze(args: argparse.Namespace, layout: Layout) -> Any:
    if args.consolidated:
        return analyze.consolidated(layout)
    result = analyze.analyze_account(layout, args.account, as_of=args.as_of)
    if args.write:
        result["receipt"] = analyze.write_analysis(layout, result)
    return result


def cmd_report(args: argparse.Namespace, layout: Layout) -> Any:
    built = report.build_report(layout, as_of=args.as_of)
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
    pf.add_argument("--bar", required=True, help="JSON bar: open, high, low, close, ts")
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
    bp = bo_sub.add_parser("plan")
    bp.add_argument("--account", required=True)
    bp.add_argument("--screen", required=True, help="screener JSON from `market screen`")
    bp.add_argument("--risk-pct", default="0.5")
    bp.add_argument("--write", action="store_true", help="store the plans (default: print only)")

    mk = groups.add_parser("market")
    mk_sub = mk.add_subparsers(dest="action", required=True)
    mb = mk_sub.add_parser("bars")
    mb.add_argument("--symbol", required=True)
    mb.add_argument("--range", default="1y", choices=list(marketdata.RANGES))
    mb.add_argument("--refresh", action="store_true")
    ms = mk_sub.add_parser("screen")
    ms.add_argument("--symbols", required=True, help="comma list; the screener never needs a key")
    ms.add_argument("--max-candidates", type=int, default=100)
    ms.add_argument("--top", type=int, default=20)

    an = groups.add_parser("analyze")
    an.add_argument("--account")
    an.add_argument("--as-of")
    an.add_argument("--consolidated", action="store_true")
    an.add_argument("--write", action="store_true", help="write the analysis receipt")

    rp = groups.add_parser("report")
    rp.add_argument("--as-of")
    return parser


DISPATCH = {
    "account": cmd_account, "inlet": cmd_inlet, "paper": cmd_paper, "plan": cmd_plan,
    "breakout": cmd_breakout, "market": cmd_market, "analyze": cmd_analyze, "report": cmd_report,
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
