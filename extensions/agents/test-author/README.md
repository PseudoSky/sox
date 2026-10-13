# test-author

Separated test authorship (595965cc T22). Plans a bucket's tests and authors failing tests from the specification, in a write scope the brief declares (tests and test support only). Never edits production code.

**When to use:** a change's rigor requires tests written by a party other than the implementer; a defect needs a regression test; a boundary needs contract tests; a refactor needs characterization first; a test must be lowered, rewritten, or removed.

**Input:** `card: <name>` (one of the seven Test-author cards), that card inlined verbatim, `write-scope:` (`tests:` globs, `support:` files), the item, the test command. Cards live in `extensions/skills/workspace-standards/standards/testing/cards/test-author/`.

**Output:** `mode:`, the echoed `write-scope:`, `tests:`, `red:` evidence (command, non-zero exit, failing assertion or stub marker per test), `obsolete:`, `remaining:`. Or one `REFUSED:` line.

**Declares** `roles-covered:TA.1-TA.5`. Mechanical write-scope enforcement is T16.AC5 / T46; until then the prose rule and the golden set are the guard.

## Declared support files

Test support owned by this agent (fakes, fixtures, builders; no production behavior):

- `support/red-record.mjs` — pure judge of a `red:` record, per failing test block (exit non-zero; each block an assertion or the `STUB_MARKER_TOKEN` marker; any structural block or preamble rejected). `eval/lib.mjs` imports this judge; there is no second rule.
- `support/red-check.mjs` — the CLI the dispatcher runs before it accepts a `red:` record (`--exit <n> --output <file>`): exit 0 only when `judgeRedRecord` judges it red; exit 1 with the reason; exit 64 on usage. Tested by `red-check.test.mjs`.
- `support/fixtures/stub-marker.txt`, `support/fixtures/assertion.txt`, `support/fixtures/missing-export.txt`, `support/fixtures/mixed-red.txt`, `support/fixtures/assertion-names-missing-binding.txt` — real `node --test` output (node v24.11.1) the judge is tested against.


