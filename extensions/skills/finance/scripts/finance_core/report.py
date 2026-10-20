"""P12 portfolio report: terminal stage. Renders from analysis dicts and the plan store; no new math."""

from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any

from . import analyze, plans
from .accounts import list_accounts
from .layout import Layout, atomic_write_json, atomic_write_text, read_json

SECTIONS = ["Executive summary", "Holdings overview", "Allocation", "Risk", "Market posture", "Income",
            "Recommendations", "Active trade plans", "Action items", "Appendix"]
EXPIRY_WINDOW_DAYS = 3


def _latest(folder: Path, pattern: str) -> dict[str, Any] | None:
    found = sorted(folder.glob(pattern)) if folder.is_dir() else []
    return read_json(found[-1]) if found else None


def build_report(layout: Layout, as_of: str | None = None, account_id: str | None = None,
                 today: date | None = None) -> dict[str, Any]:
    accounts, receipts, warnings = [], [], []
    ref = date.fromisoformat(as_of) if as_of else (today or date.today())
    for acct in ([account_id] if account_id else list_accounts(layout)):
        result = analyze.analyze_account(layout, acct, as_of)
        receipts.append(str(analyze.write_analysis(layout, result)))
        accounts.append(result)
        warnings.extend(f"{acct}: {w}" for w in result["warnings"])
        age = analyze.snapshot_age_warning(result["snapshot_as_of"], ref)
        if age:
            warnings.append(f"{acct}: {age}")
    report_as_of = as_of or max((a["as_of"] for a in accounts), default=date.today().isoformat())
    return {
        "as_of": report_as_of,
        "accounts": accounts,
        "consolidated": analyze.consolidated(layout),
        "plans": plans.list_plans(layout, status="active", as_of=report_as_of),
        "receipts": receipts,
        "warnings": warnings,
        "posture": _latest(layout.base / "posture", "*.json"),
        "income": {a["account_id"]: _latest(layout.base / "income", f"{a['account_id']}-*.json") for a in accounts},
        "recommendations": {a["account_id"]: _latest(layout.base / "recommendations", f"{a['account_id']}-*.json")
                            for a in accounts},
    }


def _table(header: list[str], rows: list[list[str]]) -> list[str]:
    lines = ["| " + " | ".join(header) + " |", "|" + "|".join("---" for _ in header) + "|"]
    lines += ["| " + " | ".join(r) + " |" for r in rows]
    return lines


def _s(value: Any) -> str:
    return "n/a" if value is None else str(value)


def _expiring(report: dict[str, Any]) -> list[dict[str, Any]]:
    today = date.fromisoformat(report["as_of"])
    return [p for p in report["plans"]
            if 0 <= (date.fromisoformat(p["valid_until"]) - today).days <= EXPIRY_WINDOW_DAYS]


def render_markdown(report: dict[str, Any]) -> str:
    out = [f"# Portfolio report {report['as_of']}", ""]
    out += [f"## {SECTIONS[0]}", ""]
    parts = [f"{a['account_id']} equity {a['equity']} {a['base_currency']}"
             + ("" if a["equity_complete"] else " (incomplete)") for a in report["accounts"]]
    out += ["; ".join(parts) + "." if parts else "No accounts configured.", ""]
    out += [f"## {SECTIONS[1]}", ""]
    for a in report["accounts"]:
        out += [f"### {a['account_id']}", ""]
        out += _table(["key", "qty", "last_price", "price as of", "market value", "cost basis", "unrealized", "unrealized %"],
                      [[p["key"], p["qty"], _s(p["last_price"]), _s(p.get("price_as_of")), p["market_value"],
                        _s(p.get("cost_basis")), _s(p.get("unrealized_pnl")), _s(p.get("unrealized_pct"))]
                       for p in a["positions"]])
        u = a["unrealized"]
        out += ["", f"Unrealized P&L {u['pnl']} on cost {u['cost_basis']} ({_s(u['pnl_pct'])}%); {u['basis']}."]
        r = a.get("realized")
        if r and r["fills"]:
            out += ["", f"Realized on paper fills since the snapshot: {r['realized_pnl']} over {len(r['fills'])} sale(s); "
                    f"{r['basis']}."]
            out += _table(["seq", "symbol", "qty", "price", "realized"],
                          [[str(x["seq"]), x["symbol"], x["qty"], x["price"], _s(x["realized_pnl"])] for x in r["fills"]])
        out.append("")
    out += [f"## {SECTIONS[2]}", ""]
    for a in report["accounts"]:
        out += [f"### {a['account_id']}", ""]
        out += _table(["bucket", "pct of equity"],
                      [[f"type:{k}", _s(v)] for k, v in a["allocation"]["by_asset_type"].items()]
                      + [[f"currency:{k}", _s(v)] for k, v in a["allocation"]["by_currency"].items()])
        out.append("")
    out += [f"## {SECTIONS[3]}", ""]
    for a in report["accounts"]:
        top = ", ".join(f"{t['key']} {_s(t['pct'])}%" for t in a["top_concentration"]) or "none"
        out += [f"- {a['account_id']}: cash {_s(a['cash_pct'])}%; open risk {a['open_risk']} "
                f"({_s(a['open_risk_pct'])}% of equity); top concentration: {top}"]
    out.append("")
    out += [f"## {SECTIONS[4]}", ""]
    post = report.get("posture")
    if post:
        out += [f"Posture **{post['posture']}** as of {post['as_of']}: " + "; ".join(post["reasons"]) + "."]
        out += ["", *_table(["index", "close", "vs 50d %", "vs 200d %", "drawdown %"],
                            [[s["symbol"], s["close"], s["vs_50d_pct"], s["vs_200d_pct"], s["drawdown_from_52w_high_pct"]]
                             for s in post["signals"]])]
    else:
        out += ["No posture receipt. Run `market posture`."]
    out += ["", f"## {SECTIONS[5]}", ""]
    for acct, inc in report["income"].items():
        if inc is None:
            out += [f"- {acct}: no income receipt. Run `analyze --account {acct} --income --write`."]
            continue
        out += [f"### {acct}: {inc['income_12m_total']} paid in the trailing 12 months", ""]
        out += _table(["symbol", "payments", "per share", "income", "trailing yield %"],
                      [[r["symbol"], str(r["payments_12m"]), r["per_share_12m"], r["income_12m"], _s(r["trailing_yield_pct"])]
                       for r in inc["positions"]])
        out += ["", *[f"- {w}" for w in inc["warnings"]], "", inc["basis"], ""]
    out += [f"## {SECTIONS[6]}", ""]
    for acct, rec in report["recommendations"].items():
        if rec is None:
            out += [f"- {acct}: no recommendations receipt. Run `recommend --account {acct}`."]
            continue
        out += [f"### {acct} (decision support, not advice)", ""]
        current = next((a for a in report["accounts"] if a["account_id"] == acct), None)
        if current is not None and rec.get("positions_seq") != current.get("ledger_seq"):
            out += [f"- STALE: positions changed after this recommendation (paper ledger {rec.get('positions_seq')} "
                    f"-> {current.get('ledger_seq')}). Run `recommend --account {acct}` again before acting on it.", ""]
        out += [f"- Note: {w}" for w in rec.get("warnings", []) if "less than one share" in w]
        for item in rec["items"]:
            if item["type"] == "trim":
                out += [f"- Trim {item['symbol']}: {item['reason']}. {item['text']} Instead of selling, adding "
                        f"{item['alternative']['new_money_in_other_holdings']} of new money to other holdings brings it "
                        f"to the limit. {item['caveat']}"]
            else:
                out += [f"- Entry policy: {item['action']}."]
        out += [f"- Entry proposals: {len(rec['proposals'])}."]
        out += [f"- Watch {w['symbol']}: {w['rating']}, {w['state']}, score {w['score']}, pivot {_s(w['pivot_price'])}; {w['status']}."
                for w in rec["watchlist"]]
        out.append("")
    out += [f"## {SECTIONS[7]}", ""]
    out += _table(["plan_id", "symbol", "mode", "trigger", "stop", "quantity", "valid_until"],
                  [[p["plan_id"], p["symbol"], p["mode"], p["trigger_price"], p["stop_price"],
                    str(p["quantity"]), p["valid_until"]] for p in report["plans"]])
    out += ["", f"## {SECTIONS[8]}", ""]
    items = [f"- Resolve: {w}" for w in report["warnings"]]
    items += [f"- Re-run `recommend --account {acct}`: its receipt predates the latest paper fills"
              for acct, rec in report["recommendations"].items()
              if rec is not None and any(a["account_id"] == acct and rec.get("positions_seq") != a.get("ledger_seq")
                                         for a in report["accounts"])]
    items += [f"- Concentration: {a['account_id']} holds {f['key']} at {f['pct']}% of equity, above the "
              f"{analyze.CONCENTRATION_LIMIT_PCT}% single-position limit"
              for a in report["accounts"] for f in a.get("concentration_flags", [])]
    items += [f"- Plan {p['plan_id']} ({p['symbol']}) expires {p['valid_until']}" for p in _expiring(report)]
    out += items or ["- None"]
    out += ["", f"## {SECTIONS[9]}", ""]
    out += [f"- Receipt: {r}" for r in report["receipts"]]
    out += [f"- Snapshot as_of {a['account_id']}: {a['snapshot_as_of']}" for a in report["accounts"]]
    return "\n".join(out) + "\n"


def write_report(layout: Layout, report: dict[str, Any]) -> dict[str, Path]:
    layout.ensure_base()
    md = layout.reports_dir() / f"{report['as_of']}.md"
    js = layout.reports_dir() / f"{report['as_of']}.json"
    atomic_write_text(md, render_markdown(report))
    atomic_write_json(js, report)
    return {"md_path": md, "json_path": js}
