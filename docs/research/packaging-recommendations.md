# Packaging Research → Package Mapping

Generated 2026-07-11. Maps researcher findings to actual sox-ecosystem packages.

---

## Topic A: Native Library Packaging

### Packages with native deps (11 total)

| Package | Native deps | Bundled? | External? | Type |
|---|---|---|---|---|
| `@adhd/sox-extension-memory-server` | better-sqlite3, sqlite-vec, fastembed, onnxruntime-node | esbuild | Yes (4) | mcp-server extension |
| `@adhd/sox-extension-memory-cli` | better-sqlite3, sqlite-vec | esbuild | Yes (4) | command extension |
| `@adhd/sox-extension-memory-flush` | better-sqlite3, sqlite-vec | esbuild | Yes (4) | command extension |
| `@adhd/sox-memory-core` | better-sqlite3, sqlite-vec, fastembed | tsc (library) | N/A | data lib |
| `@adhd/sox-embedding-provider` | fastembed (transitive onnxruntime-node) | tsc (library) | sidecarExternals | data lib |
| `@adhd/sox-vector-store` | @lancedb/lancedb (Rust napi-rs), better-sqlite3, sqlite-vec | tsc (library) | N/A | data lib |
| `@adhd/sox-blob-store` | better-sqlite3 | tsc (library) | N/A | data lib (orphaned) |
| `@adhd/sox-graph-store` | better-sqlite3 | tsc (library) | N/A | data lib |
| `@adhd/sox-task-queue` | better-sqlite3 | tsc (library) | N/A | data lib |
| `@adhd/sox-ingest` | tree-sitter-wasms, web-tree-sitter (WASM) | tsc (library) | N/A | data lib |
| `tools/baseline-capture` | better-sqlite3, sqlite-vec | tsc (tool) | N/A | private tool |

### Current approach vs. research recommendations

**Current: "delegate to upstream"** — all native deps are well-known npm packages that handle their own prebuilds. The bundler marks them `--external` and uses `createRequire`-based lazy stubs. Install-time rebuild is handled by a root `postinstall: pnpm rebuild better-sqlite3 sqlite-vec`. A `verify-native-abi.mjs` script probes better-sqlite3 and onnxruntime-node only (gap: no sqlite-vec or @lancedb/lancedb check).

**Research says:**

| Principle | Applies to | Current state | Gap |
|---|---|---|---|
| **prebuildify + node-gyp-build** (bundled prebuilds with compile fallback) | memory-server, memory-cli, memory-flush (bundled extensions) | Relies on each npm package's own prebuild mechanism. Bundled bundles are CJS-only; native `.node` files stay in `node_modules` resolved at runtime. | No first-party prebuild pipeline. If `better-sqlite3` stopped shipping prebuilds for a platform, we'd need `node-gyp` at install time on every machine. The contract doc documents the status quo but does not prescribe a migration. |
| **optionalDependencies platform packages** (esbuild/sharp pattern) | memory-server, memory-cli, memory-flush | Not used. All native deps are in `dependencies` (not optional). The `npm-package:` install mode does a real `npm install --omit=dev` which resolves platform-specific sub-packages transitively from upstream packages. | No platform isolation at our packaging layer. A user who only wants the CLI (no embedding) still gets `onnxruntime-node` even though `memory-cli` only needs `better-sqlite3` and `sqlite-vec`. The fact that all 4 native deps are externalized indiscriminately means every consumer pays for the union of all deps at install time. |
| **napi-rs CI/CD pipeline** (Rust addons) | `@lancedb/lancedb` (upstream, not ours) | Upstream napi-rs package handles its own CI/CD. Not applicable to first-party code. | Low priority — we consume `@lancedb/lancedb`, we don't author it. |
| **N-API ABI stability** (single binary across Node majors) | All packages | Upstream packages handle their own N-API targeting. `better-sqlite3` uses N-API. `onnxruntime-node` uses N-API v3. | No first-party concern. Verify that our consumers are pinned to a Node major that our upstream native deps support. |
| **Externals policy (what's --external)** | All bundled extensions (memory-server, memory-cli, memory-flush) | Documented in `extension-bundling.md`: only true third-party native addons are `--external`. `@adhd/sox-*` code is inlined. ✓ | Documented, but the bundler doesn't enforce it — it's a manual list per `project.json`. No CI gate prevents adding a new native dep to a bundled extension without adding it to `--external`. |
| **verify-native-abi.mjs scope** | memory-server, memory-cli, memory-flush | Probes better-sqlite3 and onnxruntime-node. Does NOT probe sqlite-vec or @lancedb/lancedb. | Gap: sqlite-vec (used by 3 bundled extensions, 5 libraries) and @lancedb/lancedb (used by vector-store) are not covered. |

### What packages could benefit from changes

1. **memory-server** — highest impact: carries 4 native deps, ships as bundled extension. If a platform lacks a prebuild for any of the 4 upstream packages, the whole extension fails at install time. Research recommendation: the `optionalDependencies` pattern would let each extension declare only the native deps it actually needs, platform-tagged, with a graceful degradation path.

2. **memory-cli, memory-flush** — currently externalize `fastembed` and `onnxruntime-node` even though neither package directly depends on them (they come via `@adhd/sox-memory-core` → `@adhd/sox-embedding-provider`). This means install-time resolution attempts to fetch onnxruntime-node even when it's never loaded at runtime. Research recommendation: split externals per-bundle based on actual usage, or use the bundler's tree-shaking with `--external` scoped to deps that are genuinely called.

3. **vector-store** — `@lancedb/lancedb` (Rust napi-rs) is NOT listed as `--external` in any bundle. Currently no bundled extension imports vector-store, so this is latent. If any extension were to import the LanceDB backend, the bundle would fail (esbuild can't inline a `.node` binary). Research recommendation: add `@lancedb/lancedb` to the externals policy doc and to the external list of any consumer that may transitively import it.

---

## Topic B: Database Adapter Pattern

### Packages with multi-backend or interface-based patterns (6)

| Package | Pattern | Backends | Applies to |
|---|---|---|---|
| `@adhd/sox-vector-store` | Interface + dual implementation | SqliteVectorBackend, LanceDbVectorBackend | Factory-selected at instantiation |
| `@adhd/sox-graph-store` | Interface + single implementation | SqliteGraphBackend only | Factory-returned; interface supports expansion |
| `@adhd/sox-hybrid-search` | Composed backends | Wraps VectorBackend + GraphBackend | Constructor-injected |
| `@adhd/sox-embedding-provider` | Factory + dynamic import | FastembedProvider, RemoteProvider | Config.type dispatch + lazy import() |
| `@adhd/sox-memory-core` | Env-driven selection | Fastembed (both 'auto' and 'real') | SOX_EMBED_BACKEND env var |
| `@adhd/sox-blob-store` | Dynamic driver import | better-sqlite3 only | await import() at open() |

### Current approach vs. research recommendations

| Principle | Applies to | Current state | Gap |
|---|---|---|---|
| **Subpath exports for dialect selection** (Drizzle pattern) | None | No package uses subpath exports for backend selection. `ingest` uses exports for module-system compat (CJS vs ESM), not dialect selection. | If vector-store or embedding-provider wanted to ship backends as separate import paths (`@adhd/sox-vector-store/sqlite` vs `@adhd/sox-vector-store/lancedb`), they'd need subpath exports + proper typesVersions. Currently both backends are always imported regardless of which one the caller uses. |
| **Separate packages per backend** (Sequelize pattern) | None | No per-backend packages exist. All backends ship in the same package. | If `@adhd/sox-vector-store` offered separate packages (`@adhd/sox-vector-store-sqlite`, `@adhd/sox-vector-store-lancedb`), dependencies would be isolated (no `@lancedb/lancedb` dep for sqlite-only consumers). Currently all deps for both backends are mandatory. |
| **Dynamic require monolith** (Knex pattern — BLOCKED) | None | No packages use try-require for optional backends. | Intentional avoidance — the codebase already avoids fragile `try{require()}` patterns. ✓ |
| **Code-generated client** (Prisma pattern) | `@adhd/sox-graph-store` | Uses Drizzle ORM with `sqliteTable` from `drizzle-orm/sqlite-core` — SQLite-specific schema. Drizzle generates migration files. | The schema is hardcoded to SQLite. If a second dialect were added, Drizzle's schema generation would need per-dialect config files and migration directories. |
| **Dynamic import() for optional native deps** | `@adhd/sox-embedding-provider`, `@adhd/sox-blob-store` | embedding-provider uses `await import()` for FastembedProvider (in a child process, not main thread). blob-store uses `await import('better-sqlite3')` at open(). | embedding-provider does this correctly (child process isolation). blob-store does it on the main thread in-process. Neither is try-require — the deps are mandatory. |
| **Explicit driver injection** (pass driver instance, not import) | `@adhd/sox-hybrid-search` | hybrid-search accepts `VectorBackend` + `GraphBackend` as constructor args — caller injects. ✓ | Already following this pattern. |
| **Factory dispatch at instantiation time** | `@adhd/sox-vector-store`, `@adhd/sox-embedding-provider`, `@adhd/sox-graph-store` | All three use factory functions (`openVectorStore`, `openLanceDbVectorStore`, `createEmbeddingProvider`, `createGraphBackend`) | No gap — the factory pattern is consistent. ✓ |

### What packages could benefit from changes

1. **vector-store** — the clearest candidate for subpath exports or separate packages. Both `SqliteVectorBackend` and `LanceDbVectorBackend` are statically exported from the same entry point. A consumer who only needs SQLite still gets `@lancedb/lancedb` plus its transitive deps (`apache-arrow`, `synckit`) in `node_modules`. If the LanceDB backend were at `@adhd/sox-vector-store/lancedb` with its own `package.json` dependencies, sqlite-only consumers would avoid 3+ transitive deps.

2. **embedding-provider** — currently uses dynamic `import()` correctly inside a child process. But the factory (`createEmbeddingProvider`) statically references both backend files. If the `RemoteProvider` backend were behind a subpath export or optional dep, the factory could load it only when selected, reducing the bundle size for local-only consumers.

3. **graph-store** — `GraphBackend` interface is clean and generic. If a second dialect were added, the Drizzle schema would need to be parameterized (currently `sqliteTable` from `drizzle-orm/sqlite-core`). The factory `createGraphBackend` would need a dialect argument. Good foundation, no immediate action needed unless Postgres/MySQL support is planned.

---

## Packages with no actionable changes needed

| Package | Why no change needed |
|---|---|
| `@adhd/sox-tokenguard-core` | Pure TS, no native deps |
| `@adhd/sox-host-runtime` | Pure TS, no native deps, no multi-backend |
| `@adhd/sox-install-engine` | Pure TS, no native deps |
| `@adhd/sox-manifest` | Pure TS, no native deps |
| `@adhd/sox-registry` | Pure TS, no native deps |
| `@adhd/sox-authoring` | Pure TS, no native deps |
| `@adhd/sox-analysis` | Pure TS (density-clustering is JS-only) |
| `@adhd/sox-claim-verification` | Pure TS, no native deps |
| `@adhd/sox-source-provider` | Pure TS (fast-glob, ignore, undici — JS-only) |
| `@adhd/sox-service-proxy` | Pure TS (node:builtins only) |
| `apps/sox` (CLI) | No native deps; lazy require() is for circular-dep avoidance, not multi-backend |
| All skill/agent/command extensions | Declarative only, no JS deps |
