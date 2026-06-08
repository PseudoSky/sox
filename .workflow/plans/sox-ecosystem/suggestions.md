# Workflow optimization suggestions — sox-ecosystem (greenfield LLM extension ecosystem)

Based on: /Users/nix/dev/ai/sox-ecosystem/.workflow/plans/sox-ecosystem/analysis.md (generated 2026-06-07, LIVE workflow-analyzer run)
Research as of: 2026-06-07 (`~/.claude/plugins/workflow/memory/research/extension-ecosystem-design/`)
Backup of prior architect seed: `suggestions.seed.md` (NOT overwritten)

> **Scope of this run.** The analysis is a live inventory of the *inherited global* SOX/workflow
> tooling plus an explicit ALIGNED/DIVERGENT comparison (analysis.md §4) against the 7-phase build
> plan in `migration.md`. The project itself is greenfield (no commits, no `.claude/`). These
> suggestions therefore close the gap between **the proven-but-monolithic patterns the live SOX
> ecosystem demonstrates** and **the independent-extension target the migration plan builds toward**,
> plus three live-only findings the research-derived seed missed (5-agent duplication, no eval
> harness, 15 dormant plugins). Each suggestion cites the divergence it closes, a research finding,
> and the migration phase that already (or should) carry it.

---

## Ranked suggestions

### 1. Independent per-extension versioning via Changesets — ROI: high · Difficulty: M

**Divergence closed:** analysis.md §4 DIVERGENT #1 (largest gap) — `sox-cto-system` v2.0.23 bundles
4 agents + 3 skills + scripts + templates under one semver; a fix to one skill forces a version bump
that re-publishes everything.
**Pattern (from memory):** Changesets independent mode emits per-package intent files at PR time,
computes per-package semver, and publishes only changed packages. [memory:extension-ecosystem-design/independent-versioning-via-changesets.md]; reference architecture §3 [memory:extension-ecosystem-design/llm-extension-repo-reference-architecture.md].
**Proposal:** Adopt `.changeset/config.json` with `fixed: []` (true independent mode) over a
pnpm-workspace tree where every extension is its own package with its own `package.json` + `CHANGELOG.md`.
Already specified in migration.md P0 (`.changeset/config.json`) and proven in P5 (skill-only bump
shows exactly one pending package). This suggestion ratifies it as the highest-leverage move and
flags the live monolith as the concrete anti-pattern it replaces.
**Rationale:** This single decision is what makes the other five divergences coherent — immutable
ids, dedup, scaffold, distribution, and hook ordering all assume per-extension granularity. Without
it the repo reproduces the monolith the analysis identifies.
**Difficulty:** M — cross-cutting: workspace layout + `.changeset` config + CI release wiring,
but all reuse (no novel code). Reversible (config-level). Bounded to migration P0+P5.
**Expected ROI:** high. Measurable once live: number of packages re-published per single-extension
change drops from N (whole monolith) to 1; `pnpm changeset status` after a one-extension bump lists
exactly one pending package (migration P5 acceptance check).
**Risk:** `extension.json.version` drifting from `package.json.version` (the seed's MED risk) — the
two must be CI-synced; mitigated by suggestion #5's version-sync check.
**Sources:** [memory:extension-ecosystem-design/independent-versioning-via-changesets.md], [memory:extension-ecosystem-design/llm-extension-repo-reference-architecture.md]; migration.md §Phase 0, §Phase 5.
**Migration phase:** P0 (config) → P5 (independence proven).

---

### 2. Immutable slug `id` + CI-enforced dedup invariants — ROI: high · Difficulty: S

**Divergence closed:** analysis.md §4 DIVERGENT #2 — live plugins key on `name@marketplace` with no
uniqueness or immutability enforcement.
**Pattern (from memory):** A stable immutable slug is the primary registry key; three uniqueness
invariants (unique id per registry; ≤1 entry per id in any scope's install list; no shadow copies)
plus shadow-copy prevention guard the namespace. [memory:extension-ecosystem-design/single-source-identity-dedup.md] §3,§4.
**Proposal:** Adopt the `id` field (`^[a-z][a-z0-9-]*$`, immutable once published) as the manifest
primary key (migration.md §1.2 schema) and enforce the three uniqueness invariants in
`validate-manifests.ts` (migration.md §4.5). The `id`-not-ending-in-type-name rule and type/dir match
are part of the same check.
**Rationale:** Immutable ids are the precondition for a content-addressed lockfile and cross-scope
dedup; the live `name@marketplace` scheme cannot express either. This also directly underpins the
live-only finding in #6 (the 5-agent duplication is exactly a "shadow copy" the dedup lint would catch).
**Difficulty:** S — one schema field + a handful of pure checks in one script (migration P0 ships the
id-format + type/dir half; P2 adds dedup). ≤1 day of glue.
**Expected ROI:** high. Measurable: a duplicate-id fixture causes `validate-manifests` to exit
non-zero (migration P2 acceptance, UC-5).
**Risk:** Immutability is a social/process contract, not just a regex — renaming a published id is a
breaking republish. Document the "ids are forever" rule prominently. Low residual risk.
**Sources:** [memory:extension-ecosystem-design/single-source-identity-dedup.md]; migration.md §1.2, §4.5, §Phase 2.
**Migration phase:** P0 (id format + type/dir) → P2 (dedup + cross-scope dup).

---

### 3. Dedup + secret + type/dir lint in CI (`validate-manifests.ts`) — ROI: high · Difficulty: S

**Divergence closed:** analysis.md §4 DIVERGENT #5 — no dedup lint, no type↔directory invariant, no
secret-pattern lint exists in the live system; the only safety constraint is the meta-loop recursion
guard (analysis.md §2.6 / §4 Ecosystem).
**Pattern (from memory):** A read-only lint enforcing the uniqueness invariants, the type/parent-dir
match, version sync, and a secret-in-committed-config regex, run on every PR. [memory:extension-ecosystem-design/single-source-identity-dedup.md] §3,§4; cascade secret-handling [memory:extension-ecosystem-design/multi-scope-install-config-cascade.md] §4.
**Proposal:** Build `scripts/validate-manifests.ts` (migration.md §4.5) wired into `.github/workflows/validate.yml`
(migration P5). Six checks: (1) three uniqueness invariants, (2) id format + no-type-suffix, (3) type/dir
match, (4) `extension.json.version == package.json.version`, (5) cross-scope dup warning, (6) literal-secret
regex blocking non-`${ENV}` API-key-shaped values in committed configs.
**Rationale:** This is the enforcement layer that makes suggestions #1, #2, and #5 *checked* rather than
aspirational. The live system has zero static gates on extension authoring; this is the cheapest
high-leverage safety addition.
**Difficulty:** S — ~80 LOC pure read-only script + one CI workflow file. Split across migration P0
(format/type-dir only) and P2 (dedup + secret). No runtime risk (read-only).
**Expected ROI:** high. Measurable: count of enforced authoring invariants goes 0 → 6; CI blocks a
committed-secret fixture and a duplicate-id fixture (migration P2 acceptance).
**Risk:** Secret-regex false positives could block a legitimate commit; tune the pattern to known
API-key shapes only and require `${ENV}` indirection. Low.
**Sources:** [memory:extension-ecosystem-design/single-source-identity-dedup.md], [memory:extension-ecosystem-design/multi-scope-install-config-cascade.md]; migration.md §4.5, §Phase 2, §Phase 5.
**Migration phase:** P0 (format/type-dir) → P2 (dedup + secret) → P5 (CI wiring).

---

### 4. One-command scaffold generator (`new-extension.ts`, 4 files/extension) — ROI: high · Difficulty: S

**Divergence closed:** analysis.md §4 DIVERGENT #3 — all live extensions are hand-authored; no
scaffold exists.
**Pattern (from memory):** Convention-over-configuration scaffolding emits a minimal fixed file set
per extension (a three-command create/dev/publish contract); zero external scaffold deps. [memory:extension-ecosystem-design/scaffold-first-authoring.md]; reference architecture §5 [memory:extension-ecosystem-design/llm-extension-repo-reference-architecture.md].
**Proposal:** Build `scripts/new-extension.ts` (migration.md §4.4, ~120 LOC, Node `fs`+`readline`, no
Yeoman/Plop) that prompts for type/id/title/description and writes exactly 4 files for the chosen type
(`prompt.md` for prompts, else `src/index.ts`, plus `extension.json`, `package.json`, `CHANGELOG.md`).
The glob `extensions/*/*` auto-discovers — the scaffold never edits `pnpm-workspace.yaml`.
**Rationale:** Scaffolding is what enforces the 4-file convention and the directory↔type invariant *at
authoring time* rather than only at lint time; it makes the independent-versioning + immutable-id
design ergonomic enough to actually use, directly enabling UC-1 (<5-min author time).
**Difficulty:** S — ~120 LOC, single file, no network, no external deps. migration P0. Low risk
(refuses to overwrite an existing dir; aborts on invalid id).
**Expected ROI:** high. Measurable: time-to-author a new extension target < 5 minutes (UC-1);
every scaffolded extension is exactly 4 files and passes `validate-manifests` by construction.
**Risk:** Drift between the scaffold's emitted template and the evolving schema — keep the schema the
single source and generate from it where practical. Low.
**Sources:** [memory:extension-ecosystem-design/scaffold-first-authoring.md], [memory:extension-ecosystem-design/llm-extension-repo-reference-architecture.md]; migration.md §4.4, §Phase 0.
**Migration phase:** P0.

---

### 5. npm + git `registry/index.json` two-tier distribution (replace local-file marketplace) — ROI: high · Difficulty: M

**Divergence closed:** analysis.md §4 DIVERGENT #4 — distribution is a local JSON file
(`/Users/nix/dev/ai/claude-agents/.claude-plugin/marketplace.json`) + GitHub, not npm+CDN; a clean
machine cannot install without that local checkout.
**Pattern (from memory):** Source/registry separation — a metadata-only registry indexes discovery
data while artifacts come from a package CDN; the flat git `index.json` is the registry until ~5k
entries. [memory:extension-ecosystem-design/registry-as-protocol-not-product.md] §2,§5; distribution trade-off matrix [memory:extension-ecosystem-design/distribution-mechanics-monorepo-vs-per-repo.md].
**Proposal:** Build `scripts/build-index.ts` (migration §4.3) emitting `registry/index.json`
(`{id,type,version,title,description,source,checksum,compatibility}`) where `source` is an npm-CDN URL
and `checksum` is `sha256:`; publish artifacts via `changeset publish`; install client fetches from the
CDN and verifies sha256 (migration §4.1, §Phase 4). Keep the Terraform two-endpoint HTTP server
(`scripts/registry-server.ts`) spec-compatible but DEFERRED until ~5k entries (migration Gap 3).
**Rationale:** This is the difference between "works on the author's machine" (current local-file
marketplace) and "installs reproducibly on a clean machine with checksum verification" (UC-3). It also
makes the registry language-neutral (Python agents + TS MCP servers), which a Claude-Code-native bundle
format alone cannot.
**Difficulty:** M — install client + index builder + Changesets publish wiring across P1/P4;
introduces network + supply-chain surface. Reversible per-extension (registry is metadata-only).
**Expected ROI:** high. Measurable: clean-machine install with no prior state resolves a published
version, fetches from CDN, sha256 matches (migration P4 acceptance, UC-3); a tampered artifact is
rejected.
**Risk:** Supply-chain on remote `source` (seed MED risk) — mandatory sha256 verification on every
fetch and content-hash pin on the org `extends` baseline (migration Gap 4) mitigate it. Running an HTTP
registry prematurely would add ops burden — hence DEFER per Gap 3.
**Sources:** [memory:extension-ecosystem-design/registry-as-protocol-not-product.md], [memory:extension-ecosystem-design/distribution-mechanics-monorepo-vs-per-repo.md]; migration.md §4.1, §4.3, §Phase 4, §Gap 3.
**Migration phase:** P1 (index + single-scope install) → P4 (publish→clean-machine) → P6 (optional server, deferred).

---

### 6. Collapse the `sox-active`/`sox-cto-system` 5-agent duplication (live-only finding) — ROI: high · Difficulty: S

**Divergence closed:** analysis.md §4 Ecosystem + §1.3 — `sox-active` v1.0.20 ships 5 agents
(`cto-agent`, `janitor-agent`, `workflow-analyst`, `workflow-implementer`, `planner`) that are ALSO in
`sox-cto-system` v2.0.23. This is a live "shadow copy" the research-derived seed did not surface.
**Pattern (from memory):** The "no shadow copies" invariant — the same id must not exist as two
separately-versioned installables — is one of the three uniqueness invariants and the canonical
dedup-lint target. [memory:extension-ecosystem-design/single-source-identity-dedup.md] §3,§4.
**Proposal:** In the greenfield repo, make each of these five a single canonically-owned extension
(one `id`, one package) consumed by reference, never re-vendored into a second plugin. The dedup lint
(#3) enforces this automatically once ids are immutable (#2). For the *existing* SOX install, the
follow-up is to designate `sox-cto-system` as the owner and have `sox-active` depend on rather than
duplicate those five — but that touches the live meta-loop (see Risk).
**Rationale:** Two independently-versioned copies of `cto-agent` is exactly the failure mode immutable
ids + dedup exist to prevent; left unaddressed it reproduces in the new repo. It also wastes
system-prompt budget and creates a "which copy won?" ambiguity at load time.
**Difficulty:** S for the *greenfield* design (the invariant + lint already do the work). The live SOX
de-duplication is a separate, larger change gated by the meta-loop recursion guard — out of scope for
this engagement's build, listed as a follow-up.
**Expected ROI:** high. Measurable: count of duplicated agent ids across enabled plugins goes 5 → 0
in the new repo; dedup lint exits non-zero on any reintroduction.
**Risk:** Touching the live `cto-agent`/`janitor-agent` copies risks the meta-loop self-modification
guard (analysis.md §1.5) — do NOT refactor the running SOX system as part of this greenfield build;
confine the fix to the new repo's design and flag the live cleanup to the founder.
**Sources:** [memory:extension-ecosystem-design/single-source-identity-dedup.md]; analysis.md §1.3, §4.
**Migration phase:** P2 (dedup lint enforces it); live-system cleanup is a separate engagement.

---

### 7. Declared hook execution ordering via integer `order` field — ROI: med · Difficulty: S

**Divergence closed:** analysis.md §4 DIVERGENT #6 — the live system orders its 9 global hooks
implicitly by array position in `settings.json`; there is no ordering metadata, so order is brittle to
edits and impossible to reason about per-extension.
**Pattern (from memory):** Hooks fire unconditionally and should be order-independent where possible;
when order matters, an explicit integer field is simpler and more predictable than a topological
dependency graph at this scale. [memory:extension-ecosystem-design/extension-type-taxonomy.md] (hook responsibilities); migration Gap 2 (`Conjecture:`-grade on the exact tie-break).
**Proposal:** Add a hook-only integer `order` field to `extension.json` (default 100; migration §1.2);
the host loader sorts hooks bound to the same lifecycle event ascending by `order`, ties broken by `id`
lexicographic (migration §Phase 5, Gap 2). Document that `order` is an escape hatch, not a dependency
mechanism.
**Rationale:** Independent extensions can't rely on file position — a declared `order` is the only way
two separately-installed hooks on the same event get a deterministic sequence. It also makes the live
budget-gate/read-cap/grep-cap ordering (analysis.md §1.4) expressible rather than positional.
**Difficulty:** S — one schema field + a sort in the loader + one ordering test (migration P5).
**Expected ROI:** med. Mostly qualitative (determinism + reviewability). Measurable: a two-hooks-same-event
fixture loads in `order`-then-`id` sequence (migration P5 acceptance). Lower ROI than #1–#6 because the
live system's positional ordering already works in practice — this is correctness/clarity, not a
blocking gap.
**Risk:** Authors may abuse `order` as a dependency mechanism, creating implicit coupling; the
documented "keep hooks order-independent" guidance is the mitigation. The exact tie-break is
`Conjecture:`-grade in the research, not settled by a primary finding — call that out. Low.
**Sources:** [memory:extension-ecosystem-design/extension-type-taxonomy.md]; migration.md §1.2, §Phase 5, §Gap 2.
**Migration phase:** P5.

---

## Filtered out (recorded for honesty)

- **15 dormant plugins / system-prompt bloat** (analysis.md §4 Ecosystem, §1.3): a real live
  observation, but it is a property of the *inherited global install state*, not the greenfield repo
  this engagement builds. The migration plan's per-extension `enabled` cascade (migration §1.3) already
  gives the new repo the right mechanism to avoid bloat. Acting on the live 15-plugin install is an
  ops chore (disable/uninstall), ROI low and difficulty XS but orthogonal to the build — not ranked.
- **`memory-mcp` fully dormant** (analysis.md §1.7, §1.9): same class — inherited install hygiene, not
  a build divergence. Omitted.

---

## Research gaps (memory insufficient — NOT turned into fabricated suggestions)

1. **Agent/extension eval harness for an extension repo.** analysis.md §2.5 flags a real divergence —
   the live system has *no eval harness and no CI running agents* (only `relevancy.test.js` + an MCP
   `smoke-test.js`), and the migration plan's CI (P5 `validate.yml`) covers *manifest/type/build*
   validation but NOT behavioral evaluation of agent/prompt extensions. The `extension-ecosystem-design`
   topic has **no finding** on eval harnesses, and the adjacent `verification-granularity` topic covers
   *plan-decomposition* verification, not *extension-behavior* evaluation — so neither cleanly grounds a
   concrete recommendation. Per the no-fabrication rule I am NOT inventing a best practice here.
   **Recommended follow-up:** a scoped `workflow:workflow-researcher` run on the domain-neutral question:
   *"What is the minimal CI eval-harness pattern for behavioral regression testing of LLM
   agent/prompt extensions in a monorepo — golden-transcript fixtures vs LLM-judge vs assertion-based,
   and where it sits relative to manifest/build validation?"* Once that finding exists, it would slot in
   as a new migration phase (e.g. P5.5 or a P6 addition) and likely rank med–high.

---

## Self-critique

- [x] Every ranked suggestion cites a memory finding (all seven cite `extension-ecosystem-design/*`).
- [x] No best practice fabricated without a source — the eval-harness gap is listed as a research gap, not a suggestion.
- [x] Difficulty estimates justified by file count / scope / reuse-vs-build.
- [x] ROI metrics tie to concrete migration.md acceptance checks where measurable; qualitative-only stated where not.
- [x] Risk section non-empty for every suggestion.
- [x] Research gap (eval harness) explicitly listed with a domain-neutral researcher prompt.
- [x] Did not modify project code or write to `$MEMORY_ROOT`; only this artifact + status.md transition.
