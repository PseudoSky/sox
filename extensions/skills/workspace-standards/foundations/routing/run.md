# Playbook: run routing

Resolves a role to the closest available agent for a work item and returns the choice with its evidence.

## Input
The role name (from a registered standard's `roles.md`), the work item, the roles already held in the change, the installed agents.

## Steps
1. Candidates: the installed agents (the host's agent list).
2. Eligibility: drop an agent that cannot use every tool in the role's `tools`, or that breaks a `distinct-from` rule for this change. A party is one working session: a session never approves what it authored, and a fresh dispatch of the same agent is a different party and may audit.
3. Closeness: for each eligible agent count the role's obligation ids present in the agent's `roles-covered` declaration (`capabilities` entries `roles-covered:<ID>` in its `extension.json`; free-text descriptions are never scored). Rank by that count, then by the fewest other roles the agent already holds in this change.
4. Ties: the role's `hints` order the remaining ties and nothing else.
5. Result: the closest eligible agent holds the role. If none is eligible the role is unbound: work proceeds, the clauses the role would have applied become review debt on the affected tests, and at Deep rigor an unbound test author, static reviewer, or auditor blocks the change (the role's `no-holder` field).
6. Return `{ role, holder | unbound, covered[], toolsMatched[], rank, heldRoles }`.

## Output
The holder (or `unbound`) with the closeness evidence, for the dispatch telemetry row.

## Record
The returned object, appended to the dispatch telemetry row for the change.

Status: built (595965cc T47, T49). The dispatcher's Step 2 resolves roles with `resolveRole` in `scripts/lib.mjs`; `node <skill>/scripts/foundations.mjs review routing` reports drift and unbound roles; the roster guard is `tools/test-roster-guard.mjs` in the adopting repository.
