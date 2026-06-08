# Architecture v2 — closing the five first-tenant gaps (G-A..G-E)

**Status:** design (planner deliverable). Implementation phases appended to `migration.md` Section 6 (P7+).
**Scope:** additive, back-compatible extensions to the v1 contract surfaced by the first tenant
(`sox-memory`, see `../sox-memory/design.md` §8). **No v1 extension may change behavior.**
**Ground truth read for this design (files on disk, not assumed):**
`schemas/extension/v1.json`, `schemas/extensions-config/v1.json`, `schemas/lockfile/v1.json`,
`scripts/cascade.ts`, `scripts/install.ts`, `scripts/validate-manifests.ts`,
`migration.md` Sections 1/4/5, and research findings
`extension-type-taxonomy.md`, `multi-scope-install-config-cascade.md`.

---

## 0. Design stance (why these forks, in one place)

The v1 contract has six invariants the additions must respect (`migration.md` §1, §5):
**(I1)** closed `type` enum (6 types; host hard-rejects anything else);
**(I2)** manifest-is-data (no behavior in JSON; `validate-manifests.ts` enforces);
**(I3)** immutable `id`;
**(I4)** independent versioning (every extension semver'd alone — the anti-pattern is the live
`sox-cto-system` monolith, `migration.md` §0/D5);
**(I5)** narrowest-scope-wins cascade with **arrays-replace** (`cascade.ts` lines 11–16, ratified by
`multi-scope-install-config-cascade.md` §4);
**(I6)** four-files-per-extension footprint (`extension.json` + `package.json` + entrypoint + tests).

Every fork below is biased to **additive schema deltas** (new optional fields, never required;
never a changed required field) so **every v1 manifest validates and installs unchanged**. Where a
fix necessarily bends an invariant, §7 (model-coherence check) names it explicitly.

A key empirical finding shaping G-A and G-B: the existing model **already absorbs more than the
tenant assumed.**
- `extension-type-taxonomy.md` §1 lists for **MCP server**: *"Requires a running server process"* —
  i.e. a long-running process is **already in the mcp-server type's contract**. G-A is therefore a
  *lifecycle-vocabulary* gap, not a missing type.
- `cascade.ts` lines 100–120 + `multi-scope-install-config-cascade.md` §4 row "Array": a wider
  scope's install entries **are carried forward** unless a narrower scope redefines/disables them —
  *"user additions are additive only for extensions not listed at project scope."* So the array
  doesn't fully wipe; the real G-B pain is only the *literal in-array re-listing of one bundle's
  members*. That points to **bundle-expansion**, not changing the locked merge rule.

---

## G-A — Long-running service / daemon lifecycle

### Decision
**Additive `lifecycle` block on existing manifests (NOT a 7th `service` type).** A behavioral
extension (in practice `mcp-server`, optionally `agent`) MAY declare
`lifecycle: { background, health, singleton, stop_timeout_ms }`. When present, the **host** owns
supervision/restart/health instead of the extension self-managing a PID.

**Rationale.** The closed type enum is a deliberate discipline (I1); `extension-type-taxonomy.md` §1
already files "requires a running server process" under mcp-server, and the type-taxonomy decision
table has **no branch that produces "service"** — a daemon is an implementation detail of an MCP
server, not a new invocation model. A 7th type would force every consumer, the dir↔type map, and the
host loader to learn a new primitive for what is really *metadata on an existing one*. The `sox-memory`
`memoryd` is literally shipped *inside* `memory-server` (`../sox-memory/design.md` §2.4) — the
lifecycle block formalizes exactly that arrangement.

### Exact schema delta — `schemas/extension/v1.json` (additive)
Add to `properties` (alongside `requires`, `order`):
```jsonc
"lifecycle": {
  "type": "object",
  "additionalProperties": false,
  "description": "Host-owned process supervision for long-running extensions. Optional; absent ⇒ v1 request/response behavior (no daemon). Only meaningful for type in {mcp-server, agent}.",
  "properties": {
    "background":     { "type": "boolean", "default": false,
                        "description": "If true the host keeps the process alive across calls (supervised) instead of lazy per-call spawn." },
    "singleton":      { "type": "boolean", "default": true,
                        "description": "At most one host-supervised instance per scope key. Host holds the lock — replaces the extension's own OS advisory lock." },
    "health": {
      "type": "object", "additionalProperties": false,
      "description": "How the host probes liveness. Absent ⇒ process-alive only.",
      "properties": {
        "type":        { "enum": ["stdio-ping", "socket", "command"], "default": "stdio-ping" },
        "endpoint":    { "type": "string", "description": "Socket path or command; required when type ∈ {socket, command}." },
        "interval_ms": { "type": "integer", "minimum": 250, "default": 5000 },
        "timeout_ms":  { "type": "integer", "minimum": 100, "default": 2000 }
      }
    },
    "stop_timeout_ms": { "type": "integer", "minimum": 0, "default": 5000,
                         "description": "Grace period on SIGTERM before SIGKILL." }
  }
}
```
Add one conditional to `allOf` (keeps the type enum closed, scopes the field):
```jsonc
{ "if":   { "required": ["lifecycle"] },
  "then": { "properties": { "type": { "enum": ["mcp-server", "agent"] } } } }
```

### Supervision / start-stop / health / singleton contract (host loader)
The host loader (a documented contract in v1 — `migration.md` §1.1 "hard-rejected at host load
time"; no `scripts/host*.ts` exists on disk) gains a supervisor sub-contract, specified here:
- **start:** on first need, if `lifecycle.background:true` the host spawns the `entrypoint` once and
  keeps it; else it lazy-spawns per call (v1 behavior, unchanged for manifests without `lifecycle`).
- **singleton:** the **host** holds a per-scope-key lock (file lock keyed by `id`+scope), so the
  extension no longer self-manages `~/.memory/memoryd.lock`. The OS-lock workaround in
  `../sox-memory/design.md` §2.4 becomes a host guarantee.
- **stop:** SIGTERM → wait `stop_timeout_ms` → SIGKILL. Fired on host shutdown / extension disable
  (cascade `enabled:false`) / version change.
- **health:** host probes per `health.type` every `interval_ms`; on `timeout_ms` miss × the host's
  restart policy it restarts (exponential backoff). Health is **advisory to the host**, never on the
  extension's read path.
- **back-compat of the read path:** `memory_recall` still opens DBs read-only WAL; the supervisor
  governs only the *writer* daemon. Nothing about recall latency changes.

### Impact on built code
- `validate-manifests.ts`: +check — `lifecycle` present ⇒ `type ∈ {mcp-server, agent}`; if
  `health.type ∈ {socket,command}` then `health.endpoint` required. (~25 LOC; the JSON-Schema
  `allOf` covers most, validate-manifests adds the friendly diagnostic.)
- `install.ts` / `cascade.ts`: **zero change.** `lifecycle` is manifest metadata, not config/install;
  it never enters the cascade. The resolved set already carries the manifest; the host reads
  `lifecycle` at load.
- Host loader: gains the supervisor sub-contract above (spec only in this repo; the loader is a host
  responsibility, consistent with v1 treating the loader as a contract not a built artifact).

### Back-compat
Fully additive. `lifecycle` is **optional**; every v1 manifest (no `lifecycle`) keeps exact
request/response semantics. No required field added or changed → all v1 manifests validate unchanged.
Schema stays **v1** (additive optional property is non-breaking under JSON-Schema `additionalProperties:false`,
since old docs simply omit the new key).

### Trade-offs / rejected alternative
**Rejected: a 7th `service` type** (enum 6→7). It *is* more discoverable ("there's a service type")
and gives a dedicated dir `services/`. But it (a) breaks the closed-enum discipline that the taxonomy
deliberately resisted (I1); (b) duplicates ~80% of mcp-server's contract (a service still speaks a
protocol and is model-or-host invoked); (c) forces a fork in `DIR_TO_TYPE`, the host loader, and
every consumer's mental model — for metadata that rides cleanly on the existing type. The lifecycle
block is strictly less code and strictly more back-compatible. **Cost of chosen path:** "service-ness"
is a *property of* an mcp-server rather than a first-class noun; authors discover it via the field,
not a directory. Accepted.

---

## G-B — Bundle / meta-package primitive

### Decision
**A new `bundle` extension type (enum 6→7) that expands to install entries — NOT a cascade merge-mode
change.** A `bundle` manifest is a named, independently-versioned set: `members: [{id, version}]`.
Installing the bundle id expands (in `install.ts`) to its members. The cascade's **arrays-replace
rule is untouched** (I5 preserved).

**Rationale.** The locked array-replace rule is ratified by `multi-scope-install-config-cascade.md` §4
("project install list is authoritative") and is load-bearing for supply-chain determinism — changing
it to an `append` mode would make every install list non-authoritative and reopen the exact
shadow-copy / re-vendor failure mode P2's dedup lint exists to prevent (`migration.md` §5 follow-up,
the live `sox-active`/`sox-cto-system` 5-agent case). The *real* G-B pain (`../sox-memory/design.md`
§1.2) is narrower: a consumer can't name "the memory bundle" as **one** versioned thing, and must
hand-list four members. A `bundle` that the installer **expands** gives atomic add + one version,
while every member stays independently published and the array still fully describes what's installed
post-expansion.

This is the *one* place a new type is justified by the taxonomy's own criterion: a bundle has a
distinct invocation model (it is **never loaded at runtime** — it is resolved away at install), which
none of the six behavioral types share. It is closer to npm's meta-package than to any of agent/skill/
mcp-server/hook/command/prompt.

### Exact schema delta
**`schemas/extension/v1.json`** — extend the type enum and add `members`:
```jsonc
"type": { "type": "string",
  "enum": ["agent", "skill", "mcp-server", "prompt", "hook", "command", "bundle"] },
...
"members": {
  "type": "array",
  "description": "Bundle members. Required iff type=='bundle'. Each is an independently-published extension pinned by semver range.",
  "items": {
    "type": "object", "additionalProperties": false,
    "required": ["id", "version"],
    "properties": {
      "id":      { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" },
      "version": { "type": "string", "description": "semver range, e.g. ^0.1.0" }
    }
  }
}
```
Add to `allOf`: a `bundle` requires `members` and forbids `entrypoint` (a bundle has no runtime):
```jsonc
{ "if":   { "properties": { "type": { "const": "bundle" } } },
  "then": { "required": ["members"], "not": { "required": ["entrypoint"] } } }
```
Also relax the existing entrypoint conditional so `bundle` is exempt (it is already, since `bundle`
is not in the `{agent,skill,mcp-server,command}` enum of that `if`, and `hook` is handled separately
— **no edit needed**, confirmed against `schemas/extension/v1.json` lines 80–89).

**`schemas/extensions-config/v1.json`** — no change. A bundle is listed in `install[]` like any id.

### Composition with the cascade + array-replace rule
Bundle expansion happens in `install.ts` **after** cascade resolution (`buildInstallList`,
`install.ts` lines 652–689), so org→user→project→local precedence runs first on the *bundle id*, then
the resolved bundle expands to members. Consequences (all desirable):
- A consumer's project `install: [{ "id": "sox-memory-bundle", "version": "^0.1.0" }]` expands to the
  four memory extensions — **atomic add**, one line, one version. (No member re-listing →
  `../sox-memory/design.md` §1.2 ergonomic cost resolved.)
- The cascade still sees one entry (`sox-memory-bundle`) until expansion → arrays-replace stays
  authoritative and the lint invariants are unchanged.
- A member can still be **individually overridden**: list the member id explicitly at a narrower scope
  with `enabled:false` or a pinned version; member-level entries win over bundle-expanded ones
  (expansion runs first, then explicit entries override by id — mirrors `buildInstallList`'s existing
  "supplement with direct install entries" merge, `install.ts` lines 670–686).

### `dependencies` vs `members`
`dependencies` (existing field) stays a **runtime/keystone** relation ("organizer depends on
server"); `members` is a **packaging** relation ("the bundle ships these"). A bundle's members
typically also declare `dependencies` among themselves (memory-organizer→memory-server). They are
orthogonal and both retained; §G-E governs how `requires` aggregates across them.

### Versioning a bundle independently
The bundle carries its own semver (I4 preserved): bumping the bundle version is a Changeset like any
extension; member ranges inside `members[]` are how the bundle pins what it ships. A consumer pins the
*bundle* version; the bundle pins its *members*. Two-level pin, both independently versioned.

### Impact on built code
- `install.ts`: +bundle expansion in resolution. When a resolved id's manifest has `type:"bundle"`,
  replace it with its `members` (recursively, depth-guarded; bundles-of-bundles allowed but cycle-
  checked), resolving each member against the registry as usual. (~60 LOC incl. cycle guard.)
- `validate-manifests.ts`: +checks — `type:"bundle"` ⇒ `members` non-empty, no `entrypoint`, each
  member id format-valid, no self-reference, no duplicate member ids. New `DIR_TO_TYPE` entry
  `bundles → bundle`. (~30 LOC.)
- `build-index.ts`: bundles are indexed like any extension (they have id+version+checksum); the index
  builder needs the new type in its dir scan (~5 LOC).
- `cascade.ts`: **zero change** (expansion is post-cascade).
- Host loader: **never loads a bundle** — by the time the loader runs, bundles are expanded away. The
  loader's existing "hard-reject unknown type" must learn `bundle` is install-time-only and should
  never reach load (spec note).
- New dir `extensions/bundles/`; footprint of a bundle = `extension.json` + `package.json` (+ a README;
  **no entrypoint, no tests-of-behavior** — a bundle has no behavior, I2). This is a *smaller*
  footprint than I6's four-files, not larger — noted in §7.

### Back-compat
Adding an enum member is additive: every v1 manifest's `type` is still in the (now larger) enum; no
v1 manifest is a bundle, so no v1 manifest gains required `members`. All v1 manifests validate and
install unchanged. The dir↔type map gains a key; existing dirs unaffected. Schema stays **v1**.

### Trade-offs / rejected alternative
**Rejected: cascade `install` merge-mode (`append` vs `replace`).** Tempting because it's a tiny
`cascade.ts` change and needs no new type. But it **bends the load-bearing arrays-replace invariant**
(I5) that the research explicitly chose (`multi-scope-install-config-cascade.md` §4) and that the
supply-chain integrity story rests on; an append mode makes "what is installed" depend on merge
history rather than the authoritative narrowest list, and reopens silent re-vendoring. It also doesn't
give the headline win the tenant asked for — a *named, single-versioned* set. **Cost of chosen path:**
a 7th type (the only enum growth in v2) and a new install-time expansion step; mitigated because the
bundle never reaches runtime and is cycle-guarded. Accepted. (A future tenant that genuinely needs
additive list-merge can revisit, but it is out of scope and not justified by G-B.)

---

## G-C — Scope-promotion (content maturing narrow→wide)

### Decision
**A documented ecosystem pattern + ONE generic host-fired hook event (`ScopePromotionProposed`) +
an optional `config.promotion` convention — NOT a first-class cascade feature.** The cascade governs
*config/install* precedence and must **not** learn about *content* movement (that would conflate two
orthogonal axes). Instead the ecosystem (a) names the concept, (b) defines a standard lifecycle event
the host fires so tenants don't each invent a `promotion_queue` plumbing, and (c) reserves a
`config.promotion` key shape as convention.

**Rationale.** `../sox-memory/design.md` §8/G-C is explicit: the cascade governs config/install
precedence and *"has no concept of content maturing from project→user→org."* Content promotion is a
**data-plane** concern; the cascade is the **control-plane**. Making promotion a cascade feature would
break the clean separation and force every scope merge to reason about data lineage. But leaving it
wholly to tenants means each reinvents the approval queue. The minimal ecosystem-level primitive that
prevents reinvention is: **a lifecycle event + an approval-locus rule**, both of which already fit the
existing **hook** type (hooks bind lifecycle events — `extension-type-taxonomy.md` §1).

### Where it sits relative to the cascade
**Adjacent, not inside.** Promotion moves *content* (memory nodes, learned facts) up the same
**org/user/project/local** scope ladder the cascade defines, but it is mediated by an **approval**,
never by automatic merge. The cascade decides which *extensions/config* apply at a scope; promotion
decides which *content* an extension is allowed to copy to a wider scope. The scope ladder is shared;
the mechanism is separate.

### The generic host hook (the anti-reinvention primitive)
Define a standard lifecycle event in the host hook vocabulary (alongside SessionEnd, PreToolUse, …):
```
Event: ScopePromotionProposed
Payload: { extension_id, from_scope, to_scope, items: [...], proposed_at }
Contract: the host fires this when any extension calls the host's
          `proposePromotion(from_scope, to_scope, items)` API. Hooks bound to it
          (order-sorted per Gap 2) run the approval/policy step. The DEFAULT host
          handler enqueues to a host-managed promotion log; a tenant MAY bind its
          own hook to auto-approve, route to a reviewer, or veto.
```
This means `sox-memory`'s `promotion_queue` + `memory promote` (`../sox-memory/design.md` §2.5)
becomes *one binding* of a **generic** event, not bespoke plumbing — and the next tenant reuses the
event instead of reinventing the queue.

### Approval locus (the rule the ecosystem states)
- **to_scope owner approves.** Promoting project→user requires the **user**-scope owner's approval;
  project→org requires the **org-baseline** owner's. Default = manual (no auto-widen), matching
  `../sox-memory/design.md` §1.2 `config.promotion.auto_approve:false`.
- **org baseline MAY auto-approve** via policy (e.g. occurrence/age thresholds) by binding an
  auto-approve hook — but the *default* is human-in-the-loop, because widening content is a
  trust-expanding action (narrow→wide = more exposure).

### `config.promotion` convention (reserved shape, not enforced schema)
`extensions-config/v1.json` `config` is already `additionalProperties: object` keyed by extension id,
so **no schema change is needed**. The ecosystem documents the *recommended* shape so tenants align:
```jsonc
"config": { "<ext-id>": { "promotion": {
  "auto_approve":    false,
  "min_occurrences": 3,
  "min_age_days":    60,
  "approver_scope":  "user"   // or "org"
} } }
```
This is convention (documented), not a new schema property — keeping I2 (manifest/config is data) and
avoiding a per-tenant key collision while not over-fitting the schema to one tenant's policy.

### Per-identity partitioning note (the 5th-scope trap)
`../sox-memory/design.md` §8/G-C also flags: the research's "agent" scope had no install-scope
equivalent and was resolved as an **in-store `agent_id` partition**, not a 5th scope. **The ecosystem
states this as a rule:** *per-identity (agent/user) data partitioning is a tenant concern, not an
install scope.* The four scopes (org/user/project/local) are **deployment/precedence** scopes;
identity is a *filter within* a scope's data. This prevents future tenants reaching for a 5th scope.
(Documentation-only; no schema/code change.)

### Impact on built code
- `cascade.ts` / `install.ts`: **zero change** (promotion is data-plane).
- Host loader / hook resolver: register `ScopePromotionProposed` in the event vocabulary and expose
  `proposePromotion(...)` (spec; the loader is a host contract). A reference default handler (enqueue
  + log) is ~40 LOC if/when a host stub is built — out of the core glue budget, like the optional
  registry server.
- `validate-manifests.ts`: optional advisory — if a hook's manifest binds `ScopePromotionProposed`,
  no special check needed (it's just another event). **Zero required change.**

### Back-compat
Entirely additive and mostly documentation. No schema field added; `config.promotion` rides the
existing open `config` object. Adding an event name to the host vocabulary doesn't affect any v1
extension that doesn't bind it. v1 installs unchanged.

### Trade-offs / rejected alternative
**Rejected: a first-class `config.promotion` schema block + a cascade-level promotion lifecycle.**
More discoverable and machine-checkable, but it (a) couples the control-plane cascade to data-plane
movement, (b) over-fits the schema to one tenant's threshold model (occurrences/age are *memory's*
policy, not universal), and (c) is more code for a concept still maturing across tenants. The
documented-pattern-plus-generic-event keeps the ecosystem un-opinionated about *policy* while
preventing *plumbing* reinvention. **Cost:** promotion policy isn't schema-validated, so a typo in
`config.promotion` isn't caught at install (it's tenant-validated at `memory promote` time). Accepted —
a single generic event is the right amount of ecosystem commitment for an unproven cross-tenant
concept.

---

## G-D — Explicit runtime-language contract

### Decision
**A documented rule + an optional advisory `runtime` manifest field, enforced by `validate-manifests.ts`
only for the provider-touching case.** Rule: **Node/TS is REQUIRED for any extension that calls a
provider** (declares `requires.structured_output` or `requires.tool_calling`, because the provider
abstraction is TS — `../sox-memory/design.md` §3); **language-agnostic stdio is allowed for
provider-free mcp-servers.**

**Rationale.** The runtime assumption is currently *implicit* in `entrypoint:"dist/index.js"` + the TS
provider layer (`../sox-memory/design.md` §8/G-D — the memory research assumed Python and had to
port). Making it explicit lets future tenants **budget the port up front**. But hard-coding "Node only"
everywhere would wrongly exclude a perfectly valid provider-free stdio MCP server in any language. So
the contract is **conditional**: language is constrained *only where the provider abstraction is
touched*.

### Exact schema delta — `schemas/extension/v1.json` (additive, optional)
```jsonc
"runtime": {
  "type": "string",
  "enum": ["node", "stdio-any"],
  "default": "node",
  "description": "Author-declared runtime contract. 'node' = TS/Node, can call the provider abstraction. 'stdio-any' = language-agnostic stdio process; MUST NOT declare provider requires. Absent ⇒ 'node' (back-compat: all v1 extensions are Node)."
}
```
Add to `allOf` — provider-touching ⇒ node:
```jsonc
{ "if":   { "properties": { "runtime": { "const": "stdio-any" } } },
  "then": { "properties": { "requires": {
              "properties": { "structured_output": { "const": false },
                              "tool_calling":      { "const": false } } } } } }
```

### How it's surfaced at author time
- **Schema** rejects a `stdio-any` extension that also declares `requires.structured_output:true` /
  `requires.tool_calling:true` (the rule, machine-checked).
- **`validate-manifests.ts`** emits the friendly diagnostic: *"runtime:'stdio-any' cannot declare
  provider capabilities — provider calls require the Node/TS provider abstraction; set runtime:'node'
  or drop the requires."* (~20 LOC.)
- **`new-extension.ts` scaffold** prompts/defaults `runtime:"node"` and documents the rule in the
  generated README so the port cost is visible at creation, not discovery.

### Impact on built code
- `validate-manifests.ts`: +the cross-field check above (~20 LOC).
- `install.ts` / `cascade.ts`: **zero change** (`runtime` is manifest metadata; the capability check
  in `install.ts` lines 492–504 already gates `requires` against the provider — `runtime` just makes
  the *language* precondition explicit and author-visible).
- Host loader: MAY use `runtime` to pick the launcher (node vs raw stdio), but default `node` keeps v1
  behavior. Spec note.

### Back-compat
`runtime` is optional with `default:"node"` — **every v1 extension is implicitly `node`**, which is
exactly what they already are (`dist/index.js`). No v1 manifest changes; no v1 install changes. Schema
stays **v1**.

### Trade-offs / rejected alternative
**Rejected: pure documentation with no field.** Cheapest, but unenforceable — a future tenant could
ship a Python provider-caller and only discover the impossibility at runtime, repeating exactly the
memory porting surprise. **Also rejected: mandating Node universally** — over-broad, excludes valid
non-Node provider-free stdio MCP servers. The conditional field + targeted lint is the minimum that
makes the real constraint (provider abstraction is TS) machine-visible without over-constraining.
**Cost:** one more optional field and a lint rule. Accepted.

---

## G-E — Capability-declaration granularity when one extension spawns another

### Decision
**`requires` stays per-extension on the extension that is *installed and host-loaded*; a `bundle`
keystone does NOT aggregate.** Document the rule; add a `validate-manifests.ts` advisory that flags
**redundant** `requires` (identical block on a member and on a sibling it spawns) as a `warn`, not an
error.

**Rationale.** `../sox-memory/design.md` §1.3 + §8/G-E: `requires` exists so the *installer* can check
it against the configured provider (`install.ts` lines 492–504). The check must fire for whatever the
host actually loads and runs. `memory-server` (loaded) declaring `structured_output` is correct;
`memory-organizer` (spawned *behind* the server but also independently installable + provider-calling)
declaring it is also correct — both can be the entity the installer evaluates depending on install
shape. Aggregating to a bundle keystone would (a) hide a member's real requirement when the member is
installed *without* the bundle, and (b) violate independent-versioning/standalone-installability (I4):
a member must carry its own truth. The redundancy the tenant noticed is *cosmetic*, not a correctness
bug — so the fix is an advisory, not a structural change.

### The rule (stated for the ecosystem)
1. **Every provider-calling extension declares its own `requires`** — it must be correct when
   installed standalone.
2. **A bundle does NOT declare `requires`** (a bundle has no runtime; it expands to members that carry
   their own — consistent with G-B's "bundle has no entrypoint").
3. **When extension A spawns extension B and both are separately installable**, both declare what
   *they* call. Redundancy is acceptable and is the safe default; it is **warned**, never errored.
4. The installer's effective requirement for a set = the **union** of installed members' `requires`
   (max of `min_context_tokens`, OR of booleans). (This is already the natural behavior of checking
   each entry; documented, no code change beyond the existing per-entry loop.)

### Exact delta
**No schema change.** `requires` is unchanged. Optional `validate-manifests.ts` advisory:
```
warn: extension "memory-organizer" declares requires identical to its dependency
      "memory-server"; this is redundant but safe. Keep it if memory-organizer is
      installable standalone; otherwise it may be dropped. (G-E advisory)
```
Detection: for any extension X with `dependencies:[D]` where X.requires deep-equals D.requires, emit
the warn. (~25 LOC.)

### Impact on built code
- `validate-manifests.ts`: +the advisory above (~25 LOC, severity `warn` → never blocks CI).
- `install.ts`: **zero change** — the per-entry capability loop (lines 492–504) already does the right
  thing; the union semantics are documentation of existing behavior.
- `cascade.ts` / schema / host loader: **zero change.**

### Back-compat
No schema or install change; the new diagnostic is a `warn`. Every v1 (and `sox-memory`'s current)
manifest validates unchanged; the `memory-organizer`/`memory-server` double-declaration becomes a
warn, not a break.

### Trade-offs / rejected alternative
**Rejected: aggregate `requires` at the bundle keystone.** It removes the cosmetic redundancy but
breaks standalone-installability (a member installed without the bundle would lose its requirement)
and independent versioning (I4). The per-extension rule + advisory keeps correctness and just informs
the author. **Cost:** the cosmetic redundancy remains (by design); it is now *explained* rather than
*structurally prevented*. Accepted.

---

## 7. Model-coherence check (do the additions preserve the invariants?)

| Invariant | G-A lifecycle | G-B bundle | G-C promotion | G-D runtime | G-E requires |
|---|---|---|---|---|---|
| **I1 closed type enum** | ✅ preserved (metadata, no new type) | ⚠️ **bends:** enum 6→7 (`+bundle`) — the *only* enum growth in v2, justified by a genuinely distinct (install-time-only) invocation model | ✅ (uses existing hook type) | ✅ | ✅ |
| **I2 manifest-is-data** | ✅ | ✅ | ✅ (config convention, not behavior) | ✅ | ✅ |
| **I3 immutable id** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **I4 independent versioning** | ✅ | ⚠️ **bends slightly:** a bundle pins member ranges, so a consumer who pins only the *bundle* version gets members chosen by the bundle. Mitigated: members are still published + versioned independently and can be overridden per-id (G-B). It's a *two-level* pin, not a monolith — distinct from the `sox-cto-system` anti-pattern, which *re-vendors* copies. | ✅ | ✅ | ✅ (per-extension `requires` *protects* I4 — that's why keystone-aggregation was rejected) |
| **I5 narrowest-wins / arrays-replace** | ✅ (not in cascade) | ✅ **preserved** — expansion is post-cascade; merge-mode change explicitly rejected to keep this | ✅ (data-plane, not cascade) | ✅ | ✅ |
| **I6 four-files footprint** | ✅ (no new files) | ⚠️ a bundle has *fewer* files (no entrypoint/behavior-tests) — relaxes I6 *downward*, not a footprint bloat | ✅ | ✅ | ✅ |

**Invariants bent, named honestly:**
- **G-B grows the closed enum (I1) and introduces a two-level version pin (I4).** This is the single
  deliberate model change in v2. It is justified because a bundle's invocation model (resolved away at
  install, never host-loaded) is genuinely distinct from all six behavioral types — the taxonomy's own
  criterion for a new primitive — and because the alternative (merge-mode change) would bend the
  *more* load-bearing arrays-replace invariant. The "stateless" property is **not** touched by bundle.
- **G-A does NOT break "stateless."** The taxonomy already files "requires a running server process"
  under mcp-server; `lifecycle` formalizes host ownership of that process. The *daemon* is stateful,
  but it always was (the tenant's `memoryd`); the lifecycle block moves the statefulness from
  extension-self-managed to **host-supervised**, which is *more* aligned with the model (the host owns
  process lifetime, like it owns the cascade), not less.
- **No other invariant is bent.** G-C, G-D, G-E are additive metadata/documentation + advisory lints
  with zero cascade/install/host-load behavioral change for v1 extensions.

---

## 8. v2 LOC budget (proportionate to the increment)

| Gap | Schema delta | Code delta (built scripts) | New LOC |
|---|---|---|---|
| G-A lifecycle | `extension/v1.json` (+block, +1 allOf) | `validate-manifests.ts` cross-check | ~25 |
| G-B bundle | `extension/v1.json` (+enum, +members, +allOf) | `install.ts` expansion+cycle-guard ~60; `validate-manifests.ts` ~30; `build-index.ts` ~5; `DIR_TO_TYPE` +1 | ~95 |
| G-C promotion | none (config convention) | event-vocabulary spec; optional default handler ~40 (out of core budget) | ~0 core (~40 optional) |
| G-D runtime | `extension/v1.json` (+field, +allOf) | `validate-manifests.ts` cross-field ~20; `new-extension.ts` scaffold ~10 | ~30 |
| G-E requires | none | `validate-manifests.ts` advisory ~25 | ~25 |
| **v2 core total** | | | **≈ 175 LOC** |

This sits **on top of** the v1 ~730-LOC core glue (`migration.md` §0/changelog), a ~24% additive
increment — proportionate for closing five tenant gaps. The optional G-C reference handler (~40) and
any host-loader supervisor code are **outside** the core budget, consistent with v1 treating the host
loader / registry server as host responsibilities, not built artifacts.

---

## 9. Summary of decisions (one line each)

- **G-A:** additive `lifecycle{}` block on mcp-server/agent — host-owned supervision; **rejected** 7th `service` type.
- **G-B:** new `bundle` type that **expands to install entries** post-cascade; **rejected** cascade append merge-mode (keeps arrays-replace).
- **G-C:** documented pattern + generic `ScopePromotionProposed` host event + `config.promotion` convention; **rejected** first-class cascade/schema promotion.
- **G-D:** optional `runtime` field (`node`/`stdio-any`) + targeted lint (Node required iff provider-touching); **rejected** doc-only and rejected universal-Node mandate.
- **G-E:** per-extension `requires` stays; advisory `warn` on redundancy; **rejected** keystone aggregation.

**Bent invariants:** G-B grows the type enum (I1) and adds a two-level version pin (I4) — the only
deliberate model changes; everything else is strictly additive. v2 core ≈ 175 LOC.

---

## 10. v2 conformance note (P11 — 2026-06-07)

**Status:** COMPLETE. All five gaps implemented as designed, verified end-to-end by P11.

| Gap | Design decision | Implemented in | Test(s) |
|---|---|---|---|
| **G-A lifecycle** | Additive `lifecycle{}` block on `schemas/extension/v1.json`; `validate-manifests.ts` checks: lifecycle ⇒ type∈{mcp-server,agent}; socket/command health ⇒ endpoint required | `schemas/extension/v1.json`, `scripts/validate-manifests.ts` | `P8 G-A service lifecycle block` (validate-manifests.test.ts); `G-A: lifecycle block` (v2-e2e.test.ts) |
| **G-B bundle** | New `bundle` type in enum; `members` field; post-cascade expansion in `install.ts`; cycle guard; `validate-manifests.ts` bundle checks; `build-index.ts` scans `bundles/`; example `extensions/bundles/sox-memory-bundle/` | `schemas/extension/v1.json`, `scripts/install.ts`, `scripts/validate-manifests.ts`, `scripts/build-index.ts` | `P9 G-B bundle expansion` (install.test.ts); `P9 G-B bundle type` (validate-manifests.test.ts); `G-B: bundle installs atomically` (v2-e2e.test.ts) |
| **G-C promotion** | `docs/scope-promotion.md`: `ScopePromotionProposed` event + `config.promotion` convention + approval-locus rule + per-identity-not-a-5th-scope rule. No schema/cascade change. | `docs/scope-promotion.md` | `G-C: scope-promotion event documented` (v2-e2e.test.ts) |
| **G-D runtime** | Optional `runtime: node\|stdio-any` field + `allOf` conditional in schema; friendly diagnostic in `validate-manifests.ts` (error severity); `new-extension.ts` defaults `runtime:"node"` | `schemas/extension/v1.json`, `scripts/validate-manifests.ts`, `scripts/new-extension.ts` | `P7 G-D runtime-language contract` (validate-manifests.test.ts); `G-D: runtime:stdio-any + provider-requires is rejected` (v2-e2e.test.ts) |
| **G-E requires** | Advisory `warn` (never error) in `validate-manifests.ts` when extension X with `dependencies:[D]` has `requires` deep-equal to D's `requires`. No schema change. | `scripts/validate-manifests.ts` | `P10 G-E requires-granularity advisory` (validate-manifests.test.ts); `G-E: requires-redundancy advisory` (v2-e2e.test.ts) |

**Back-compat verification:** `pnpm run validate-manifests` exits 0 across all 7 extensions (6 v1 + 1 bundle). Full suite: 131 tests, 0 failures. The `cascade.ts` arrays-replace rule is byte-unchanged. All v1 manifests (no `lifecycle`, no `runtime`, no `members`, no `dependencies`) validate and install without modification.

**Key test names (P11 acceptance):**
- `G-A PASS: mcp-server with lifecycle.background:true validates (supervision contract)`
- `G-B: installing sox-memory-bundle resolves to exactly 4 member extensions`
- `G-C: ScopePromotionProposed event is defined in the doc`
- `G-D FAIL: runtime:stdio-any with requires.structured_output:true is rejected`
- `G-E: redundant requires emits warn, not error; ok remains true`
- `pnpm run validate: the real extensions/ tree validates (7 extensions, 0 errors)`
