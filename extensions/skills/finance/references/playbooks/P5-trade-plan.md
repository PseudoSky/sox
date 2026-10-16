# P5 trade-plan

Stage: plan. Reads: a candidate (P3) or a single name (P1), and the posture (P2). Emits: plan v0 via `breakout translate` then `plan put`.

1. Run `breakout plan --account <id> --screen <file> [--write]` on the screener file. It sizes against the account's equity, runs `breakout-trade-planner`, and translates every actionable order; steps 2 and 3 below describe what it does for each one, and `breakout translate` remains for a single hand-built item.
2. For each actionable item: `breakout translate --account <id> --item <file> --plan-id <id> --write`. Translation maps signal_entry → trigger_price, stop_loss_price → stop_price, target_price → targets, shares → quantity, risk_dollars → risk_amount, plan_valid_for_session → valid_until. Floats are converted through strings, never arithmetic.
3. Mode: `planned` by default. `paper:<id>` only when the user asks for a paper trade. `live:<id>` needs an approval record; the core will refuse without it.

Order templates in the planner output (Alpaca format) are not used.
