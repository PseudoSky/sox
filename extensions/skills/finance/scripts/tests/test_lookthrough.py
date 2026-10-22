"""Fund look-through. SYNTHETIC filings, ticker lookups and books; no network."""
import json
from datetime import date, timedelta

import pytest

from finance_core import accounts, lookthrough
from finance_core.errors import FinanceError
from finance_core.layout import Layout
from tests.test_analyze_report import pos, snapshot

NS = "http://www.sec.gov/edgar/nport"


def nport(series, rows, period="2026-08-31"):
    body = "".join(f"<invstOrSec><name>{n}</name><cusip>{c}</cusip><pctVal>{p}</pctVal><assetCat>{cat}</assetCat></invstOrSec>"
                   for n, c, p, cat in rows)
    return (f'<edgarSubmission xmlns="{NS}"><formData><genInfo><seriesId>{series}</seriesId><repPdDate>{period}</repPdDate>'
            f"</genInfo><invstOrSecs>{body}</invstOrSecs></formData></edgarSubmission>").encode()


class Net:
    """Routes the three SEC/OpenFIGI endpoints; counts calls."""

    def __init__(self, period="2026-08-31"):
        self.calls = []
        # FUNDA (series S000000001, cik 11) holds AAA 60, BBB 30, a note 5; FUNDB (S000000002, cik 22) holds AAA 50, CCC 50.
        # Cik 11 files another trust series first, so the scan must skip a non-matching filing.
        self.docs = {
            "https://www.sec.gov/Archives/edgar/data/11/000000001126000002/primary_doc.xml": nport("S000009999", [("X", "9", "100", "EC")]),
            "https://www.sec.gov/Archives/edgar/data/11/000000001126000001/primary_doc.xml": nport(
                "S000000001", [("Alpha Inc", "CUSIPAAA1", "60", "EC"), ("Beta Corp", "CUSIPBBB1", "30", "EC"),
                               ("Linked Note", "CUSIPNOTE", "5", "DBT")], period),
            "https://www.sec.gov/Archives/edgar/data/22/000000002226000001/primary_doc.xml": nport(
                "S000000002", [("Alpha Inc", "CUSIPAAA1", "50", "EC"), ("Gamma Ltd", "CUSIPCCC1", "50", "EC")], period)}
        self.tickers = {"CUSIPAAA1": "AAA", "CUSIPBBB1": "BBB", "CUSIPCCC1": "CCC"}

    def __call__(self, url, headers, data):
        self.calls.append(url)
        if url.endswith("company_tickers_mf.json"):
            return 200, json.dumps({"fields": ["cik", "seriesId", "classId", "symbol"],
                                    "data": [[11, "S000000001", "C1", "FUNDA"], [22, "S000000002", "C2", "FUNDB"]]}).encode()
        if "submissions/CIK" in url:
            cik = int(url.rsplit("CIK", 1)[1][:10])
            accs = {11: ["0000000011-26-000002", "0000000011-26-000001"], 22: ["0000000022-26-000001"]}[cik]
            return 200, json.dumps({"filings": {"recent": {
                "form": ["NPORT-P"] * len(accs), "accessionNumber": accs,
                "filingDate": ["2026-10-02", "2026-09-01"][:len(accs)]}, "files": []}}).encode()
        if url.startswith("https://www.sec.gov/Archives"):
            if url not in self.docs:
                return 404, b""
            return 200, self.docs[url]
        if "openfigi" in url:
            ids = [r["idValue"] for r in json.loads(data)]
            self.id_types = [r["idType"] for r in json.loads(data)]
            return 200, json.dumps([{"data": [{"ticker": self.tickers[i] + "*", "exchCode": "MM", "securityType2": "Common Stock"},
                                              {"ticker": self.tickers[i], "exchCode": "UW", "securityType2": "Common Stock"}]} if i in self.tickers else {"warning": "none"}
                                    for i in ids]).encode()
        return 404, b""


@pytest.fixture(autouse=True)
def fast(monkeypatch):
    monkeypatch.setattr(lookthrough.time, "sleep", lambda s: None)


def book(tmp_path):
    layout = Layout(tmp_path)
    accounts.create_account(layout, "acc1", "USD")
    accounts.create_account(layout, "acc2", "USD")
    accounts.write_snapshot(layout, "acc1", snapshot("acc1", "1000.00", [
        pos("FUNDA", "10", "100", asset="etf"),                 # 1000, 60% AAA
        pos("AAA", "10", "50"),                                 # 500 direct
        pos("MMF", "500", "1", asset="cash_equivalent")]))     # 500 cash-like
    accounts.write_snapshot(layout, "acc2", snapshot("acc2", "0.00", [pos("FUNDB", "20", "100", asset="etf")]))  # 2000
    return layout


def row(rows, key):
    return next(r for r in rows if r["underlying"] == key)


def test_single_account_hand_computed(tmp_path):
    out = lookthrough.look_through(book(tmp_path), ["acc1"], Net())
    ex = out["per_account"][0]["exposure"]
    assert out["per_account"][0]["equity"] == "3000.00"          # 1000 cash + 1000 + 500 + 500
    aaa = row(ex, "AAA")
    assert aaa["value"] == "1100.00" and aaa["pct_of_equity"] == "36.67"   # 600 via FUNDA + 500 direct
    assert aaa["via"] == {"AAA": "500.00", "FUNDA": "600.00"}
    assert row(ex, "BBB")["value"] == "300.00"
    cash = out["per_account"][0]["cash"]
    assert cash[0]["value"] == "1500.00" and cash[0]["pct_of_equity"] == "50.00"   # cash + the money-market fund
    assert all(r["category"] != "cash" for r in ex)
    assert row(ex, "cusip:CUSIPNOTE")["category"] == "other:DBT"
    assert row(ex, "OTHER:FUNDA")["value"] == "50.00"            # the 5% residual net assets


def test_fund_scan_skips_other_series_and_caches(tmp_path):
    layout, net = book(tmp_path), Net()
    lookthrough.look_through(layout, ["acc1"], net)
    first = len(net.calls)
    lookthrough.look_through(layout, ["acc1"], net)
    assert len(net.calls) == first                                # funds, map and tickers all cached
    assert any("000000001126000002" in c for c in net.calls)      # the foreign-series filing was examined


def test_combined_exposure_across_accounts(tmp_path):
    out = lookthrough.look_through(book(tmp_path), ["acc1", "acc2"], Net())
    comb = out["combined"]
    assert comb["equity"] == "5000.00"
    aaa = row(comb["exposure"], "AAA")
    assert aaa["value"] == "2100.00"                              # 1100 + 1000 via FUNDB
    assert aaa["via"] == {"acc1": "1100.00", "acc2": "1000.00"}
    assert aaa["pct_of_equity"] == "42.00"


def test_stock_not_in_fund_list_is_a_single_line(tmp_path):
    layout = Layout(tmp_path)
    accounts.create_account(layout, "a", "USD")
    accounts.write_snapshot(layout, "a", snapshot("a", "0.00", [pos("ZZZ", "1", "10", asset="etf")]))
    out = lookthrough.look_through(layout, ["a"], Net())
    assert row(out["per_account"][0]["exposure"], "ZZZ")["pct_of_equity"] == "100.00"
    assert "ZZZ" in out["warnings"][0] and "single line" in out["warnings"][0]


def test_stale_filing_warns(tmp_path):
    old = (date.today() - timedelta(days=200)).isoformat()
    out = lookthrough.look_through(book(tmp_path), ["acc1"], Net(period=old))
    assert any("older fund filings" in w and old in w for w in out["warnings"])


def test_options_not_decomposed(tmp_path):
    layout = Layout(tmp_path)
    accounts.create_account(layout, "a", "USD")
    opt = {"underlying": "FUNDA", "expiry": "2027-01-15", "strike": "100", "right": "call", "multiplier": 100}
    accounts.write_snapshot(layout, "a", snapshot("a", "0.00", [pos("FUNDA270115C100", "1", "2", asset="option", option=opt)]))
    ex = lookthrough.look_through(layout, ["a"], Net())["per_account"][0]["exposure"]
    assert row(ex, "OPTION:FUNDA270115C100")["value"] == "200.00"


def test_unmapped_cusip_listed_by_cusip(tmp_path):
    net = Net()
    del net.tickers["CUSIPBBB1"]
    out = lookthrough.look_through(book(tmp_path), ["acc1"], net)
    assert row(out["per_account"][0]["exposure"], "cusip:CUSIPBBB1")["value"] == "300.00"
    assert any("no current US listing" in w for w in out["warnings"])


def test_no_matching_filing_raises_with_scan_count(tmp_path):
    net = Net()
    net.docs.pop("https://www.sec.gov/Archives/edgar/data/22/000000002226000001/primary_doc.xml")
    with pytest.raises(FinanceError, match="no N-PORT filing for FUNDB"):
        lookthrough.fund_holdings(Layout(tmp_path), "FUNDB", net)


def test_receipt_written(tmp_path):
    layout = book(tmp_path)
    out = lookthrough.look_through(layout, ["acc1", "acc2"], Net())
    path = lookthrough.write_lookthrough(layout, out)
    assert json.loads(open(path).read())["combined"]["equity"] == "5000.00"


def test_listing_pick_prefers_composite_and_skips_star_lines():
    pick = lookthrough._pick_listing
    rows = [{"ticker": "EA*", "exchCode": "MM", "securityType2": "Common Stock"},
            {"ticker": "EA", "exchCode": "UW", "securityType2": "Common Stock"},
            {"ticker": "EA", "exchCode": "US", "securityType2": "Common Stock"}]
    assert pick(rows)["exchCode"] == "US"
    assert pick(rows[:2])["exchCode"] == "UW"
    assert pick(rows[:1]) is None and pick([]) is None


def test_foreign_domiciled_cusip_uses_cins_lookup(tmp_path):
    net = Net()
    net.tickers["GFOREIGN1"] = "FRN"
    lookthrough._map_cusips(Layout(tmp_path), ["GFOREIGN1"], net)
    assert net.id_types == ["ID_CINS"]


def test_top_counts_only_non_cash_rows(tmp_path):
    out = lookthrough.look_through(book(tmp_path), ["acc1"], Net(), top=2)
    assert [r["underlying"] for r in out["per_account"][0]["exposure"]] == ["AAA", "BBB"]


def test_share_classes_of_one_issuer_merge(tmp_path):
    net = Net()
    key = "https://www.sec.gov/Archives/edgar/data/22/000000002226000001/primary_doc.xml"
    net.docs[key] = nport("S000000002", [("Alpha Inc Class A", "CUSIPAAA1", "30", "EC"),
                                         ("Alpha Inc Class C", "CUSIPAAC1", "20", "EC"), ("Gamma Ltd", "CUSIPCCC1", "50", "EC")])
    net.tickers["CUSIPAAC1"] = "AAAC"
    out = lookthrough.look_through(book(tmp_path), ["acc2"], net)
    merged = out["per_account"][0]["merged_share_classes"]
    assert merged[0]["tickers"] == ["AAA", "AAAC"] and merged[0]["pct_of_equity"] == "50.00"
    assert lookthrough.issuer_key("Alphabet Inc. Class C") == lookthrough.issuer_key("Alphabet Inc Class A")


def test_fund_weight_sum_reported_and_contact_warning(tmp_path, monkeypatch):
    monkeypatch.delenv("FINANCE_SEC_CONTACT", raising=False)
    out = lookthrough.look_through(book(tmp_path), ["acc1"], Net())
    assert out["funds"]["FUNDA"]["weight_sum"] == "95.00"
    assert any("FINANCE_SEC_CONTACT is not set" in w for w in out["warnings"])
    monkeypatch.setenv("FINANCE_SEC_CONTACT", "a@b.co")
    again = lookthrough.look_through(book(tmp_path / "x"), ["acc1"], Net())
    assert not any("FINANCE_SEC_CONTACT" in w for w in again["warnings"])


def test_report_renders_lookthrough_section(tmp_path):
    from finance_core import report
    layout = book(tmp_path)
    md = report.render_markdown(report.build_report(layout, account_id="acc1"))
    assert "no look-through receipt" in md
    lookthrough.write_lookthrough(layout, lookthrough.look_through(layout, ["acc1"], Net()))
    md = report.render_markdown(report.build_report(layout, account_id="acc1"))
    assert "Underlying exposure through funds" in md and "AAA" in md and "FUNDA 600.00" in md
