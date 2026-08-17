# Public API stability tiers (`@adhd/sox-*`)

> Releasing one of these packages: see [release-flow.md](./release-flow.md) — enumerate
> consumers, bump exact pins, test consumers in isolation, verify running processes.

Companion to [ADR-0005](../decisions/0005-npm-publishing-and-content-address-coexistence.md) and the
publishing refactor. Per owner decision **Q2**, all 12 `@adhd/sox-*` libs publish publicly, but they
do **not** carry the same stability promise. This page is the supported-surface contract a third
party should read before depending on a lib.

> **Versioning policy for `0.x` packages:** while a package is `0.x`, a **minor** bump (`0.x.0`) MAY
> contain breaking changes; a **patch** (`0.x.y`) is non-breaking. Pin accordingly
> (`@adhd/sox-install-engine@~0.1`). A package reaches `1.x` only when its export surface is declared
> stable here.

## Tier 1 — Stable authoring contract

These are the surface a third party builds *authoring tooling* on. Breaking changes are avoided and,
when unavoidable, are a major bump.

| Package | Supported surface | Notes |
|---|---|---|
| `@adhd/sox-manifest` | extension.json schema types + validators (`index.ts` exports) | The manifest is the cross-tool contract; treat as stable. |
| `@adhd/sox-authoring` | `scaffold()` + template option types (`ScaffoldOpts`, `ActiveType`) | The born-publishable golden path (`soxe init`) runs through here. |

## Tier 2 — Engine SDK (`0.x`, semver-managed, may break on minor)

The "engine SDK" a third party can build a host/installer on. Real semver, but **unstable** — the
export surface may change on a minor while `0.x`.

| Package | Supported surface |
|---|---|
| `@adhd/sox-install-engine` | `install`, `fetchArtifact`, `loadRegistryIndex`, `resolveFromRegistry`, `verifyIntegrity`, lockfile/cascade types |
| `@adhd/sox-registry` | registry index types + helpers |
| `@adhd/sox-host-runtime` | supervisor / runtime entry points (`index.ts` exports) |
| `@adhd/sox-mcp-runtime` | MCP serve/tool-dispatch helpers |

## Tier 3 — Internal, published for completeness (`0.x`, NO stability promise)

Published so the dependency graph resolves and the "publish it all" directive is honored, but these
are **implementation details**. Do not pin third-party code to them; they will churn without notice.

| Package | Why it's internal |
|---|---|
| `@adhd/sox-memory-core` | sox-memory store internals (db/schema/embed/recall); volatile |
| `@adhd/sox-memory-enrich` | deterministic enrichment internals; volatile |
| `@adhd/sox-service-proxy` | front-shim/backend lifecycle internals |
| `@adhd/sox-tokenguard-core` | token mapping internals |
| `@adhd/sox-host-registry` | host path/target resolution internals |

## CLI

| Package | Surface |
|---|---|
| `@adhd/sox-cli` | the `soxe` binary (CLI command surface). Self-contained bundle; carries **zero** `@adhd/sox-*` runtime deps. Not an importable API. |

## Extensions

`@adhd/sox-extension-*` packages are **runtime artifacts** (self-contained esbuild bundles), not
importable libraries. Their identity is the content checksum (ADR-0003), not their npm version. Do
not `import` from them; install them via `soxe install`.

## How to consume a Tier 2 lib (G3)

```bash
npm i @adhd/sox-install-engine
```
```js
const { fetchArtifact, loadRegistryIndex } = require('@adhd/sox-install-engine');
```
Types ship in the package (`exports["."].types`). Because these are `0.x`, pin with `~` and read the
CHANGELOG before bumping the minor.
