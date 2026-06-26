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
  - **Standalone-consumption ([def:standalone-proof], the BL-87/F1 guard):** run
    `scripts/pack-smoke.mjs` — for each PUBLIC `data/*` package, `npm pack` →
    `npm install` the tarball into a clean tmp dir **outside the workspace** (so module
    resolution cannot fall back into `libs/`) → import-and-exercise. This is the only
    *affirmative* proof of the refactor's thesis (data/* reusable via plain `npm i`); the
    boundary lint + dist-greps are necessary but not sufficient. It directly guards the
    BL-87 failure class (boundary-clean but broken on install via an undeclared runtime
    dep — exactly how the live `memory-server` shipped without `fastembed`).
- **Invariants:** ALL — this phase re-runs every prior phase + the reality checks.
- **Validation:** `--phase final` exits 0 (incl. `pack-smoke`), then owner review.

---

## Acceptance criteria

- [ ] **[audit-final.1]** `--phase final` runs all phases + the reality checks and exits 0.
- [ ] **[audit-final.2]** The real spawned server passes the tool-contract diff + the
      real-vector write→recall + the cosine-sanity probe.
- [ ] **[audit-final.3]** Degrade-to-BM25 proven against the live server with vectors off.
- [ ] **[audit-final.4]** Owner has reviewed the green audit ([inv:reality]) before
      `complete` + merge.
- [ ] **[audit-final.5]** Standalone-consumption: `scripts/pack-smoke.mjs` exits 0.
      **Native carriers** prove their declared native deps resolve FROM THE TARBALL
      INSTALL (the BL-87 guard) and run a real round-trip:
      - `embedding-provider` — `fastembed`/`onnxruntime-node` resolve; resolve the real
        provider, `embed`, assert `dim` + [fix:cosine-sanity] of two unrelated strings
        `< 0.5`; resolve the deterministic provider too.
      - `vector-store` — `better-sqlite3`/`sqlite-vec` resolve; `openVectorStore`
        in-memory → `applyVecSchema` → `upsertVector` → `knn` round-trip returns the
        seeded nearest neighbor.
      **Pure-JS three** (`hybrid-search`, `analysis`, `ingest`) — import + one real call
      each (e.g. hybrid-search ranks a 2-doc fixture; ingest `contentHash`; analysis
      `computeImportance`). Each install is in a clean tmp dir outside the workspace; only
      `@adhd/sox-*` deps allowed are other public `data/*` packages.

---

## Notes for executor

- This is a reality gate, not a test gate — a green vitest run is necessary but NOT
  sufficient; the real spawned server must pass (BL-4: build before you probe).
- Do NOT set `audit-final` complete or merge `feat/memory-refactor` without the owner's
  explicit sign-off on the green audit. The publish of any `data/*` package stays
  owner-gated regardless (F1).
- `pack-smoke` is the affirmative half of the audit — the rest is invariant/negative
  checks. A package can pass every boundary check and still fail `pack-smoke` (the BL-87
  shape: a runtime dep that only resolved in-workspace). When it fails, the fix is the
  package's `package.json` `dependencies` / esbuild externalize config, never the smoke.
- Install the tarball with `npm install <tgz> --prefix <tmp>` (or `--install-links`) in a
  dir with NO parent `node_modules` reaching back to the repo — otherwise a missing dep
  resolves against the workspace and the BL-87 guard silently passes a broken package.
- Budget: 1 session + owner review (+ the pack-smoke run).
