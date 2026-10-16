# P0 portfolio-review

Stage: portfolio. Owns: holdings and exposure reads. Reads: an inlet record (`.finance/accounts/<id>/current.json`). Emits: analysis receipt `.finance/analysis/<id>-<as_of>.json`.

1. Import: follow SKILL.md "Inlet". Import once per file; the core refuses a re-import of the same file.
2. Analyze: `analyze --account <id> --write`. Consolidated view: `analyze --consolidated`. Currencies are never converted; mixed currencies are reported separately.
3. Report the receipt path, equity, allocation, cash %, top concentration, and the warnings verbatim.

Ungated. Analysis is the snapshot plus paper-ledger events newer than the import, so paper fills show in equity and positions. Money is rounded to cents; percentages to 2 dp. `cash_pct` = cash plus `cash_equivalent` positions, as a brokerage cash balance includes its sweep fund.
