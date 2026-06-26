# ADR-0005 — npm publishing coexists with content-addressed identity (two axes, never conflated)

**Status:** Accepted (2026-06-26). Companion to the publishing & distribution refactor
(`docs/plan/publishing/SCOPE.md`, `DECISIONS.md`). **Extends** ADR-0003 (extension identity is
content-addressed) — it does not supersede it. Ratifies decision D-E (option E2) from the owner
sign-off, and records the Model-A vs Model-B resolution the sign-off delegated to the planner.

**Decision (one sentence):** Publishing the `@adhd/sox-*` packages to npm introduces **npm semver
for package-graph resolution**, which is a **different axis** from **extension identity/integrity**
(the sha256 content checksum of the built entrypoint, ADR-0003); the two never read each other —
the npm version only *selects which bytes to fetch*, after which the checksum is the *sole* gate.

---

## Context

ADR-0003 made an extension's identity `id + sha256(entrypoint artifact)` and demoted the
extension's own `version` to a display-only label. The publishing refactor (BL-42/BL-43) must let
a fresh machine `npm install` the CLI, the engine libs, and the extensions — which **reintroduces
npm semver**, because npm resolves a package graph by version range. ADR-0003 itself flagged this
tension ("Note the tension … a future multi-build-per-id registry is an explicit, separately-decided
change"). This ADR closes it.

Three forces had to be reconciled:

1. **G3 — third-party reuse.** A consumer must `npm i @adhd/sox-install-engine` and import it. That
   *requires* publishing the libs with real semver (npm's resolution axis).
2. **G2 — native deps on a fresh machine.** `memory-server` needs `better-sqlite3` / `sqlite-vec`
   native addons. A single-file CDN fetch cannot deliver a `node_modules`; only a real `npm install`
   (the new `npm-package:` install mode) lands a platform binary.
3. **ADR-0003 — identity stays content-addressed.** Re-introducing semver must NOT make version a
   resolution input for extensions (that revives the BL-30 dual-write class and multi-build-per-id).

---

## Decisions (Accepted)

### 1. Two axes, never conflated (D-E / E2)

- **npm semver** governs **inter-package dependency resolution at install-from-npm time** — e.g.
  `npm i @adhd/sox-install-engine@^0.2` resolves the lib graph; changesets rewrites `workspace:*`
  to a real range at publish. This axis is **invisible to the extension-identity system**.
- **Content checksum** (`sha256` of the built entrypoint) remains the **sole** extension
  identity + integrity authority (ADR-0003 unchanged). The registry `source` may carry a version
  in its locator (`npm-package:@adhd/sox-extension-memory-server@1.1.0`) — that version only
  **selects which bytes to fetch**; the fetcher then recomputes the checksum and compares
  (`install.ts` `fetchArtifact`). **A version bump with identical bytes is a no-op to identity; a
  byte change with the same version still trips `CHECKSUM MISMATCH`.**
- **No multi-build-per-id.** `build-index` still emits exactly **one** entry per id; the locator
  version does not create a resolution choice. The lockfile key stays the bare `id` (ADR-0003 Dec. 3).

### 2. The content hash gates the *runtime artifact*, proven reproducible across npm

The checksum gates the extension's **built entrypoint bundle** (`dist/index.js`), which the publish
pipeline ships verbatim inside the npm tarball. This was verified to be **byte-reproducible** across
`npm pack` → `npm install`: `sha256(local dist/index.js) == sha256(npm-installed dist/index.js) ==
memory_ping.artifact`. Because the esbuild bundle embeds no absolute paths (the native-addon loader
resolves `__filename` at runtime; the sourcemap URL is relative), the registry checksum computed at
build time equals the fetcher's checksum after a real `npm install` on any machine. The
content-address gate therefore holds end-to-end across the npm substrate.

### 3. Extensions are self-contained bundles (Model A), libs are published packages

The sign-off asked the planner to evaluate whether "everything published + `npm install`" obviates
per-extension esbuild inlining (extensions as ordinary npm packages whose `@adhd/sox-*` deps resolve
from npm — "Model B"). **Resolution: keep esbuild self-contained bundling for extensions (Model A).**

- **Why not Model B:** Model B would force the integrity authority to move from
  `sha256(dist/index.js)` to `sha256(tarball)` — a one-way-door change through ADR-0003's most
  load-bearing invariant, with npm-pack gzip-reproducibility hazards (registry tarball vs local
  `npm pack` integrity differ in general). It also enlarges every extension's install-time supply
  chain to N `@adhd` packages.
- **Why Model A holds:** the bundle inlines **all** `@adhd/sox-*` JS, so `sha256(dist/index.js)`
  genuinely captures the full JS behavior — the content address stays meaningful and the ADR-0003
  core is **untouched**. Only native `.node` addons stay external; those are platform-specific
  binaries that cannot be content-pinned identically across platforms anyway, so semver-ranging them
  (npm's job) is the **correct** expression of axis 1 (`dependencies: { better-sqlite3, sqlite-vec }`),
  while axis 2 (the checksum) gates the JS bundle. This is the cleanest realization of E2.
- **"Publish it all" is still honored at the package level:** all 12 `@adhd/sox-*` libs flip
  `private:false` + `publishConfig.access:public` (G3), and every extension/bundle member publishes
  too (Q3). Extensions simply carry their `@adhd/sox-*` build deps as **devDependencies** (inlined by
  the bundler) so the published runtime artifact has **zero** `@adhd` runtime deps.

### 4. The `npm-package:` install mode is the native-dep delivery vehicle

`build-index` emits a portable `npm-package:<name>@<version>` locator when the publication signal
`SOX_REGISTRY_PUBLISH` is set (replacing the dormant, never-fired `manifest.checksum` CDN branch).
The fetcher's new `npm-package:` mode runs a real `npm install` into a per-extension content store
(`<dataRoot>/ext/<id>/`), so transitive native deps resolve a platform binary; it then resolves the
entrypoint and checksum-gates it. Pure-JS extensions use the same mode uniformly (offline-verifiable
against a local registry); the legacy single-file CDN (`npm:`) branch is retained for back-compat.

---

## Consequences

- **Structural 404 prevention.** A new gate (`scripts/check-publishable.ts`) fails CI if a published
  package carries a `workspace:*` runtime dep onto a non-published target, or if an extension carries
  any `@adhd/sox-*` runtime dep. The BL-42 dependency-404 class cannot regress.
- **API stability tiers (Q2).** Publishing the libs creates a public API surface; its support tiers
  are documented in `docs/publishing/api-stability.md` (engine internals `0.x` unstable;
  `@adhd/sox-manifest` + `@adhd/sox-authoring` are the stable authoring contract).
- **Supply-chain surface.** 12 public libs enlarge the typosquat/attack surface; mitigated by
  `0.x` for volatile internals, npm provenance (`id-token: write` in `release.yml`), and the minimal
  per-extension install footprint (native deps only).
- **No change to ADR-0003.** Identity, the lockfile key, `--frozen-lockfile` checksum verification,
  and the one-entry-per-id invariant are all unchanged. ADR-0005 only adds the npm-resolution axis
  beside them and proves their coexistence.

## Carve-outs

- `compatibility.host` (ADR-0003 Dec. 7) is still a distinct axis (extension ↔ host-runtime),
  untouched.
- Windows native support is a follow-on (Q5). The native prebuild matrix targets macOS + Linux
  (arm64 + x64); see the handoff note for the Node-20 better-sqlite3 prebuild gap (R1).
