# P12 portfolio-report

Stage: report. Terminal. Reads: P0 receipts, the plan index, the account config, and optionally P2, P4, P9 receipts. Emits: `.finance/reports/<as_of>.md` and `.json`.

`report --as-of <date>` recomputes the analysis through the same code path as P0, writes receipts, and renders. Sections: executive summary, holdings overview, allocation, risk, active plans, action items (from warnings and plans expiring within 3 days only), appendix with receipt paths. No number is typed by hand.
