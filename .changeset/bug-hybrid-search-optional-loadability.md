---
'@adhd/sox-hybrid-search': patch
---

Make the native chain optional at BOTH the install and the load level: `@adhd/sox-vector-store` and
`@adhd/sox-embedding-provider` become `optionalDependencies`, and the cross-encoder resolves
embedding-provider lazily on first `createCrossEncoder()`.

Two independent failures are fixed (BUG-HYBRID-SEARCH-OPTIONAL-LOADABILITY-001, ADR-0019):

- **Install-level.** Both heavy packages were hard `dependencies`, so a consumer that listed them as
  `optionalDependencies` could not produce an install in which they were absent — the hard transitive
  dep re-installed them under any `--omit=optional` / `--no-optional` install, defeating
  `@adhd/sox-semantic`'s load-level optionality at the install level. They are now
  `optionalDependencies`, so `--omit=optional` produces a tree with neither, and `fuse()` /
  `StoreSearchBackend` over injected backends still run. `@adhd/sox-graph-store` stays a mandatory
  dependency (base tier, no native chain).
- **Load-level.** `src/cross-encoder.ts` statically value-imported `getSharedOnnxWorker`,
  `TransientEmbeddingError` and `ResolutionError` from embedding-provider, and `src/index.ts`
  re-exports `./cross-encoder.js` — so importing hybrid-search at all (for the pure `fuse()`, or for
  `StoreSearchBackend`) resolved embedding-provider and its ONNX chain. The cross-encoder now takes
  only embedding-provider's **type** statically; every value use is reached through a cached,
  **non-literal** dynamic import resolved exactly once, on the first `createCrossEncoder()`. A literal
  dynamic import would be a defect: a bundler could hoist it back to an eager import.

Absence degrades honestly: with embedding-provider not installed, `createCrossEncoder()` rejects with
a message naming the specifier and the remedy, never a bare `ERR_MODULE_NOT_FOUND`. The public type
shapes and `createCrossEncoder`'s signature are unchanged — a patch, not a minor. `instanceof`
identity for embedding-provider's `TransientEmbeddingError` / `ResolutionError` is preserved across
the lazy boundary.

Two regression guards ship, both with teeth (verified red against a reverse-applied negative control,
green after):

- `src/optional-loadability.spec.ts` loads the **built `dist/index.js`** in a child process behind an
  ESM resolve hook (`module.register()`) that records every specifier and throws on either heavy one.
  It proves the pure path resolves neither heavy specifier (with `@adhd/sox-graph-store` resolution as
  the positive control), and that the cross-encoder degrades with the named-specifier message.
- `src/install-omitted.spec.ts` does a real `pnpm pack` → `pnpm install --omit=optional` consumer,
  asserts neither heavy directory exists anywhere in the tree and `fuse()` runs, with a default-install
  consumer as the positive control.

The manifest also gains the `sox.invariants` entry and `sox.externalConsumers` (`@adhd/backlog`), so
the release check can see the adhd consumer that was previously invisible. See ADR-0019.
