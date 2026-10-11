# Playbook: review gates

Checks every registered gate for completeness, liveness, reachability, and teeth. The generic engine runs these for every standard; a standard adds only its own domain checks.

## Steps
1. Completeness: every clause id in each registered standard's policy has exactly one binding row.
2. Liveness: every path and command a binding references exists.
3. Reachability: the stage a gate is bound to actually invokes it; an unbound gate is a finding.
4. Teeth: each mechanical gate has a seeded-violation fixture it must fail on; a gate without one is a finding.
5. Skipped standards: list each standard declaring `own: ["gates"]`; its own playbook reviews its gates.
6. Drift: the `workspace-standards:gates` block in `AGENTS.md` equals what `apply gates` would write. Command: `node <skill>/scripts/foundations.mjs review gates [--root <repo>]`; exit 3 names the drifted block.
7. Report the conformance level from the passing rows; an obligation without a mechanism counts toward no level.

## Output
Findings `{ id, severity, evidence }` and the level.

## Record
The findings with command lines and exit statuses, written to the review output location the repository names.

Status: built (595965cc T49, T62). Steps 1 to 4 run as `node <skill>/engine/cli.mjs check <completeness|liveness|reachability|teeth|all> [--root <repo>] [--table <file>]`; step 6 runs as `node <skill>/scripts/foundations.mjs review gates`.
