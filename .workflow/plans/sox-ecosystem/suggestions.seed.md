# Suggestions — build-vs-reuse + gap-resolution stances

> **Provenance:** distilled by workflow-architect from `build-vs-reuse-and-build-plan.md`
> and the gap-relevant findings. The build-vs-reuse rows are *agreed* (research-backed).
> The gap stances below are **recommended defaults** for the planner to lock or override
> with stated rationale — they are `Conjecture:`-grade where the research did not settle them.

## Locked build-vs-reuse (from research; ~1010 LOC custom total)

Reuse: pnpm workspaces, Changesets, Zod + ajv, GitHub Actions, Turborepo (deferred),
Vitest/pytest, LiteLLM (Py), Vercel AI SDK (TS), dotenv, json5/jsonc-parser.
Build (thin glue): `new-extension.ts` (~120), `build-index.ts` (~80), `install.ts` (~300),
cascade merge (~100), `validate-manifests.ts` (~80), provider capability matrix (~30),
lockfile schema (~20), registry two-endpoint server (~150, Phase 2+).

## Recommended stances on the 5 open gaps

1. **MCPB vs npm+registry.** `Conjecture:` Treat MCPB as an **export/packaging target**, not the
   primary install path. Primary = npm + git `registry/index.json` (language-neutral, covers all
   6 types). Add `scripts/pack-mcpb.ts` that emits a `.mcpb` bundle from an already-built extension
   for Claude-Code-native consumers. Avoid coupling core install semantics to one host's bundle format.

2. **Hook execution ordering.** `Conjecture:` Deterministic order via an explicit integer
   `order` field in the hook's `extension.json` (default 100), ties broken by `id` lexicographic.
   Resolver sorts hooks bound to the same event ascending. Document that hooks must be
   order-independent where possible; `order` is an escape hatch, not a dependency mechanism.

3. **Registry HTTP server.** Research (`registry-as-protocol-not-product.md`) says the flat git
   `index.json` is the registry until ~5k entries. **Validate** the Terraform two-endpoint model
   (`GET /versions`, `GET /:version/download`) but **defer it to Phase 4+/optional** — build only
   when queryability or scale demands. Keep it spec-compatible so it's a drop-in later.

4. **Org-baseline `extends` URL.** Lock: **pin by content hash** in the per-scope lockfile
   (`extends: { url, sha256, resolved_at }`). Install fails closed if the fetched baseline's hash
   diverges from the lockfile unless `--update`. Aligns with checksum verification already in `install.ts`.

5. **Capability check.** Lock: **advisory-warn by default, hard-block opt-in** via
   `requires.tool_calling` + a scope-level `strict_capabilities: true`. Long-tail local models
   (Ollama/vLLM) frequently under-report params; a hard block would break legitimate setups.
   Warn loudly at install time; let a team escalate to block in their scope config.

## Aggregate risk seeds (for planner to expand)

- MED: `extension.json` ↔ `package.json` version drift (mitigation: pre-publish sync + CI check).
- MED: checksum/supply-chain on remote `source` and org `extends` (mitigation: sha256 pin, fail-closed).
- LOW: capability false-negatives on local models (mitigation: advisory-warn default).
- LOW: cascade-merge ambiguity on arrays (decide: arrays replace, not concat — document).
