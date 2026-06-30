# Extension Framework Contracts — `agent`

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

**Consumers:** the **Operator** (installs and configures; sets scope policy) and the **Orchestrator**
(the host runtime or parent LLM that decides when to delegate a task to an installed agent). The
**Author** is the producer whose outputs Layers 2–4 trace back to.

The `agent` type is the only type whose runtime consumer is itself a decision-making process — an
orchestrating host or parent LLM that reads the agent's description, resolves when to delegate, and
invokes the agent's entrypoint with a task. This is distinct from `mcp-server` (tools surfaced into
a context) and `hook` (deterministic lifecycle reaction): an agent is a sub-orchestrator with its own
system prompt and tool surface.

| # | Consumer | Action | Framework promise | Clarity |
|---|---|---|---|---|
| O1 | Operator | Discover | "You can find what agent extensions exist, understand their delegation conditions, and decide when to install them." | **Implicit** — the registry record (`registry/index.json`) carries `description` and `keywords`, but no machine-readable delegation-condition or input/output contract. The `description` field is the primary discovery signal (`schemas/extension/v1.json` line 26–29), validated only for invocation-guidance shape (advisory, `validate-manifests.ts` line 717) — not for completeness or testability. |
| O2 | Operator | Install at scope | "Install at org/user/project/local; narrower overrides broader." | **Defined** — the scope/cascade contract is specified and enforced by `scripts/cascade.ts` and `scripts/install.ts`. |
| O3 | Operator | Configure | "Set the agent's config and secrets, validated before they reach it." | **Implicit** — config cascades, but the framework defines no per-extension config schema, so nothing validates what an agent tenant accepts via environment or config. |
| O4 | Operator | Rely on activation | "Once installed and enabled, the agent is available for the orchestrator to delegate tasks to." | **Absent** — no host runtime reads the lockfile, resolves the agent's entrypoint, or makes the agent available to any orchestrator. Nothing in the repo loads `dist/index.js` from an installed agent (confirmed: neither `extensions/agents/echo-agent/` nor `extensions/agents/memory-organizer/` has a `dist/` directory at all). |
| O5 | Operator | Manage lifecycle | "Upgrade, disable, uninstall, promotion behave predictably." | **Implicit/Absent** — install modes exist; disable/uninstall semantics are partially conventional; promotion event is declared in documentation but the event bus it depends on is absent. |
| R1 | Orchestrator | Decide to delegate | "The orchestrator can determine from installed agent metadata whether this agent handles the current task." | **Absent** — the CLAUDE.md file is a prose document readable by an LLM, but it is not a machine-readable contract. No manifest field declares delegation conditions, accepted input format, or output shape in a form a host can parse without executing the agent. |
| R2 | Orchestrator | Invoke agent | "The orchestrator passes a task and the agent runs to completion, returning a structured result." | **Absent** — no invocation protocol (stdio, IPC, function call, or HTTP) is specified or enforced by the framework. Both tenants embed their logic as exported TypeScript functions (`organizeItems` in `memory-organizer/src/index.ts` line 233; tool-execute callbacks in `echo-agent/src/index.ts` lines 37, 55), but the calling convention is undefined and unverified. |

---

## Layer 1 — Action-Supporting Systems

| Action | Owning system | Exists as a framework contract? |
|---|---|---|
| O1 Discover | Registry + discovery command | Registry record: **yes** — `registry/index.json` projects `type`, `description`, `keywords`. Discovery command (`soxe search`): **Absent** — `bin/sox` stubs it as "not yet implemented." No agent-specific discovery metadata (delegation conditions, input/output contract) is projected. |
| O2 Install | Install client + CLI + cascade + lockfile | **Defined.** |
| O3 Configure | Config cascade + capability gate + env resolution | Cascade + capability gate: **Defined.** Per-extension config schema: **Absent.** |
| O4 Activation | Host runtime: loader → entrypoint resolution → agent process or module | **Absent** — no host runtime exists. The `lifecycle` block is permitted for `agent` type (`schemas/extension/v1.json` line 200; `validate-manifests.ts` line 349) and its shape is schema-governed, but nothing honors it at runtime. `tools/supervisor-shim.js` is labelled "TEST SCAFFOLDING, not a product workaround" (line 9) and only covers `memory-server`, not any agent extension. |
| O5 Lifecycle | Install modes + promotion event + disable/uninstall | Install modes: **Defined.** Host event bus: **Absent** (`docs/architecture-audit.md` line 13). |
| R1 Delegation decision | Host orchestrator: reads agent registry/CLAUDE.md, matches to task | **Absent** — the framework provides no machine-readable delegation condition; the orchestrator must read prose CLAUDE.md or rely on `description` field text, with no validated format or guaranteed completeness. |
| R2 Invocation | Host orchestrator: calls agent entrypoint with task, collects result | **Absent** — no invocation protocol (call convention, transport, task format, result format) is specified or enforced anywhere in the framework. |

> **The seam.** Discovery/install/configure/cascade/capability are governed. The **delegation
> decision, activation, invocation, and result handling** rows are where the framework's contracts
> thin out completely to Absent. The seam for `agent` is total at the runtime boundary: nothing
> between "installed lockfile entry" and "agent produces a result" is contracted. Unlike `hook` (which
> at least has a `HookLoader` with defined dispatch semantics) or `mcp-server` (which at least has a
> transport protocol convention), `agent` has no analogous runtime primitive at all.

---

## Layer 2 — Output Contracts

| Contract | Interface specified by the framework? | Clarity |
|---|---|---|
| **Manifest** (`extension.json`) | Yes — manifest schema (`schemas/extension/v1.json`). Agent requires `entrypoint` (enforced by `allOf` at schema line 190–192). Agent may optionally declare `lifecycle` (permitted by schema line 200; validated by `validate-manifests.ts` line 349). | **Defined** (shape only — schema validates format but not resolvability of `entrypoint` or behavioral correctness). |
| **Catalog record** | Partially — projection of manifest; carries `type`, `description`, `keywords`. No delegation-condition or input/output contract projected. | **Implicit** — an agent's invocation contract is not machine-readable in the catalog. |
| **Lockfile entry** | Yes — lockfile schema + checksum. | **Defined** (but "what is the artifact it pins?" is undefined — inherits the build hole). |
| **Runnable entrypoint** | No — `entrypoint: "dist/index.js"` is declared in both agent manifests (`extensions/agents/echo-agent/extension.json` line 13; `extensions/agents/memory-organizer/extension.json` line 11), but no `dist/` directory exists under either package. | **Absent** — the framework has no build contract; per-package `dist/index.js` is never produced by CI. |
| **Invocation protocol** (how an orchestrator calls the agent: stdio, function export, IPC, HTTP) | No — the framework names no invocation protocol for agent type. `echo-agent` exports a `tools` array and an `AgentDefinition` object; `memory-organizer` exports an `organizeItems()` function. These are incompatible shapes; neither is declared or validated. | **Absent** — every tenant invents a different calling convention. |
| **Agent definition contract** (`AgentDefinition` — name, description, systemPrompt, tools) | Convention only — the scaffolder emits an `AgentDefinition` interface (`scripts/new-extension.ts` lines 74–88), but it is a scaffold template, not a framework type. `memory-organizer` exports a different `AgentDefinition` with `capabilities` instead of `tools` (`src/index.ts` lines 381–408). No validator or runtime enforces the interface. | **Implicit** — tenants comply partially by following the scaffold; no contract enforces it. |
| **CLAUDE.md** (LLM invocation guidance: when to delegate, what it does, handoff protocol) | Scaffolded by `new-extension.ts` (line 936–942); sections validated by scaffolder test (`scaffolder.test.ts` lines 131–132). Presence is not checked by `validate-manifests.ts`; content is free prose. | **Implicit** — the scaffolder produces a template with correct sections; nothing enforces presence or content at CI time. |
| **Lifecycle descriptor** (`lifecycle{}`) | Shape: yes, behavior: no. Permitted for `agent` type, schema-validated fields. No loader honors the block. | **Declared-unimplemented** — the lifecycle block can be declared; no product-code reads it for agents. |
| **Config contract** | No per-extension schema; config is an open object. | **Implicit.** |
| **Capability declaration** (`requires`) | Checked against the capabilities asset at install time. | **Defined.** |
| **Resource/permission contract** | Nothing declares or bounds filesystem/network/socket access. `memory-organizer` makes HTTP calls to a provider (`src/index.ts` line 105) — undeclared. | **Absent.** |

> The **Absent** rows manufacture specific tenant defects. With no invocation protocol, two agent
> tenants in the same repo use incompatible export shapes and cannot be called by the same
> orchestrator without custom adapters. With no build contract, the `entrypoint` field points to a
> file that was never generated. With no CLAUDE.md enforcement, an agent can be installed with no
> delegation guidance and the orchestrator has no contract to route against. With no resource
> contract, an agent's network or filesystem access is unbounded and undiscoverable by operators.

---

## Layer 3 — Contract Sources

| Contract | Origin (authored / generated / resolved / runtime) | Governed at origin? |
|---|---|---|
| Manifest | authored | Yes (schema-validated at CI via `validate-manifests.ts`). |
| Catalog record | generated from manifest | Generation exists (`build-index.ts`); delegation-condition and invocation-contract fields not projected — ungoverned for agent-specific metadata. |
| Lockfile entry | resolved at install | Yes. |
| Runnable entrypoint (`dist/index.js`) | should be *generated* from source by a per-package build step | **No build contract → ungoverned.** CI runs `pnpm typecheck` (`tsc --noEmit`) but no emit step; root `package.json` has no `pnpm -r build` script. Neither agent package has a local `tsconfig.json`, so `tsc` in the package directory inherits the root config and would emit to `dist/extensions/...` at the repo root — not to the package-local `dist/index.js` declared in `entrypoint`. |
| Invocation protocol | authored (source code, varying per tenant) | **No protocol contract → ungoverned.** Two tenants use different export shapes with no framework enforcement. |
| Agent definition | authored (source code, guided by scaffold template) | **Convention only — not schema-enforced.** Scaffold emits one shape; `memory-organizer` uses a divergent shape with no validator catching the deviation. |
| CLAUDE.md | authored (from scaffold template, free prose thereafter) | **Convention only — not validated.** Scaffolded with correct sections; presence not checked by `validate-manifests.ts`. |
| Lifecycle descriptor | authored (manifest) | Shape governed; behavior ungoverned (no loader). |
| Config contract | authored (manifest + scope config files) | **No per-extension schema → ungoverned.** |
| Capability declaration | authored (manifest) | Yes. |
| Resource/permission | (not declared anywhere) | **No origin → ungoverned.** |

---

## Layer 4 — Producing Subsystems (primary hole map)

| # | Transition | Owning subsystem | Clarity | If not Defined → what the tenant must improvise (where drift enters) |
|---|---|---|---|---|
| 1 | intent → **manifest** | scaffolder + schema + validator | **Defined**, but validation asserts shape only — it does not check that the declared `entrypoint` resolves to a built file, that declared capabilities are real, or that the CLAUDE.md delegation guidance is present or well-formed. | A tenant can pass all validation with a dangling entrypoint, no CLAUDE.md, and an undiscoverable delegation contract. |
| 2 | manifest → **catalog record** | registry/index builder (`build-index.ts`) | **Implicit** — the catalog projects `type`, `description`, `keywords` but not delegation conditions, input format, output format, or invocation protocol. An orchestrator cannot filter or route agents by capability without reading prose documentation. | Each tenant guesses what metadata makes its agent discoverable to an orchestrator; operators cannot compare agents at rest. |
| 3 | manifest + package → **lockfile** | install client (`install.ts`) | **Defined** — but "package" is undefined (inherits #4). The install client checksums the source, not a built artifact. | The lockfile pins a TypeScript source file, not an executable. A host that reads the lockfile gets a path it cannot invoke without a build step. |
| 4 | source → **distributable artifacts** | **build/output-generation subsystem (framework-owned)** | **Absent** | Both agent extensions declare `entrypoint: "dist/index.js"` but neither has a `dist/` directory (`extensions/agents/echo-agent/` and `extensions/agents/memory-organizer/` — confirmed by inspection). CI runs `pnpm typecheck` but no `pnpm -r build`. Each package's `"scripts": { "build": "tsc" }` has no local `tsconfig.json`, so `tsc` in the package directory inherits the root config and would emit to a structurally different path. **Highest-severity hole: silently nullifies the Defined rows #3 (lockfile) and #7 (release) — the framework can pin and publish an artifact that was never generated.** |
| 5 | author → **invocation protocol** | (framework should specify: stdio/function-export/IPC/HTTP + task schema + result schema) | **Absent** | Every agent tenant invents a calling convention. `echo-agent/src/index.ts` (lines 23–65) exports a `tools` array with `execute` callbacks; `memory-organizer/src/index.ts` (line 233) exports `organizeItems(items, db)`. An orchestrator host must custom-adapt to each tenant's shape. Each new tenant introduces a new adapter surface. |
| 6 | source → **agent definition descriptors** (name, systemPrompt, capabilities, tools) | (schema + validator) | **Absent** — no machine-readable contract for `AgentDefinition` shape, required fields, or systemPrompt format at the manifest level. The scaffolder emits one interface shape; `memory-organizer` exports a divergent one (`capabilities` field instead of `tools`, `src/index.ts` lines 381–408) with no validator catching the deviation. | A tenant's agent definition is undiscoverable and unvalidatable at rest. An orchestrator cannot know what tools or capabilities an agent requires without loading and introspecting its source. |
| 7 | artifact + version → **published package** | versioning/release (Changesets) | **Defined** but blocked by #4 | The release pipeline publishes an npm package containing no `dist/index.js`; any host that resolves the published entrypoint gets a file-not-found error. |
| 8 | installed set + entrypoint + lifecycle → **activated agent** | host runtime: loader + supervisor | **Absent** | Nothing reads the lockfile at host startup, resolves an agent's entrypoint, and makes the agent available for delegation. The `lifecycle` block is schema-governed but no product-code loader honors it for agents. `tools/supervisor-shim.js` covers `memory-server` only and is explicitly test scaffolding. **Root cause of "installed but never callable."** |
| 9 | task description → **agent invoked, result returned** | host runtime: orchestrator/dispatcher | **Absent** — the framework specifies no protocol by which an orchestrator hands a task to an agent and receives a result. The CLAUDE.md template documents a prose "handoff protocol" (`scripts/new-extension.ts` line 651–653: "Pass the task as a natural-language description string. The agent returns its result as the final assistant message.") but this is unspecified as a machine contract and unenforced. | The orchestrator must invent the delegation path. Every orchestrator invents a different task format, timeout policy, and result extraction. **Root cause of "agent installed, orchestrator can't use it."** |
| 10 | scope config → **applied config** | cascade + config schema | Cascade **Defined**; per-extension config schema **Absent** | An agent's config keys (e.g., `MEMORY_PROVIDER_URL`, `MEMORY_PROVIDER_KEY` read by `memory-organizer/src/index.ts` lines 69–70) are unvalidated; typos pass silently. |
| 11 | requires + capabilities → **gate decision** | capability gate (`provider-capabilities.ts`) | **Defined** | — |
| 12 | lifecycle signal → **agent restarted/stopped/promoted** | host event bus | **Absent** — no host event bus is implemented. The `lifecycle` block shape exists in the schema; no product-code acts on it. The promotion event convention exists in documentation (`docs/scope-promotion.md`) but has no runtime carrier. | The host must invent the event vocabulary and agent lifecycle semantics. No agent tenant has a framework-specified restart, stop, or promotion path. |

### The shape of the hole map

- **Defined (framework holds the line):** rows 1\*, 3\*, 7\*, 11 — the authoring → distribution
  spine. (\* with the noted incompleteness in 1, and 3/7 blocked by the missing build contract at #4.)
- **Absent / declared-unimplemented (tenant on its own):** rows 4, 5, 6, 8, 9, 12 — the entire
  build → activation → invocation → eventing seam.

The "spine contracted, seam not" thesis reproduces exactly for `agent`, but with a type-specific
amplification: the seam for `agent` is *wider than for any other type* because the agent runtime model
introduces a contract layer not present in `mcp-server` or `hook` — the invocation protocol (row 5)
and agent definition descriptors (row 6). An MCP server's runtime model is specified by the MCP
standard; a hook's runtime model is partially specified by `HookLoader`. The `agent` type has no
analogous external standard and no internal library: the framework provides zero seam primitives
between "installed lockfile entry" and "orchestrator delegates and gets a result." The row-5 hole
(invocation protocol) is `agent`-specific and has no parallel in the other types — it is the defining
structural gap of this type.

---

## The `agent` runtime contract the framework still owes

These are the seam contracts a complete `agent` guideline must define — today they are Absent or
Declared-unimplemented. This section is where agent-specific drift enters.

- **Build / output-generation contract (#4) — framework-owned, the linchpin:** the framework (not
  the tenant) must deterministically and uniformly compile each agent's `src/index.ts` to the
  package's own `dist/index.js`, so that the declared `entrypoint` resolves to a real, executable
  file. Neither agent package has a `dist/` directory; CI has no `pnpm -r build` step. The per-package
  `"build": "tsc"` script has no local `tsconfig.json` to drive it, so `tsc` in the package directory
  would emit to the repo root `dist/extensions/...`, not the package-local `dist/index.js` the
  manifest declares. Until this holds, rows #3 (lockfile) and #7 (release) are only nominally
  Defined — they pin and publish an entrypoint that was never built.

- **Invocation protocol contract (#5) — the agent-specific seam:** the framework must specify how
  an orchestrator or host invokes an installed agent: the transport (stdio subprocess, imported module
  function call, IPC, or HTTP), the task input format (string, structured object, message array), and
  the result output format (string, structured object, error envelope). Currently two tenants use
  incompatible shapes — `echo-agent` exports a `tools` array with `execute` callbacks
  (`src/index.ts` lines 23–65); `memory-organizer` exports `organizeItems(items, db): Promise<OrganizerResult[]>`
  (`src/index.ts` line 233) — with no common calling convention. This gap has no parallel in other
  types; it is the foundational missing contract for `agent`.

- **Agent definition contract (#6):** the framework must specify a canonical `AgentDefinition`
  interface — at minimum: `name`, `description`, `systemPrompt`, and either a `tools` list or a
  declared capability set — as a framework-owned importable type validated by the schema or validator.
  Currently the scaffolder emits one interface shape (`scripts/new-extension.ts` lines 74–88) and a
  real tenant uses a divergent shape (`memory-organizer/src/index.ts` lines 381–408: `capabilities`
  field instead of `tools`, no validator catches the deviation). Without a canonical interface,
  orchestrators cannot introspect agent capabilities without loading and reading source.

- **Activation / loading contract (#8):** the framework must specify how a host, at startup, reads
  the lockfile, identifies installed agent extensions, resolves their entrypoints, and makes them
  available for delegation. The `lifecycle` block shape exists in the schema and is enforced for
  type (`validate-manifests.ts` line 349), but no product-code loader honors it for agents.
  The supervision contract documented in `architecture-v2.md` §G-A describes start/stop/health/singleton
  semantics; these are unenforced for any agent extension.

- **Invocation / delegation contract (#9):** the framework must specify the host's obligation when
  delegating to an agent: the task handoff format, the result extraction protocol, timeout behavior,
  error handling (agent crash, malformed output), and whether the agent runs in-process or as a
  subprocess. The CLAUDE.md template prose ("Pass the task as a natural-language description string.
  The agent returns its result as the final assistant message." — `scripts/new-extension.ts` line
  651–653) is authoring guidance, not a machine contract. No schema, interface, or enforced protocol
  specifies any of these properties.

- **CLAUDE.md content contract:** the framework must validate that each agent extension ships a
  CLAUDE.md with the required sections (Purpose, When to delegate, What this agent does, Handoff
  protocol) rather than only scaffolding them. Currently `validate-manifests.ts` does not check for
  CLAUDE.md presence at all; an agent that deletes its CLAUDE.md passes all CI checks. Given that
  CLAUDE.md is the primary mechanism by which an LLM orchestrator determines when and how to delegate,
  its absence is equivalent to a missing event-binding declaration for a hook.

- **Config-schema contract (#10):** a per-extension config schema so that agent config keys (e.g.,
  `MEMORY_PROVIDER_URL`, `MEMORY_PROVIDER_KEY`, `MEMORY_PROVIDER_MODEL` read by
  `memory-organizer/src/index.ts` lines 69–71) are declared, typed, and validated at install time
  rather than discovered by reading source code.

- **Resource/permission contract:** a manifest declaration of what network endpoints, filesystem
  paths, and external services an agent may access — so operators can audit agent behavior before
  installing and hosts can (eventually) sandbox it. `memory-organizer` makes unconstrained HTTP calls
  to an arbitrary `MEMORY_PROVIDER_URL` (`src/index.ts` line 105); this is entirely undeclared.

- **Event contract (#12):** a defined event vocabulary so agent lifecycle signalling (start, stop,
  restart, promotion) is specified rather than improvised. The `lifecycle` block names the semantics;
  no event bus delivers them.

---

## Notes for the author of the NEXT type document

The invariant spine (scaffold → schema → validate → build → version → install/cascade → capability
gate) should read consistently across every `docs/guidelines/*.md`. The **activation + consumption**
seam is what each type's document exists to specify. If your finding does NOT reproduce the
"spine contracted, seam not" shape, that is itself a notable result — say so and explain why.
