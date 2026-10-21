# P2 regime-posture

Stage: assess. Reads: `market-data`. Emits: posture, one of `full`, `reduced`, `no-new-entries`, with the signals that set it and their dates.

Run: `market posture [--symbols SPY,QQQ,IWM]`. It reads daily bars (200-day and 50-day averages, drawdown from the 52-week high) and writes a dated receipt under `.finance/posture/`. SPY must be among the symbols.

- `no-new-entries`: SPY below its 200-day average, or 10% or more below its 52-week high.
- `reduced`: SPY below its 50-day average, 5% or more below its high, or fewer than two of the indices above their 200-day average.
- `full`: none of the above.

Only SPY's 50-day average, drawdown and 200-day average are tested individually; the other indices count solely toward the "two above their 200-day average" tally, so an index below its 50-day average, or one stray index below its 200-day average, does not change the posture.

What the posture does: `breakout plan` and `recommend` read the latest receipt (at most 3 days old). `reduced` sizes new entries at half the normal risk (0.25% of equity per trade instead of 0.5%); `no-new-entries` makes `breakout plan` refuse unless `--ignore-posture` is passed. The posture is unbuffered: a close 0.1% under the 50-day average flips it to `reduced`, and the receipt does not smooth that. When the margin in `signals` is small, rerun on the next session's close before changing sizing. The posture governs entries. The `regime` printed by `market edge` describes breadth inside the symbols you passed, a different measure; when the two disagree, follow the posture and treat the edge regime as context for that universe.

A receipt is JSON at `.finance/posture/<as_of>.json` with `posture`, `as_of`, `reasons`, `signals`, `sources` and `rules`; to see the effect of another posture on sizing, write a copy with `"synthetic": true` into a scratch root and say so. The receipt lists each rule that fired. It uses price action only: no breadth, news or macro feeds. For a richer read, run the source skills in `references/routing-table.md` (all keyed) and state which were run; the price-action posture is still the fallback when none can run. A `no-new-entries` posture stops the chain at P5 and is written into the answer.
