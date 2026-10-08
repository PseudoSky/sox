# Format: audit record

Clauses: §8.1, §8.2, §8.3, §14, R1, R2, R3, R4, R5, R6. One record per test under review, written by the auditor on the retention ticket or the work item.

## Fields

| Field | Content |
|---|---|
| `test` | Test id or path. |
| `auditor` | The auditing session; `authorship-check` below must clear it. |
| `authorship-check` | The authorship record read, and the result: `not-auditor` or `refused` (§14). |
| `R1`..`R6` | `yes` or `no` per question with the evidence and the method (mutation kill-set, fault injection, reviewer analysis). Stop recording at the first `no`. |
| `verdict` | `keep`, `lower`, `rewrite`, `quarantine`, or `remove` (§8.1). |
| `action` | The change made or queued; for `lower`, the parity evidence (§8.3). |
| `confirmed-by` | The different party that confirmed an edit or removal, or `review debt: owner, expiry` (§14). |

## Validity
- Age alone is never evidence (§8.2).
- `verdict: remove` requires a removal record.
- `confirmed-by` is mandatory when the auditor edited or removed a test.

## Example
```
test: suite/parser/dup-id
authorship-check: not-auditor
R1: yes (fails when dedupe is deleted; fault injection)
R2: no (test parser/dup-key kills every fault this one kills; kill-set diff)
verdict: remove
confirmed-by: <party>
```
