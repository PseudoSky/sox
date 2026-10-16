# Inlet mapping (v0)

The agent writes this file for each brokerage export. The core validates it with `inlet check-mapping` and applies it with `inlet ingest`. Every ref must resolve; an unresolved ref is a rejection, never a default.

```json
{
  "schema_version": 0,
  "broker_label": "example-broker",
  "format": "csv",
  "as_of": {"regex": "As of (\\d{2}/\\d{2}/\\d{4})", "group": 1},
  "as_of_format": "%m/%d/%Y",
  "cash": {"regex": "Cash Balance,\\$?([-0-9,.()]+)", "group": 1},
  "account_number": {"regex": "Account: (\\S+)", "group": 1},
  "control_total": {"regex": "Total Value,\\$?([-0-9,.()]+)", "group": 1},
  "rows": {"row_filter": {"column": "Row Type", "equals": "Position"}},
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

Ref kinds: `{"column": name}` (csv header or json key), `{"path": "a.b"}` (json dotted path), `{"value": literal}`, and for scalars `{"regex": pattern, "group": n}` over the raw text. Option rows need all of `option_underlying`, `option_expiry`, `option_strike`, `option_right`, `option_multiplier` as row refs. JSON sources use `rows_path` instead of `row_filter`.
