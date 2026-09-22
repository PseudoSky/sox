# ADR-0019 — Heavy native-chain dependencies of a public composer are `optionalDependencies`, resolved by a lazy non-literal dynamic import

**Status:** ACCEPTED (2026-09-22).
**Owner:** pseudosky.
**Relates to:** ADR-0006 (public/private + DI for live objects — its `optionalDependencies` rejection is scoped to the *private* dep and is superseded for the *public* case by this ADR), ADR-0016 (the semantic composer), ADR-0018 (the process-wide singleton slot), BUG-HYBRID-SEARCH-OPTIONAL-LOADABILITY-001 (the defect this records), `docs/publishing/release-flow.md` §2 (edges that do not float).

## TL;DR for the next agent

A public package that can serve a useful surface **without** a native-chain dependency (vector-store,
embedding-provider) must declare that dependency as `optionalDependencies` — never `dependencies` (it forces
the install) and never `peerDependencies` (npm/pnpm auto-install peers, so it forces the install too). Every
**value** use of it must go through a lazy, **non-literal** dynamic import on the branch that needs it,
cached once, degrading to a clear failure that names the specifier. `@adhd/sox-semantic` and
`@adhd/sox-hybrid-search` are the reference implementations; the resolve-hook guard is the enforcement.

## Context

`@adhd/sox-semantic` 0.1.5 established the shape: both of its native-chain dependencies
(`@adhd/sox-vector-store` → `sqlite-vec` / `better-sqlite3` / `lancedb`; `@adhd/sox-embedding-provider` →
`onnxruntime` / `fastembed`) are `optionalDependencies`, reached only through lazy, non-literal dynamic
imports on the default capability-probe path, with their types arriving as type-only imports (erased at
emit). A caller that injects both a provider and a vector backend resolves neither specifier.

That fix was defeated twice, independently, by its own mandatory dependency `@adhd/sox-hybrid-search`
(0.4.8):

- **(A) Install-level defeat.** hybrid-search hard-declared both packages in `dependencies`, so a consumer
  that listed them as `optionalDependencies` could not produce an install in which they were absent — the
  hard transitive dep re-installed them under any `--omit=optional` / `--no-optional` install. The
  load-level optionality was therefore unreachable at the install level. Confirmed live in the consumer
  `entrypoint/backlog` (`@adhd/sox-hybrid-search ^0.4.6` + the heavy two in `optionalDependencies`).
- **(B) Load-level defeat.** `hybrid-search/src/cross-encoder.ts` **statically value-imported**
  `getSharedOnnxWorker`, `TransientEmbeddingError` and `ResolutionError` from embedding-provider, and
  `src/index.ts` re-exports `./cross-encoder.js`. ESM evaluates a re-exported module and its static imports
  when `index.js` loads, so importing hybrid-search at all — for the pure `fuse()` or for
  `StoreSearchBackend` — resolved embedding-provider and its native ONNX chain.

The two failures are independent: fixing (B) alone leaves (A) (the manifest still forces the install);
fixing (A) alone leaves (B) (the eager import still loads the chain when present, and an omitted install
would crash on import rather than degrade). Both must be fixed, and the same class of defect recurs
whenever a new public composer gains a native-chain edge.

## Decision

1. **A public package's native-chain dependency is `optionalDependencies` when a useful non-native surface
   exists.** "Optional" is the true semantics: *installed by default, tolerated absent, we degrade
   honestly*. It is omittable via `pnpm install --omit=optional` / `npm install --omit=optional` across the
   whole tree. A base-tier dependency with no native chain (`@adhd/sox-graph-store`) stays a hard
   `dependency`.

2. **The specifier is held in a variable; a literal dynamic import is a defect.** A literal
   `import('@adhd/sox-embedding-provider')` is statically analysable, so a bundler (esbuild/rollup) may
   hoist it back into an eager import — silently restoring the mandatory native load. A non-literal
   specifier is opaque to static analysis, so it can only ever be a genuine runtime `import()`.

3. **Resolution is lazy, cached once, on the branch that needs it — never at module load.** The first call
   that actually needs the package resolves it; the resolved module object is memoized so the cost is paid
   once. A module-load-time static import is the failure mode this ADR exists to prevent.

4. **Absence degrades to a typed or clear failure that names the specifier — never a bare
   `ERR_MODULE_NOT_FOUND`.** The error must tell the caller which package is missing and how to remedy it
   (install it, or inject the live object that avoids it). This preserves `instanceof` identity for the
   package's real error types across the lazy boundary.

5. **`peerDependencies` and `peerDependenciesMeta` are rejected for this case.** npm 7+ / pnpm auto-install
   peers by default, so a peer would re-create failure (A) — the dep is still installed unconditionally.
   A peer also fails to express a *fallback* ("we have a working default path when absent"). ADR-0006's
   **Alternatives considered** rejects `peerDependencies` on exactly this auto-install ground.

## Consequences

- `@adhd/sox-hybrid-search` **0.4.9** moves `@adhd/sox-vector-store` and `@adhd/sox-embedding-provider`
  from `dependencies` to `optionalDependencies`; its `cross-encoder.ts` resolves embedding-provider through
  a cached non-literal dynamic import taken only on the first `createCrossEncoder()` call. Its public type
  shapes and `createCrossEncoder`'s signature are unchanged — this is a patch, not a minor. The published
  range floats to the consumer's `^0.4.6`, so no consumer-side manifest change is required.
- **The install-level guarantee:** `pnpm install --omit=optional` produces a tree in which neither heavy
  package is present, and the pure surface (`fuse` / `normalize` / `rrfFuse`) plus `StoreSearchBackend`
  over constructor-injected backends still loads and runs. `createCrossEncoder` in that tree fails with the
  named-specifier message, not a bare module-resolution error.
- **Type-level residual (documented, not papered over):** a *TypeScript* consumer that omits vector-store
  gets a `.d.ts` resolution error on `index.d.ts`'s re-exported `VectorBackend` / `VectorSpace` /
  `VecFilter`. This is legitimate: any consumer that constructs `StoreSearchBackend` must already own a live
  `VectorBackend` (ADR-0006 DI), hence already declares vector-store. Under `skipLibCheck` the unused
  import is inert. **Do not** add `peerDependenciesMeta` to "fix" this (re-creates failure A), and **do
  not** delete the type re-exports (a breaking API change that would force a minor/major).
- **Enforcement.** Two guards ship with the change: `hybrid-search/src/optional-loadability.spec.ts` (a
  child process behind an ESM resolve hook that records every specifier and throws on either heavy one,
  loading the **shipped `dist/index.js`**) and `hybrid-search/src/install-omitted.spec.ts` (a real
  `pnpm pack` → `--omit=optional` consumer proving the heavy directories are absent and `fuse()` runs,
  with a default-install positive control). `semantic`'s existing guard re-runs as a composed-consumer
  regression gate.
- **ADR-0006 tension resolved.** ADR-0006's **Consequences** previously read that hybrid-search depends on
  *"it (and `vector-store`) as normal public deps"*. This ADR supersedes that sentence: hybrid-search
  depends on graph-store as a normal public dep and on vector-store as an **optional** public dep. No
  numbered Decision of ADR-0006 is violated — its `optionalDependencies` rejection in **Alternatives
  considered** was scoped *"for the private dep"* (keeping a dep private *and* the install working), which
  is not this case, since both packages are public.
- **Generalizes.** Any future public composer with a native-chain fallback path follows this ADR, and the
  resolve-hook guard is the reusable enforcement pattern.

## Evidence

- `libs/data/search/semantic/src/index.ts` — the reference lazy loader (`loadOptional` + non-literal
  specifiers) and `libs/data/search/semantic/src/optional-loadability.spec.ts` — the reference guard.
- `libs/data/search/hybrid-search/src/cross-encoder.ts` — the lazy gate; `src/optional-loadability.spec.ts`
  and `src/install-omitted.spec.ts` — the guard and the install-level proof.
- `docs/publishing/release-flow.md` §2 — why a **patch** (0.4.9) is required for a `^0.4.6` consumer.

## Alternatives considered

- **`peerDependencies`.** Rejected — npm/pnpm auto-install peers, so it re-creates failure (A), and it
  cannot express a working default path. (ADR-0006 **Alternatives considered**, same ground.)
- **`peerDependenciesMeta` (optional peer).** Rejected — mechanically it would work (not auto-installed),
  but it is the wrong contract (peers mean "the host provides / versions must match"), it is used nowhere
  in this ecosystem, and introducing it for one package is un-precedented and un-auditable against the
  existing guards. `optionalDependencies` is the ecosystem's established vocabulary for this exact case.
- **Bundle the heavy packages into the public artifact.** Rejected — they are native-chain packages, not
  stateless helpers; ADR-0006's bundling rule is for stateless code, and bundling native addons is not
  viable.
- **Amend ADR-0006's consequence sentence only.** Rejected as the *primary* mechanism — the rule
  generalizes beyond this one edge, and a new ADR is how the catalog records a decision-changing update.
  The ADR-0006 consequence line is corrected *by reference* to this ADR rather than silently edited.
- **Leave `optionalDependencies` out and document a manual install step.** Rejected — it defeats the
  "installed by default" half of the contract; the whole point is that a default install works and an
  omitted install degrades.
