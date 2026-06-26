# Publishing — Decision Records (options tables)

Companion to [`SCOPE.md`](./SCOPE.md). Date 2026-06-25, author platform-engineer, sha `20f51d0`.
Each record: **options → tradeoffs → recommendation → consequences.** SCOPE.md §5 summarises;
this file is the long form for owner sign-off.

---

## ✅ OWNER SIGN-OFF — ratified 2026-06-26

Owner directive: **"defaults, but publish it all."** Publish-everything is the chosen target —
the system is to be publishable, consumable, and reusable by others purely from `npm install`,
and new bundles install the same way. Ratified decisions:

| Record / Q | Ratified | Note |
|---|---|---|
| **D-A** | **A1 — publish ALL 12 `@adhd/sox-*` libs public** (overrides the A3 hybrid rec) | Owner wants max reuse + simplest model; accepts the public-API/semver contract as a deliberate one-way door |
| **D-B** | B3 — `npm-package` install mode (tarball + `npm install`); B4 fallback | unchanged |
| **D-C** | C1 — per-member published packages, declarative bundle | unchanged |
| **D-D** | D1 — rewrite sources in-repo + bundled index; D2 deferred (Q4) | unchanged |
| **D-E** | E2 — two axes; **ratify ADR-0005** (Q1 = yes) | npm semver resolves the graph; sha256 stays sole identity/integrity authority |
| **D-F** | F2 — self-contained CLI bundle, in-package bin | unchanged; independent of D-A ordering |
| **Q2** | All libs published; **document API stability tiers** — engine internals start `0.x` (unstable, may break); `manifest`/`authoring` are the stable authoring contract | refinement, non-blocking |
| **Q3** | **Publish the private members too** (`memory-daemon`, `memory-usage` → public) — consistent with publish-everything; removes the carrier/inline workaround | simplifies C1 |
| **Q4** | D1 now (bundled index); `@adhd/sox-registry-index` deferred | |
| **Q5** | Windows native support = follow-on, not launch | |
| **Q6** | `engines.node` floor `>=20` | |

**Consequence for the planner to evaluate:** with everything published *and* B3 (`npm install`)
as the extension install mode, per-extension esbuild **inlining of `@adhd/sox-*` may be obviated** —
extensions can be ordinary npm packages whose deps (including native `better-sqlite3`/`sqlite-vec`)
resolve from npm at install. The content-addressed identity (ADR-0003/0005) must then gate the
**published tarball/artifact**, not a single `dist/index.js`. The CLI (D-F/F2) stays self-contained
regardless. This may simplify S2/S3 materially — the plan should resolve it explicitly.

---

## D-A — Engine libs: publish-as-public-SDK vs bundle-and-keep-private

| Option | What | Pros | Cons |
|---|---|---|---|
| A1 — Publish ALL 12 libs | Flip every `@adhd/sox-*` `private:false`, semver them | Max reuse; simplest mental model; changesets rewrites `workspace:*` automatically | Every internal refactor = public breaking change; 12-package supply-chain/typosquat surface; exposes volatile internals (memory-core, service-proxy) third parties shouldn't pin |
| A2 — Bundle ALL (publish none) | esbuild-inline every lib into each extension; libs stay private | Smallest public surface; no semver burden; extensions self-contained | **Fails G3** — nothing for a third party to `npm i`; the owner's reusability ask unmet |
| **A3 — HYBRID (recommend)** | Publish a curated SDK subset; bundle the rest | Serves G3 with a small documented API; volatile internals stay private + inlined; refactor freedom inside the private set | Two classes of lib to reason about; must define + hold the public API boundary |

**Recommendation: A3.** Public SDK = `install-engine`, `manifest`, `registry`, `host-runtime`,
`authoring`, `mcp-runtime` (start `0.x`). Private+bundled = `memory-core`, `memory-enrich`,
`service-proxy`, `tokenguard-core`, `host-registry`.

**Consequences:** SDK libs gain a real semver contract (see D-E); `soxe init` and the bundler must
keep producing zero-`@adhd`-dep extension artifacts for the private set; a `docs/` page must
enumerate the supported SDK export surface (Q2).

---

## D-B — Native addon distribution (`better-sqlite3`, `sqlite-vec`)

| Option | What | Pros | Cons |
|---|---|---|---|
| B1 — Single-file CDN (status quo path) | Fetch `dist/index.js` only | No new install code | **Broken for native deps** — no node_modules on a CDN; `createRequire` walk finds nothing on a fresh box |
| B2 — Inline native addon into the bundle | esbuild-inline better-sqlite3 | One file | **Impossible** — native `.node` addons can't be inlined (the bundler already forces them `--external`) |
| **B3 — npm-package install mode (recommend)** | Publish extension as a tarball with native deps as real `dependencies`; new fetcher mode runs `npm install` in the per-extension store | Real prebuilt binaries land per-platform; standard npm semantics; checksum still gates the bundle | New install-mode code; install does a real `npm install` (slower, network); prebuild-matrix dependency |
| B4 — Ship prebuilt `.node` per-platform from `@adhd` | Host our own prebuilds keyed by platform | Full control; offline-capable | Build/host a prebuild matrix ourselves — large ongoing cost |

**Recommendation: B3**, with B4 as a fallback only if R1 (prebuild gap) bites.

**Consequences:** the fetcher grows a `npm-package` source mode (tarball → `npm install
--omit=dev`); the §9 G2 gate must exercise a real runtime call (not just fetch) to prove the native
dep resolves; pre-S3 prebuild-matrix spike is mandatory.

---

## D-C — Bundle publish model: per-member vs single carrier

| Option | What | Pros | Cons |
|---|---|---|---|
| **C1 — Per-member packages (recommend)** | Each public member is its own npm package; bundle is a declarative manifest that expands to member installs | Reuses existing independent-install machinery; members version independently; minimal new code | Private members (daemon/usage) need an addressing answer (Q3) |
| C2 — Single carrier package | One tarball carries all 5 members; installer extracts | One publish unit | New bundling + member-extraction installer; re-entangles member versioning; duplicates the install machinery |

**Recommendation: C1.** Matches the already-declarative `bundle` type. Only new work: private-member
addressing (Q3 — recommend carrying daemon's artifact inside the bundle package, inlining usage
content).

**Consequences:** `check-registry-sync` must recurse `members/` (BL-33); the bundle manifest needs a
resolvable source for each private member.

---

## D-D — Registry portability: source rewrite vs published registry artifact

| Option | What | Pros | Cons |
|---|---|---|---|
| **D1 — Rewrite sources in-repo (recommend)** | `build-index` emits npm/CDN locators; CLI ships a bundled registry copy; `release.yml` commits it | Reuses existing build-index + release.yml; fresh machine works via bundled index | Registry still lives in the repo (fine for public, single-source) |
| D2 — Published `@adhd/sox-registry-index` artifact | Publish the index as its own package consumers fetch | Decouples registry from the CLI; non-CLI consumers can query | New package + fetch path; versioning of the index itself; more moving parts now |

**Recommendation: D1** now; D2 deferred (Q4) until a non-CLI consumer needs discovery.

**Consequences:** set the publication signal so `resolveSource` stops emitting `file://`; CLI build
embeds the current index.

---

## D-E — Versioning/identity coexistence with ADR-0003

| Option | What | Pros | Cons |
|---|---|---|---|
| E1 — Reintroduce extension semver for resolution | Resolve extensions by version | Familiar npm model | **Violates ADR-0003** (identity = checksum); revives the dual-write/BL-30 class |
| **E2 — Two axes, never conflated (recommend)** | npm semver resolves the *package graph*; checksum is *extension identity/integrity*; locator-version selects bytes, checksum gates them | Honors ADR-0003; enables npm dependency resolution for SDK libs; no multi-build-per-id | Requires discipline + an ADR to document; reviewers must understand the split |

**Recommendation: E2.** Ratify as **ADR-0005** (Q1).

**Consequences:** registry `source` may include a version in the npm locator, but the lockfile key
stays bare `id` and the checksum stays the sole integrity authority; a test asserts one registry
entry per id after rewrite (R8).

---

## D-F — CLI package shape

| Option | What | Pros | Cons |
|---|---|---|---|
| F1 — Publish CLI with `workspace:*` deps + flip private | Minimal package.json change | Least bundling work | **404s on install** (private `@adhd/sox-*` deps); depends on D-A landing first; not self-contained |
| **F2 — Self-contained esbuild bundle, in-package bin (recommend)** | Inline all `@adhd/sox-*`; `bin`/`dist`/`files`/`engines` inside the package; bundled registry | Works **independently of D-A**; zero runtime `@adhd` deps; clean `npm i -g` | Build wiring (bundle the CLI); shim must move in-package |

**Recommendation: F2.** Unblocks G1 without waiting on the SDK-lib publish.

**Consequences:** move the shim into the package (`./bin/soxe.mjs` → `./dist/main.cjs`); fix
`main`/`bin` off `../../`; add `files`/`engines`/`publishConfig`; CLI gains a bundle build target.
Resolves BL-34 incidentally (in-package entrypoint becomes index-resolvable).
