# Changelog

## 0.2.5

### Patch Changes

- Re-version the `sox-memory-bundle` members whose bundled bytes drifted from their published
  `registry/index.json` pins, so a fresh-machine install from the registry receives exactly the bytes
  the local build produces.

  The drift is a build-inlining effect, not a source change: each member bundles workspace libraries
  (`@adhd/sox-store-adapter`, `@adhd/sox-memory-core`) declared as **devDependencies**
  `workspace:*`. Changesets' `updateInternalDependencies: "patch"` cascades only through
  `dependencies`/`peerDependencies`, so the `turso-driver-offthread` rework of those libraries rebuilt
  these three members' entrypoints without bumping their versions. `build-index.ts` correctly
  preserves a committed pin while its locator is unchanged, so the stale pins survived and the
  clean-room smoke's G2 compared the correct published bytes against unpublished local bytes —
  CHECKSUM MISMATCH.

  A patch bump moves each locator, so the release flow re-derives the checksum from the bytes it
  publishes. `memory-server` is intentionally not touched: its version is already ahead of its pin
  (1.4.2 vs the committed 1.4.1) and needs no re-version. `registry/index.json` is untouched
  (ADR-0021) — the registry is written by the release flow, not by this change.

## 0.2.4

### Patch Changes

- 6251948: Rebuilt against `@adhd/sox-embedding-provider` 0.6.0 and
  `@adhd/sox-service-proxy` 0.4.4 (ADR-0022: the embedding host retires on work,
  keys on a content build id, owns its model init, and never inherits a
  service's identity env).

  The `workspace:^` ranges on embedding-provider do not admit a minor bump, so
  every direct and transitive dependent is republished here explicitly. The
  memory-server, memory-cli and memory-flush bundles inline the new embedding
  host sidecar, so their published artifacts carry the fix. No source change in
  these packages.

## 0.2.3

### Patch Changes

- 14265f0: Republishes the memory-cli and memory-flush bundles so their inlined
  `@adhd/sox-memory-core`, `@adhd/sox-store-adapter` and
  `@adhd/sox-embedding-provider` code matches this release. `dist/index.js`,
  the embed and enrich worker sidecars, and the new `embedHostMain.js` sidecar
  all differ from the published 0.2.4 / 0.2.2 tarballs. Every invalidation now
  records `meta.invalidatedReason`, and the Turso FTS quoted-query fix is
  included. These packages have no source changes of their own.

## 0.2.2

### Patch Changes

- 884e3e7: Rewrite the package README against real, executed behaviour.

  These packages published to npm with READMEs that were missing, wrong, or unusable:
  no install line, no runnable example, and in several cases relative links pointing
  outside the package directory — dead for every npm reader, since a tarball carries
  only the package's own directory plus a force-included README and LICENSE.

  Every README now has an install line and at least one example that was actually run
  against the built artifact, with real output. Every documented symbol is verified to
  exist in that package's own declarations.

  Packages built on `@adhd/sox-store-adapter` now state the concurrency properties they
  inherit from it: the default Turso backend mandates `multiprocess-wal`, so multiple
  processes hold concurrent write connections to one store file. The claim is scoped
  per package rather than asserted blanket-wide — packages whose default path is
  single-writer by construction say so.

  Corrections found by reading and running the code rather than trusting the prose:
  `sox-graph-store` described itself as a store "over SQLite" when it has no
  better-sqlite3 dependency and is built on StoreAdapter; `sox-hybrid-search` described
  itself as an unimplemented skeleton when its implementation is complete;
  `sox-embedding-provider` advertised a hash provider that exists in no factory branch;
  and `sox-tokenguard-core` documented `detectFqdn` as returning `<FQDN_1>` when it
  returns `<HOST_1>`.

## 0.2.0

### Minor Changes

- 05430d9: Publishing & distribution refactor — the system is now publishable, consumable, and reusable purely
  from `npm install`, and new bundles install the same way (BL-42/BL-43/BL-65/BL-34/BL-33/BL-38).

  - **All 12 `@adhd/sox-*` libs publish public** (`private:false` + `publishConfig.access:public`,
    `engines.node>=20`, `files:["dist"]`) so third parties can `npm i` and import the engine SDK (G3).
    API stability tiers documented in `docs/publishing/api-stability.md` (ADR-0005 / Q2).
  - **CLI is a self-contained esbuild bundle** with an in-package `bin` (`@adhd/sox-cli` →
    `soxe`), in-package `dist`/`files`/`engines`/`publishConfig`, and a bundled registry copy, so
    `npm i -g @adhd/sox-cli` works on a fresh machine with no checkout (G1; fixes BL-34).
  - **Extensions are self-contained bundles (Model A)** carrying zero `@adhd/sox-*` runtime deps;
    `memory-server`/`memory-cli`/`memory-flush`/`memory-daemon` migrated off bare `tsc` to esbuild
    (closes BL-38). Native addons (`better-sqlite3`, `sqlite-vec`) are declared as real runtime
    `dependencies` and installed via a new `npm-package:` install mode (tarball + `npm install`),
    the only path that can deliver transitive native deps to a fresh machine (G2).
  - **Registry portability:** `build-index` emits portable `npm-package:` locators under the
    `SOX_REGISTRY_PUBLISH` signal (was a dormant CDN branch); `check-registry-sync` mirrors it
    (BL-33). The content checksum remains the sole extension identity/integrity authority — the npm
    version only selects which bytes to fetch (ADR-0003 intact; ADR-0005 ratifies the coexistence).
  - **Born-publishable golden path:** `soxe init` scaffolds publish + fresh-machine-install-ready
    packages; a `check-publishable` gate forbids the `workspace:*`/`@adhd`-runtime-dep 404 class.

## 0.1.0

- Initial release
