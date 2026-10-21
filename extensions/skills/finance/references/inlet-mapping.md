# Inlet mapping (v0)

The agent writes this file for each brokerage export. The core validates it with `inlet check-mapping` and applies it with `inlet ingest`. Every ref must resolve; an unresolved ref is a rejection, never a default.

```json
{
  "schema_version": 0,
  "broker_label": "example-broker",
  "format": "csv",
  "header_line": 4,
  "as_of": {"regex": "As of (\\d{2}/\\d{2}/\\d{4})", "group": 1},
  "as_of_format": "%m/%d/%Y",
  "cash": {"regex": "Cash Balance,\\$?([-0-9,.()]+)", "group": 1},
  "account_number": {"regex": "Account: (\\S+)", "group": 1},
  "control_total": {"regex": "Total Value,\\$?([-0-9,.()]+)", "group": 1},
  "rows": {"row_filter": {"column": "Row Type", "equals": "Position"}, "require_numeric": ["Quantity", "Last Price"]},
  "fields": {
    "symbol": {"column": "Symbol"},
    "quantity": {"column": "Quantity"},
    "avg_cost": {"column": "Average Cost"},
    "last_price": {"column": "Last Price"},
    "asset_type": {"column": "Type"},
    "currency": {"value": "USD"}
  },
  "asset_type_map": {"Stock": "equity", "ETF": "etf", "Option": "option"}
}
```

Top-level keys:

- `header_line` (csv, 1-based, default 1): the physical line holding the column header, counting blank lines. A wrong value produces a rejection that lists the columns it read. Brokers put preambles above it; the header of a preamble-heavy file is usually not line 1.
- `fields.cost_basis` (optional): the broker's total cost for the position. When mapped it replaces the per-share `avg_cost` column, which brokers round to cents; the average cost is derived as total cost over quantity, so cost basis and unrealized P&L match the broker to the cent.
- `rows.row_filter`: `{column, equals}` keeps matching rows; `{column, not_equals}` drops them. Use `not_equals` to drop summary rows that share a column.
- `rows.require_numeric` (csv): columns that must parse as numbers. A row failing this is skipped with a named warning, which is how totals and footers drop out.
- `fields.asset_type` values in `asset_type_map` must be `equity`, `etf`, `option`, `cash_equivalent`, or `other`. Map mutual funds that are neither stocks nor ETFs to `other`; allocation reports them as their own bucket. Use `cash_equivalent` for money-market and sweep funds: they count toward `cash_pct` as a brokerage cash balance does, and are reported separately as `cash_equivalents`. A mapped asset_type column with a blank cell rejects the file; it never defaults to equity.

Scalars (`as_of`, `cash`, `control_total`, `account_number`) read any row: a regex over the raw file text, quotes and delimiters included, so a value inside a quoted CSV cell is matched with its quotes and commas (`"1,234.00"`). For a summary row, anchor on its label and capture the value column, e.g. `{"regex": "Cash & Cash Investments,[^,]*,[^,]*,[^,]*,([-0-9,.]+)", "group": 1}` for a row laid out as label, type, quantity, price, value. Adjust the `[^,]*` count to the row's real column count. A dollar value after a label: `{"regex": "Positions Total[^$\\n]*\\$([-0-9,.]+)", "group": 1}`. A regex returns the first match in the file, and inside it a greedy `.*` or `[^\\n]*` runs to the last `$` on the line, so a label followed by several dollar columns captures the wrong one; use `[^$\\n]*` or a lazy `*?`. Always map `control_total`: a wrong capture is otherwise silent, and a mismatch is reported with the value read but not the field that read it, so check `cash` and `control_total` first. Summary rows (a cash row, a total row) are dropped by `rows.row_filter` when one column names them, else by `require_numeric`; a row is dropped when either rejects it. When both `cost_basis` and `avg_cost` are mapped, `cost_basis` wins. `inlet ingest` warns only about the snapshot's age in days. An export taken during the session carries intraday prices but only its date is kept, so `price_as_of` says the date, not that the prices are final.

Account ids (`account create --account`) match `^[a-z0-9][a-z0-9_-]{0,63}$`.

Ref kinds: `{"column": name}` (csv header or json key), `{"path": "a.b"}` (json dotted path), `{"value": literal}`, and for scalars `{"regex": pattern, "group": n}` over the raw text. Option rows need all of `option_underlying`, `option_expiry`, `option_strike`, `option_right`, `option_multiplier` as row refs. JSON sources use `rows_path` instead of `row_filter`.
