# P11 intraday-options-rules

Stage: analysis. Reads: values the user observes (signal grade, signal type, relative volume, time, trend age, open positions, trades today, day P&L, option P&L). Emits: an entry verdict or an exit verdict naming the rule that decided it.

Run: `intraday entry --grade A --signal mega_bull --rvol 1.5 --time 10:00 --trend-age 5 [--symbol SPY] [--weekday 0-4, Monday=0 to Friday=4; default today] [--open-positions N] [--trades-today N] [--day-pnl X --account-size S [--max-trade-pct P --max-daily-loss-pct Q]]` and `intraday exit --pnl-pct P --grade G [--entry-grade G0] [--signal-flipped] --time HH:MM`. Times are 24-hour Eastern.

These implement the `0dte-flow` rule tables exactly: the entry gate (grade at least B, a mega signal, relative volume above 1.2, 09:30 to 11:30, trend age under 15 bars, nothing open, at most two trades a day, never Friday) and the exit cascade S1, S2, S3, T1, P1, P2, P3, T2 where the first match wins. `--day-pnl` is today's realized P&L (0 on a fresh day); omit it and the daily-loss rule is reported as not evaluated. The source's caps (40% of the account per trade, 80% daily loss) come from a $75 example account, so the core applies them by default only to accounts up to $1,000. For a larger account `--account-size` states no dollar caps and warns until you pass `--max-trade-pct` and `--max-daily-loss-pct` (percent of the account); the daily-loss rule is evaluated only when `--day-pnl` and a daily-loss limit are both known. `--premium P [--contracts N]` adds the order cost (P x 100 x N) and, when a per-trade cap applies, the rule `order_cost_within_max_per_trade`; without a cap the cost is reported and not judged. The gate has no stop-price input, and the exit cascade has no drawdown-from-peak rule (S1 is a 50% loss from entry); the source describes neither. The source's grade wording (A+/A) is looser than the gate (B or better), and its primary underlying is XSP with an SPY fallback of far-out-of-the-money strikes, which the core does not check. With `--symbol` it also checks that the signal fired on SPY, as the source requires.

A verdict is a successful evaluation: `allowed: false` and `action: sell` both exit 0 with the failed rules listed. Exit 2 is reserved for a malformed input (bad grade, time or number).

Exit cascade, first match wins (`pnl` is the option's percent gain or loss):

| rule | fires when |
|---|---|
| S1 hard stop | pnl <= -50 |
| S2 grade death | grade D or F |
| S3 reversal | `--signal-flipped` |
| T1 end of day | time at or after 14:30 |
| P1 double | pnl >= 100 |
| P2 fading | pnl >= 30 and grade C or worse and worse than `--entry-grade` (grade B never fades) |
| P3 afternoon | pnl >= 50 and time after 13:00 |
| T2 dead money | time at or after 12:00 and pnl between -10 and 10 |

Examples: `exit --pnl-pct -55 --grade B --time 10:20` sells on S1; `exit --pnl-pct 35 --grade C --entry-grade A --time 10:45` sells on P2; `exit --pnl-pct 35 --grade B --entry-grade A --time 10:45` holds, because a B is not a fade.

- The signal feed (Ghost Alpha on TradingView) is external. The user supplies its values; none are fetched or guessed.
- `sources/0dte-flow` contains a Tradier `curl` order example and `sources/ghost-auto-trader` describes a bot that places live orders on a tool call. Neither is run or scaffolded here. Order placement is the gated E playbook and is not implemented.
- A verdict is decision support. The user places every order.
