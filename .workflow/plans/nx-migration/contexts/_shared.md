# Shared context — Nx + self-hosting migration

> **Single source of truth for definitions.** Every work-state context references
> entries here by name instead of restating them. Change a definition once, here.

---

## Glossary

Reference as **[def:term]** from any context file.

- **[def:root]** — `$ROOT=/Users/nix/dev/ai/sox-ecosystem`. `pnpm` is on PATH or
  at `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`.
- **[def:active-types]** — the 6 active extension types: `agent`, `skill`,
  `mcp-server`, `hook`, `command`, `bundle`. `prompt` is **parked** (no generator,
  no template) until a real text-dedup use case appears.
- **[def:engine-libs]** — `libs/install-engine` (install/cascade/build-index/
  lockfile/`parseArgs`), `libs/host-runtime` (loader/supervisor/registrar/
  event-bus), `libs/registry` (drift gate/index/checksum).
- **[def:memory-extensions]** — the 4 memory extensions
  (`extensions/mcp-servers/memory-server`, `extensions/agents/memory-organizer`,
  `extensions/hooks/memory-flush`, `extensions/commands/memory-cli`) plus
  `extensions/bundles/sox-memory-bundle`.
- **[def:session-fixes]** — the uncommitted fixes that must survive the migration:
  `memory_recall` alias bug, `fireIsolated` on the event bus, enable-reactivation,
  stop-via-supervisor, registry drift gate, the typecheck fix.
- **[def:reality-check]** — "done" is verified against **reality** (OS process
  table via `pgrep`, real built artifacts on disk, the documented `--help` flag
  forms) from a clean slate — never self-reported test output (DOD.md
  Verification rule).
- **[def:install-target]** — optional manifest field on declarative extensions
  declaring where the artifact installs (e.g. `~/.claude/commands/`,
  `~/.claude/agents/`, the skills dir) — the generalized reinjection primitive.

---

## Cross-cutting invariants

Contracts every state must preserve throughout the migration.

- **[inv:nx-dev-only]** — Nx (`nx`, `@nx/*`) is a **dev-time only** dependency:
  it appears only under root `devDependencies`, never under any extension's or
  lib's `dependencies`. Verified by `[ref:nx-never-runtime-dep]`.
- **[inv:nx-free-core]** — `libs/authoring`'s `scaffold(opts) → FileSet` core
  imports **no** `@nx/devkit` or `@nx/*` package, so `soxe init` works without nx
  installed. Verified by `[ref:nx-free-authoring-core]`.
- **[inv:scaffold-parity]** — `soxe init <type> <id>` and
  `@adhd/sox-nx:extension <type> <id>` emit **byte-identical** output from the same
  `scaffold()` core. Verified by `[ref:scaffold-parity]`.
- **[inv:fix-carry-forward]** — after `checkpoint-branch`, all work happens on
  `feat/nx-migration`. Later states **port** [def:session-fixes] forward; they
  **never re-grab pre-fix code** from before the `pre-nx-baseline` tag.
- **[inv:manifest-source]** — `libs/manifest` is the only place `validate()` and
  the schema live; `scripts/validate-manifests.ts` becomes a thin wrapper that
  imports it. Verified by `[ref:manifest-single-source]`.
- **[inv:ordering]** — `manifest-lib` before `authoring-lib`; [def:engine-libs]
  before wiring `sox-extension`; generate shells → port logic → wire/verify last.
- **[inv:capture-exit]** — acceptance checks capture `$?` directly into a
  variable; **never pipe** a command whose exit code is being tested.
- **[inv:no-orphans]** — after any lifecycle teardown (`stop`/`uninstall`), the
  OS process table has **zero** orphan `sox-ecosystem` processes ([def:reality-check]).

---

## Shared fixtures and sample data

- **[fix:probe-extension]** — a freshly scaffolded extension written to a
  `.tmp-*` directory under [def:root], validated against `libs/manifest`, then
  removed. The audit uses one probe per [def:active-types].
- **[fix:validate-suite]** — the existing `scripts/validate-manifests.test.ts`
  conformance suite (44 tests). It is the regression bar for `[ref:manifest-single-source]`.

---

## Contract flexes (encoded in libs/manifest)

```text
[shape:manifest-flexes]
  entrypoint:      optional, typed by runtime
                   (markdown agent → .md; shell hook → script; bundle/prompt → none)
  runtime:         "node" | "shell" | "python" | "declarative"
  install-target:  optional string (declarative types) — see [def:install-target]
```

---

## Reference-pattern fallbacks ([ref:] inline definitions)

These idioms are catalogued in `references.json` (`discovered_via: "manual"`).
The full prose lives here; states cite `[ref:<slug>]`; the final audit verifies
each once.

- **[ref:nx-free-authoring-core]** — anchor `libs/authoring/src/index.ts:scaffold`.
  Rule: `libs/authoring/src/**/*.ts` contains zero imports of `@nx/devkit` or any
  `@nx/*` package. The scaffold core is pure TypeScript so `soxe init` runs without
  nx. Audit: `[audit-final.ref-nx-free-authoring-core]`.
- **[ref:scaffold-parity]** — anchor
  `packages/sox-nx/src/generators/extension/extension.spec.ts`. Rule: a passing
  test asserts `scaffold()` (the `soxe init` path) and `@adhd/sox-nx:extension` produce
  byte-identical FileSet output for identical inputs. Audit:
  `[audit-final.ref-scaffold-parity]`.
- **[ref:nx-never-runtime-dep]** — anchor `package.json`. Rule: no extension or
  lib `package.json` lists `nx`/`@nx/*` under `dependencies`; nx is only a root
  devDependency. Audit: `[audit-final.ref-nx-never-runtime-dep]`.
- **[ref:manifest-single-source]** — anchor `libs/manifest/src/index.ts:validate`.
  Rule: `validate()` + schema live only in `libs/manifest`;
  `scripts/validate-manifests.ts` imports it instead of re-implementing. Audit:
  `[audit-final.ref-manifest-single-source]`.
- **[ref:no-cross-extension-reachin]** — anchor
  `extensions/mcp-servers/memory-server/src/recall.ts`. Rule: no file under
  `extensions/` imports another extension's built output via a relative
  `../**/dist/` path; shared code is imported from a `libs/*` internal library and
  `@nx/enforce-module-boundaries` forbids extension→extension edges. Audit:
  `[audit-final.ref-no-cross-extension-reachin]`.
- **[ref:dual-flag-form]** — anchor `libs/install-engine/src/index.ts:parseArgs`.
  Rule: the parser accepts both `--flag value` and `--flag=value` for every flag,
  matching `--help` (A12). Audit: `[audit-final.ref-dual-flag-form]`.
- **[ref:self-hosted-extension-zero]** — anchor `apps/sox/extension.json`. Rule:
  `apps/sox` ships an `extension.json` with `type: "command"` that validates
  against `libs/manifest` — `sox` is a literal conformant extension #0 (D1/D2).
  Audit: `[audit-final.ref-self-hosted-extension-zero]`.
