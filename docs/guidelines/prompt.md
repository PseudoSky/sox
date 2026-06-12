# Extension Framework Contracts — `prompt`

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

## Important deviation: `prompt` is a static template asset, not a process

Unlike `mcp-server`, `hook`, `command`, `agent`, and `skill`, the `prompt` type has **no runtime
entrypoint and no runtime process**. The schema makes this explicit: the `entrypoint` field
description reads "Required for behavioral types; omitted for prompt (host convention: `prompt.md`)"
(`schemas/extension/v1.json` line 43–44), and none of the `allOf` conditionals at lines 184–207
require `entrypoint` for type `prompt`. The scaffolder enforces this: `scripts/new-extension.ts`
line 748 writes `entrypoint: 'dist/index.js'` for all types *except* `prompt` and `bundle`.

The distributable artifact is `prompt.md` — a Markdown file with optional YAML frontmatter. There
is no build step, no compile phase, no spawn, and no transport layer. Consumption means a host reads
and injects the rendered template; nothing in the framework implements that read or injection.

This changes the seam geometry. For process-based types, the seam runs through activation (spawn,
registration) and dispatch (call, result). For `prompt`, the activation and dispatch seam collapses
to a single contract: the **template-loading and parameter-injection contract** — which is Absent.
The rows below are adapted accordingly; where a process-based row has no analogue for `prompt`, this
is stated explicitly rather than forcing the `mcp`/`hook` shape.

---

## Layer 0 — Ecosystem User Actions (Usage)

**Consumers:** the **Operator** (installs and configures; decides which prompts are available) and
the **Host** (the runtime entity — agent, CLI, or orchestrator — that reads and injects a prompt
template at invocation time). There is no transport layer: the host consumes the template as text,
not as a running process. The **Author** is the producer whose outputs Layers 2–4 trace back to.

| # | Consumer | Action | Framework promise | Clarity |
|---|---|---|---|---|
| O1 | Operator | Discover | "You can find what prompt extensions exist, understand what they produce, and decide which to install." | **Implicit** — the registry record (`registry/index.json` lines 139–150) carries `description` and `type`, but no machine-readable declaration of parameters or template purpose; the operator must read the `prompt.md` prose. |
| O2 | Operator | Install at scope | "Install at org/user/project/local; narrower overrides broader." | **Defined** — scope/cascade contract is specified and enforced by `scripts/cascade.ts` and `scripts/install.ts`. |
| O3 | Operator | Configure | "You can set the prompt's config, validated before it reaches it." | **Implicit** — config cascades, but no per-prompt config schema exists; nothing validates what keys a prompt template accepts. |
| O4 | Operator | Rely on availability | "Once installed, the prompt template is available to the host on demand without manual wiring." | **Implicit** — install places the template in the lockfile; whether the host can actually locate and read it from the lockfile is unspecified and unimplemented. |
| O5 | Operator | Manage lifecycle | "Upgrade, disable, uninstall, promotion behave predictably." | **Implicit/Absent** — install modes exist; disable/uninstall semantics are partially conventional; promotion event bus is absent (`docs/scope-promotion.md`). |
| H1 | Host | Load template | "On request, retrieve the installed prompt template text by id." | **Absent** — nothing in the framework reads the lockfile, locates `prompt.md` for a given id, and returns its content to the host. |
| H2 | Host | Inject parameters | "Supply named parameter values; receive the rendered, substitution-complete template text." | **Absent** — the framework specifies no parameter schema, no substitution engine, and no rendering contract. |

---

## Layer 1 — Action-Supporting Systems

| Action | Owning system | Exists as a framework contract? |
|---|---|---|
| O1 Discover | Registry + discovery command | Registry record: **yes**, but without machine-readable parameter declarations. Discovery command (`sox search`): **Absent** — `bin/sox` line 612–613: "not yet implemented". |
| O2 Install | Install client + CLI + cascade + lockfile | **Defined.** Install client recognizes `prompt.md` as the content file for `file://` sources (`scripts/install.ts` lines 312–316). |
| O3 Configure | Config cascade + capability gate + env resolution | Cascade + capability gate: **Defined.** Per-prompt config schema: **Absent.** |
| O4 Availability | Host runtime: lockfile reader → template file locator | **Implicit** — the install client stores `source` and `checksum` in the lockfile, but no runtime path reads the lockfile to locate and serve `prompt.md` on demand. The connection from "installed" to "loadable by id" is a convention only. |
| O5 Lifecycle | Install modes + promotion event + disable/uninstall | Install modes: **Defined.** Host event bus + promotion: **Absent.** |
| H1 Load template | Template loader: lockfile → `prompt.md` content | **Absent** — no loader exists in the framework. |
| H2 Inject parameters | Template renderer: parameter schema + substitution engine | **Absent** — no parameter schema and no substitution engine. |

> **The seam.** The discovery/install/configure/cascade/capability spine is governed. The **template-loading and parameter-injection** rows (H1, H2) are where the framework's contracts disappear entirely. For `prompt`, the seam is sharper and simpler than for process-based types: there is no activation, no transport, and no dispatch chain — the whole runtime value of the type is constituted by two operations (load, inject) that are fully Absent.

---

## Layer 2 — Output Contracts

| Contract | Interface specified by the framework? | Clarity |
|---|---|---|
| **Manifest** (`extension.json`) | Yes — manifest schema (`schemas/extension/v1.json`). `prompt` type is recognized; `entrypoint` is explicitly omitted (schema line 43–44). | **Defined** (shape only — the schema does not check that `prompt.md` exists at the declared path, that parameter names in the manifest match those in the template, or that declared parameters are complete). |
| **Catalog record** | Partially — projection of manifest; carries `type`, `description`, `source`, `checksum`, `compatibility`. No parameter declarations projected. | **Implicit** — a prompt's parameters and rendering contract are undiscoverable from the catalog alone. |
| **Lockfile entry** | Yes — lockfile schema + checksum. The checksum covers `prompt.md` content (`scripts/build-index.ts` lines 144–146). | **Defined** — uniquely for `prompt`, the artifact being checksummed (the `.md` file) *is* the distributable; there is no separate build step to go wrong. This is the one structural advantage of the static-asset model. |
| **Template asset** (`prompt.md`) | Convention only — the scaffolder emits a file named `prompt.md` with YAML frontmatter (`scripts/new-extension.ts` lines 151–173); `build-index.ts` and `install.ts` treat this filename as canonical. No schema specifies the frontmatter fields, parameter types, or template syntax. | **Implicit** — the `prompt.md` convention is real but unschematized. |
| **Parameter declarations** (the names, types, and required-ness of template parameters) | No — the `greeting-prompt/prompt.md` frontmatter (lines 5–13) declares `name` and `context` parameters with types and descriptions; this shape is author-invented and not validated by any framework component. The manifest schema has no `parameters` field. | **Absent** — parameter declarations exist only in the template file's frontmatter; their format is undeclared and unverified. A host cannot discover or validate parameters without reading and parsing the `.md` file with a parser it supplies itself. |
| **Template syntax contract** (the substitution syntax — `{{name}}`, `{{#if context}}`, etc.) | No — the `greeting-prompt/prompt.md` uses Handlebars-style syntax (lines 16–31); no framework component specifies this syntax, and no component validates that parameters declared in frontmatter match placeholders in the body. | **Absent** — every tenant chooses a substitution syntax; every host must implement a matching renderer; no two tenants are required to agree. |
| **Lifecycle descriptor** (`lifecycle{}`) | Explicitly prohibited — `validate-manifests.ts` line 356 rejects `lifecycle` on prompt type (same rule as hook/command/skill). | **Defined** (the prohibition is enforced; prompts are static assets, not supervised daemons). |
| **Config contract** | No per-prompt schema; config is an open object. | **Implicit.** |
| **Capability declaration** (`requires`) | Checked against the capabilities asset at install time. | **Defined.** |
| **Resource/permission contract** | Nothing declares or bounds what a host may do with the rendered template text. | **Absent** (less critical for a read-only asset than for process-based types, but relevant if templates can instruct the host to access external systems). |

> The **Absent** rows manufacture specific tenant defects. With no parameter-declaration contract, a host cannot validate that all required parameters are supplied before rendering — type errors and missing substitutions surface only in the model's output, not at invocation time. With no template-syntax contract, tenants use incompatible substitution formats; a host that implements Jinja2 cannot render a Handlebars template. With no template-loading contract, the host must discover `prompt.md` by convention and implement its own file-resolution path from the lockfile.

---

## Layer 3 — Contract Sources

| Contract | Origin (authored / generated / resolved / runtime) | Governed at origin? |
|---|---|---|
| Manifest | authored | Yes (schema-validated at CI via `validate-manifests.ts`). |
| Catalog record | generated from manifest | Generation exists (`build-index.ts`); parameter declarations not projected — ungoverned for prompt-specific metadata. |
| Lockfile entry | resolved at install | Yes. Checksum covers `prompt.md` directly — no intermediate build step. |
| Template asset (`prompt.md`) | authored | Convention only — filename is canonical by framework convention; frontmatter schema and body syntax are ungoverned. |
| Parameter declarations | authored (frontmatter in `prompt.md`) | **No schema → ungoverned.** The validator does not parse `prompt.md`; any frontmatter format passes. |
| Template syntax | authored (body of `prompt.md`) | **No syntax contract → ungoverned.** Substitution markers are invisible to all framework components. |
| Config contract | authored (manifest + scope config files) | **No per-extension schema → ungoverned.** |
| Capability declaration | authored (manifest) | Yes. |
| Resource/permission | (not declared anywhere) | **No origin → ungoverned.** |

---

## Layer 4 — Producing Subsystems (primary hole map)

| # | Transition | Owning subsystem | Clarity | If not Defined → what the tenant must improvise (where drift enters) |
|---|---|---|---|---|
| 1 | intent → **manifest** | scaffolder + schema + validator | **Defined**, but validation asserts shape only — it does not check that `prompt.md` exists, that frontmatter is well-formed, or that any declared parameters exist in the template body. | A tenant can pass validation with a missing `prompt.md` or a frontmatter parameter that is never used in the body. |
| 2 | manifest → **catalog record** | registry/index builder (`build-index.ts`) | **Implicit** — the catalog projects `type`, `description`, `source`, `checksum` but no parameter declarations, making prompts undiscoverable by parameter name or template purpose. | Each tenant guesses what metadata makes its prompt discoverable; hosts cannot programmatically enumerate required parameters without reading and parsing `prompt.md`. |
| 3 | manifest + `prompt.md` → **lockfile** | install client (`install.ts`) | **Defined** — the install client checksums `prompt.md` directly (`install.ts` lines 312–316). Unlike process-based types, the checksummed artifact *is* the distributable; there is no build-step gap between source and artifact. | — (no build step means the lockfile correctly pins the exact file the host will read). |
| 4 | source → **distributable artifact** | build/output-generation subsystem | **N/A for `prompt`** — the source *is* the artifact (`prompt.md`). There is no compile step; the framework's build contract gap that is high-severity for process-based types does not apply here. The `package.json` for `greeting-prompt` confirms: `"typecheck": "echo \"No TypeScript source for prompt type\""` (`extensions/prompts/greeting-prompt/package.json` line 10). | — (the static-asset model eliminates this hole for `prompt`). However, if a future `prompt` variant incorporates generated content, this row becomes relevant immediately. |
| 5 | author → **parameter declarations** | (ecosystem should enforce a `parameters` field in the manifest schema, or a validated frontmatter schema) | **Absent** | Every prompt tenant invents its own frontmatter schema (`greeting-prompt/prompt.md` lines 5–13 uses `name`/`type`/`required`/`description`; the scaffolder template uses a different subset). A host must parse the frontmatter with a parser it selects, against a schema it invents, with no guarantee the result matches what the template body expects. **Root cause of "host cannot validate parameters before rendering."** |
| 6 | source → **template syntax declaration** | (schema + validator) | **Absent** — no field declares which substitution engine a template requires (Handlebars, Jinja2, simple `{{key}}`, etc.). | A host that renders with the wrong engine produces malformed output silently. No validator can flag a syntax mismatch between declared parameters and template placeholders. **Root cause of "rendered output contains unreplaced markers."** |
| 7 | artifact + version → **published package** | versioning/release (Changesets) | **Defined** — Changesets publishes the npm package; `package.json` `files` field lists `["prompt.md", "extension.json"]` (`extensions/prompts/greeting-prompt/package.json` line 6). No build step needed, so the published package is directly usable. | — (the static-asset model means #7 is unambiguously trustworthy for `prompt`, unlike process-based types where #7 is blocked by #4). |
| 8 | installed set → **template available to host by id** | host runtime: lockfile reader + template file locator | **Absent** | Nothing reads the lockfile, maps an extension id to its `source` path, fetches `prompt.md`, and returns its content to a caller. Every host must implement this resolution path from scratch. **Root cause of "installed but unreachable at runtime."** |
| 9 | raw template text + parameter values → **rendered prompt delivered to consumer** | host runtime: parameter injector / template renderer | **Absent** — no renderer, no parameter validator, no injection contract. | The host must implement parameter validation (are required params supplied?), substitution (which syntax?), and delivery (as a system prompt? a user turn? a tool response?). Every host invents a different answer. **Root cause of "prompt installed but parameters ignored."** |
| 10 | scope config → **applied config** | cascade + config schema | Cascade **Defined**; per-prompt config schema **Absent** | A prompt's config keys are unvalidated; typos pass silently. |
| 11 | requires + capabilities → **gate decision** | capability gate (`provider-capabilities.ts`) | **Defined** | — |
| 12 | event/lifecycle signal → **prompt lifecycle reaction** | host event bus | **Absent** — the `prompt` type has no process lifecycle; events relevant to prompts (e.g., "new conversation started, inject system prompt") are unspecified. | A host that wants to inject a prompt at conversation start must wire that event itself, with no guidance from the framework on when injection is expected to occur. |

### The shape of the hole map

- **Defined (framework holds the line):** rows 1\*, 2\*, 3, 7, 11 — the authoring → distribution spine. (\* with the noted incompleteness in 1 and 2.) Row 3 and row 7 are both genuinely trustworthy for `prompt` — the static-asset model means the lockfile pins the exact artifact that gets published, with no build step to go wrong.
- **Absent (tenant on its own):** rows 5, 6, 8, 9, 12 — the entire template-declaration → loading → rendering → injection seam.
- **N/A:** row 4 — the build/output-generation gap that is the linchpin hole for process-based types does not apply to `prompt`.

The "spine contracted, seam not" thesis reproduces for `prompt`, but with a **type-specific deviation
that matters**: the build contract gap (#4) that is the highest-severity hole for `mcp-server`, `hook`,
`command`, `agent`, and `skill` is structurally absent for `prompt` because the source is the artifact.
This makes rows #3 and #7 genuinely trustworthy rather than nominally trustworthy for this type.

The seam for `prompt` is therefore narrower in row count but no less consequential: the two Absent
rows that constitute the entire runtime value of the type (H1 load, H2 inject — mapped to rows 8 and
9) are fully uncontracted. Additionally, `prompt` has two unique Absent rows — parameter declarations
(#5) and template syntax (#6) — that have no direct analogue in process-based types. Because a prompt
extension's value is entirely in the fidelity of parameter rendering, the absence of #5 and #6 means
the framework provides no path from "installed prompt" to "correctly rendered text" — the whole seam
must be invented by every host independently.

---

## The `prompt` runtime contract the framework still owes

These are the seam contracts a complete `prompt` guideline must define — today they are Absent.
This is where prompt-specific drift enters.

- **Parameter-declaration contract (#5) — manifest `parameters` field or validated frontmatter schema:** the framework must specify a machine-readable, schema-validated declaration of each template parameter (`name`, `type`, `required`, `description`) — either as a field in `extension.json` or as a validated YAML frontmatter block in `prompt.md` with a published JSON Schema. Currently the only parameter declarations live in the `greeting-prompt/prompt.md` frontmatter (lines 5–13) with no schema backing them; the manifest has no `parameters` field; and the validator does not parse `prompt.md` at all. Without this contract: (a) a host cannot enumerate required parameters before rendering; (b) the validator cannot reject a template whose frontmatter omits a parameter used in the body; (c) the registry cannot surface "prompts with a `name` parameter" to operators without loading and parsing each `prompt.md` independently.

- **Template syntax contract (#6) — a `template_engine` manifest field with a closed enum:** the framework must require a prompt to declare which substitution engine its body is written for (e.g., `handlebars`, `jinja2`, `simple` for `{{key}}` only). Without this, a host implementing one engine silently produces incorrect output for templates authored for another. The validator cannot flag a mismatch between declared parameters and body placeholders. The `greeting-prompt` uses Handlebars-style syntax (`{{name}}`, `{{#if context}}`) without declaring it.

- **Template-loading contract (#8) — a loader API the host calls:** the framework must specify how a host, given an extension id, reads the lockfile, resolves the `source` path for that id, fetches `prompt.md`, and returns its raw content. Currently nothing implements or specifies this path; each host must invent its own file-resolution logic from the lockfile. A framework-owned loader (even a thin one that returns the raw file bytes and parsed frontmatter) would make this contract Defined.

- **Parameter-injection contract (#9) — a rendering interface the host implements against:** the framework must specify the rendering contract: which engine processes the template, what happens when a required parameter is missing (error vs. empty-string substitution vs. template literal), and how the rendered text is delivered to the consuming context (system prompt injection, user-turn prepend, tool response, etc.). Without this contract, every host implements a different rendering behavior; prompts that work in one host are silently broken in another.

- **Discovery contract (#1, O1 deviation) — a `parameters` projection in the catalog:** once #5 is defined, `build-index.ts` must project parameter declarations into `registry/index.json` so that an operator (or orchestrator) can enumerate a prompt's required inputs from the catalog without fetching and parsing `prompt.md`.

- **Config-schema contract (#10):** a per-prompt config schema so that any config keys a prompt reads at render time are declared, typed, and validated at install rather than discovered by reading source.

---

## Notes for the author of the NEXT type document

The invariant spine (scaffold → schema → validate → build → version → install/cascade → capability
gate) should read consistently across every `docs/guidelines/*.md`. The **activation + consumption**
seam is what each type's document exists to specify. If your finding does NOT reproduce the
"spine contracted, seam not" shape, that is itself a notable result — say so and explain why.
