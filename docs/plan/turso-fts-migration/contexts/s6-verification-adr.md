# s6 — Production-copy verification, docs, proposed ADR

## Goal

Prove the migration on a real store copy, document it, and land the decision record.

## Work

1. Copy a production `~/.memory/memory.db`; run the migration; assert: base counts equal,
   every FTS sentinel hit count equal, `integrity_check` no new damage, `page_count` /
   `file_bytes` strictly down, counter 0, live `fts_match`.
2. Confirm the leak is gone on the migrated copy via the (fixed) gate.
3. Update docs: `docs/spec/sox-executor.md` (§6.6 #2), `docs/ops/memory-server-playbook.md`,
   `libs/data/CLAUDE.md`.
4. Draft the proposed ADR (`docs/decisions/0026-…`) — **propose only; write on owner
   approval.** Reconcile the ADR number with `store-reclaim`'s proposed 0026 first.

## Constraints

Never claim resolved without a red→green test naming the id (`BL-225`). Registry
untouched (ADR-0021). Never edit a `BACKLOG.md`.
