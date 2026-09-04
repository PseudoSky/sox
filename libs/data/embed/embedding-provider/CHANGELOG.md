# @adhd/sox-embedding-provider

## 0.5.0

### Minor Changes

- 884e3e7: Public API surface changed since the last publish.

  Each of these packages has `dist/*.d.ts` differing from the version currently on
  npm, with no changeset recording it — the drift the `check-changeset-surface` gate
  exists to catch. This changeset records it and ships the accumulated surface.

  The READMEs shipped alongside are rewritten and verified: every documented symbol
  is checked against that package's own built declarations, and every example is one
  that was executed against the built artifact.

  `@adhd/sox-memory-core` also corrects three source comments that asserted ADR-0007's
  single-writer architecture as current fact. ADR-0012 supersedes it — the default
  Turso backend runs `multiprocess-wal`, where multiple processes hold concurrent
  write connections to one store file, serialized through a `-tshm` coordinator, with
  no opt-out. Because those comments are emitted into the shipped `.d.ts`, the false
  claim was visible in consumers' editor tooltips.

### Patch Changes

- Updated dependencies [884e3e7]
  - @adhd/sox-telemetry@0.3.0

## 0.4.1

### Patch Changes

- Stop `terminate()` re-forking a fastembed child process (BUG-MEMORYSERVER-SHUTDOWN-LEAKS-FASTEMBED-CHILD-001). `SharedFastembedProcessClient` now carries a permanent `terminated` flag; `ensureProcess()` refuses to fork once shutdown has begun, so a cache-hit warmup retry racing `coordinatedShutdown` can no longer spawn an untracked orphan `fastembedProcessHost.js` child.

## 0.4.0

### Minor Changes

- **graph-store**: `engineIdentity` and `supportsRecursiveCte` now resolve correctly under the adapter's lazy-connect (BL-580/BL-581) — both previously snapshotted at construction, so `engineIdentity` cached `null` permanently and `supportsRecursiveCte` read a value captured before any connection existed. Backup residue is now reclaimed with a bounded sweep. A semicolon inside a SQL comment was being split into a phantom statement. Indexed the predicate the hot queries actually use, across all three DDL surfaces — a 11.9s delete became 15ms.

  **embedding-provider**: fastembed child pooling is concurrency-adaptive with abort plumbing (BL-575/576), breaking embed head-of-line blocking. The pool's grow trigger now has a real time dimension rather than firing on instantaneous depth, and auto-sizing accounts for macOS reclaimable memory — `os.freemem()` excludes inactive/speculative/purgeable pages, so the pool previously sized itself against a number far below the memory actually available.

  **blob-store**: internal workspace dependency ranges float (`workspace:^`) so published consumers are not pinned to an exact internal version.

### Patch Changes

- Updated dependencies
  - @adhd/sox-telemetry@0.2.1

## 0.3.0

### Minor Changes

- d0644be: Add `WARMUP_CACHE_HIT_ATTEMPTS` and `warmupOuterBudgetMs()` exports. A cache-hit fastembed warmup now retries up to `WARMUP_CACHE_HIT_ATTEMPTS` (2) times at the existing tight per-attempt budget (`warmupTimeoutMs(true)`, unchanged from BL-376) instead of giving up after a single attempt — a cold-but-cached load that merely took slightly longer than one tight window (e.g. under OS scheduling pressure) no longer strands the shared fastembed child process mid-load while the caller gives up and forgets it ever asked (BUG-EMBED-WARMUP-CACHEHIT-ASSUMES-FAST-LOAD-001). Cache-miss warmups are unaffected: still exactly one attempt at the existing 180s default budget.

## 0.2.0

### Minor Changes

- 32275f7: Breaking: `warmupTimeoutMs` gained a required, non-optional parameter.

  ```
  -export declare function warmupTimeoutMs(): number;
  +export declare function warmupTimeoutMs(cacheHit: boolean): number;
  ```

  Any consumer calling `warmupTimeoutMs()` with zero arguments — the only legal call under the
  published `0.1.0` signature — now fails to compile. This is a required-parameter addition to an
  existing exported function, not an additive change: the old call site is a type error under the new
  `dist/index.d.ts`, so major is correct regardless of how trivial the call-site fix is (BL-376).

  Also additive in this release (does not affect the bump, recorded for changelog completeness):
  new exports `isPidAlive`, `checkAndClaimFastembedLock` (`fastembedProcessHost.d.ts`), `isModelCached`
  (`index.d.ts`), a new `fastembedLock.d.ts` module exporting `FastembedLockInfo` and
  `resolveFastembedLockPath` (BL-471), a new optional `EmbeddingProviderMetadata.execution_provider?:
string` field, a new `SharedFastembedProcessClient`-accepting constructor overload, and
  telemetry-carrying JSDoc on `request()`/`terminate()` (BL-432/BL-405, comment-only).
