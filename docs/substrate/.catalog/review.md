# Substrate Surface Review — Verdict (Re-audit)

**VERDICT: PASS**

README now comprehensively covers all 11 shipped substrate packages (8 core + 2 extended + 1 utility) with non-empty sections, per-package error taxonomies, and sufficient detail for fresh agents to succeed on canonical tasks.

---

## Lens 1: Closed-Loop Metric ✓ PASS

**Claim:** "Complete reference for the **10 substrate packages**"  
**Finding:** README now documents all **11 shipped packages**:

| Segment | Count | Packages |
|---------|-------|----------|
| Core | 8 | source-provider, task-queue, vector-store, ingest, embedding-provider, hybrid-search, blob-store, claim-verification |
| Extended | 2 | graph-store, analysis |
| Utilities | 1 | manifest |
| **Total** | **11** | ✓ All documented with non-empty sections |

**Sub-checks:**
- ✓ Zero stubs/TBD placeholders
- ✓ All packages carry purpose, public API, quickstart, and invariants/errors
- ✓ No roadmap items masquerading as shipped
- ✓ @adhd/sox-analysis: complete (clustering, graph algorithms, batch enrichment, all APIs present)
- ✓ @adhd/sox-manifest: complete (validation, error types, key invariant about id/package.json match)
- ⚠ **Minor note:** Headline still says "10 substrate packages" (should be "11" or clarify "8 core + 2 extended + 1 utility")

**Improvement vs. prior audit:** sox-analysis and sox-manifest sections went from missing/stub to fully documented. Closed-loop metric improved: 8/11 → 11/11 packages documented.

---

## Lens 2: Template/Rubric Conformance ✓ PASS

**Required template per brief:**
- Intro → quick ref → package details → integration → cross-workspace → testing/errors → license

**Findings:**

| Component | Status | Evidence |
|-----------|--------|----------|
| Intro | ✓ PASS | Lines 1–3, clear purpose |
| Quick ref table | ✓ PASS | Lines 13–37, all 11 packages listed + entrypoints |
| Package details (11/11) | ✓ PASS | Each package has dedicated section with purpose, API types/functions, quickstart, key invariants |
| Integration example | ✓ PASS | Lines 1134–1254, wires 8+ packages into semantic search + claim verification pipeline |
| Cross-workspace | ✓ PASS | Lines 1258–1318, file-link + pnpm.overrides pattern documented |
| Testing/examples | ✓ PASS | Lines 1321–1335, test commands + example paths provided |
| Error handling by package | ✓ PASS | Lines 1338–1451, comprehensive per-package error taxonomy (11 subsections) with retriable/non-retriable decision matrix |
| License | ✓ PASS | Line 1472, MIT licensed |
| TypeScript support | ✓ PASS | Lines 1454–1468, ESM-only + CJS-safe subpath documented |

**Per-package rubric conformance (sample checks):**

1. **@adhd/sox-analysis** (Lines 744–944)
   - Purpose: ✓ "Batch corpus derivation: density-based clustering, near-duplicate detection, importance scoring, auto-linking, and pure graph algorithms"
   - Public API: ✓ ClusterOpts, ClusterResult, NearDupOpts, NearDupPair, TopoSortResult, PackItem, PackResult + functions (clusterVectors, detectNearDups, computeImportance, buildAutoLinks, runBatchEnrich, topoSort, criticalPath, detectCycles, packBatches)
   - Quickstart: ✓ Real code example (lines 863–929) shows clustering, near-dup detection, importance scoring, topo sort, critical path, cycles, batch packing
   - Key invariants: ✓ Listed (lines 931–938): corpus-level only, deterministic under model, incremental by default, DB-integrated, pure graph algorithms, submodular packing
   - Error types: ✓ Listed (lines 939–942): ClusteringError, GraphTopologyError, PackingError

2. **@adhd/sox-manifest** (Lines 1064–1131)
   - Purpose: ✓ "Extension manifest schema + validation"
   - Public API: ✓ ExtensionManifest interface + validate(), validatePartial() functions
   - Quickstart: ✓ Real code example (lines 1095–1127) shows load, validate, error handling
   - Key invariant: ✓ "id field must match the package.json name field"
   - Error types: ✓ Listed (line 1091): ValidationError (schema mismatch), SchemaVersionMismatch

3. **@adhd/sox-embedding-provider** (Lines 405–465)
   - Error types in error handling section (lines 1382–1390): ✓ ResolutionError, TransientEmbeddingError, PermanentEmbeddingError + retry guidance
   - Factory-time exception behavior: ✓ Documented ("throws at factory time; never mid-call")

4. **@adhd/sox-claim-verification** (Lines 637–741)
   - Error handling section (lines 1412–1422): ✓ ModelNotLoadedError, VerifierBusyError, UnsupportedLanguageError, PreFilterSkippedError, InvalidClaimInputError
   - Language mismatch strategy: ✓ Documented ("downgrades result to 'neutral' with languageMismatch=true flag")
   - ONNX worker isolation: ✓ Documented (line 740, "ONNX inference runs exclusively in worker threads")

5. **@adhd/sox-vector-store** (Lines 225–305)
   - Error handling section (lines 1364–1371): ✓ SpaceInvariantError (vector dim ≠ space.dim), BlobStoreSystemError, retry strategy
   - Key invariant: ✓ "upsert() throws SpaceInvariantError if vec.length !== space.dim. A model switch is always an explicit reembed() migration, never a hot-swap."

**Error handling taxonomy:** Lines 1338–1451 break down by package (11 subsections):
- @adhd/sox-source-provider (lines 1342–1351)
- @adhd/sox-task-queue (lines 1353–1362)
- @adhd/sox-vector-store (lines 1364–1371)
- @adhd/sox-ingest (lines 1373–1380)
- @adhd/sox-embedding-provider (lines 1382–1390)
- @adhd/sox-hybrid-search (lines 1392–1398)
- @adhd/sox-blob-store (lines 1400–1410)
- @adhd/sox-claim-verification (lines 1412–1422)
- @adhd/sox-graph-store (lines 1424–1433)
- @adhd/sox-analysis (lines 1435–1442)
- @adhd/sox-manifest (lines 1445–1450)

Each subsection includes error type + cause + retriable flag + action.

---

## Lens 3: Fresh-Agent Consumer Test ✓ PASS

**Task 1: "Implement cluster-based near-duplicate detection (sox-analysis)"**
- Agent searches README for "cluster", "detectNearDup", "near-duplicate"
- Finds ✓ §@adhd/sox-analysis (lines 744–944)
- Finds ✓ `detectNearDups()` function signature (lines 819–822)
- Finds ✓ Real quickstart code (lines 884–894) showing:
  - `detectNearDups(vectorBackend, { nearDupThreshold: 0.95, distinctThreshold: 0.8 })`
  - Result iteration over `NearDupPair` objects with `.status` enum
- Finds ✓ Error types (NearDupOpts interface, lines 767–772)
- Finds ✓ How to integrate with VectorBackend (line 873: `await clusterVectors(vectorBackend, ...)`)
- **Outcome:** PASS — docs sufficient; can implement without source code

**Task 2: "Validate an extension manifest (manifest with error handling)"**
- Agent searches README for "manifest", "validate"
- Finds ✓ §@adhd/sox-manifest (lines 1064–1131)
- Finds ✓ `validate()` function + `ValidationError` exception (lines 1087–1088)
- Finds ✓ Real quickstart code (lines 1095–1127) showing:
  - Load JSON from file
  - `validate(rawManifest)` call with try-catch
  - Error type check: `error instanceof ValidationError`
  - Access to error properties: `error.message`, `error.path`
  - Partial validation with `validatePartial()`
- Finds ✓ Error types (lines 1091): ValidationError, SchemaVersionMismatch
- Finds ✓ Key invariant (line 1129): id/package.json match
- **Outcome:** PASS — docs sufficient; complete error-handling pattern shown

**Task 3: "Embed, search, and rank with hybrid backend"**
- Agent searches README for "hybrid", "embed", "search"
- Finds ✓ §@adhd/sox-embedding-provider (lines 405–465)
  - `createEmbeddingProvider()`, `embedSingle()`, `embedBatch()` documented
  - Quickstart (lines 441–461) shows full flow: create embedder, embed single, batch embed with async iterable
- Finds ✓ §@adhd/sox-vector-store (lines 225–305)
  - `openSqliteVecStore()`, `ensureSpace()`, `upsert()`, `knn()` documented
  - Quickstart (lines 269–302) shows vector storage and retrieval
- Finds ✓ §@adhd/sox-hybrid-search (lines 467–545)
  - `SqliteSearchBackend`, `search()` method documented
  - Quickstart (lines 514–540) shows:
    - Creating backend with vectorBackend + graphBackend
    - Calling `search()` with text + vec + filters
    - Accessing result.textScore, result.vecScore, result.score
    - Degradation behavior ("No vec? Falls back to text-only")
- Finds ✓ Integration example (lines 1134–1254) wires all three packages + vector store + blob store + graph store into a complete semantic search + claim verification pipeline
- **Outcome:** PASS — docs sufficient; integration example provides runnable pseudocode for orchestrating all three

**All three canonical tasks succeed using README only; no source code required.**

---

## Improvements from Prior Audit

| Finding | Before | After | Delta |
|---------|--------|-------|-------|
| Packages documented | 8/11 (73%) | 11/11 (100%) | +3 packages (analysis, manifest, error details) |
| sox-analysis section | Missing entirely | Complete (200 lines) | Covers DBSCAN, graph algorithms, batch packing, 6 public functions, full quickstart |
| sox-manifest section | Table entry only | Complete (68 lines) | Covers validation, error handling, quickstart, key invariant |
| Error handling | Generic list, no per-package detail | Per-package taxonomy (114 lines) | 11 subsections, each with retriable flag + action guidance |
| Fresh-agent test (predicted) | FAIL on 2/3 tasks | PASS on 3/3 tasks | All canonical tasks executable from docs |

---

## Minor Gaps (Non-Blocking)

1. **Headline count:** Line 3 says "10 substrate packages" but documents 11 (8 core + 2 extended + 1 utility)
   - **Fix:** Change to "11 substrate packages" or expand to "8 core + 2 extended + 1 utility = 11 packages"
   - **Impact:** Cosmetic; tables are accurate and clear
   - **Recommendation:** Tier 3 (backlog), not blocking

2. **Integration example wiring:** Excellent coverage (8+ packages), but doesn't show every package
   - Missing: direct use of sox-analysis functions in the pipeline
   - **Workaround:** Reader can combine lines 884–929 (near-dup quickstart) with lines 1134–1254 (integration)
   - **Impact:** Negligible; analysis is corpus-level, not hot-path
   - **Recommendation:** Tier 3 (defer to advanced guide)

3. **LanceDB backend details:** Vector store mentions LanceDB (HNSW/IVF-PQ) but focuses on sqlite-vec
   - **Coverage:** Adequate (config interface provided, lines 247–257)
   - **Recommendation:** Tier 3 (link to sox-ecosystem docs for advanced tuning)

---

## Verdict Summary

**Closed-loop metric:** 11/11 packages documented (100%) → PASS  
**Template conformance:** All 11 packages follow rubric (purpose, API, quickstart, invariants, errors) → PASS  
**Fresh-agent test:** All 3 canonical tasks executable from README alone → PASS  

**Status:** PASS with strong conformance. Package count label should be corrected (10 → 11), but this is a label issue, not a content gap.

---

**Re-audit completed:** 2026-07-09  
**Previous verdict:** FAIL (8/11 packages, missing analysis + manifest, generic error handling)  
**Current verdict:** PASS (11/11 packages, per-package errors, all canonical tasks succeed)
