# P0 portfolio-review

Stage: portfolio. Owns: holdings and exposure reads. Reads: an inlet record (`.finance/accounts/<id>/current.json`). Emits: analysis receipt `.finance/analysis/<id>-<as_of>.json`.

1. Import: follow SKILL.md "Inlet". Import once per file; the core refuses a re-import of the same file.
2. Analyze: `analyze --account <id> --write`. Consolidated view: `analyze --consolidated`. Currencies are never converted; mixed currencies are reported separately.
3. Report the receipt path, equity, allocation, cash %, top concentration, and the warnings verbatim.

Ungated. Paper fills do not change the snapshot; the ledger is replayed on top of it.
