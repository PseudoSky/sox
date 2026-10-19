# P11 intraday-options-rules

Stage: analysis. Reads: values the user observes (signal grade, signal type, relative volume, time, trend age, open positions, trades today, day P&L, option P&L). Emits: an entry verdict or an exit verdict naming the rule that decided it.

Run: `intraday entry --grade A --signal mega_bull --rvol 1.5 --time 10:00 --trend-age 5 [--symbol SPY] [--weekday 0-4, Monday=0 to Friday=4; default today] [--open-positions N] [--trades-today N] [--day-pnl X --account-size S]` and `intraday exit --pnl-pct P --grade G [--entry-grade G0] [--signal-flipped] --time HH:MM`. Times are 24-hour Eastern.

These implement the `0dte-flow` rule tables exactly: the entry gate (grade at least B, a mega signal, relative volume above 1.2, 09:30 to 11:30, trend age under 15 bars, nothing open, at most two trades a day, never Friday) and the exit cascade S1, S2, S3, T1, P1, P2, P3, T2 where the first match wins. `--day-pnl` is today's realized P&L (0 on a fresh day); omit it and the daily-loss rule is reported as not evaluated. With `--account-size` the entry verdict also states the per-trade and daily-loss caps (40% and 80% of the account, the skill's $75 example scaled) and a warning that a full daily loss is 80% of the account; those are the playbook's ratios, not a recommendation. With `--symbol` it also checks that the signal fired on SPY, as the source requires.

- The signal feed (Ghost Alpha on TradingView) is external. The user supplies its values; none are fetched or guessed.
- `sources/0dte-flow` contains a Tradier `curl` order example and `sources/ghost-auto-trader` describes a bot that places live orders on a tool call. Neither is run or scaffolded here. Order placement is the gated E playbook and is not implemented.
- A verdict is decision support. The user places every order.
