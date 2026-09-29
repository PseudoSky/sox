# Changelog

## 1.4.5

- **Fixed a silent YAML parse failure that hid this skill from every agent.** The description
  contained `backlog: product prioritizes` — a colon+space inside an unquoted scalar, which
  YAML reads as a mapping separator. The frontmatter therefore failed to parse, opencode
  dropped the skill with no error, and the dispatcher reported it could not see
  `dispatch-plan` while the four sibling playbooks (no `: ` in their descriptions) loaded
  fine. Reworded to an em dash. Proven red→green with a YAML parser: the pre-fix bytes at
  HEAD fail with "mapping values are not allowed here"; the fixed bytes parse.
- `package.json` realigned from a stale 1.4.3.

## 1.4.4

- **Executor name corrected to the real registry (BUG-DISPATCH-PHANTOM-ROSTER).** `product-manager` → `product` (absent from the registry) in the description, body, and README.

## 1.4.3

- **Plans now live in the backlog, and the playbook was rewritten around that.** A plan is an
  `issue` row; its work items attach by a `part_of` edge and their order is expressed as `blocks`
  dependencies. The steps are now: read the structure · craft it when the user asks · land it ·
  execute from the **ready view**. The `docs/plan/<slug>/` / `state.json` framing is gone.
- **`plan-orchestrator` removed — no such agent exists.** The "Execute `docs/plan/<slug>/` with
  `plan-orchestrator`" option, the execute branch, the `state.json` check, and the halt line are all
  gone, along with the frontmatter and manifest references.
- **Division of labour stated:** `product-manager` prioritizes, `architect` **returns** the
  structured items (it does not touch the backlog), `backlog-operator` files and links them on the
  dispatcher's instruction, and the dispatcher never designs the structure and never edits the graph.

## 1.4.0

- Initial release. Ingested verbatim from `claude-agents` (`categories/dispatch/skills/dispatch-plan/SKILL.md`,
  v1.4.0, commit `6ffe0db1`) as part of the `dispatcher` v1.4.0 ingestion.
