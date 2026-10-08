# Playbook card: author-contract

Clauses: P7, §6.2, §6.6, §12, §14, G9. Obligations: TA.1, TA.3.

Serves the boundary or contract class (Deep rigor, separated authorship required). One boundary per unit.

## Input
The shared executable description of the messages crossing the boundary (schema, example set, or specification), both owners' interfaces, the risk map.

## Steps
1. Confirm the contract artifact exists and is executable. If it does not, report that to the planner; do not invent it from one side's implementation (P7).
2. Consumer side: run the consumer against the contract with a double at the boundary, normally tier S (§6.2 modifier).
3. Provider side: run the real provider against the same contract at the tier that implementation needs (§6.2).
4. Cover shape, status, error bodies, and authentication on both sides (§12). Include malformed and missing input.
5. Tag `contract`. If one specification must hold across several implementations, tag `conformance` and run the same suite against each; the tier is the highest any implementation needs (§6.2).
6. Header with failure mode, tier, and a gap statement for any P, H, X side (G9).
7. Record red evidence for both sides against a broken contract variant (§6.5).

## Output
Consumer-side and provider-side tests, both red runs, the contract artifact reference.

## Never
Stand up the neighbor to test the boundary (P7), or change either side's production code (§14).
