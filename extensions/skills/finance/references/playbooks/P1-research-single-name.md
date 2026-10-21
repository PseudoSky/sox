# P1 research-single-name

Stage: research. Reads: `market-data`. Emits: a research note (markdown, cited by path) and optionally a plan (P5 input).

Source skills: us-stock-analysis, stock-analyzer, technical-analyst, and claude-equity-research (`sources/claude-equity-research/research-command.md`, `methodology.md`). Use the methodology as written; do not re-derive it.

If `market-data` is absent, stop after stating which inputs are missing. Numbers without a data date are labelled unverified.
Core commands for the numbers: `market bars --symbol <S>` (levels and moving averages are computed from the cached bars, cited to the cache path), `market screen --symbols <S>` (the trend and VCP verdict; it gives a rating, not a per-rule reason). A name without a valid VCP has no planner output: size a hand-chosen entry and stop with `breakout size` (P6) and store it as in P5 step 4.
