# Workflow optimization suggestions — sox-ecosystem framework-contract-completion

Based on: /Users/nix/dev/ai/sox-ecosystem/.workflow/plans/framework-contract-completion/analysis.md (generated 2026-06-08)
Grounded in: docs/guidelines/README.md + docs/guidelines/<type>.md (per-type "owes" sections), docs/architecture-audit.md, docs/engine-defects-found.md
Research as of: 2026-06-08

## Framing

The analysis grades the **framework's** contracts and identifies a single causal spine:
build/output-generation (#4) is Absent for every process type, which silently nullifies the
otherwise-Defined lockfile (#3) and release (#7) rows; and the activation/consumption seam (#8/#9)
is Absent for all five runtime types, so `installed` never becomes `running`. Each suggestion below
closes one hole-cluster, cites the analysis row(s) + guideline doc + audit evidence, and honors the
prerequisite ordering the analysis handed down (#4 → #5/#6 → #8 → #9 → #12; bundle / config /
permission are parallel).

The consumer-interface engagement is **complete**: `bin/sox` is the operator surface. Every runtime
contract proposed here must integrate **below** that CLI — the CLI invokes install today (`bin/sox`
line 265) and stubs `update`/`search`/`enable`/`disable` (lines 609–615). The host runtime is the
missing callee that turns the CLI's lockfile output into running extensions.

Ranking is by ROI descending, then difficulty ascending, then critical-path position. The
prerequisite chain partially overrides pure ROI ordering: a `critical` item that is *blocked* is
listed at its true position but flagged `BLOCKED BY` so the planner cannot schedule it first.

---

## Ranked suggestions

### 1. Framework-owned build/output-generation subsystem + entrypoint-reachability gate — ROI: critical · Difficulty: M

**Hole closed:** analysis row #4 (`source → build artifacts`: **Absent** for mcp/hook/agent/skill/
command; N/A for prompt/bundle) — the linchpin that turns nominal rows #3/#7 (`²` footnote) into
real ones. Also closes audit Gap D1 (CRITICAL), Gap D3 (hand-maintained `dist/`), Gap F4
(entrypoint/output path mismatch), and the precondition half of Gap C4 (lockfile records `.ts`
source, not a built `.js` artifact).

**Pattern (from guideline + memory):** The guideline set's first cross-type finding states build is
"the single most universal framework hole … you can pin and publish an artifact that was never
generated" (README.md, finding 1). Best-practice from memory: a manifest's entry point is resolved
by the host's loader against a *built* artifact, and mature ecosystems treat hand-maintained output
as an anti-pattern; the build-vs-reuse matrix prescribes reusing the workspace task runner
(pnpm `--filter` / Turborepo) with thin per-package `tsconfig.json` glue rather than a bespoke
compiler [memory:extension-ecosystem-design/build-vs-reuse-and-build-plan.md].

**Proposal:**
- Add a per-package `tsconfig.json` (or workspace `tsconfig.packages.json` with project references)
  that compiles each `src/index.ts` to that package's own `dist/index.js` — the exact path the
  `entrypoint` field resolves to. This makes output **deterministic and uniform** across all nine
  process-type packages.
- Add `pnpm -r build` to the CI validate workflow after `pnpm typecheck`.
- Add an **entrypoint-reachability validation gate**: a validator step that, for every manifest with
  an `entrypoint`, asserts the resolved path exists post-build (closes audit recommendation #7).
  This is where row #4 becomes **Defined** (specified *and* enforced) per the guideline legend.
- Retire the hand-maintained `dist/*.js` mirrors documented in `docs/cli-build-decision.md`; the
  build subsystem makes the "Discipline B" hand-authoring decision obsolete.

**Difficulty: M** — touches all nine process-type packages (new tsconfig each), the CI workflow, and
the validator + its tests; cross-cutting but mechanical, no new subsystem. ≤ 1 week.

**Expected ROI: critical** — measurable: converts rows #3 and #7 from nominal to real for 5 of 7
types (footnote `²` removed), and takes the count of executable behavioral extensions from 0 → 9
(audit: "makes every behavioral extension non-executable"). Strict prerequisite for items 3, 4, 5.

**Risk:** Retiring hand-maintained `dist/` while the cross-package relative import in
`memory-flush/src/index.ts:262` still points at `../../../dist/memory-lib.js` (audit Gap A4) will
break that hook at runtime unless sequenced with item 9's import fix. Build-output path changes can
break the install client's source-resolution logic (install.ts lines 311–317) — retest install.

**Sources:** docs/guidelines/README.md (finding 1); docs/architecture-audit.md Gaps D1/D3/F4, rec #1/#7; analysis.md rows #4/#3/#7 + footnote ²; [memory:extension-ecosystem-design/build-vs-reuse-and-build-plan.md]

---

### 2. Host runtime — unified loader + supervisor with per-type adapters (#8) — ROI: critical · Difficulty: L

**Hole closed:** analysis row #8 (`install → activated runtime`: **Absent** for hook/agent/skill/
command; **DU** for mcp; D-mech/A-sem for bundle) — "No host runtime turns `installed` into
`running`." Closes audit Gap C1 (CRITICAL — "the single most consequential finding") and Gap A7
(host version enforcement has no consumer because there is no host).

**Pattern (from guideline + memory):** The guideline README's finding 2 isolates this as the
universal runtime-seam hole. Best-practice from memory favors a **unified loader with per-type
adapters** over N independent loaders: the agent-runtime-platforms survey shows mature stateful
runtimes converge on one process-supervision core with type/shape adapters layered above
[memory:agent-runtime-platforms/2026-04-24-landscape-survey.md], and the manifest-format survey's
recommendation #6 ("no entry point in the manifest itself; runtimes resolve implementation by name
against their own loader") argues the loader is the single point that maps declarative manifest →
runnable [memory:plugin-manifest-formats/cross-language-convergence.md]. The plugin-taxonomy finding
adds that a kind taxonomy survives long-run precisely when one host owns dispatch and the kinds are
adapters, not separate engines [memory:plugin-taxonomies/multi-kind-vs-unified-middleware.md].

**Proposal:** Build a host runtime as a **new subsystem** (not an incremental edit), scoped as a
*unified loader + supervisor* with per-type adapters:
- A loader that reads the lockfile (the artifact `bin/sox install` already produces), resolves each
  entry's built `entrypoint`, and hands it to the right adapter.
- A process supervisor honoring the already-designed `lifecycle{}` block (`background`, `singleton`,
  `stop_timeout_ms`, health probe) — promote `tools/supervisor-shim.js` from "TEST SCAFFOLDING"
  (line 9) to product code as the supervisor's reference core.
- Per-type adapters: mcp (spawn + stdio), hook (register into HookLoader), agent/skill (in-process
  invoke), command (verb registration — integrates with `bin/sox`). This is the #8 layer; #9
  dispatch/registrar is item 4.
- Resolve the socket-endpoint convention (audit Gap A5: `~/.memory/memoryd.sock` tilde is not a
  Node path) as part of the supervisor's health-probe contract.

**Difficulty: L** — a new subsystem (loader + supervisor + ≥4 adapters), 1–4 weeks, staged. This is
the largest single item and the audit's "largest single work item" (rec #2).

**Expected ROI: critical** — measurable: number of runtime types reachable from `installed` goes
0 → 5; converts mcp #8 from DU to Defined. Without it the ecosystem "produces configuration only."

**BLOCKED BY:** item 1 (needs built artifacts) and item 3 (needs manifest self-description to
dispatch without executing code). Cannot start before #4 + #5/#6 land.

**Blast radius:** new subsystem — not a schema or manifest edit. Integrates with `bin/sox` (must add
the loader as install's runtime callee) and the lockfile reader (audit Gap C5: uninstall leaves
stale lock entries a host would naively load).

**Risk:** Scope explosion — staging per-type adapters is mandatory (start with mcp + hook, the two
types with existing tenants). A naive lockfile-reading host trips Gap C4 (`.ts` source pinned) unless
item 1 ships first and Gap C5 (stale uninstall entries) unless lockfile cleanup is addressed.

**Sources:** docs/guidelines/README.md (finding 2); docs/architecture-audit.md Gaps C1/A5/A7/C4/C5, rec #2/#6; analysis.md row #8 + ordering step 4; [memory:agent-runtime-platforms/2026-04-24-landscape-survey.md]; [memory:plugin-manifest-formats/cross-language-convergence.md]; [memory:plugin-taxonomies/multi-kind-vs-unified-middleware.md]

---

### 3. Per-type manifest self-description + interface contracts (#5/#6), optional-first then enforced — ROI: high · Difficulty: M

**Hole closed:** analysis rows #5 (`author → type runtime contract`: **Absent** for all 7) and #6
(`source → interface descriptors`: Absent for all process types, Implicit for bundle). Closes audit
Gaps A1 (hook `event` not in schema), F1 (no event vocabulary), F2 (dependencies declared but never
enforced). Directly cures the empirically-observed divergence the analysis cites: `event` vs
`events` (hook), `tools[]` vs `organizeItems()` (agent), `run(input)` vs `runCli(argv)` (command).

**Pattern (from guideline + memory):** The analysis (footnote ¹) notes manifests today validate
"shape only — validation does not assert … declared-tool/event/verb validity." Memory's strongest
prescription: capability declarations are **universal** across mature manifest systems (7/8), and a
**closed enum** beats open strings "when ordering or composition has correctness implications" — adopt
Envoy's well-known-names model and VS Code's contribution-points model
[memory:plugin-manifest-formats/cross-language-convergence.md §3.1]. The consumer-interface finding
identifies a "manifest self-description block" as the convergent surface that lets a host discover
capability without executing code [memory:extension-consumer-interface/consumer-interface-lifecycle-conformance.md].
Memory's additive-evolution rule supports the optional-first → enforced rollout: "unknown field
within a known section → warn but accept" [same §3.7], i.e. ship the field optional, then flip the
validator to required.

**Proposal:** Per type, add the self-description field the guideline doc specifies and validate it:
- **hook:** required `events: []` array + a **closed enum** of valid host event names (audit rec #3,
  Gap F1) — host discovers binding without running code.
- **agent / command:** declare invocation protocol + handler interface (resolves `tools[]` vs
  `organizeItems`, `run` vs `runCli`).
- **skill:** declare run/IO interface (`run(input)` signature).
- **prompt:** declare parameter set + template-syntax (prompt's seam per analysis per-type note).
- **mcp:** transport + tool descriptors.
- **bundle:** member-existence guarantee (row #6 is Implicit, not Absent, for bundle — see item 6).
- Wire `dependencies` enforcement into the install client (audit Gap F2 — field exists, no consumer).
- **Rollout:** add each field *optional-first* (validator warns), then flip to *required* once the
  11 existing manifests are retrofitted — this is where rows #5/#6 become Defined.

**Difficulty: M** — schema change → **all 11 manifests + validator + its tests** (declared blast
radius), plus a retrofit of the existing manifests when fields flip to required. Cross-cutting,
≤ 1 week. New *required* fields force the retrofit explicitly.

**Expected ROI: high** — measurable: enables static discovery for 7 types (host can enumerate
bindings/tools/verbs without code execution), the precondition for any dispatcher; eliminates 3
already-observed divergence classes. Prerequisite for items 2 and 4.

**Blast radius:** schema change → all 11 manifests + `scripts/validate-manifests.ts` + its tests
(`scripts/validate-manifests.test.ts`). New required fields → retrofit of every existing manifest.

**Risk:** Flipping optional → required before all tenants are retrofitted breaks CI for in-flight
extensions; gate the flip on a green retrofit. A closed event enum that omits an in-use event name
(e.g. `ScopePromotionProposed`) would reject a valid hook — seed the enum from current usage first.

**Sources:** docs/guidelines/README.md (finding 3 — observed divergence); docs/architecture-audit.md Gaps A1/F1/F2, rec #3/#5; analysis.md rows #5/#6 + footnote ¹ + per-type notes; [memory:plugin-manifest-formats/cross-language-convergence.md §3.1/§3.7]; [memory:extension-consumer-interface/consumer-interface-lifecycle-conformance.md]

---

### 4. Host runtime — per-type dispatcher / registrar / renderer (#9) — ROI: high · Difficulty: L

**Hole closed:** analysis row #9 (`runtime → delivered to consumer`: **Absent** for all 5 runtime
types; N/A for bundle). Closes audit Gap C2 (CRITICAL — no MCP tool registration into an agent
surface) and the agent-side half of Layer 0.

**Pattern (from guideline + memory):** The guideline README finding 2 marks the consumption seam
Absent for all five runtime types. Memory: the host MCP registrar is the "client that discovers and
exposes tools" — the missing counterpart to the correctly-implemented stdio server; agent-runtime
platforms converge on a registrar/dispatch layer above the supervisor
[memory:agent-runtime-platforms/2026-04-24-landscape-survey.md]. For commands, the verb→handler
dispatch must register into the existing `bin/sox` verb surface — the consumer interface is the
integration point [memory:extension-consumer-interface/consumer-interface-lifecycle-conformance.md].

**Proposal:** On top of item 2's supervisor, add the per-type delivery layer:
- **mcp registrar:** a host-side MCP client that discovers tools from spawned servers and exposes
  them into the agent's surface (closes Gap C2; the transport already exists in
  `memory-server/src/index.ts` lines 324–366).
- **command dispatcher:** verb→handler dispatch wired into `bin/sox` (also lets `update`/`search`/
  `enable`/`disable` stubs become real, audit Gaps C3/C6).
- **agent/skill invoker + prompt renderer:** deliver agent/skill/prompt output to the consumer.

**Difficulty: L** — extends the new subsystem with per-type delivery logic; 1–4 weeks; staged after #8.

**Expected ROI: high** — measurable: tools reachable from an agent surface goes 0 → N; closes the
last break in the audit's end-to-end chain trace (Steps 3/4/5 → all resolved with items 1+2+4).

**BLOCKED BY:** item 2 (#8 must exist first) and item 3 (needs interface descriptors to dispatch).

**Blast radius:** new subsystem extension; integrates with `bin/sox` (command dispatch) and the
agent host surface (MCP registrar).

**Risk:** MCP registrar security — the audit (Gap F5) notes the MCP transport has no auth and
caller-supplied `db_path` is unsandboxed; the registrar must not expose this to multiple clients
without the resource/permission contract (item 5).

**Sources:** docs/guidelines/README.md (finding 2); docs/architecture-audit.md Gaps C2/C3/C6/F5; analysis.md row #9 + ordering step 5; [memory:agent-runtime-platforms/2026-04-24-landscape-survey.md]; [memory:extension-consumer-interface/consumer-interface-lifecycle-conformance.md]

---

### 5. Event bus + lifecycle signals (#12) incl. DEFECT-1 `fireIsolated()` fix — ROI: high · Difficulty: M

**Hole closed:** analysis row #12 (`event/lifecycle signal → reaction`: **A+defect** for hook, **DU**
for mcp, Absent for agent/skill/command). Closes audit Gap A2 (DEFECT-1, MEDIUM) and the
host-event-bus row (audit §6: "Absent — test scaffolding only", `tools/host-event-shim.js`).

**Pattern (from guideline + memory):** The analysis singles out the hook seam as "A+defect" —
worse than plain Absent because a defect actively suppresses downstream hooks. `docs/engine-defects-
found.md` specifies the fix verbatim: a `fireIsolated()` variant that continues the chain past a
throwing hook and returns per-hook error results. Memory's ordering rule for composed handlers
(Envoy: ordered filter chain where one filter must not silently abort the rest) is the design
analogue [memory:plugin-manifest-formats/cross-language-convergence.md §3.1].

**Proposal:**
- Implement `fireIsolated()` in `scripts/hook-loader.ts` exactly as specified in
  `docs/engine-defects-found.md` (continue-on-throw, collect `{id, error}` per hook); make it the
  call site the host uses for all lifecycle dispatch. Update the two pinned KNOWN-DEFECT tests in
  `scripts/hook-isolation.test.ts` to assert the *isolated* behavior.
- Build the host event bus on top of the host runtime: a registry of the closed event vocabulary
  (item 3's enum) that fires lifecycle signals through `fireIsolated()` and lets mcp/agent/skill/
  command react — converting mcp #12 from DU to Defined.

**Difficulty: M** — DEFECT-1 fix is XS-to-S on its own (one method + two test updates); the event bus
is the larger part but builds on the host runtime. ≤ 1 week once #8 exists.

**Expected ROI: high** — measurable: eliminates silent data loss (a single buggy hook can currently
suppress all downstream hooks); converts row #12 from A/DU to Defined for hook + mcp.

**BLOCKED BY:** the event-bus portion requires the host runtime (item 2). The `fireIsolated()` fix
itself is **independent** and can land in parallel immediately (it is pure engine code).

**Risk:** Changing `fire()` semantics could surprise call sites relying on abort-on-throw; the
defect doc recommends keeping `fire()` for back-compat and adding `fireIsolated()` as the new
default — follow that to avoid a breaking change.

**Sources:** docs/engine-defects-found.md (DEFECT-1, fix spec); docs/architecture-audit.md Gap A2, rec #11, §6; analysis.md row #12 + ordering step 3/6; [memory:plugin-manifest-formats/cross-language-convergence.md §3.1]

---

### 6. Per-extension config schema (#10) + resource/permission contract (cross-cutting) — ROI: med · Difficulty: M

**Hole closed:** analysis row #10 (`scope config → applied config`: cascade Defined but **cfg-schema
Absent** for all types) and the "Resource/permission contract: Absent for all" universal hole. Closes
audit Gaps F3 (no per-extension config schema), F5 (MCP transport / `db_path` unsandboxed), A6
(misleading embed-model config silently accepted).

**Pattern (from guideline + memory):** The analysis lists both as **parallel / order-independent** —
they do not block the runtime chain. Memory: per-extension config validation is the convergent
"applicability/scope" + capability declaration layer; the build-vs-reuse matrix prescribes reusing
JSON Schema + AJV (already in the repo for manifests) to validate each extension's config block
against a manifest-declared schema [memory:extension-ecosystem-design/build-vs-reuse-and-build-plan.md].
The policy-enforcement topic supports a declared resource/permission contract as the bounding layer
for fs/network/socket access [memory:policy-enforcement/INDEX.md].

**Proposal:**
- Let each manifest declare a JSON Schema for its `config` block; validate scope-resolved config
  against it at install time (closes Gap F3 — `extensions-config/v1.json` currently accepts any
  object). This makes row #10 Defined.
- Add a resource/permission declaration block (fs/network/socket scopes) per type; the host runtime
  (items 2/4) enforces the declared bounds — closes Gap F5 (unsandboxed `db_path`).

**Difficulty: M** — schema change → all 11 manifests + validator + tests + install client; reuses
existing AJV machinery. ≤ 1 week. Can run **in parallel** with the runtime chain.

**Expected ROI: med** — qualitative: prevents silent misconfiguration and bounds resource access;
high *value* but not on the critical path to `running`, so med relative to items 1–5. Measurable:
config blocks validated against schema goes 0 → 11.

**Risk:** The permission contract is only meaningful once the host runtime enforces it; shipping the
declaration without the enforcer (items 2/4) leaves it Declared-unimplemented — sequence the
enforcement half after the host runtime exists.

**Sources:** docs/architecture-audit.md Gaps F3/F5/A6, rec #10; analysis.md row #10 + parallel note; [memory:extension-ecosystem-design/build-vs-reuse-and-build-plan.md]; [memory:policy-enforcement/INDEX.md]

---

### 7. Bundle composition contracts — member-existence, version-conflict policy, bundle provenance (#5/#6/#3 for bundle) — ROI: med · Difficulty: S

**Hole closed:** the bundle-specific holes the analysis isolates (per-type deviation note + row #3
`D(mbr)/A(bundle id)`): member-existence validation (#5), version-conflict resolution policy with
operator-visible signal (#6 — currently first-seen dedup pinned as behavior), and bundle-provenance
in the lockfile (#3 — the bundle id is erased after expansion). Closes audit Gap A3 (silent
first-seen dedup, MEDIUM).

**Pattern (from guideline + memory):** The analysis notes the "spine contracted / seam not" thesis
"does not cleanly reproduce" for bundle — a bundle has no build and no runtime; its real holes are
install-time composition. Memory: conflict detection should be **explicit and operator-visible**, not
silent (OPA refuses to activate bundles with overlapping `roots` rather than silently picking one)
[memory:plugin-manifest-formats/cross-language-convergence.md §3.6], and dependency/composition
references should be validated by id at parse time [same §2].

**Proposal:**
- **Member-existence validation:** the validator asserts every bundle member id resolves (row #5 for
  bundle → Defined).
- **Version-conflict policy + signal:** replace silent first-seen dedup in `expandBundles()`
  (install.ts lines 709–794) with an explicit policy that emits an **operator-visible warning/error**
  on conflicting member version specs (closes Gap A3; the behavior is currently *pinned* in
  `scripts/bundle-collision.test.ts` lines 120–163 — those tests must be updated).
- **Bundle provenance in lockfile:** record the originating bundle id per expanded member so an
  operator can "remove all members of this bundle" (row #3 bundle-id → Defined).

**Difficulty: S** — edits the install client + validator + the two pinned collision tests; no schema
change to all 11 manifests, scoped to bundle. ≤ 1 day to a few days. Runs **in parallel** with the
runtime chain (analysis: order-independent).

**Expected ROI: med** — qualitative: eliminates invisible dependency shadowing "at scale (multiple
organization-provided bundles)"; measurable: version-conflict events surfaced 0 → all.

**Risk:** Changing dedup to error-on-conflict could break existing installs that silently relied on
first-seen; consider warn-first then error, mirroring item 3's optional-first rollout.

**Sources:** docs/architecture-audit.md Gap A3; analysis.md per-type deviation (bundle) + row #3; [memory:plugin-manifest-formats/cross-language-convergence.md §3.6/§2]

---

## Critical-path ordering (honoring the analysis prerequisite chain)

```
            ┌─────────────────────────── PARALLEL TRACK (order-independent) ───────────────┐
            │  6. Config schema + permission (decl)   7. Bundle composition contracts       │
            │  5a. DEFECT-1 fireIsolated() fix (pure engine, no host dep)                    │
            └───────────────────────────────────────────────────────────────────────────────┘

  1. BUILD (#4)  ──►  3. MANIFEST SELF-DESCRIPTION (#5/#6)  ──►  2. HOST RUNTIME loader+supervisor (#8)
   [linchpin]          [enables static dispatch]                       │
                                                                       ▼
                                                       4. DISPATCHER/REGISTRAR/RENDERER (#9)
                                                                       │
                                                                       ▼
                                                       5b. EVENT BUS / LIFECYCLE (#12)
```

- **#4 (item 1) is the linchpin** — it must complete first; it unblocks the entire runtime chain and
  retroactively makes rows #3/#7 real.
- **#5/#6 (item 3)** must precede the host runtime (item 2) — a dispatcher needs static interface
  descriptors to route without executing code.
- **#8 (item 2)** precedes **#9 (item 4)** precedes **#12 event bus (item 5b)**.
- **Can run in parallel from day one:** item 5a (DEFECT-1 fix — pure engine), item 6 (config/
  permission *declaration*), item 7 (bundle composition). Item 6's *enforcement* half and item 5b's
  *event-bus* half wait for the host runtime.

## Biggest blast-radius items

- **Schema changes (items 3, 6):** all 11 manifests + `scripts/validate-manifests.ts` + its tests;
  new *required* fields force a retrofit of every existing manifest.
- **Host runtime (items 2, 4):** a **new subsystem**, not an incremental edit — loader + supervisor
  + per-type adapters/registrar. The single largest work item; must integrate below `bin/sox`.
- **Build subsystem (item 1):** touches all nine process-type packages + CI + validator; retiring
  hand-maintained `dist/` is coupled to item 9-class import fixes (Gap A4).

## Consumer-interface integration points (CLI is complete; runtime integrates below it)

- `bin/sox install` already produces the lockfile — item 2's loader is its missing runtime callee.
- Item 4's command dispatcher registers into `bin/sox` verbs and can fill the stubbed
  `update`/`search`/`enable`/`disable` (audit Gaps C3/C6).
- Item 2 must address lockfile hygiene (audit Gap C5: `sox uninstall` leaves stale lock entries a
  naive host would load) and Gap C4 (lockfile pins `.ts` source — fixed by item 1's built artifacts).

## Research gaps

None blocking. Every recommendation is grounded in the in-repo guideline set / audit / defect doc
and corroborated by the global research memory. Two items the analysis did **not** raise that the
audit flags as out-of-scope here (recorded, not proposed):

- `Conjecture:` the hash-projection embedding (audit Gap A6, `embed.ts` line 20) degrades recall but
  is a tenant-quality issue, not a framework-contract hole — out of scope for this engagement.
- `Conjecture:` placeholder schema `$id` URLs (audit Gap D5) and absolute-local registry source URLs
  (Gap A8) are distribution-hygiene items orthogonal to the build→activation→consumption seam — defer.
```
