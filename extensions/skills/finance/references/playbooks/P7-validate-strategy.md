# P7 validate-strategy

Stage: validate. Reads: a plan or a strategy. Emits: a validation receipt (backtest or postmortem), citing data source and date range.

Source skills: backtest-expert, strategy-pivot-designer, signal-postmortem, quant-feature-engineer. A backtest without a stated data range is not reported.
The core has no backtest command. Fetch bars with `market bars --range 5y`, run the test as an explicitly labelled ad-hoc script, and report the window, trade count, cost assumptions and the missing out-of-sample check. `sources/backtest-expert` scores aggregate statistics the user supplies; it does not simulate trades.
