# Extension Framework Contracts — `bundle`

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

## Member id naming (decision, BL-16)

Bundle members follow the **same id contract as any extension** — `^[a-z][a-z0-9-]*$` **and the
id must not end in the type name** (`-skill`, `-agent`, `-server`-the-suffix is fine because the
type is `mcp-server` only when it equals/ends-with the literal type token). Members are named by
**function**, not by type: `memory-server`, `memory-cli`, `memory-daemon`, `memory-usage` (a
skill) — never `memory-skill`. `soxe init` enforces this at scaffold time (it shares
`validateId` with `soxe validate`), so a non-conformant member id is rejected before any files
are written.

**Decision (BL-16.3): the no-type-suffix rule is kept globally, not relaxed for bundle members.**
Rationale: one uniform id contract avoids two divergent rules; the member's type is already
explicit in its `extension.json` and `members/<id>/` path, so a `-skill` suffix is redundant
rather than disambiguating; and the `memory-<function>` convention already conveys a member's
role more usefully than its type would.

## Fundamental deviation: `bundle` is not a runtime type

Before applying the layer model, the single most important fact about `bundle` must be stated
explicitly, because it changes the shape of every layer below.

A `bundle` is **an install-time aggregation construct, not a runtime extension.** It has no
entrypoint, no process, no host activation, and no runtime consumer. Its entire lifecycle is:
operator references a bundle id → installer expands it to member ids → members are installed as
independent extensions → the bundle id disappears from the lockfile. By the time the host loader
runs, all bundle ids have been expanded away (`scripts/install.ts` line 656: "A bundle is NEVER
passed to the host loader").

This means:

- Layers 0 and 1 have **no runtime consumer row** — there is no agent, no host event bus, no
  dispatch. The "consumption" event is install-time expansion.
- Layer 2 has **no entrypoint, no transport contract, no handler interface, no lifecycle descriptor**
  — none of the runtime artifacts that every other type requires.
- Layer 4 rows 8 and 9 (activation and delivery) collapse into the install-time expansion step,
  which is itself a framework-owned contract — and the only seam row unique to this type.
- The `bundle` type's seam is **narrower and qualitatively different**: activation and delivery do
  not exist; the seam consists entirely of install-time composition contracts (member existence,
  version-conflict resolution, cross-bundle dedup signalling).

The "spine contracted, seam not" thesis does **not** reproduce identically for `bundle`. The
detailed finding is in the Layer 4 hole map below.

---

## Layer 0 — Ecosystem User Actions (Usage)

**Consumers:** the **Operator** (installs a bundle to obtain a set of extensions atomically). There
is no runtime consumer: once the bundle is expanded at install time, only its individual members
remain. There is no agent consumer and no host consumer for `bundle` itself. The **Author** is the
producer whose manifest Layers 2–4 trace back to.

| # | Consumer | Action | Framework promise | Clarity |
|---|---|---|---|---|
| O1 | Operator | Discover | "You can find what bundles exist, which extensions each includes, and when installing one makes sense." | **Implicit** — the registry record (`registry/index.json`) carries `type: "bundle"` and a `members` array (line 44–61 of `registry/index.json`), and the `description` field is intended to convey purpose. No machine-readable semantic of "install these together" is enforced; the discovery contract (what metadata a bundle record must carry to be discoverable as a unit) is not specified beyond the common manifest fields. |
| O2 | Operator | Install at scope | "You can install at org/user/project/local; narrower overrides broader; the bundle expands to members atomically." | **Defined** — the scope/cascade contract is specified and enforced (`scripts/cascade.ts`; `scripts/install.ts` lines 436–438). The cascade treats a bundle id as an opaque install entry; expansion is post-cascade and controlled. |
| O3 | Operator | Configure | "You can configure bundle-member extensions individually, validated before they reach them." | **Implicit** — a bundle itself has no config (no `config` block). Config applies to member extensions individually after expansion. The framework defines no bundle-level config aggregation contract; the operator must configure each member by id separately. |
| O4 | Operator | Rely on expansion | "Once installed, the bundle id is expanded to its member extensions, which are individually fetched, checksummed, and locked." | **Defined** for the mechanical expansion (cycle detection, depth guard, dedup) — `expandBundles()` in `scripts/install.ts` lines 709–794 is implemented and tested. **Implicit/Absent** for the semantic contract: version-conflict resolution across two bundles that share a member is first-seen-dedup with no operator warning (`scripts/bundle-collision.test.ts` lines 120–163 pins this as current behavior). |
| O5 | Operator | Manage lifecycle | "Upgrade, disable, uninstall, and promotion behave predictably for a bundle as a unit." | **Absent** — there is no bundle-level upgrade, disable, or uninstall contract. A bundle id in the install list is treated as an opaque entry by the cascade; disabling `sox-memory-bundle` in a scope config disables the bundle entry but the already-expanded member locks remain in force. No framework contract defines what "uninstall this bundle" means for previously-expanded members. |

---

## Layer 1 — Action-Supporting Systems

| Action | Owning system | Exists as a framework contract? |
|---|---|---|
| O1 Discover | Registry + discovery command | Registry record: **yes** — `build-index.ts` lines 207–210 include the `members` array in the index entry for `type: "bundle"`. Discovery command (`soxe search`): **Absent** (bin/soxe stubs it). |
| O2 Install | Install client + CLI + cascade + expansion + lockfile | Cascade: **Defined.** Expansion (`expandBundles()`): **Defined** for cycle detection and depth; **Implicit/Absent** for version-conflict semantics. Lockfile: **Defined** — but the bundle id itself does not appear in the lockfile; only expanded members do (`scripts/install.ts` lines 553–566; confirmed by `docs/architecture-audit.md` line 27: lockfile contains `memory-server@0.1.0`, not `sox-memory-bundle`). |
| O3 Configure | Config cascade + capability gate + env resolution | Cascade + capability gate: **Defined** for member extensions post-expansion. No bundle-level config contract: **Absent**. |
| O4 Expansion | Install client: `expandBundles()` → member install entries | **Defined** for mechanics (cycle guard, depth limit, explicit-entry override). **Absent** for version-conflict notification: silent first-seen-dedup is pinned behavior, not a specified contract with a defined operator signal. |
| O5 Lifecycle | Bundle-as-unit upgrade/disable/uninstall | **Absent** — no system owns bundle-level lifecycle. The install client treats the bundle id as a list expansion and writes nothing bundle-specific to the lockfile; there is no remove-bundle-members operation. |

> **The seam for `bundle`.** The discovery/install/cascade/capability spine is governed as for
> other types. However, the `bundle` type has **no activation or runtime seam at all** — because
> bundles have no runtime. The seam is entirely in the install-time expansion layer: specifically,
> the contracts around member existence validation, cross-bundle version-conflict resolution and
> notification, and bundle-level lifecycle (upgrade, disable, uninstall as a unit). These are
> install-time seam contracts, not runtime seam contracts. This is the fundamental deviation from
> the cross-type pattern.

---

## Layer 2 — Output Contracts

| Contract | Interface specified by the framework? | Clarity |
|---|---|---|
| **Manifest** (`extension.json`) | Yes — manifest schema (`schemas/extension/v1.json`). For `bundle`: `members` required, `entrypoint` prohibited (enforced by `allOf` at schema lines 204–206). | **Defined** (shape enforced; but member ids are not validated against the registry — a bundle can declare members that do not exist). |
| **Catalog record** | Partially — projection of manifest; carries `type`, `description`, `members` in the index entry (`build-index.ts` lines 207–210). | **Implicit** — the `members` array is included opportunistically; no discovery metadata contract specifies what a bundle's catalog record must carry to be operator-actionable. |
| **Lockfile entry** | **Absent for the bundle itself** — the bundle id is never written to the lockfile. Lockfile entries exist only for expanded member extensions (`scripts/install.ts` lines 531–536). | **Absent** as a bundle-level artifact. This is intentional by design; the consequence is that no lockfile record proves "this member was installed because of this bundle." |
| **Entrypoint** | Explicitly prohibited — schema `allOf` line 205: `"not": { "required": ["entrypoint"] }`; `validate-manifests.ts` line 392–401 enforces the prohibition as an error. | **Defined** (the prohibition is enforced; bundles are install-time-only constructs). |
| **Runtime transport / handler / lifecycle** | Not applicable — a bundle has no runtime, no process, no lifecycle block, no handler. `validate-manifests.ts` line 125 comment: "bundles are install-time-only; they expand to members and are never host-loaded." | **Not applicable** — the absence of all runtime contracts is the correct state for this type. |
| **Member existence contract** | No — the schema validates member id *syntax* (`^[a-z][a-z0-9-]*$`) and prohibits self-reference and duplicates, but does not validate that declared member ids exist in the registry or locally. | **Absent** — a bundle can declare members that will fail at expansion time with a runtime error (`install: ERROR cannot resolve extension "X"`), not a validation error. |
| **Member version-conflict resolution contract** | No — when two bundles share a member with different version specs, `expandBundles()` applies first-seen dedup silently. No warning is emitted, no contract specifies the dedup rule as an explicit operator-visible policy (`bundle-collision.test.ts` lines 120–163). | **Implicit** — the behavior is pinned in tests but never specified as a governing contract with a defined operator signal. |
| **Config contract** | No per-bundle config schema; bundles carry no `config` block. | **Not applicable** (bundles have no runtime to receive config). |
| **Capability declaration** (`requires`) | Not expected on bundles — members carry their own `requires` blocks, checked at member expansion/install time. No bundle-level capability aggregation contract. | **Implicit** — the framework relies on members declaring their own requirements; no contract states whether a bundle may also carry `requires`. |
| **Resource/permission contract** | Not applicable — bundles are install-time-only; they consume no runtime resources. | **Not applicable.** |

> The **Absent** rows here manufacture a specific class of tenant defect unique to `bundle`: with
> no member-existence contract at validation time, a well-formed bundle manifest can reach the
> registry and pass CI only to fail silently or loudly at operator install time, when
> `expandBundles()` cannot resolve a declared member. The framework owns no static path from "bundle
> manifest validated" to "all declared members are resolvable."

---

## Layer 3 — Contract Sources

| Contract | Origin (authored / generated / resolved / runtime) | Governed at origin? |
|---|---|---|
| Manifest | authored | Yes — schema-validated at CI via `validate-manifests.ts`; member id syntax, self-reference, duplicates, and no-entrypoint enforced as errors. |
| Catalog record | generated from manifest by `build-index.ts` | Generation exists and includes `members` array; required-field contract for bundle-specific discovery metadata: Implicit. |
| Lockfile entry | not generated for bundle itself; generated for each expanded member at install time | Member lockfile entries: governed (checksum + version). Bundle-level provenance in lockfile: Absent. |
| Member existence | authored (in manifest `members[]`) | Syntax governed at validation; existence against registry ungoverned at validation time. |
| Version-conflict resolution | resolved at install time by `expandBundles()` first-seen dedup | Behavior pinned in tests; resolution policy never specified as a governing contract. |
| Bundle-level lifecycle | (not declared anywhere) | No origin — ungoverned. |
| Config contract | not applicable | Not applicable. |
| Capability declaration | authored (member manifests) | Governed per member at install time. |
| Resource/permission | not applicable | Not applicable. |

---

## Layer 4 — Producing Subsystems (primary hole map)

| # | Transition | Owning subsystem | Clarity | If not Defined → what the tenant must improvise (where drift enters) |
|---|---|---|---|---|
| 1 | intent → **manifest** | scaffolder + schema + validator | **Defined**, but validation asserts structural shape only — it does not check that declared member ids exist in the registry, that declared version ranges are satisfiable, or that two bundles with shared members will not conflict silently. | A bundle author can declare members that do not exist or that conflict across bundles; these pass validation and fail only at operator install time, with no pre-publish gate. |
| 2 | manifest → **catalog record** | registry/index builder (`build-index.ts`) | **Implicit** — `build-index.ts` lines 207–210 include `members` in the index entry for bundles. No required discovery metadata contract specifies what a bundle's catalog record must expose to make a bundle operator-actionable (e.g., member types, total capability surface). | Each bundle author guesses what description metadata conveys the bundle's composition to operators; no standard guides what a "discoverable bundle record" must contain. |
| 3 | manifest + package → **lockfile** | install client (`install.ts`) | **Defined** for member-level lockfile entries. **Absent** as a bundle-level lockfile artifact — the bundle id does not appear in the lockfile, so there is no pinned record of "members were installed as a bundle." | There is no framework mechanism to prove that a specific set of member versions was installed together as a named bundle. Audit and rollback of bundle-level installs must be improvised by operators. |
| 4 | source → **distributable artifacts** | **build/output-generation subsystem (framework-owned)** | **Not applicable for bundle itself** — a bundle has no source code and no build step. The `package.json` scaffolded for a bundle (`new-extension.ts` lines 759–776) includes `"scripts": { "build": "tsc", "typecheck": "tsc --noEmit" }`, inheriting the pattern from runtime types, but there is nothing to compile. This is a scaffolder artifact mismatch: build/typecheck scripts are meaningless for a manifest-only type. For the **member** extensions that a bundle references, row 4 is fully Absent — no framework build contract exists, and members may have no `dist/` directories — but this is a member-type concern, not a bundle contract. | A bundle author scaffolding from `new-extension.ts` receives a `package.json` with a `build` script that has nothing to build. This is low-severity (the script is a no-op), but it signals that the scaffolder's separation between manifest-only and runtime types is incomplete. |
| 5 | author → **member existence declaration** | (validator should check member ids against the registry) | **Absent** — `validate-manifests.ts` Check 8 (lines 377–447) validates member id syntax, self-reference, and duplicates, but never resolves member ids against the registry index or local extensions tree. | Every bundle author must manually verify that all declared member ids exist and are installable. The framework provides no static guarantee from "validated bundle manifest" to "installable bundle." |
| 6 | manifest → **version-conflict resolution contract** | install client: `expandBundles()` | **Implicit** — the first-seen dedup behavior is implemented and tested (`bundle-collision.test.ts` lines 120–163), but the policy is never specified as an operator-visible contract. No warning is emitted when a version conflict is silently resolved. | An operator installing two bundles that share a member with different version specs receives the first-seen version with no notification. This is invisible dependency shadowing at any scale beyond a single bundle per install. |
| 7 | artifact + version → **published package** | versioning/release (Changesets) | **Defined** — Changesets governs versioning and release for bundles as for other types. The bundle `package.json` is a valid npm package. The release contract is not undermined by row 4 here (bundles have nothing to build). | — |
| 8 | bundle id + members → **member install entries** | install client: `expandBundles()` | **Defined** for mechanics: cycle detection (`ancestorChain` check, `install.ts` lines 749–754), depth guard (`BUNDLE_MAX_DEPTH = 10`, line 665), explicit-entry override (lines 784–791), recursive bundle-of-bundles support (lines 766–777). **Absent** for semantic contract: silent dedup without warning, no operator-visible conflict report, no verification that all members resolved. | A host that installs a bundle containing an unresolvable member gets a `process.exit(1)` with a console error — no structured error type that a caller can catch or handle. The framework owns no static path from bundle manifest to confirmed resolvable member set. |
| 9 | installed members → **no runtime delivery** | not applicable | **Not applicable** — by design, the bundle id disappears after expansion. There is no row 9 runtime delivery for this type. This is the correct state; it is the most important structural deviation from the cross-type pattern. | — |
| 10 | scope config → **applied config** | cascade + config schema | **Defined** for member extensions post-expansion. **Not applicable** at bundle level (bundles carry no config). | — |
| 11 | requires + capabilities → **gate decision** | capability gate (`provider-capabilities.ts`) | **Defined** for member extensions (each member's `requires` is checked at install). **Not applicable** at bundle level (bundles carry no `requires`). | — |
| 12 | bundle-level lifecycle signal → **no event** | not applicable | **Not applicable** — bundles have no runtime and participate in no event bus. Members participate individually after expansion. | — |

### The shape of the hole map

- **Defined (framework holds the line):** rows 1\*, 2\*, 7, 8\* — the authoring → expansion →
  distribution spine. (\* with noted incompleteness: 1 does not validate member existence; 2 has no
  required discovery metadata contract; 8 lacks version-conflict notification and structured error
  types.)
- **Absent / implicit (tenant on its own):** rows 5, 6 — the install-time composition seam unique
  to bundle.
- **Not applicable (correctly absent):** rows 4\*, 9, 12 — runtime contracts that do not exist
  because `bundle` has no runtime. (\* Row 4 is not applicable for the bundle itself; the
  scaffolder artifact mismatch for `package.json` is a low-severity consistency gap, not a contract
  hole.)

**The "spine contracted, seam not" thesis does not reproduce identically for `bundle`**, and this
is itself the primary finding. The deviation is structural, not incidental:

1. **The seam is install-time, not runtime.** For `mcp-server` and `hook`, the seam is in rows 8/9
   (activation and runtime delivery). For `bundle`, rows 8 and 9 are the install-time expansion
   step itself — and the expansion mechanics (cycle guard, depth limit, explicit-entry override) are
   well-implemented. The seam contracts that are missing are the *semantic* contracts around
   expansion: member existence validation, version-conflict resolution policy, and operator-visible
   conflict notification.

2. **Row 4 (build) is not the linchpin for `bundle`.** Unlike every other type, a bundle has
   nothing to build. The build/output-generation contract that is the highest-severity hole for
   runtime types is simply not applicable here. This means rows 3 and 7 are not undermined by a
   missing build step — the bundle's release artifact (the manifest and `package.json`) is correct
   by construction.

3. **The lockfile does not record bundle provenance.** For all other types, the lockfile is the
   definitive record of what was installed and at what version. For `bundle`, the lockfile records
   only expanded members — the bundle identity is erased. This is the correct design for member
   deduplication, but it means there is no framework-owned audit trail from "bundle installed" to
   "these members installed as that bundle."

---

## The `bundle` install-time contract the framework still owes

These are the seam contracts a complete `bundle` guideline must define — today they are Absent or
Implicit. This section is where bundle-specific drift enters.

- **Member existence contract (#5) — static validation gap:** the validator (`validate-manifests.ts`
  Check 8) must verify that each declared member id resolves against the registry index or local
  extensions tree at validation time, not only at operator install time. Currently a bundle can
  carry member ids that pass all schema and validator checks and then fail with a `process.exit(1)`
  during `expandBundles()` because the member does not exist in the registry. The framework should
  make this a pre-publish validation error, not a runtime install error.

- **Version-conflict resolution contract (#6) — silent dedup must become specified policy:** when
  two bundles declare the same member id with different version specs, `expandBundles()` applies
  first-seen dedup silently (pinned in `bundle-collision.test.ts` lines 120–163). The framework
  must either (a) specify first-seen as the explicit, documented policy and emit a structured
  operator warning naming the conflicting bundles, the member id, and the dropped version range, or
  (b) define a different resolution strategy (e.g., strictest range wins, explicit entry always
  wins, conflict is a fatal error). Currently the behavior is observable only by reading the test
  file; no operator-visible contract governs it.

- **Bundle provenance in lockfile (#3 deviation):** the framework should define whether bundle
  identity is preserved in any install artifact. The current design — bundle id erased after
  expansion, only members in the lockfile — is a deliberate trade-off for deduplication, but it
  makes it impossible to audit "which bundle caused this member to be installed" or to implement
  "remove all members of this bundle" without re-expanding the bundle manifest. The framework must
  specify whether bundle provenance is a contract it will honor or explicitly disclaim.

- **Scaffolder artifact alignment (#4 minor):** the `new-extension.ts` scaffolder emits a
  `package.json` with `"scripts": { "build": "tsc", "typecheck": "tsc --noEmit" }` for bundles
  (`new-extension.ts` lines 759–776), inherited from the runtime-type template. A bundle has no
  source to compile. The scaffolded `package.json` should either omit build/typecheck scripts or
  emit bundle-specific scripts (`"validate": "soxe validate-bundle"`), so that `pnpm -r typecheck`
  and `pnpm -r build` do not silently no-op for bundles.

- **Bundle-level lifecycle contract (#O5):** the framework must specify what "uninstall bundle X"
  and "upgrade bundle X" mean for members that were previously expanded and locked. Today there is
  no framework operation for this; operators must manually remove member entries from scope configs
  and re-run install. If the framework intends to support bundle-level lifecycle operations, it must
  define them; if it does not, that disclaimer must be explicit.

---

## Notes for the author of the NEXT type document

The invariant spine (scaffold → schema → validate → build → version → install/cascade → capability
gate) should read consistently across every `docs/guidelines/*.md`. The **activation + consumption**
seam is what each type's document exists to specify. If your finding does NOT reproduce the
"spine contracted, seam not" shape, that is itself a notable result — say so and explain why.
