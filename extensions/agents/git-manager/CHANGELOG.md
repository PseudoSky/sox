# Changelog

## 0.1.1

- **The equivalence test is now single-file and content-based.** 0.1.0 said `<project>/docs/GIT-POLICY.md`
  "unless the project already has an equivalent (a contributing doc, a release-flow doc, a
  `.github/` policy)" and told the agent to "adopt and correct **it**". A real run read the union
  of `CONTRIBUTING.md` + `AGENTS.md` as that equivalent, declared it "in sync", and **deferred**
  the missing required sections to a human — refusing to create a doc because of the "rather than
  creating a second one" clause. Reproduced on a two-partial-doc fixture: 0/6 required sections
  after the run, deferral emitted. The policy now exists **only** when one committed document
  already contains every required section; anything else (no candidate, a partial candidate, or
  coverage split across several documents) means the project has no policy and
  `docs/GIT-POLICY.md` is created as the single authoritative doc, citing existing docs instead
  of restating them.
- **"Incomplete" is now a sync trigger, and establishment is never a deferral.** The old sync
  rule fired only on *absent* or *drift* (a false rule, or an omitted repo convention). Missing
  required sections are neither — so the gap was invisible to it. The trigger now includes
  **incomplete**, and the contract states that "there is no policy doc here" and "the doc lacks
  section X" are outcomes the agent fixes inside the operation, not blockers it reports.
  `## Refused / Deferred` says so explicitly.
- Two failure modes named: **kind-equivalence** and **deferred establishment**.
- A/B (fresh subagent, two fixture shapes × contract v0.1.0 vs v0.1.1): two-partial-doc fixture
  went 0 → 6 required sections and a deferral → none. Runtime cost rose (tool_calls 2.43x, cost
  1.77x) because the variant performs the policy authoring the baseline omitted; attribution
  shows 96% of the wall-clock delta in model-wait, not tool execution. Surfaced, not hidden.

## 0.1.0

- Initial release: sole owner of a project's git operations and of a per-project git policy
  document; worktree lifecycle with the three-part safe-to-remove predicate; hard refusals for
  irreversible operations; separation of duties (merger ≠ implementer).
