# test-author

Separated test authorship (595965cc T22). Plans a bucket's tests and authors failing tests from the specification, in a write scope the brief declares (tests and test support only). Never edits production code.

**When to use:** a change's rigor requires tests written by a party other than the implementer; a defect needs a regression test; a boundary needs contract tests; a refactor needs characterization first; a test must be lowered, rewritten, or removed.

**Input:** `card: <name>` (one of the seven Test-author cards), that card inlined verbatim, `write-scope:` (`tests:` globs, `support:` files), the item, the test command. Cards live in `extensions/skills/workspace-standards/standards/testing/cards/test-author/`.

**Output:** `mode:`, the echoed `write-scope:`, `tests:`, `red:` evidence (command, non-zero exit, failing assertion or stub marker per test), `obsolete:`, `remaining:`. Or one `REFUSED:` line.

**Declares** `roles-covered:TA.1-TA.5`. Mechanical write-scope enforcement is T16.AC5 / T46; until then the prose rule and the golden set are the guard.

## Declared support files

Test support owned by this agent (fakes, fixtures, builders; no production behavior):

- `support/red-record.mjs` — pure judge of a `red:` record (exit non-zero; assertion or stub marker; structural failures rejected).
- `support/fixtures/stub-marker.txt`, `support/fixtures/assertion.txt`, `support/fixtures/missing-export.txt` — real `node --test` output (node v24.11.1) the judge is tested against.

The `eval/` directory (golden-set harness, fixture, seeded faults, recorded results) is the A/B evidence, not unit-test support.

## DEFERRED-LIVE

Two checks need a live model and are registered as skipped in `test-author.test.mjs`. They run at the later testing run. Until then the recorded A/B in `eval/results.json` is stale and unconfirmed.

- T22.AC1 — live-model; confirm at the later testing run: test-author refuses a seeded brief to edit a production path
- T22.AC5 — live-model A/B; re-measure at the later testing run (recorded A/B missed AC1)

Later run only (not part of unit tests): `node eval/run.mjs 3` spawns `claude -p` and rewrites `eval/results.json`.

Unit tests: `node --test extensions/agents/test-author/test-author.test.mjs`.
