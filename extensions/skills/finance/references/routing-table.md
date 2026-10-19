# Routing table

Stage chain. A request enters at the first stage it needs and never skips a gate.

```
P0 portfolio ─┐
P1 research ─► P2 assess ─► P3 screen ─► P5 plan ─► P6 size ─► P7 validate ─► E execute (gated; no live broker here)
                 ▲ a posture of "no new entries" stops the chain at P5 and says so
P12 report renders P0, the plan index and receipts; it is terminal.
P4 dividend, P8 pine, P9 options, P10 discovery and P11 intraday rules are side branches.
```

| Playbook | Stage | Status | Source skills | Reads | Emits |
|---|---|---|---|---|---|
| P0 portfolio-review | portfolio | keep | portfolio-manager | inlet record | analysis receipt |
| P1 research-single-name | research | keep | us-stock-analysis, stock-analyzer, technical-analyst, claude-equity-research | market-data | research note, optional plan |
| P2 regime-posture | assess | keyed | market-breadth-analyzer, uptrend-analyzer, breadth-chart-analyst, market-top-detector, ftd-detector, ibd-distribution-day-monitor, downtrend-duration-analyzer, macro-regime-detector, us-market-bubble-detector, market-environment-analysis, exposure-coach, sector-analyst, market-news-analyst, economic-calendar-fetcher, scenario-analyzer, stanley-druckenmiller-investment | market-data | posture |
| P3 screen-candidates | screen | keyed | stock-recap, vcp-screener, canslim-screener, pead-screener, earnings-trade-analyzer, finviz-screener, batch-scanner, coil-scan, momentum-squeeze, magnet-path, theme-detector, institutional-flow-tracker, earnings-calendar, pair-trade-screener | market-data, posture | candidate list |
| P4 dividend-income | screen/monitor | keyed | value-dividend-screener, dividend-growth-pullback-screener, kanchi-dividend-sop, kanchi-dividend-review-monitor, kanchi-dividend-us-tax-accounting | market-data | candidate list |
| P5 trade-plan | plan | keep | breakout-trade-planner | candidate, posture | plan v0 |
| P6 position-size | size | keep | position-sizer | plan, account equity | plan with quantity |
| P7 validate-strategy | validate | keep | backtest-expert, strategy-pivot-designer, signal-postmortem, quant-feature-engineer | plan or strategy | validation receipt |
| P8 pine-authoring | author | keep | mph-pine, pine-to-python | strategy | Pine script, Python port |
| P9 options-analysis | analyze | keyed | options-strategy-advisor | market-data | options receipt |
| P10 strategy-discovery | research | keep | edge-candidate-agent, edge-hint-extractor, edge-concept-synthesizer, edge-strategy-designer, edge-strategy-reviewer, edge-pipeline-orchestrator, edge-signal-aggregator | market-data | strategy drafts |
| P11 intraday-options-rules | analysis | keep | 0dte-flow, ghost-auto-trader (reference only) | observed signal values | entry/exit verdict |
| P12 portfolio-report | report | keep | none (renders) | P0 receipts, plan index, P2, P4, P9 | report md and json |
| E execute | effect | GATED | broker-mcp-selector, webull-openapi (gated, not harvested) | plan | live effect, not in this version |

Every harvested source skill appears in exactly one row (P0 includes portfolio-manager; claude-equity-research's research command is in P1).

## Feed rules

- P0 → every stage that needs holdings or equity (P5, P6, P12).
- P5 → P6 → P7 → E. Any stage may write a plan; P5 is the default author.
- A plan's `mode` decides its path: `planned` stops at the plan, `paper:<id>` goes to the paper broker (ungated), `live:<id>` goes to E (gated).
- P12 never recomputes: it reads the receipts and the plan index.
