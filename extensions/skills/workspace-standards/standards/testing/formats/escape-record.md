# Format: escape record

Clauses: §8.5, §11, §7.2, P3. Written by the triager on the defect item when a defect is found at a later stage than the earliest that could have caught it.

## Fields

| Field | Content |
|---|---|
| `defect` | Defect item id. |
| `found-at-stage` | Stage A to H where it was found (§7.1). |
| `earliest-stage` | The earliest stage that could have caught it (§8.5). |
| `lowest-tier` | The lowest tier that can observe the failure (§8.5 step 1). |
| `missing-test` | `yes` (the test is written by the fix) or `no`, with the test id. |
| `gap` | The fidelity-gap statement, when the failure is observable only at a higher tier (§8.5 step 3). |
| `change-class`, `rigor` | Class and rigor of the change that introduced the defect, copied from its testing record (§11). |
| `caught-by` | Tier of the test that caught it, and `redundant: yes/no` for retention. |

## Validity
Every field is required. A missing field is reported as "not measured" by the escape-rate metrics, never estimated (§11).

## Example
```
defect: ITEM-456
found-at-stage: E
earliest-stage: D
lowest-tier: S
missing-test: yes
change-class: new-behavior
rigor: standard
caught-by: P, redundant: no
```
