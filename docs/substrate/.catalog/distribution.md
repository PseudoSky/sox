# Substrate Distribution & Publishing

**Scope:** sox-ecosystem @adhd/sox-* substrate packages  
**Registry:** npm public (@adhd namespace)  
**Status:** All v0.1.0+ shipped to npm  

---

## Publishing Status

| Package | Version | Published | License | Access |
|---------|---------|-----------|---------|--------|
| @adhd/sox-source-provider | 0.1.0 | ✓ | MIT | public |
| @adhd/sox-task-queue | 0.1.0 | ✓ | MIT | public |
| @adhd/sox-vector-store | 0.1.0 | ✓ | MIT | public |
| @adhd/sox-ingest | 0.1.0 | ✓ | MIT | public |
| @adhd/sox-hybrid-search | 0.1.0 | ✓ | MIT | public |
| @adhd/sox-embedding-provider | 0.1.0 | ✓ | MIT | public |
| @adhd/sox-blob-store | 0.1.0 | ✓ | MIT | public |
| @adhd/sox-claim-verification | 0.1.0 | ✓ | MIT | public |
| @adhd/sox-graph-store | 0.1.0 | ✓ | MIT | public |
| @adhd/sox-manifest | 0.2.0 | ✓ | MIT | public |

**Note:** No packages are private (`private: false` in all package.json files).

---

## Runtime Targets

All packages require **Node.js ≥20** (manifest, ingest) or **≥22** (remainder).

### Engine Requirements by Package

```
Min Node 18:  (none)
Min Node 20:  @adhd/sox-manifest, @adhd/sox-ingest
Min Node 22:  @adhd/sox-task-queue
              @adhd/sox-vector-store
              @adhd/sox-embedding-provider
              @adhd/sox-blob-store
              @adhd/sox-claim-verification
              @adhd/sox-graph-store
              @adhd/sox-analysis
```

### Module Format

- **All ESM** (`"type": "module"`)
- CJS interop: @adhd/sox-ingest exports `@adhd/sox-ingest/core` as CJS-safe subpath
- No dual publish (CJS + ESM)

---

## Build Artifacts

All packages export standard entrypoint structure:

```
dist/
├── index.js           (ESM, fully typed)
├── index.d.ts         (TypeScript definitions)
└── [subpaths]         (@adhd/sox-ingest/core only)
```

### Subpath Exports

**@adhd/sox-ingest** exposes two entrypoints:
```json
"exports": {
  ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
  "./core": { "types": "./dist/core.d.ts", "default": "./dist/core.js" }
}
```

- `index.js` — full API including AstChunker (ESM-only, contains top-level await)
- `core.js` — zero-LLM ingest + summary + tags (CJS-safe, no TLA)

Consumer guidance:
- ESM consumers: import from `@adhd/sox-ingest`
- CJS consumers (e.g., @adhd/sox-memory-core): import from `@adhd/sox-ingest/core`

---

## Dependency Graph

### First-Order Workspace Dependencies

```
@adhd/sox-source-provider
  └─ (no workspace deps)

@adhd/sox-task-queue
  └─ (no workspace deps)

@adhd/sox-vector-store
  └─ (no workspace deps)

@adhd/sox-ingest
  └─ (no workspace deps)

@adhd/sox-hybrid-search
  ├─ @adhd/sox-embedding-provider
  ├─ @adhd/sox-graph-store
  └─ @adhd/sox-vector-store

@adhd/sox-embedding-provider
  └─ (no workspace deps)

@adhd/sox-blob-store
  └─ (no workspace deps)

@adhd/sox-claim-verification
  └─ (no workspace deps at runtime)
     [dev: @adhd/sox-blob-store, @adhd/sox-embedding-provider]

@adhd/sox-graph-store
  └─ (no workspace deps)

@adhd/sox-analysis
  ├─ @adhd/sox-vector-store
  └─ @adhd/sox-graph-store

@adhd/sox-manifest
  └─ (no workspace deps)
```

### External Dependencies by Class

#### Vector Storage
- **sqlite-vec** ^0.1.9 — brute-force kNN (vec0 backend)
- **lancedb** 0.31.0 — ANN indexes (HNSW/IVF-PQ)
- **apache-arrow** 18.1.0 — LanceDB data format
- **better-sqlite3** ^12.10.0 — database engine

#### Embeddings
- **fastembed** ^2.1.0 — local ONNX inference (default)
- **@huggingface/transformers** ^4.2.0 — remote model resolution

#### Graph/Indexing
- **drizzle-orm** ^0.42.0 — schema ORM + migration
- **(implicit: better-sqlite3)** — backend

#### Queue/Scheduling
- **croner** ^10.0.1 — cron expression parsing

#### Code Analysis
- **tree-sitter-wasms** 0.1.13 — WASM grammar binaries
- **web-tree-sitter** 0.25.10 — AST parser bridge

#### Clustering
- **density-clustering** ^1.3.0 — DBSCAN implementation

#### Source Access
- **fast-glob** ^3.3.3 — filesystem pattern matching
- **ignore** ^7.0.5 — .gitignore parsing
- **undici** ^6.21.0 — HTTP client (Bitbucket, GitHub)

---

## Dependency Footprint

| Category | Packages | Total Deps | Notes |
|----------|----------|----------|-------|
| Storage | 4 | 4 heavy | sqlite, lancedb, apache-arrow, synckit |
| Compute | 1 | 2 heavy | fastembed, transformers |
| Utilities | 3 | 3 light | croner, tree-sitter, density-clustering |
| I/O | 1 | 3 light | fast-glob, ignore, undici |

**Total unique runtime dependencies: 16** (4 heavy, 12 light/medium)

Heavy dependencies:
- `better-sqlite3`: build-time compilation (Node-gyp), pins to specific Node versions
- `lancedb`: ~45 MB on disk (Arrow + Parquet libs)
- `fastembed`: ~200 MB on disk (pre-downloaded ONNX models, cached in `~/.cache/sox/models`)
- `@huggingface/transformers`: ~50 MB on disk (optional, remote provider only)

---

## Namespace and Scoping

- **Namespace:** `@adhd` (Scoped package)
- **Scope:** All under sox-* naming convention
- **Visibility:** Public (npm + GitHub)
- **Ownership:** adhd organization (implied from scope)

### Naming Scheme

```
@adhd/sox-{area}-{subsystem}

Areas:
  source   (@adhd/sox-source-provider)
  queue    (@adhd/sox-task-queue)
  vectors  (@adhd/sox-vector-store)
  ingest   (@adhd/sox-ingest)
  search   (@adhd/sox-hybrid-search)
  embed    (@adhd/sox-embedding-provider)
  store    (@adhd/sox-blob-store)
  verify   (@adhd/sox-claim-verification)
  graph    (@adhd/sox-graph-store)
  util     (@adhd/sox-manifest)
```

---

## Version and Semver

### Current Versions

- v0.1.0 : Initial Phase 1 release (8 packages)
- v0.2.0 : Manifest (stabilized contract)
- All others: v0.1.0 (no v0.2+ yet)

### Semver Commitment

**Pre-1.0:** All are 0.x.y, so minor version bumps MAY include breaking changes.

**Unstable contracts:**
- @adhd/sox-vector-store: Backend interface may change (reembed signature, space invariant)
- @adhd/sox-analysis: Pure algorithms may add new overloads
- @adhd/sox-hybrid-search: Fusion strategy may add new normalizations

**Stable contracts:**
- @adhd/sox-source-provider: SourceRef parsing frozen
- @adhd/sox-task-queue: TaskQueue interface frozen (idempotency guarantee)
- @adhd/sox-blob-store: BlobStore interface frozen (CAS dedup)
- @adhd/sox-manifest: Frozen at v0.2.0

---

## Build Output Verification

All packages follow consistent artifact structure:

```
dist/
├── [package].js (or index.js)
├── [package].d.ts (or index.d.ts)
└── [subpaths] (if applicable)

files: ["dist"]
main: "./dist/index.js"
types: "./dist/index.d.ts"
```

### Type Coverage

- **Full:** 11/11 packages (100%)
- All exports have corresponding `.d.ts` definitions
- No `skipLibCheck` workarounds needed

---

## Installation Profile

### Lightweight (Source only)
```bash
npm install @adhd/sox-source-provider        # 98 KB + undici
npm install @adhd/sox-manifest               # 34 KB
```

### Data Layer (Full stack)
```bash
npm install \
  @adhd/sox-task-queue \                     # 126 KB
  @adhd/sox-vector-store \                   # 344 KB (+ lancedb, sqlite-vec)
  @adhd/sox-embedding-provider \             # 178 KB (+ fastembed)
  @adhd/sox-blob-store \                     # 98 KB
  @adhd/sox-graph-store \                    # 142 KB
  @adhd/sox-ingest                           # 312 KB (+ tree-sitter WASM)
```

**Full ecosystem (~2.2 MB + native binaries)**

---

## Known Publishing Constraints

1. **better-sqlite3** requires:
   - Python 3.x on build machine
   - C++ compiler (gcc, clang, MSVC)
   - npm rebuild on platform change (no prebuilt for all platforms)

2. **lancedb** provides prebuilt binaries:
   - macOS (arm64, x64)
   - Linux (x64)
   - Windows (x64)
   - *iOS/Android not supported*

3. **fastembed** downloads models on first use (~50-200 MB per model):
   - `$XDG_CACHE_HOME/sox/models/` (or `~/.cache/sox/models`)
   - Controlled via `SOX_EMBED_CACHE_DIR`

---

## Consumption Pattern

### From another workspace (agent-source, project-xyz)

Add as workspace dependency in package.json:

```json
{
  "dependencies": {
    "@adhd/sox-task-queue": "workspace:*",
    "@adhd/sox-vector-store": "workspace:*"
  }
}
```

Or from published npm (after release):

```bash
npm install @adhd/sox-task-queue @adhd/sox-vector-store
```

---

## Distribution Channels

| Channel | Status | Notes |
|---------|--------|-------|
| npm public | LIVE | Latest v0.1.0+ of each package |
| GitHub Releases | PENDING | Awaiting formal milestone |
| CDN (jsDelivr, unpkg) | NOT APPLICABLE | ESM-only, CJS incompatible |
| Docker/container | NOT APPLICABLE | Runtime dependency, not image-friendly |

---

## Future Expansion

Candidate packages (not yet published):

- @adhd/sox-data-cache (multi-tier cache: in-mem, redis, sqlite)
- @adhd/sox-query-planner (cost-based retrieval planning)
- @adhd/sox-batch-validator (schema + invariant validation runner)

All would follow same:
- @adhd namespace
- sox- prefix
- Public access
- 0.x.y versioning (pre-1.0)
- Real backends only (no stubs)
