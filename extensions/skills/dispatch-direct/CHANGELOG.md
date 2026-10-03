## 1.6.3

- Dedupe the blind-review sizing rule to its two homes (87ba1b48): dispatcher rule 5 and dispatch-direct Step 11 now point at `dispatch-contract` §1a and AGENTS.md’s `## Blind Review` instead of restating the threshold.

## 1.6.2

- Finish the leaf→bucket terminology migration (764e8f71): the dispatch work unit is a **Bucket**; no `leaf` remains in the body.

# Changelog

## 1.6.1

- **Post-ship refinements.** Step 3 sizes a Bucket by **cohesion and separability, not maximal size**. Step 11 chooses review type by **changed lines of code** (~200–400); `>=8` changed files is a coarse secondary proxy.

## 1.6.0

- **Step 3 bucketing.** The five-item-per-leaf cap is replaced by **Buckets** — one shared done-state, a cohesive write-scope, all changes touching a file grouped; split only when separably dispatchable. Bucketing scans the backlog to fold in similar items, then applies the `definition-of-ready` gate (`needs-triage` / `needs-research` / `needs-spec` / `ready`) and assesses priority via `dispatch-priority`.
- **Step 11 review sizing.** Review type is by changed-file count (`>=8` blind / `<8` guided), with exactly one full-delta blind review at plan completion; the HIGH/critical filter is narrow.

## 1.5.0

- **Merge-first delivery loop (supersedes the review-before-merge gate, `19434c31`).** Steps 10–11 inverted: the change merges on its **own gates** (`pnpm test` 0 failures, `tsc --noEmit` exit 0, bundle under budget), the item is `resolve`d on merge, and the review runs from `main` afterwards per ticket against the pinned sha. The flow diagram and the description follow suit. Hard rule `Never merge without a zero-item review.` → `Never merge without the change's own gates green; never merge a review gate into the delivery path.` Step 4 now requires each leaf's write-scope to be **declared in its brief up front** — two executors independently creating the same file is a real add/add collision (rails: findings filed AND scheduled; `main`'s gates are a hard rail; the tradeoff — `main` will carry defects a pre-merge gate would have caught — is recorded).

## 1.4.1

- **Phantom routing table replaced with the real roster (BUG-DISPATCH-PHANTOM-ROSTER).** §6's "Typical matches" named `typescript-pro`, `backend-developer`, `javascript-pro`, `python-pro`, `react-specialist`, `nextjs-developer`, `fullstack-developer`, `refactoring-specialist`, `performance-engineer`, `test-automator`, `qa-expert`, `deployment-engineer`, `devops-engineer`, `database-administrator`, `debugger`, `code-reviewer`, `architect-reviewer`, `product-manager` — 17 of 19 absent from the registry. An implementation leaf matched neither the `typescript-pro` nor the `backend-developer` row, so the generic catch-all `general` absorbed it. §6 now routes over the real roster and defers to the dispatcher's Step 2.3 work-class table; §5/§10 name `product`/`review`.

## 1.4.0

- Initial release. Ingested verbatim from `claude-agents` (`categories/dispatch/skills/dispatch-direct/SKILL.md`,
  v1.4.0, commit `6ffe0db1`) as part of the `dispatcher` v1.4.0 ingestion.
