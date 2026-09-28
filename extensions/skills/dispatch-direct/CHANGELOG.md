# Changelog

## 1.4.1

- **Phantom routing table replaced with the real roster (BUG-DISPATCH-PHANTOM-ROSTER).** §6's "Typical matches" named `typescript-pro`, `backend-developer`, `javascript-pro`, `python-pro`, `react-specialist`, `nextjs-developer`, `fullstack-developer`, `refactoring-specialist`, `performance-engineer`, `test-automator`, `qa-expert`, `deployment-engineer`, `devops-engineer`, `database-administrator`, `debugger`, `code-reviewer`, `architect-reviewer`, `product-manager` — 17 of 19 absent from the registry. An implementation leaf matched neither the `typescript-pro` nor the `backend-developer` row, so the generic catch-all `general` absorbed it. §6 now routes over the real roster and defers to the dispatcher's Step 2.3 work-class table; §5/§10 name `product`/`review`.

## 1.4.0

- Initial release. Ingested verbatim from `claude-agents` (`categories/dispatch/skills/dispatch-direct/SKILL.md`,
  v1.4.0, commit `6ffe0db1`) as part of the `dispatcher` v1.4.0 ingestion.
