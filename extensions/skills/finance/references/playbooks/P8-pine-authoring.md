# P8 pine-authoring

Stage: author. Reads: a strategy or indicator described in words, or an existing Pine file. Emits: a Pine script, or a Python port with its parity notes.

Source skills (instructions only, no scripts): `mph-pine` writes Pine v6 indicators and strategies and ships `channels.pine` as a worked reference; `pine-to-python` ports a `.pine` file to Python.

1. Authoring: read `sources/mph-pine/SKILL.source.md` and follow it. The script is compiled by the user in TradingView's Pine Editor, which needs a TradingView account; say so and never claim it compiled.
2. Porting: read `sources/pine-to-python/SKILL.source.md`. Name every construct that has no Python equivalent instead of approximating it silently.
3. A script is advisory. Placing trades and wiring alerts to a broker belong to E and are not implemented.
4. Hand the finished strategy to P7 for a backtest with a stated data range.
