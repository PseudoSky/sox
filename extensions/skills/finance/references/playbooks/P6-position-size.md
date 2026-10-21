# P6 position-size

Stage: size. Reads: a plan and the account equity from P0. Emits: the plan with quantity and risk_amount reconciled.

Source skills: `position-sizer`. Its inputs come from the plan and the account; the sized quantity must equal the plan's quantity or the plan is re-put with the new value and `supersedes` set to the prior plan_id.
Without a plan: `breakout size --account <id> --entry E --stop S [--risk-pct 0.5] [--max-position-pct 10]` sizes against the account's equity and prints shares (floored), position value, risk dollars and the binding constraint (`max_position_pct` when the cap reduced the count, else `risk_budget`), after applying the posture the way `breakout plan` does (`--ignore-posture` skips it and says so in the reply). Nothing is stored. When the reply warns that the position exceeds buying power, resize to `floor(buying_power / entry)` shares or fewer, then re-put the plan with `supersedes` set to the prior `plan_id`.
