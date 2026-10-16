# finance

Portfolio review, single-name research, regime posture, screening, trade plans, position sizing, strategy validation, and portfolio reports. One entry point (`SKILL.md`) routes each request to a playbook in `references/playbooks/`.

## When to use

- A holdings file from any brokerage needs to become a tracked portfolio.
- You want analysis, a trade plan, or a report on a tracked account.
- You want a paper account to test fills against a plan.

## Inputs

- A holdings export, saved outside the repo.
- A per-file mapping JSON written by the agent (see `references/inlet-mapping.md`).
- Paper account config (commission, slippage, fill rules, option mode).

## Outputs

- A portfolio record under `.finance/accounts/<id>/` (snapshot, pointer, ledger, mappings).
- Plans under `.finance/plans/`, analysis receipts under `.finance/analysis/`, reports under `.finance/reports/`.

## Gates

Analysis, reads, screening, sizing, and paper fills run ungated. Live effects are gated and not implemented in this version: no broker is connected.

## Core

`scripts/finance_core` (stdlib Python). `python3 -m finance_core --root <project> --help`. Tests: `python3 -m pytest -q tests` from `scripts/`.

## Sources

`sources/` holds the harvested skill sources verbatim (`SKILL.source.md`).
