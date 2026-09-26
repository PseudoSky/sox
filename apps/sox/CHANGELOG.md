# @adhd/sox-cli

## 1.3.0

### Minor Changes

- a742f23: A user-scope OS unit no longer bakes a git checkout's `soxe` into its argv. The
  front-shim (`soxe serve <id> --port <port>`) and doctor-tick units used
  `realpath(process.argv[1])` — the CLI that ran `service enable` — so prod's
  launchd unit ran the dev checkout's `bin/soxe` and every branch switch or build
  there changed production. New `resolveUnitCliPath` (host-runtime) resolves an
  explicit `--cli-path`, else the invoking soxe when it is not in a checkout, else
  a released `@adhd/sox-cli` install, else the checkout CLI marked volatile;
  `service enable|update` and `doctor --install-tick` refuse a volatile CLI at
  user scope unless `--allow-checkout-cli`. Also exports `isGitCheckoutPath` and
  `installedCliCandidates`. (27850011)

  A path only counts as a git checkout if the nearest `.git` is found BEFORE the
  walk crosses a `node_modules` segment — a released CLI installed under
  Homebrew's (`/opt/homebrew/.git`) or nvm's (`~/.nvm/.git`) own repo was
  previously misclassified as a checkout, so a correctly installed
  `@adhd/sox-cli` failed the user-scope gate with no way to pass it (the
  suggested `npm i -g @adhd/sox-cli` remedy could never succeed). The released-CLI
  candidate is now resolved via `npm root -g` run through the pinned node's own
  npm, falling back to the old `<prefix>/lib/node_modules` heuristic only when
  that call fails (it previously resolved to the Homebrew Cellar path, which
  Homebrew never populates, and to `~/.adhd/sox-ecosystem/cli`, which nothing
  ever populates — both dropped). `--cli-path` is now validated: a non-absolute
  or nonexistent value throws instead of silently baking in a broken path. This
  is a **behavior change** for `@adhd/sox-cli`: a user-scope `service
enable|update` / `doctor --install-tick` that previously silently accepted (or
  wrongly refused) a CLI path now resolves and gates it correctly, hence `minor`.

## 1.2.3

### Patch Changes

- 14265f0: - `soxe service restart` finds the backend the OS unit actually runs by reading
  the unit's argv on disk (dc6261c1). `--backend-only` respawns only the backend
  and never kickstarts the unit. When the unit's entrypoint
  differs from the resolved install, it reports `NOT DEPLOYED` instead of
  claiming success.
  - `cmdServe` forwards SIGTERM, SIGHUP and SIGINT to its grandchild when running
    without a proxy. A `--grace-ms` of 0 means an immediate SIGKILL, and death is
    verified after escalation.
  - The `cli_invoked` telemetry event now carries `subverb` and `target`
    (d5c01be3).
  - Picks up the unreleased `@adhd/sox-host-runtime`, `@adhd/sox-install-engine`
    and `@adhd/sox-host-registry` changes, which are bundled into the CLI.

## 1.2.2

### Patch Changes

- 06aa9e7: Refuse to publish a CLI that embeds a non-portable registry index.

  `@adhd/sox-cli@1.2.1` shipped to npm with an embedded registry
  (`dist/registry/index.json`) of 31 entries, zero `npm-package:` sources, 31
  `file://` sources pointing at absolute paths under a maintainer's home
  directory, `provisional: true`, and a `+dirty` build stamp. On a machine with no
  repo checkout the CLI falls back to that embedded copy, so every
  `soxe install` failed with `install: source file not found: /Users/…` — leaking
  the maintainer's path and never reaching the checksum gate.

  `embed-registry.cjs` copied whatever sat at `registry/index.json` with no
  validation; its header merely _assumed_ the publish flow had rewritten sources
  first. Two gates now enforce it:

  - **Build time** — `embed-registry.cjs` validates before writing whenever
    `SOX_REGISTRY_PUBLISH` is set, and leaves no artifact on refusal. `file://`
    remains valid for local dev builds, so developer workflow is unchanged.
  - **Publish time** — `check-bundled-registry.cjs` runs as `prepack` and
    `prepublishOnly`, reading the artifact as it sits on disk. This fires even
    when the build never ran and a stale `dist/` is packed wholesale.

  `release:prepared` now carries `SOX_REGISTRY_PUBLISH` into `nx build sox` (it
  previously set it only for `build-index:publish`, so the build that produces the
  published artifact skipped the build-time gate), and the variable is part of the
  build's nx cache key so a cache hit cannot replay a dev-shaped `dist/`.

  **Expected, and not a regression: this build embeds 6 registry entries where
  1.2.1 embedded 31, so `soxe search` lists fewer extensions.** The 25 that
  disappear are private/unpublished extensions that publish-mode `build-index`
  correctly omits — in 1.2.1 they were `file://` entries pointing at a
  maintainer's laptop, so no consumer could ever install them. A shorter list of
  entries that all work is the fix, not a loss.

## 1.2.1

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

## 1.1.1

### Patch Changes

- Embedded registry fix: the published CLI now embeds the **portable** registry
  (`npm-package:` locators for the 7 published extensions only), not checkout-bound
  `file://` dev paths. `build-index`/`check-registry-sync` now gate the `npm-package:`
  rewrite on `private !== true` and omit private/unpublished extensions from the
  published registry entirely — so a fresh `npm i -g @adhd/sox-cli` resolves
  `sox-memory-bundle` from npm with no `/Users` leak and no dangling locators.

## 1.1.0

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
