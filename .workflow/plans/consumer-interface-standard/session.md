---
slug: consumer-interface-standard
opened: 2026-06-08T06:19:06Z
---

# Session — consumer-interface-standard

## 2026-06-08T06:19Z — initialization + dual dispatch

User surfaced large gaps left by the sox-ecosystem + sox-memory builds (both complete): repo
maintenance / linting / doc templating never considered; consumer interface and use cases ignored;
zero documentation, zero reusability, zero developer guidance; and (confirmed) no user-facing CLI —
the ecosystem has an engine but no front door. Root cause: the build's planning frame optimized for
deterministic exit-0 acceptance checks per phase, which structurally excludes the DX/affordance layer.

User directive: dispatch an analyst to fully document what the build covered, and a researcher to
design the ideal consumer interface that ships installs across global/user/project scopes for the
full extension lifecycle (creation, install, search, usage, configure, …), with extensions made to
adhere to that standard through repo tooling + contracts.

Architect actions:

- A4: new engagement `consumer-interface-standard` (no slug collision; no open engagements → no
  overlap gate). Parent: sox-ecosystem.
- Memory check (A2): surfaced prior global findings to feed the researcher — `extension-ecosystem-design`,
  `plugin-manifest-formats`, `plugin-taxonomies`, `plugin-protocol-versioning`, `policy-enforcement`.
  None covers the consumer-facing interface / multi-scope install UX / lifecycle CLI / DX conformance
  → new research warranted, told to build on the above.
- Dispatched workflow-analyzer (attached: slug + plan_dir) and workflow-researcher (global, domain-
  neutral restatement) in parallel.

## 2026-06-08T~07:45Z — dispatch results

- workflow-analyzer: SUCCESS. Delivered full coverage map; advanced status → analyzed. NOTE: reported it could not write analysis.md itself (sub-agent write constraint); architect captured its verbatim output to `analysis.md` with a provenance note. Headline: substrate built+proven for 1 tenant; entire affordance layer (host CLI/bin, READMEs, CLAUDE/AGENTS/SKILL, manifest self-description fields, DX-conformance CI) ABSENT; scope model proven single-scope but 4-scope cascade + multi-tenant collision UNFALSIFIED (test harness uses singleScopeOnly).
- workflow-researcher: CRASHED (API socket closed, 0 tokens returned after 43 tool uses). Verified nothing persisted to global memory. Cannot SendMessage-resume a crashed agent from architect tool surface → re-dispatching fresh with a persist-before-return hardening note.

## 2026-06-08T08:05Z — both inputs in; engagement state=analyzed

- workflow-researcher (re-dispatch): SUCCESS. Persisted `extension-consumer-interface/consumer-interface-lifecycle-conformance.md` (30KB) + topic INDEX to global memory. 12-verb command set; named-scope convention; manifest description-as-invocation-guidance; scaffold→schema→lint(--strict)→registry enforcement (fail-open local/fail-closed CI). Extended 4 prior findings. Thin evidence flagged: description-quality→agent-routing has no published benchmark.
- Research dispatch log written to .workflow/logs/architect/research.json (drift: intentional domain-neutral generalization, no scope narrowing).
- INDEX.md rebuilt: consumer-interface-standard added to Open (analyzed); sox-memory + sox-ecosystem remain Closed.
- NEXT (not yet dispatched): workflow-optimizer (reconcile coverage gaps vs ideal interface → ranked suggestions), then workflow-planner (phased migration). Awaiting user go-ahead.

## 2026-06-08 — optimizer + planner: engagement now PLANNED

- workflow-optimizer: suggestions.md, state→suggested, provisional_roi critical. 6 ranked items; S1 host-CLI universal prereq; S2 schema-fields before S3 doc-gen; doc-lint gate as warnings→retrofit→strict; S6 collision tests independent. Blast radius: S2 schema→11 manifests (optional-first), strict-flip requires 11-extension retrofit first.
- workflow-planner: migration.md, state→planned. 8 phases P0–P7. Chain P0→P6 (P0 build-decision+bin skeleton; P1 tier-1 verbs+named scopes; P2 self-description fields optional-first; P3 scaffolder doc-gen; P4 doc-lint warnings; P5 retrofit 11; P6 flip --strict CI + scope provenance). P7 (4-scope/collision tests) independent/early; complete when chain+P7 both green. Carries session-learned facts: no-bundler src↔dist reconciliation (P0), never-pipe exit checks, CLI wraps engine (never forks), schema optional-first.
- INDEX.md rebuilt: detail updated with plan summary + complexity. Engagement ready to execute (same loop pattern as sox-memory P3→P5).

## 2026-06-08 — execution loop COMPLETE (P0–P7 all green)

Architect looped the plan: P7 in background (parallel), P0→P6 serial chain. All dispatched to typescript-pro with resume-guard.

- P0 build-decision (hand-maintained mirror, no bundler) + inert bin/sox · P1 tier-1 verbs (install/uninstall/list/validate/details) + named scopes · P2 schema self-description fields (optional-first, 11 still valid) · P3 scaffolder doc-gen + `soxe init` · P4 doc-lint as warnings (fail-open; --strict fails on 11) · P5 retrofit all 11 (11 READMEs + 5 type-docs + manifest fields) · P6 flip CI to --strict (fail-closed) + scope-provenance (`list --json`, `details installed-in`). P7 added 22 collision/4-scope/hook tests.
- Test suite 131 → 256, all green. Engagement state → complete (P6 last finisher).
- CARRY-FORWARD (recorded, not fixed): DEFECT-1 HookLoader.fire() aborts chain on first throwing hook (docs/engine-defects-found.md) — needs a follow-on engagement (fireIsolated() variant). This is the multi-tenant collision risk flagged earlier, now falsified with a pinned test.
- INDEX.md rebuilt: consumer-interface-standard moved Open→Closed. All changes uncommitted, pending user review.
