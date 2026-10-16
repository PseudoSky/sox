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

- `header_line` (csv, 1-based, default 1): the line holding the column header. Brokers put preambles above it; the header of a preamble-heavy file is usually not line 1.
- `rows.row_filter`: `{column, equals}` keeps matching rows; `{column, not_equals}` drops them. Use `not_equals` to drop summary rows that share a column.
- `rows.require_numeric` (csv): columns that must parse as numbers. A row failing this is skipped with a named warning, which is how totals and footers drop out.
- `fields.asset_type` values in `asset_type_map` must be `equity`, `etf`, `option`, or `other`. A mapped asset_type column with a blank cell rejects the file; it never defaults to equity.

Scalars (`as_of`, `cash`, `control_total`, `account_number`) read any row: a regex over the raw text. For a summary row, anchor on its label and capture the value column, e.g. `{"regex": "Cash & Cash Investments,[^,]*,[^,]*,[^,]*,([-0-9,.]+)", "group": 1}` for a row laid out as label, type, quantity, price, value. Adjust the `[^,]*` count to the row's real column count.

Account ids (`account create --account`) match `^[a-z0-9][a-z0-9_-]{0,63}$`.

Ref kinds: `{"column": name}` (csv header or json key), `{"path": "a.b"}` (json dotted path), `{"value": literal}`, and for scalars `{"regex": pattern, "group": n}` over the raw text. Option rows need all of `option_underlying`, `option_expiry`, `option_strike`, `option_right`, `option_multiplier` as row refs. JSON sources use `rows_path` instead of `row_filter`.
