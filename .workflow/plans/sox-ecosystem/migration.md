# Migration plan (v2): LLM extension ecosystem monorepo — greenfield build, reconciled with a live SOX-ecosystem analysis

## Intro

- **Goal:** Build a monorepo that hosts six LLM-extension types (agent, skill, mcp-server, prompt, hook, command), each independently versioned (Changesets), separately installable across org/user/project/local scopes with a config cascade, provider-agnostic (LiteLLM / Vercel AI SDK / OpenAI-compat), authored via a one-command scaffold that emits exactly 4 files per extension, distributed two-tier (git `registry/index.json` for discovery + npm/CDN for artifacts). **v2 reframe:** this is *not* pure greenfield — the repo sits inside a working SOX plugin ecosystem (19 plugins, `plugin.json` manifests, user/project scopes, a `sox` MCP server, 37 agents) that is a **working prototype** of much of the target. The build is therefore partly a *migration*: evolve the proven `plugin.json` + `installed_plugins.json` scope/cascade concept toward independent `extension.json` units, rather than inventing the cascade from zero. Source: `analysis.md` §4 (ALIGNED 1–3).
- **ROI:** Qualitative only (no baseline metric; canonical_roi = qualitative-only). Primary value: ~1010 LOC of owned glue replaces what would otherwise be a bespoke 5–10k LOC platform; all heavy lifting (versioning, publish, schema validation, provider routing, monorepo task graph) is delegated to battle-tested tools. Secondary, measurable once live: time-to-author a new extension < 5 min (UC-1); provider swap = 0 code changes (UC-2); per-extension republish count drops from N (the live `sox-cto-system` monolith re-publishes 4 agents + 3 skills + scripts + templates on any change) to 1. `Conjecture:` the LOC-saved figure is an estimate, not measured.
- **Phases:** 8 — P0 skeleton → P5 (six types + CI + hooks) → **P5.5 eval-harness research spike (gate)** → P6 verification. (v1 had 7; v2 inserts P5.5 as a research gate.)
- **Current status:** not started

---

## Section 0 — Delta from v1 (what changed and why)

v1 (`migration.v1.md`) was authored from research memory only, under a *pure-greenfield* assumption. A subsequent **live** `workflow-analyzer` run (`analysis.md`) inventoried the inherited global SOX/workflow tooling and produced an explicit ALIGNED/DIVERGENT comparison (§4); `workflow-optimizer` then ranked seven suggestions against it. v2 reconciles the plan with those live findings. The architecture (Section 1), build-vs-reuse + LOC budget (Section 2), and the five resolved gaps (Section 5) are **carried forward essentially unchanged** — the live analysis ratified them. The changes are:

| # | Change in v2 | Driver | Disposition |
|---|---|---|---|
| D1 | **Reframe build as "partly a migration."** The `plugin.json` + `installed_plugins.json` scope system (`scope: user`/`scope: project`) is a *working prototype* of the proposed cascade; v2 cites it as the proof-of-concept the design evolves, not a clean-slate invention. | `analysis.md` §4 ALIGNED 1–3 | Intro reframed; no phase reordering — the build target is identical, only its framing and the "evolve-not-invent" justification change. |
| D2 | **Sequence the 6 DIVERGENT gaps in the optimizer's ranked order** and tag each phase with the divergence + suggestion rank it closes. | `analysis.md` §4 DIVERGENT 1–6; `suggestions.md` ranks #1–#7 | Phase headers now carry `Closes:` tags. Ordering already matched (keystone Changesets in P0/P5, dedup/id in P0/P2, lint in P0/P2/P5, scaffold in P0, registry in P1/P4, hook order in P5); v2 makes the mapping explicit. |
| D3 | **Add the live-only 5-agent shadow-copy finding** (`sox-active` v1.0.20 re-vendors 5 agents also in `sox-cto-system` v2.0.23). The greenfield dedup lint (P2) already prevents this class; v2 adds it as an explicit P2 acceptance fixture and flags the *live* SOX cleanup as an out-of-scope follow-up gated by the meta-loop recursion guard. | `analysis.md` §1.3, §4 Ecosystem; `suggestions.md` #6 | New P2 fixture + a Section 5 "live follow-up, NOT in this build" note. No live system is touched by this engagement. |
| D4 | **Insert an eval-harness research gate (new phase P5.5).** The optimizer flagged a real gap: the live system has *no eval harness and no CI running agents* (`analysis.md` §2.5), and the `extension-ecosystem-design` topic has **no finding** on eval harnesses. Per the no-fabrication rule, v2 does NOT design one. P5.5 is a `workflow-researcher` spike; any behavioral-eval work in CI is GATED on its output landing in memory. | `suggestions.md` "Research gaps" #1 | New phase P5.5 between P5 and P6; P6 references it as a hard prerequisite for any eval addition. |
| D5 | **No v1 decision overridden.** The live analysis confirmed every Section 5 gap call and the Section 2 budget. The only Section 2 note added: the live `sox-cto-system` monolith is now cited as the concrete anti-pattern the independent-versioning budget replaces. | `analysis.md` §4 DIVERGENT #1; `suggestions.md` #1 | Section 5 unchanged in substance; one anti-pattern citation added to Section 2 and Gap framing. |

**Override audit:** the live analysis forced **zero** overrides of v1 Section-5 gap decisions or Section-2 reuse choices — it *strengthened* them by supplying a real-world monolith (`sox-cto-system`) as the anti-pattern and a real-world shadow copy (`sox-active`'s 5 agents) as the dedup target. The one genuinely *new* obligation is the eval-harness research gate (D4), which v1 lacked.

---

## Section 1 — Concrete repo architecture

> Carried forward from v1 unchanged — the live analysis (`analysis.md` §4 ALIGNED 1–2) confirmed the type taxonomy and the multi-scope cascade are already the right vocabulary in the live system; only *independence* and *enforcement* were missing, which Sections 3–4 add. The `plugin.json` → `extension.json` evolution (D1) is a manifest-shape change, not a schema redesign.

### 1.1 Final directory tree (six types resolved)

The research shows five types under `extensions/`; this plan adds `commands/` (sixth type, per `extension-type-taxonomy.md` §7) and reconciles the prompt convention: a **prompt** uses `prompt.md` as its content file in place of `src/index.ts`; all other types use `src/index.ts`. Exactly 4 files per extension in every case.

```text
repo-root/
  pnpm-workspace.yaml              # packages: ['extensions/*/*']
  package.json                     # root devDeps only (see Section 2 for pinned versions)
  pnpm-lock.yaml                   # single hoisted lockfile (pnpm-managed; distinct from per-scope extensions.lock)
  tsconfig.base.json               # strict mode; each extension extends this
  vitest.config.ts                 # include: ['extensions/**/*.test.ts']
  .changeset/
    config.json                    # { access: "public", baseBranch: "main", fixed: [] }
  schemas/
    extension/v1.json              # extension.json JSON Schema (Section 1.2)
    extensions-config/v1.json      # scoped extensions.json JSON Schema (Section 1.3)
    lockfile/v1.json               # per-scope lockfile JSON Schema (Section 1.4)
  extensions/
    agents/<id>/        { extension.json, src/index.ts, package.json, CHANGELOG.md }
    skills/<id>/        { extension.json, src/index.ts, package.json, CHANGELOG.md }
    mcp-servers/<id>/   { extension.json, src/index.ts, package.json, CHANGELOG.md }
    prompts/<id>/       { extension.json, prompt.md,     package.json, CHANGELOG.md }
    hooks/<id>/         { extension.json, src/index.ts, package.json, CHANGELOG.md }
    commands/<id>/      { extension.json, src/index.ts, package.json, CHANGELOG.md }
  registry/
    index.json                     # discovery index (built by build-index.ts)
  scripts/
    new-extension.ts               # scaffold generator      (Section 4.4)
    build-index.ts                 # registry index builder   (Section 4.3)
    install.ts                     # install client           (Section 4.1)
    cascade.ts                     # cascade-merge resolver    (Section 4.2)
    validate-manifests.ts          # dedup + secret lint       (Section 4.5)
    provider-capabilities.ts       # static capability matrix query (Section 2)
    pack-mcpb.ts                   # OPTIONAL .mcpb exporter (Gap 1; Phase 5+)
    registry-server.ts             # OPTIONAL two-endpoint HTTP server (Gap 3; Phase 6+/deferred)
  assets/
    model_capabilities.json        # vendored LiteLLM capability table snapshot (Section 2)
  .github/workflows/
    validate.yml                   # PR: validate-manifests + typecheck + test + changeset status
    release.yml                    # main: changesets publish + build-index + commit
```

**Directory↔type invariant:** the `type` field in `extension.json` MUST equal the singular of its parent directory (`agents/` → `agent`, `mcp-servers/` → `mcp-server`, `commands/` → `command`, etc.). Enforced by `validate-manifests.ts` (Section 4.5) and hard-rejected at host load time. Source: `extension-type-taxonomy.md` §7; `llm-extension-repo-reference-architecture.md` §2.

### 1.2 `extension.json` JSON Schema (v1) — complete document

`schemas/extension/v1.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://your-registry/schemas/extension/v1.json",
  "title": "Extension manifest v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["$schema", "id", "version", "type", "title", "description", "compatibility", "license"],
  "properties": {
    "$schema": { "type": "string", "format": "uri" },
    "id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]*$",
      "description": "Stable slug; primary registry key; immutable once published."
    },
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z-.]+)?(?:\\+[0-9A-Za-z-.]+)?$",
      "description": "semver; MUST equal package.json version (CI-enforced)."
    },
    "type": {
      "type": "string",
      "enum": ["agent", "skill", "mcp-server", "prompt", "hook", "command"]
    },
    "title": { "type": "string", "minLength": 1 },
    "description": { "type": "string", "minLength": 1 },
    "compatibility": {
      "type": "object",
      "additionalProperties": false,
      "required": ["host"],
      "properties": {
        "host": {
          "type": "string",
          "description": "semver range of supported host versions, e.g. '>=1.0.0 <2.0.0'."
        }
      }
    },
    "entrypoint": {
      "type": "string",
      "description": "Resolved at install. Required for behavioral types; omitted for prompt (host convention: prompt.md)."
    },
    "author": { "type": "string" },
    "license": { "type": "string" },
    "requires": {
      "type": "object",
      "additionalProperties": false,
      "description": "Static capability requirements checked against configured provider at install time.",
      "properties": {
        "tool_calling": { "type": "boolean", "default": false },
        "structured_output": { "type": "boolean", "default": false },
        "min_context_tokens": { "type": "integer", "minimum": 1 }
      }
    },
    "order": {
      "type": "integer",
      "default": 100,
      "description": "Hook execution order for the bound lifecycle event (ascending). Only meaningful when type=='hook'. Ties broken by id lexicographic. See Gap 2."
    },
    "dependencies": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "version"],
        "properties": {
          "id": { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" },
          "version": { "type": "string" }
        }
      }
    },
    "capabilities": { "type": "array", "items": { "type": "string" } },
    "tags": { "type": "array", "items": { "type": "string" } },
    "repository": { "type": "string", "format": "uri" },
    "private": { "type": "boolean", "default": false },
    "checksum": {
      "type": "string",
      "pattern": "^sha256:[0-9a-f]{64}$",
      "description": "Populated by CI at publish time; verified on install."
    }
  },
  "allOf": [
    {
      "if": { "properties": { "type": { "const": "hook" } } },
      "then": { "required": ["entrypoint"] }
    },
    {
      "if": { "properties": { "type": { "enum": ["agent", "skill", "mcp-server", "command"] } } },
      "then": { "required": ["entrypoint"] }
    }
  ]
}
```

Notes: `type` is a **closed enum incl. `command`**. `compatibility.host` is a semver **range** (not an integer), per `version-declaration-and-negotiation` cited in reference-architecture §2. `requires` block carries capability flags per `multi-llm-provider-abstraction.md` §3. `order` is hook-only (Gap 2). `checksum` is `sha256:`-prefixed. **v2 migration note:** this manifest is the independent-unit successor to the live `plugin.json` (`analysis.md` §1.3) — `id` replaces `name@marketplace` as the primary key (closes DIVERGENT #2).

### 1.3 Scoped `extensions.json` config schema + worked examples

`schemas/extensions-config/v1.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://your-registry/schemas/extensions-config/v1.json",
  "title": "Scoped extensions config v1",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "extends": {
      "type": "string",
      "format": "uri",
      "description": "Org baseline URL. Fetched, then this scope merges on top. Pinned by sha256 in lockfile (Gap 4)."
    },
    "strict_capabilities": {
      "type": "boolean",
      "default": false,
      "description": "If true, a capability mismatch hard-blocks install instead of warning (Gap 5)."
    },
    "providers": {
      "type": "object",
      "description": "Provider connection blocks. User/local scope only — NEVER in committed project config. API keys are ${ENV} refs only.",
      "additionalProperties": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "base_url": { "type": "string", "format": "uri" },
          "api_key": {
            "type": "string",
            "pattern": "^(\\$\\{[A-Z0-9_]+\\}|ollama)$",
            "description": "Env-var reference ${VAR} or the literal 'ollama' sentinel. Literal secrets are a lint error."
          }
        }
      }
    },
    "install": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id"],
        "properties": {
          "id": { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" },
          "version": { "type": "string", "description": "semver range or workspace:* for monorepo-local." },
          "enabled": { "type": "boolean", "default": true },
          "source": { "type": "string", "description": "Optional explicit source override (npm:, file://, https://)." }
        }
      }
    },
    "config": {
      "type": "object",
      "description": "Per-extension config keyed by extension id. Deep-merged across scopes.",
      "additionalProperties": { "type": "object" }
    },
    "enabled": {
      "type": "object",
      "description": "Per-extension enable/disable override keyed by id. Narrowest scope wins.",
      "additionalProperties": { "type": "boolean" }
    },
    "private": {
      "type": "boolean",
      "default": false,
      "description": "If true, this scope's extensions are excluded from registry publication and global dedup."
    }
  }
}
```

> **v2 migration note (D1):** the live `installed_plugins.json` already records `scope: user`/`scope: project` and an `enabled` flag per plugin (`analysis.md` §1.3, ALIGNED #1) — this `extensions.json` is its independent-unit, cascade-aware successor. The live system proves the scope+enabled concept; what it lacks (and this schema adds) is `extends` org-baseline inheritance, per-extension deep-merge `config`, and the narrowest-wins suppression semantics.

**Worked example — Org baseline** (`https://org.example.com/extensions/base.json`, fetched via `extends`):

```jsonc
{
  "install": [
    { "id": "security-linter", "version": "^2.0.0", "enabled": true },
    { "id": "verbose-logger",  "version": "^1.0.0", "enabled": true }
  ],
  "config": { "security-linter": { "severity": "high" } }
}
```

**Worked example — User scope** (`~/.config/extensions/extensions.json`; holds secrets, gitignored by nature of location):

```jsonc
{
  "extends": "https://org.example.com/extensions/base.json",
  "providers": {
    "anthropic": { "api_key": "${ANTHROPIC_API_KEY}" },
    "openai":    { "api_key": "${OPENAI_API_KEY}" },
    "ollama":    { "base_url": "http://localhost:11434/v1", "api_key": "ollama" }
  },
  "install": [
    { "id": "my-agent", "version": "^1.2.0", "enabled": true }
  ],
  "config": { "my-agent": { "provider": "anthropic/claude-opus-4-5", "max_tokens": 8192 } }
}
```

**Worked example — Project scope** (`.extensions/extensions.json`; committed; no secrets, no `providers`):

```jsonc
{
  "strict_capabilities": true,
  "install": [
    { "id": "code-reviewer", "version": "workspace:*", "enabled": true }
  ],
  "config": { "my-agent": { "max_tokens": 2048 } },
  "enabled": { "verbose-logger": false }
}
```

**Worked example — Local override** (`.extensions/extensions.local.json`; gitignored):

```jsonc
{
  "config": { "my-agent": { "provider": "ollama/llama3.1" } }
}
```

Merge semantics (Section 4.2): primitives replace, objects deep-merge, **arrays replace entirely (not concat)**, narrowest scope wins, `enabled:false` at a narrower scope force-suppresses. Source: `multi-scope-install-config-cascade.md` §4, §7.

### 1.4 Per-scope lockfile schema (with `extends` content-hash pin)

`schemas/lockfile/v1.json` (worked instance shown; schema mirrors it):

```jsonc
// .extensions/extensions.lock  (committed at project scope; user lockfile lives in ~/.config/extensions/)
{
  "lockfileVersion": 1,
  "extends": {
    "url": "https://org.example.com/extensions/base.json",
    "sha256": "sha256:9f2c...e1",        // content hash of the fetched baseline; fail-closed on divergence (Gap 4)
    "resolved_at": "2026-06-07T00:00:00Z"
  },
  "resolved": {
    "my-agent@1.2.3": {
      "source": "https://cdn.jsdelivr.net/npm/@scope/extension-my-agent@1.2.3/dist/index.js",
      "checksum": "sha256:abc123...",
      "resolved_at": "2026-06-07T00:00:00Z"
    },
    "code-reviewer@0.1.0": {
      "source": "file://./extensions/skills/code-reviewer",
      "checksum": "sha256:def456...",
      "resolved_at": "2026-06-07T00:00:00Z"
    }
  }
}
```

JSON Schema: `lockfileVersion` (const 1), `extends` is an optional object `{ url:uri, sha256:^sha256:[0-9a-f]{64}$, resolved_at:date-time }`, `resolved` is an object whose keys match `^[a-z][a-z0-9-]*@\d+\.\d+\.\d+...$` and whose values are `{ source:string, checksum:sha256-pattern, resolved_at:date-time }`. Lockfiles are never merged across scopes. Source: `multi-scope-install-config-cascade.md` §5; `extends` pin per Gap 4.

---

## Section 2 — Build-vs-reuse LOCKED per component

Versions are research-current as of 2026-06. Where a precise patch is unknowable from the findings, the version family is given and marked `Conjecture:`.

> **v2 anti-pattern citation (D5):** the live `sox-cto-system` v2.0.23 plugin bundles 4 agents + 3 skills + scripts + templates under ONE semver (`analysis.md` §1.3, §4 DIVERGENT #1). Any one-line fix re-publishes the whole monolith. That is the concrete anti-pattern the "Independent versioning → Changesets" reuse row below replaces; it is the single highest-leverage decision in the plan (`suggestions.md` #1).

### Reuse (no custom code)

| Component | Tool | Pinned version | Source |
|---|---|---|---|
| Monorepo pkg mgmt | pnpm workspaces | `pnpm@9.x` `Conjecture:` (9 family current 2026-06) | build-vs-reuse row 1 |
| Independent versioning | Changesets | `@changesets/cli@2.27.x`, `@changesets/action@v1` `Conjecture:` | row 2; reference-arch §3 |
| Static manifest validation | ajv | `ajv@8.x` | row 3 |
| Runtime type safety (TS) | Zod | `zod@3.x` `Conjecture:` (3 family; 4 may be current — verify at P0) | row 3 |
| CI orchestration | GitHub Actions | `actions/checkout@v4`, `pnpm/action-setup@v3` | row 9; reference-arch §6 |
| Incremental task runner | pnpm `--filter`; Turborepo deferred | `turbo@2.x` only if build >3 min `Conjecture:` | row 10 |
| Testing (TS) | Vitest | `vitest@2.x` `Conjecture:` | row 11 |
| Testing (Python) | pytest | `pytest@8.x` `Conjecture:` | row 11 |
| LLM provider (Python) | LiteLLM | `litellm@1.x` `Conjecture:` | row 12 |
| LLM provider (TS) | Vercel AI SDK | `ai@4.x` `Conjecture:` (`createProviderRegistry`) | row 13 |
| Config comment parsing | jsonc-parser | `jsonc-parser@3.x` | row 14 |
| Secret/env resolution | dotenv / python-dotenv | `dotenv@16.x` / `python-dotenv@1.x` `Conjecture:` | row 16 |

**Pinning discipline:** all reuse deps are pinned to exact versions in root `package.json` at P0; `Conjecture:`-marked families MUST be resolved to an exact patch during P0 acceptance.

> **Eval-harness reuse — DEFERRED to P5.5 research (D4).** No reuse tool is locked for behavioral agent/prompt evaluation. The `extension-ecosystem-design` topic has no finding on eval harnesses (`suggestions.md` "Research gaps" #1). v2 does NOT pre-select golden-transcript / LLM-judge / assertion tooling here — that selection is the explicit output of the P5.5 spike and is excluded from the LOC budget below until it lands.

### Build (thin glue) — single responsibility + interface

| Module | Single responsibility | Interface (inputs → outputs; side effects) |
|---|---|---|
| `new-extension.ts` | Scaffold a new extension (4 files) for any of the 6 types | prompts (type,id,title,description) → writes `extensions/<type>/<id>/` dir; no network |
| `build-index.ts` | Build the discovery index | reads all `extension.json` → writes `registry/index.json`; no network |
| `install.ts` | Resolve scopes, fetch, verify, lock | scope + flags → writes `extensions.lock`, fetches artifacts; network + fs |
| `cascade.ts` | Merge scoped configs into a flat resolved map | ordered scope configs → flat `{id→{version,enabled,config}}`; pure |
| `validate-manifests.ts` | Enforce identity/dedup/secret invariants | reads `extensions/**` + `registry/index.json` → exit 0/1 + diagnostics; pure |
| `provider-capabilities.ts` | Query static capability table | `(model, requires)` → `{ok,warnings}`; reads `assets/model_capabilities.json`; pure |
| lockfile schema (`schemas/lockfile/v1.json` + writer in `install.ts`) | Define + emit lockfile | resolved set → lockfile JSON |
| `registry-server.ts` (Phase 6+, OPTIONAL) | Two-endpoint HTTP registry | HTTP `GET /versions`, `GET /:version/download` over `index.json` |
| `pack-mcpb.ts` (Phase 5+, OPTIONAL) | Export a built extension as `.mcpb` | built extension dir → `<id>.mcpb` bundle; fs |

### LOC budget table (sums to total)

| Module | LOC | Phase introduced |
|---|---:|---|
| `install.ts` | 300 | P1/P2/P4 (grows) |
| `new-extension.ts` | 120 | P0 |
| `cascade.ts` | 100 | P2 |
| `build-index.ts` | 80 | P1 |
| `validate-manifests.ts` | 80 | P0/P2 (grows) |
| `provider-capabilities.ts` | 30 | P3 |
| lockfile schema + writer | 20 | P1 |
| **Core subtotal** | **730** | |
| `registry-server.ts` (optional, deferred) | 150 | P6+ |
| `pack-mcpb.ts` (optional) | ~130 `Conjecture:` | P5+ |
| **Total incl. optional** | **~1010** | |

Core (always-built) glue lands at **730 LOC**; the two optional/deferred modules bring the budget to **~1010 LOC**, matching the build-vs-reuse matrix. Source: `build-vs-reuse-and-build-plan.md` Part 1 (~1010 total). **Any eval-harness glue from P5.5 is OUTSIDE this 1010-LOC budget and will be re-budgeted once the research finding exists (D4).**

---

## Section 3 — Phased, resumable implementation plan

Each phase is standalone: a fresh executor can resume from its prompt alone. Acceptance checks are deterministic (exact command + expected result). UC-N refer to the 5 MVP use cases in `build-vs-reuse-and-build-plan.md` Part 3. Each phase header carries a `Closes:` tag mapping it to the `analysis.md` §4 divergence and `suggestions.md` rank it addresses (D2).

### Phase 0 — Repo skeleton + scaffold + manifest schema

**Phase ID:** P0
**Closes:** DIVERGENT #2 (id format/type-dir half), #3 (scaffold), #5 (lint format half), keystone #1 setup (`.changeset` config) — `suggestions.md` #1, #2, #3, #4.
**Phase goal:** An empty monorepo with all tooling wired, the `extension.json` schema authored, the scaffold generator working, and a `hello-world` skill that builds and lints clean.
**Inputs:** empty repo; this plan's Sections 1.2 and 2.
**Outputs:** `pnpm-workspace.yaml`, root `package.json`, `tsconfig.base.json`, `.changeset/config.json` (`fixed: []`), `schemas/extension/v1.json`, `scripts/new-extension.ts`, `scripts/validate-manifests.ts` (id-format + type/dir checks only), `extensions/skills/hello-world/` (4 files).
**Verification:** `pnpm changeset status` exits 0; `pnpm typecheck` exits 0; `pnpm run validate-manifests` exits 0; `extensions/skills/hello-world/` contains exactly 4 files.
**Unblocks:** UC-1 (scaffold half).

**Phase prompt:**

> You are a TypeScript build/tooling engineer bootstrapping a greenfield monorepo that will host six LLM-extension types (agent, skill, mcp-server, prompt, hook, command). Nothing exists yet in the repo source tree. Context you need cold: this repo lives inside an existing SOX plugin ecosystem whose monolithic `plugin.json` plugins (one semver bundling many agents/skills) are exactly what this new repo's *independent per-extension versioning* replaces — you are building the independent-unit successor, not editing that live system. The authoritative architecture is in `.workflow/plans/sox-ecosystem/migration.md` Sections 1.1, 1.2, and 2 — read them first; do not re-derive the design.
>
> Your task: create the repo skeleton. (1) `git init`; `pnpm init`; `pnpm-workspace.yaml` with `packages: ['extensions/*/*']`. (2) Root `package.json` with devDeps pinned to exact versions per migration.md Section 2 "Reuse" table — resolve every `Conjecture:`-marked family to an exact patch now and record the resolved versions in a comment. (3) `tsconfig.base.json` strict mode. (4) `pnpm changeset init`, then set `.changeset/config.json` to `{ "access": "public", "baseBranch": "main", "fixed": [] }` (true independent mode — this is the keystone decision; do NOT use a `fixed` group). (5) Author `schemas/extension/v1.json` exactly as in migration.md Section 1.2 (closed type enum incl. `command`; `compatibility.host` semver range; `requires`; hook-only `order`; `sha256:`-prefixed `checksum`). (6) Write `scripts/new-extension.ts` (~120 LOC, Node `fs`+`readline`, zero external scaffold deps) that prompts for type/id/title/description and writes the 4 files for the chosen type — prompts use `prompt.md`, all others `src/index.ts`. (7) Write `scripts/validate-manifests.ts` with ONLY the id-format (`^[a-z][a-z0-9-]*$`), id-not-ending-in-type-name, and type/parent-directory-match checks for now (dedup comes in P2). (8) Run `new-extension.ts` to generate `extensions/skills/hello-world/`.
>
> Skills/tools you need: pnpm, Changesets CLI, TypeScript, ajv. Files to read first: `.workflow/plans/sox-ecosystem/migration.md` Sections 1.1, 1.2, 2.
> Success criteria (all must hold): `pnpm changeset status` exits 0; `pnpm typecheck` exits 0; `pnpm run validate-manifests` exits 0; `extensions/skills/hello-world/` contains exactly 4 files.
> Hard constraints: exactly 4 files per extension; no per-extension tsconfig/eslint/test config; do NOT modify `pnpm-workspace.yaml` after creation (the glob auto-discovers); do NOT add Yeoman/Plop; the `type` enum is closed — six values only; do NOT touch the live global SOX install (`~/.claude/`).
>
> **Mandatory completion step.** Before exiting, append one line to `.workflow/plans/sox-ecosystem/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P0 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`. *On the final phase, set `state: complete` instead of `executing`.* (P0 is not the final phase.)

### Phase 1 — First installable extension (single scope)

**Phase ID:** P1
**Closes:** DIVERGENT #4 (distribution — index half) — `suggestions.md` #5 (P1 leg).
**Phase goal:** A user-scope `extensions.json` installs `hello-world`, producing a deterministic lockfile; the host loads and activates the skill.
**Inputs:** P0 outputs.
**Outputs:** `scripts/install.ts` (single-scope, no cascade), `scripts/build-index.ts`, `schemas/lockfile/v1.json`, a user-scope `extensions.json` pointing at the local `hello-world` path, generated `~/.config/extensions/extensions.lock`.
**Verification:** from a fresh checkout, `pnpm run install-extensions --scope=user` writes a lockfile; a second run with `--frozen-lockfile` produces a byte-identical lock and exits 0; a corrupted artifact yields a non-zero checksum-mismatch exit.
**Unblocks:** UC-1 (install half).

**Phase prompt:**

> You are a TypeScript systems engineer. A monorepo skeleton for an LLM-extension ecosystem already exists (Phase P0 complete): `extensions/skills/hello-world/` builds, `schemas/extension/v1.json` and `scripts/new-extension.ts` exist. Read `.workflow/plans/sox-ecosystem/migration.md` Sections 1.4 (lockfile schema), 4.1 (install client contract), 4.3 (build-index contract) before writing code.
>
> Your task: make the first extension installable. (1) Write `schemas/lockfile/v1.json` per migration.md Section 1.4 (incl. the `extends` content-hash slot, even though unused this phase). (2) Write `scripts/build-index.ts` (~80 LOC) per the Section 4.3 contract: read every `extension.json` under `extensions/`, emit `registry/index.json` with `{id,type,version,title,description,source,checksum,compatibility}`. (3) Write `scripts/install.ts` (~300 LOC target across phases; this phase implements SINGLE scope only — no cascade) per the Section 4.1 contract: read a scope's `extensions.json`, resolve each `install[]` entry (local file path or `source` URL), verify sha256 checksum, write the per-scope lockfile. Implement `--scope=<org|user|project|local>`, `--frozen-lockfile`, and `--update` flags; this phase only needs `--scope=user` and `--frozen-lockfile` to fully work. (4) Create a user-scope `~/.config/extensions/extensions.json` with one `install` entry for `hello-world` using a `file://` source.
>
> Skills/tools you need: Node `fetch`, `node:crypto` (sha256), ajv. Files to read first: migration.md Sections 1.4, 4.1, 4.3.
> Success criteria: `pnpm run install-extensions --scope=user` writes `~/.config/extensions/extensions.lock` validating against `schemas/lockfile/v1.json`; re-running with `--frozen-lockfile` exits 0 and leaves the lockfile byte-identical; a deliberately corrupted artifact (altered bytes) causes a non-zero exit with a checksum-mismatch message.
> Hard constraints: never merge lockfiles across scopes; resolve `${ENV}` references at runtime only, never at parse time; `--frozen-lockfile` must refuse to re-resolve; do NOT touch the live global SOX install (`~/.claude/`).
>
> **Mandatory completion step.** Before exiting, append one line to `.workflow/plans/sox-ecosystem/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P1 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`. *On the final phase, set `state: complete` instead of `executing`.* (P1 is not the final phase.)

### Phase 2 — Multi-scope install + config cascade + dedup/secret lint

**Phase ID:** P2
**Closes:** DIVERGENT #2 (dedup invariants), #5 (dedup + secret + cross-scope lint), and the live-only 5-agent shadow-copy finding — `suggestions.md` #2, #3, #6 (greenfield leg); Gap 4 (`extends` pin).
**Phase goal:** org→user→project→local cascade resolves correctly; `enabled:false` at a narrower scope suppresses a globally enabled extension; dedup and secret-in-config lint fire in CI; a shadow-copy fixture (the live `sox-active`/`sox-cto-system` failure mode) is rejected.
**Inputs:** P1 outputs.
**Outputs:** `scripts/cascade.ts`; extended `scripts/install.ts` (full 4-scope load + `extends` fetch with sha256 pin); extended `scripts/validate-manifests.ts` (three uniqueness invariants + cross-scope dup + shadow-copy check + secret regex); `.gitignore` adds `.extensions/extensions.local.json`.
**Verification:** an integration test asserting a three-scope cascade produces the expected flat resolved-config map; a duplicate-ID fixture makes `validate-manifests` exit non-zero; a *shadow-copy* fixture (same id from two separately-versioned sources) makes it exit non-zero; a committed-secret fixture makes it exit non-zero; an `extends`-hash-mismatch fixture fails closed without `--update` and succeeds with it.
**Unblocks:** UC-4 (config override), UC-5 (dedup), Gap 4 (`extends` pin); structurally prevents the live shadow-copy class in the new repo.

**Phase prompt:**

> You are a TypeScript systems engineer. The install client exists for a single scope (Phases P0–P1 complete): `scripts/install.ts` resolves one scope and writes a per-scope lockfile; `scripts/build-index.ts` and `schemas/lockfile/v1.json` exist. Context you need cold: the surrounding live SOX ecosystem exhibits a real "shadow copy" bug — its `sox-active` plugin re-vendors 5 agents (`cto-agent`, `janitor-agent`, `workflow-analyst`, `workflow-implementer`, `planner`) that are ALSO shipped, separately versioned, by `sox-cto-system`. The dedup lint you build here is exactly what prevents that failure mode in this new repo. Do NOT attempt to fix the live SOX system — confine all work to this repo. Read `.workflow/plans/sox-ecosystem/migration.md` Sections 1.3 (scoped config schema + worked examples), 4.2 (cascade-merge resolver contract), 4.5 (dedup lint contract), and the Gap 4 resolution in Section 5 before writing code.
>
> Your task: (1) Write `scripts/cascade.ts` (~100 LOC) implementing the Section 4.2 contract exactly: load org baseline (if `extends` present) → user → project → local; **primitives replace, objects deep-merge, ARRAYS REPLACE ENTIRELY (not concat), narrowest scope wins**; `enabled:false` at a narrower scope force-suppresses; emit a flat `{ id → { version, enabled, config } }` map. (2) Extend `scripts/install.ts` to call the cascade across all four scopes and to fetch the `extends` org baseline, computing its sha256 and writing `extends: { url, sha256, resolved_at }` into the lockfile; on a subsequent install the fetched baseline's hash MUST match the lockfile or install FAILS CLOSED unless `--update` is passed (Gap 4). (3) Extend `scripts/validate-manifests.ts` to enforce the three uniqueness invariants from Section 4.5 (unique id per registry; ≤1 entry per id in any single scope's `install[]`; **no shadow copies** — the same id MUST NOT exist as two separately-versioned installables), cross-scope duplicate detection, and a secret-in-committed-config regex (block `${ENV}`-free literal values matching known API-key shapes in any committed `extensions.json`). (4) Add `.extensions/extensions.local.json` to root `.gitignore`. (5) Add a regression fixture modeling the live `sox-active`/`sox-cto-system` shadow copy (one agent id supplied by both an npm source and a `file://` source) and assert the lint rejects it.
>
> Skills/tools you need: Node fs/crypto, ajv, a test runner (Vitest). Files to read first: migration.md Sections 1.3, 4.2, 4.5, and Section 5 Gap 4.
> Success criteria: a Vitest integration test feeding org/user/project/local fixtures asserts the exact flat resolved map (incl. an array-replace case and an `enabled:false` suppression case) and passes; `validate-manifests` exits non-zero on a duplicate-ID fixture, on the shadow-copy fixture, and on a literal-secret fixture; an `extends`-hash-mismatch fixture causes install to exit non-zero without `--update` and exit 0 with `--update`.
> Hard constraints: arrays REPLACE, never concatenate (document this in a code comment citing migration.md Section 4.2); secrets valid only at user/local scope; never commit `extensions.local.json`; fail closed on `extends` hash divergence; do NOT modify the live global SOX install (`~/.claude/`) or its plugins.
>
> **Mandatory completion step.** Before exiting, append one line to `.workflow/plans/sox-ecosystem/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P2 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`. *On the final phase, set `state: complete` instead of `executing`.* (P2 is not the final phase.)

### Phase 3 — Multi-provider support + capability check

**Phase ID:** P3
**Closes:** provider-abstraction MVP (UC-2) + Gap 5 — not a §4 divergence; carried from v1.
**Phase goal:** A skill runs against Claude at one scope and a local Ollama model at another with zero code changes; a tool-calling extension pointed at a non-tool-calling model warns at install time (or blocks under `strict_capabilities`).
**Inputs:** P2 outputs.
**Outputs:** `assets/model_capabilities.json` (vendored LiteLLM table snapshot); `scripts/provider-capabilities.ts` (~30 LOC); `providers` block wired into install; capability check integrated into `install.ts`.
**Verification:** an install run with `requires.tool_calling:true` against `ollama/llama3` (no tool calling) emits a warning and exits 0 by default; the same run with `strict_capabilities:true` exits non-zero.
**Unblocks:** UC-2 (provider swap) and Gap 5 (capability stance).

**Phase prompt:**

> You are a TypeScript/LLM-integration engineer. A multi-scope install client with a config cascade already exists (Phases P0–P2 complete). Read `.workflow/plans/sox-ecosystem/migration.md` Section 2 (provider rows), the provider layering rules, and the Gap 5 resolution in Section 5 before writing code. Background: `multi-llm-provider-abstraction.md` establishes that `provider` config lives in the scoped `extensions.json`, while `requires.*` lives in `extension.json`.
>
> Your task: (1) Vendor a snapshot of LiteLLM's `model_prices_and_context_window.json` capability table into `assets/model_capabilities.json` (the public static JSON; do NOT add the full LiteLLM library as a TS runtime dep). (2) Write `scripts/provider-capabilities.ts` (~30 LOC): given a `model` string and an extension's `requires` block, look up the model in the vendored table and return `{ ok: boolean, warnings: string[] }` covering `tool_calling`, `structured_output`, and `min_context_tokens`. (3) Wire the `providers` block (with `${ENV}` api_key refs and `base_url`) from resolved config into the install flow. (4) Integrate the capability check into `install.ts`: for every installed extension whose `requires.tool_calling` (or other flag) is true, check the configured provider model; by DEFAULT emit a loud warning and continue (exit 0); if the resolving scope has `strict_capabilities: true`, treat the mismatch as a hard error (non-zero exit). This is Gap 5: advisory-warn default, hard-block opt-in.
>
> Skills/tools you need: the vendored capability JSON; optionally LiteLLM/Vercel AI SDK in extension runtimes (not the install client). Files to read first: migration.md Section 2 provider rows + Section 5 Gap 5.
> Success criteria: installing a `requires.tool_calling:true` extension configured for `ollama/llama3` prints a capability warning and exits 0; the same install under a scope with `strict_capabilities:true` exits non-zero; switching a config's `provider` from `anthropic/claude-opus-4-5` to `ollama/llama3.1` (tool-calling-capable) passes the check with no warning and requires no change to extension source.
> Hard constraints: never put `provider` in `extension.json` (it belongs in scoped config); resolve `${ENV}` api_keys at runtime only; do not add the full LiteLLM Python library to the TS host — use the static capability table only.
>
> **Mandatory completion step.** Before exiting, append one line to `.workflow/plans/sox-ecosystem/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P3 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`. *On the final phase, set `state: complete` instead of `executing`.* (P3 is not the final phase.)

### Phase 4 — Registry publish + remote install from clean machine

**Phase ID:** P4
**Closes:** DIVERGENT #4 (distribution — npm+CDN replacing the local-file `marketplace.json`) + Gap 1 — `suggestions.md` #5 (P4 leg).
**Phase goal:** Publish `hello-world` to npm; install it on a clean machine from `registry/index.json` (no local source); `--frozen-lockfile` refuses re-resolution and `--update` re-resolves.
**Inputs:** P3 outputs.
**Outputs:** a Changeset for `hello-world`; published npm package; `registry/index.json` regenerated with npm-CDN `source` + sha256; verified clean-machine install.
**Verification:** on a clean checkout/machine with only `{ "install": [{ "id": "hello-world", "version": "^0.2.0" }] }` at user scope, `pnpm run install-extensions --scope=user` fetches from the npm CDN, verifies sha256, writes a working lockfile; a tampered artifact is rejected; `--frozen-lockfile` rejects a stale lock while `--update` rewrites it.
**Unblocks:** UC-3 (publish→install) and Gap 1 (npm+registry is the primary path).

**Phase prompt:**

> You are a release/distribution engineer. A working multi-scope, multi-provider install client exists (Phases P0–P3 complete) and `hello-world` installs from a local path. Context you need cold: the surrounding live SOX ecosystem distributes plugins via a LOCAL FILE marketplace (`/Users/nix/dev/ai/claude-agents/.claude-plugin/marketplace.json`) — a clean machine cannot install without that checkout. This phase replaces that model with npm + a git `registry/index.json` so installs are reproducible on any clean machine. Read `.workflow/plans/sox-ecosystem/migration.md` Section 4.1 (install client: `--frozen-lockfile`/`--update`), Section 4.3 (build-index emits npm-CDN source + sha256), and the Gap 1 resolution in Section 5 before acting.
>
> Your task: prove the publish→install cycle. (1) Run `pnpm changeset` declaring a minor bump for `hello-world`; run `changeset version`; run `changeset publish` to publish `@scope/extension-hello-world` to npm (use a test registry or `--dry-run` if no npm token is available, and document which). (2) Run `scripts/build-index.ts` so `registry/index.json` lists `hello-world` with a resolved npm-CDN `source` URL (`https://cdn.jsdelivr.net/npm/@scope/extension-hello-world@<v>/dist/index.js`) and the artifact's sha256 `checksum`. (3) On a clean checkout (no prior lockfile/state), create a user-scope `extensions.json` with `{ "install": [{ "id": "hello-world", "version": "^0.2.0" }] }`, run `install-extensions --scope=user`, and confirm it resolves the published version from the registry index, fetches from the npm CDN, verifies sha256, and writes the lockfile. (4) Verify `--frozen-lockfile` refuses to re-resolve and `--update` re-resolves. This confirms Gap 1: npm + git `registry/index.json` is the PRIMARY, language-neutral install path (`.mcpb` is a later optional export, not built here).
>
> Skills/tools you need: Changesets, npm publish (or dry-run), Node fetch/crypto. Files to read first: migration.md Sections 4.1, 4.3, Section 5 Gap 1.
> Success criteria: a clean-machine install with no prior state resolves `^0.2.0` to the published version, fetches from the CDN, sha256 matches, and the skill activates; a byte-tampered artifact is rejected with a checksum error; `--frozen-lockfile` exits non-zero on a stale lock while `--update` succeeds and rewrites it.
> Hard constraints: the registry stores metadata only — artifacts come from npm/CDN; never publish a `private:true` extension; checksum verification is mandatory on every fetch; do NOT alter the live `marketplace.json` or the live SOX install.
>
> **Mandatory completion step.** Before exiting, append one line to `.workflow/plans/sox-ecosystem/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P4 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`. *On the final phase, set `state: complete` instead of `executing`.* (P4 is not the final phase.)

### Phase 5 — All six extension types + full CI + hook ordering

**Phase ID:** P5
**Closes:** DIVERGENT #1 (independent versioning PROVEN), #6 (declared hook `order`); ratifies #3 (lint in CI) — `suggestions.md` #1, #3, #7; Gap 2.
**Phase goal:** One working example of each of the six types; CI validate+release workflows live; hook execution order is deterministic; independent versioning proven (bump one, others stay).
**Inputs:** P4 outputs.
**Outputs:** stubs for agent, mcp-server, prompt, hook, command (skill already exists); `.github/workflows/validate.yml` + `release.yml`; hook-ordering logic in the host loader keyed on `order` then `id`; optional `scripts/pack-mcpb.ts`.
**Verification:** `pnpm changeset status` after bumping only the skill shows exactly one package pending; CI validate workflow passes on a clean PR; a fixture with two hooks on the same event loads them in `order`-ascending, `id`-tiebroken sequence.
**Unblocks:** completes UC-1..UC-5 coverage; resolves Gap 2 (hook ordering) and Gap 1 export option.

**Phase prompt:**

> You are a full-stack TypeScript engineer finishing an LLM-extension monorepo. Phases P0–P4 are complete: install, cascade, providers, and registry publish all work; only the `skill` type has a real example. Context you need cold: the live SOX system orders its 9 global hooks IMPLICITLY by array position in `settings.json` — brittle to edits and impossible to reason about per-extension. This phase makes hook order explicit via an integer `order` field. Also: proving independent versioning here directly demonstrates the fix for the live `sox-cto-system` monolith (one semver for many sub-units). Read `.workflow/plans/sox-ecosystem/migration.md` Sections 1.1 (six-type tree), 4.4 (scaffold per type incl. `command`), and the Gap 2 resolution in Section 5 before writing code. Background type responsibilities are in `extension-type-taxonomy.md`.
>
> Your task: (1) Run `scripts/new-extension.ts` to scaffold one example of each remaining type: `agent` (system prompt + 2 tools), `mcp-server` (stdio transport, 1 stub tool), `prompt` (`prompt.md` with frontmatter + parameterized body, NO `src/index.ts`), `hook` (binds a lifecycle event e.g. `PreToolUse`, logs to a file, sets `order`), `command` (deterministic shell op, slash-invoked, no LLM). Each must be exactly 4 files. (2) Implement hook execution ordering in the host loader per Gap 2: when multiple hooks bind the SAME lifecycle event, sort ascending by the integer `order` field (default 100), breaking ties by `id` lexicographic. Document that hooks should be order-independent where possible and `order` is an escape hatch, not a dependency mechanism. (3) Add `.github/workflows/validate.yml` (runs `validate-manifests`, `typecheck`, `test`, `changeset status` on PRs with `--filter "...[HEAD~1]"`) and `release.yml` (Changesets publish → `build-index` → commit `registry/index.json`) exactly per reference-architecture §6. (4) OPTIONAL: write `scripts/pack-mcpb.ts` to export a built extension as a `.mcpb` bundle (Gap 1 export target) — skip if time-bound. (5) Prove independent versioning: add a changeset bumping only the skill; confirm only the skill is pending.
>
> Skills/tools you need: Changesets, GitHub Actions, MCP stdio SDK for the mcp-server stub. Files to read first: migration.md Sections 1.1, 4.4, Section 5 Gap 2.
> Success criteria: all six type directories exist with exactly 4 files each and pass `validate-manifests`; a two-hooks-same-event fixture loads in `order`-then-`id` sequence (assert via test); `pnpm changeset status` after the skill-only bump lists exactly one package; the validate workflow passes on a clean PR.
> Hard constraints: `prompt` type uses `prompt.md`, never `src/index.ts`; the `type` field must match the parent directory for all six; hooks must not call the LLM (deterministic only); exactly 4 files per extension; do NOT add a behavioral agent/prompt eval step to CI here — that is gated on the P5.5 research spike (see migration.md P5.5).
>
> **Mandatory completion step.** Before exiting, append one line to `.workflow/plans/sox-ecosystem/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P5 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`. *On the final phase, set `state: complete` instead of `executing`.* (P5 is not the final phase.)

### Phase 5.5 — Eval-harness research spike (GATE — research only)

**Phase ID:** P5.5
**Closes:** the eval-harness research gap — `analysis.md` §2.5 (no eval harness, no CI running agents); `suggestions.md` "Research gaps" #1. This is a GATE: no behavioral-eval code may be written in P6 (or any later engagement) until this finding lands in memory.
**Phase goal:** A memory-backed finding that selects (or explicitly defers) a minimal CI eval-harness pattern for behavioral regression testing of LLM agent/prompt extensions — golden-transcript fixtures vs LLM-judge vs assertion-based — and locates it relative to the existing manifest/build validation (`validate.yml`). NO implementation.
**Inputs:** P5 outputs (CI exists but covers only manifest/type/build validation); the open research question stated below.
**Outputs:** a new research finding under `~/.claude/plugins/workflow/memory/research/extension-ecosystem-design/` (e.g. `agent-extension-eval-harness.md`) plus an `INDEX.md` update; a returned recommendation on whether to (a) add an eval phase to this engagement, (b) spin a follow-up engagement, or (c) defer with a recorded trigger.
**Verification:** a finding file exists in the topic directory addressing the question with cited sources and a clear pattern recommendation (golden-transcript / LLM-judge / assertion-based, plus where it sits vs `validate.yml`); the topic `INDEX.md` references it. This is the binary check — a human can confirm the file exists and answers the question.
**Unblocks:** any behavioral-eval work. Until this completes, P6 explicitly excludes eval-harness scope.

**Phase prompt:**

> You are `workflow-researcher` running a scoped, domain-neutral research spike. Context you need cold: a greenfield LLM-extension monorepo (Phases P0–P5 complete) has CI (`.github/workflows/validate.yml`) that validates *manifests, types, and builds* but does NOT behaviorally evaluate agent/prompt extensions. A prior live analysis found the surrounding SOX system likewise has no eval harness and no CI running agents (only a relevancy unit test and an MCP smoke test). The `extension-ecosystem-design` research topic at `~/.claude/plugins/workflow/memory/research/extension-ecosystem-design/` has NO finding on eval harnesses, and the adjacent `verification-granularity` topic covers plan-decomposition verification, not extension-behavior evaluation. You are NOT to invent a best practice ungrounded — research and cite.
>
> Your task: answer this question and persist a finding: *"What is the minimal CI eval-harness pattern for behavioral regression testing of LLM agent/prompt extensions in a monorepo — golden-transcript fixtures vs LLM-judge vs assertion-based — and where does it sit relative to manifest/build validation?"* (1) Research the three candidate patterns with real-world sources (e.g. promptfoo, OpenAI Evals, LangSmith, Braintrust, Inspect, assertion harnesses) — cite each. (2) Recommend a minimal pattern (or a tiered combination) appropriate for a per-extension monorepo where each extension is independently versioned, stating cost, determinism, and false-positive trade-offs. (3) Locate it relative to the existing `validate.yml` (does it gate releases? run nightly? run per-PR on changed extensions only?). (4) Recommend one of: (a) add a concrete eval phase to the sox-ecosystem engagement, (b) spin a separate engagement, (c) defer with a recorded trigger. Write the finding to `~/.claude/plugins/workflow/memory/research/extension-ecosystem-design/agent-extension-eval-harness.md` and update that topic's `INDEX.md`.
>
> Skills/tools you need: web research (WebFetch/WebSearch), `workflow-memory` skill for the finding format. Files to read first: `.workflow/plans/sox-ecosystem/migration.md` Section 0 (D4) and Section 3 P5.5; the topic `INDEX.md`.
> Success criteria: a finding file exists at the path above with ≥3 cited sources, a clear pattern recommendation, its placement relative to `validate.yml`, and an (a)/(b)/(c) disposition; the topic `INDEX.md` references it. NO code is written; NO CI is modified.
> Hard constraints: do NOT fabricate a pattern without citation; do NOT write eval-harness implementation code; do NOT modify `validate.yml` or any repo source; this phase is research-and-persist only; do NOT modify the live global SOX install beyond the write-gated memory path you are permitted to write.
>
> **Mandatory completion step.** Before exiting, append one line to `.workflow/plans/sox-ecosystem/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P5.5 complete (executor: workflow-researcher)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`. *On the final phase, set `state: complete` instead of `executing`.* (P5.5 is not the final phase.)

### Phase 6 — End-to-end verification + optional registry server

**Phase ID:** P6
**Closes:** engagement completion; Gap 3 decision (registry HTTP server defer-or-build). Behavioral eval is IN SCOPE only if P5.5 disposition (a) was chosen AND its finding exists.
**Phase goal:** All five MVP use cases pass end-to-end on a clean environment; the optional two-endpoint registry server is either built spec-compatibly or explicitly deferred with a recorded decision; any eval-harness addition is governed strictly by the P5.5 finding.
**Inputs:** P0–P5 outputs; the P5.5 research finding (if it landed).
**Outputs:** a verification report mapping each acceptance command to UC-1..UC-5; optionally `scripts/registry-server.ts` (Gap 3); a recorded note on eval-harness disposition; final status transition to `complete`.
**Verification:** each of UC-1..UC-5 runs to its documented success state from a clean checkout; if the registry server is built, `GET /:id/versions` and `GET /:id/:version/download` return the Terraform-shaped responses over `registry/index.json`; if any eval-harness step is added, it cites the P5.5 finding by path.
**Unblocks:** engagement completion.

**Phase prompt:**

> You are a verification/QA engineer closing out a greenfield LLM-extension monorepo. Phases P0–P5 are complete: all six extension types, multi-scope install, providers, registry publish, and CI exist. A research spike (P5.5) may have produced an eval-harness finding at `~/.claude/plugins/workflow/memory/research/extension-ecosystem-design/agent-extension-eval-harness.md`. Read `.workflow/plans/sox-ecosystem/migration.md` Section 3 (the five MVP use cases referenced as UC-1..UC-5, defined in `build-vs-reuse-and-build-plan.md` Part 3), Section 0 (D4 eval-harness gate), and the Gap 3 resolution in Section 5 before acting.
>
> Your task: (1) From a clean checkout, execute each MVP use case end-to-end and record pass/fail with the exact command and observed result: UC-1 scaffold→edit→project-install in <5 min; UC-2 provider swap via config with no code change; UC-3 publish→clean-machine install with checksum verify; UC-4 project-scope config override (deep-merge, narrowest wins); UC-5 duplicate-ID blocked at CI. (2) Resolve Gap 3: the flat git `index.json` is the registry until ~5k entries; DECIDE to either (a) build `scripts/registry-server.ts` (~150 LOC) implementing the two Terraform-shaped endpoints `GET /:id/versions` and `GET /:id/:version/download` (redirect to the npm-CDN `source`) over `registry/index.json`, keeping it spec-compatible — OR (b) explicitly defer it, recording the entry-count trigger (~5k) that would justify building it. Default per the plan is DEFER; build only if the executor observes a queryability/scale need. (3) EVAL-HARNESS GATE: check whether the P5.5 finding exists AND recommended disposition (a) "add an eval phase to this engagement." ONLY in that case, and following the finding's recommended pattern exactly, may you add a behavioral-eval step; if the finding is absent or recommended (b)/(c), do NOT add any eval-harness code — record that it is deferred to its follow-up. (4) Produce a verification report (returned as your message, not a new committed file) mapping each acceptance check to its use case and stating the eval-harness disposition.
>
> Skills/tools you need: the full install/publish toolchain from prior phases; any minimal HTTP framework if building the server. Files to read first: migration.md Section 3 + Section 0 (D4) + Section 5 Gap 3; `build-vs-reuse-and-build-plan.md` Part 3 for the canonical UC definitions; the P5.5 finding if present.
> Success criteria: all five use cases reach their documented success state from a clean environment; the Gap 3 decision is recorded (built-and-spec-compatible OR deferred-with-trigger); the eval-harness disposition is recorded and any added eval step cites the P5.5 finding by path; no eval code added if P5.5 is absent or recommended defer.
> Hard constraints: do not weaken any prior acceptance check to make a use case pass; the registry server (if built) must be a metadata layer only — downloads redirect to npm/CDN, never serve artifacts directly; do NOT add an eval harness ungrounded in the P5.5 finding; do NOT touch the live global SOX install; this is the FINAL phase.
>
> **Mandatory completion step.** Before exiting, append one line to `.workflow/plans/sox-ecosystem/status.md` under `## State transitions`:
> `<ISO timestamp> complete — phase P6 complete (executor: <your role>)`
> Update frontmatter: `state: complete`, `last_event: <ISO timestamp>`. *(This is the final phase: set `state: complete`, not `executing`.)*

---

## Section 4 — Interface contracts

Contracts specify signature, inputs, outputs, error modes, and side effects — not implementation. Carried forward from v1; the live analysis required no contract change (the dedup-lint contract 4.5 now explicitly names the shadow-copy invariant the live `sox-active` finding exercises).

### 4.1 Install client — `scripts/install.ts`

- **Signature:** `install({ scope: 'org'|'user'|'project'|'local', mode: 'default'|'frozen'|'update' }) → Promise<ResolvedSet>`. CLI: `install-extensions --scope=<s> [--frozen-lockfile] [--update]`.
- **Inputs:** the named scope's `extensions.json` (and, transitively, narrower scopes + the `extends` org baseline); the existing per-scope lockfile if present; OS env for `${ENV}` resolution.
- **Outputs:** a per-scope lockfile (`extensions.lock`) `{ lockfileVersion, extends?, resolved }`; the in-memory `ResolvedSet` (`{ id → { version, enabled, config, source, checksum } }`); fetched artifacts on disk.
- **Behavior:** resolve scope chain → cascade-merge (Section 4.2) → for each enabled extension resolve a version against `registry/index.json` (or `workspace:*`/`file://`) → fetch from `source` → verify sha256 → write lockfile. `--frozen-lockfile`: refuse to re-resolve; install exactly the lockfile or fail. `--update`: re-resolve and rewrite the lockfile (the only mode allowed to overwrite a mismatched `extends` hash, per Gap 4).
- **Error modes:** checksum mismatch → non-zero exit, structured error naming the id+source; `extends` hash divergence without `--update` → fail closed; literal secret in a committed config → reject; unknown `type` or type/dir mismatch → reject; capability hard-block under `strict_capabilities` → non-zero (P3 / Gap 5).
- **Side effects:** writes lockfile + artifacts; network fetches; reads env. Never writes secrets to the lockfile; resolves `${ENV}` at runtime only.

### 4.2 Cascade-merge resolver — `scripts/cascade.ts`

- **Signature:** `cascade(scopes: ScopeConfig[]) → ResolvedConfigMap` where `scopes` is ordered widest→narrowest `[org, user, project, local]`.
- **Inputs:** each scope's parsed `extensions.json` (org baseline already fetched).
- **Outputs:** flat `{ id → { version, enabled, config } }`.
- **Merge rules:** **primitives replace** (narrower wins); **objects deep-merge** (narrower keys win on conflict); **arrays replace entirely — NOT concat** (documented; project install list is authoritative); **narrowest scope wins** for `version`; **`enabled`** = narrowest scope that specifies it, and `enabled:false` at a narrower scope force-suppresses a wider `true`.
- **Error modes:** none thrown for normal merges (pure function); duplicate id within a single scope's `install[]` is surfaced to the caller as a diagnostic (lint, not merge, enforces it).
- **Side effects:** none — pure. Source: `multi-scope-install-config-cascade.md` §4,§7.

### 4.3 Registry index builder — `scripts/build-index.ts`

- **Signature:** `buildIndex({ root: string }) → IndexEntry[]` (also writes the file).
- **Inputs:** all `extension.json` under `extensions/`; for published entries, the resolved npm-CDN URL and artifact bytes (to compute sha256).
- **Outputs:** `registry/index.json` — an array of `{ id, type, version, title, description, source, checksum, compatibility }`. `source` points to the npm CDN (or GitHub Release); `checksum` is `sha256:<hex>`.
- **Error modes:** an `extension.json` failing `schemas/extension/v1.json` aborts with the offending path; a `private:true` extension is excluded (not an error).
- **Side effects:** writes `registry/index.json`; may fetch published artifacts to checksum them. Runs post-publish in CI. Source: reference-architecture §4,§6.

### 4.4 Scaffold generator — `scripts/new-extension.ts`

- **Signature:** interactive CLI `new-extension` (or `new-extension({ type, id, title, description })` non-interactive).
- **Inputs:** `type` (closed enum, six values), `id` (validated `^[a-z][a-z0-9-]*$`, not ending in the type name), `title`, `description`.
- **Outputs:** `extensions/<type>/<id>/` with exactly **4 files**: `extension.json` (minimal required fields from the type template), `package.json` (`@scope/extension-<id>`, `version: 0.1.0`, `main: dist/index.js`), the content file (`prompt.md` for `prompt`, else `src/index.ts` with a type-specific working stub), and empty `CHANGELOG.md`.
- **Type stubs:** agent `{name,description,systemPrompt,tools[]}`; skill `(input)=>output` + input JSON Schema; mcp-server stdio init + one stub tool; prompt `prompt.md` frontmatter + template body; hook `{event,handler}` + `order`; command deterministic shell op, slash-invoked.
- **Error modes:** invalid id format → abort before writing; existing directory → abort (no overwrite).
- **Side effects:** creates a directory + 4 files; does NOT modify `pnpm-workspace.yaml` (glob auto-discovers); no network; zero external scaffold deps. Source: reference-architecture §5; `scaffold-first-authoring`.

### 4.5 Dedup lint — `scripts/validate-manifests.ts`

- **Signature:** `validateManifests({ root }) → { ok: boolean, errors: Diagnostic[] }`; CLI exits 0/1.
- **Inputs:** all `extension.json` under `extensions/`; `registry/index.json`; every scope's `extensions.json` install lists; committed config files.
- **Checks (all must pass):** (1) **three uniqueness invariants** — unique id per registry; ≤1 entry per id in any single scope's `install[]`; **no shadow copies** (same id MUST NOT exist as two separately-versioned installables, e.g. both a registry/npm source and a `file://` source — this is exactly the live `sox-active`/`sox-cto-system` 5-agent failure mode, `analysis.md` §1.3). (2) **id format** `^[a-z][a-z0-9-]*$` and id must not end with its type name. (3) **type/dir match** — `type` equals the singular of the parent directory. (4) **version sync** — `extension.json.version` == `package.json.version`. (5) **cross-scope dup** — warn when the same id appears in a committed install list and a local path. (6) **secret-in-config regex** — block committed `extensions.json` whose config values are literal API-key-shaped strings instead of `${ENV}` refs.
- **Error modes:** any failed check → non-zero exit with an actionable, structured message (e.g. the UC-5 duplicate-ID error).
- **Side effects:** none — read-only. Runs in `validate.yml`. Source: `single-source-identity-dedup.md` §3,§4; `multi-scope-install-config-cascade.md` §4.

---

## Section 5 — Resolution of the 5 open gaps

Each gap is DECIDED. The live analysis ratified every v1 decision; **no override**. suggestions.md defaults are adopted unless an override is stated (none is). No gap is deferred-as-undecided (Gap 3's "defer" is itself a decision with a trigger).

> **Live follow-up (NOT in this build) — 5-agent shadow copy.** The live `sox-active` v1.0.20 re-vendors 5 agents (`cto-agent`, `janitor-agent`, `workflow-analyst`, `workflow-implementer`, `planner`) also shipped by `sox-cto-system` v2.0.23 (`analysis.md` §1.3; `suggestions.md` #6). In THIS greenfield repo the P2 dedup lint structurally prevents that class. De-duplicating the *live running SOX system* (designate `sox-cto-system` as owner; have `sox-active` depend rather than copy) is a separate, larger change gated by the meta-loop self-modification recursion guard (`analysis.md` §1.5) — it is explicitly OUT OF SCOPE for this engagement and is flagged to the founder, not executed here.

### Gap 1 — MCPB (`.mcpb`) vs generic npm+registry install path
**Decision (adopt suggestions default):** npm + git `registry/index.json` is the **primary, language-neutral install path** covering all six types — directly replacing the live local-file `marketplace.json` (`analysis.md` §4 DIVERGENT #4). `.mcpb` is an **optional export/packaging target**, not the core install path: `scripts/pack-mcpb.ts` (Phase 5+, optional) emits a `.mcpb` bundle from an already-built extension for Claude-Code-native consumers.
**Trade-off:** Coupling core install semantics to one host's bundle format would break language-neutrality (Python agents alongside TS MCP servers) and the two-tier discovery/distribution split. Cost of the chosen path: Claude-Code-native users need the extra `pack-mcpb` step instead of a first-class bundle. Accepted — the export is cheap and additive. `Conjecture:` `.mcpb` internals per the suggestions stance; not settled by a primary finding.

### Gap 2 — Hook execution ordering on the same lifecycle event
**Decision (adopt suggestions default):** Deterministic order via an explicit integer `order` field in the hook's `extension.json` (default 100); the host resolver sorts hooks bound to the same event ascending by `order`, breaking ties by `id` lexicographic. `order` is hook-only in the schema (Section 1.2). This replaces the live system's implicit array-position ordering of its 9 global hooks (`analysis.md` §4 DIVERGENT #6).
**Trade-off:** An explicit integer is simpler and more predictable than a topological dependency graph, but it is an escape hatch, not a dependency mechanism — authors must keep hooks order-independent where possible (documented in the P5 prompt). A pure dependency DAG would be more expressive but adds resolution complexity unjustified at this scale. Source: `extension-type-taxonomy.md` (hooks fire unconditionally) + suggestions #7 (`Conjecture:` on the exact tie-break).

### Gap 3 — Registry HTTP server (Terraform two-endpoint model)
**Decision (adopt suggestions default — validate-but-defer):** The flat git `registry/index.json` IS the registry until ~5k entries (`registry-as-protocol-not-product.md` §5: git-repo registries don't scale past ~10k; queryability is the trigger). **Validate** the Terraform two-endpoint shape (`GET /:id/versions`, `GET /:id/:version/download` redirecting to the npm-CDN source) and keep it spec-compatible, but **defer building `scripts/registry-server.ts` to Phase 6+/optional** — build only when entry count or queryability demands it.
**Trade-off:** Deferring avoids running and securing an HTTP service for an ecosystem that a static file serves perfectly; the cost is that large-scale search requires a full index clone until the server is built. Spec-compatibility keeps it a drop-in later. Recorded trigger: ~5k entries. Source: `registry-as-protocol-not-product.md` §2,§5.

### Gap 4 — Org-baseline `extends` URL pinned by content hash
**Decision (adopt suggestions default):** Pin the org baseline by content hash in the per-scope lockfile: `extends: { url, sha256, resolved_at }` (Section 1.4). On install, the fetched baseline's sha256 MUST match the lockfile; on divergence the install **fails closed** unless `--update` is passed (which re-resolves and rewrites the pin).
**Fail-closed behavior (exact):** `install.ts` computes sha256 of the fetched `extends` body; if a lockfile `extends.sha256` exists and differs and `mode != 'update'` → abort non-zero with `ERROR: org baseline at <url> changed (lock <old> vs fetched <new>); re-run with --update to accept`. If no prior pin exists, record it. This reuses the same checksum machinery as artifact verification.
**Trade-off:** Fail-closed prevents a silently mutated org baseline from changing every project's resolved config (supply-chain integrity), at the cost of an explicit `--update` step when the org legitimately revises the baseline. Accepted — matches the MED supply-chain risk in suggestions. Source: suggestions #5 (supply-chain) + `multi-scope-install-config-cascade.md` §5.

### Gap 5 — Capability check: advisory-warn vs hard-block
**Decision (adopt suggestions default):** **Advisory-warn by default, hard-block opt-in.** The capability checker (P3) warns loudly at install time on a `requires.*` mismatch and exits 0; a scope-level `strict_capabilities: true` (Section 1.3) escalates the mismatch to a non-zero hard block.
**Trade-off:** Long-tail local models (Ollama/vLLM) frequently under-report params in static tables; a default hard block would break legitimate setups (the LOW false-negative risk in suggestions). Default-warn keeps those setups working while surfacing the risk; teams that need guarantees opt into `strict_capabilities`. Cost: a genuinely incapable model may pass install with only a warning unless strict mode is enabled. Accepted. Source: suggestions Gap 5 + `multi-llm-provider-abstraction.md` §3,§7.

---

## Section 6 — v2 gap-closure phases (P7+)

Appended by workflow-planner (v2 gap-closure increment). These phases implement the design in
`.workflow/plans/sox-ecosystem/architecture-v2.md`, which closes the five first-tenant gaps G-A..G-E
surfaced by the `sox-memory` tenant (`.workflow/plans/sox-memory/design.md` §8). **P0–P6 are built and
green and are NOT rewritten.** Every change here is additive and back-compatible: every v1 extension
MUST still validate and install unchanged after each phase (the acceptance check enforces this).
Core v2 LOC budget ≈ 175 (see architecture-v2.md §8). Phases are independently acceptable; order is by
dependency where one exists (P9 bundle depends on the enum delta; otherwise independent).

> **Cross-phase hard constraint (applies to every P7+ phase):** do NOT modify the locked v1 merge
> rule in `scripts/cascade.ts` (arrays-replace, lines 11–16). Do NOT change any v1 manifest's
> behavior. Do NOT touch `.workflow/INDEX.md` (the architect owns it). Every new schema field is
> OPTIONAL with a back-compat default. Run `pnpm test` and `pnpm run validate` (validate-manifests)
> after your change and confirm all pre-existing tests still pass.

### Phase 7 — G-D runtime-language contract (smallest, no new type)

**Phase ID:** P7
**Phase goal:** Make the Node/TS-required-for-provider-touching rule explicit and machine-checked via an optional `runtime` field.
**Inputs:** `architecture-v2.md` §G-D; `schemas/extension/v1.json`; `scripts/validate-manifests.ts`; `scripts/new-extension.ts`.
**Outputs:** `schemas/extension/v1.json` (+`runtime` property, +1 `allOf` conditional); `scripts/validate-manifests.ts` (+cross-field check + test); `scripts/new-extension.ts` (default `runtime:"node"` + README note).
**Verification (deterministic):** (a) `pnpm test` green incl. a new test asserting a `stdio-any` manifest with `requires.structured_output:true` FAILS validation and a `stdio-any` manifest with no provider requires PASSES; (b) every existing extension manifest (none declaring `runtime`) still validates (defaults to `node`); (c) all P0–P6 tests still green.

**Phase prompt:**

> You are a TypeScript ecosystem-tooling engineer. A greenfield LLM extension ecosystem repo at `/Users/nix/dev/ai/sox-ecosystem` is built and green through phase P6 (six extension types, install client, cascade, validate-manifests, registry). You are adding ONE optional manifest field to make an implicit runtime rule explicit. Read first, in order: `/Users/nix/dev/ai/sox-ecosystem/.workflow/plans/sox-ecosystem/architecture-v2.md` section "G-D"; `/Users/nix/dev/ai/sox-ecosystem/schemas/extension/v1.json`; `/Users/nix/dev/ai/sox-ecosystem/scripts/validate-manifests.ts`; `/Users/nix/dev/ai/sox-ecosystem/scripts/new-extension.ts`.
>
> Your task: (1) Add the optional `runtime` property to `schemas/extension/v1.json` exactly as specified in architecture-v2.md §G-D (enum `["node","stdio-any"]`, default `"node"`), plus the `allOf` conditional that forces `requires.structured_output` and `requires.tool_calling` to `false` when `runtime=="stdio-any"`. (2) Add to `validate-manifests.ts` a friendly diagnostic mirroring that rule (error severity) with the message from §G-D. (3) Make `new-extension.ts` default `runtime:"node"` in generated manifests and note the rule in the generated README. (4) Add Vitest tests for both the pass and fail cases.
>
> Skills/tools you need: Node fs, ajv (already a dep), Vitest. Files to read first: listed above.
> Success criteria (binary): `pnpm test` passes; a test proves `stdio-any`+provider-requires is rejected and `stdio-any`+no-requires is accepted; all manifests lacking `runtime` still validate; P0–P6 tests unchanged and green.
> Hard constraints: `runtime` MUST be optional with default `"node"` (no v1 manifest may break). Do NOT change `cascade.ts` or `install.ts`. Do NOT touch `.workflow/INDEX.md`. Schema stays v1.
>
> **Mandatory completion step.** Before exiting, append one line to `.workflow/plans/sox-ecosystem/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P7 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`. *(Not the final phase — leave state at `executing`.)*

### Phase 8 — G-A long-running service lifecycle (additive lifecycle block)

**Phase ID:** P8
**Phase goal:** Add an optional `lifecycle{}` block so the host owns supervision/health/singleton for background extensions, with zero change to v1 request/response behavior.
**Inputs:** `architecture-v2.md` §G-A; `schemas/extension/v1.json`; `scripts/validate-manifests.ts`; `.workflow/plans/sox-memory/design.md` §2.4 (the `memoryd` workaround this formalizes).
**Outputs:** `schemas/extension/v1.json` (+`lifecycle` property, +1 `allOf` scoping it to `{mcp-server,agent}`); `scripts/validate-manifests.ts` (+checks: lifecycle ⇒ type∈{mcp-server,agent}; socket/command health ⇒ endpoint required; +tests); a host-loader supervisor sub-contract documented in `architecture-v2.md` §G-A (already written — confirm it matches the schema you ship).
**Verification (deterministic):** (a) `pnpm test` green incl. tests that a `lifecycle` on a `command`-type manifest FAILS, a `lifecycle` on an `mcp-server` PASSES, and `health.type:"socket"` without `endpoint` FAILS; (b) every existing manifest (no `lifecycle`) still validates; (c) `install.ts`/`cascade.ts` are byte-unchanged (grep-confirm no diff); (d) P0–P6 tests green.

**Phase prompt:**

> You are a TypeScript ecosystem-tooling engineer. The repo at `/Users/nix/dev/ai/sox-ecosystem` is built and green through P7. You are adding an OPTIONAL `lifecycle{}` block to the extension manifest so the host (not the extension) supervises long-running background processes — formalizing the lazy-spawned singleton daemon the first tenant (`sox-memory`) ships inside its MCP server. Read first, in order: `/Users/nix/dev/ai/sox-ecosystem/.workflow/plans/sox-ecosystem/architecture-v2.md` section "G-A"; `/Users/nix/dev/ai/sox-ecosystem/schemas/extension/v1.json`; `/Users/nix/dev/ai/sox-ecosystem/scripts/validate-manifests.ts`; `/Users/nix/dev/ai/sox-ecosystem/.workflow/plans/sox-memory/design.md` lines 307–331 (the `memoryd` daemon model).
>
> Your task: (1) Add the `lifecycle` object property to `schemas/extension/v1.json` exactly per architecture-v2.md §G-A (sub-keys `background`, `singleton`, `health{type,endpoint,interval_ms,timeout_ms}`, `stop_timeout_ms`, all with the stated defaults; `additionalProperties:false`). (2) Add the `allOf` conditional restricting `lifecycle` to `type ∈ {mcp-server, agent}`. (3) Add `validate-manifests.ts` diagnostics: lifecycle present ⇒ type in that set; `health.type ∈ {socket,command}` ⇒ `health.endpoint` required. (4) Add Vitest tests for each pass/fail case. Do NOT implement a host supervisor (the loader is a host contract, spec-only in this repo) — the supervisor sub-contract is documented in architecture-v2.md §G-A; just confirm your schema matches it.
>
> Skills/tools you need: Node fs, ajv, Vitest. Files to read first: listed above.
> Success criteria (binary): `pnpm test` passes with the three new fail/pass cases; manifests without `lifecycle` still validate; `git diff --stat` shows NO change to `scripts/install.ts` or `scripts/cascade.ts`; P0–P6 tests green.
> Hard constraints: `lifecycle` MUST be optional (no v1 manifest breaks). Do NOT add a 7th type. Do NOT modify `cascade.ts`/`install.ts`. Do NOT touch `.workflow/INDEX.md`. Schema stays v1.
>
> **Mandatory completion step.** Before exiting, append one line to `.workflow/plans/sox-ecosystem/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P8 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`. *(Not the final phase — leave state at `executing`.)*

### Phase 9 — G-B bundle meta-package primitive (the one new type)

**Phase ID:** P9
**Phase goal:** Add a `bundle` type that expands to install entries at install time, giving atomic, single-versioned add of a multi-extension product WITHOUT changing the arrays-replace cascade rule.
**Inputs:** `architecture-v2.md` §G-B; `schemas/extension/v1.json`; `scripts/install.ts` (`buildInstallList`, lines 652–689; resolution loop ~455–490); `scripts/validate-manifests.ts` (`DIR_TO_TYPE`); `scripts/build-index.ts`; `.workflow/plans/sox-memory/design.md` §1.2 (the four-member memory bundle this enables).
**Outputs:** `schemas/extension/v1.json` (+`bundle` enum member, +`members` property, +`allOf` requiring members & forbidding entrypoint for bundles); `scripts/install.ts` (+post-cascade bundle expansion with cycle guard, +tests); `scripts/validate-manifests.ts` (+`bundles→bundle` in `DIR_TO_TYPE`, +bundle checks, +tests); `scripts/build-index.ts` (+index bundles); a `extensions/bundles/sox-memory-bundle/` example bundle manifest (id+package.json, no entrypoint) used as the install-expansion test fixture.
**Verification (deterministic):** (a) `pnpm test` green incl. a test that installing a config with one `bundle` install entry RESOLVES to its N members (using the example bundle fixture), and a cycle (bundle A members B, B members A) is rejected; (b) `validate-manifests` rejects a bundle with no `members`, a bundle with an `entrypoint`, and a bundle with a duplicate/self member; (c) every existing (non-bundle) manifest validates and installs unchanged; (d) `scripts/cascade.ts` is byte-unchanged (grep/diff-confirm); (e) P0–P6 tests green.

**Phase prompt:**

> You are a TypeScript ecosystem-tooling engineer. The repo at `/Users/nix/dev/ai/sox-ecosystem` is built and green through P8. You are adding the ONLY new extension type of the v2 increment: `bundle` — a named, independently-versioned set of extensions that the install client EXPANDS into its members. The cascade's arrays-replace rule must NOT change; expansion happens AFTER cascade resolution. Read first, in order: `/Users/nix/dev/ai/sox-ecosystem/.workflow/plans/sox-ecosystem/architecture-v2.md` section "G-B" (and §7 model-coherence on why this is the only enum growth); `/Users/nix/dev/ai/sox-ecosystem/schemas/extension/v1.json`; `/Users/nix/dev/ai/sox-ecosystem/scripts/install.ts` (read `buildInstallList` ~652–689 and the resolution loop ~455–490); `/Users/nix/dev/ai/sox-ecosystem/scripts/validate-manifests.ts` (the `DIR_TO_TYPE` map ~70–77); `/Users/nix/dev/ai/sox-ecosystem/scripts/build-index.ts`; `/Users/nix/dev/ai/sox-ecosystem/.workflow/plans/sox-memory/design.md` lines 121–147 (the four-member memory bundle).
>
> Your task: (1) Extend the `type` enum in `schemas/extension/v1.json` with `"bundle"`, add the `members` array property, and add the `allOf` conditional (bundle ⇒ requires `members`, forbids `entrypoint`) exactly per §G-B. (2) In `install.ts`, after cascade resolution and as part of building the install list, expand any resolved id whose manifest has `type:"bundle"` into its `members` (resolve each member against the registry like any id); guard against cycles and depth; member-level explicit install entries override bundle-expanded ones by id (mirror the existing supplement logic). (3) In `validate-manifests.ts`, add `bundles:'bundle'` to `DIR_TO_TYPE` and add bundle checks (non-empty members, no entrypoint, valid member id format, no self-reference, no duplicate member ids). (4) In `build-index.ts`, include `bundles/` in the dir scan so bundles are indexed. (5) Create an example `extensions/bundles/sox-memory-bundle/extension.json` (+ `package.json`, no entrypoint, no behavior tests) listing the four memory members, used as the expansion test fixture. (6) Add Vitest tests for expansion, cycle rejection, and each validate check.
>
> Skills/tools you need: Node fs/crypto, ajv, Vitest. Files to read first: listed above.
> Success criteria (binary): `pnpm test` passes incl. expansion + cycle-rejection + bundle-validation tests; a non-bundle manifest still installs/validates unchanged; `git diff --stat` shows NO change to `scripts/cascade.ts`; the example bundle expands to exactly its four members in the install test; P0–P6 tests green.
> Hard constraints: do NOT change the arrays-replace rule in `cascade.ts` (cite this constraint in a code comment near the expansion). A bundle MUST NOT have an entrypoint or reach the host loader. Expansion is install-time-only and cycle-guarded. Do NOT touch `.workflow/INDEX.md`. Schema stays v1 (enum growth is additive).
>
> **Mandatory completion step.** Before exiting, append one line to `.workflow/plans/sox-ecosystem/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P9 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`. *(Not the final phase — leave state at `executing`.)*

### Phase 10 — G-C scope-promotion pattern + generic host event, and G-E requires-granularity advisory

**Phase ID:** P10
**Phase goal:** Land the two documentation-plus-advisory gaps: a generic `ScopePromotionProposed` host-event spec + `config.promotion` convention (G-C, no schema change), and a redundancy advisory for per-extension `requires` (G-E).
**Inputs:** `architecture-v2.md` §G-C and §G-E; `scripts/validate-manifests.ts`; `schemas/extensions-config/v1.json` (confirm `config` is already open — no change needed).
**Outputs:** `scripts/validate-manifests.ts` (+G-E `warn`-severity advisory when an extension's `requires` deep-equals a dependency's `requires`, +test asserting it is `warn` not `error`); a documented `ScopePromotionProposed` event + `config.promotion` convention + the "per-identity partitioning is not a 5th scope" rule written into a new `docs/scope-promotion.md` (or appended to architecture-v2.md if no docs dir) — documentation only, no schema/cascade/install change.
**Verification (deterministic):** (a) `pnpm test` green incl. a test that the G-E advisory is emitted as severity `warn` (CI-non-blocking) for a manifest whose `requires` matches its dependency's, and that validate-manifests still exits 0 in that case; (b) NO schema file changed (grep/diff-confirm `schemas/` unchanged); (c) `cascade.ts` and `install.ts` byte-unchanged; (d) the promotion doc exists and states the approval-locus rule (to_scope owner approves; org may auto-approve) and the per-identity-not-a-5th-scope rule; (e) P0–P9 tests green.

**Phase prompt:**

> You are a TypeScript ecosystem-tooling engineer and technical writer. The repo at `/Users/nix/dev/ai/sox-ecosystem` is built and green through P9. You are landing two LOW-footprint gap closures that are mostly documentation + one advisory lint — NO schema, cascade, or install behavior change. Read first, in order: `/Users/nix/dev/ai/sox-ecosystem/.workflow/plans/sox-ecosystem/architecture-v2.md` sections "G-C" and "G-E"; `/Users/nix/dev/ai/sox-ecosystem/scripts/validate-manifests.ts`; `/Users/nix/dev/ai/sox-ecosystem/schemas/extensions-config/v1.json` (confirm `config` is already `additionalProperties:object` — it is; do NOT add a `promotion` schema property).
>
> Your task: (1) G-E: add to `validate-manifests.ts` a `warn`-severity advisory that fires when an extension X with `dependencies:[D]` has `requires` deep-equal to D's `requires`, using the message in §G-E. It MUST be `warn` (never `error`) so it does not block CI. Add a Vitest test asserting the warn is emitted AND `validateManifests` still reports `ok:true`. (2) G-C: write `docs/scope-promotion.md` (create `docs/` if absent) documenting, per §G-C: the generic `ScopePromotionProposed` host event (payload + contract + that the host exposes `proposePromotion(...)` and a default enqueue/log handler), the `config.promotion` convention shape (NOT a schema field), the approval-locus rule (to_scope owner approves; org baseline may auto-approve via a bound hook; default human-in-the-loop), and the rule that per-identity (agent/user) data partitioning is a tenant concern and NOT a 5th install scope. Do NOT implement a host event bus (the loader is a host contract); this is a spec/doc + the lint only.
>
> Skills/tools you need: Node fs, Vitest, Markdown. Files to read first: listed above.
> Success criteria (binary): `pnpm test` passes incl. the G-E warn-not-error test (validate still exits 0); `git diff --stat` shows NO change under `schemas/`, and none to `cascade.ts`/`install.ts`; `docs/scope-promotion.md` exists and contains the approval-locus rule and the per-identity-not-a-scope rule; P0–P9 tests green.
> Hard constraints: G-E must be `warn`, never `error`. Do NOT add a `promotion` property to any schema. Do NOT change `cascade.ts`/`install.ts`. Do NOT touch `.workflow/INDEX.md`.
>
> **Mandatory completion step.** Before exiting, append one line to `.workflow/plans/sox-ecosystem/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P10 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`. *(Not the final phase — leave state at `executing`.)*

### Phase 11 — v2 end-to-end verification (closing phase)

**Phase ID:** P11
**Phase goal:** Prove the whole v2 increment is coherent and back-compatible: all five gaps closed, all v1 extensions still validate/install unchanged, full suite green.
**Inputs:** all of P7–P10 outputs; `architecture-v2.md` (the whole design); the v1 P6 end-to-end test from `migration.md` Section 3 Phase 6.
**Outputs:** a v2 end-to-end test (`scripts/__tests__/v2-e2e` or equivalent) that installs the `sox-memory-bundle`, asserts it expands to four members, asserts a `lifecycle`-bearing mcp-server validates, asserts a `runtime:"stdio-any"` provider-caller is rejected, and asserts the G-E advisory is a warn; a short conformance note appended to `architecture-v2.md` confirming each of G-A..G-E is implemented as designed.
**Verification (deterministic):** (a) `pnpm test` fully green (P0–P11); (b) `pnpm run validate` (validate-manifests) exits 0 across the whole `extensions/` tree including the example bundle; (c) the v2-e2e test passes all five gap assertions; (d) running the v1 P6 end-to-end flow still passes unchanged (back-compat proof).

**Phase prompt:**

> You are a TypeScript verification engineer. The repo at `/Users/nix/dev/ai/sox-ecosystem` has had phases P7–P10 land the v2 gap-closure (runtime field, lifecycle block, bundle type, promotion docs + requires advisory). Your job is the FINAL phase: prove the increment is coherent and fully back-compatible. Read first, in order: `/Users/nix/dev/ai/sox-ecosystem/.workflow/plans/sox-ecosystem/architecture-v2.md` (entire); `/Users/nix/dev/ai/sox-ecosystem/.workflow/plans/sox-ecosystem/migration.md` Section 3 Phase 6 (the v1 end-to-end definition); the test files added in P7–P10.
>
> Your task: (1) Write a v2 end-to-end test that, against the example `sox-memory-bundle`, asserts: installing the bundle resolves to exactly its four members; an mcp-server manifest carrying `lifecycle.background:true` validates; a manifest with `runtime:"stdio-any"` + `requires.structured_output:true` is REJECTED; the G-E redundancy advisory is emitted as `warn` and validate still exits 0. (2) Re-run the v1 P6 end-to-end flow and confirm it still passes unchanged (back-compat proof). (3) Append a short "v2 conformance" note to `architecture-v2.md` confirming G-A..G-E are each implemented as designed, citing the test names.
>
> Skills/tools you need: the full install/validate toolchain from P0–P10, Vitest. Files to read first: listed above.
> Success criteria (binary): `pnpm test` fully green (P0–P11); `pnpm run validate` exits 0 across the whole tree incl. the bundle; the v2-e2e test passes all five gap assertions; the v1 P6 flow passes unchanged.
> Hard constraints: do NOT modify P0–P10 implementation to make tests pass — if a test reveals a defect, fix the defect and note it. Do NOT change `cascade.ts`'s arrays-replace rule. Do NOT touch `.workflow/INDEX.md`. This is the FINAL phase.
>
> **Mandatory completion step.** Before exiting, append one line to `.workflow/plans/sox-ecosystem/status.md` under `## State transitions`:
> `<ISO timestamp> complete — phase P11 complete (executor: <your role>)`
> Update frontmatter: `state: complete`, `last_event: <ISO timestamp>`. *(This IS the final phase — set `state: complete`.)*

---

## Changelog

- 2026-06-07 — **workflow-planner v2 gap-closure** wrote `architecture-v2.md` (full design closing G-A..G-E) and appended Section 6 (phases P7–P11) implementing it. Decisions: G-A additive `lifecycle{}` block (rejected 7th `service` type); G-B new `bundle` type expanded post-cascade (rejected append merge-mode, arrays-replace preserved); G-C documented pattern + generic `ScopePromotionProposed` event + `config.promotion` convention (rejected first-class cascade promotion); G-D optional `runtime` field + targeted lint (rejected doc-only and universal-Node); G-E per-extension `requires` + redundancy `warn` advisory (rejected keystone aggregation). v2 core ≈ 175 LOC additive on top of v1's ~730. Bent invariants: G-B grows the type enum (6→7) and introduces a two-level version pin — the only deliberate model changes; all else strictly additive. P0–P6 unchanged.
- 2026-06-07 — **workflow-planner v2** reconciled the plan with the LIVE `workflow-analyzer` run (`analysis.md`) and `workflow-optimizer` ranked suggestions (`suggestions.md`). Changes (Section 0): D1 reframed the build as *partly a migration* of the proven `plugin.json`/`installed_plugins.json` scope system (analysis §4 ALIGNED 1–3); D2 tagged every phase with the `analysis.md` §4 divergence + `suggestions.md` rank it closes; D3 added the live-only 5-agent shadow-copy finding as an explicit P2 dedup fixture + an out-of-scope live-cleanup note; D4 inserted **P5.5**, a `workflow-researcher` eval-harness research gate (no finding exists in memory; no harness is designed here), and gated any P6 eval work on it; D5 confirmed **zero overrides** of v1's Section-5 gap calls or Section-2 budget — the live analysis only *strengthened* them. Phase count 7 → **8** (added P5.5). Core glue budget unchanged at 730 LOC (~1010 incl. optional `registry-server.ts` + `pack-mcpb.ts`); any eval-harness LOC is OUTSIDE this budget pending P5.5. canonical_roi = qualitative-only.
- 2026-06-07 — (v1) workflow-planner created migration.md from the agreed `extension-ecosystem-design` research. 7 phases (P0–P6). All 5 gaps resolved. Backed up at `migration.v1.md`.
