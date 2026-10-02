# Changelog

## 1.5.0

- **Merge-first delivery loop (supersedes the review-before-merge gate, `19434c31`).** Steps 10–11 inverted: the change merges on its **own gates** (`pnpm test` 0 failures, `tsc --noEmit` exit 0, bundle under budget), the item is `resolve`d on merge, and the review runs from `main` afterwards per ticket against the pinned sha. The flow diagram and the description follow suit. Hard rule `Never merge without a zero-item review.` → `Never merge without the change's own gates green; never merge a review gate into the delivery path.` Step 4 now requires each leaf's write-scope to be **declared in its brief up front** — two executors independently creating the same file is a real add/add collision (rails: findings filed AND scheduled; `main`'s gates are a hard rail; the tradeoff — `main` will carry defects a pre-merge gate would have caught — is recorded).

## 1.4.1

- **Phantom routing table replaced with the real roster (BUG-DISPATCH-PHANTOM-ROSTER).** §6's "Typical matches" named `typescript-pro`, `backend-developer`, `javascript-pro`, `python-pro`, `react-specialist`, `nextjs-developer`, `fullstack-developer`, `refactoring-specialist`, `performance-engineer`, `test-automator`, `qa-expert`, `deployment-engineer`, `devops-engineer`, `database-administrator`, `debugger`, `code-reviewer`, `architect-reviewer`, `product-manager` — 17 of 19 absent from the registry. An implementation leaf matched neither the `typescript-pro` nor the `backend-developer` row, so the generic catch-all `general` absorbed it. §6 now routes over the real roster and defers to the dispatcher's Step 2.3 work-class table; §5/§10 name `product`/`review`.

## 1.4.0

- Initial release. Ingested verbatim from `claude-agents` (`categories/dispatch/skills/dispatch-direct/SKILL.md`,
  v1.4.0, commit `6ffe0db1`) as part of the `dispatcher` v1.4.0 ingestion.
