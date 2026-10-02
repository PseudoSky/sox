# Changelog

## 1.6.0

- **A report/deferral claim is the `needs-triage` path.** Step 1 states it explicitly: a reported issue is routed through `definition-of-ready`'s `needs-triage` path before any dispatch, never assumed to be already understood.

## 1.5.0

- **Merge-first fix loop.** The flow block's two `dispatch-direct → review → merge` chains become `→ gates → merge → resolve → post-merge review`; the description and Step 7 now say the fix merges on its own gates and is `resolve`d on merge, with the review running from `main` afterwards and a HIGH bucketed as follow-up impl rather than stalling delivery.

## 1.4.1

- **Executor names corrected to the real registry (BUG-DISPATCH-PHANTOM-ROSTER).** `debugger` → `debug` and `architect-reviewer` → `architect` throughout the body, description, and README. Both were absent from the registry, so the playbook routed triage to agents that could not be resolved.

## 1.4.0

- Initial release. Ingested verbatim from `claude-agents` (`categories/dispatch/skills/dispatch-triage/SKILL.md`,
  v1.4.0, commit `6ffe0db1`) as part of the `dispatcher` v1.4.0 ingestion.
