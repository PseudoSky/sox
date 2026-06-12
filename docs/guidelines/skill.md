# Extension Framework Contracts — `skill`

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

**Consumers:** the **Operator** (installs and configures the skill) and the **Agent / Orchestrator**
(the runtime LLM or host that discovers and invokes the skill as a callable unit of logic). The
**Author** is the producer whose outputs Layers 2–4 trace back to.

The `skill` type's runtime model is: a deterministic, synchronous or async function (`run(input)
→ output`) with no persistent process. Unlike `mcp-server`, a skill is not a long-running daemon;
unlike `hook`, it is not event-driven; unlike `command`, it is not slash-invoked. It is a
function-shaped unit the host calls directly by loading the entrypoint and calling `run`. No host
currently performs that call.

| # | Consumer | Action | Framework promise | Clarity |
|---|---|---|---|---|
| O1 | Operator | Discover | "You can find what skill extensions exist, what they do, and when to invoke them, before installing." | **Implicit** — the registry record carries `description` and `keywords`; no machine-readable `SkillInput`/`SkillOutput` schema is projected into the catalog. The operator must read `SKILL.md` prose or source to learn the invocation contract. |
| O2 | Operator | Install at scope | "Install at org/user/project/local; narrower overrides broader." | **Defined** — the scope/cascade contract is specified and enforced by `scripts/cascade.ts` and `scripts/install.ts`. |
| O3 | Operator | Configure | "Set the skill's config, validated before it reaches the skill." | **Implicit** — config cascades, but the framework defines no per-extension config schema; nothing validates what keys a skill tenant accepts. |
| O4 | Operator | Rely on activation | "Once installed, the skill is callable by the host or agent without manual wiring." | **Absent** — the framework defines no host-side loader, dispatcher, or registration path for skills. Nothing reads the lockfile, loads the skill's entrypoint, and makes `run` available to a caller. `validate-manifests.ts` line 356 confirms skill is request-response (no lifecycle block). |
| O5 | Operator | Manage lifecycle | "Upgrade, disable, uninstall, and cross-scope promotion behave predictably." | **Implicit/Absent** — install modes exist; disable/uninstall semantics are partially conventional; the promotion event bus is absent (`docs/scope-promotion.md`). |
| A1 | Agent / Orchestrator | Discover invocable skills | "The agent's invocation surface gains this skill, with input/output schema and when-to-invoke guidance." | **Absent** — nothing registers a skill into an agent's tool surface or invocation menu. `SKILL.md` exists as prose guidance but is not machine-consumed by any framework component. |
| A2 | Agent / Orchestrator | Invoke skill | "Call `run(input)` with typed args and receive a typed result; errors are surfaced uniformly." | **Absent** — the framework specifies no loader, call convention, error wrapping, or result contract. The `run` function shape (`(input: SkillInput) => Promise<SkillOutput>`) is a scaffold template convention only (`scripts/new-extension.ts` lines 105–107), not an enforced interface. |

---

## Layer 1 — Action-Supporting Systems

| Action | Owning system | Exists as a framework contract? |
|---|---|---|
| O1 Discover | Registry + discovery command | Registry record: **yes**. Discovery command (`sox search`): **Absent** (`bin/sox` line 366: `verb 'search' is not yet implemented`). `SKILL.md` contains invocation prose but is not indexed or machine-readable by any framework component. |
| O2 Install | Install client + CLI + cascade + lockfile | **Defined.** |
| O3 Configure | Config cascade + capability gate + env resolution | Cascade + capability gate: **Defined.** Per-extension config schema: **Absent.** |
| O4 Activation | Host runtime: skill loader → `run(input)` call site | **Absent** — no loader reads the lockfile, resolves the skill's `entrypoint`, imports the module, and calls `run`. No product-code caller of any skill's `run` function exists outside the skill's own `eval/` test fixture. |
| O5 Lifecycle | Install modes + promotion event + disable/uninstall | Install modes: **Defined.** Host event bus + promotion: **Absent** (`docs/scope-promotion.md` line 143). |
| A1 See skills | Skill registrar + invocation-surface descriptor | **Absent** — no registrar maps installed skills onto an agent's callable surface. `SKILL.md` is authored prose; the validator does not check its presence or its input/output contract sections. |
| A2 Invoke skill | Host runtime: skill dispatcher — load entrypoint, call `run`, return result | **Absent** — the dispatcher does not exist. The `run` export convention is unverified. |

> **The seam.** The discovery/install/configure/cascade/capability spine is governed. The
> **invocation-surface registration, activation, and dispatch** rows (O4, A1, A2, and the event half
> of O5) are fully absent. The seam for `skill` is structurally identical to `mcp-server` and `hook`
> — the same spine/seam shape recurs — but the `skill` type has a unique aggravating factor: its
> runtime value is entirely constituted by a single synchronous call (`run`), so the absence of the
> dispatcher makes every installed skill unconditionally inert. There is no transport layer or event
> bus to partially compensate.

---

## Layer 2 — Output Contracts

| Contract | Interface specified by the framework? | Clarity |
|---|---|---|
| **Manifest** (`extension.json`) | Yes — manifest schema (`schemas/extension/v1.json`). Skill requires `entrypoint` (enforced by `allOf` at schema line 190). `lifecycle` is prohibited by `validate-manifests.ts` line 356. No type-specific fields beyond `entrypoint`. | **Defined** (shape only — schema validates format; does not check that `entrypoint` exists as a built file). |
| **Catalog record** | Partially — projects `type`, `description`, `keywords`. No `SkillInput`/`SkillOutput` schema projected. | **Implicit** — the skill's invocation interface is not machine-readable in the catalog. |
| **Lockfile entry** | Yes — lockfile schema + checksum. | **Defined** (but "what artifact does it pin?" is undefined — inherits the build hole at #4). The install client checksums `src/index.ts`, not a built `dist/index.js`. |
| **Runnable entrypoint** | No — `entrypoint: "dist/index.js"` is declared in `extensions/skills/hello-world/extension.json` line 14, but no `dist/` directory exists under the skill package (confirmed by inspection). The framework has no build contract. | **Absent** — the declared entrypoint is never produced by CI. |
| **`run` function interface** (`(input: SkillInput) => Promise<SkillOutput>`) | Convention only — the scaffolder emits this signature (`scripts/new-extension.ts` lines 96–108) and `SKILL.md` documents it (`extensions/skills/hello-world/SKILL.md` lines 13–24). No schema or validator enforces the export name or its type. | **Implicit** — tenants comply because the scaffold template matches; no contract enforces it. |
| **`SkillInput` / `SkillOutput` descriptors** (machine-readable, at-rest I/O schema) | No — the manifest carries no `inputSchema`/`outputSchema` fields. Input and output types exist only in source (`extensions/skills/hello-world/src/index.ts` lines 4–11) and in `SKILL.md` prose. | **Absent** — a host cannot discover or validate the skill's interface without executing its code. |
| **`SKILL.md` invocation document** | Shape: the scaffolder emits a `SKILL.md` template with sections `Invocation guidance`, `Input contract`, `Output contract`, `Examples`, `Failure modes`, `Performance characteristics` (`scripts/new-extension.ts` lines 562–609). Behavior: the validator does not check for `SKILL.md` presence, its sections, or consistency with source. | **Implicit** — emitted by convention; not validated; not machine-consumed. |
| **Eval / golden-assertion fixture** | Not scaffolded — `scripts/new-extension.ts` emits no `eval/` directory. The `hello-world` skill carries a hand-created `eval/golden.test.ts` and `eval/goldens.json` fixture. | **Absent** as a framework contract — the eval colocation pattern exists as a single instance, not as a scaffolded or validated convention. |
| **Lifecycle descriptor** (`lifecycle{}`) | Explicitly prohibited — `validate-manifests.ts` line 356 rejects `lifecycle` on `skill` type. | **Defined** (the prohibition is enforced; skills are request-response, not supervised daemons). |
| **Config contract** | No per-extension schema; config is an open object. | **Implicit.** |
| **Capability declaration** (`requires`) | Checked against the capabilities asset at install time. | **Defined.** |
| **Resource/permission contract** | Nothing declares or bounds filesystem/network/socket access. | **Absent.** |

> The **Absent** rows here manufacture specific tenant defects. With no build contract, the declared
> `entrypoint` points to a file that does not exist. With no `run`-interface contract enforced, a
> mismatched export (wrong name, wrong arity, sync where async is expected) passes all validation
> and fails only when a host attempts to call it — a host that does not yet exist. With no
> `SkillInput`/`SkillOutput` descriptor at-rest, a host cannot validate, auto-complete, or document
> the skill's interface without introspecting source. With no `SKILL.md` validation, the invocation
> guidance document can drift from source silently. None of these are tenant mistakes — they are
> unfilled framework slots.

---

## Layer 3 — Contract Sources

| Contract | Origin (authored / generated / resolved / runtime) | Governed at origin? |
|---|---|---|
| Manifest | authored | Yes (schema-validated at CI via `validate-manifests.ts --strict`). |
| Catalog record | generated from manifest | Generation exists (`scripts/build-index.ts` line 63); I/O schema not projected — ungoverned for skill-specific interface metadata. |
| Lockfile entry | resolved at install | Yes. |
| Runnable entrypoint (`dist/index.js`) | should be *generated* from source by a per-package build step | **No build contract → ungoverned.** CI runs `pnpm typecheck` (`tsc --noEmit`); no `tsc` emit step runs. `package.json` declares `"build": "tsc"` but this is never invoked by CI or the release pipeline. |
| `run` function interface | authored (source code, guided by scaffold template) | **Convention only — not schema-enforced.** |
| `SkillInput` / `SkillOutput` descriptors | authored (source code only; mirrored in `SKILL.md` prose) | **No manifest field and no validator → ungoverned at rest.** The types are visible only after loading the module. |
| `SKILL.md` invocation document | authored (scaffold template emits a stub; tenant fills sections) | **Not validated** — the framework does not check presence, section completeness, or consistency with source types. |
| Eval / golden-assertion fixture | authored by hand (no scaffold) | **No framework contract → ungoverned.** The `eval/` pattern exists in one skill instance, created manually, not mandated or scaffolded. |
| Config contract | authored (manifest + scope config files) | **No per-extension schema → ungoverned.** |
| Capability declaration | authored (manifest) | Yes. |
| Resource/permission | (not declared anywhere) | **No origin → ungoverned.** |

---

## Layer 4 — Producing Subsystems (primary hole map)

| # | Transition | Owning subsystem | Clarity | If not Defined → what the tenant must improvise (where drift enters) |
|---|---|---|---|---|
| 1 | intent → **manifest** | scaffolder + schema + validator | **Defined**, but validation asserts shape only — it does not check that the declared `entrypoint` resolves to a built file, that `SkillInput`/`SkillOutput` types are real, or that `SKILL.md` exists and is consistent with source. | A tenant can pass validation with a dangling entrypoint, undiscoverable I/O types, and a stale `SKILL.md`. |
| 2 | manifest → **catalog record** | registry/index builder (`scripts/build-index.ts`) | **Implicit** — the catalog projects `type`, `description`, `keywords` but no `SkillInput`/`SkillOutput` schema, making skill interfaces undiscoverable at rest. | Each tenant guesses what metadata makes its skill discoverable; orchestrators cannot filter or validate skills by interface without executing them. |
| 3 | manifest + package → **lockfile** | install client (`scripts/install.ts`) | **Defined** — but "package" is undefined (inherits #4). The install client checksums `src/index.ts`, not a built artifact. | The lockfile pins a TypeScript source file, not an executable. A host that resolves the lockfile's entrypoint gets a `.js` path to a file that was never emitted. |
| 4 | source → **distributable artifacts** | **build/output-generation subsystem (framework-owned)** | **Absent** | `extensions/skills/hello-world/` has no `dist/` directory (confirmed by inspection); `extension.json` line 14 declares `entrypoint: "dist/index.js"`. CI runs `pnpm typecheck` but no `pnpm -r build`. Each package's `"build": "tsc"` script has no local `tsconfig.json`, so the emit target is structurally ambiguous. **Highest-severity hole: silently nullifies the Defined rows #3 (lockfile) and #7 (release) — the framework can pin and publish an artifact that was never generated.** |
| 5 | author → **`run` function interface + `SkillInput`/`SkillOutput` descriptors** | (framework should supply a validated export contract and manifest I/O schema fields) | **Absent** | Every skill tenant declares its own `SkillInput`/`SkillOutput` interface shapes independently, with no shared base type and no manifest-level schema. The export name (`run`) is convention, not enforced. A host that wants to call any skill must parse source or `SKILL.md` prose to discover the interface — making static dispatch impossible. |
| 6 | source → **`SKILL.md` invocation document + eval fixture** | (framework should scaffold and validate both) | **Absent** as a framework contract | The scaffolder emits a `SKILL.md` stub (`scripts/new-extension.ts` line 933) but the validator does not check its presence or content. No eval fixture is scaffolded. The `hello-world` `eval/` directory is a single hand-created instance. A host cannot verify that the `SKILL.md` contract matches the source, and tenants have no mandated eval pattern to follow. |
| 7 | artifact + version → **published package** | versioning/release (Changesets) | **Defined** but blocked by #4. | The release pipeline publishes an npm package containing no `dist/index.js`; any host that resolves the published entrypoint gets a file-not-found error. |
| 8 | installed set + entrypoint → **loaded, callable `run` function** | host runtime: skill loader | **Absent** | Nothing reads the lockfile at host startup, loads each skill's entrypoint, verifies the `run` export exists, and makes it callable. The framework provides no skill loader as a library or product-code integration point. **Root cause of "installed but uncallable."** |
| 9 | callable `run` → **skill invocation surface for agent/orchestrator** | host runtime: skill dispatcher / registrar | **Absent** | The agent never receives the skill as an invocable unit. No registrar maps installed skills onto a callable surface; no call convention specifies how the host passes `input`, handles errors, or returns `output`. **Root cause of "agent can't use it."** |
| 10 | scope config → **applied config** | cascade + config schema | Cascade **Defined**; per-extension config schema **Absent** | A skill's config keys are unvalidated; typos or wrong types pass silently. |
| 11 | requires + capabilities → **gate decision** | capability gate (`scripts/validate-manifests.ts`) | **Defined** | — |
| 12 | event/lifecycle signal → **skill lifecycle reaction** | host event bus | **Absent** (`docs/scope-promotion.md` line 143: "No host event bus is implemented in this repo.") | No event vocabulary; cross-scope and lifecycle signalling is improvised. Skills have no daemon lifecycle (the prohibition on `lifecycle{}` is correct), but install/uninstall/promotion events that a host might want to observe are still uncontracted. |

### The shape of the hole map

- **Defined (framework holds the line):** rows 1\*, 3\*, 7\*, 11 — the authoring → distribution spine.
  (\* with the noted incompleteness in 1, and 3/7 blocked by the missing build contract at #4.)
- **Absent / declared-unimplemented (tenant on its own):** rows 4, 5, 6, 8, 9, 12 — the entire
  build → activation → invocation → eventing seam.

The "spine contracted, seam not" thesis reproduces exactly for `skill`. The shape is structurally
identical to `mcp-server` and `hook`: rows 1, 3, 7, 11 are governed; rows 4–6, 8–9, 12 are not. The
type-specific deviation for `skill` is in the *depth* of the seam gap: because the skill type has
no transport layer (unlike `mcp-server`'s stdio), no event binding (unlike `hook`'s `fire()`), and
no process lifecycle (unlike `agent`'s supervision), the entire seam reduces to a single missing
call — `run(input)` — for which the framework provides no loader, no call convention, no error
wrapping, and no registration path. The `skill` type is therefore the most minimal possible seam
gap: one function call, fully uncontracted.

A secondary skill-specific deviation is at row 5/6: the `skill` type introduces two framework
artifacts not present in `mcp-server` or `hook` — the `SKILL.md` invocation document and the eval
fixture colocation pattern — that the framework scaffolds but does not validate. These are
positive contributions (the `hook` type has no equivalent) that are nonetheless currently Implicit,
not Defined, because nothing enforces their presence or consistency.

---

## The `skill` runtime contract the framework still owes

These are the seam contracts a complete `skill` guideline must define — today they are Absent or
Implicit. This section is where skill-specific drift enters.

- **Build / output-generation contract (#4) — framework-owned, the linchpin:** the framework (not
  the tenant) must deterministically and uniformly compile each skill's `src/index.ts` to the
  package's own `dist/index.js`, so that the declared `entrypoint` resolves to a real, executable
  file. `extensions/skills/hello-world/` has no `dist/` directory; CI has no `pnpm -r build` step.
  Until this holds, rows #3 (lockfile) and #7 (release) are only nominally Defined — they pin and
  publish an entrypoint that was never built. A framework-owned build makes the hand-maintained
  output unnecessary and eliminates the silent drift between source and distributable.

- **`run` export contract (#5) — enforced interface:** the framework must specify the skill handler's
  TypeScript interface — `export async function run(input: SkillInput): Promise<SkillOutput>` — as a
  validated, importable type that every skill tenant must satisfy, checked by the validator or a
  type-only package. Currently the export name and shape are a scaffold-template convention only;
  two tenants could export `execute` or `handler` and pass all checks. The validator should
  additionally require the presence and non-emptiness of the `run` export in the compiled output, or
  a manifest-level `inputSchema`/`outputSchema` that mirrors the TypeScript types.

- **`SkillInput`/`SkillOutput` descriptor contract (#5/#6):** the manifest (or a framework-owned
  companion file) must carry a machine-readable I/O schema for each skill — equivalent to the MCP
  `inputSchema` per tool — so that the registry, validator, and orchestrator can discover, validate,
  and describe the skill's interface without loading its code. Currently the types live only in
  source (`extensions/skills/hello-world/src/index.ts` lines 4–11) and in `SKILL.md` prose; nothing
  can assert they agree.

- **`SKILL.md` validation contract (#6):** the validator must check that `SKILL.md` exists for every
  skill-type extension (currently the scaffolder emits it but the validator does not check for it —
  confirmed by inspection of `scripts/validate-manifests.ts` which has no `SKILL.md` check), and
  optionally assert that its required sections (`Invocation guidance`, `Input contract`,
  `Output contract`) are present. Until this holds, `SKILL.md` is a documentation convention, not
  a framework contract, and will drift from source as skills evolve.

- **Eval / golden-assertion contract (#6):** the framework must scaffold an `eval/` directory with a
  `goldens.json` seed and a `golden.test.ts` fixture for every skill, matching the Layer 2
  deterministic pattern documented in `extensions/skills/hello-world/eval/golden.test.ts`. Currently
  `scripts/new-extension.ts` emits no `eval/` directory; the `hello-world` fixture was hand-created.
  Without scaffolding, every new skill tenant must invent the eval pattern independently, producing
  different fixture shapes. The validator should require `eval/goldens.json` to be non-empty.

- **Activation / dispatch contract (#8/#9):** the framework must specify how a host, at startup,
  reads the lockfile, loads each enabled skill's entrypoint, verifies the `run` export, and makes
  it callable to an agent or orchestrator — so that every host produces the same
  installed-skill → callable-`run` map from the same installed set. Currently no product-code
  caller of any skill's `run` function exists outside the skill's own test fixture. The framework
  provides no skill loader as a library, integration point, or specification.

- **Config-schema contract (#10):** a per-extension config schema so that skill config keys are
  declared, typed, and validated at install time rather than discovered by reading source.

- **Resource/permission contract:** a manifest declaration of what filesystem paths, network
  resources, or sockets a skill may access, so operators can audit behavior before installing and
  hosts can eventually sandbox it.

---

## Notes for the author of the NEXT type document

The invariant spine (scaffold → schema → validate → build → version → install/cascade → capability
gate) should read consistently across every `docs/guidelines/*.md`. The **activation + consumption**
seam is what each type's document exists to specify. If your finding does NOT reproduce the
"spine contracted, seam not" shape, that is itself a notable result — say so and explain why.
