<!-- markdownlint-disable MD013 -->
# Step 7 — Final review checklist (tokenguard-service)

Worked through before publishing. Every box is `[x]` or `N/A — <reason>`.

```text
[x] Definition of Done agreed in Step 1a — README has `## Definition of Done` with IDed [dod.1..11] (outcomes, old-gone, reviewer, non-goals, rollback)
[x] Every [dod.N] is proven by a final-audit check (one check("dod.N", ...) per clause in audit_tokenguard.py phase_final)
[x] Every BEHAVIORAL [dod.N] (1-6) declares entrypoint:/observable: and is proven by a check that DRIVES that entrypoint (sox-CLI harness / demo / nx test) with the observable asserted; structural clauses (7-11) stay grep/AST
[x] Artifact-to-artifact seams exercised through the real path — the config seam (extension.json config_schema ↔ SOX_CONFIG_* read) is checked together by ref-config-schema; the service lifecycle seam (manifest ↔ supervisor ↔ run-service) is exercised end-to-end by the dod.2/dod.5 harnesses, not in isolation
[x] Final audit emits a `[dod.N] PASS` line per clause (check() prints PASS/FAIL); the terminal DoD-confirmation gate is satisfiable — every clause has a real executed check
[x] Final audit written first — every DoD clause + every [ref:] + the decoupling negatives have named checks before the work states were finalized
[x] All magic named — the "service is an execution mode" special case is promoted to a first-class `service` type (service-type) and the hidden `profile: service` path is unified (http-transport/mcp-as-service); no unnamed special case remains
[x] Shorthand/mechanism separated — `mcp-server` (ergonomic shorthand) is preserved as `service[transport=stdio]` while the underlying routing mechanism is unified; the shorthand stays, the duplicate mechanism is folded
[x] External caller analysis done — gap-check.js --discover ran (oracle reported below in the publish run); the refactor is additive (mcp-server stays valid) and the one resigned internal symbol (_probeHealth, new branch only) has no external callers; memory-server is covered by the non-regress harness
[x] Every node changing a symbol declares it in dag.json `changes` — http-transport declares resigns:[_probeHealth]; the rest are additive (empty change sets, explicitly declared)
[x] Every deferral has a forcing function — no "during migration period" deferrals; sse/socket transports are an explicit [dod.10] non-goal (declared, not deferred), and every "live"/"reflected" claim has a named harness guard
[x] Identity is a stable slug — no positional numbers; ordering is depends_on only
[x] dag.json holds structure; state.json holds runtime only
[x] Slug set in dag.json.nodes == slug set in state.json.states; every context path exists
[x] Shared definitions centralized in contexts/_shared.md — [def:]/[inv:]/[ref:]/[shape:] referenced, not restated
[x] Acceptance criteria present per work state — ≥1 per added symbol/file, negative grep for removed coupling
[x] Criterion IDs are slug-keyed and match the check IDs in audit_tokenguard.py
[x] reservations.mutates populated for every work state
[x] dag.json artifacts array matches reservations.mutates exactly (same file set per state)
[x] Commit points section present in every work + audit state
[x] Shared-file merge protocols — N/A across tracks: the framework and core tracks touch DISJOINT files; within the framework track, edits to shared files (manifest/install.ts) are SEQUENTIAL (service-type → http-transport → mcp-as-service), not parallel, so no merge protocol is needed; cross-state one-line wire-ups (project.json test target; proxy mapstore subscription) are flagged as executor-class amendments in the affected contexts
[x] Guards are red→green — every guard fails today (impl/harness absent) and passes only after the state's work
[x] All criteria are deterministic commands — grep/AST/nx/harness, no prose
[x] Final audit has negative checks — dod.7/dod.8 + ref-host-keyed-target + ref-c7-no-reach-in are absence checks
[x] Final audit has a live data check — dod.5 drives the real proxy through a mock upstream and asserts the on-wire content + exact reversal (not a fixture)
[x] notes field answers the non-obvious — every node's `notes` names its footgun/ordering/risk
[x] dag.json dependency graph matches state-machine.md topology exactly
[x] Dispatch-or-orchestrate decision made — automatic dispatch = yes (deferred until the founder's go after the plan's architecture review); the Dispatch line is emitted at hand-off
```
