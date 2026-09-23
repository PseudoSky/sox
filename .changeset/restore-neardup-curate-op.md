---
'@adhd/sox-memory-core': patch
---

Add `memory_curate { op: 'restore_neardup' }` — a reversible, auditable restore for
episodes invalidated by an automatic near-duplicate pass.

An automatic near-dup pass invalidated 852 episodes, 689 of which sit on a live
INFERRED `SAME_AS` edge. A separate read-only triage classified those 689
component-wise on **lexical** measures only (Jaccard / LCS / containment / length
ratio). Embedding cosine sat at 0.95–1.00 across every class and does not
discriminate, and an *age* rule is what selected the parent documents for
destruction in the first place — so neither signal appears anywhere in this code
path. The op consumes the triage report; it never re-derives the decision.

Restore scope is an explicit **policy choice**, not a measured recoverable count:
the floor plus the whole ambiguous band, on the asymmetry argument that a wrongly
restored duplicate stays re-mergeable through its retained `SAME_AS` edge while a
wrongly withheld false positive is lost permanently. TRUE-DUPLICATE components
stay collapsed. A `SAME_AS` edge is never deleted.

Safety properties:

- **`dry_run` defaults to TRUE for this op only.** It is destructive by omission,
  so a caller must pass `dry_run: false` to mutate. The default is decided in
  `curate.ts`; the MCP input schema deliberately carries **no** JSON-Schema
  `default` on `dry_run`, because a client that materialises schema defaults
  would send `false` and mutate. Every other op still treats an absent value as
  `false`, unchanged.
- **Apply verifies authorship, not state.** `rowsAffected !== 1` pushes to
  `notWritten`, and the verification query requires
  `json_extract(meta,'$.restoredFrom.at')` to equal *this* run's timestamp — a
  row made live by someone else between plan and apply is not counted, since
  counting it would make it silently un-reversible.
- `meta` is re-read **inside** the transaction rather than merged from a
  plan-time snapshot, so a concurrent `meta` write is not clobbered.
- `report_path` is a guarded read: absolute, `.json`, realpath-checked on both
  sides, ≤32 MB, confined to `~/.memory/**` unless `SOX_RESTORE_REPORT_ROOTS`
  grants more. The parser never echoes file contents into an error.
- `reverse: true` undoes a run, re-invalidating to the exact recorded
  `prior_t_invalid` **and** GCing orphaned community state in the same
  transaction (the raw SQL alternative leaks zero-member communities).
- Integrity is gated on the shared `classifyIntegrityMessages` classifier, so the
  known turso FTS false positive does not force an operator to pass
  `allow_integrity_failure` as routine.
- Guard order is load-bearing: `not_found` → `already_live` →
  `no_live_inferred_same_as` → `skipped_membership_divergence` →
  `withheld_true_duplicate`.

34 acceptance tests. Dry run against a copy of the live store plans 604 of 607
policy-scope members (435 floor + 169 policy-ambiguous), withholds 3 carrying a
live `SUPERSEDES` edge, leaves 82 TRUE-DUPLICATE members collapsed, and reports
163 edge-less invalidated episodes as out of scope.
