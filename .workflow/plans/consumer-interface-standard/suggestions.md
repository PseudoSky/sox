---
slug: consumer-interface-standard
artifact: suggestions
author: workflow-optimizer
date: 2026-06-08
---

# Workflow optimization suggestions — sox-ecosystem (consumer interface)

Based on: /Users/nix/dev/ai/sox-ecosystem/.workflow/plans/consumer-interface-standard/analysis.md (generated 2026-06-08)
Research as of: 2026-06-08
Primary source: `memory:extension-consumer-interface/consumer-interface-lifecycle-conformance.md`

> Note on memory coverage: the primary finding cites adjacent prior findings
> (`extension-ecosystem-design/*`, `plugin-manifest-formats/*`). Those topic directories
> are **not present** in this memory root — the primary finding is self-contained and
> reproduces their relevant conclusions inline, so every suggestion below is grounded in
> a present source. Where the primary finding flags thin evidence, it is labelled.

---

## Critical-path / prerequisite ordering (read this first)

The suggestions are ranked by ROI, but they are **not independent**. The hard prerequisite chain:

```
S1 (host CLI + bin entrypoint)                  ← prerequisite for ALL consumer verbs
   ├─ S2 (manifest self-description schema)      ← prerequisite for S3 doc-gen + S5 `details`/`list` rendering
   │     └─ S3 (scaffolder generates docs/README/SKILL/CLAUDE)
   │           └─ S4 (doc-lint / DX-conformance CI gate)   ← needs S2 fields + S3 output to lint against
   └─ S5 (multi-scope UX: named scopes + provenance)       ← surfaces what S6 must prove correct
S6 (close the unfalsified 4-scope / collision testing gap) ← INDEPENDENT of CLI; can run in parallel
```

- **S1 is the universal prerequisite** for every consumer verb (analysis §3.1: "A consumer cannot interact without editing JSON config"; finding §1.6 / §6.1: `bin/` convention is the invocation substrate).
- **S2 must land before S3 and before S5's `details` rendering** — doc-gen and `details` have no raw material to render until the schema declares self-description fields (finding §4.1, §6.3).
- **S6 is on its own track** — it is a test-only change that does not depend on the CLI and should be sequenced early because it gates trust in the very scope model the CLI will expose.

---

## Ranked suggestions

### 1. Host CLI + `bin` entrypoint with the minimal-complete verb subset — ROI: critical · Difficulty: M

**Gap closed:** analysis §3.1 ("No `bin` / host CLI. Zero `bin` fields") and coverage matrix rows "Host CLI / `bin` entrypoints — Absent", "User-facing install/search/catalog/configure CLI — Absent". The install engine is reachable only via `npx tsx scripts/install.ts` + hand-edited JSON.

**Recommended change (grounded in finding §6.1, §1.6):** ship a single host `bin` entrypoint and wrap the existing proven engine (`scripts/install.ts`, `scripts/cascade.ts`, `scripts/validate-manifests.ts`, `registry/index.json`) behind a verb dispatcher. Prioritize the **minimal complete subset that maps to engine capability that already exists**, deferring verbs that need new infrastructure:

- **Tier 1 (ship first — every one wraps already-built engine code):** `install`, `uninstall`, `list`, `validate`, `details`. These are pure adapters over the cascade/install engine + registry + validator.
- **Tier 2 (small additions):** `update` (engine already has `--update` re-pin mode — analysis §1.2), `enable` / `disable` (engine already honors `enabled:false` suppression — analysis §1.2, cascade.ts 137–148).
- **Tier 3 (nice-to-have, needs new infra):** `search` (needs the registry served/queried — analysis: "Registry search / browse / HTTP API — Absent"), `prune`, `init` (alias to scaffolder, see S3).

**Difficulty: M** — it is an adapter layer, not new behavior: the merge/install/validate logic is built and proven by 131 tests. But it is cross-cutting (new entrypoint + arg parsing + output formatting for ~8 verbs + wiring to 4 existing modules) and touches the user-visible contract, so >1 day, <1 week.

**ROI: critical** — unblocks every other consumer affordance; without it suggestions S3/S5 have nothing to attach to. It is the single highest-leverage move because the engine value already exists and is currently unreachable.

**Dependencies / sequencing:** PREREQUISITE for S5 (scope UX lives on these verbs) and for S3's `init` alias. Tier 1 can ship before S2; `details` output gets richer once S2 lands.

**Blast radius:** additive — a new `bin` field + entrypoint. Does **not** require retrofitting the 11 extensions. Does not change the schema. Low risk; fully reversible (delete the entrypoint).

**Risk:** verb/flag naming churn if shipped before the scope vocabulary (S5) is decided — mitigate by deciding the `-s <scope>` convention (S5) at the same time even if provenance display lands later.

**Sources:** `memory:extension-consumer-interface/consumer-interface-lifecycle-conformance.md` §1.6, §6.1; analysis.md §3.1.

---

### 2. Manifest self-description contract in `schemas/extension/v1.json` — ROI: high · Difficulty: M

**Gap closed:** analysis §3.4 ("No self-description contract in the schema… only a one-line `description`") and matrix row "`docs`/`usage`/`llm-guidance` fields in v1.json schema — Absent". A host has no raw material to present affordances.

**Recommended change (grounded in finding §4.1, §6.3, §3.3):** add a self-description block to the manifest schema. Per the finding's manifest/adjacent-file split (§4.1): keep long-form prose in README/SKILL files, but add to the manifest the machine-readable fields a catalog and an LLM agent need:

- `description` reframed as **dual human + LLM invocation guidance** — written as "use this when X", not marketing copy (finding §3.3, §6.3: this is the text the LLM reads to route).
- discovery metadata: `keywords` / `tags`, optional `categories`, `author`, `homepage`, `repository` (finding §3.2, §6.3).
- optional per-component self-description: each behavioral component carries its own `description` as more-specific invocation guidance (finding §3.3, §6.3 — the MCP `tools/list` → `description` model).

**Difficulty: M** — the schema edit is small, but it is a **closed-schema change** with a retrofit obligation (see blast radius) and a back-compat decision (new fields must be optional first per finding §6.4 maturation advice).

**ROI: high** — it is the raw material that S3 (doc-gen) and S5 (`details`/`list` rendering) consume; without it those produce empty output. High not critical only because S1 delivers user-visible value first.

**Dependencies / sequencing:** PREREQUISITE for S3 (scaffolder can only template fields the schema defines) and for the rich form of S5's `details`. Can land in parallel with S1 Tier 1.

**Blast radius (FLAG):** touches the schema → **all 11 manifests are in scope**. To stay non-breaking, add fields as **optional** (warnings only), then tighten to required-in-CI later via S4's `--strict` gate (finding §5.2 fail-open-in-dev / fail-closed-in-CI; §6.4 "start with few required fields, add with a deprecation cycle"). The validator (`scripts/validate-manifests.ts`, already 8 checks) is the natural place to add the advisory checks.

**Risk:** over-stuffing the manifest with prose that belongs in README (finding §4.1 explicitly warns against this — long-form usage/examples/screenshots go in adjacent files, not the manifest). Mitigate by keeping manifest fields to identity + one-line guidance + discovery metadata only.

**Sources:** `memory:extension-consumer-interface/consumer-interface-lifecycle-conformance.md` §4.1, §6.3, §3.3, §6.4; analysis.md §3.4.

---

### 3. Scaffolder generates README / SKILL / CLAUDE(AGENTS) + manifest self-description — ROI: high · Difficulty: S

**Gap closed:** analysis §3.2, §3.3 and matrix rows "Scaffolder generates README/docs/CLAUDE.md — Absent", "README files — Absent", "CLAUDE.md / AGENTS.md / SKILL.md — Absent". `scripts/new-extension.ts` generates 4 files/extension but no docs.

**Recommended change (grounded in finding §1.1, §5.1, §6.4):** extend the existing scaffolder to emit type-specific doc stubs (README per extension; SKILL.md for skills; CLAUDE.md/AGENTS.md guidance) and pre-fill the S2 self-description fields from interactive prompts / flags (`--description`, `--author`). This implements the finding's "scaffold-first inverts the friction" principle (§6.4): if the scaffolder emits a conformant manifest + docs by default, new extensions start conformant for free.

**Difficulty: S** — the scaffolder already exists and is interactive + non-interactive (analysis §1.7); this adds template files and a few prompts. Single file (`scripts/new-extension.ts`) + template assets, ≤1 day.

**ROI: high** — the cheapest durable fix to the docs gap going forward; every future extension is born conformant. (Does not fix the 11 existing extensions — that is S4's retrofit job.)

**Dependencies / sequencing:** DEPENDS ON S2 (templates must reference the self-description fields the schema defines). Pairs with S1's `init` verb (Tier 3) as the user-facing entry. Should land before S4 so S4 has conformant scaffolder output to validate against.

**Blast radius:** additive for new extensions; does not retrofit existing 11 (that is deliberate — S4 handles the existing surface). Low risk, reversible.

**Risk:** generated stubs that authors never fill in ("Lorem ipsum READMEs") pass file-existence checks but add no value — mitigate by having S4 lint for non-empty/non-placeholder content, not mere existence.

**Sources:** `memory:extension-consumer-interface/consumer-interface-lifecycle-conformance.md` §1.1, §5.1, §6.4; analysis.md §3.2, §3.3, §1.7.

---

### 4. Close the unfalsified 4-scope cascade + multi-tenant collision testing gap — ROI: high · Difficulty: M

**Gap closed:** analysis §2 ("Unfalsified — harness uses single-scope mode": every `install()` test sets `configPath` → `singleScopeOnly=true`, install.ts:417) and matrix rows "Full 4-scope real-install integration test — Partial/unfalsified", "Multi-tenant bundle collision — Untested", "Hook error isolation — Untested". Four specific untested behaviors: full 4-scope simultaneous cascade; two extensions in one scope binding the same lifecycle event through a real install; bundle-member version conflict across two bundles (`expandBundles()` dedups first-seen — "behavior unspecified and untested"); hook error isolation (hook-loader.ts:113 says "callers should wrap" — no test).

**Recommended change (grounded in finding §2.2, §2.3):** add integration tests that exercise the real multi-scope path (org+user+project+local from default paths, not `singleScopeOnly`), plus the multi-tenant bundle-collision and hook-error-isolation cases. This is the falsification layer behind S5's UX: the finding's §2.3 precedence foot-guns (scope-unaware uninstall, enable/disable not distinguishing scopes, orphaned deps, install/update scope mismatch) are exactly the behaviors a real multi-scope test must pin before a CLI exposes them to users.

**Difficulty: M** — requires building a real multi-scope fixture harness (the current harness deliberately bypasses it). New test infra across the install + bundle + hook surfaces, ≤1 week.

**ROI: high** — the scope model is the ecosystem's core claim, and it is proven for exactly one configuration. Shipping a multi-scope CLI (S1/S5) on top of an unfalsified multi-scope engine is the highest-correctness-risk path; this de-risks it. Measurable metric: closes 4 named untested behaviors → moves matrix rows from "Untested/Partial" to "proven".

**Dependencies / sequencing:** INDEPENDENT of the CLI — pure test work. Should run **early and in parallel**; it gates trust in the model S5 will expose. Strongly recommended to land before or alongside S1 so the CLI does not ship over unproven cascade behavior.

**Blast radius:** test-only; touches no schema, no manifests, no source behavior. May surface latent bugs in `expandBundles()` dedup or hook isolation — that is the point. Low blast radius, potentially high signal.

**Risk:** discovering that first-seen bundle dedup or hook isolation is actually wrong, forcing a source fix outside this engagement's scope. That is a feature (find it now, not in production), but flag it as a possible scope expansion for the planner.

**Sources:** `memory:extension-consumer-interface/consumer-interface-lifecycle-conformance.md` §2.2, §2.3; analysis.md §2.

---

### 5. Multi-scope install UX — named scopes (`-s user|project|local`) + scope provenance — ROI: high · Difficulty: S

**Gap closed:** analysis §3.1 (consumers edit JSON directly; no scope ergonomics) and §2 (four scopes exist with canonical paths but no user-facing way to target or inspect them). Currently scope is chosen by which JSON file you hand-edit.

**Recommended change (grounded in finding §1.3, §2.1, §2.2, §6.2):** on the S1 scope-mutating verbs (`install`/`uninstall`/`update`/`enable`/`disable`), adopt the named-scope convention `-s, --scope <user|project|local>` (the engine's four canonical scopes already map cleanly — analysis §1.2 org/user/project/local). Use **named scopes, not `-g`** (finding §2.1: named scopes self-document and scale to 3–4 scopes; `-g` breaks down). Make `list` always show scope + source per entry, and `details` show provenance, to answer "which scope did this come from?" — the finding's §2.2 most-common multi-scope debugging question. Default scope = `user` for interactive install (finding §6.2), and ensure `update`/`uninstall` share install's default to avoid the §2.3 foot-guns.

**Difficulty: S** — a flag convention + provenance field in `list`/`details` output on top of S1's verbs and the engine's existing scope paths. Confined to the CLI layer, ≤1 day once S1 exists.

**ROI: high** — converts the built-but-hidden four-scope model into a usable, debuggable surface; directly prevents the named precedence foot-guns the finding documents.

**Dependencies / sequencing:** DEPENDS ON S1 (verbs to attach the flag to). The `-s` vocabulary decision should be made at S1 time even if provenance display lands with S5. Rich `details` provenance benefits from S2's metadata. Correctness of what it surfaces is proven by S6.

**Blast radius:** CLI-layer only; no schema or manifest change. Low risk, reversible.

**Risk:** silent scope shadowing (finding §2.2 anti-pattern) if `list` does not surface the active layer — mitigate by making scope+source mandatory columns in `list` from day one.

**Sources:** `memory:extension-consumer-interface/consumer-interface-lifecycle-conformance.md` §1.3, §2.1, §2.2, §2.3, §6.2; analysis.md §2, §3.1.

---

### 6. Doc-lint / DX-conformance CI gate (`validate --strict`) — ROI: med · Difficulty: S

**Gap closed:** analysis §3.5 ("No DX-conformance enforcement") and matrix rows "CI — doc-lint / README completeness gate — Absent", "CI — lint / format — Absent". CI enforces schema/typecheck/tests/changeset but not description quality, README existence, or doc completeness.

**Recommended change (grounded in finding §5.1–§5.3, §6.4):** add advisory conformance rules to the validator and wire a `validate --strict` mode into CI per the finding's fail-open-in-dev / fail-closed-in-CI posture (§5.2). Rules per the finding's error-vs-warning table (§5.3): non-empty `description`, present `keywords`, set `author`/`license`, README existence + non-placeholder content → **warning in dev, error in CI**. Wrong-type / missing-required-field stay hard errors (already covered by the existing 8 checks). This is the finding's "cheapest high-value gate" (§6.4): costs nothing to run, catches discoverability-degrading omissions.

**Difficulty: S** — extends the existing `scripts/validate-manifests.ts` + adds a CI step to `validate.yml`. ≤1 day of rule-writing plus the retrofit cost (below).

**ROI: med** — high-value mechanism, but ranked med because its value is realized only once S2 (fields to lint) and S3 (scaffolder output to enforce) exist, and because flipping it to fail-closed forces the 11-extension retrofit (a cost, not just a benefit). It is the gate that makes S2/S3 stick.

**Dependencies / sequencing:** DEPENDS ON S2 (the fields it lints) and S3 (the doc artifacts it checks for). Land LAST in the conformance chain. Roll out fail-open first (warnings), then flip `--strict` in CI after the retrofit.

**Blast radius (FLAG):** flipping to fail-closed **requires retrofitting all 11 existing extensions** to add descriptions/keywords/READMEs — they were authored before any DX standard. Sequence: (1) add rules as warnings, (2) retrofit the 11, (3) flip `--strict` in CI. Doing this before the retrofit will red-bar the whole repo.

**Risk:** contributor friction if `--strict` lands before scaffolder (S3) makes conformance free — mitigate by ordering S3 before the CI flip, per finding §6.4 ("scaffold-first inverts the friction").

**Sources:** `memory:extension-consumer-interface/consumer-interface-lifecycle-conformance.md` §5.1, §5.2, §5.3, §6.4; analysis.md §3.5.

---

## Filtered out (deliberately not proposed)

- **Remote registry HTTP API / `search` server, Layer 3 LLM-judge eval, second-tenant onboarding automation** — real gaps in the analysis matrix, but each is difficulty M+ with ROI that is med-at-best for *this* engagement (the consumer-interface standard). They are downstream of the standard, not part of defining it. The `search` verb is listed as Tier 3 of S1 so the CLI is forward-compatible, but standing up the registry service is out of scope here. (Per optimizer filter: difficulty > M and ROI < high are not listed as standalone suggestions.)

---

## Research gaps (memory insufficient — may warrant a narrow `workflow-researcher` run)

- **Adjacent prior findings absent from this memory root.** The primary finding cites
  `extension-ecosystem-design/multi-scope-install-config-cascade.md`,
  `extension-ecosystem-design/scaffold-first-authoring.md`,
  `plugin-manifest-formats/cross-language-convergence.md`, and
  `extension-ecosystem-design/manifest-driven-discovery.md`. None are present here. The primary
  finding reproduces their relevant conclusions inline, so no suggestion is ungrounded — but if the
  planner wants the deeper cascade-precedence or manifest-convergence detail behind S2/S5/S6, a
  narrow researcher run to (re)materialize those topics would help.
- **Bundle-member version-conflict resolution policy** (S6). The finding documents collision *detection*
  patterns but not a prescribed *resolution* policy for "two bundles, same member, different ranges."
  The engine currently dedups first-seen (analysis §2). Choosing the right resolution semantics is a
  design question with thin memory coverage — flag for a focused research sub-question if the planner
  promotes S6 to a behavior change rather than just a test.
- **Per-component LLM `description` routing quality** (S2). The finding itself flags (§8) that the claim
  "well-written `description` improves agent routing" is implied by MCP design but not benchmarked. The
  S2 recommendation rests on convergent design practice, not measured outcome — acceptable, but noted.
