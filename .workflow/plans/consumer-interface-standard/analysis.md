---
slug: consumer-interface-standard
artifact: analysis
author: workflow-analyzer
captured_by: workflow-architect
date: 2026-06-08
---

> **Provenance note:** This is `workflow-analyzer`'s output, captured verbatim by the architect
> because the analyzer reported it could not write the file directly (sub-agent write constraint).
> Content is the analyzer's; the architect only persisted it. Read-only analysis of the repo as of
> 2026-06-08; no source was modified.

# Analysis: sox-ecosystem coverage map

## Coverage matrix (headline)

| Capability | Status |
|---|---|
| 7-type closed enum + type/dir enforcement | Built |
| Cascade engine (4 scopes, merge rules) | Built + proven |
| Cascade — array-replace rule | Built + proven |
| Cascade — org baseline `extends` + hash-pin | Built + proven |
| Full 4-scope real-install integration test | **Partial — unfalsified** |
| Bundle type + post-cascade expansion + cycle guard | Built + proven |
| Multi-tenant bundle collision (same member, two bundles) | **Untested** |
| Hook execution ordering (order + id tie-break) | Built + proven |
| Hook error isolation | **Untested** |
| Lifecycle block (G-A) | Built + proven |
| ScopePromotionProposed event | **Specified only — host contract, not implemented** |
| Provider capability gating (warn + hard-block) | Built + proven |
| Runtime contract (G-D: stdio-any restriction) | Built + proven |
| Requires-redundancy advisory (G-E) | Built + proven |
| Manifest validation (all 8 checks) | Built + proven |
| Secret-in-config lint | Built + proven |
| Scaffolder | Built |
| Scaffolder generates README/docs/CLAUDE.md | **Absent** |
| Changesets versioning | Built |
| CI — validate-manifests + typecheck + tests + changeset | Built |
| CI — lint / format | **Absent** |
| CI — doc-lint / README completeness gate | **Absent** |
| Registry index (flat JSON, 11 entries) | Built |
| Registry search / browse / HTTP API | **Absent** |
| Layer 2 eval (one extension only — hello-world) | Partial |
| Layer 3 eval (LLM-judge) | **Absent** |
| Host CLI / `bin` entrypoints | **Absent** |
| User-facing install/search/catalog/configure CLI | **Absent** |
| README files (root or per-extension) | **Absent** |
| CLAUDE.md / AGENTS.md / SKILL.md | **Absent** |
| Per-extension documentation / usage / examples | **Absent** |
| `docs`/`usage`/`llm-guidance` fields in v1.json schema | **Absent** |
| Extension uninstall / upgrade / list lifecycle | **Absent** |
| sox-memory end-to-end (one tenant proven) | Built + proven |
| Second tenant onboarding path | **Absent** |

## 1. What IS covered (the substrate)

### 1.1 Extension type system (7 types)
Closed enum `["agent","skill","mcp-server","prompt","hook","command","bundle"]` — `schemas/extension/v1.json:22`. `dir→type` mapping enforced by `scripts/validate-manifests.ts` (`DIR_TO_TYPE`, lines 107–116). 11 extensions across all 7 types. Required fields: `$schema,id,version,type,title,description,compatibility,license` (`v1.json:7`); behavioral types also require `entrypoint` (allOf, lines 147–155).

### 1.2 Cascade / install engine + scope model
Four scopes with canonical paths (`install.ts getScopePath()`): org `.extensions/org.extensions.json`; user `~/.config/extensions/extensions.json`; project `.extensions/extensions.json`; local `.extensions/extensions.local.json` (+locks). Merge rules in `scripts/cascade.ts`: primitives replace narrower-wins (100–111); objects deep-merge (`deepMerge()` 52–78); **arrays replace entirely** (11–16; test `cascade.test.ts:33`); `enabled:false` narrower force-suppresses (137–148). Org baseline `extends` fetch + sha256 pin + fail-closed divergence (`install.ts fetchOrgBaseline()` 360–376; hash-check 598–609). Install modes: default, frozen, update.

### 1.3 Bundle primitive (G-B)
`bundle` type enforced in schema + validator. Post-cascade `expandBundles()` (`install.ts` 709–794) cycle-guarded (`BUNDLE_MAX_DEPTH=10`). `sox-memory-bundle` lists 4 members; installed via `.extensions/extensions.json`.

### 1.4 Host-event / lifecycle model (G-A, G-C)
Lifecycle block: schema 85–131; validator type restriction 337–364; `memory-server` carries full block (background, singleton, socket health). ScopePromotionProposed: fully specified in `docs/scope-promotion.md` as a host contract — no implementation in-repo; CI shim `tools/host-event-shim.js` exercises it. Hook-loader: ascending `order` (default 100), id-lexicographic tie-break.

### 1.5 Provider abstraction + capability gating
`scripts/provider-capabilities.ts` vs `assets/model_capabilities.json`. Advisory-warn default; `strict_capabilities:true` hard-blocks. G-D runtime contract; G-E redundancy advisory (warn, non-blocking).

### 1.6 Manifest validation
`scripts/validate-manifests.ts` (729 lines): id format, id≠type suffix, type enum, type/dir match, version-sync, G-D, G-A, G-B (8 checks), P2 dedup (3 invariants), secret-in-config, G-E advisory.

### 1.7 Scaffolder
`scripts/new-extension.ts`: interactive + non-interactive. Generates 4 files/extension (3 for bundles). No README/CLAUDE.md/AGENTS.md/SKILL.md generated.

### 1.8 Changesets + CI + registry
Changesets via `@changesets/cli`. CI: `validate.yml` (validate + typecheck + vitest + changeset status); `release.yml` (publish + build-index). Registry: `registry/index.json` flat array (11 entries).

### 1.9 Test surface (131 tests, all green per VERIFICATION.md P11)
- `cascade.test.ts` (10) — merge rules, array-replace, enabled suppression, deep-merge
- `install.test.ts` (24) — single-scope install, frozen-lockfile, extends hash-pin, capability warn/hard-block, semver, checksum tamper, bundle expansion
- `validate-manifests.test.ts` (44) — all 8 checks, G-A/B/D/E, dedup, secret-in-config
- `hook-loader.test.ts` (15) — sort order, tie-break, async sequencing, multi-event isolation
- `provider-capabilities.test.ts` (12) — capability matrix, gates
- `v2-e2e.test.ts` (21) — per-gap G-A..G-E e2e + back-compat
- `hello-world/eval/golden.test.ts` (~6) — Layer 2 deterministic golden (no LLM)
Layer 3 LLM-judge: explicitly deferred.

### 1.10 The one real tenant (sox-memory)
4 extensions proven end-to-end: memory-server (mcp, lifecycle, socket health), memory-organizer (agent, structured_output, min_context_tokens:16384), memory-flush (hook, dual-event bind), memory-cli (command, depends on memory-server). Bundle installed; lockfile written.

## 2. The scope model as built

**Proven:** narrowest version wins; array-replace; `enabled:false` suppression; deep-merge; org hash-pin/fail-closed; `--frozen-lockfile` idempotency; `--update` re-pin.

**Unfalsified (harness uses single-scope mode):** every `install()` test sets `configPath`, triggering `singleScopeOnly=true` (`install.ts:417`). Therefore:
- Full 4-scope real-install cascade (org+user+project+local from default paths simultaneously) never integration-tested.
- Two extensions in one scope binding the same lifecycle event: ordering tested in isolation, not through a real install cycle.
- Bundle-member version conflict (two bundles, same member, different ranges): `expandBundles()` dedups by first-seen — behavior unspecified and untested.
- Hook error isolation: `hook-loader.ts:113` documents "callers should wrap"; no test exercises it.

## 3. The five most consequential absences
1. **No `bin` / host CLI.** Zero `bin` fields. A consumer cannot interact without editing JSON config and running `npx tsx scripts/install.ts`.
2. **No README anywhere.** No prose orientation for a first-time developer.
3. **No CLAUDE.md / AGENTS.md / SKILL.md.** No structured guidance for an LLM/agent; the repo is navigable only by code inference.
4. **No self-description contract in the schema.** `v1.json` has no `docs`/`usage`/`examples`/`parameters`/`llm_guidance` — only a one-line `description`. A host has no raw material to present affordances.
5. **No DX-conformance enforcement.** CI enforces schema/typecheck/tests/changeset, not README existence, description quality, or doc completeness; scaffolder generates no docs; no doc-lint.

## 4. Root-cause read
- **Substrate-first sequencing** — phases P0–P11 were substrate deliverables; affordances never appeared in the phase list, so accrued no acceptance criteria.
- **Deterministic-acceptance-check frame** — gates are binary technical assertions, well-suited to substrate; "a developer can discover/understand this" doesn't map to a binary check without first deciding it's in scope, which never happened.
- **Host-contract deferral** — consumer concerns deferred to a future "host"; the same deferral silently extended to the metadata (per-extension docs, LLM guidance, usage contracts) any host would need.
- **One-tenant scope** — all decisions grounded in sox-memory (expert-built); a second author, first-time user, or autonomous LLM agent was never a design input.
