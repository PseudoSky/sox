# audit-final — Convergence reality audit

> **Slug is identity.** `audit-final` is immutable.

**Phase:** convergence · **Depends on:** `audit-routing` · **Guard:** `audit_memrefactor.py --phase final`

---

## Goal

The cumulative reality audit ([inv:reality]): everything is re-verified against **real
built artifacts and the live MCP surface**, not test output. On green, the owner reviews;
only then is `audit-final` set `complete` and `feat/memory-refactor` merged.

---

## Semantic Distillation

- **Primitive:** ADD `phase_final()` — spawn the real built `memory-server` and exercise
  it; run the full whole-repo gate.
- **Reference Pattern:** the C6 final-audit pattern (spawn the real server, observe real
  behavior); [fix:cosine-sanity]; [fix:memory-db]; `baseline/tool-snapshot.json`.
- **Delta Spec:** `phase_final()` checks:
  - **Real server, real tools:** spawn the built `memory-server`; `tools/list` diffs clean
    vs baseline (19 tools). [inv:tool-contract-stable] [inv:reality]
  - **Real vectors end-to-end:** a real `memory_write` then a semantic `memory_recall`
    returns the relevant result ranked by real vectors; [fix:cosine-sanity] of two
    unrelated strings is `< 0.5`.
  - **Degrade:** force vectors off (hash backend) → `memory_recall` still returns BM25-
    ranked results (no error). [def:degrade-to-bm25]
  - **Re-embed:** `vector-store.reembed` dry-run on a [fix:memory-db] copy reports
    mismatches; a real run converts + is idempotent; `space_invariant_check.mjs` then
    exits 0. [inv:space]
  - **Whole-repo gate:** `nx run-many -t build,lint,test` + `host-runtime:test-e2e`
    (zero orphans, reconciled vs BL-63) + `registry:check-sync` + the boundary lint, all
    green. [inv:no-regress] [inv:boundary] [inv:registry-current]
  - **Dissolution + single-source:** memory-enrich gone; reembed single-sourced.
- **Invariants:** ALL — this phase re-runs every prior phase + the reality checks.
- **Validation:** `--phase final` exits 0, then owner review.

---

## Acceptance criteria

- [ ] **[audit-final.1]** `--phase final` runs all phases + the reality checks and exits 0.
- [ ] **[audit-final.2]** The real spawned server passes the tool-contract diff + the
      real-vector write→recall + the cosine-sanity probe.
- [ ] **[audit-final.3]** Degrade-to-BM25 proven against the live server with vectors off.
- [ ] **[audit-final.4]** Owner has reviewed the green audit ([inv:reality]) before
      `complete` + merge.

---

## Notes for executor

- This is a reality gate, not a test gate — a green vitest run is necessary but NOT
  sufficient; the real spawned server must pass (BL-4: build before you probe).
- Do NOT set `audit-final` complete or merge `feat/memory-refactor` without the owner's
  explicit sign-off on the green audit. The publish of any `data/*` package stays
  owner-gated regardless (F1).
- Budget: 1 session + owner review.
