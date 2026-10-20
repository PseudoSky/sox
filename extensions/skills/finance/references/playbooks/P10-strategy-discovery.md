# P10 strategy-discovery

Stage: research. Reads: bars from `market-data` for a universe of at least three symbols. Emits: edge tickets, hints, concepts and reviewed strategy drafts under `.finance/edge/<stamp>/pipeline/`.

Run: `market edge --symbols A,B,C,... [--range 1y] [--as-of YYYY-MM-DD] [--export]`. Without `--export` the run is a dry run. It needs `pandas` and `pyarrow` (`python3 -m pip install pandas pyarrow`); a missing dependency is reported, not skipped.

The chain is the harvested edge-* skills in order: `edge-candidate-agent` (detects candidates from the bars), `edge-hint-extractor`, `edge-concept-synthesizer`, `edge-strategy-designer`, `edge-strategy-reviewer` (at most two revise iterations), then export of passing drafts. `edge-pipeline-orchestrator` runs them. `edge-signal-aggregator` merges outputs from several skills into one ranked signal list and is run by hand with its own `SKILL.source.md`.

- A result of `candidates: 0` is a valid answer: the detector ran and nothing in the universe qualified. Report it as such and do not lower thresholds to produce one.
- Bars normally come from Yahoo (adjusted). If any symbol fell back to unadjusted Nasdaq prices, the run reports `adjusted_prices: false` and a `warnings` entry naming them; treat gap and return features near splits and dividends as unreliable and rerun when Yahoo answers.
- Drafts are hypotheses. Send any draft to P7 for a backtest before it reaches P5.

`market edge` also returns `drafts` (the draft files) and `notes`. Anomalies in `tickets/anomalies.json` are outliers on single symbols, not signals. Draft conditions are the concept's observed values, rounded by the review loop (whole numbers from 10 up, one decimal from 1 to 10, one significant figure below 1); they are single observations, not fitted thresholds, so open each draft and check its conditions before a P7 backtest.
