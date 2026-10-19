# P2 regime-posture

Stage: assess. Reads: `market-data`. Emits: posture, one of `full`, `reduced`, `no-new-entries`, with the signals that set it and their dates.

Run: `market posture [--symbols SPY,QQQ,IWM]`. It reads daily bars (200-day and 50-day averages, drawdown from the 52-week high) and writes a dated receipt under `.finance/posture/`. SPY must be among the symbols.

- `no-new-entries`: SPY below its 200-day average, or 10% or more below its 52-week high.
- `reduced`: SPY below its 50-day average, 5% or more below its high, or fewer than two of the indices above their 200-day average.
- `full`: none of the above.

The receipt lists each rule that fired. It uses price action only: no breadth, news or macro feeds. For a richer read, run the source skills in `references/routing-table.md` (all keyed) and state which were run; the price-action posture is still the fallback when none can run. A `no-new-entries` posture stops the chain at P5 and is written into the answer.
