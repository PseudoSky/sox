# Strategy & Migration Plan — Nx + self-hosting

**Status:** planned (pre-execution). Captures the full strategy so context isn't lost.
**Decision record:** `docs/decisions/0001-nx-and-self-hosting.md` (the *why/what*). This doc is the *how* + context.
**Requirements:** `DOD.md` (the bar). **Current status:** `CLAUDE.md`.

---

## 1. Why we're doing this

The ecosystem accreted into an **all-custom build** with no decision record — a hand-rolled, drift-prone
scaffolder, no shared-library primitive, cross-extension `../../../dist` reach-in, and an uncached
`tsc`-per-package build. The target was always: **rapidly add many extensions of every type, with shared
code, at scale.** That target is nx's sweet spot. We adopt nx for the *undifferentiated* monorepo layer
and keep the *novel* layer custom.

- **Custom (the product):** manifest contract + `validate`, multi-scope install/cascade, host runtime
  (loader/supervisor/registrar/event-bus), registry-as-protocol, the `sox` CLI.
- **Nx (undifferentiated infra):** project types (incl. `library`), generators, affected + cache,
  module-boundary enforcement, release.
- **Invariant:** **nx is dev-time only — never a consumer/runtime dependency.** Consumers get published
  packages + the `sox` CLI; `sox init`'s scaffolding core is nx-free so the product stands alone.

## 2. Decisions (D1–D5)

| # | Decision |
|---|---|
| D1 | **Literal self-hosting** — `sox` is a real conformant **extension #0** (own manifest, own validator, same pipeline). |
| D2 | **`sox` type = `command`** (description broadened to "a CLI program with an entrypoint — root or subcommand"); no `host` type. |
| D3 | **`nx release`** replaces Changesets (graph-aware bumps; lose per-PR changeset file + status gate → conventional commits + commitlint). |
| D4 | **Delete the 6 demos**; generators are **input-driven per type**; conformance-gate fixtures = generated outputs. |
| D5 | **Migration scope** = make A1, A12, B1–B4, C7 pass + no regressions; **C6 + memory-depth out** (separate). |

## 3. Architecture

### Authoring = lib-core ← generator-adapter ← nx-meta-generators
- `libs/authoring` — **pure** `scaffold(opts) → FileSet` (no `@nx/devkit` dep) + templates. Single source of truth for "what a conformant extension of type X is."
- `sox init` — writes the FileSet to disk (works **without nx**).
- `@sox/nx:extension` / `:library` — thin devkit adapters: map FileSet → nx `Tree`, add tags + graph wiring.
- nx meta-generators (`@nx/plugin:plugin`, `@nx/plugin:generator`, `@nx/js:lib`) bootstrap the plugin, generators, and libs.
- **Parity guard:** a test asserts `sox init` and `@sox/nx:extension` emit byte-identical output → the two paths can't drift.

### bundle vs registry vs nx (don't conflate)
- **`bundle`** = runtime/consumer primitive: `sox install <bundle>` expands to members at the consumer's machine. Stays.
- **registry** = the data plane: bundle composition + all installable entries live here; `sox` ships the **install engine** that *reads* the registry, not the data. Keeps `sox` generic.
- **nx release group** = dev-time version coherence for a bundle's members. Complements bundle; doesn't replace it.

### Cardinality
High-cardinality types namespaced (`extensions/agents/<ns>/<id>`, `skills/<ns>/<id>`); low-cardinality flat
(`commands/<id>`, `mcp-servers/<id>`). Tags `type:<t>` + `ns:<n>` keep scale tractable.

### Target layout
```
sox-ecosystem/
├── nx.json · tsconfig.base.json · pnpm-workspace.yaml
├── apps/sox/                        # extension #0 (type command); entrypoint = CLI
├── libs/
│   ├── manifest/                    # schema + validate (+ contract flexes §4)
│   ├── install-engine/ · registry/ · host-runtime/
│   ├── authoring/                   # scaffold()→FileSet core + templates
│   └── memory-core/                 # extracted from memory-server (the C7 lib)
├── extensions/
│   ├── agents/<ns>/<id>/ · skills/<ns>/<id>/      # high-cardinality, namespaced
│   ├── mcp-servers/<id>/ · commands/<id>/ · hooks/<id>/ · bundles/<id>/
├── packages/sox-nx/                 # @sox/nx plugin: generators + executors + files/<type>/
├── schemas/ · registry/ · assets/ · docs/
```

## 4. Contract adjustments (the real corpus forces these)

Inferred from the example sources; confirmed in per-type discovery (§5):
- **`entrypoint` optional/typed** — markdown agent → its `.md`; shell hook → the script; bundle/prompt → none.
- **`runtime` ∈ {node, shell, python, declarative}** — not node-only.
- **install-target / host-discovery placement** — declarative extensions declare *where they install to*
  (`~/.claude/commands/`, `~/.claude/agents/`, skills dir). `sox install` = render/link into the host's
  discovery location. **This is the generalized reinjection primitive** for prompt + markdown agents + skills.

## 5. Per-type generators + real example sources

Generators take the type's **relevant inputs** and scaffold around them (populating self-description):

| type | generator inputs | real example source (explore in discovery — large, deferred) |
|---|---|---|
| hook | event(s); runtime (shell/node) | `~/dev/ai/claude-agents/tools/hooks/{swarm-cost,agent-tool-logger.sh,budget-gate.sh}` |
| mcp-server | tools[] + input schemas | `~/dev/node/adhd/packages/ai/agent-mcp` (production) |
| command | verb + args; runtime (python/node) | `~/dev/ai/sox-protocol/packages/python`, `~/dev/ai/claude-agents/tools/cli` |
| skill | I/O + (likely) markdown body | `~/dev/ai/claude-agents/categories/workflow/skills/` |
| agent | invocation/handler + (likely) markdown def | `~/dev/ai/claude-agents/categories/00-active/agents/` |
| prompt | params + template + install-target | **parked** — no example, no current use |

Approach: design each generator's input-schema from the contract **now**; a **discovery step per type**
refines templates + confirms the §4 flexes against the real corpus (these repos are large — explored
during the plan, not before).

## 6. Phased migration plan

Each phase: goal → key outputs → **acceptance** (verified, not self-reported).

- **P0 — Checkpoint.** Commit/tag the current (fixed) state — *everything this session is uncommitted, incl. the recall/fireIsolated/enable/stop/registry/typecheck fixes.* Work on a branch. → *Acc: clean baseline tagged; branch created.*
- **P1 — gitnexus setup.** → *Acc: history-preserving move/refactor available.*
- **P2 — nx init + configure.** target defaults, named inputs, cache, **tags/boundaries**, release config. → *Acc: `nx run-many -t build` works on the (pre-migration) tree; boundary lint active.*
- **P3 — `libs/manifest`** (schema + validate) **incl. the §4 contract flexes** (entrypoint-optional, runtime breadth, install-target). Prereq for "conformant." → *Acc: validate runs as an nx target; flexes covered by tests.*
- **P4 — `libs/authoring` + `@sox/nx` generators + `sox init` + born-conformance gate.** Pure FileSet core; thin adapters; **parity test** (`sox init`==generator). → *Acc: scaffold every type → build → validate green; parity test passes.*
- **P5 — Port engine libs** (`install-engine`, `host-runtime`, `registry`) — **carry this session's fixes forward**; **fix the flag parser (A12)** + `exec` routing while re-homing the CLI. → *Acc: lifecycle e2e green via documented flag forms; zero orphans (reality-checked).*
- **P6 — Generate `sox`** (extension #0) wiring authoring + manifest + install-engine + host-runtime. → *Acc: `sox` validates as a conformant extension; CLI works.*
- **P7 — Per-type discovery** against the §5 sources → refine generators + confirm §4 flexes. *(The large-repo exploration happens here.)* → *Acc: each type's generator produces output matching a real example shape.*
- **P8 — Generate memory** (4 extensions + bundle + `libs/memory-core`); gitnexus-port logic; re-point deps to `memory-core` → **kills the reach-in** (now a boundary-lint pass). → *Acc: memory write+recall green; no cross-extension `dist` imports; boundary lint clean.*
- **P9 — CI + release + tests.** CI → `nx affected`; `nx release` + commitlint; re-home 380 tests + **process-table reality-gates** as nx targets (scaffolder tests *replaced* by the conformance gate, not moved); **per-type purpose docs**. → *Acc: `nx affected -t build,lint,test` green; release dry-run works.*
- **P10 — Acceptance.** Verify the **D5 scope from a clean slate**: every type `init→build→validate→install→run`; lifecycle zero-orphans; **documented flag forms**. → *Acc: A1, A12, B1–B4, C7 pass; nothing previously green regressed.*

## 7. Acceptance / DoD mapping

This migration **makes pass:** A1, A12, B1, B2, B3, B4, C7. **Holds green:** A2–A10, C1, C2, C3, C5.
**Out of scope (stay unchecked):** C6 (runtime permission enforcement), memory semantic depth (embeddings/LLM organizer).
"Done" = verified against reality (process table, real artifacts, documented flag forms) from a clean slate.

## 8. Risks

- **Porting regresses the session's fixes** — P0 checkpoint + "carry fixes forward, don't re-grab pre-fix code" in P5/P8.
- **Bootstrap ordering** — manifest (P3) before authoring (P4); engine libs (P5) before wiring `sox` (P6). Generate shells → port logic → wire last.
- **Contract flexes turn out deeper than inferred** — P7 discovery may force more `libs/manifest` change; sequence P3 to expect revision.
- **Large-repo discovery scope creep** — P7 is bounded to "shape per type," not full ingestion (ingestion is out of scope entirely).
- **Reality-gate erosion in translation** — P9 must preserve the process-table checks, not just move test files.

## 9. Explicitly out of scope
Ingestion / normalization / reinjection of external extensions (your workflow, done outside the tool —
though §4's install-target *is* the placement primitive it would build on); memory semantic quality.
