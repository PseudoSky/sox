# audit-extraction — Phase audit: extraction

> **Slug is identity.** `audit-extraction` is immutable.

**Phase:** extraction · **Depends on:** `w2e-domain-rewire` · **Guard:** `audit_memrefactor.py --phase extraction`

---

## Goal

Extend the runner with `phase_extraction()` (calls baseline + layout first). This is the
phase that proves the decomposition is correct AND invisible to the outside: the six
`data/*` packages are populated + clean, the boundaries hold, the hard invariants are
enforced, `memory-enrich` is gone, and the **19-tool `memory_*` contract is unchanged**.

---

## Semantic Distillation

- **Primitive:** ADD `phase_extraction()` covering every `[w2a.*]`, `[w2b.*]`, `[w2c.*]`,
  `[w2d-ingest.*]`, `[w2d-analysis.*]`, `[w2d-hs.*]`, `[w2e.*]`.
- **Reference Pattern:** `baseline/tool-snapshot.json` (the diff target), the per-package
  `dist/index.js` (import-grep boundary checks), a [fix:memory-db] copy.
- **Delta Spec:** `phase_extraction()` checks (headline subset; one check per criterion ID):
  - **Contract:** [w2e.3] a live `tools/list` against the rebuilt server diffs clean vs
    the baseline snapshot (19 tools, identical names + inputSchemas). [inv:tool-contract-stable]
  - **Boundary:** [w2b.5] graph-store has no vec_node/vector-store import; [w2c.6]
    vector-store has no graph-store import; [w2e.7] no data/* imports the composer;
    [w2d-ingest.3] ingest imports neither vectors nor analysis. (dist-grep + `nx lint`.)
  - **Space invariant:** [w2c.2] a mismatched-dim/modelId `upsertVector` throws;
    `space_invariant_check.mjs` on a re-embedded [fix:memory-db] copy exits 0. [inv:space]
  - **Degrade:** [w2d-hs.4] hybrid-search returns BM25 results with vectors off. [def:degrade-to-bm25]
  - **Loud-fail:** [w2a.2]/[w2a.6] no silent hash downgrade. [inv:loud-fail]
  - **Re-embed single-source:** [w2e.4] the script delegates to `vector-store.reembed`.
  - **Dissolution:** [w2e.2] `@adhd/sox-memory-enrich` is gone.
  - **Regression:** [w2e.5] registry sync green; [w2e.6] `nx run-many -t test` + e2e green,
    zero orphans (reconciled vs BL-63). [inv:no-regress]
- **Invariants:** [inv:tool-contract-stable], [inv:space], [inv:boundary], [inv:loud-fail],
  [inv:degrade], [inv:no-regress], [inv:reality], [def:audit-runner].
- **Validation:** `--phase extraction` exits 0.

---

## Acceptance criteria

- [ ] **[audit-extraction.1]** `--phase extraction` runs all prior phases + extraction and
      exits 0.
- [ ] **[audit-extraction.2]** The tool-contract diff is performed against the real rebuilt
      server (not source) and is clean.

---

## Notes for executor

- The single most important check is the tool-contract diff — it is the proof that a large
  internal refactor changed nothing the outside can see. Build memory-core + memory-server
  first (BL-4) before listing tools.
- The vectors↛graph and graph↛vectors dist-grep checks catch the [def:connection-seam]
  being violated through the composer; run them on built `dist`, not source.
- Likely failure: a tool inputSchema drift, or a vectors→graph edge introduced when the
  composer's `openDb` was refactored. Fix in source.
- Budget: 1 session.
