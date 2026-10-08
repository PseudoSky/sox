# Card: implementer at Light rigor

Clauses: §6.1, §6.6, §6.7, §14, G9, G12. Obligations: IM.1, IM.2, IM.3.

Applies when derived rigor is Light and the implementer may author the tests (§6.6). At Standard or Deep authorship is separated (§14) and this card does not apply.

## Steps
1. Write one line per acceptance criterion: the behavior it needs and the failure mode that breaks it (the Light risk map, §6.6).
2. Default tier is S. A higher tier needs a valid fidelity-gap statement: "This cannot be observed at tier T-1 because ___" naming a property that disappears below it (§6.2, G9).
3. One test per failure mode. Prefer the real implementation in-process, then a fake, then a stub, then a mock (§4). Doubles replace only boundaries the system does not own.
4. Give every new test a header: failure mode guarded, tier, gap statement for P, H, X, the item and criterion it cites (§6.1.8, G12).
5. Prove teeth: show each new behavioral test failing on an assertion when the behavior is broken, with the command and exit status (§6.5).
6. List the tests the change makes obsolete or lowers, or state none (§8.6).

## Hard limits
- A refactor adds no behavior tests; the existing tests pass unchanged (§6.7).
- Never edit, skip, delete, or loosen a test you did not author. Report the dispute with evidence to the auditor (§14).
- Never leave a placeholder (todo, empty stub, skipped block) behind (§14, P10).
- Counts and pass claims come from a run you produced, with command and exit status (§14).

## Output
Tests with headers, red evidence, the obsolete-tests line, and the rigor record unchanged.
