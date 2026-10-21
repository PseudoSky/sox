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

- `market-data`: daily bars for US stocks and ETFs, keyless, unofficial, personal use only, cached under `.finance/market/`. Yahoo's chart endpoint is tried first (adjusted close, dividends, splits). Only if Yahoo fails does Nasdaq's public historical endpoint supply unadjusted OHLCV with no dividends or splits; the record's `provider` and `adjusted` fields say which answered, and `market screen` and `market edge` return a `warnings` entry naming every symbol on unadjusted prices. Fundamentals, options chains and market-breadth feeds are not provided, so playbooks that need them report "unavailable". Required by P1, P2, P3, P6 input, P9.
- `inlet`: reads a holdings file from outside the repo and returns a mapping proposal. Used by P0 import.
- `paper-broker`: the local paper broker. Places orders, applies fills, cancels, reports positions. Always available.
- `broker-read`: live read of a real brokerage account. Absent in this version.
- `broker-live`: live order effects. Absent in this version. Gated.

## Core commands

The deterministic core is `scripts/finance_core` (stdlib Python). Run it from the skill's `scripts/` directory: `cd <skill>/scripts && python3 -m finance_core --root <project> <group> <command>`. Output is JSON on stdout; a rejection of the command is JSON on stderr with exit 2, while a verdict or a refused paper fill (`status: rejected`, with `reason`) is a normal reply with exit 0. `--root` is the directory holding `.finance/`.

Market data and proposals: `market bars --symbol <S> [--range 1y]` fetches and caches bars. `market screen --symbols A,B,C` runs the VCP screener on those symbols. `breakout plan --account <id> --screen <file> [--write]` sizes against the account's equity, runs the breakout planner, and translates each actionable order into a plan; without `--write` it stores no plans (the planner's own output file is still kept under `.finance/market/plans/` and named in the reply). The planner's `watchlist` is breakout alerts only (a valid VCP that is not yet actionable); the `watchlist` in `recommend` is near-miss screen results, a different list. `market universe [--index sp500] [--sector S] [--limit N]` lists constituents keylessly and `market screen --index sp500` screens them; `--sector` takes the exact sector name (`Information Technology`, not `Technology`; an unknown name lists the valid ones), and `--top N` sets how many scored results the file keeps and the reply reports the `funnel`. The screen summary's `weak` count includes `No VCP` results. `market bars` caches one file per symbol; a cached longer range serves a shorter request, and the reply warns when the newest bar is a session still forming (before 16:00 ET). `--provider yahoo|nasdaq` forces a source. After a Yahoo 429 the core skips Yahoo for 30 minutes and uses Nasdaq; if every provider fails the error lists each cause.

Recommendations: `recommend --account <id> [--screen <file>]` states what to do with the portfolio as decision support: a trim proposal (whole shares rounded up so the position ends at or under the limit; a smaller excess than one share is noted, not trimmed; shares, proceeds, resulting weight, estimated realized gain, the alternative of adding other holdings) for each position above the 25% limit, the entry policy from the posture, a watchlist of near-miss screen results with pivots, and sized entry proposals when a screen has valid patterns. A trim's `proposal` is a limit order at `reference_price` or better; the trim is sized at that price, so after a price move rerun `recommend` before acting. It writes a receipt and places nothing.

Paper fills: `paper order` returns an order id; `paper fill --account <id> --order-id <id> --latest-bar` fills it from the symbol's most recent daily bar (or `--bar <json>` for any bar). With `--latest-bar` the reply warns when that bar's session is still open (before 16:00 ET): its high, low and close will change. After the fill the position is marked at the fill price, which for market and limit fills is the bar's open, not its close. A market order fills at the bar's open plus slippage; a limit sell fills at the better of the open and the limit when the bar's high reaches it, and a limit buy at the lower of the open and the limit when the low reaches it. The reply shows `fill_rule` and, for sells, `realized_pnl` against the average cost at the fill; analysis and the report list the realized total, mark each position with its own price date, and warn when marks come from different dates.

Receipts: a re-run that changes a receipt keeps the previous one under the receipt folder's `history/`. Analysis, recommend and report warn when the snapshot is two or more days old. `recommend` receipts record the paper ledger position they were made at, and the report marks one STALE after a later fill.

Posture and income: `market posture` gives `full`, `reduced` or `no-new-entries` from index trend and drawdown (P2). `analyze --account <id> --income [--write]` reports trailing-12-month dividends per position (P4). `breakout plan` halves its risk when the posture is `reduced` and refuses when it is `no-new-entries`. The report flags any non-cash position above 25% of equity.

Edge discovery and intraday rules: `market edge --symbols A,B,C,...` runs the edge research pipeline on cached bars (needs pandas and pyarrow; dry run unless `--export`). `intraday entry|exit` checks the 0DTE entry gate and exit cascade from values you observe (`--symbol SPY` checks the signal's underlying); it places nothing.

## Inlet: any brokerage's holdings file

The agent reads the file and writes a mapping JSON, then the core does the rest. The agent adapts to whatever the brokerage gives; the core only enforces the target.

1. Save the source export outside the repo. The core refuses sources inside a git repository.
2. Author a mapping: `schema_version: 0`, `broker_label`, `format` (csv or json), refs for `as_of`, `cash`, each field, optional `control_total` and `account_number`. Refs are `{column}`, `{path}`, `{value}`, or for scalars `{regex, group}` against the raw text. Read `references/inlet-mapping.md` for the full shape before writing one.
3. `python3 -m finance_core --root <project> inlet check-mapping --mapping <file>`; fix until `valid: true`. Add `--source <export>` to also resolve the scalar refs (`as_of`, `cash`, `control_total`, `account_number`) against the real file and print the values read; without it only the mapping's shape is checked. `inlet ingest` additionally applies the row filters and reconciles the totals. `broker_label` is a short lowercase name you choose for the broker; `--account-mask` is the digits the export shows for the account.
4. `python3 -m finance_core --root <project> account create --account <id> --base-currency <ccy> [--account-mask <tail>]` once per account, then `inlet ingest --account <id> --mapping <file> --source <file>`. `--account-mask` is the visible tail the broker shows (`496` for `****496`); the mapping's `account_number` is compared against it on the trailing characters both sides show. The raw number is never stored. A wrong mask is fixed with `account config --account <id> --key account_mask --value <tail>`; the rejection prints this command.
5. The ingest prints the summary and any warnings. A rejection lists every reason and writes nothing. Never guess a value to get past a rejection: ask the user.

Target record: `account_id`, `as_of`, `base_currency`, `cash`, `positions[]`, `source{file_sha256, imported_at}`, `warnings[]`. Account numbers are masked before anything is written.

Paper orders: `paper order --account <id> --order <json>` with `symbol`, `side` (buy|sell), `qty` (not `quantity`), `type` (market|limit|stop_entry|stop_loss), and `limit_price` or `stop_price` where the type needs one (prices and quantities are strings, since a float is rejected), and optionally `plan_id` to link the order to a stored plan. Order ids are `ord-<ledger seq>`, so numbers are skipped when other events intervene. A plan id is lowercase letters, digits, `_` and `-`. A paper buy is rejected at fill time when it costs more than cash plus cash-equivalent positions (the reply says `buying power`); `account config --account <id> --key allow_margin --value true` permits an overdraw, which then warns that cash is negative. A `stop_entry` buy fills only when the bar's high reaches its `stop_price`, at the larger of the bar's open and the stop (a gap up fills at the open), and `stop_loss` only when the low reaches it, at the smaller of the open and the stop; otherwise `paper fill` returns `status: open` and the order stays open. `paper reconcile --statement` takes a snapshot file from `.finance/accounts/<id>/snapshots/`, not `current.json`, and compares the paper ledger (the snapshot plus paper fills) with it: a statement taken before the paper trades reports them as quantity, missing-position and cash discrepancies; one that already includes them reports none; a cash figure that differs reports `cash_mismatch`.

Breakout: `breakout size --account <id> --entry E --stop S [--risk-pct 0.5] [--max-position-pct 10] [--ignore-posture]` applies the posture like `breakout plan` (half risk when reduced, a refusal when no-new-entries, the reply's `posture` shows what applied or that the override was used) and returns floored shares, position value and risk for one long trade without a screen or a plan; `breakout translate --account <id> --item <json or file path> --plan-id <id> [--mode planned] [--write]` takes one planner actionable item: the object with `symbol`, `sector`, `plan_valid_for_session`, and a nested `trade_plan` (`signal_entry`, `worst_entry`, `stop_loss_price`, `risk_per_share`, `target_price`, `shares`, `risk_dollars`, `position_value`, `cumulative_risk_pct`, `binding_constraint`). Add `--write` to store the plan.

## Trade plans are shared outputs

`breakout plan`, `recommend`, `analyze` and `report` need an imported holdings snapshot for the account; without one they say to run `inlet ingest`. `market edge` needs at least 3 symbols. When a trade is done, `plan close --plan-id <id> [--status closed|cancelled] [--reason <text>]` ends its plan so it stops counting as open risk and drops out of Active trade plans; a paper sale that leaves a symbol flat names the plans still active. Any playbook may emit a plan (P5 most often; P1 or P3 may emit one too). Plans are stored with `plan put` and read with `plan list`, so a later playbook reuses the plan rather than re-deriving it. A plan's mode is `planned`, `paper:<account_id>`, or `live:<account_id>`. `live:` requires an approval record naming the account, and the core records it but does not execute it in this version. A plan is rejected when its stop is on the wrong side of the trigger or a target is on the loss side of it. A plan's `risk_per_share` may exceed the trigger-to-stop distance (the planner sizes from the worst entry) but never fall below it.

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
