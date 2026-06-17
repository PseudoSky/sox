# Extension Framework Contracts — `mcp-server`

> **Status of this document:** reference instance of a shared, per-extension-type contract document.
> The ecosystem has seven types (`agent`, `skill`, `mcp-server`, `prompt`, `hook`, `command`,
> `bundle`). Each gets its own `docs/guidelines/<type>.md`, all built on the **same five-layer model**.
> `mcp-server` is written first as the canonical example; the others re-instantiate the identical
> skeleton.

---

## `mcp-server` is `service[transport=stdio]`

> **[mcp-as-service]** — As of the `tokenguard-service` plan, `mcp-server` is formally treated as
> `service[transport=stdio]` for all routing purposes. The type name `mcp-server` is a **back-compat
> alias** that remains valid indefinitely — no existing `extension.json` needs to change.
>
> **What this means:**
> - `mcp-server` extensions install and run through the **unified service model** — the same
>   `run-service` capability and supervisor path used by `type: service` extensions.
> - Transport is always `stdio` (JSON-RPC lines). The install descriptor should declare both
>   `serves: ['stdio']` (back-compat) and `transports: ['stdio']` (unified field).
> - The `service[transport=stdio]` equivalence is enforced at install routing time in
>   `libs/install-engine/src/install.ts` (`isServiceInstall` check).
> - The supervisor spawns and supervises `mcp-server` processes identically to `service` processes.
>
> **Cross-reference:** See [`docs/guidelines/service.md`](./service.md) for the full unified service
> model contract, transport vocabulary, and lifecycle semantics.
>
> **Invariant ([inv:no-regress-mcp]):** `mcp-server` remains a valid manifest `type`; `memory-server`
> (the reference mcp-server implementation) non-regresses across its full lifecycle
> (build/validate/install/start/health/stop) **and** the C6 forbidden-write denial at every audit hold
> point. Verified by `bash tools/tg-plan/check-memory-nonregress.sh` → `MEMORY OK` + `C6 DENY OK`.

---

## Operating principle (read first)

This document exists to find holes in the **framework**, not to grade any tenant.

The causal direction is fixed: **tenant correctness is downstream of contract clarity.** A tenant can
only be as correct as the contracts the framework defines and enforces. Wherever the framework leaves
a contract *absent*, *implicit*, or *declared-but-unimplemented*, every tenant is forced to improvise
that contract privately — and a privately-improvised contract is, by definition, unverifiable and
free to drift. So when a first tenant looks "wrong," the correct reading is almost always: *the
framework never gave it a contract to be right against.*

Therefore each layer below does two things:
1. **States the contract** the framework owes an `mcp-server` tenant at that layer.
2. **Marks the contract's current clarity**, using this legend:

| Clarity | Meaning | Consequence for tenants |
|---|---|---|
| **Defined** | Specified *and* enforced — a tenant cannot violate it silently. | None — the framework holds the line. |
| **Implicit** | Relied on by convention; not specified or not enforced. | Tenants comply by luck; reviewers catch drift, or nobody does. |
| **Declared-unimplemented** | A contract *shape* exists (e.g. a manifest block) but nothing honors it at runtime. | Worst case — it *looks* governed, so the gap is invisible until integration. |
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
| 4 | **Producing Subsystems** | Which subsystem produces each artifact, and *is that production contracted?* | The framework's own responsibility map — the primary hole map. |

---

## Layer 0 — Ecosystem User Actions (Usage)

**Consumers:** the **Operator** (a human granting their agent a capability) and the **Agent** (the
runtime LLM that discovers and calls tools). The **Author** is the producer whose outputs Layers 2–4
trace back to.

| # | Consumer | Action | Framework promise | Clarity |
|---|---|---|---|---|
| O1 | Operator | Discover | "You can find what exists and learn when to use it before installing." | **Implicit** — a registry record exists; the *discovery contract* (what metadata a record must carry to be discoverable) is not specified. |
| O2 | Operator | Install at scope | "You can install at org/user/project/local and narrower overrides broader." | **Defined** — the scope/cascade contract is specified and enforced. |
| O3 | Operator | Configure | "You can set the extension's config and secrets, validated before they reach it." | **Implicit** — config cascades, but the framework defines no per-extension config *schema*, so nothing validates what a tenant accepts. |
| O4 | Operator | Rely on activation | "Once installed+enabled, it runs and stays running without manual wiring." | **Declared-unimplemented** — the activation contract is the type's whole point and is the largest hole (see Layer 4 #8/#9). |
| O5 | Operator | Manage lifecycle | "Upgrade, disable, uninstall, and cross-scope promotion all work predictably." | **Implicit/Absent** — install modes exist; disable/uninstall/promotion semantics are partially conventional. |
| A1 | Agent | See tools | "The agent's tool surface gains this extension's tools, with when-to-use guidance." | **Absent** — nothing registers a tool into an agent surface. |
| A2 | Agent | Invoke tools | "The agent calls a tool with typed args and gets a typed result." | **Implicit** — the transport works if the tenant implements MCP, but the framework neither specifies nor verifies that it did. |

> The promises that are **Defined** are exactly the ones a tenant cannot get wrong. Every other row is
> a place a tenant is on its own.

---

## Layer 1 — Action-Supporting Systems

For each action, the system that must own it — and whether the framework actually fields that system.

| Action | Owning system | Exists as a framework contract? |
|---|---|---|
| O1 Discover | Registry + discovery command | Registry: **yes**. Discovery command (search/describe surfaced to operator & agent): **Absent**. |
| O2 Install | Install client + CLI + cascade + lockfile | **Defined.** |
| O3 Configure | Config cascade + capability gate + env resolution | Cascade + capability gate: **Defined.** Per-extension config schema: **Absent.** |
| O4 Activation | **Host runtime**: loader → supervisor → registrar | **Declared-unimplemented** — the `lifecycle` *shape* is in the schema; no loader/supervisor/registrar honors it. |
| O5 Lifecycle | Install modes + promotion event + disable/uninstall | Install modes: **Defined.** Event bus + promotion: **Declared-unimplemented.** |
| A1 See tools | MCP registrar + tool self-description | **Absent.** |
| A2 Invoke tools | MCP transport | **Implicit** (tenant-implemented, unverified). |

> **The seam.** Discovery/install/configure/cascade/capability are framework-owned and real. The
> **activation + consumption** systems (rows O4, A1, A2, and the event half of O5) are where the
> framework's contracts thin out to *declared-unimplemented* or *absent*. Every type's document will
> show the same shape, because the seam is structural, not tenant-specific.

---

## Layer 2 — Output Contracts

The artifacts subsystems exchange. The hole question per artifact: **is its interface specified, or
must each tenant define it privately?**

| Contract | Interface specified by the framework? | Clarity |
|---|---|---|
| **Manifest** (`extension.json`) | Yes — manifest schema. | **Defined** (shape only — see Layer 4 #1 for what the schema does *not* assert). |
| **Catalog record** | Partially — projection of manifest; no required discovery fields. | **Implicit.** |
| **Lockfile entry** | Yes — lockfile schema + checksum. | **Defined** (but "what is the artifact it pins?" is undefined — inherits the build hole). |
| **Runnable entrypoint** | No — the framework defines no contract for what `entrypoint` must resolve to or how it's produced. | **Absent.** |
| **Runtime transport contract** | No — "mcp-server" implies MCP, but the handshake/methods a server must implement are nowhere specified or verified. | **Absent.** |
| **Tool descriptors** (`{name, description, inputSchema}`) | No — tool interfaces exist only at runtime; the manifest carries no machine-readable per-tool contract. | **Absent** — capabilities cannot be discovered or validated without executing the extension. |
| **Lifecycle descriptor** (`lifecycle{}`) | Shape yes, behavior no. | **Declared-unimplemented.** |
| **Config contract** | No per-extension schema; config is an open object. | **Implicit.** |
| **Capability declaration** (`requires`) | Yes — checked against the model-capabilities asset. | **Defined.** |
| **Resource/permission contract** (what the extension may touch: fs, network, sockets) | No — nothing declares or bounds an extension's resource access. | **Absent.** |

> The **Absent** rows here are the framework holes that *manufacture* tenant defects: with no
> entrypoint-production contract a tenant ships an unrunnable artifact; with no transport contract a
> tenant re-derives the protocol by hand; with no tool-descriptor contract a tenant's capabilities are
> undiscoverable; with no resource contract a tenant's access is unbounded. None of these are tenant
> mistakes — they are unfilled framework slots.

---

## Layer 3 — Contract Sources

Where each artifact's content originates. (Structure is largely type-invariant; included for
completeness and to show which origins are *governed*.)

| Contract | Origin | Governed at origin? |
|---|---|---|
| Manifest | authored | Yes (schema-validated). |
| Catalog record | generated from manifest | Generation exists; required-field contract Implicit. |
| Lockfile entry | resolved at install | Yes. |
| Runnable entrypoint | should be *generated* from source | **No build contract → ungoverned.** |
| Runtime transport | authored (server source) | **No transport contract → ungoverned.** |
| Tool descriptors | authored in source; emitted at runtime | **No descriptor contract → ungoverned at rest.** |
| Lifecycle descriptor | authored (manifest) | Shape governed; behavior ungoverned. |
| Config contract | authored (manifest + scope files) | **No schema → ungoverned.** |
| Capability declaration | authored (manifest) | Yes. |
| Resource/permission | (not declared anywhere) | **No origin → ungoverned.** |

---

## Layer 4 — Producing Subsystems (primary hole map)

For each source→artifact transition: the subsystem that should own it, **whether that production is
contracted**, and — the causal payoff — **what a tenant is forced to improvise when it is not.**

| # | Transition | Owning subsystem | Clarity | If not Defined → what the tenant must improvise (where drift enters) |
|---|---|---|---|---|
| 1 | intent → **manifest** | scaffolder + schema + validator | **Defined**, but validation asserts *shape*, not *resolvability* (it does not check the entrypoint exists, that declared tools are real, or that config keys are known). | A tenant can pass validation with a dangling entrypoint and undiscoverable tools. |
| 2 | manifest → **catalog record** | registry/index builder | **Implicit** — no required discovery metadata; no search surface. | Each tenant guesses what makes it discoverable. |
| 3 | manifest + package → **lockfile** | install client | **Defined** — but "package" is undefined (inherits #4). | Lockfile pins source files, not built artifacts. |
| 4 | source → **distributable artifacts** | **build / output-generation subsystem (framework-owned)** | **Absent** | The framework owns no deterministic build, so each tenant invents one or **hand-maintains `dist/` by hand** — the hand-maintained mirror is itself the diagnostic that this contract is Absent. Outputs may not exist, may not match source, and drift silently. **Highest-leverage hole: it silently nullifies the otherwise-Defined rows #3 (lockfile) and #7 (release) — you can pin and publish an artifact that was never correctly generated.** |
| 5 | author → **runtime transport** | (ecosystem should supply the type's transport spec) | **Absent** | Every tenant re-implements the MCP handshake by hand, unverified. |
| 6 | source → **tool descriptors** | tool-surfacing path (manifest mirror + runtime) | **Absent** | A tenant's real capabilities live only in code; nothing can list/validate them at rest. **Root cause of "undiscoverable capabilities."** |
| 7 | artifact + version → **published package** | versioning/release | **Defined** but blocked by #4. | Release ships an artifact that may not load. |
| 8 | installed set + entrypoint + lifecycle → **loaded, supervised process** | **host runtime: loader + supervisor** | **Declared-unimplemented** | Nothing runs the extension. **Root cause of "installed but inert."** |
| 9 | running tools → **agent tool surface** | **host runtime: MCP registrar** | **Absent** | The agent never receives the tools. **Root cause of "agent can't use it."** |
| 10 | scope config → **applied config** | cascade + config schema | Cascade **Defined**; config schema **Absent** | A tenant's config keys are unvalidated; typos/secrets pass silently. |
| 11 | requires + capabilities → **gate decision** | capability gate | **Defined** | — |
| 12 | promotion convention + queue → **proposal** | host event bus | **Declared-unimplemented** | No event vocabulary; cross-scope and lifecycle signalling is improvised. |

### The shape of the hole map

- **Defined (framework holds the line):** rows 1*, 3*, 7*, 11 — the *authoring → distribution* spine.
  (\* with the noted incompleteness in 1, and 3/7 blocked by the missing build contract.)
- **Absent / declared-unimplemented (tenant on its own):** rows 4, 5, 6, 8, 9, 12 — the entire
  *build → activation → consumption → eventing* seam.

**The build/output-generation contract (#4) is the linchpin, not just one seam row.** It sits between
the contracted spine and the runtime seam, and because #3 (lockfile) and #7 (release) both depend on
it, leaving it Absent makes the framework's *strongest* contracts produce confident guarantees about
artifacts that may never have been generated correctly. The tell is concrete: any hand-maintained
build output in the repo is proof the framework is not generating outputs itself. A framework-owned,
deterministic build — one that makes hand-maintained output unnecessary and impossible — is the single
highest-value contract to define, because it converts #3 and #7 from *nominally Defined* into
*actually trustworthy*.

Every "root cause" annotation in the table lands in that seam. That is the thesis, made mechanical:
**the framework is well-contracted up to `install`, and uncontracted from `install` onward** — so any
tenant's runtime "incorrectness" is the predictable output of the uncontracted region, not a property
of the tenant.

---

## The `mcp-server` runtime contract the framework still owes (type-specific)

These are the seam contracts a complete `mcp-server` guideline must *define* (today they are Absent or
declared-unimplemented). This section is what each future type's document replaces with its own runtime
contract.

- **Build / output-generation contract (#4) — framework-owned, the linchpin:** the framework (not the
  tenant) must deterministically and uniformly generate every extension's distributable artifacts from
  source, so that a hand-maintained `dist/` is both unnecessary and impossible to drift; plus a
  validation gate that the declared `entrypoint` exists, is executable, and corresponds to current
  source. Until this holds, #3 (lockfile) and #7 (release) are only *nominally* Defined — they pin and
  ship artifacts whose generation was never guaranteed.
- **Transport contract (#5):** the required MCP methods (`initialize`, `tools/list`, `tools/call`),
  framing, and a conformance check the framework can run without trusting the tenant.
- **Tool-descriptor contract (#6):** a machine-readable, at-rest declaration of each tool
  (`name`, `description` as dual human+agent invocation guidance, `inputSchema`) that the registry and
  validator can read — so capabilities are discoverable before execution.
- **Activation contract (#8/#9):** the loader/supervisor/registrar behavior the `lifecycle{}` block
  currently only *names* — spawn, singleton enforcement, health probing, stop semantics, and tool
  registration into the agent surface.
- **Config-schema contract (#10):** a per-extension config schema so accepted keys are declared and
  validated.
- **Resource/permission contract:** a declaration + enforcement of what filesystem/network/socket
  resources an extension may access.
- **Event contract (#12):** a defined event vocabulary so eventing/promotion is specified, not
  improvised.

---

## Instantiating this document for a new extension type

Each `docs/guidelines/<type>.md` re-runs the same hole map. To produce one:

1. **Layer 0** — restate the consumers/actions and mark each *promise's* clarity for this type.
2. **Layer 1** — keep discovery/install/configure/cascade/capability rows (the shared spine); re-mark
   the **activation + consumption** rows for this type.
3. **Layer 2** — keep manifest/catalog/lockfile/config/capability rows; **replace the runtime-contract
   rows** (transport/descriptors) with this type's runtime artifacts and mark their clarity.
4. **Layer 3** — adjust the runtime-contract origins.
5. **Layer 4** — rows 1–4, 7, 10, 11 are shared (the spine); **re-mark rows 5, 6, 8, 9, 12** for this
   type and write the per-row "what the tenant must improvise" consequence.
6. **Runtime-contract section** — define the seam contracts this type still owes.

The invariant finding should reproduce across every type document: **the spine is contracted, the
seam is not.** The value of writing one per type is to pin down *exactly which seam contracts each
type needs* — because the seam is where the framework, and therefore every tenant on it, is currently
underdetermined.
