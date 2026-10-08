# Playbook: run testing

`/workspace-standards run testing` for one work item. Returns what the item needs; writes nothing to the repository. Modes: `retention-audit`, `flake-triage` (resolve with `scripts/ws.mjs run testing --mode <name>`).

## Input
The work item (text, acceptance criteria) and the paths it changes.

## Steps
1. Classify and derive rigor with `cards/role/classifier.md` (§6.1.1, §6.6). Where the repository has a routing command (the `test-routing` capability the `apply` playbook installs), call it and use its output; otherwise apply the card by hand and say so in the Record.
2. Read the authorship mode from the rigor (§6.6, §14): Light, the implementer MAY author (`cards/role/implementer-light.md`); Standard, separated authorship is the default; Deep, separated authorship is required. Work with no coordinator and Deep rigor is refused or escalated to the owner (§13.2).
3. Select exactly one card by class from `standard.json` `workClasses`: new behavior `author-new-behavior`; defect fix `author-regression`; boundary or contract `author-contract`; refactor `characterize`; configuration or dependency `select-checks`; test maintenance `maintain`; no-code none. A bucket of two or more items at Standard or Deep starts with `plan-bucket`.
4. Resolve every role the item needs to its holder with the routing foundation (`scripts/ws.mjs run routing`). An unbound role becomes review debt; at Deep an unbound test author, static reviewer, or auditor blocks the change (§13.1).
5. Return the slice: class, rigor, triggers, authorship mode, the one card (inline), the roles with holders, the gates that apply (`standard.json` `gates`; no class relaxes G1, G2, G4, G10, G12 — §6.7).

## Output
`{ class, rigor, triggers, authorship, card, roles, gates }`. Do not return the whole policy.

## Record
Write the testing record (`formats/testing-record.md`) onto the work item, plus one line naming how the class was derived (routing command or classifier card) and each role's holder with its closeness evidence.
