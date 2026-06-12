<!--
================================================================================
TEMPLATE — Extension Framework Contracts (per extension type)
================================================================================
This is the shared skeleton for every `docs/guidelines/<type>.md`. The completed
reference instance is `docs/guidelines/mcp.md`.

HOW TO USE
- Copy this file to `docs/guidelines/<type>.md` and replace every `<...>` placeholder.
- Blocks marked “(INVARIANT — copy verbatim)” are identical across all seven types
  (`agent`, `skill`, `mcp-server`, `prompt`, `hook`, `command`, `bundle`). Do NOT
  reword them — cross-type consistency is the point.
- Blocks marked “(FILL)” are type-specific. Derive their content by INSPECTING THE
  ACTUAL REPO (`schemas/`, `scripts/`, `extensions/`, `registry/`, `bin/`,
  `package.json`, CI, `dist/`, `docs/`) — not by assuming.
- STRIP ANNOTATIONS BEFORE SAVING: the finished `docs/guidelines/<type>.md` must
  contain NO `<!-- ... -->` comments — delete this entire header block and every
  `(INVARIANT — copy verbatim)` / `(FILL)` marker on the section headers. The
  reference instances (`mcp.md`, `hook.md`) carry no annotations; yours must match.

THE CORE METHOD (do not lose this)
- This document grades the FRAMEWORK’s contracts, never a tenant. Causal direction is
  fixed: tenant correctness is downstream of contract clarity. Where the framework
  leaves a contract absent/implicit/declared-but-unimplemented, every tenant must
  improvise it, and improvisation is indistinguishable from drift. So a “wrong”
  tenant is the predictable output of an uncontracted region — say so, generically;
  never cite a specific tenant’s bug.
- Mark every contract with the clarity legend. A “hole” is any row that is not Defined.
- Expect the invariant finding to reproduce: the authoring→distribution SPINE is
  contracted; the build→activation→consumption→eventing SEAM is not. Your job per
  type is to pin down EXACTLY which seam contracts THIS type needs.
- BUILD/OUTPUT-GENERATION (Layer 4 #4) is a framework-owned contract and the linchpin
  of the whole map: the framework — not the tenant — should deterministically and
  uniformly generate every extension's distributable artifacts from source. Any
  hand-maintained build output anywhere in the repo is the DIAGNOSTIC that this
  contract is Absent; flag it, and note that it silently nullifies the otherwise-
  Defined lockfile (#3) and release (#7) rows (you can pin/publish an artifact that
  was never correctly generated). Treat #4 as high-severity in every type document.

QUALITY BAR
- Every clarity verdict must be defensible from repo evidence (you may cite a path /
  symbol). Distinguish Absent (never built) from Declared-unimplemented (a shape
  exists, nothing honors it) from Implicit (convention, unenforced).
- Layer 4 is the centerpiece: its “what the tenant must improvise” column is where you
  root-cause drift back to a framework slot.
================================================================================
-->

# Extension Framework Contracts — `<TYPE>`

> **Status of this document:** instance of the shared per-extension-type contract document.
> The ecosystem has seven types (`agent`, `skill`, `mcp-server`, `prompt`, `hook`, `command`,
> `bundle`). Each gets its own `docs/guidelines/<type>.md`, all built on the same five-layer model.
> Reference instance: `docs/guidelines/mcp.md`.

---

## Operating principle (read first)   <!-- (INVARIANT — copy verbatim) -->

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

## The layer model (type-agnostic)   <!-- (INVARIANT — copy verbatim) -->

| Layer | Section | Question | Contract it governs |
|---|---|---|---|
| 0 | **Ecosystem User Actions (Usage)** | Who uses this type and what do they do? | The behaviors the framework promises consumers. |
| 1 | **Action-Supporting Systems** | Which system serves each action? | Which subsystem owns each promise. |
| 2 | **Output Contracts** | What artifacts pass between systems? | The interfaces between subsystems. |
| 3 | **Contract Sources** | Where does each artifact originate? | Authored vs generated vs resolved vs runtime. |
| 4 | **Producing Subsystems** | Which subsystem produces each artifact, and *is that production contracted?* | The framework's responsibility map — the primary hole map. |

---

## Layer 0 — Ecosystem User Actions (Usage)   <!-- (FILL) -->

<!-- Identify THIS type's consumers. For tool/server types the runtime consumer is an agent; for
     hook/command/prompt it may be the host or the operator. Keep the Operator install/configure/
     lifecycle actions (spine); replace the runtime-consumption actions for this type. Mark each
     PROMISE's clarity. -->

**Consumers:** `<who consumes this type — e.g. Operator + Agent + Host>`. The **Author** is the
producer whose outputs Layers 2–4 trace back to.

| # | Consumer | Action | Framework promise | Clarity |
|---|---|---|---|---|
| O1 | Operator | Discover | `<promise>` | `<clarity + why>` |
| O2 | Operator | Install at scope | "Install at org/user/project/local; narrower overrides broader." | `<clarity>` |
| O3 | Operator | Configure | `<promise>` | `<clarity>` |
| O4 | Operator | Rely on activation | `<how THIS type is activated/consumed at runtime>` | `<clarity>` |
| O5 | Operator | Manage lifecycle | "Upgrade, disable, uninstall, promotion behave predictably." | `<clarity>` |
| `<Cx>` | `<runtime consumer>` | `<consume action(s) specific to this type>` | `<promise>` | `<clarity>` |

---

## Layer 1 — Action-Supporting Systems   <!-- (FILL: keep spine rows; re-mark activation+consumption) -->

| Action | Owning system | Exists as a framework contract? |
|---|---|---|
| O1 Discover | Registry + discovery command | `<verdict>` |
| O2 Install | Install client + CLI + cascade + lockfile | `<verdict — usually Defined>` |
| O3 Configure | Config cascade + capability gate + env resolution | `<verdict>` |
| O4 Activation | `<the host runtime path that activates THIS type>` | `<verdict>` |
| O5 Lifecycle | Install modes + promotion event + disable/uninstall | `<verdict>` |
| `<consume>` | `<the system that delivers THIS type to its runtime consumer>` | `<verdict>` |

> **The seam.** State, for this type, where the contracts thin out — typically the activation +
> consumption rows. Note that the seam is structural (recurs across types), not tenant-specific.

---

## Layer 2 — Output Contracts   <!-- (FILL: keep manifest/catalog/lockfile/config/capability; replace runtime-contract rows) -->

| Contract | Interface specified by the framework? | Clarity |
|---|---|---|
| **Manifest** (`extension.json`) | `<schema yes/no; shape vs behavior>` | `<clarity>` |
| **Catalog record** | `<...>` | `<clarity>` |
| **Lockfile entry** | `<...>` | `<clarity>` |
| **Runnable entrypoint** (if this type has runtime) | `<...>` | `<clarity>` |
| **`<type runtime contract>`** (e.g. event-binding for hook; verb+argv for command; transport for mcp) | `<...>` | `<clarity>` |
| **`<type interface descriptors>`** (the machine-readable declaration of what this type exposes) | `<...>` | `<clarity>` |
| **Lifecycle descriptor** (if applicable) | `<shape vs behavior>` | `<clarity>` |
| **Config contract** | `<per-extension schema? no?>` | `<clarity>` |
| **Capability declaration** (`requires`) | `<checked against capabilities asset?>` | `<clarity>` |
| **Resource/permission contract** | `<does the framework bound what this type may touch?>` | `<clarity>` |

> Call out the **Absent** rows and name, generically, the tenant defect each one manufactures.

---

## Layer 3 — Contract Sources   <!-- (FILL: adjust runtime-contract origins) -->

| Contract | Origin (authored / generated / resolved / runtime) | Governed at origin? |
|---|---|---|
| Manifest | authored | `<...>` |
| Catalog record | generated | `<...>` |
| Lockfile entry | resolved | `<...>` |
| `<runnable entrypoint>` | `<...>` | `<...>` |
| `<type runtime contract>` | `<...>` | `<...>` |
| `<type interface descriptors>` | `<...>` | `<...>` |
| Config contract | authored | `<...>` |
| Capability declaration | authored | `<...>` |
| Resource/permission | `<...>` | `<...>` |

---

## Layer 4 — Producing Subsystems (primary hole map)   <!-- (FILL: rows 1–4,7,10,11 shared; re-mark 5,6,8,9,12) -->

| # | Transition | Owning subsystem | Clarity | If not Defined → what the tenant must improvise (where drift enters) |
|---|---|---|---|---|
| 1 | intent → **manifest** | scaffolder + schema + validator | `<clarity + any shape-vs-resolvability gap>` | `<consequence>` |
| 2 | manifest → **catalog record** | registry/index builder | `<clarity>` | `<consequence>` |
| 3 | manifest + package → **lockfile** | install client | `<clarity>` | `<consequence>` |
| 4 | source → **distributable artifacts** | build/output-generation subsystem (framework-owned) | `<clarity — Absent if any output is hand-maintained>` | `<consequence — note it nullifies #3 and #7; framework should make hand-maintained output unnecessary>` |
| 5 | author → **`<type runtime contract>`** | `<owner>` | `<clarity>` | `<consequence>` |
| 6 | source → **`<type interface descriptors>`** | `<owner>` | `<clarity>` | `<consequence>` |
| 7 | artifact + version → **published package** | versioning/release | `<clarity>` | `<consequence>` |
| 8 | installed set + entrypoint + lifecycle → **`<activated runtime for this type>`** | host runtime: loader + supervisor | `<clarity>` | `<consequence>` |
| 9 | runtime output → **`<delivered to consumer>`** | host runtime: `<registrar/dispatcher for this type>` | `<clarity>` | `<consequence>` |
| 10 | scope config → **applied config** | cascade + config schema | `<clarity>` | `<consequence>` |
| 11 | requires + capabilities → **gate decision** | capability gate | `<clarity — usually Defined>` | `<consequence or —>` |
| 12 | event/lifecycle signal → **`<reaction for this type>`** | host event bus | `<clarity>` | `<consequence>` |

### The shape of the hole map   <!-- (FILL: summarize which rows are spine vs seam for this type) -->

- **Defined (framework holds the line):** `<rows>` — the authoring→distribution spine.
- **Absent / declared-unimplemented (tenant on its own):** `<rows>` — the seam.

`<One paragraph: confirm or refute the cross-type thesis — spine contracted, seam not — using this
type's rows, and note any type-specific deviation.>`

---

## The `<TYPE>` runtime contract the framework still owes   <!-- (FILL) -->

<!-- Enumerate the seam contracts a complete <TYPE> guideline must DEFINE that are currently Absent or
     declared-unimplemented. This is the heart of the per-type document. -->

- **`<contract name>`:** `<what it must specify + the validation/enforcement that would make it Defined>`
- `<...>`

---

## Notes for the author of the NEXT type document   <!-- (INVARIANT — copy verbatim) -->

The invariant spine (scaffold → schema → validate → build → version → install/cascade → capability
gate) should read consistently across every `docs/guidelines/*.md`. The **activation + consumption**
seam is what each type's document exists to specify. If your finding does NOT reproduce the
“spine contracted, seam not” shape, that is itself a notable result — say so and explain why.
