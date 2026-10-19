# Local patches to harvested sources

Sources are upstream copies (mphinance/alpha-skills). These edits adapt them to the `sources/` layout; each is covered by a test in `scripts/tests/`.

| File | Change | Why |
|---|---|---|
| `edge-pipeline-orchestrator/scripts/orchestrate_edge_pipeline.py` | sibling script root is the parent of the skill directory, and the `skills/` prefix is dropped | upstream resolves siblings under `<repo>/skills/`; here they sit beside it in `sources/` (`tests/test_edge.py`) |
| `position-sizer/scripts/tests/test_position_sizer.py` | `test_cli_arguments` finds `position_sizer.py` from `__file__` | the test assumed the upstream repo root as the working directory |
| `theme-detector/scripts/tests/test_etf_scanner.py` | `test_both_fail_returns_none` reads `backend_stats()` | the scanner nests its counters per context |
