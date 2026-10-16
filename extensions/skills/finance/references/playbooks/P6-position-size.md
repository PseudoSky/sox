# P6 position-size

Stage: size. Reads: a plan and the account equity from P0. Emits: the plan with quantity and risk_amount reconciled.

Source skills: `position-sizer`. Its inputs come from the plan and the account; the sized quantity must equal the plan's quantity or the plan is re-put with the new value and `supersedes` set to the prior plan_id.
