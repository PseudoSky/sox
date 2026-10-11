# Standard contract

T14.AC2, T14.AC10. A standard registers in `registry.json` only when it provides every item below. `review all` reports each missing item as a finding (`scripts/review-all.mjs`); `scripts/conformance.mjs <standard>` runs the standard's own conformance specification.

## What a standard provides

| # | Item | Form | Registry key |
|---|---|---|---|
| 1 | Portable policy | A document in the adopting repository that names no agent, tool, or runner. | `policy` |
| 2 | Declaration | Machine-readable `standard.json` (schema `schemas/standard.schema.json`) with `roles`, `workClasses`, `gates`, `carriers`. | `declaration` |
| 3 | Carrier per clause | Every policy clause maps to one carrier: `check`, `field`, `brief-slice`, or `card`, in that order of preference (a clause a check can carry never rests on judgment). | `declaration` > `carriers` |
| 4 | Conformance specification | `conformance.spec.json`: a list of checks a script can run (`scripts/conformance.mjs`). | `conformance` |
| 5 | `apply` template | The managed-block template `apply` writes. | `applyTemplate` |
| 6 | Playbooks | One per verb (`review`, `run`, `apply`), each ending in `## Record`. | `playbooks` |
| 7 | Optional `routing: own` / `gates: own` | Declaration key `own: ["routing", "gates"]`. Absent, the `routing` and `gates` foundations write the routing and gate content and `apply <standard>` writes domain content only. Present, that foundation skips the standard and reports it skipped; the standard's own playbook writes and reviews that part. | `declaration` |

## Declaration fields

- `roles[]`: `{ role, obligations[{id, text, clauses[]}], tools[], distinctFrom[], hints[], noHolder }`. The prose and machine form live in the standard's `roles.md`; the declaration lists the role names and `roles.md` is authoritative for obligations.
- `workClasses[]`: `{ id, defaultRigor, role, card }`. `defaultRigor` is `none|light|standard|deep`. `role` is optional (`null` when the class needs no role) and names the `roles.md` role whose holder takes the class in the routing table.
- `gates[]`: `{ id, threshold, mechanism, stage[] }`. `mechanism` is the enforcement class (`mechanical` or `review`); the concrete tool is bound by the adopting repository, never here. The gate set's name in the registry is the registry key `gateSet` (optional; default `<id>-gates`, so testing names its set `test-gates`).
- `carriers`: `{ <clause id>: check|field|brief-slice|card }`.
- `own`: optional list drawn from `routing`, `gates` (the declaration form of `routing: own` / `gates: own`; a separate key because `gates` is already the gate list).

## `roles-covered` declaration (D23)

An agent states which role obligations it covers so role resolution never scores free text. Obligation ids are drawn from the standard's `roles.md` (`<ROLE>.<n>`, for example `AU.2`).

- On disk, in the agent's `extension.json`, one `capabilities` entry per obligation: `"roles-covered:AU.2"`. `capabilities` is the schema-valid open string list of the manifest; the agent IR (`agent`) rejects unknown keys.
- Normalized form: `schemas/roles-covered.schema.json`.
- `scripts/review-routing.mjs --agents-dir <dir> --roles <roles.md>` reports every agent with no declaration (`no-roles-covered-declaration`) and every id that `roles.md` does not define (`unknown-obligation-id`), and every `roles.md` hint naming no installed agent (`unresolved-hint`); exit 1 on any finding. An `agent["roles-covered"]` list is not the declaration and is reported as a missing one.
- Closeness (rank by count of covered obligations, then fewest other roles held) is computed by the routing foundation's `run` playbook from these entries and `roles.md`.
