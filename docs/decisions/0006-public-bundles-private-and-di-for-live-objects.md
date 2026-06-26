# ADR-0006 — Public packages bundle private internals; live objects cross via dependency injection

**Status:** Accepted · 2026-06-26
**Relates to:** ADR-0003 (content-addressed identity), ADR-0005 (npm publishing coexistence), the
extension bundler `tools/bundle-extension.cjs` (Model A).

## Context

ADR-0005 made the workspace npm-publishable and established **Model A**: every *extension* esbuild-
**inlines** its `@adhd/sox-*` code and declares only true third-party/native addons (`better-sqlite3`,
`sqlite-vec`, …) as `--external`, so a published extension artifact carries **zero `@adhd` runtime deps**.

That settled *extensions*. It did **not** settle *libraries*. As we decompose subsystems (e.g. the
memory subsystem into `data/*` packages), we want to publish **only** the packages with genuine
standalone third-party reuse value and keep thin internal libs **private** — schema-over-SQLite helpers,
off-the-shelf-algorithm wrappers, trivial transforms. The blocker: **a public package cannot have a
private `@adhd/sox-*` runtime dependency** — `npm i` of the public package 404s on the unpublished dep
(the BL-43 failure class). Naively, one public consumer forces its entire transitive `@adhd` graph
public, defeating the "publish only what's genuinely reusable" goal.

## Decision

1. **Publish only what has standalone reuse value.** A package is **PUBLIC** (`private:false`,
   `publishConfig.access:public`) **only if** a third party can meaningfully `npm i` and use it on its
   own. Everything else is a **PRIVATE** internal lib (`private:true`) — extracted for structure, never
   published.

2. **A public package may depend on a private `@adhd` lib ONLY by BUNDLING its code** at build time
   (esbuild inline, identical to Model A for extensions). The published tarball carries **zero `@adhd`
   runtime deps**. Only true third-party/native deps (`better-sqlite3`, `sqlite-vec`, `fastembed`,
   `onnxruntime-node`, …) are `--external` and declared as real `dependencies`.

3. **Bundle only STATELESS code; cross live objects via DEPENDENCY INJECTION.** The code a public
   package inlines from a private lib MUST be stateless (pure functions, schema/DDL helpers, query
   builders). Anything **live or identity-sensitive** — an open DB connection, an embedding-provider
   instance, a vector buffer, anything checked with `instanceof` or relied on as a singleton — MUST cross
   package boundaries via **dependency injection** (passed in by the composer) over a **shared, externalized
   native dep**, NEVER via duplicated stateful bundled code. This is what neutralizes the dual-package /
   multiple-copies hazard: N bundled copies of a stateless helper are harmless; two copies of a stateful
   object are a bug.

4. **Public libs still ship types.** A bundled public *library* (consumed via `import`) must still emit a
   bundled `.d.ts` (`tsc` + a d.ts bundler) so consumers get types — a bundle is not an excuse to drop the
   type surface.

5. **The npm name is identity (ADR-0003).** Bundling changes packaging, not identity: each published
   tarball is still content-addressed by `sha256`, and a package's published **name is immutable** (a
   rename/move never changes it).

## Consequences

- **The public surface is exactly the reusable set.** Private internals never publish → smaller
  supply-chain + semver-contract burden. (Memory-refactor, **revised 2026-06-26 on external use-case
  demand — see `USE_CASES.md` SYS-1..10**: **5 public** — `embedding-provider`, `vector-store`,
  `graph-store`, `hybrid-search`, `analysis`; **1 private** — `ingest` (no use case pulled it; thinnest).
  graph-store + analysis were promoted because real consumer systems require them: catalog/notes/agent-
  memory pull graph-store (versioned nodes + composition edges + dedup), and dedup/clustering/drift pull
  analysis. **Because graph-store is now public, `hybrid-search` depends on it (and `vector-store`) as
  normal public deps — it no longer bundles them;** the bundle-private mechanism below now has no active
  instance in this refactor but remains the canonical rule for any future private dep.)
- **Code duplication is accepted, bounded.** A private lib bundled by N public packages ships N copies;
  fine for stateless helpers. A change to a bundled private lib requires **rebuild + republish of every
  public package that bundles it** — a versioning coupling to track.
- **Enforcement.** A public package's published artifact MUST have **no `@adhd/sox-*` in runtime
  `dependencies`** (`scripts/check-publishable.ts` already gates fresh-machine-safe dep shape — extend it
  to assert zero-`@adhd`-runtime-deps for public packages). Stateless-bundle + DI-for-live-objects is a
  review rule (no static check yet).
- **Decision rule for new packages:** *"Does a third party gain from installing this alone?"* → yes =
  public (bundle any private deps); no = private (get bundled by whoever needs you).

## Alternatives considered

- **Publish the whole transitive graph.** Rejected — forces thin schema/util libs into a public,
  semver-bound, one-way-door surface for no reuse benefit.
- **Pure dependency-injection, bundle nothing.** Viable for *live* objects (and we use it for those), but
  it pushes wiring + a stable interface onto every consumer; bundling stateless helpers is "just works on
  `npm i`." We use **both**: bundle stateless code, DI live objects.
- **`optionalDependencies` / `peerDependencies` for the private dep.** Rejected — modern npm/pnpm
  auto-install peers, and `optional` means "tolerate absence," which silently breaks the consumer; neither
  keeps the dep private *and* the install working.
