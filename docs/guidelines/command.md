# Extension Framework Contracts — `command`

> **Status of this document:** instance of the shared per-extension-type contract document.
> The ecosystem has seven types (`agent`, `skill`, `mcp-server`, `prompt`, `hook`, `command`,
> `bundle`). Each gets its own `docs/guidelines/<type>.md`, all built on the same five-layer model.
> Reference instance: `docs/guidelines/mcp.md`.

---

## Operating principle (read first)

This document exists to find holes in the **framework**, not to grade any tenant.

The causal direction is fixed: **tenant correctness is downstream of contract clarity.** A tenant can
only be as correct as the contracts the framework defines and enforces. Wherever the framework leaves
a contract *absent*, *implicit*, or *declared-but-unimplemented*, every tenant is forced to improvise
that contract privately — and a privately-improvised contract is, by definition, unverifiable and free
to drift. So when a first tenant looks "wrong," the correct reading is almost always: *the framework
never gave it a contract to be right against.*

| Clarity | Meaning | Consequence for tenants |
|---|---|---|
| **Defined** | Specified *and* enforced — a tenant cannot violate it silently. | None — the framework holds the line. |
| **Implicit** | Relied on by convention; not specified or not enforced. | Tenants comply by luck; reviewers catch drift, or nobody does. |
| **Declared-unimplemented** | A contract *shape* exists but nothing honors it at runtime. | Worst case — it *looks* governed, so the gap is invisible until integration. |
| **Absent** | The framework provides nothing. | The tenant must invent the contract; every tenant invents a different one. |

A hole is any row that is not **Defined**. The rest of this document is the hole map.

---

## The layer model (type-agnostic)

| Layer | Section | Question | Contract it governs |
|---|---|---|---|
| 0 | **Ecosystem User Actions (Usage)** | Who uses this type and what do they do? | The behaviors the framework promises consumers. |
| 1 | **Action-Supporting Systems** | Which system serves each action? | Which subsystem owns each promise. |
| 2 | **Output Contracts** | What artifacts pass between systems? | The interfaces between subsystems. |
| 3 | **Contract Sources** | Where does each artifact originate? | Authored vs generated vs resolved vs runtime. |
| 4 | **Producing Subsystems** | Which subsystem produces each artifact, and *is that production contracted?* | The framework's responsibility map — the primary hole map. |

---

## Layer 0 — Ecosystem User Actions (Usage)

**Consumers:** the **Operator** (installs the extension; the human who expects to invoke a command)
and, depending on invocation model, either a **host UI** (a slash-command surface that dispatches the
verb) or the **Operator directly** via `node <entrypoint>` or `sox <verb>`. No agent consumer
exists: the scaffolder template (`scripts/new-extension.ts` line 205) explicitly notes "no LLM
calls," and the schema prohibits the `lifecycle` block on command type (`validate-manifests.ts`
line 356), ruling out supervised daemon use. The **Author** is the producer whose outputs
Layers 2–4 trace back to.

The framework implies two distinct invocation models but commits to neither: (a) a standalone
executable invoked by the operator directly (the `memory-cli` pattern, which also has a hand-maintained
`dist/memory-cli.js` top-level entry that bypasses the extension `entrypoint` entirely); (b) a
slash-command handler invoked by a host dispatcher (the `status-command` pattern, whose `run(input)`
export signature is scaffolded for a caller that does not exist in product code). Every row in O4 and
C1/C2 below is downstream of that unresolved ambiguity.

| # | Consumer | Action | Framework promise | Clarity |
|---|---|---|---|---|
| O1 | Operator | Discover | "You can find what command extensions exist, which verbs they expose, and when to install them." | **Implicit** — the registry record carries `description` and `keywords` but no machine-readable verb or invocation surface; the operator must read prose to know how a command is invoked (`registry/index.json` carries no `verb` field). |
| O2 | Operator | Install at scope | "Install at org/user/project/local; narrower overrides broader." | **Defined** — the scope/cascade contract is specified and enforced by `scripts/install.ts` and `scripts/cascade.ts`. |
| O3 | Operator | Configure | "Set the command's config and secrets, validated before they reach it." | **Implicit** — config cascades, but the framework defines no per-extension config schema, so nothing validates what a command tenant accepts. |
| O4 | Operator | Rely on activation | "Once installed, the command is reachable via a stable, framework-provided invocation surface." | **Absent** — `bin/sox` has no verb for dispatching installed command extensions (`bin/sox` lines 607–619: `update`, `enable`, `disable`, and `search` are stubbed "not yet implemented"; there is no `run <id>` or `/<id>` dispatch). Neither does any host dispatcher surface installed commands. |
| O5 | Operator | Manage lifecycle | "Upgrade, disable, uninstall, promotion behave predictably." | **Implicit/Absent** — install modes exist; disable/uninstall semantics are partially conventional; no promotion event bus is implemented. |
| C1 | Host UI / Operator | Invoke by verb | "After install, the command runs when its verb/slash-command is issued." | **Absent** — the framework specifies no verb registration mechanism; no host dispatcher reads the lockfile and wires installed commands to verbs; the `status-command` export `run(input)` has no framework caller. |
| C2 | Host UI / Operator | Receive typed result | "The command's output (`stdout`, `exitCode`) is delivered to the caller in a defined shape." | **Implicit** — both tenants converge on `{ stdout: string; exitCode: number }` by following the scaffold template (`scripts/new-extension.ts` lines 210–213), but the framework neither specifies nor enforces this interface at the manifest level. |

---

## Layer 1 — Action-Supporting Systems

| Action | Owning system | Exists as a framework contract? |
|---|---|---|
| O1 Discover | Registry + discovery command | Registry record: **yes**, but without a `verb` or invocation-surface field a command's entry point is undiscoverable at rest. Discovery command (`sox search`): **Absent** (`bin/sox` line 612: stubbed "not yet implemented"). |
| O2 Install | Install client + CLI + cascade + lockfile | **Defined.** |
| O3 Configure | Config cascade + capability gate + env resolution | Cascade + capability gate: **Defined.** Per-extension config schema: **Absent.** |
| O4 Activation | Host dispatcher: lockfile reader → verb router → process spawn or module `run()` call | **Absent** — no system reads the installed-command lockfile and exposes commands as invocable verbs. `bin/sox` knows no `run <id>` or `/<id>` verb. The `memory-cli` command bypasses the extension activation model entirely via a hand-maintained `dist/memory-cli.js` top-level entry (`docs/cli-build-decision.md` line 5). |
| O5 Lifecycle | Install modes + promotion event + disable/uninstall | Install modes: **Defined.** Event bus + promotion: **Absent** (`docs/scope-promotion.md` notes no host event bus is implemented). |
| C1 Invoke by verb | Host dispatcher: verb router → command entrypoint | **Absent** — the framework provides no verb router, no slash-command registrar, and no `sox run <id>` dispatch path. |
| C2 Receive result | Host dispatcher: result contract | **Implicit** — the `{ stdout, exitCode }` shape exists by scaffold convention, not framework contract. |

> **The seam.** Discovery/install/configure/cascade/capability are framework-owned and real. The
> **verb declaration, activation, dispatch, and result contract** rows are entirely absent. The seam
> for `command` is sharper than for `mcp-server` in one respect: an mcp-server has an implied
> transport (MCP protocol) that at least constrains the tenant's implementation space; a command has
> no declared invocation model at all. Every tenant must choose independently between standalone
> executable, slash-command handler, and host-dispatched module — with no framework guidance on
> which is intended.

---

## Layer 2 — Output Contracts

| Contract | Interface specified by the framework? | Clarity |
|---|---|---|
| **Manifest** (`extension.json`) | Yes — manifest schema (`schemas/extension/v1.json`). Command requires `entrypoint` (enforced by `allOf` at schema lines 190–192). Lifecycle block is explicitly prohibited (`validate-manifests.ts` line 356), making request-response semantics the only sanctioned model. | **Defined** (shape only — schema validates format but not resolvability or invocation model of `entrypoint`). |
| **Catalog record** | Partially — projection of manifest; carries `type`, `description`, `keywords`. No `verb` or invocation-surface field projected. | **Implicit** — a command's verb is not machine-readable in the catalog; operators cannot search for "command that handles X verb" without reading prose. |
| **Lockfile entry** | Yes — lockfile schema + checksum. | **Defined** (but "what is the artifact it pins?" is undefined — inherits the build hole). |
| **Runnable entrypoint** | No — both command tenants declare `entrypoint: "dist/index.js"` (`extensions/commands/memory-cli/extension.json` line 11; `extensions/commands/status-command/extension.json` line 14), but neither has a `dist/` directory under its own package root. Compiled output exists at `dist/extensions/commands/<name>/src/index.js` (the root-tsconfig emit path), not at the declared `dist/index.js`. | **Absent** — the framework has no build contract; the declared entrypoint resolves to a path that does not exist in any package. |
| **Verb/invocation-surface declaration** (which CLI verb, slash-command name, or endpoint a command binds) | No — the schema has no `verb`, `slash`, or `invocation` field. Invocation surface lives only in source code comments (`status-command/src/index.ts` line 1: "invoked via slash command /status-command"; scaffolder README template line 494: `/${id} [args...]`). | **Absent** — a host cannot discover a command's invocation surface without reading its source or documentation. |
| **Command handler contract** (`run(input: CommandInput): CommandOutput`) | Convention only — the scaffolder emits this signature (`scripts/new-extension.ts` lines 221–233) and `status-command/src/index.ts` line 21 implements it. `memory-cli` does not export `run()` at all (its entry is `runCli(argv)` at line 200), demonstrating that the convention already diverges across two tenants. No schema or validator enforces the handler shape. | **Implicit** (and already diverged) — tenants cannot comply consistently because no contract specifies which export name or signature is canonical. |
| **Lifecycle descriptor** (`lifecycle{}`) | Explicitly prohibited for commands — `validate-manifests.ts` line 356 rejects `lifecycle` on command type. | **Defined** (the prohibition is enforced; commands are request-response, not supervised daemons). |
| **Config contract** | No per-extension schema; config is an open object. | **Implicit.** |
| **Capability declaration** (`requires`) | Checked against capabilities asset at install time. | **Defined.** |
| **Resource/permission contract** | Nothing declares or bounds filesystem/network/socket access. `memory-cli` opens SQLite databases, reads/writes `~/.memory/registry.json`, and resolves paths from `process.cwd()` — all undeclared. | **Absent.** |

> The **Absent** rows here manufacture specific tenant defects. With no verb-declaration contract,
> a host cannot build the verb→command map without loading and introspecting source. With no build
> contract, the declared `entrypoint` points to a file that does not exist under the package root.
> With no handler contract enforced, the two existing tenants already emit different export signatures
> (`run(input)` vs `runCli(argv)`), making them incompatible with any single dispatcher. None of
> these are tenant mistakes — they are unfilled framework slots.

---

## Layer 3 — Contract Sources

| Contract | Origin (authored / generated / resolved / runtime) | Governed at origin? |
|---|---|---|
| Manifest | authored | Yes (schema-validated at CI via `validate-manifests.ts`). |
| Catalog record | generated from manifest | Generation exists (`build-index.ts`); verb/invocation-surface field not projected — ungoverned for command-specific metadata. |
| Lockfile entry | resolved at install | Yes. |
| Runnable entrypoint (`dist/index.js`) | should be *generated* from source by a per-package build step | **No build contract → ungoverned.** CI runs `pnpm typecheck` but no `pnpm -r build`; root-tsconfig emit lands at `dist/extensions/commands/<name>/src/index.js`, not the declared `dist/index.js`. |
| Verb/invocation-surface declaration | authored (source code only — comments and README prose; `scripts/new-extension.ts` lines 220, 494) | **No manifest field → ungoverned at rest.** The binding is visible only after reading source or documentation. |
| Command handler signature | authored (source code, guided by scaffold template) | **Convention only — not schema-enforced, and already diverged** (`run(input)` in `status-command`; `runCli(argv)` in `memory-cli`). |
| Config contract | authored (manifest + scope config files) | **No per-extension schema → ungoverned.** |
| Capability declaration | authored (manifest) | Yes. |
| Resource/permission | (not declared anywhere) | **No origin → ungoverned.** |

---

## Layer 4 — Producing Subsystems (primary hole map)

| # | Transition | Owning subsystem | Clarity | If not Defined → what the tenant must improvise (where drift enters) |
|---|---|---|---|---|
| 1 | intent → **manifest** | scaffolder + schema + validator | **Defined**, but validation asserts shape only — it does not check that the declared `entrypoint` resolves to a built file, that any verb binding is valid (no `verb` field exists in the schema), or that the handler signature matches a framework-owned interface. | A tenant can pass validation with a dangling entrypoint, no declared verb, and a handler signature incompatible with any dispatcher. |
| 2 | manifest → **catalog record** | registry/index builder (`build-index.ts`) | **Implicit** — the catalog projects `type`, `description`, `keywords` but not the command's invocation verb or surface, making commands undiscoverable by verb. | Each tenant guesses what metadata makes its command discoverable; operators cannot filter commands by invocation surface without reading source or prose documentation. |
| 3 | manifest + package → **lockfile** | install client (`install.ts`) | **Defined** — but "package" is undefined (inherits #4). The install client checksums `src/index.ts`, not a built artifact. | The lockfile pins a TypeScript source file, not an executable. A dispatcher that reads the lockfile gets a `.ts` path it cannot `require()` without a TypeScript runtime. |
| 4 | source → **distributable artifacts** | **build/output-generation subsystem (framework-owned)** | **Absent** | Both command extensions declare `entrypoint: "dist/index.js"` but neither has a `dist/` directory under its own package root (`extensions/commands/memory-cli/` and `extensions/commands/status-command/` — confirmed by inspection). Root-tsconfig emit produces `dist/extensions/commands/<name>/src/index.js`, which is a structurally different path that no manifest references. CI runs `pnpm typecheck` but no `pnpm -r build` step in either `validate.yml` or `release.yml`. The hand-maintained `dist/memory-cli.js` at repo root (`docs/cli-build-decision.md` §"Hand-Maintained ESM Mirror") is itself the diagnostic that this contract is Absent — the framework is not generating outputs, so a tenant invents a parallel mechanism. **Highest-severity hole: silently nullifies rows #3 (lockfile) and #7 (release) — the framework can pin and publish an entrypoint that was never generated at the declared path.** |
| 5 | author → **verb/invocation-surface declaration** | (ecosystem should enforce a `verb` or `invocation` field in the manifest schema) | **Absent** | Every command tenant encodes its invocation surface in source comments and README prose only. No two tenants are required to declare the same surface shape. A host must load and read each command's source to discover how it is invoked — making static dispatch impossible. |
| 6 | source → **command handler interface descriptors** | (schema + validator) | **Absent** — no machine-readable contract for handler export name, input type, or output type at the manifest level. Already diverged: `status-command` exports `run(input: CommandInput): CommandOutput`; `memory-cli` exports `runCli(argv: string[]): void` (`extensions/commands/memory-cli/src/index.ts` line 200). | A dispatcher cannot import and call a command module without knowing the export name and signature. Every dispatcher must hard-code per-command import paths and call conventions. **Root cause of "command is installed but cannot be dispatched uniformly."** |
| 7 | artifact + version → **published package** | versioning/release (Changesets) | **Defined** but blocked by #4. | The release pipeline publishes an npm package containing no `dist/index.js` at the declared path; any host that resolves the published entrypoint gets a file-not-found error. |
| 8 | installed set + entrypoint + verb-binding → **registered in command dispatcher** | host runtime: command loader + verb router | **Absent** | Nothing reads the lockfile at host startup, loads each command's entrypoint, resolves its verb binding (which is not in the manifest), and wires it to an invocation surface. `bin/sox` has no `run <id>` verb; there is no `sox /<id>` dispatch. The framework provides a scaffolder template but no integration point. **Root cause of "installed but unreachable."** |
| 9 | operator invocation → **command executes and result delivered** | host runtime: verb router → handler → result | **Absent** — no product-code caller of any command's `run()` or `runCli()` exists in the framework. `memory-cli` is invocable only via its hand-maintained `dist/memory-cli.js` top-level entry, which bypasses the extension activation model entirely. | The operator must invent the invocation path independently per command. Every host or operator script that wants to run an installed command must discover the entrypoint, the export name, and the argument shape from source or documentation. **Root cause of "extension type with no delivery path."** |
| 10 | scope config → **applied config** | cascade + config schema | Cascade **Defined**; per-extension config schema **Absent** | A command's config keys and env var names (e.g., `memory-cli`'s `process.env['HOME']` at `src/index.ts` line 36, `process.env['USERPROFILE']` at line 36) are unvalidated; typos or missing env vars pass silently and surface only at runtime. |
| 11 | requires + capabilities → **gate decision** | capability gate (`provider-capabilities.ts`) | **Defined** | — |
| 12 | lifecycle signal → **command reaction** | host event bus | **Absent** — the `lifecycle` block is explicitly prohibited on command type; the event bus that would signal lifecycle events is also absent (noted in `docs/scope-promotion.md`). | Commands cannot participate in promotion, disable, or lifecycle events. No event vocabulary is specified. |

### The shape of the hole map

- **Defined (framework holds the line):** rows 1\*, 3\*, 7\*, 11 — the authoring → distribution
  spine. (\* with the noted incompleteness in 1, and 3/7 blocked by the missing build contract at #4.)
- **Absent / declared-unimplemented (tenant on its own):** rows 4, 5, 6, 8, 9, 12 — the entire
  build → activation → dispatch → result seam.

The "spine contracted, seam not" thesis reproduces for `command`, but with a type-specific
amplification: the seam for `command` is the most consequential of any type reviewed so far, because
the `command` type has no implied transport or activation model that constrains the tenant's
implementation space even informally. An `mcp-server` without a registrar at least inherits the MCP
protocol as an implicit constraint; a `hook` without a dispatcher at least has its event binding
implicit in source exports. A `command` without a verb declaration, handler contract, and dispatcher
has nothing: the framework scaffolds an invocable-looking module and then provides zero mechanism for
any caller to reach it. The result is that the two existing tenants have already diverged at the most
fundamental level — handler export name and signature — because there was no contract to converge on.
Additionally, `command` has a unique row-5 hole that `mcp-server` and `hook` partially mitigate via
transport and event conventions respectively: there is no static, machine-readable path from
"installed command set" to "verb → handler" at any layer of the framework.

---

## The `command` runtime contract the framework still owes

These are the seam contracts a complete `command` guideline must define — today they are Absent.
This is where command-specific drift enters.

- **Build / output-generation contract (#4) — framework-owned, the linchpin:** the framework (not
  the tenant) must deterministically compile each command's `src/index.ts` to the package's own
  `dist/index.js`, so that the declared `entrypoint` resolves to a real, executable file at the
  package root. Currently both command packages declare `entrypoint: "dist/index.js"` but neither
  has a `dist/` directory; root-tsconfig emit lands at a structurally different path
  (`dist/extensions/commands/<name>/src/index.js`); CI has no `pnpm -r build` step. The
  hand-maintained `dist/memory-cli.js` at repo root is the diagnostic that this contract is Absent —
  a tenant invented a parallel delivery mechanism because the framework provided none. Until this
  holds, rows #3 (lockfile) and #7 (release) are only nominally Defined.

- **Verb/invocation-surface contract (#5) — manifest `verb` or `invocation` field:** the schema
  must require a command to declare, in its manifest, the invocation surface it binds to — whether a
  CLI verb (`sox run <id>`), a slash-command name (`/<id>`), or a standalone executable path. This
  declaration must be validated against a defined vocabulary of invocation surfaces. Currently both
  command tenants encode their invocation surface only in source comments and README prose
  (`status-command/src/index.ts` line 1: "invoked via slash command /status-command";
  `scripts/new-extension.ts` line 494: `/${id} [args...]`). Without a manifest field: (a) a host
  cannot statically build the verb→command map; (b) the validator cannot reject a command that
  declares an invocation surface that does not exist in the host; (c) the registry cannot surface
  "commands that handle verb X" to operators without running code.

- **Handler interface contract (#6):** the framework must specify a single canonical export name
  and signature (`run(input: CommandInput): CommandOutput` or equivalent) as a validated,
  importable type that every command tenant must satisfy — checked by the validator or a type-only
  package, not inferred from a scaffold template. Currently the two tenants export different shapes:
  `run(input: CommandInput)` (`status-command/src/index.ts` line 21) and `runCli(argv: string[])`
  (`memory-cli/src/index.ts` line 200). The `CommandInput` and `CommandOutput` interfaces are
  re-declared independently in each tenant's source rather than imported from a framework-owned
  package. Any dispatcher must hard-code per-command call conventions until this is resolved.

- **Activation / registration contract (#8):** the framework must specify how a host, at startup (or
  on-demand), reads the lockfile, loads each enabled command's entrypoint, resolves its verb binding
  from the manifest (once #5 is defined), and wires it to an invocation surface — so that every host
  produces the same verb→command map from the same installed set. Currently `bin/sox` has no
  `run <id>` verb and no slash-command dispatch; no product-code caller of any command's handler
  function exists in the framework. The scaffolder generates a callable module with no integration
  point.

- **Dispatch / invocation contract (#9):** the framework must specify the invocation vocabulary
  (closed enum of invocation models, input payload shapes per model) and the host's obligation to
  call the handler at the right moment with the right input shape. Currently the invocation model
  is undecided between standalone executable, slash-command handler, and host-dispatched module —
  no schema, interface, or enforced contract defines `CommandInput` payload shape, error semantics,
  or the stdout/exitCode result contract at the framework level.

- **Config-schema contract (#10):** a per-extension config schema so that command config keys and
  env var dependencies (e.g., `HOME`, `USERPROFILE`, database path environment variables read by
  `memory-cli/src/index.ts` lines 36–37) are declared, typed, and validated at install time rather
  than discovered by reading source code.

- **Resource/permission contract:** a manifest declaration of what filesystem paths, sockets, and
  network resources a command may access — so operators can audit command behavior before installing
  and hosts can (eventually) sandbox it.

---

## Notes for the author of the NEXT type document

The invariant spine (scaffold → schema → validate → build → version → install/cascade → capability
gate) should read consistently across every `docs/guidelines/*.md`. The **activation + consumption**
seam is what each type's document exists to specify. If your finding does NOT reproduce the
"spine contracted, seam not" shape, that is itself a notable result — say so and explain why.
