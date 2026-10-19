# P3 screen-candidates

Stage: screen. Reads: `market-data`, posture from P2. Emits: a candidate list (symbol, screen, score, date) and optionally a plan per candidate.

Run only the screens the user asked for. The VCP screen runs keyless: `market screen --symbols A,B,C`, and its output file feeds P5. The result reports `results` (symbols that passed the trend filter) and `valid_vcp` (the only ones that can become candidates); a weak or no-VCP result is monitor-only. Sector and market cap read Unknown and 0 because fundamentals are not provided. Read the posture from `market posture` (P2) first. A screen that needs a key with no `market-data` binding is reported as unavailable, not skipped silently. `stock-recap` moved here from research.
