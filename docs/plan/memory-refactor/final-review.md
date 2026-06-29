# Final review — memory-refactor

**Gate:** must be ticked by owner before `audit-final` → complete + merge.

## Reality gates
- [ ] `npx --yes nx run-many -t build,lint,test` green
- [ ] `npx --yes nx run host-runtime:test-e2e` green, zero orphans (BL-63 false-positive reconciled)
- [ ] `npx --yes nx run registry:check-sync` green

## Acceptance gates
- [ ] [dod.1] 6 data/* packages build+lint+test independently
- [ ] [dod.2] boundary lint: data↛platform synthetic violation fails
- [ ] [dod.3] 19 memory_* tools diff-clean vs p0-baseline snapshot
- [ ] [dod.4] real write→recall, cosine sanity ~0 (not ~0.99)
- [ ] [dod.5] hybrid-search degrades to BM25 without vectors
- [ ] [dod.6] pack-smoke.mjs passes (standalone install proof, native carriers resolve)
- [ ] [dod.7] routing index generated + drift gate exercised
- [ ] [dod.8] feat/memory-refactor merges with zero new red gates

## Owner sign-off
- [ ] Owner reviewed `audit-final` output
- [ ] `feat/memory-refactor` PR reviewed, approved
- [ ] Publishing posture confirmed (F1: 5 public @ 0.x, owner-gated publish action)
- [ ] No open backlog items added by this plan left un-tracked
