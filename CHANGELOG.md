# Changelog

---

## [Unreleased] — graph-store extensible node kinds; hybrid-search filter/vector-channel correctness

`@adhd/sox-graph-store` and `@adhd/sox-hybrid-search` fixes closing out the four blockers the
adhd agent-mcp-authoring integration audit filed as BL-293/294/295/303. Both packages remain
at their current published versions (`graph-store@0.2.0`, `hybrid-search@0.1.0`) pending a
version bump — not yet published.

### `@adhd/sox-graph-store` — extensible node `kind` allowlist (BL-295)

```ts
import { createGraphBackend } from '@adhd/sox-graph-store';

// Register a domain-specific kind beyond the built-in
// episode/entity/claim/community/session/generic set.
const graph = createGraphBackend(db, { kinds: ['component'] });

const id = graph.writeNode('A reusable Button component', {
  kind: 'component',
  name: 'Button',
});
graph.getNode(id)!.kind;              // 'component'
graph.queryNodes({ kind: 'component' }); // [...]
```

`NodeMeta.kind` / `NodeRecord.kind` / `NodeFilter.kind` are now first-class (previously `kind`
was hardcoded to `'episode'` on every write and not exposed on read at all, despite the `node`
table's CHECK constraint already gating it — the escape hatch existed at the SQL layer with no
way to reach it through the public API). Custom kind names are validated against
`/^[a-z][a-z0-9_]*$/` (rejects anything unsafe to interpolate into the underlying
`CHECK (kind IN (...))` constraint — SQLite can't parameterize DDL) and, for a store re-opened
with new kinds, the constraint is upgraded in place via the existing `rebuildTable`
rename→create→copy→drop→rename mechanism — the same path already used to add
`'generic'`/`'DEPENDS_ON'` to older stores. `NodeFilter` also gained `projectPath`/`agentId`,
closing a gap where those columns were indexed but unfilterable through the public read API.

### `@adhd/sox-hybrid-search` — vector channel now honors query filters (BL-294)

**Fix (namespace/tenant leak):** a `namespace`/`kind`/`topic`/`project_path`/`agent_id` filter
passed to `SqliteSearchBackend.search()` previously constrained only the FTS5 text channel — the
vector (kNN) channel ran completely unfiltered. A namespace-scoped hybrid or vec-only query could
therefore return another namespace's nodes fused into the results (proven with a red→green test:
two nodes with identical vectors in different namespaces, `filters: { namespace: 'tenant-b' }`
leaked `tenant-a`'s node on unfixed code). The vector channel now resolves the same `NodeFilter`
through `graph.queryNodes()` and constrains `vec.knn()` to the matching id set; a filter matching
zero nodes now correctly yields zero vector candidates instead of falling back to an unfiltered
`knn()` call (an empty `VecFilter.ids` array means "no filter" to the vector backend, not "match
nothing", so this required an explicit skip-the-call path, not just passing `{ ids: [] }`).

**New: degrade signal.** `SearchBackend.search()` results (and the top-level `search()`
function's `SearchResult[]`) gained an additive `degraded?: { unsupportedFilters: string[] }`
field, set whenever a caller's `filters` included a key with no mapping onto `NodeFilter`.
Surfaced unconditionally — not gated behind `explain: true`, since "was my filter actually
applied" is a correctness question, not a diagnostic one.

`buildFilterClause()`'s `project_path`/`agent_id` filter keys now route to
`NodeFilter.projectPath`/`NodeFilter.agentId` (previously silently dropped into an `extraClauses`
value that `SqliteSearchBackend` never actually applied to either search channel).

### Fixes (backlog evidence corrections — no code change)

- **BL-293** — `createGraphBackend(db)` already applies schema automatically
  (`SqliteGraphBackend`'s constructor calls `applySchema()`, which is idempotent). Confirmed via
  a fresh in-memory store round-trip and a live check against the **built** `dist/index.js`,
  invoked from a `cwd` outside the package with a real file-backed SQLite store — ruling out any
  `import.meta.url`/migrations-folder resolution issue. The constructor already carried the fix
  as of the 2026-07-11 Drizzle migration port (commit `9c63d40`, same day the blocker was filed
  against a pre-port line reference); this entry only corrects the stale backlog evidence.
- **BL-303** — `drizzle-orm` is not a dead dependency: `libs/data/graph/graph-store/src/index.ts`
  imports `drizzle`/`migrate` from it and runs it in every `applySchema()` call. The 2026-07-11
  Drizzle migration port (commit `9c63d40`) wired it up rather than removing it, closing the
  underlying finding by the opposite resolution than originally proposed. No code change
  required; this entry only corrects the stale backlog evidence.

## [1.2.0] — 2026-07-11 — asp-gateway install surface, build integrity, and embedding-provider audit

This release is where `soxe` grew the install capabilities the asp-gateway bundle needs to deploy on a fresh machine, the build substrate was standardized against off-the-shelf tools with the contract published, and the embedding-provider package's documentation was reconciled with reality through a component-spec audit.

### asp-gateway install capabilities

`soxe install` and `soxe uninstall` now support the four behaviours the asp-gateway bundle needs: hook surfaces with object-array-merge semantics, lockfile-less file-drop uninstall, service start after install, and bundle-level uninstall that recursively removes every member.

```bash
# Install a service extension and start it in one command
soxe install asp-gateway --start --scope=user

# Uninstall a bundle — recursively removes every member
soxe uninstall asp-gateway

# Hook surfaces use object-array-merge for settings.json
# (identity-scoped append/remove, not raw array overwrite)
soxe install components.hook --scope=user
```

**Hook surface + object-array-merge** — `'object-array-merge'` capability added to the host-registry capability set; `libs/install-engine/src/capabilities/object-array-merge.ts` provides identity-scoped append/remove with `OwnedEntry` kind `'object-array-values'`, tracked in the ownership ledger with `entryKey`/`supersededEntries` for fully reversible uninstall. The `claude` surface builder emits settings.json entries through this merge, not a raw overwrite. The `hook-script` secondary file-drop is wired in `declarativeInstall`.

**Lockfile-less uninstall** — `soxe uninstall` no longer hard-exits when no lockfile exists; instead it treats `null` as empty and falls through to the file-drop teardown, so a file-drop-only installation (no lockfile) can be completely reversed.

**Service start after install** — `soxe install` accepts `--start`; after a `type:service` install, it calls `enableOsUnit` with `load: true` and records os-unit ownership in the index for reversible uninstall.

**Bundle-level uninstall** — `soxe uninstall <bundle-id>` resolves the bundle's member ids from the registry, then recurses per member via a shared `uninstallOne()` helper.

### Build substrate standardized

The build substrate was audited per owner directive and migrated to standard tools where they proved equal-or-better, retaining the bespoke esbuild driver only where a swap would regress a safety invariant.

```bash
# The old hand-rolled exports verifier is gone — publint + attw handle it
npx publint --strict
npx attw --pack

# Cache inputs are now standard "production" + "^production"
# (editing memory-core now correctly invalidates memory-server's build cache)
npx nx build memory-server
```

`tools/verify-package-exports.mjs` deleted, replaced by `publint` (red→green proven a strict superset on broken fixtures) + `@arethetypeswrong/cli` (a types-resolution check the old script never had — the BL-208/BL-222 blind spot). Both wired into the smoke preflight.

Hand-maintained cross-package cache `inputs` on all five bundle targets replaced by standard `["production","^production"]` — this exposed and fixed a latent bug where editing `memory-core` did not invalidate `memory-server`'s build cache (verified 11/11 cache hits against changed source → now a cache miss), the cache-level root of the "always rebuild the chain" workaround.

`@nx/esbuild:esbuild` migration evaluated with a live spike on tokenguard, **not adopted**: no post-metafile sidecar-discovery hook exists (a swap re-creates the BL-262 per-consumer-list failure mode), and its default `deleteOutputPath:true` reproduces the BL-235 artifact destruction. Full rationale + revisit triggers documented.

Reusable invariant harness at `tools/test-bl266-bundle-invariants.mjs`. All five invariants verified post-merge: whole-repo build/lint/test/typecheck 32 projects green, smoke 13/0 isolation OK, registry checksum-stable across no-op rebuilds, live memory-server healthy on the new artifact.

### Extension build/bundling contract documented

`docs/standards/extension-bundling.md` is now the single source of truth for what a bundle is, how sidecars are declared/discovered/verified, the externals policy for native addons, atomic staging semantics (BL-235), registry checksum interplay, and the tests-bypass-artifact trap (BL-248/BL-262: vitest runs source; only the shipped bundle proves shipping).

Cross-linked from `AGENTS.md` and referenced in every build-target `CONTRIBUTING.md`. Test of done met: the doc names exactly the gap `3916afd`'s author fell into.

### Memory episode hard-delete

```bash
# Permanently drop specific episodes by UID
memory_curate({op: "drop-episodes", uids: ["<uid>", ...]})
```

`memory_curate` gains `op: "drop-episodes"` — hard-deletes nodes and cascades `vec_node`/`edge` rows in a single transaction. No tombstone, no bi-temporal invalidation: the episode and all its vector index entries are gone atomically.

### Root typecheck gate now green

The `sox-ecosystem:typecheck` script (`tsc --noEmit`) had **24 pre-existing errors** — never gated because the whole-repo gate was `build,lint,test` only. All 24 cleared in commit `334f266` without weakening any tsconfig flag (no `as any`/`!`/`@ts-expect-error`). The tautological routing-drift gate it uncovered (the generator clobbered its own baseline) was also fixed. `npx nx run-many -t build,lint,test,typecheck` goes green for the first time.

### Embedding-provider audit fixes

**`warmupTimeoutMs()` unified** — duplicate definitions in `index.ts` (default 180s) and `fastembed.ts` (default 60s) consolidated to a single exported function in `index.ts` with default `180_000`. Worker-init is no longer bounded by a shorter copy.

**`ModelCache`/`FileSystemModelCache` deprecated** — both carry `@deprecated SOX-BUG-002` JSDoc blocks explaining the real `cacheDir` resolution order; reachable only via the deprecated re-export.

**False "deterministic hash provider" claim removed** — `sox.concerns` no longer advertises a hash/deterministic provider; `createEmbeddingProvider` still switches only on `'fastembed'`/`'remote'` and throws `ResolutionError` for anything else.

**"Asymmetric role encoding" claim corrected** — `sox.concerns` now reads "EmbedRole param accepted for interface compatibility — currently ignored (not yet applied) by the fastembed provider". Code matches: `_role?` prefix and `void opts?.role` confirm the param is documented-accepted but silently unapplied.

**`FastEmbedPoolConfig.batchSizes` JSDoc default fixed** — documented as `256` (`DEFAULT_BATCH_SIZE`), was incorrectly `32`. Also documented that `FastEmbedPoolConfig` is not currently consumed by any factory.

**Stale "warmUp cache" claim removed** — `sox.invariants` now states `warmUp()` is a no-op when `isDeterministic === false` (always true today). No "cache for hot/topic texts" language remains.

**Summariser description corrected** — `sox.concerns` now reads "extractive summary (lead-N sentences — first summaryMaxSentences sentences, no scoring; zero LLM)" — was "sentence-scoring," which belongs to `extractTags`.

### Audit criteria wired

**`memory-refactor` audit states completed** — all five audit-state acceptance criteria (`[audit-*.N]`) wired to real, falsifiable checks in `audit_memrefactor.py`. Gap count dropped 39→9. Red→green proven on 5 sample checks; live write-path probes return blocked-red without an opt-in disposable DB (never a vacuous pass).

### Phantom-package audit resolved

**BL-304 — all 5 packages previously flagged "dead/phantom" verified as actively consumed.** Architect audit confirmed: `@adhd/sox-analysis` (imported by memory-core cluster/neardup/importance), `@adhd/sox-vector-store` (imported by hybrid-search), `@adhd/sox-blob-store` (agent-source `file:` dep, BL-166), `@adhd/sox-claim-verification` (agent-source `file:` dep, BL-166), `@adhd/sox-hybrid-search` (agent-source `file:` dep, BL-166), `@adhd/sox-graph-store` (8 memory-core modules call `createGraphBackend`). `drizzle-orm` in graph-store genuinely dead → BL-303 (already separately tracked and removed). No packages deleted. No code changes.
