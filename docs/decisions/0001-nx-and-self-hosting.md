# ADR-0001 — Adopt Nx for the infrastructure layer; self-host `sox` as extension #0

**Status:** Accepted (2026-06-11). Supersedes the implicit "all-custom build" that accreted with no decision record.
**Requirements it serves:** `DOD.md` A1, B1–B4, C1–C4, C7. (The DoD states *what*; this ADR states *how*.)

## Context
- Target: rapidly add **many** extensions of **every** type, **with shared internal code**.
- The custom path reimplements undifferentiated monorepo infrastructure poorly: a drift-prone string-template scaffolder, no shared-library primitive, cross-extension `../../../dist` reach-in, and a non-cached `tsc`-per-package build.
- Nx provides exactly that layer — project types (incl. **library**), **generators**, **affected + cache**, and **module-boundary** enforcement. The product's novel layer is unaffected.

## Decision
1. **Adopt Nx** for the monorepo / build / dependency-graph / generator layer. Keep the **novel layer custom** on top: manifest schema + `validate`, multi-scope install/cascade, host runtime (loader/supervisor/registrar/event-bus), registry, and the `sox` CLI. Nx does not touch those.
2. **Self-host:** `sox` is **extension #0** — a conformant extension whose `entrypoint` *is* the CLI; its capabilities are libs it depends on. If `sox` can't be expressed as a conformant extension, the contract is wrong.
3. **Authoring = lib-core + adapters.** Scaffolding logic + templates live in `libs/authoring` as a **pure** `scaffold(opts) → FileSet` (no `@nx/devkit` dependency). Two thin adapters consume it:
   - `sox init` (writes the FileSet to disk) — so the product scaffolds **without nx installed**.
   - `@sox/nx:extension` / `:library` (maps the FileSet onto the nx `Tree`, adds tags + graph wiring).
   The nx **meta-generators** (`@nx/plugin:plugin`, `@nx/plugin:generator`, `@nx/js:lib`) bootstrap the plugin, the generators, and the libs.
4. **Module boundaries via tags** (`type:extension`, `type:lib`) enforced by `@nx/enforce-module-boundaries`: extensions may depend on libs, never on each other → the reach-in becomes a lint error.

## Resolved decisions (D1–D5)
- **D1 — Self-hosting is *literal*.** `sox` is a real conformant **extension #0**: own manifest, validated by its own validator, same build/release pipeline. If it can't be expressed conformantly, the contract is wrong.
- **D2 — `sox` type = `command`** (no new `host` type). Broaden the `command` description to *"a CLI program with an entrypoint — the root CLI or a subcommand."* Host/bootstrap is a runtime role, not a contract type (failed the YAGNI test — no validation rule a `host` type would add).
- **D3 — Releases = `nx release`** (retire Changesets). **Lost:** per-PR changeset intent file + `changeset status` gate → replaced by conventional commits + commitlint. **Gained:** graph-aware dependent bumps (change `memory-core` → all 4 memory extensions bump). Mechanical changelogs instead of curated-at-PR-time.
- **D4 — Demos deleted.** Generators are **input-driven per type** — they scaffold *around* the type's relevant inputs (mcp tools, hook events, command verb, agent invocation, skill I/O, prompt params), populating self-description at generation time. The born-conformance gate's fixtures = the freshly-generated one-per-type outputs.
- **D5 — Migration scope.** Accountable for **A1, A12, B1–B4, C7 + no regressions** to anything currently green. **Explicitly out:** C6 (runtime permission enforcement) and memory semantic depth — real DoD items, tracked separately, stay unchecked. *(Adopted recommendation; flag if C6 should be pulled in.)*

## Contract adjustments expected (confirm in per-type discovery)
The real corpus is multi-runtime and largely declarative, so the manifest contract must flex — inferred now from the example sources, confirmed during discovery:
- **`entrypoint` optional/typed** — a markdown agent's "entrypoint" is its `.md`, a shell hook's is the script, a bundle/prompt has none. Drop the "all behavioral types compile to `dist/index.js`" assumption.
- **`runtime` broadened** — `node | shell | python | declarative` (markdown), not node-only.
- **install-target / host-discovery placement** — a declarative extension declares **where it installs to** (e.g. `~/.claude/commands/`, `~/.claude/agents/`, the skills dir). `sox install` = render/link the artifact into the target host's discovery location. **This is the generalized reinjection primitive** for the declarative family (prompt + markdown agents + skills), not a prompt-only detail.

## Cardinality & docs
- **Layout scales by cardinality:** high-cardinality types support intra-type namespacing — `extensions/agents/<ns>/<id>`, `extensions/skills/<ns>/<id>` (mirrors `categories/<cat>/…`); low-cardinality stay flat (`extensions/commands/<id>`, `mcp-servers/<id>`). Tags `type:<t>` + `ns:<n>` keep boundaries/affected/release tractable at hundreds of projects.
- **Each type gets a "purpose & when-to-use & install-target" doc** (not just the Layer-4 conformance table) — the gap that left `prompt`'s use case undiscoverable.
- **`prompt` is parked** (no generator) until a real text-dedup use case appears.

## Layout mapping (current → nx)
| Current | nx |
|---|---|
| `extensions/<type>/<id>/` (pnpm pkg) | project, **publishable library** (same path ok) |
| shared code in `memory-server/src` (db/schema/embed/recall/write) | `libs/memory-core` (**internal library** = C7) |
| `scripts/` engine (install/cascade/validate/build-index) | `libs/{manifest, install-engine, registry}` |
| `scripts/host/*` | `libs/host-runtime` |
| `bin/sox` + CLI | **`apps/sox`** (extension #0; entrypoint = CLI) |
| `scripts/new-extension.ts` (hand-rolled) | `libs/authoring` (core) + `@sox/nx` generators (adapters) |
| `pnpm -r build` + per-pkg tsconfig | `nx run-many -t build` (`@nx/js:tsc`, dep-aware, cached) |
| `validate-manifests`, `build-index` | nx **targets**, run on **affected** |
| cross-pkg `../../../dist` reach-in | forbidden by module-boundary lint |

## Where templates live
`packages/sox-nx/` (publishable `@sox/nx` plugin): `src/generators/{extension,library}/` with `schema.json`, `generator.ts` (thin — calls `libs/authoring`), and `files/<type>/…` templates. `libs/authoring` is the single source of truth for templates + conformance; the generator and `sox init` both delegate to it.

## The reflexive boundary (keep it honest)
core **lib** (nx-free) ← **generator** adapter (nx) ← nx **meta-generators**. A test asserts **`sox init` and `@sox/nx:extension` emit byte-identical output** (same `scaffold()` core) so the two paths cannot drift.

## What stays custom (nx does not provide)
Manifest contract + `validate`; multi-scope install/cascade; host runtime; registry; the `sox` CLI/host semantics.

## Consequences — migration order (corrected sequence)
0. **Checkpoint** the current state — all of this session's fixes are uncommitted (recall alias, `fireIsolated`, enable-reactivation, stop-via-supervisor, registry drift gate, typecheck). Commit/tag first.
1. gitnexus setup.
2. `nx init` + configure: target defaults, named inputs, **tags/boundaries**, cache, release.
3. Establish **`libs/manifest`** (schema + `validate`) — prerequisite for "conformant" and for the gate.
4. Generate + implement **`libs/authoring`** (+ `@sox/nx` generators); add the **born-conformance gate** (per-type `scaffold → build → validate`; `sox init`==generator parity).
5. Port **engine libs** (`install-engine`, `host-runtime`, `registry`) — carrying this session's **fixes forward** and fixing the **flag parser (A12)** + `exec` routing while re-homing the CLI.
6. Generate **`sox`** (extension #0) wiring `authoring + manifest + install-engine + host-runtime`.
7. Generate memory's **4 extensions + bundle + `libs/memory-core`**; gitnexus-port the logic in; re-point deps to `memory-core` (kills reach-in).
8. CI → `nx affected`; **decide nx release vs changesets**; re-home tests + **reality-gates** (process-table checks) as nx targets.
9. **Acceptance:** verify the full DoD from a **clean slate** — every type `init→build→validate→install→run`, lifecycle with **zero orphans**, using the **documented flag forms**.

## Out of scope
Ingestion / normalization / reinjection of external extensions; memory semantic quality (embeddings, LLM enrichment).
