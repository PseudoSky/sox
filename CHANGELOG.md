# Changelog

---

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
