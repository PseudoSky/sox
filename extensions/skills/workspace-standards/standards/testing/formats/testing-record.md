# Format: testing record

Clauses: §6.1.1, §6.1.3, §6.6, §10, G12. A convention inside the body of an existing work item; the backlog structure does not change. The routing command derives `rigor` and records it; nobody chooses it.

## Fields

| Field | Content |
|---|---|
| `change-class` | `new-behavior`, `defect-fix`, `refactor`, `configuration`, `dependency`, `boundary-contract`, `no-code`, or `test-maintenance` (§6.1.1). |
| `rigor` | `none`, `light`, `standard`, or `deep`, derived (§6.6). |
| `triggers` | The triggers hit, or `none`. |
| `ac` | `AC1 <criterion> ; AC2 <criterion> ; ...` |
| `not-testing` | Failure modes left untested and why, or `none` (§6.1.3). Required at Standard and Deep. |
| `plan` | `<failure mode> -> <tier> -> <AC>`, one line per AC at Light. |
| `expires` | Date. Exception items only (§10). |

## Block
```
## Testing record
change-class: new-behavior | defect-fix | refactor | configuration | dependency | boundary-contract | no-code | test-maintenance
rigor: none | light | standard | deep
triggers: <the triggers hit> | none
ac: AC1 <criterion> ; AC2 <criterion> ; ...
not-testing: <failure modes left untested, and why> | none
plan: <failure mode -> tier -> AC>
expires: <date>
```

## Validity
A change with no record is treated as new behavior at Standard. A record at Standard or Deep without `not-testing` fails G12.
