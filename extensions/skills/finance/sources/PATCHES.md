# Local patches to harvested sources

Sources are upstream copies (mphinance/alpha-skills). These edits adapt them to the `sources/` layout; each is covered by a test in `scripts/tests/`.

| File | Change | Why |
|---|---|---|
| `edge-pipeline-orchestrator/scripts/orchestrate_edge_pipeline.py` | sibling script root is the parent of the skill directory, and the `skills/` prefix is dropped | upstream resolves siblings under `<repo>/skills/`; here they sit beside it in `sources/` (`tests/test_edge.py`) |
| `position-sizer/scripts/tests/test_position_sizer.py` | `test_cli_arguments` finds `position_sizer.py` from `__file__` | the test assumed the upstream repo root as the working directory |
| `theme-detector/scripts/tests/test_etf_scanner.py` | `test_both_fail_returns_none` reads `backend_stats()` | the scanner nests its counters per context |
| `theme-detector/scripts/etf_scanner.py` | `yf = None` when yfinance is not installed | tests patch `etf_scanner.yf`; the name did not exist without the package |
| `theme-detector/scripts/tests/test_etf_scanner.py` | yfinance fallback tests also patch `HAS_YFINANCE` and read `backend_stats()` | the fallback is gated on that flag; counters are nested per context |
| `theme-detector/scripts/tests/test_heat_calculator.py` | expected values recomputed by hand from the documented formulas; uptrend ratios are 0-1 fractions | the tests asserted a retired scoring scheme (heat weights 0.40/0.25/0.20/0.15, linear volume, step uptrend) |
| `theme-detector/scripts/calculators/heat_calculator.py` | docstring examples corrected (momentum 0/5/30/50%, volume 1.0) | examples disagreed with the formula they illustrate |
