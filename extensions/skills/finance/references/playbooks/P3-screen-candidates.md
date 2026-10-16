# P3 screen-candidates

Stage: screen. Reads: `market-data`, posture from P2. Emits: a candidate list (symbol, screen, score, date) and optionally a plan per candidate.

Run only the screens the user asked for. The VCP screen runs keyless: `market screen --symbols A,B,C`, and its output file feeds P5. A screen that needs a key with no `market-data` binding is reported as unavailable, not skipped silently. `stock-recap` moved here from research.
