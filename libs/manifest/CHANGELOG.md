# @adhd/sox-manifest

## 0.4.0

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

## 0.3.0

### Minor Changes

- 32275f7: Additive: opencode host support in manifests, plus new validation-set exports.

  `ExtensionManifest.hosts?: Array<'claude' | 'codex'>` widened to `Array<'claude' | 'codex' |
'opencode'>` — an array-of-union widening on a field consumers write into when authoring a manifest,
  not one they narrow-match against; old manifests remain valid, new manifests may now legally include
  `'opencode'`. Four new top-level exports: `VALID_TYPES`, `VALID_RUNTIMES`, `VALID_HOOK_EVENTS` (all
  `Set<string>`), and `KNOWN_HOSTS: Set<string>`. No removed or narrowed export — minor.

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
