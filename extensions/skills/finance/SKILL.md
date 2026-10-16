# Finance

Skill version: 0.1.0.

One entry point for portfolio, market, and trade work. A request is routed to the first stage it needs; no gate is skipped. Each playbook owns one stage and one output artifact, and consumes the previous stage's artifact by path. Playbook list and feed graph: `references/routing-table.md`. Per-playbook contracts: `references/playbooks/<id>.md`.

## Gates

A gate applies to an operation, never to a playbook. The gate decides the operation, not the skill.

| Operation kind | Gate |
|---|---|
| Analysis, data read, screening, sizing, validation | ungated |
| Paper fill (local ledger) | ungated |
| Live effect (any order, cancel, or broker write on a real account) | gated, needs an approval record that names the account |

This version connects no live broker. Live-capable capabilities are declared in the project's capability table and are absent here, so any live step returns "unavailable" and stops.

## Capabilities

Playbooks name capabilities, not tools. The project's `AGENTS.md` `## Capabilities` table binds them. An absent row means the capability is unavailable and the playbook stops at its last ungated output. `market-data`, `inlet` and `paper-broker` are provided by the finance core itself and need no row.

- `market-data`: daily bars (OHLCV, adjusted close, dividends, splits) for US stocks and ETFs from Yahoo's public chart endpoint. Keyless, unofficial, personal use only; cached under `.finance/market/`. Fundamentals, options chains and market-breadth feeds are not provided, so playbooks that need them report "unavailable". Required by P1, P2, P3, P6 input, P9.
- `inlet`: reads a holdings file from outside the repo and returns a mapping proposal. Used by P0 import.
- `paper-broker`: the local paper broker. Places orders, applies fills, cancels, reports positions. Always available.
- `broker-read`: live read of a real brokerage account. Absent in this version.
- `broker-live`: live order effects. Absent in this version. Gated.

## Core commands

The deterministic core is `scripts/finance_core` (stdlib Python). Run it from the skill's `scripts/` directory: `cd <skill>/scripts && python3 -m finance_core --root <project> <group> <command>`. Output is JSON on stdout; a rejection is JSON on stderr with exit 2. `--root` is the directory holding `.finance/`.

Market data and proposals: `market bars --symbol <S> [--range 1y]` fetches and caches bars. `market screen --symbols A,B,C` runs the VCP screener on those symbols. `breakout plan --account <id> --screen <file> [--write]` sizes against the account's equity, runs the breakout planner, and translates each actionable order into a plan; without `--write` it prints and stores nothing. Yahoo limits by network: a 429 after retries is reported with the cause; retry later or from another network.

## Inlet: any brokerage's holdings file

The agent reads the file and writes a mapping JSON, then the core does the rest. The agent adapts to whatever the brokerage gives; the core only enforces the target.

1. Save the source export outside the repo. The core refuses sources inside a git repository.
2. Author a mapping: `schema_version: 0`, `broker_label`, `format` (csv or json), refs for `as_of`, `cash`, each field, optional `control_total` and `account_number`. Refs are `{column}`, `{path}`, `{value}`, or for scalars `{regex, group}` against the raw text. Read `references/inlet-mapping.md` for the full shape before writing one.
3. `python3 -m finance_core --root <project> inlet check-mapping --mapping <file>`; fix until `valid: true`.
4. `python3 -m finance_core --root <project> account create --account <id> --base-currency <ccy> [--account-mask <tail>]` once per account, then `inlet ingest --account <id> --mapping <file> --source <file>`. `--account-mask` is the visible tail the broker shows (`496` for `****496`); the mapping's `account_number` is compared against it on the trailing characters both sides show. The raw number is never stored. A wrong mask is fixed with `account config --account <id> --key account_mask --value <tail>`; the rejection prints this command.
5. The ingest prints the summary and any warnings. A rejection lists every reason and writes nothing. Never guess a value to get past a rejection: ask the user.

Target record: `account_id`, `as_of`, `base_currency`, `cash`, `positions[]`, `source{file_sha256, imported_at}`, `warnings[]`. Account numbers are masked before anything is written.

Paper orders: `paper order --account <id> --order <json>` with `symbol`, `side` (buy|sell), `qty` (not `quantity`), `type` (market|limit|stop_entry|stop_loss), and `limit_price` or `stop_price` where the type needs one. `paper reconcile --statement` takes a snapshot file from `.finance/accounts/<id>/snapshots/`, not `current.json`.

Breakout: `breakout translate --item <json>` takes one planner actionable item: the object with `symbol`, `sector`, `plan_valid_for_session`, and a nested `trade_plan` (`signal_entry`, `worst_entry`, `stop_loss_price`, `risk_per_share`, `target_price`, `shares`, `risk_dollars`, `position_value`, `cumulative_risk_pct`, `binding_constraint`). Add `--write` to store the plan.

## Trade plans are shared outputs

Any playbook may emit a plan (P5 most often; P1 or P3 may emit one too). Plans are stored with `plan put` and read with `plan list`, so a later playbook reuses the plan rather than re-deriving it. A plan's mode is `planned`, `paper:<account_id>`, or `live:<account_id>`. `live:` requires an approval record naming the account, and the core records it but does not execute it in this version. A plan's `risk_per_share` may exceed the trigger-to-stop distance (the planner sizes from the worst entry) but never fall below it.

## Routing

1. Classify the request: portfolio, single name, market regime, screen, plan, size, validate, options, report.
2. Load `references/routing-table.md`, follow the chain from the first stage the request needs.
3. Load only the playbook file for the stage you are in.
4. Each stage's output is an artifact on disk (receipt, plan, report) and is cited by path in the answer.
5. Stop at a posture gate: if P2 says "no new entries", stop at plan and say so.

## Reporting

Every number in an answer is cited to a receipt path. Unverified numbers are labelled. Breakout planner and sizer outputs are used through the translator (`breakout translate`), not by re-typing values.

## Disclaimers in every analysis

Analysis is not a recommendation to trade. State the data date for every price and the snapshot date for every position.
