# Extension Framework Contracts — `hook`

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

**Consumers:** the **Operator** (installs and configures; sets the lifecycle policy) and the **Host**
(the runtime that fires lifecycle events and dispatches hooks). There is no agent consumer: hooks
execute deterministically with no LLM calls and are invisible to the agent's tool surface. The
**Author** is the producer whose outputs Layers 2–4 trace back to.

| # | Consumer | Action | Framework promise | Clarity |
|---|---|---|---|---|
| O1 | Operator | Discover | "You can find what hook extensions exist, which events they bind, and when to install them." | **Implicit** — the registry record (`registry/index.json`) carries a `description` and `keywords` field but no machine-readable `event` binding; the operator must read prose to know which lifecycle events a hook covers. `schemas/extension/v1.json` has no `event` field. |
| O2 | Operator | Install at scope | "Install at org/user/project/local; narrower overrides broader." | **Defined** — the scope/cascade contract is specified and enforced by `scripts/cascade.ts` and `scripts/install.ts`. |
| O3 | Operator | Configure | "Set the hook's config and secrets, validated before they reach it." | **Implicit** — config cascades, but the framework defines no per-extension config schema, so nothing validates what a hook tenant accepts via environment or config. |
| O4 | Operator | Rely on activation | "Once installed, the hook fires on its declared lifecycle event without manual wiring." | **Absent** — the framework provides no host runtime. Nothing reads the lockfile, constructs a `HookLoader`, calls `loader.register()` on installed hooks, or calls `loader.fire()` when a lifecycle event occurs. The `HookLoader` class in `scripts/hook-loader.ts` implements ordering semantics but is never called by any non-test code. |
| O5 | Operator | Manage lifecycle | "Upgrade, disable, uninstall, promotion behave predictably." | **Implicit/Absent** — install modes exist; disable/uninstall semantics are partially conventional; promotion event is declared in `docs/scope-promotion.md` but the event bus it depends on is absent. |
| H1 | Host | Fire lifecycle event | "On each lifecycle event, all installed, enabled hooks bound to that event execute in deterministic order." | **Declared-unimplemented** — the `HookLoader` documents ordering semantics (order ASC, id ASC tie-break), and `hook-loader.ts:109–116` implements the sequencing; no host exists that calls `fire()` at the right moment from real events. |
| H2 | Host | Isolate hook failures | "A single throwing hook does not suppress later hooks for the same event." | **Absent** — `HookLoader.fire()` aborts the chain on the first throwing hook (DEFECT-1, `docs/engine-defects-found.md`; `scripts/hook-isolation.test.ts`). The documented fix (`fireIsolated()`) is not implemented and has no phase assignment. |

---

## Layer 1 — Action-Supporting Systems

| Action | Owning system | Exists as a framework contract? |
|---|---|---|
| O1 Discover | Registry + discovery command | Registry record: **yes**, but without an `event` field the hook's binding is undiscoverable at rest. Discovery command (`soxe search`): **Absent** (`bin/sox` stubs it as "not yet implemented"). |
| O2 Install | Install client + CLI + cascade + lockfile | **Defined.** |
| O3 Configure | Config cascade + capability gate + env resolution | Cascade + capability gate: **Defined.** Per-extension config schema: **Absent.** |
| O4 Activation | Host runtime: event emitter → `HookLoader.register()` + `HookLoader.fire()` | **Absent** — no host runtime emits lifecycle events or wires the `HookLoader` to an installed extension set. `tools/host-event-shim.js` is test scaffolding only (file line 9: "TEST SCAFFOLDING only"). |
| O5 Lifecycle | Install modes + promotion event + disable/uninstall | Install modes: **Defined.** Host event bus: **Absent** (`docs/scope-promotion.md` line 143: "No host event bus is implemented in this repo."). |
| H1 Fire event | Host event dispatcher → `HookLoader.fire(event, ctx)` | **Declared-unimplemented** — `HookLoader.fire()` is implemented and tested in isolation; no caller exists in product code. |
| H2 Isolate failures | `HookLoader.fireIsolated()` (per-hook try/catch) | **Absent** — documented as the recommended fix in `docs/engine-defects-found.md` but not implemented. |

> **The seam.** The discovery/install/configure/cascade/capability spine is governed. The **event
> binding, activation, dispatch, and failure isolation** rows are where the framework's contracts
> thin out to Absent or Declared-unimplemented. The seam for `hook` is sharper than for `mcp-server`
> because the hook type has no transport layer to compensate — its entire runtime value is in the
> dispatch chain, which is the precise region that is uncontracted.

---

## Layer 2 — Output Contracts

| Contract | Interface specified by the framework? | Clarity |
|---|---|---|
| **Manifest** (`extension.json`) | Yes — manifest schema (`schemas/extension/v1.json`). Hook requires `entrypoint` (enforced by `allOf` at schema line 186–189). `order` field present (schema line 85–86). | **Defined** (shape only — schema validates format but not resolvability of `entrypoint`). |
| **Catalog record** | Partially — projection of manifest; carries `type`, `description`, `keywords`. No `event` field projected. | **Implicit** — a hook's event binding is not machine-readable in the catalog. |
| **Lockfile entry** | Yes — lockfile schema + checksum. | **Defined** (but "what is the artifact it pins?" is undefined — inherits the build hole). |
| **Runnable entrypoint** | No — `entrypoint: "dist/index.js"` is declared in every hook manifest (`extensions/hooks/audit-hook/extension.json` line 14; `extensions/hooks/memory-flush/extension.json` line 11), but no `dist/` directory exists under either hook package. | **Absent** — the framework has no build contract; per-package `dist/index.js` is never produced by CI. |
| **Event-binding declaration** (which lifecycle events a hook binds) | No — the schema has no `event` field. Event binding lives only in source code (`export const event = 'PreToolUse'` in `extensions/hooks/audit-hook/src/index.ts` line 42; `export const events = [...]` in `extensions/hooks/memory-flush/src/index.ts` line 20). | **Absent** — a host cannot discover a hook's event binding without executing its code. |
| **Hook handler contract** (`handler(ctx: HookContext): void \| Promise<void>`) | Convention only — the scaffolder emits this signature (`scripts/new-extension.ts` lines 194–198) and `HookLoader` expects `HookHandler = (ctx: HookContext) => void \| Promise<void>` (`hook-loader.ts` line 39). No schema or validator enforces it. | **Implicit** — tenants comply because the scaffold template matches; no contract enforces it. |
| **Lifecycle descriptor** (`lifecycle{}`) | Explicitly prohibited for hooks — `validate-manifests.ts` line 349 rejects `lifecycle` on hook type. | **Defined** (the prohibition is enforced; hooks are request-response, not supervised daemons). |
| **Execution order** (`order` integer) | Schema field present; semantics documented in `hook-loader.ts` header; validated by schema pattern. Not enforced at dispatch time (no dispatcher exists). | **Declared-unimplemented** — shape is specified, but the runtime that would honor it during event dispatch does not exist in product code. |
| **Config contract** | No per-extension schema; config is an open object. | **Implicit.** |
| **Capability declaration** (`requires`) | Checked against capabilities asset at install time. | **Defined.** |
| **Resource/permission contract** | Nothing declares or bounds filesystem/network/socket access. The `memory-flush` hook opens a SQLite database and a Unix socket — both undeclared. | **Absent.** |

> The **Absent** rows here manufacture specific tenant defects. With no event-binding contract, a host
> cannot wire hooks to their events without loading and introspecting each hook's source. With no
> build contract, the `entrypoint` field points to a file that does not exist. With no handler
> contract enforced, any mismatched signature compiles and silently passes validation — the mismatch
> surfaces only at runtime dispatch. With no resource contract, a hook's filesystem or socket access
> is unbounded and undiscoverable by operators.

---

## Layer 3 — Contract Sources

| Contract | Origin (authored / generated / resolved / runtime) | Governed at origin? |
|---|---|---|
| Manifest | authored | Yes (schema-validated at CI via `validate-manifests.ts`). |
| Catalog record | generated from manifest | Generation exists (`build-index.ts`); event-binding field not projected — ungoverned for hook-specific metadata. |
| Lockfile entry | resolved at install | Yes. |
| Runnable entrypoint (`dist/index.js`) | should be *generated* from source by a per-package build step | **No build contract → ungoverned.** CI runs `tsc --noEmit` (typecheck only); no `tsc` emit step runs in CI or release pipelines. |
| Event-binding declaration | authored (source code only — `export const event` / `export const events`) | **No manifest field → ungoverned at rest.** The binding is visible only after executing the module. |
| Hook handler signature | authored (source code, guided by scaffold template) | **Convention only — not schema-enforced.** |
| Execution order | authored (manifest `order` field) | Schema-validated for type (integer); semantics honored only by `HookLoader`, which has no product-code caller. |
| Config contract | authored (manifest + scope config files) | **No per-extension schema → ungoverned.** |
| Capability declaration | authored (manifest) | Yes. |
| Resource/permission | (not declared anywhere) | **No origin → ungoverned.** |

---

## Layer 4 — Producing Subsystems (primary hole map)

| # | Transition | Owning subsystem | Clarity | If not Defined → what the tenant must improvise (where drift enters) |
|---|---|---|---|---|
| 1 | intent → **manifest** | scaffolder + schema + validator | **Defined**, but validation asserts shape only — it does not check that the declared `entrypoint` resolves to a built file, that the `order` field will ever be honored, or that any `event` binding is valid (no `event` field exists in the schema). | A tenant can pass validation with a dangling entrypoint and an event binding that no host recognizes. |
| 2 | manifest → **catalog record** | registry/index builder (`build-index.ts`) | **Implicit** — the catalog projects `type`, `description`, `keywords` but not the hook's event binding, making hooks undiscoverable by event name. | Each tenant guesses what metadata makes its hook discoverable; operators cannot filter hooks by event without reading source. |
| 3 | manifest + package → **lockfile** | install client (`install.ts`) | **Defined** — but "package" is undefined (inherits #4). The install client checksums `src/index.ts`, not a built artifact (`install.ts` lines 311–317). | The lockfile pins a TypeScript source file, not an executable. A host that reads the lockfile gets a `.ts` path it cannot `require()` without a TypeScript runtime. |
| 4 | source → **distributable artifacts** | **build/output-generation subsystem (framework-owned)** | **Absent** | Both hook extensions declare `entrypoint: "dist/index.js"` but neither has a `dist/` directory (`extensions/hooks/audit-hook/` and `extensions/hooks/memory-flush/` — confirmed by inspection). CI runs `pnpm typecheck` but no `pnpm -r build`. Each package's `"scripts": { "build": "tsc" }` has no local `tsconfig.json`, so `tsc` in the package directory would inherit the root config and emit to `dist/extensions/...` at the repo root — a structurally different path. **Highest-severity hole: silently nullifies the Defined rows #3 (lockfile) and #7 (release) — the framework can pin and publish an artifact that was never generated.** |
| 5 | author → **event-binding declaration** | (ecosystem should enforce an `events` field in the manifest schema) | **Absent** | Every hook tenant encodes its event binding as a source-level export (`export const event = '...'` or `export const events = [...]`). No two tenants are required to use the same export name or shape. A host must load and introspect each hook's module to discover its bindings — making static discovery impossible. |
| 6 | source → **hook handler interface descriptors** | (schema + validator) | **Absent** — no machine-readable contract for handler signature, context shape, or return type at the manifest level. | A tenant must infer the expected handler shape from the scaffold template or `hook-loader.ts` source. A mismatched signature (e.g., wrong parameter type, sync instead of async) passes all checks and fails only at dispatch time. |
| 7 | artifact + version → **published package** | versioning/release (Changesets) | **Defined** but blocked by #4 | The release pipeline publishes an npm package containing no `dist/index.js`; any host that resolves the published entrypoint gets a file-not-found error. |
| 8 | installed set + entrypoint + event-binding → **registered in HookLoader** | host runtime: hook loader + event wiring | **Absent** | Nothing reads the lockfile at host startup, loads each hook's entrypoint, introspects its event binding, and calls `loader.register()`. The framework provides `HookLoader` as a library but has no product-code integration point. Every host that wants to use hooks must invent the registration pipeline itself. **Root cause of "installed but never fires."** |
| 9 | runtime lifecycle event → **hooks dispatched in order** | host runtime: event emitter → `HookLoader.fire()` | **Absent** — `HookLoader.fire()` is implemented and tested (`hook-loader.test.ts`) but no product-code caller exists. The `tools/host-event-shim.js` is test scaffolding only. | The host must invent the event vocabulary, the `fire()` call site for each event, and the timing contract. Every host invents a different vocabulary unless it reads `docs/scope-promotion.md` prose. **Root cause of "event occurs, hook silent."** |
| 10 | scope config → **applied config** | cascade + config schema | Cascade **Defined**; per-extension config schema **Absent** | A hook's config keys (e.g., `AUDIT_HOOK_LOG` env var read by `audit-hook/src/index.ts` line 24) are unvalidated; typos pass silently. |
| 11 | requires + capabilities → **gate decision** | capability gate (`provider-capabilities.ts`) | **Defined** | — |
| 12 | hook throws → **chain continues or aborts** | host runtime: `HookLoader.fire()` error semantics | **Absent** (and the implemented behavior is a known defect) — `fire()` aborts the chain on the first throwing hook (DEFECT-1, `docs/engine-defects-found.md`; `scripts/hook-isolation.test.ts`). The documented fix (`fireIsolated()`) is unimplemented with no phase assignment. | A host that calls `fire()` directly inherits abort-on-throw semantics. A single buggy hook silently suppresses all later hooks for that event. The host must wrap every `fire()` call and track which hooks ran — or the framework must provide `fireIsolated()`. |

### The shape of the hole map

- **Defined (framework holds the line):** rows 1\*, 3\*, 7\*, 11 — the authoring → distribution
  spine. (\* with the noted incompleteness in 1, and 3/7 blocked by the missing build contract at #4.)
- **Absent / declared-unimplemented (tenant on its own):** rows 4, 5, 6, 8, 9, 12 — the entire
  build → activation → event-dispatch → failure-isolation seam.

The "spine contracted, seam not" thesis reproduces exactly for `hook`, but with a type-specific
sharpening: the seam for `hook` is *more consequential per missing row* than for `mcp-server`. An
MCP server without a registrar is installed-but-unreachable; a hook without a dispatcher is
installed-and-called-zero-times for every lifecycle event that ever fires. The `hook` type's
runtime value is entirely constituted by the dispatch chain (rows 8 and 9), which is fully absent.
Additionally, `hook` has a unique row-5 hole — the event-binding declaration — that `mcp-server`
does not: because hook bindings are not in the manifest, the absence of row 8 cannot even be
partially compensated by manifest introspection. A host must execute each hook module to discover
what it handles. This means the framework provides no static path from "installed hook set" to
"event → ordered handlers" — the whole seam must be invented by every host independently.

---

## The `hook` runtime contract the framework still owes

These are the seam contracts a complete `hook` guideline must define — today they are Absent or
Declared-unimplemented. This section is where hook-specific drift enters.

- **Build / output-generation contract (#4) — framework-owned, the linchpin:** the framework (not
  the tenant) must deterministically and uniformly compile each hook's `src/index.ts` to the
  package's own `dist/index.js`, so that the declared `entrypoint` resolves to a real, executable
  file. Neither hook package has a `dist/` directory; CI has no `pnpm -r build` step. Until this
  holds, rows #3 (lockfile) and #7 (release) are only nominally Defined — they pin and publish
  an entrypoint that was never built.

- **Event-binding contract (#5) — manifest `events` field:** the schema must require a hook to
  declare, in its manifest, the lifecycle event(s) it binds to — validated against a closed enum of
  valid host event names (e.g., `PreToolUse`, `PostToolUse`, `SessionEnd`, `ScopePromotionProposed`,
  `Stop`). Currently both hook tenants encode bindings only in source (`export const event = '...'`
  — `audit-hook/src/index.ts` line 42; `export const events = [...]` — `memory-flush/src/index.ts`
  line 20), using different export name shapes. Without a manifest field: (a) a host cannot
  statically build the event→hooks map; (b) the validator cannot reject a hook that binds an
  event that does not exist; (c) the registry cannot surface "hooks that fire on PreToolUse" to
  operators without running code.

- **Handler interface contract (#6):** the framework must specify the hook handler's TypeScript
  interface (`(ctx: HookContext) => void | Promise<void>`) as a validated, importable type that
  every hook tenant must satisfy — checked by the validator or a type-only package, not inferred
  from a scaffold template. `HookContext` is currently re-declared independently in each hook's
  source (`audit-hook/src/index.ts` lines 9–13; `memory-flush/src/index.ts` lines 22–26) rather
  than imported from a framework-owned package.

- **Activation / registration contract (#8):** the framework must specify how a host, at startup,
  reads the lockfile, loads each enabled hook's entrypoint, resolves its event binding from the
  manifest (once #5 is defined), and calls `HookLoader.register()` — so that every host produces
  the same event→ordered-hooks map from the same installed set. Currently no product-code caller of
  `loader.register()` exists; the `HookLoader` class is a library without an integration point.

- **Dispatch / timing contract (#9):** the framework must specify the event vocabulary (closed enum
  of event names, payload shapes per event) and the host's obligation to call `loader.fire(event,
  ctx)` at the right moment. Currently the vocabulary exists only in documentation prose
  (`docs/scope-promotion.md`) and `tools/host-event-shim.js` (test scaffolding). No schema,
  interface, or enforced contract defines `PreToolUse` payload shape, `SessionEnd` payload shape,
  or the timing guarantee ("fires before the tool runs" vs. "fires after").

- **Failure-isolation contract (#12):** the framework must specify whether a throwing hook aborts
  the chain (current `fire()` behavior, DEFECT-1) or is isolated (documented fix `fireIsolated()`,
  unimplemented). Until the contract is defined and the preferred variant implemented, every host is
  forced to choose between inheriting the abort-on-throw behavior or wrapping every `fire()` call
  in a custom isolation layer. The recommended `fireIsolated()` must be implemented in
  `hook-loader.ts` and designated as the canonical call site for lifecycle event dispatch.

- **Config-schema contract (#10):** a per-extension config schema so that hook config keys (e.g.,
  `AUDIT_HOOK_LOG`, `db_path`, socket paths) are declared, typed, and validated at install time
  rather than discovered by reading source code.

- **Resource/permission contract:** a manifest declaration of what filesystem paths, sockets, and
  network resources a hook may access — so operators can audit hook behavior before installing and
  hosts can (eventually) sandbox it.

---

## Notes for the author of the NEXT type document

The invariant spine (scaffold → schema → validate → build → version → install/cascade → capability
gate) should read consistently across every `docs/guidelines/*.md`. The **activation + consumption**
seam is what each type's document exists to specify. If your finding does NOT reproduce the
"spine contracted, seam not" shape, that is itself a notable result — say so and explain why.
