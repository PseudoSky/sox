# Format: test header

Clauses: §6.1.8, §6.2, §6.4, §6.5, G9, G12. Written once per test, in the test's own file or label, in whatever comment syntax the language uses. The IMPLEMENTATION fixes the concrete syntax; the fields do not change.

## Fields

| Field | Required | Content |
|---|---|---|
| `guards` | always | The one failure mode this test guards, in one line. |
| `tier` | always | `S`, `P`, `H`, or `X` (§2.1). |
| `gap` | tier P, H, X | `This cannot be observed at tier <T-1> because <concrete property>.` (§6.2, G9) |
| `cites` | always | Work item id and criterion id(s) it proves (G12). |
| `tags` | optional | `smoke`, `contract`, `conformance`, `regression:<defect id>`, `property`, `characterization`, `security`, `performance`, `accessibility`, `concurrency`, `durability` (§2.3). |
| `teeth` | new behavioral test | `red: <command> -> exit <n>; <failing assertion>` recorded against the stub commit, or the base commit when authorship is not separated (§6.5). |
| `owner`, `replace-by` | `characterization` | Who replaces the test and by when (§6.4). |

## Validity
- `gap` names a property that disappears one tier lower. "More realistic", "the real flow", "easier to write" are invalid.
- `tier` S has no `gap`. A test missing a required field fails G12; a missing or invalid `gap` fails G9.

## Example
```
guards: a duplicate id is rejected, not overwritten
tier: S
cites: ITEM-123 AC2
teeth: red: <test command> -> exit 1; expected error "duplicate id", got ok
```
