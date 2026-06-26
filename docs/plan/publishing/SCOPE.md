# Publishing & Distribution — Refactor Specification (SCOPE)

| | |
|---|---|
| **Version** | 1.0 (draft) |
| **Date** | 2026-06-25 |
| **Author** | platform-engineer |
| **Git sha** | `20f51d0` (branch `main`) |
| **Status** | SPEC ONLY — no implementation. Supersedes the *fix sketch* in BACKLOG BL-42/BL-43. |
| **Companion** | [`DECISIONS.md`](./DECISIONS.md) — the decision records with options tables. |

> **Reality-gate philosophy (CLAUDE.md).** "Tests pass" ≠ "publishable." The single canonical
> acceptance gate in this spec is the **fresh-machine container smoke** (§9). Every slice carries
> its own verification gate, but none of them count as *done distribution* until the container
> gate is green. All builds go through **nx targets** (never bare `tsc`/`vitest`/`eslint`); any
> `dist` touch is followed by `npx nx run registry:sync-index` on the **real checkout** (a worktree
> bakes absolute `source` URLs) and an explicit-path commit.

---

## 1. Goal & success criteria

**Owner's words:** *"I want the system to be publishable, consumable, and reusable by others purely
from `npm install`. I want new bundles to be installable the same way as well."*

Translated into four testable acceptance assertions (the fresh-machine gates):

- **G1 — CLI from npm.** On a machine with **no repo checkout**, `npm i -g @adhd/sox-cli` makes
  `soxe --version`, `soxe list`, `soxe search` work with exit 0 and no reference to any
  `/Users/...` path.
- **G2 — Bundle from npm.** On that same machine, `soxe install sox-memory-bundle --scope user`
  resolves **every** member from npm/CDN (zero `file://` sources), installs the native runtime
  dependency, spawns `memory-server`, and `memory_ping` returns `{ ok: true, ... }` with a content
  address.
- **G3 — Libs reusable by third parties.** A third-party Node project can
  `npm i @adhd/sox-install-engine` (and the other public SDK libs) and `import`/`require` them
  with working types — i.e. the engine is consumable outside this monorepo.
- **G4 — Born-publishable.** A **new** bundle/extension authored via `soxe init` reaches
  *published + fresh-machine-installable* through the **same** templated golden path (§7), with no
  one-off hand-edits to `package.json`, the registry, or CI.

**Definition of "done" for this spec's program of work:** all of G1–G4 verified by the §9
container gate in CI, with `npx nx run-many -t build,lint,test` green and the registry containing
zero `file://` sources for published extensions.

---

## 2. Non-goals

Explicitly **out of scope** for this engagement (each may be a separate future effort):

- **OS-kernel sandboxing** of extensions — an explicit non-goal already (DOD C6). Permission
  enforcement stays in-process.
- **The OS-supervisor control surface** (launchd/systemd unit generation, BL-51) — not on the
  publish path.
- **Private/org registry hosting** (a self-hosted registry server, auth, paid scopes) — this spec
  targets the **public** `@adhd` npm scope + public CDN only. (The registry-portability decision
  §5(d) keeps the door open but does not build a server.)
- **Multi-build-per-id resolution** — ADR-0003 forbids it; publishing must not reintroduce it
  (see §5(e)).
- **Changing the runtime/serve architecture** of memory-server (proxy front-shim, daemon
  lifecycle) — untouched except for the BL-65 *config repoint* (§8, Slice 3).
- **Windows native-addon support** — the prebuild matrix (§5(b)) targets macOS + Linux (arm64 +
  x64); Windows is a follow-on.
- **Removing checkout-bound *development*** — devs still build locally. The goal is that
  *consumers* and the *live MCP config* stop depending on the checkout, not that the repo stops
  building.

---

## 3. Current-state analysis (verified)

Every claim below was read from the live tree at sha `20f51d0`. Citations are `file:line`.

### 3.1 Consumer side — READY

The install fetcher already speaks three schemes (`libs/install-engine/src/install.ts:261-329`):

- `file://` → reads the resolved entrypoint, with the C4 resolution order
  (`manifest.entrypoint` → `dist/index.js` → `prompt.md` → `extension.json`) at `install.ts:285-302`.
- `http(s)://` → `fetch()` the URL, checksum the bytes (`install.ts:312-317`).
- `npm:` → maps `npm:<spec>` to `https://cdn.jsdelivr.net/npm/<spec>/dist/index.js`
  (`install.ts:318-326`).

Checksum verification (`install.ts:331-340`) is scheme-independent — ADR-0003 content-addressing
holds for any source. **The consumer can already install from npm/CDN today** — what's missing is
a producer that *publishes* and *rewrites the registry to point there*, plus a way to deliver
**native dependencies** (see §3.3).

> ⚠ **Single-file limitation (load-bearing).** Both the `npm:` and `http(s)://` branches fetch
> **one file** (`…/dist/index.js`) and checksum it. This is correct for **pure-JS** extensions.
> It is **insufficient** for an extension that needs a **native addon at runtime** (memory-server
> → `better-sqlite3`, `sqlite-vec`): a single `index.js` on a CDN has no `node_modules`, so the
> bundle's lazy `createRequire` walk (`tools/bundle-extension.cjs:141-147`) finds nothing on a
> fresh machine. Delivering native deps requires an **npm-package install mode** (tarball +
> `npm/pnpm install` of declared dependencies), not a single-file fetch. This is the central
> producer gap §5(b)/Slice 3 must close.

### 3.2 Producer side — MISSING / checkout-bound

- **Registry is absolute-`file://` (BL-42).** `registry/index.json` has **15** entries whose
  `source` is `file:///Users/nix/dev/ai/sox-ecosystem/...` (verified by grep — note: 15, not the
  14 ADR-0003 cites; `demo-creator` was added since). On any other machine those paths do not
  exist.
- **`resolveSource` gates CDN URLs on a signal never set.** `scripts/build-index.ts:158-177`:
  it emits `https://cdn.jsdelivr.net/npm/<pkg>@<version>/dist/index.js` **only when
  `manifest.checksum` is present**, else falls back to `file://${extDir}`. Nothing in the publish
  flow sets `manifest.checksum`, so build-index always emits `file://`. The CDN-rewrite path is
  *written but dormant*.
- **All 12 `@adhd/sox-*` packages are `private: true`** (verified): `authoring`, `host-registry`,
  `host-runtime`, `install-engine`, `manifest`, `mcp-runtime`, `memory-core`, `memory-enrich`,
  `registry`, `service-proxy`, `tokenguard-core`, **cli**. Versions are `0.1.0` except
  `memory-enrich 1.0.0` and `cli 1.0.0`.
- **`workspace:*` deps 404 on publish (BL-42).** The published extensions declare `@adhd/sox-*`
  runtime deps with the `workspace:*` protocol:
  - `memory-server` (`@adhd/sox-extension-memory-server@1.1.0`, public): depends on
    `@adhd/sox-memory-core`, `-memory-enrich`, `-mcp-runtime`, `-service-proxy` — **all four
    `workspace:*` and all four `private`** (`members/memory-server/package.json:18-23`).
  - `memory-cli` (`@adhd/sox-extension-memory-cli`, public): `@adhd/sox-memory-core: workspace:*`.
  - `memory-flush` (`@adhd/sox-extension-memory-flush`, public): `@adhd/sox-memory-core: workspace:*`.
  - `memory-daemon`, `memory-usage`: `private: true` (internal bundle members).
  `workspace:*` only resolves inside the pnpm workspace; a published tarball carrying it 404s
  (already hit for `@adhd/sox-tokenguard-core`, per BL-42).
- **CLI package can't stand alone** (`apps/sox/package.json`): `private: true`; `main:
  "../../dist/apps/sox/main.js"` and `bin.soxe: "../../bin/soxe"` both point **outside** the
  package directory (`../../`), so an `npm pack` would not include the entrypoint; no `engines`,
  no `publishConfig`, no `files`. The `bin/soxe` shim itself is a 10-line ESM `createRequire` of
  `../dist/apps/sox/main.js` — also outside the package.
- **memory-server builds with bare `tsc`, not the bundler** (`members/memory-server/project.json:17`:
  `tsc --project … && gen-schema.cjs`). Its `dist/index.js` therefore carries **bare
  `require("@adhd/sox-*")`** that only resolve because it runs stdio **from the repo** (BL-38). By
  contrast `memory-daemon` was converted to the self-contained esbuild bundle (BL-37 resolved).
- **Live MCP config is checkout-bound (BL-65).** `.mcp.json` / `~/.claude.json`
  `mcpServers.memory-server.command = /Users/nix/dev/ai/sox-ecosystem/bin/soxe` → the dev `dist`
  IS the live MCP runtime. A repo build mutates the running server; the principled repoint is
  **blocked on this spec** (there is no independently-installable `soxe`).
- **Root `package.json` is `private: true`** with the changesets scripts wired
  (`build-index`, `version-packages` = `changeset version`, `release` = `changeset publish`).
- **CI publish pipeline exists but has never run green** (`.github/workflows/release.yml`):
  changesets-action → `pnpm release` → `pnpm run build-index` (only `if published == true`) →
  commit `registry/index.json`. Changeset config (`.changeset/config.json`): `access: public`,
  `baseBranch: main`, `updateInternalDependencies: patch`. Three pending changesets exist
  (`proxy-default-memory-backend.md`, `sox-memory-p0.md`, `sox-memory-p5.md`) — the p0/p5 ones
  describe historical churn and would mis-changelog (BL-43 #4).

### 3.3 Native-addon reality

`tools/bundle-extension.cjs` inlines all `@adhd/sox-*` (alias → each lib's `dist/index.js`,
lines 41-52) but **must keep native addons external** (`--external better-sqlite3 sqlite-vec`),
loaded lazily via `createRequire(__filename)` walking up the dir tree (lines 103-152). On the dev
box that walk finds the monorepo `node_modules`. **On a fresh machine it finds nothing** unless the
native dep was installed next to the bundle. Therefore any published memory artifact MUST declare
`better-sqlite3` (and `sqlite-vec`) as **real runtime `dependencies`** so npm/node-gyp/prebuild
installs a platform binary on the target — and the install must run actual `npm/pnpm install`, not
a single-file fetch (§3.1 warning).

---

## 4. Verified-vs-unverified ledger

| Claim | Status | Evidence |
|---|---|---|
| 15 `file://` registry sources | **verified** | `grep -c file:///Users registry/index.json` → 15 |
| Fetcher supports file/http/npm | **verified** | `install.ts:268-329` |
| `npm:`/CDN fetch is single-file | **verified** | `install.ts:320` hardcodes `/dist/index.js` |
| 12 `@adhd/sox-*` all `private` | **verified** | per-package `package.json` scan |
| memory-server deps are `workspace:*` + private | **verified** | `members/memory-server/package.json:18-23` |
| CLI `main`/`bin` point outside package | **verified** | `apps/sox/package.json:6-9` |
| `resolveSource` gates CDN on `manifest.checksum` | **verified** | `build-index.ts:158-177` |
| memory-server builds via bare `tsc` (BL-38) | **verified** | `members/memory-server/project.json:17` |
| memory-daemon is bundled (BL-37 resolved) | **verified** | BACKLOG BL-37 + bundler aliases |
| `release.yml` rewrites registry post-publish | **verified** | `release.yml:74-90` |
| jsdelivr serves a single file w/o node_modules | **reasoned** *(unverified at runtime)* | jsdelivr is a file CDN, not an npm installer — needs the §9 container test to confirm the failure/fix |
| better-sqlite3 prebuilt binaries cover macOS+Linux arm64/x64 | **unverified** | must check `npm view better-sqlite3` prebuild matrix before Slice 3 |

---

## 5. Decisions (recommendations)

Each decision is summarised here with a recommendation; the full options table + consequences
live in [`DECISIONS.md`](./DECISIONS.md). The owner should confirm D-A and D-F before any publish.

### (a) D-A — Engine libs: publish-as-public-SDK vs bundle-and-keep-private

**Recommendation: HYBRID — publish a curated SDK subset as public packages; bundle the rest.**

The owner explicitly wants third-party reusability (G3), which *requires* publishing the libs a
third party would `import`. But not every lib is a stable public API, and exposing all 12 enlarges
the supply-chain + support surface. Split:

- **Public SDK (publish, `private:false` + `publishConfig.access=public`, semver-managed):**
  `@adhd/sox-install-engine`, `@adhd/sox-manifest`, `@adhd/sox-registry`, `@adhd/sox-host-runtime`,
  `@adhd/sox-authoring`, `@adhd/sox-mcp-runtime`. These are the "engine SDK" a third party builds
  on. Start them at **`0.x`** (unstable API; minor = breaking allowed) and document the public
  entry surface (`index.ts` exports only).
- **Internal (stay private, inlined by the bundler into extensions that need them):**
  `@adhd/sox-memory-core`, `@adhd/sox-memory-enrich`, `@adhd/sox-service-proxy`,
  `@adhd/sox-tokenguard-core`, `@adhd/sox-host-registry`. These are extension-implementation
  details, not a third-party SDK. Extensions that consume them ship as **self-contained esbuild
  bundles** (BL-37/38 standard) carrying **zero** `@adhd/sox-*` runtime deps.

**Why hybrid over "publish all" or "bundle all":** publish-all maximizes reuse but turns every
internal refactor into a public breaking change and bloats the attack surface; bundle-all keeps
everything private but **fails G3** (nothing to `npm i`). Hybrid serves G3 with a deliberately
small, documented API while keeping volatile internals private. **Consequence:** the SDK libs now
carry a *real* semver contract — see §5(e) for how that coexists with ADR-0003.

### (b) D-B — Native addon distribution (`better-sqlite3`, `sqlite-vec`)

**Recommendation: declare as real `dependencies` + publish the extension as an npm *package*
(tarball), installed via a new `npm-package` install mode; rely on upstream prebuilt binaries,
with source-build fallback.**

- The published `@adhd/sox-extension-memory-server` package declares `better-sqlite3` and
  `sqlite-vec` in `dependencies` (real semver ranges), keeps them `--external` in the esbuild
  bundle, and ships `files: ["dist"]`.
- A **new install mode** is required because the single-file CDN fetch (§3.1) cannot deliver
  transitive native deps. Options for that mode are in DECISIONS.md; recommended: fetch the npm
  **tarball** and run `npm install --omit=dev --no-audit` in the per-extension store so node-gyp
  /prebuild resolves a platform binary.
- **Prebuild matrix:** target macOS (arm64, x64) + Linux (arm64, x64) on Node 20/22. `better-sqlite3`
  ships prebuilds for these (verify `npm view better-sqlite3` before Slice 3 — flagged unverified
  in §4). `sqlite-vec` similarly. Source-build fallback requires a toolchain on the target (document
  as a risk, §10).

### (c) D-C — Bundle publish model: per-member vs single carrier

**Recommendation: per-member published packages; the `bundle` stays a declarative manifest.**

The `bundle` type is already declarative (`extensions/bundles/sox-memory-bundle/project.json` build
is a no-op echo; `extension.json` lists `members[].id`). Each member already has its own
`project.json`, build, package.json, and registry entry and installs independently. Keep that:

- **Public members** (`memory-server`, `memory-cli`, `memory-flush`) publish as individual npm
  packages (`@adhd/sox-extension-<id>`).
- **Private members** (`memory-daemon`, `memory-usage`) are **not** separately published — they are
  carried *inside* the bundle's install expansion. `memory-daemon` ships as a self-contained
  bundle artifact fetched by the same `npm-package`/CDN source as its sibling; `memory-usage` is a
  declarative skill (content, no npm package needed — its source can be a CDN/tarball path or
  inlined into the bundle manifest). **Open question §11-Q3** covers exactly how a private member's
  artifact is addressed when it has no public npm package.
- The bundle manifest itself publishes as a tiny package (or registry-only entry) that `soxe
  install sox-memory-bundle` expands to member installs.

**Why not a single carrier package:** one tarball carrying all five members would need new bundling
+ a member-extraction installer + would re-entangle independent member versioning. Per-member reuses
the existing independent-install machinery; the only new work is the private-member addressing
(Q3).

### (d) D-D — Registry portability: source rewrite vs published registry artifact

**Recommendation: rewrite sources to resolvable URLs at publish time (keep the registry in-repo),
defer a published-registry-artifact to a later phase.**

`build-index.ts` already knows how to emit CDN URLs (§3.2) — the work is to (1) set the publication
signal so it actually does, and (2) make the emitted URL a *package*/tarball reference (for native
deps) rather than only a single `dist/index.js`. `release.yml` already commits the rewritten
`registry/index.json` post-publish. For a fresh machine, the CLI ships a **bundled copy of the
registry** (or fetches it from the jsdelivr-served repo path / the published CLI package), so
`soxe search`/`install` works with no checkout. A standalone published `@adhd/sox-registry-index`
artifact is a *possible* later optimization (Q4) but not required for G1–G4.

### (e) D-E — Versioning/identity coexistence with ADR-0003

**Recommendation: two axes, never conflated. npm semver governs *inter-package dependency
resolution at install-from-npm time*; content-checksum governs *extension runtime identity +
integrity*. Neither reads the other.**

ADR-0003 says an *extension's* identity is `id + sha256(artifact)` and the extension's own
`version` is display-only. Publishing libs reintroduces semver — but **only for npm's package
graph** (so `npm i @adhd/sox-install-engine@^0.2` resolves), which is a *different concern* from
extension identity. Concretely:

- **SDK libs** (D-A) get real semver — this is npm dependency resolution, invisible to the
  extension-identity system.
- **Extensions** remain content-addressed: the registry `source` may be `npm:@adhd/sox-extension-…
  @1.2.3` (a *fetch locator*, version included for npm resolution) but the **integrity authority is
  still the checksum** the fetcher computes and compares (`install.ts:331-340`). The lockfile key
  stays bare `id` (ADR-0003 Decision 3); the version in the npm locator is bookkeeping that selects
  *which bytes to fetch*, after which the checksum is the gate. **An npm version bump with identical
  bytes is a no-op to identity; a byte change with the same version still trips CHECKSUM MISMATCH.**
- **No multi-build-per-id.** The registry still holds exactly one entry per id (ADR-0003); semver
  on the *fetch locator* does not create a resolution choice — build-index emits one locator per id.

This is the documented coexistence ADR-0003's "Note the tension" asks for; it warrants a short
**ADR-0005** ratifying "npm-semver-for-package-resolution vs checksum-for-extension-identity"
(§11-Q1).

### (f) D-F — CLI package shape

**Recommendation: publish `@adhd/sox-cli` as a self-contained esbuild bundle with an in-package
`bin`.**

The CLI core links **no native deps** (verified context; the native surface is memory-server's, not
the CLI's), so it can be a clean fully-self-contained bundle. Required changes (Slice 1):

- `private: false` + `publishConfig.access=public`.
- `bin: { "soxe": "./bin/soxe.mjs" }` where the shim lives **inside** the package and loads the
  in-package bundled `dist/main.cjs` (not `../../`). The current `../../bin/soxe` +
  `../../dist/...` are repo-relative and break standalone.
- `files: ["dist", "bin"]`, `engines: { "node": ">=20" }`, `main: "./dist/main.cjs"`.
- Build via `tools/bundle-extension.cjs` (or an nx target wrapping it) so all `@adhd/sox-*` engine
  libs are inlined → the published CLI has **zero** `@adhd/sox-*` runtime deps (works even before
  the SDK libs are published; G1 does not depend on D-A landing first).
- Ship a **bundled registry index** inside the package so `soxe search`/`install` works on a fresh
  machine with no checkout (D-D).

---

## 6. Target architecture (end state)

```
                         ┌─────────────────────────── CI (release.yml) ───────────────────────────┐
   author commits        │  changesets-action → "Version Packages" PR → on merge:                 │
   + changeset           │    1. pnpm release  (changeset publish)                                │
        │                │         ├─ publish SDK libs            → npm  @adhd/sox-install-engine… │
        ▼                │         ├─ publish CLI (bundled)       → npm  @adhd/sox-cli (bin: soxe) │
   ┌──────────┐          │         └─ publish extensions (bundled,│                                │
   │  GitHub  │──push────▶│             native deps declared)     → npm  @adhd/sox-extension-*     │
   └──────────┘          │    2. build-index  → registry/index.json sources = npm:/CDN + checksum │
                         │    3. commit registry/index.json back to main                          │
                         └────────────────────────────────────────────────────────────────────────┘
                                                      │ npm registry + jsdelivr CDN
  FRESH MACHINE (no checkout)                         ▼
  ┌──────────────────────────────────────────────────────────────────────────────────────────┐
  │ npm i -g @adhd/sox-cli         → soxe on PATH; bundled registry index inside the package   │
  │ soxe install sox-memory-bundle --scope user                                                │
  │     ├─ read registry (bundled or CDN-fetched)  → member sources are npm:/CDN, never file://│
  │     ├─ expand bundle → members [memory-server, memory-cli, memory-flush, +daemon,+usage]   │
  │     ├─ for native-dep members: npm-package install mode (tarball + npm install →           │
  │     │      better-sqlite3 prebuilt binary lands in the per-extension store)                │
  │     ├─ pure-JS members: single-file CDN fetch + checksum (existing path)                   │
  │     └─ verifyIntegrity: sha256(artifact) == registry checksum  (ADR-0003 gate, unchanged)  │
  │ memory-server spawns (stdio); createRequire finds the installed better-sqlite3             │
  │ memory_ping → { ok:true, id, artifact:"sha256:…", short }                                  │
  └──────────────────────────────────────────────────────────────────────────────────────────┘
       MCP config command → installed `soxe` (BL-65 repoint), NOT the dev checkout
```

**Key properties:**
- Identity/integrity unchanged (checksum gate). npm semver only selects *which bytes to fetch*.
- The dev checkout is no longer in any consumer or live-MCP path (BL-65 severed — §8).
- The same path serves the CLI, the memory bundle, and **any** future bundle (§7).

---

## 7. The "born-publishable bundle" golden path (G4)

The repeatable, templated flow so a NEW bundle/extension is publishable + installable identically.
This is the owner's second ask and the heart of the engagement. The flow touches four surfaces;
each must be templated, not hand-edited:

1. **`soxe init <type> <id>`** scaffolds a **born-publishable** package.json:
   `private` defaulting to `false` for public extension types, `publishConfig.access=public`,
   `files: ["dist"]`, `main: "dist/index.js"`, `@adhd/sox-extension-<id>` name, native deps (if the
   template declares any) as real `dependencies`, and `engines.node`. (Today `init` produces the
   `workspace:*` + `private` shape that 404s.)
2. **The bundle/extension build step** becomes a real self-contained build for code types: the
   `bundle` type's no-op echo (`project.json` build) is replaced by a generator step that, for each
   member, runs `tools/bundle-extension.cjs` (or an nx-target wrapper) → inlines `@adhd/sox-*`,
   externalizes declared native addons, emits `dist/index.js` + `package.json` sidecar. memory-server
   migrates off bare `tsc` onto this (closes BL-38).
3. **`build-index`** sets the publication signal so `resolveSource` emits the npm/CDN locator
   (close the §3.2 dormancy), recurses into `members/` (it already does; the *check-registry-sync*
   scanner must too — BL-33), and emits **package/tarball** locators (not only single `dist/index.js`)
   for native-dep extensions.
4. **Changesets**: `soxe init` (or a `soxe changeset` helper) drops a starter changeset naming the
   new package, so the very first publish is one command. A repo lint/gate asserts *every public
   extension has a non-`workspace:*` dependency shape* before merge (prevents the 404 class
   structurally).

**Acceptance for G4:** `soxe init bundle demo-bundle` → add a trivial member → `nx build` →
`registry:sync-index` → publish (CI) → on a fresh machine `soxe install demo-bundle` works, with
**zero** manual edits to package.json/registry/CI between init and install.

---

## 8. BL-65 live-dist cutover (how publishing severs the checkout)

Publishing is what finally unblocks BL-65's principled repoint. Sequence (orchestrator step — do
**not** casually rebuild the live serve path, per CLAUDE.md):

1. Publish the CLI + memory bundle (Slices 1+3) so an independently-installable `soxe` exists.
2. `npm i -g @adhd/sox-cli` (or `soxe install sox` to a content-addressed store under
   `~/.adhd/sox-ecosystem/...`).
3. **Repoint** `.mcp.json` / `~/.claude.json` `mcpServers.memory-server.command` from
   `/Users/nix/dev/ai/sox-ecosystem/bin/soxe` to the **installed** `soxe`. Extensions then resolve
   from npm, not `libs/*/dist`.
4. After repoint: a repo build never touches the running server; it updates only on explicit
   `soxe upgrade --all`. The BL-65 dirty-dist guard (`warnIfDistSha`) remains as defense-in-depth.

The spec MUST NOT propose a fragile dist-copy repoint (BL-65 warns it risks re-breaking live). The
repoint is a documented human/orchestrator step performed once after Slice 3 ships.

---

## 9. Acceptance & reality gates

**Canonical gate — fresh-machine container smoke (CI, the only gate that proves "publishable").**
A throwaway container with **no repo checkout** and a clean npm cache:

```bash
# G1 — CLI from npm
npm i -g @adhd/sox-cli
soxe --version            # exit 0, prints version
soxe search memory        # exit 0, lists sox-memory-bundle (registry resolved, no /Users path)

# G2 — bundle from npm, native dep, runtime green
soxe install sox-memory-bundle --scope user
#   expect: every member source npm:/https:, ZERO file:// ; better-sqlite3 installed
printf '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory_ping","arguments":{}}}\n' \
  | soxe exec memory-server      # → {"ok":true,"id":"memory-server","artifact":"sha256:…"}

# G3 — libs reusable by a third party
cd /tmp/thirdparty && npm init -y && npm i @adhd/sox-install-engine
node -e "const e=require('@adhd/sox-install-engine'); if(!e.fetchArtifact) process.exit(1)"

# G4 — born-publishable (run against a scaffolded throwaway bundle published to a test scope)
soxe install demo-bundle --scope user && echo OK
```

**Gate assertions:** all commands exit 0; `registry/index.json` (as resolved on the fresh machine)
contains **0** `file://` sources; `memory_ping.ok == true`; no path under `/Users/` appears in any
resolved source or MCP command.

**Per-slice gates** are in §10's slice table. Repo-wide gate for every slice:
`npx nx run-many -t build,lint,test` green + (on any `dist` touch) `npx nx run registry:sync-index`
clean + `host-runtime:test-e2e` (orphan-free).

> Per CLAUDE.md: a green `nx test` against a stale `dist` is **not** acceptance (BL-4). The
> container gate runs against **published artifacts**, not the local build — that is what makes it
> authoritative.

---

## 10. Phased implementation slices

Ordered; each is self-contained with entry/exit criteria. Dependencies noted. Slices 1 and 2 are
independent and can parallelize; 3 depends on the native-dep + install-mode work; 4 depends on
1+3 patterns; 5 gates everything.

| Slice | Title | Depends on | Entry criteria | Exit criteria / gate |
|---|---|---|---|---|
| **S1** | **Publish the CLI** (clean, no native) | — | CLI core confirmed native-free | `@adhd/sox-cli` published; in-package `bin`/`dist`/`files`/`engines`; bundled registry; **G1 container check green** |
| **S2** | **Lib publish / SDK** (D-A hybrid) | — | SDK subset agreed (owner D-A) | 6 SDK libs `private:false`+`access:public`, `0.x`, documented export surface; internal libs stay private+bundled; **G3 check green**; ADR-0005 written |
| **S3** | **Extension/bundle distribution + native deps + registry rewrite** | S1 (CLI to drive install); native-dep mode | better-sqlite3 prebuild matrix verified | memory-server migrated off bare `tsc` to bundle (closes BL-38); native deps declared; `npm-package` install mode added to fetcher; `build-index` sets publication signal + emits npm/CDN locators; `check-registry-sync` recurses members (BL-33); **G2 container check green**; BL-65 repoint documented + executed |
| **S4** | **Born-publishable golden path + new-bundle template** | S1+S3 patterns | S3 publish shape proven | `soxe init` scaffolds born-publishable pkg; bundle build no-op replaced with real generator; first-publish changeset auto-dropped; lint gate forbids `workspace:*` in public extensions; **G4 check green** |
| **S5** | **Fresh-machine container acceptance in CI** | S1–S4 | all prior gates green | the §9 container smoke runs in CI on every release; documented as the canonical gate; BL-42/BL-43 closed |

**Pre-S3 spike (blocking S3):** verify `better-sqlite3` + `sqlite-vec` prebuilt-binary coverage for
{macOS,Linux}×{arm64,x64}×Node{20,22} via `npm view` — if a cell is missing, the source-build
fallback risk (§11) must be accepted or a prebuild added.

---

## 11. Risks & mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Native prebuild gap** — a target platform lacks a `better-sqlite3`/`sqlite-vec` prebuild → install needs a C toolchain (node-gyp), which a minimal container/user may not have. | Pre-S3 matrix spike (§10); pin a `better-sqlite3` version with full prebuild coverage; document toolchain requirement; consider shipping `@adhd`-hosted prebuilds as fallback. |
| R2 | **Single-file fetch ≠ npm install** — the existing CDN path cannot deliver transitive native deps; naive reuse would ship a memory-server that can't `require('better-sqlite3')` on a fresh box. | The `npm-package` install mode (S3) is mandatory for native-dep extensions; the §9 G2 gate catches a regression at runtime, not just at fetch. |
| R3 | **Supply-chain surface of public libs** — publishing 6 SDK libs publicly enlarges the attack/typosquat surface and ties refactors to public breaking changes. | Hybrid (D-A) keeps the public set minimal + `0.x`; enable npm 2FA/provenance (`id-token: write` already in release.yml); document the public API boundary; internal libs stay private. |
| R4 | **Version skew / diamond deps** — third parties pinning different SDK lib versions; `updateInternalDependencies: patch` may under/over-bump. | `0.x` + clear "minor=breaking" policy; changesets `fixed`/`linked` groups for libs that must move together; CI installs the published set fresh to detect skew. |
| R5 | **BL-65 live-dist cutover** — repointing the live MCP while sessions are connected can break memory for all agents (already happened). | §8 documented orchestrator step (publish → install → repoint), one final reconnect (BL-61); never a dist-copy repoint; dirty-dist guard stays. |
| R6 | **npm scope/2FA/automation token** — a wrong/expired `NPM_TOKEN`, or 2FA blocking CI, stalls publish. | Automation token (bypasses OTP) as `NPM_TOKEN` secret; document scope membership check (`npm whoami`); dry-run `changeset publish --dry-run` (or `npm publish --dry-run`) before first real publish. |
| R7 | **First-release changelog noise** — stale `sox-memory-p0/p5` changesets mis-bump memory-server (BL-43 #4). | Consolidate into one coherent first-release changeset before the first publish (S3 entry task). |
| R8 | **ADR-0003 regression** — semver-on-fetch-locator could tempt a multi-build-per-id resolution. | §5(e) + ADR-0005: locator-version selects bytes, checksum is identity; build-index still emits exactly one entry per id; add a test asserting one-entry-per-id post-rewrite. |

---

## 12. Open questions (owner decisions)

- **Q1 — Ratify coexistence as ADR-0005?** §5(e) (npm-semver-for-resolution vs
  checksum-for-identity) should be a formal ADR so the tension ADR-0003 flagged is closed in the
  record. *Recommend: yes.*
- **Q2 — SDK public-API surface.** Which exact exports of the 6 SDK libs are the *supported* public
  API (vs incidental exports)? Needs an owner pass to avoid accidentally committing to internals.
- **Q3 — Private bundle-member addressing.** `memory-daemon` (private, not separately published) and
  `memory-usage` (declarative skill) need a *fetchable* source on a fresh machine. Options: (a)
  publish them too (drop `private`); (b) carry their artifacts *inside* the bundle's published
  package; (c) inline `memory-usage` content into the bundle manifest. *Recommend (b) for daemon,
  (c) for usage — owner confirm.*
- **Q4 — Published registry artifact?** D-D defers a standalone `@adhd/sox-registry-index` package
  in favor of a CLI-bundled index. Confirm that's acceptable, or prioritize a published/queryable
  registry now (needed if non-CLI consumers must discover extensions).
- **Q5 — Windows support timing.** Native prebuild matrix excludes Windows (§2). Confirm Windows is
  a follow-on, not a launch requirement.
- **Q6 — `engines.node` floor.** Recommend `>=20` (CI uses Node 20; bundler targets `node18`).
  Confirm the minimum supported Node.

---

## Appendix A — Backlog cross-reference

| Backlog | This spec resolves via |
|---|---|
| **BL-42** (checkout-bound) | The whole spec; closed by S5. |
| **BL-43** (publish-strategy decisions) | §5 (D-A…D-F) + DECISIONS.md; closed by S2+S3. |
| **BL-65** (dev dist IS live MCP) | §8 cutover; principled repoint unblocked after S3. |
| **BL-38** (memory-server bare-`tsc` requires) | S3 migrates memory-server to the self-contained bundle. |
| **BL-33** (check-registry-sync skips members) | S3 (scanner recurses `members/`). |
| **BL-34** (sox entrypoint not index-resolvable) | S1 (in-package `main`/`dist` makes it resolvable). |
| **BL-37** (daemon bundle) | Already resolved; the standard S3/S4 generalize. |
