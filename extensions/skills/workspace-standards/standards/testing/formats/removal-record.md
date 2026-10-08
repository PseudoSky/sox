# Format: removal record

Clauses: §8.4, §8.3, §10, R1, R2, R3. One record per removed test, in the same change that supplies the evidence. A different party than the remover confirms.

## Fields

| Field | Content |
|---|---|
| `test` | Id or path of the removed test. |
| `failed-question` | `R1`..`R6` and the evidence (§8.4 step 1). |
| `covering-test` | The cheaper test or parity proof that still covers each `regression:<id>` the removed test carried; or `requirement-retired: <record>` (§8.4 step 2). |
| `reviewer` | The confirming party, not the remover. |
| `exception` | When coverage cannot be shown: a risk acceptance with a named owner and expiry in the exception log (§10). |

## Validity
- No removal without per-test evidence; no batch records.
- `covering-test` or `requirement-retired` or `exception` must be present.

## Example
```
test: suite/parser/dup-id
failed-question: R2 (parser/dup-key kills every fault this test kills)
covering-test: suite/parser/dup-key
reviewer: <party>
```
