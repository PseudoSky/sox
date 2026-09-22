# Spec — `@adhd/sox-hybrid-search` optional loadability (heavy native-chain deps are optional, loaded lazily)

**Status:** Draft for review (architect pass — no code written)
**Builds on:** ADR-0006 (public/private + DI for live objects), ADR-0016 (semantic facade is a composition package), ADR-0018 (process-wide singleton slot), `docs/publishing/release-flow.md` §2 (edges that do not float).
**Precedent (the shape to mirror):** `@adhd/sox-semantic` 0.1.5→0.1.7 — `libs/data/search/semantic/src/index.ts` (`loadOptional` + non-literal specifiers), `libs/data/search/semantic/src/optional-loadability.spec.ts`, `libs/data/search/semantic/src/__tests__/fixtures/optional-load-{guard,resolve-hook}.mjs`.
**Tracked as:** `BUG-HYBRID-SEARCH-OPTIONAL-LOADABILITY-001` (adhd backlog graph).
**Repo:** `/Users/nix/dev/ai/sox-ecosystem` (read-only on code). A concurrent executor owns `libs/**/vector-store`; this spec does not touch it.

---

## 1. Problem

`@adhd/sox-hybrid-search` (current **0.4.8**, `libs/data/search/hybrid-search/package.json:26-30`) hard-declares
`@adhd/sox-vector-store` and `@adhd/sox-embedding-provider` in `dependencies`. Both drag a **native chain**
(vector-store → `sqlite-vec` / `better-sqlite3` / `lancedb`; embedding-provider → `onnxruntime-node` / `fastembed`).

Two separate failures follow, and they are distinct:

**(A) Install-level defeat.** A consumer that lists the two as `optionalDependencies` cannot produce an
install in which they are absent, because hybrid-search's hard transitive dep re-installs them under any
`--omit=optional` / `--no-optional` install. The load-level optionality fix (sox-semantic 0.1.5→0.1.7) is
therefore defeated at the INSTALL level. Confirmed live in the consumer
`/Users/nix/dev/node/adhd/.worktrees/backlog-v2/entrypoint/backlog/package.json:20-21,37-40`
(hard-dep `@adhd/sox-hybrid-search ^0.4.6` + `@adhd/sox-semantic ^0.1.2`; the heavy two in
`optionalDependencies`). Evidence the consumer is pnpm: `pnpm-lock.yaml:1556` pins
`/@adhd/sox-hybrid-search@0.4.6`.

**(B) Load-level defeat.** `libs/data/search/hybrid-search/src/cross-encoder.ts:18-23` **statically value-imports**
`{ TransientEmbeddingError, ResolutionError, getSharedOnnxWorker }` from `@adhd/sox-embedding-provider`.
`src/index.ts:7` re-exports `./cross-encoder.js`. ESM evaluates the re-exported module and its static imports
when `index.js` loads, so **importing hybrid-search at all** — for the pure `fuse()` or for `StoreSearchBackend` —
resolves embedding-provider and its native ONNX chain. The consumer
`entrypoint/backlog/src/write/bootstrap.ts:45` does exactly that (`import { StoreSearchBackend } from '@adhd/sox-hybrid-search'`),
so its non-semantic commands pay a mandatory native load.

Note the two are independent: fixing (B) alone leaves (A) (the manifest still forces the install); fixing (A)
alone leaves (B) (the eager import still loads the chain when present, and an omitted install would crash on
import rather than degrade). **Both must be fixed.**

### What hybrid-search actually uses the heavy two for

| Package | Runtime value use in shipped `src/` | Where |
|---|---|---|
| `@adhd/sox-vector-store` | **NONE** — type-only (`import type` / `export type`, erased at emit) | `src/index.ts:1,15` |
| `@adhd/sox-embedding-provider` | `getSharedOnnxWorker()`, `TransientEmbeddingError`, `ResolutionError` | `src/cross-encoder.ts:18-23,93,106,129,151,190,205` |

`StoreSearchBackend` (`src/index.ts:593-604`) receives its `VectorBackend` via the **constructor** — it never
constructs one. `filter-utils.ts:1` and `index.ts:2-3,16` are type-only against `graph-store`. So the *only*
eager runtime edge is `cross-encoder.ts` → embedding-provider, and the only *declared* need for vector-store
is the re-exported types (plus the package's own spec files, which import `SqliteVectorBackend` as a value).

---

## 2. Decision — the dependency mechanism

**Move both heavy packages from `dependencies` to `optionalDependencies`, and make the embedding-provider
runtime resolve only through a lazy, non-literal dynamic import on the `createCrossEncoder` path.**
`@adhd/sox-graph-store` stays a hard `dependency` (base-tier, no native chain; out of scope).

### Why `optionalDependencies` — and not the alternatives

| Mechanism | Verdict | Reason (grounded) |
|---|---|---|
| **`optionalDependencies`** | **CHOSEN** | The established, shipped precedent: `sox-semantic` already declares exactly these two this way (`semantic/package.json:31-34`), with a resolve-hook guard proving it. Expresses the true semantics: *installed by default, tolerated absent, we degrade honestly*. Omittable via `pnpm install --omit=optional` / `npm install --omit=optional` across the whole tree. |
| `peerDependencies` | **REJECTED** | npm 7+ / pnpm **auto-install peers by default**, so this would re-create the current failure (the dep is still installed unconditionally) — precisely ADR-0006's stated reason for rejecting it ("modern npm/pnpm auto-install peers"). It also fails to express a *fallback* ("we have a working default path when absent"). ADR-0006 **Alternatives considered** rejects it for both grounds. |
| `peerDependenciesMeta` (optional peer) | **REJECTED** | Not auto-installed by npm/pnpm, so it *would* work mechanically, but it is the wrong contract (peers mean "the host provides / versions must match", the React/plugin pattern) and it is used nowhere in this ecosystem — introducing it for one package is un-precedented and un-auditable against the existing guards. `optionalDependencies` is the ecosystem's established vocabulary for this exact case. |

### ADR citations (constraints, not suggestions)

- **ADR-0006** — numbered Decisions 1-5 govern *public/private* and *bundling*; none forbids an **optional**
  dependency between two **public** packages. Its **Alternatives considered** rejects `optionalDependencies` /
  `peerDependencies` **"for the private dep"** — a scoped rejection of *keeping a dep private while the install
  works*, which is not this case (both packages are public, per ADR-0006 Consequences). Its rejection of
  `peerDependencies` on the auto-install ground **applies here and is cited above**. Decision 3 (live objects
  cross via DI) is the reason hybrid-search must not *construct* a vector backend or own an embedding-provider
  instance — which it already does not.
- **ADR-0016** — blessed the composer + lazy-load pattern: "live objects cross via constructor DI"; the
  `sox-semantic` optional-loadability implementation is this ADR's direct product. This spec mirrors it.
- **ADR-0018** — legitimizes `getSharedOnnxWorker()` as a process-wide `globalThis` singleton across module
  copies. It is **not** a reason to keep the *eager static import*; the singleton stays, only its resolution
  becomes lazy.
- **`docs/publishing/release-flow.md` §2** — "any `^0.x` edge crossing a **minor** bump … does not reach it".
  The consumer pins `^0.4.6`; a **minor** release (0.5.0) would be invisible to it, a **patch** (0.4.9) floats.
  This constrains the version plan (§6).

### ⚠️ ADR tension that must be surfaced (do not silently design around it)

ADR-0006 **Consequences** contains the sentence: *"Because graph-store is now public, `hybrid-search` depends on
it (and `vector-store`) as **normal public deps** — it no longer bundles them."* Moving `vector-store` to
`optionalDependencies` is in **tension with that recorded consequence sentence** (though it violates none of the
five numbered Decisions, and preserves the sentence's intent: still not bundled).

Per the ADR revision protocol this is a **decision-affecting change to a recorded consequence** and is
**NOT** for this spec to decide. Two compliant options, both requiring explicit human approval:

- **(a) Amend ADR-0006's consequence line** (non-decision correction: "…depends on graph-store as a normal
  public dep and on vector-store as an optional public dep") — proposed edit, written only on approval; **or**
- **(b) New ADR (next free number, currently 0019)** — *"Heavy native-chain dependencies of a public composer
  are `optionalDependencies` resolved by lazy non-literal dynamic import."* Drafted in §8.

**Recommendation: (b)** — the rule generalizes (any future public package with a native-chain fallback path),
and a new ADR is the mechanism the catalog uses for a decision-changing update. Either way, the ADR must land
**before or with** the code.

---

## 3. Interface & behavioral changes

### 3.1 `libs/data/search/hybrid-search/package.json`

```jsonc
// BEFORE
"dependencies": {
  "@adhd/sox-embedding-provider": "workspace:^",
  "@adhd/sox-graph-store": "workspace:^",
  "@adhd/sox-vector-store": "workspace:^"
},
"devDependencies": { "@adhd/sox-store-adapter": "workspace:^" }

// AFTER
"dependencies": {
  "@adhd/sox-graph-store": "workspace:^"
},
"optionalDependencies": {
  "@adhd/sox-embedding-provider": "workspace:^",
  "@adhd/sox-vector-store": "workspace:^"
},
"devDependencies": { "@adhd/sox-store-adapter": "workspace:^" }
```

- `version`: `0.4.8` → **`0.4.9`** (patch — see §6).
- `sox.concerns` / `sox.invariants`: add the invariant "the pure surface (`fuse`/`normalize`/`rrfFuse`) and
  `StoreSearchBackend` over injected backends resolve neither `@adhd/sox-vector-store` nor
  `@adhd/sox-embedding-provider`; the cross-encoder is the only path that resolves embedding-provider, and only
  on first `createCrossEncoder()`."
- `sox.externalConsumers`: **add** the adhd consumer so the release check can see it (currently invisible —
  see §6). Shape per `release-flow.md` §1:
  ```jsonc
  "externalConsumers": [
    { "name": "@adhd/backlog", "repo": "/Users/nix/dev/node/adhd", "path": "entrypoint/backlog", "note": "hard dep on hybrid-search; lists the heavy two as optionalDependencies" }
  ]
  ```

### 3.2 `libs/data/search/hybrid-search/src/cross-encoder.ts` — the only behavioral change

**BEFORE** (static value import, eager native load on module evaluation):

```ts
import {
  TransientEmbeddingError,
  ResolutionError,
  getSharedOnnxWorker,
  type SharedOnnxWorkerClient,
} from '@adhd/sox-embedding-provider';
```

**AFTER** (type-only + lazy non-literal dynamic import, cached once):

```ts
import type { SharedOnnxWorkerClient } from '@adhd/sox-embedding-provider';

// Non-literal on purpose: a literal import('@adhd/sox-embedding-provider') is
// statically analysable and a bundler may hoist it back to an eager import,
// silently restoring the mandatory native load this package must not have.
// Mirrors sox-semantic's VECTOR_STORE_SPECIFIER / EMBEDDING_PROVIDER_SPECIFIER.
const EMBEDDING_PROVIDER_SPECIFIER = '@adhd/sox-embedding-provider';

type EmbeddingProviderRuntime = typeof import('@adhd/sox-embedding-provider');

let _runtime: EmbeddingProviderRuntime | null = null;

/**
 * Resolve the optional @adhd/sox-embedding-provider runtime exactly once, on
 * first use of the cross-encoder — NEVER at module load. Maps "not installed"
 * onto a clear error naming the specifier and the remedy, rather than an
 * ERR_MODULE_NOT_FOUND escaping from a package the caller never asked for.
 */
async function embeddingProviderRuntime(): Promise<EmbeddingProviderRuntime> {
  if (_runtime) return _runtime;
  try {
    _runtime = (await import(/* @vite-ignore */ EMBEDDING_PROVIDER_SPECIFIER)) as EmbeddingProviderRuntime;
    return _runtime;
  } catch (err) {
    throw new Error(
      `"${EMBEDDING_PROVIDER_SPECIFIER}" is required by the cross-encoder reranker and could not be ` +
        `loaded. Install it (npm i @adhd/sox-embedding-provider). The pure fusion surface ` +
        `(fuse/normalize/rrfFuse) and StoreSearchBackend over an injected VectorBackend do not need it.`,
      { cause: err },
    );
  }
}
```

Structural changes inside the file:

1. `CrossEncoderWorker` — drop the constructor-time `getSharedOnnxWorker()`; take the resolved runtime.
   - `constructor(modelId: string, rt: EmbeddingProviderRuntime)`; store `rt`; `private shared: SharedOnnxWorkerClient | null = null`.
   - `start()` (already async): `this.shared = this.rt.getSharedOnnxWorker();` **then** issue the `init` request.
   - `rerank` / `rerankBatch` / `start` error-wrap with `this.rt.TransientEmbeddingError` (not a module-level
     binding).
2. `CrossEncoderImpl` — `constructor(config, rt: EmbeddingProviderRuntime)`; `getWorker()` passes `rt` to
   `CrossEncoderWorker`; `rerank`/`rerankBatch`'s disposed-check throws `new this.rt.ResolutionError(...)`.
3. `createCrossEncoder` — **the single lazy gate**:
   ```ts
   export async function createCrossEncoder(config: CrossEncoderConfig): Promise<CrossEncoder> {
     const rt = await embeddingProviderRuntime();   // honest failure point, only when a cross-encoder is built
     return new CrossEncoderImpl(config, rt);
   }
   ```
4. `CrossEncoderConfig` / `CrossEncoder` / `CrossEncoderMetadata` / `CrossEncoderRerankerConfig` public shapes
   are **unchanged** — `createCrossEncoder` still returns `Promise<CrossEncoder>`; no new export, no new field.
   (The public error *type* on the absent path becomes a plain `Error` with a precise message + `cause`;
   embedding-provider's `TransientEmbeddingError`/`ResolutionError` continue to be used for their real cases,
   preserving `instanceof` identity across the package boundary — see §5, `claim-verification`.)

### 3.3 `libs/data/search/hybrid-search/src/index.ts` — **no change**

Lines 1-3 and 15-16 are type-only (erased); line 7's re-export of `./cross-encoder.js` is now safe because
`cross-encoder.js` no longer eagerly imports embedding-provider. `StoreSearchBackend` continues to receive its
`VectorBackend` via constructor DI (`index.ts:597-604`) and constructs nothing.

### 3.4 `libs/data/search/hybrid-search/project.json` — `test` target must build first

The new guard loads the **shipped `dist/index.js`** (a module-graph shape — the same reason
`semantic/project.json:39-42` declares it). Add:

```jsonc
"test": {
  "executor": "nx:run-commands",
  "options": { "command": "vitest run --config libs/data/search/hybrid-search/vitest.config.ts", "cwd": "." },
  "cache": true,
  "dependsOn": ["^build", "build"],          // ← ADDED (mirrors semantic)
  "inputs": ["default", "^production"]
}
```

---

## 4. Blast radius — who breaks, who is safe

Sweep performed over **both** repos: `package.json` deps, and all `*.ts` imports of
`@adhd/sox-vector-store` / `@adhd/sox-embedding-provider` (the adhd `.worktrees/` tree was searched explicitly —
`rg` skips it as gitignored).

### 4.1 Relies on hybrid-search to transitively provide the heavy two — **none found**

Every source importer of the heavy two also declares it itself:

| Importer | Declares it? | Use | Under new graph |
|---|---|---|---|
| `libs/data/analysis/analysis` | ✅ hard (`package.json:27`) | `import type` + spec value | **SAFE** |
| `libs/data/verify/claim-verification` | ✅ hard (`:27`) | `worker.ts:19` value (`getSharedOnnxWorker`) | **SAFE** |
| `libs/memory-core` | ✅ hard (`:27`) | `embed.ts:23-24`, `reembed.ts:68` value | **SAFE** |
| `libs/data/search/semantic` | ✅ optional (`:31-34`) | lazy non-literal import | **SAFE** (already the pattern) |
| `libs/data/search/hybrid-search` (own specs) | was hard → **optional** | `SqliteVectorBackend` value in 3 specs | **SAFE** (optional deps install by default) |
| adhd `entrypoint/backlog` (worktree `backlog-v2`) | ✅ optional (`:37-40`) | lazy/type-only | **SAFE** — the fix's beneficiary |

### 4.2 Must change or is at risk

| # | Site | Why | Verification |
|---|---|---|---|
| 1 | `hybrid-search/src/cross-encoder.ts:18-23` | **Root cause (B)** — eager static value import of embedding-provider | §5 guard: import of `dist/index.js` resolves neither heavy specifier; `createCrossEncoder` under an armed hook fails with the named-specifier message |
| 2 | `hybrid-search/package.json:26-30` | **Root cause (A)** — hard deps | §5 manifest assertion + install-level spec |
| 3 | `hybrid-search/project.json` `test` | Guard loads `dist/`; target had no `dependsOn` | Guard's `beforeAll` fails loudly if `dist/index.js` is absent (§3.4) |
| 4 | `tools/e2e/substrate-pipeline.test.mjs:66,148` | Calls `createCrossEncoder`; header comment at `:28` asserts the eager import | Comment becomes **stale** — update to "lazily resolved on first `createCrossEncoder()`"; test still runs (optional deps installed in-workspace) |
| 5 | `tools/smoke/consumer-smoke.mjs:208` | Calls `createCrossEncoder` on the built artifact | No code change; **document** that the smoke's cross-encoder probe requires embedding-provider (installed by default) |
| 6 | `claim-verification/src/__tests__/bl238-concurrent-onnx.integration.test.ts:45,99` | Calls `createCrossEncoder` | No change — embedding-provider is its declared hard dep. Run it to confirm the lazy path preserves `TransientEmbeddingError`/`ResolutionError` `instanceof` identity across the boundary |
| 7 | `semantic/src/index.ts:108-115,160-170` (`HYBRID_SEARCH_SPECIFIER` lazy load) | Workaround for hybrid-search's eager embedding-provider import; becomes redundant | No change required (still correct). Re-run `semantic`'s `optional-loadability.spec.ts` — it must stay green and now also holds under a *static* hybrid-search import |
| 8 | `semantic/CHANGELOG.md:27` + `semantic/src/__tests__/fixtures/optional-load-resolve-hook.mjs:9-13` | Prose/comments describing hybrid-search as the carrier of the eager import | Update to note hybrid-search no longer eagerly imports it (historical context kept) |
| 9 | **ADR-0006 consequence sentence** (§2) | Decision-affecting tension | Human-approved ADR-0006 amendment **or** new ADR-0019 (§8) before/with the code |

### 4.3 Named risk (documented, not blocking)

A **TypeScript** consumer that omits `vector-store` gets a `.d.ts` resolution error on
`index.d.ts`'s `export type { VectorBackend, VectorSpace, VecFilter } from '@adhd/sox-vector-store'`
(`index.ts:15`). This is legitimate and must be documented, not papered over:

- Any consumer that constructs `StoreSearchBackend` must already own a live `VectorBackend` (ADR-0006 DI) —
  hence already declares `vector-store` itself. The adhd backlog does exactly this.
- Consumers of the **pure** surface (`fuse`/`normalize`/`rrfFuse`) get an unused, lazily-resolved type import;
  under `skipLibCheck` (the common setting) it is inert.
- **Do not** add `peerDependenciesMeta` to "fix" this — npm/pnpm auto-install peers, re-creating failure (A).
- **Do not** delete the type re-exports — that is a breaking API change (would force a minor/major).

---

## 5. Test plan — with teeth

Three layers. **None is a blanket `nx affected` run**; each names its exact spec file and assertions.

### 5.1 Hermetic resolve-hook guard (always runs, mirrors `semantic`'s)

- **Files (new):**
  - `libs/data/search/hybrid-search/src/optional-loadability.spec.ts`
  - `libs/data/search/hybrid-search/src/__tests__/fixtures/optional-load-guard.mjs`
  - `libs/data/search/hybrid-search/src/__tests__/fixtures/optional-load-resolve-hook.mjs`
  (adapted from the `semantic` originals; `HEAVY = ['@adhd/sox-vector-store', '@adhd/sox-embedding-provider']`,
  `MANDATORY = '@adhd/sox-graph-store'`.)
- **Mechanism:** child process + `module.register()` ESM resolve hook that **records every specifier and throws**
  on any heavy one; loads the **shipped `dist/index.js`**; `beforeAll` **throws loudly** (never skips) if
  `dist/index.js` is absent.
- **Assertions:**
  1. Importing `dist/index.js` and calling `fuse(...)`, `normalize(...)`, `rrfFuse(...)` **and** constructing
     `new StoreSearchBackend(mockVec, mockGraph).searchRanked({text:'x', signals:[{kind:'text'}]}, 5)` exits 0
     with a fused result. **Positive control first:** the hook's log **contains `@adhd/sox-graph-store`** (proves
     the hook observed real resolutions, so the negatives are not vacuous). The log contains **neither** heavy specifier.
  2. Calling `createCrossEncoder({modelId:'x'})` under the same armed hook rejects with a message **containing
     `'@adhd/sox-embedding-provider'`** (honest degradation, not a bare `ERR_MODULE_NOT_FOUND`), and a subsequent
     `fuse(...)` still succeeds (the failure did not poison the pure surface).
  3. Manifest assertion: both heavy specifiers are in `optionalDependencies` and **absent** from `dependencies`;
     `@adhd/sox-graph-store` is present in `dependencies`.
- **Negative controls (execute once, revert):**
  - Temporarily re-add `@adhd/sox-vector-store` to `dependencies` → assertion 3 goes **RED**.
  - Temporarily replace the lazy loader with a top-of-file literal `import { getSharedOnnxWorker } from '@adhd/sox-embedding-provider'`
    → the resolve hook **throws** → assertions 1/2 go **RED**.

### 5.2 Install-level proof (the requirement that must not be hand-waved)

- **File (new):** `libs/data/search/hybrid-search/src/install-omitted.spec.ts`
- **Mechanism (real install, no mocks):**
  1. `beforeAll`: assert `dist/index.js` exists (loud failure otherwise; `dependsOn: ["^build","build"]`).
  2. `pnpm pack` hybrid-search into a `mkdtemp` dir.
  3. Build a temp consumer `package.json` depending on the packed tarball (`file:`), then run
     **`pnpm install --omit=optional --ignore-scripts`** (fallback flag for older pnpm: `--no-optional`).
  4. Child node script imports the installed
     `node_modules/@adhd/sox-hybrid-search/dist/index.js`, calls `fuse()`, prints one JSON line, exits 0.
  5. Teardown removes the temp dir in a `finally`.
- **Assertions:**
  - **Absence (the fix):** `node_modules/@adhd/sox-vector-store` and `node_modules/@adhd/sox-embedding-provider`
    do **not** exist in the consumer tree; child exit 0 and `fuse()` returned a ranked list.
  - **Positive control (default install):** a **second** temp consumer installed with **no** `--omit=optional`
    **does** contain both heavy dirs — proves the absence assertion above is not vacuous (optional deps install
    by default).
  - **Honest degrade:** a third child run calls `createCrossEncoder({modelId:'x'})` in the omitted tree and
    asserts the rejection message names `@adhd/sox-embedding-provider`.
- **Negative control:** revert `hybrid-search/package.json` to put the heavy two back in `dependencies`, run
  this spec → the **`--omit=optional` absence assertion goes RED** (the heavy dirs reappear). This is the exact
  regression `BUG-HYBRID-SEARCH-OPTIONAL-LOADABILITY-001` describes.
- **Notes / preconditions:** needs registry access to fetch the packed tarball's hard deps (`graph-store`,
  `store-adapter`). If the registry is unreachable the spec **fails loudly** (no skip) — per the repo's
  "a test that never ran is a comment" rule. `--ignore-scripts` avoids native builds and is sufficient because
  the child only imports hybrid-search's pure surface (graph-store is type-only at runtime).
- **Runner:** targeted only — `npx nx test hybrid-search` (or
  `npx vitest run --config libs/data/search/hybrid-search/vitest.config.ts`). **No `nx affected`.**

### 5.3 Consumer-outcome test (the reason this exists)

- **Existing, re-run (no new file):** `semantic`'s `optional-loadability.spec.ts` must stay green — it proves
  the *composed* consumer path. Re-run `claim-verification`'s
  `bl238-concurrent-onnx.integration.test.ts` to prove error-type identity survives the lazy boundary.
- **Consumer-side follow-up (adhd repo — a separate release, not this repo's change):** in
  `.worktrees/backlog-v2/entrypoint/backlog`, install with `--omit=optional` and assert a **non-semantic**
  command runs without loading the native chain (`bootstrap.ts`'s `StoreSearchBackend` import must not pull
  onnxruntime), and that a semantic command degrades to the typed `not_installed`/`InvalidArgumentError('semantic', …)`
  path. Verified via `node -e "…"` on the installed tree, keyed on the **process exit code**.

---

## 6. Version & publish plan

### Changeset scope

- **`@adhd/sox-hybrid-search`: `patch` → `0.4.9`.**
  Rationale (grounded in `release-flow.md` §2): the consumer pins `^0.4.6`, and a **`^0.x` edge crossing a
  minor bump does not float** — a `0.5.0` would be **invisible** to the consumer and require a manifest bump on
  its side. A **patch floats** (`^0.4.6` covers `0.4.x`), so `0.4.9` reaches the consumer with **no consumer-side
  change**. The change is manifest + internal load mechanism only; **no public API change** (that is also why the
  optional `CrossEncoderConfig.worker?` DI seam is deliberately **out of scope** — it would force a minor; see §7).
- Changeset file: `.changeset/<bug-hybrid-search-optional-loadability>.md`, affected package
  `@adhd/sox-hybrid-search: patch`. Respect the repo's `check-changeset-surface` gate (`package.json:18`).
- `workspace:^` is the correct range for the two moved deps (`release-flow.md` §2 table) — never `workspace:*`.

### Cascade implications

- **adhd `@adhd/backlog`** (`entrypoint/backlog`, both the main repo `^0.4.6`… and the worktree): hard-depends on
  hybrid-search; its `^0.4.6` **floats to 0.4.9 automatically**. It also optionally depends on the heavy two.
  No manifest change required — but the release is **not done** until the consumer is re-installed and verified
  (§5.3, `release-flow.md` §5: "verify the running process, not the artifact").
- **`@adhd/sox-semantic`**: depends on hybrid-search via `workspace:^` → republished range becomes `^0.4.9`.
  No source change. Its `optional-loadability.spec.ts` is re-run as a regression gate.
- **`libs/memory-core`, `libs/data/verify/claim-verification`**: `workspace:^` on hybrid-search; no change
  (they declare their own embedding-provider).
- **Add `sox.externalConsumers`** to hybrid-search's manifest (§3.1) so `tools/release-consumers.mjs` can see the
  adhd consumer — today it is **invisible** to the release check, which is itself a latent release-hygiene gap.

### npm-verify step (post-publish)

1. `node tools/release-consumers.mjs @adhd/sox-hybrid-search` → exits 0 (no non-floating edge).
2. `npm view @adhd/sox-hybrid-search@0.4.9 dependencies optionalDependencies` → confirms the two are under
   `optionalDependencies` and absent from `dependencies`.
3. `pnpm pack` the published version into a `mkdtemp` consumer with `--omit=optional` → assert both heavy dirs
   **absent**, `fuse()` runs (mirrors §5.2 against the **registry** artifact, not the workspace).
4. Re-install the adhd consumer from the registry and run the §5.3 consumer-outcome checks (exit-code keyed).

---

## 7. Independent segments (for the executor)

| Segment | Files | Depends on | Read tokens | Output tokens | Required context |
|---|---|---|---|---|---|
| **A — Manifest** | `hybrid-search/package.json` (deps + `sox.invariants` + `externalConsumers`) | none | ~80 | ~60 | Read `package.json:26-34,47-56` only |
| **B — Lazy cross-encoder** | `hybrid-search/src/cross-encoder.ts` | none (independent of A) | ~250 (`:1-100` imports/worker ctor) | ~200 | Read `cross-encoder.ts:1-30` + `:85-115` + `:170-246` only |
| **C — Test wiring** | `hybrid-search/project.json` (`test.dependsOn`) | none | ~30 | ~20 | Read `project.json:32-43` only |
| **D — Resolve-hook guard** | `src/optional-loadability.spec.ts` + `src/__tests__/fixtures/*.mjs` (3 new) | A, B, C | ~150 (adapt from `semantic`'s 3 files) | ~350 | Read the 3 `semantic` originals; do not read hybrid-search's full source |
| **E — Install-level spec** | `src/install-omitted.spec.ts` (new) | A, B, C | ~80 | ~300 | Read `semantic/src/optional-loadability.spec.ts` for the child-process pattern |
| **F — Docs/comments** | `tools/e2e/substrate-pipeline.test.mjs:28`; `semantic/CHANGELOG.md:27`; `semantic/.../optional-load-resolve-hook.mjs:9-13` | A, B | ~60 | ~50 | Targeted reads only |
| **G — ADR** (blocked on approval) | `docs/decisions/0019-*.md` (new) **or** `0006-*.md` amendment | human approval | ~80 | ~250 | Read ADR-0006 in full |
| **H — Changeset** | `.changeset/<name>.md` | A | 0 | ~20 | none |

Segments A–F are independent enough to run in parallel **except** D/E which need the built artifact (C).

**Execution notes for weaker models:**
- In `cross-encoder.ts`, **never** change the public type shapes or `createCrossEncoder`'s signature; only the
  import form, the runtime threading, and the error sources.
- The specifier **must** be held in a variable — never a literal `import('@adhd/sox-embedding-provider')`.
- Do **not** touch `src/index.ts`, `src/filter-utils.ts`, or the existing `*.spec.ts` files.
- Do **not** touch `libs/**/vector-store` (concurrent executor).
- Revert every negative-control edit after running it; `git status --porcelain` must show only intended files.

---

## 8. Proposed ADR (draft — write only on approval)

```md
# ADR 0019 — Heavy native-chain dependencies of a public composer are optionalDependencies, resolved by lazy non-literal dynamic import

**Status:** Proposed
**Owner:** pseudosky
**Drives:** BUG-HYBRID-SEARCH-OPTIONAL-LOADABILITY-001
**Relates to:** ADR-0006 (public/private + DI), ADR-0016 (semantic composer), ADR-0018 (singleton slot)

## TL;DR for the next agent
A public package that can serve a useful surface WITHOUT a native-chain dependency (vector-store,
embedding-provider) must declare that dependency as `optionalDependencies` — never `dependencies` (it forces the
install) and never `peerDependencies` (npm/pnpm auto-install peers, so it forces the install too). Every use of
it must go through a lazy, NON-LITERAL dynamic import on the branch that needs it, cached once, degrading to a
typed/clear failure naming the specifier. `sox-semantic` and `sox-hybrid-search` are the reference
implementations; the resolve-hook guard is the enforcement.

## Context
[…sox-semantic 0.1.5 established the shape; hybrid-search's hard dep defeated it at install level…]

## Decision
1. A public package's native-chain dependency is `optionalDependencies` when a useful non-native surface exists.
2. The specifier is held in a variable; a literal dynamic import is a defect (bundler hoisting).
3. Resolution is lazy, cached once, on the branch that needs it — never at module load.
4. Absence degrades to a typed/clear failure naming the specifier; never a bare ERR_MODULE_NOT_FOUND.
5. `peerDependencies` (+ `peerDependenciesMeta`) is rejected for this case (ADR-0006's auto-install ground).

## Evidence
[semantic optional-loadability.spec.ts; hybrid-search guard + install-omitted spec; release-flow §2]
```

---

## 9. Open questions

1. **ADR route** (§2): new ADR-0019, or amend ADR-0006's consequence sentence? Recommendation: **0019**.
2. **Version granularity** (§6): confirm **patch 0.4.9** (floats to the `^0.4.6` consumer, no consumer change) —
   or accept a **minor 0.5.0** if the optional `CrossEncoderConfig.worker?` DI seam is wanted now (would require
   a consumer manifest bump; deliberately out of scope here).
3. **Install-level spec placement** (§5.2): keep it inside `nx test hybrid-search` (network-touching), or move it
   to a `tools/smoke/` tool invoked by a `verify` target? Recommendation: keep in `test` (fail-loudly), mirroring
   the repo's "no silent gating" rule.
4. **`sox-graph-store`** is also type-only at runtime in hybrid-search. Left as a hard dep (base-tier, no native
   chain, and its types are re-exported). Flagged as a possible future cleanup — **not** in this scope.
5. **ADR-0006 Consequences** currently reads "hybrid-search depends on … vector-store as normal public deps";
   whichever route (1) is chosen, the corrected text must land before or with the code.
