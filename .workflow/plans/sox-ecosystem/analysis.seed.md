# Analysis — LLM extension ecosystem (greenfield)

> **Provenance:** distilled by workflow-architect from the agreed research findings in
> `~/.claude/plugins/workflow/memory/research/extension-ecosystem-design/`. Not a live
> analyzer run (greenfield — no existing code to inventory). Every claim traces to a cited finding.

## Target system

A greenfield monorepo hosting six LLM-extension types — **agent, skill, mcp-server,
prompt, hook, command** — each independently versioned, separately installable across
project/user/org scopes, provider-agnostic, and authored via a one-command scaffold.

## Agreed design basis (do not re-derive)

| Concern | Decided position | Source finding |
|---|---|---|
| Directory layout | `extensions/<type>/<id>/` glob; 4 files/unit | `llm-extension-repo-reference-architecture.md` §1 |
| Manifest | separate `extension.json` (JSON Schema `v1`); id≠title; closed `type` enum | reference-architecture §2; `manifest-driven-discovery.md` |
| Versioning | Changesets independent mode (`fixed: []`) | `independent-versioning-via-changesets.md` |
| Distribution | two-tier: git `registry/index.json` for discovery + npm/CDN for artifacts | `distribution-mechanics-monorepo-vs-per-repo.md`; `registry-as-protocol-not-product.md` |
| Scope cascade | org → user → project → local; narrowest wins; primitives replace, objects deep-merge | `multi-scope-install-config-cascade.md` |
| Identity | reverse-DNS ids, immutable; three uniqueness invariants; CI dedup lint | `single-source-identity-dedup.md` |
| Providers | LiteLLM (Python) / Vercel AI SDK (TS); capability negotiation; local LLM support | `multi-llm-provider-abstraction.md` |
| Type taxonomy | skill/mcp/agent/cli/hook/prompt decision tree + canonical responsibilities | `extension-type-taxonomy.md` |
| Scaffolding | custom ~120 LOC generator, zero external scaffold deps | `scaffold-first-authoring.md` |

## Constraints (binding on the plan)

- **Bias to reuse.** Total custom code near **~1010 LOC** (build-vs-reuse matrix).
- **Low footprint:** exactly **4 files per new extension** (`extension.json`, `src/index.ts`
  or `prompt.md`, `package.json`, `CHANGELOG.md`); all build/test/lint/CI config at repo root.
- Plan must be **phased and resumable**, each milestone with a **deterministic acceptance check**
  and the **MVP use case** it unblocks (5 MVP cases defined in `build-vs-reuse-and-build-plan.md`).

## Open gaps the plan must resolve (decide, don't defer)

1. **MCPB (`.mcpb`) / Claude Code plugin-bundle install path** vs the generic npm+registry path.
2. **Hook execution ordering** when multiple hooks bind the same lifecycle event.
3. **Registry HTTP server** (Terraform two-endpoint model) — validate or replace.
4. **Org-baseline `extends` URL** — pin by content hash in the lockfile.
5. **Capability check** — advisory-warn vs hard-block for long-tail local models.
