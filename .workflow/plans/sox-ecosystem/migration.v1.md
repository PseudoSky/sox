# Migration plan: greenfield LLM extension ecosystem monorepo

## Intro

- **Goal:** Build a greenfield monorepo that hosts six LLM-extension types (agent, skill, mcp-server, prompt, hook, command), each independently versioned (Changesets), separately installable across org/user/project/local scopes with a config cascade, provider-agnostic (LiteLLM / Vercel AI SDK / OpenAI-compat), and authored via a one-command scaffold that emits exactly 4 files per extension. Distribution is two-tier: a git `registry/index.json` for discovery plus npm/CDN for artifacts.
- **ROI:** Qualitative only (greenfield — no baseline metric). Primary value: ~1010 LOC of owned glue replaces what would otherwise be a bespoke 5–10k LOC platform; all heavy lifting (versioning, publish, schema validation, provider routing, monorepo task graph) is delegated to battle-tested tools. Secondary, measurable once live: time-to-author a new extension target < 5 minutes (UC-1); provider swap requires 0 code changes (UC-2). `Conjecture:` LOC-saved figure is an estimate, not a measured value.
- **Phases:** 7 (P0 skeleton → P6 verification). Maps onto research Phases 0–5 with verification split out as its own resumable milestone.
- **Current status:** not started

---

## Section 1 — Concrete repo architecture

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

Notes: `type` is a **closed enum incl. `command`**. `compatibility.host` is a semver **range** (not an integer), per `version-declaration-and-negotiation` cited in reference-architecture §2. `requires` block carries capability flags per `multi-llm-provider-abstraction.md` §3. `order` is hook-only (Gap 2). `checksum` is `sha256:`-prefixed.

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

JSON Schema: `lockfileVersion` (const 1), `extends` is an optional object `{ url:uri, sha256:^sha256:[0-9a-f]{64}$, resolved_at:date-time }`, `resolved` is an object whose keys match `^[a-z][a-z0-9-]*@\d+\.\d+\.\d+...$` and whose values are `{ source:string, checksum:sha256-pattern, resolved_at:date-time }`. Lockfiles are never merged across scopes. Source: `multi-scope-install-config-cascade.md` §5; `extends` pin per suggestions.md Gap 4.

---

## Section 2 — Build-vs-reuse LOCKED per component

Versions are research-current as of 2026-06. Where a precise patch is unknowable from the findings, the version family is given and marked `Conjecture:`.

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

Core (always-built) glue lands at **730 LOC**; the two optional/deferred modules bring the budget to **~1010 LOC**, matching the build-vs-reuse matrix. Source: `build-vs-reuse-and-build-plan.md` Part 1 (~1010 total; per-module estimates as listed there + suggestions.md).

---

## Section 3 — Phased, resumable implementation plan

Each phase is standalone: a fresh executor can resume from its prompt alone. Acceptance checks are deterministic (exact command + expected result). UC-N refer to the 5 MVP use cases in `build-vs-reuse-and-build-plan.md` Part 3.

### Phase 0 — Repo skeleton + scaffold + manifest schema

**Phase ID:** P0
**Phase goal:** An empty monorepo with all tooling wired, the `extension.json` schema authored, the scaffold generator working, and a `hello-world` skill that builds and lints clean.
**Inputs:** empty repo; this plan's Sections 1.2 and 2.
**Outputs:** `pnpm-workspace.yaml`, root `package.json`, `tsconfig.base.json`, `.changeset/config.json` (`fixed: []`), `schemas/extension/v1.json`, `scripts/new-extension.ts`, `scripts/validate-manifests.ts` (id-format + type/dir checks only), `extensions/skills/hello-world/` (4 files).
**Verification:** `pnpm changeset status` exits 0; `pnpm typecheck` exits 0; `pnpm run validate-manifests` exits 0.
**Unblocks:** UC-1 (scaffold half).

**Phase prompt:**

> You are a TypeScript build/tooling engineer. You are bootstrapping a greenfield monorepo that will host six LLM-extension types (agent, skill, mcp-server, prompt, hook, command). Nothing exists yet. The authoritative architecture is in `.workflow/plans/sox-ecosystem/migration.md` Sections 1.1, 1.2, and 2 — read them first; do not re-derive the design.
>
> Your task: create the repo skeleton. (1) `git init`; `pnpm init`; `pnpm-workspace.yaml` with `packages: ['extensions/*/*']`. (2) Root `package.json` with devDeps pinned to exact versions per migration.md Section 2 "Reuse" table — resolve every `Conjecture:`-marked family to an exact patch now and record the resolved versions in a comment. (3) `tsconfig.base.json` strict mode. (4) `pnpm changeset init`, then set `.changeset/config.json` to `{ "access": "public", "baseBranch": "main", "fixed": [] }`. (5) Author `schemas/extension/v1.json` exactly as in migration.md Section 1.2 (closed type enum incl. `command`; `compatibility.host` semver range; `requires`; hook-only `order`; `sha256:`-prefixed `checksum`). (6) Write `scripts/new-extension.ts` (~120 LOC, Node `fs`+`readline`, zero external scaffold deps) that prompts for type/id/title/description and writes the 4 files for the chosen type — prompts use `prompt.md`, all others `src/index.ts`. (7) Write `scripts/validate-manifests.ts` with ONLY the id-format (`^[a-z][a-z0-9-]*$`), id-not-ending-in-type-name, and type/parent-directory-match checks for now (dedup comes in P2). (8) Run `new-extension.ts` to generate `extensions/skills/hello-world/`.
>
> Skills/tools you need: pnpm, Changesets CLI, TypeScript, ajv. Files to read first: `.workflow/plans/sox-ecosystem/migration.md` Sections 1.1, 1.2, 2.
> Success criteria (all must hold): `pnpm changeset status` exits 0; `pnpm typecheck` exits 0; `pnpm run validate-manifests` exits 0; `extensions/skills/hello-world/` contains exactly 4 files.
> Hard constraints: exactly 4 files per extension; no per-extension tsconfig/eslint/test config; do NOT modify `pnpm-workspace.yaml` after creation (the glob auto-discovers); do NOT add Yeoman/Plop. The `type` enum is closed — six values only.
>
> **Mandatory completion step.** Before exiting, append one line to `.workflow/plans/sox-ecosystem/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P0 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`.

### Phase 1 — First installable extension (single scope)

**Phase ID:** P1
**Phase goal:** A user-scope `extensions.json` installs `hello-world`, producing a deterministic lockfile; the host loads and activates the skill.
**Inputs:** P0 outputs.
**Outputs:** `scripts/install.ts` (single-scope, no cascade), `scripts/build-index.ts`, `schemas/lockfile/v1.json`, a user-scope `extensions.json` pointing at the local `hello-world` path, generated `~/.config/extensions/extensions.lock`.
**Verification:** from a fresh checkout, `pnpm run install-extensions --scope=user` writes a lockfile; a second run with `--frozen-lockfile` produces byte-identical lock and exits 0.
**Unblocks:** UC-1 (install half).

**Phase prompt:**

> You are a TypeScript systems engineer. A monorepo skeleton for an LLM-extension ecosystem already exists (Phase P0 complete): `extensions/skills/hello-world/` builds, `schemas/extension/v1.json` and `scripts/new-extension.ts` exist. Read `.workflow/plans/sox-ecosystem/migration.md` Sections 1.4 (lockfile schema), 4.1 (install client contract), 4.3 (build-index contract) before writing code.
>
> Your task: make the first extension installable. (1) Write `schemas/lockfile/v1.json` per migration.md Section 1.4 (incl. the `extends` content-hash slot, even though unused this phase). (2) Write `scripts/build-index.ts` (~80 LOC) per the Section 4.3 contract: read every `extension.json` under `extensions/`, emit `registry/index.json` with `{id,type,version,title,description,source,checksum,compatibility}`. (3) Write `scripts/install.ts` (~300 LOC target across phases; this phase implements SINGLE scope only — no cascade) per the Section 4.1 contract: read a scope's `extensions.json`, resolve each `install[]` entry (local file path or `source` URL), verify sha256 checksum, write the per-scope lockfile. Implement `--scope=<org|user|project|local>`, `--frozen-lockfile`, and `--update` flags; this phase only needs `--scope=user` and `--frozen-lockfile` to fully work. (4) Create a user-scope `~/.config/extensions/extensions.json` with one `install` entry for `hello-world` using a `file://` source.
>
> Skills/tools you need: Node `fetch`, `node:crypto` (sha256), ajv. Files to read first: migration.md Sections 1.4, 4.1, 4.3.
> Success criteria: `pnpm run install-extensions --scope=user` writes `~/.config/extensions/extensions.lock` validating against `schemas/lockfile/v1.json`; re-running with `--frozen-lockfile` exits 0 and leaves the lockfile byte-identical; a deliberately corrupted artifact (altered bytes) causes a non-zero exit with a checksum-mismatch message.
> Hard constraints: never merge lockfiles across scopes; resolve `${ENV}` references at runtime only, never at parse time; `--frozen-lockfile` must refuse to re-resolve.
>
> **Mandatory completion step.** Before exiting, append one line to `.workflow/plans/sox-ecosystem/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P1 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`.

### Phase 2 — Multi-scope install + config cascade + dedup/secret lint

**Phase ID:** P2
**Phase goal:** org→user→project→local cascade resolves correctly; `enabled:false` at a narrower scope suppresses a globally enabled extension; dedup and secret-in-config lint fire in CI.
**Inputs:** P1 outputs.
**Outputs:** `scripts/cascade.ts`; extended `scripts/install.ts` (full 4-scope load + `extends` fetch with sha256 pin); extended `scripts/validate-manifests.ts` (three uniqueness invariants + cross-scope dup + secret regex); `.gitignore` adds `.extensions/extensions.local.json`.
**Verification:** an integration test asserting a three-scope cascade produces the expected flat resolved-config map; a duplicate-ID fixture makes `validate-manifests` exit non-zero; a committed-secret fixture makes it exit non-zero.
**Unblocks:** UC-4 (config override), UC-5 (dedup), and Gap 4 (`extends` pin).

**Phase prompt:**

> You are a TypeScript systems engineer. The install client exists for a single scope (Phases P0–P1 complete): `scripts/install.ts` resolves one scope and writes a per-scope lockfile; `scripts/build-index.ts` and `schemas/lockfile/v1.json` exist. Read `.workflow/plans/sox-ecosystem/migration.md` Sections 1.3 (scoped config schema + worked examples), 4.2 (cascade-merge resolver contract), 4.5 (dedup lint contract), and the Gap 4 resolution in Section 5 before writing code.
>
> Your task: (1) Write `scripts/cascade.ts` (~100 LOC) implementing the Section 4.2 contract exactly: load org baseline (if `extends` present) → user → project → local; **primitives replace, objects deep-merge, ARRAYS REPLACE ENTIRELY (not concat), narrowest scope wins**; `enabled:false` at a narrower scope force-suppresses; emit a flat `{ id → { version, enabled, config } }` map. (2) Extend `scripts/install.ts` to call the cascade across all four scopes and to fetch the `extends` org baseline, computing its sha256 and writing `extends: { url, sha256, resolved_at }` into the lockfile; on a subsequent install the fetched baseline's hash MUST match the lockfile or install FAILS CLOSED unless `--update` is passed (Gap 4). (3) Extend `scripts/validate-manifests.ts` to enforce the three uniqueness invariants from Section 4.5 (unique id per registry; ≤1 entry per id in resolved set; no shadow copies), cross-scope duplicate detection, and a secret-in-committed-config regex (block `${ENV}`-free literal values matching known API-key shapes in any committed `extensions.json`). (4) Add `.extensions/extensions.local.json` to root `.gitignore`.
>
> Skills/tools you need: Node fs/crypto, ajv, a test runner (Vitest). Files to read first: migration.md Sections 1.3, 4.2, 4.5, and Section 5 Gap 4.
> Success criteria: a Vitest integration test feeding org/user/project/local fixtures asserts the exact flat resolved map (incl. an array-replace case and an `enabled:false` suppression case) and passes; `validate-manifests` exits non-zero on a duplicate-ID fixture and on a literal-secret fixture; an `extends`-hash-mismatch fixture causes install to exit non-zero without `--update` and exit 0 with `--update`.
> Hard constraints: arrays REPLACE, never concatenate (document this in a code comment citing migration.md Section 4.2); secrets valid only at user/local scope; never commit `extensions.local.json`; fail closed on `extends` hash divergence.
>
> **Mandatory completion step.** Before exiting, append one line to `.workflow/plans/sox-ecosystem/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P2 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`.

### Phase 3 — Multi-provider support + capability check

**Phase ID:** P3
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
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`.

### Phase 4 — Registry publish + remote install from clean machine

**Phase ID:** P4
**Phase goal:** Publish `hello-world` to npm; install it on a clean machine from `registry/index.json` (no local source); `--frozen-lockfile` refuses re-resolution and `--update` re-resolves.
**Inputs:** P3 outputs.
**Outputs:** a Changeset for `hello-world`; published npm package; `registry/index.json` regenerated with npm-CDN `source` + sha256; verified clean-machine install.
**Verification:** on a clean checkout/machine with only `{ "install": [{ "id": "hello-world", "version": "^0.2.0" }] }` at user scope, `pnpm run install-extensions --scope=user` fetches from the npm CDN, verifies sha256, writes a working lockfile; a tampered artifact is rejected.
**Unblocks:** UC-3 (publish→install) and Gap 1 (npm+registry is the primary path).

**Phase prompt:**

> You are a release/distribution engineer. A working multi-scope, multi-provider install client exists (Phases P0–P3 complete) and `hello-world` installs from a local path. Read `.workflow/plans/sox-ecosystem/migration.md` Section 4.1 (install client: `--frozen-lockfile`/`--update`), Section 4.3 (build-index emits npm-CDN source + sha256), and the Gap 1 resolution in Section 5 before acting.
>
> Your task: prove the publish→install cycle. (1) Run `pnpm changeset` declaring a minor bump for `hello-world`; run `changeset version`; run `changeset publish` to publish `@scope/extension-hello-world` to npm (use a test registry or `--dry-run` if no npm token is available, and document which). (2) Run `scripts/build-index.ts` so `registry/index.json` lists `hello-world` with a resolved npm-CDN `source` URL (`https://cdn.jsdelivr.net/npm/@scope/extension-hello-world@<v>/dist/index.js`) and the artifact's sha256 `checksum`. (3) On a clean checkout (no prior lockfile/state), create a user-scope `extensions.json` with `{ "install": [{ "id": "hello-world", "version": "^0.2.0" }] }`, run `install-extensions --scope=user`, and confirm it resolves the published version from the registry index, fetches from the npm CDN, verifies sha256, and writes the lockfile. (4) Verify `--frozen-lockfile` refuses to re-resolve and `--update` re-resolves. This confirms Gap 1: npm + git `registry/index.json` is the PRIMARY, language-neutral install path (`.mcpb` is a later optional export, not built here).
>
> Skills/tools you need: Changesets, npm publish (or dry-run), Node fetch/crypto. Files to read first: migration.md Sections 4.1, 4.3, Section 5 Gap 1.
> Success criteria: a clean-machine install with no prior state resolves `^0.2.0` to the published version, fetches from the CDN, sha256 matches, and the skill activates; a byte-tampered artifact is rejected with a checksum error; `--frozen-lockfile` exits non-zero on a stale lock while `--update` succeeds and rewrites it.
> Hard constraints: the registry stores metadata only — artifacts come from npm/CDN; never publish a `private:true` extension; checksum verification is mandatory on every fetch.
>
> **Mandatory completion step.** Before exiting, append one line to `.workflow/plans/sox-ecosystem/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P4 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`.

### Phase 5 — All six extension types + full CI + hook ordering

**Phase ID:** P5
**Phase goal:** One working example of each of the six types; CI validate+release workflows live; hook execution order is deterministic; independent versioning proven (bump one, others stay).
**Inputs:** P4 outputs.
**Outputs:** stubs for agent, mcp-server, prompt, hook, command (skill already exists); `.github/workflows/validate.yml` + `release.yml`; hook-ordering logic in the host loader keyed on `order` then `id`; optional `scripts/pack-mcpb.ts`.
**Verification:** `pnpm changeset status` after bumping only the skill shows exactly one package pending; CI validate workflow passes on a clean PR; a fixture with two hooks on the same event loads them in `order`-ascending, `id`-tiebroken sequence.
**Unblocks:** completes UC-1..UC-5 coverage; resolves Gap 2 (hook ordering) and Gap 1 export option.

**Phase prompt:**

> You are a full-stack TypeScript engineer finishing an LLM-extension monorepo. Phases P0–P4 are complete: install, cascade, providers, and registry publish all work; only the `skill` type has a real example. Read `.workflow/plans/sox-ecosystem/migration.md` Sections 1.1 (six-type tree), 4.4 (scaffold per type incl. `command`), and the Gap 2 resolution in Section 5 before writing code. Background type responsibilities are in `extension-type-taxonomy.md`.
>
> Your task: (1) Run `scripts/new-extension.ts` to scaffold one example of each remaining type: `agent` (system prompt + 2 tools), `mcp-server` (stdio transport, 1 stub tool), `prompt` (`prompt.md` with frontmatter + parameterized body, NO `src/index.ts`), `hook` (binds a lifecycle event e.g. `PreToolUse`, logs to a file, sets `order`), `command` (deterministic shell op, slash-invoked, no LLM). Each must be exactly 4 files. (2) Implement hook execution ordering in the host loader per Gap 2: when multiple hooks bind the SAME lifecycle event, sort ascending by the integer `order` field (default 100), breaking ties by `id` lexicographic. Document that hooks should be order-independent where possible and `order` is an escape hatch, not a dependency mechanism. (3) Add `.github/workflows/validate.yml` (runs `validate-manifests`, `typecheck`, `test`, `changeset status` on PRs with `--filter "...[HEAD~1]"`) and `release.yml` (Changesets publish → `build-index` → commit `registry/index.json`) exactly per reference-architecture §6. (4) OPTIONAL: write `scripts/pack-mcpb.ts` to export a built extension as a `.mcpb` bundle (Gap 1 export target) — skip if time-bound. (5) Prove independent versioning: add a changeset bumping only the skill; confirm only the skill is pending.
>
> Skills/tools you need: Changesets, GitHub Actions, MCP stdio SDK for the mcp-server stub. Files to read first: migration.md Sections 1.1, 4.4, Section 5 Gap 2.
> Success criteria: all six type directories exist with exactly 4 files each and pass `validate-manifests`; a two-hooks-same-event fixture loads in `order`-then-`id` sequence (assert via test); `pnpm changeset status` after the skill-only bump lists exactly one package; the validate workflow passes on a clean PR.
> Hard constraints: `prompt` type uses `prompt.md`, never `src/index.ts`; the `type` field must match the parent directory for all six; hooks must not call the LLM (deterministic only); exactly 4 files per extension.
>
> **Mandatory completion step.** Before exiting, append one line to `.workflow/plans/sox-ecosystem/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P5 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`.

### Phase 6 — End-to-end verification + optional registry server

**Phase ID:** P6
**Phase goal:** All five MVP use cases pass end-to-end on a clean environment; the optional two-endpoint registry server is either built spec-compatibly or explicitly deferred with a recorded decision.
**Inputs:** P0–P5 outputs.
**Outputs:** a verification report mapping each acceptance command to UC-1..UC-5; optionally `scripts/registry-server.ts` (Gap 3); final status transition to `complete`.
**Verification:** each of UC-1..UC-5 runs to its documented success state from a clean checkout; if the registry server is built, `GET /:id/versions` and `GET /:id/:version/download` return the Terraform-shaped responses over `registry/index.json`.
**Unblocks:** engagement completion.

**Phase prompt:**

> You are a verification/QA engineer closing out a greenfield LLM-extension monorepo. Phases P0–P5 are complete: all six extension types, multi-scope install, providers, registry publish, and CI exist. Read `.workflow/plans/sox-ecosystem/migration.md` Section 3 (the five MVP use cases referenced as UC-1..UC-5, defined in `build-vs-reuse-and-build-plan.md` Part 3) and the Gap 3 resolution in Section 5 before acting.
>
> Your task: (1) From a clean checkout, execute each MVP use case end-to-end and record pass/fail with the exact command and observed result: UC-1 scaffold→edit→project-install in <5 min; UC-2 provider swap via config with no code change; UC-3 publish→clean-machine install with checksum verify; UC-4 project-scope config override (deep-merge, narrowest wins); UC-5 duplicate-ID blocked at CI. (2) Resolve Gap 3: the flat git `index.json` is the registry until ~5k entries; DECIDE to either (a) build `scripts/registry-server.ts` (~150 LOC) implementing the two Terraform-shaped endpoints `GET /:id/versions` and `GET /:id/:version/download` (redirect to the npm-CDN `source`) over `registry/index.json`, keeping it spec-compatible — OR (b) explicitly defer it, recording the entry-count trigger (~5k) that would justify building it. Default per the plan is DEFER; build only if the executor observes a queryability/scale need. (3) Produce a verification report (returned as your message, not a new committed file) mapping each acceptance check to its use case.
>
> Skills/tools you need: the full install/publish toolchain from prior phases; any minimal HTTP framework if building the server. Files to read first: migration.md Section 3 + Section 5 Gap 3; `build-vs-reuse-and-build-plan.md` Part 3 for the canonical UC definitions.
> Success criteria: all five use cases reach their documented success state from a clean environment; the Gap 3 decision is recorded (built-and-spec-compatible OR deferred-with-trigger); if built, both endpoints return correctly shaped responses for a known extension id.
> Hard constraints: do not weaken any prior acceptance check to make a use case pass; the registry server (if built) must be a metadata layer only — downloads redirect to npm/CDN, never serve artifacts directly; this is the FINAL phase.
>
> **Mandatory completion step.** Before exiting, append one line to `.workflow/plans/sox-ecosystem/status.md` under `## State transitions`:
> `<ISO timestamp> complete — phase P6 complete (executor: <your role>)`
> Update frontmatter: `state: complete`, `last_event: <ISO timestamp>`. *(This is the final phase: set `state: complete`, not `executing`.)*

---

## Section 4 — Interface contracts

Contracts specify signature, inputs, outputs, error modes, and side effects — not implementation.

### 4.1 Install client — `scripts/install.ts`

- **Signature:** `install({ scope: 'org'|'user'|'project'|'local', mode: 'default'|'frozen'|'update' }) → Promise<ResolvedSet>`. CLI: `install-extensions --scope=<s> [--frozen-lockfile] [--update]`.
- **Inputs:** the named scope's `extensions.json` (and, transitively, narrower scopes + the `extends` org baseline); the existing per-scope lockfile if present; OS env for `${ENV}` resolution.
- **Outputs:** a per-scope lockfile (`extensions.lock`) `{ lockfileVersion, extends?, resolved }`; the in-memory `ResolvedSet` (`{ id → { version, enabled, config, source, checksum } }`); fetched artifacts on disk.
- **Behavior:** resolve scope chain → cascade-merge (Section 4.2) → for each enabled extension resolve a version against `registry/index.json` (or `workspace:*`/`file://`) → fetch from `source` → verify sha256 → write lockfile. `--frozen-lockfile`: refuse to re-resolve; install exactly the lockfile or fail. `--update`: re-resolve and rewrite the lockfile (the only mode allowed to overwrite a mismatched `extends` hash, per Gap 4).
- **Error modes:** checksum mismatch → non-zero exit, structured error naming the id+source; `extends` hash divergence without `--update` → fail closed; literal secret in a committed config → reject; unknown `type` or type/dir mismatch → reject; capability hard-block under `strict_capabilities` → non-zero (Section 4 P3 / Gap 5).
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
- **Checks (all must pass):** (1) **three uniqueness invariants** — unique id per registry; ≤1 entry per id in any single scope's `install[]`; no shadow copies (same id as both a registry/npm source and a `file://` source in a committed lockfile). (2) **id format** `^[a-z][a-z0-9-]*$` and id must not end with its type name. (3) **type/dir match** — `type` equals the singular of the parent directory. (4) **version sync** — `extension.json.version` == `package.json.version`. (5) **cross-scope dup** — warn when the same id appears in a committed install list and a local path. (6) **secret-in-config regex** — block committed `extensions.json` whose config values are literal API-key-shaped strings instead of `${ENV}` refs.
- **Error modes:** any failed check → non-zero exit with an actionable, structured message (e.g. the UC-5 duplicate-ID error).
- **Side effects:** none — read-only. Runs in `validate.yml`. Source: `single-source-identity-dedup.md` §3,§4; `multi-scope-install-config-cascade.md` §4.

---

## Section 5 — Resolution of the 5 open gaps

Each gap is DECIDED. suggestions.md defaults are adopted unless an override is stated. No gap is deferred-as-undecided (Gap 3's "defer" is itself a decision with a trigger).

### Gap 1 — MCPB (`.mcpb`) vs generic npm+registry install path
**Decision (adopt suggestions default):** npm + git `registry/index.json` is the **primary, language-neutral install path** covering all six types. `.mcpb` is an **optional export/packaging target**, not the core install path: `scripts/pack-mcpb.ts` (Phase 5+, optional) emits a `.mcpb` bundle from an already-built extension for Claude-Code-native consumers.
**Trade-off:** Coupling core install semantics to one host's bundle format would break language-neutrality (Python agents alongside TS MCP servers) and the two-tier discovery/distribution split. Cost of the chosen path: Claude-Code-native users need the extra `pack-mcpb` step instead of a first-class bundle. Accepted — the export is cheap and additive. `Conjecture:` `.mcpb` internals per the suggestions stance; not settled by a primary finding.

### Gap 2 — Hook execution ordering on the same lifecycle event
**Decision (adopt suggestions default):** Deterministic order via an explicit integer `order` field in the hook's `extension.json` (default 100); the host resolver sorts hooks bound to the same event ascending by `order`, breaking ties by `id` lexicographic. `order` is hook-only in the schema (Section 1.2).
**Trade-off:** An explicit integer is simpler and more predictable than a topological dependency graph, but it is an escape hatch, not a dependency mechanism — authors must keep hooks order-independent where possible (documented in the P5 prompt). A pure dependency DAG would be more expressive but adds resolution complexity unjustified at this scale. Source: `extension-type-taxonomy.md` (hooks fire unconditionally) + suggestions Gap 2 (`Conjecture:` on the exact tie-break).

### Gap 3 — Registry HTTP server (Terraform two-endpoint model)
**Decision (adopt suggestions default — validate-but-defer):** The flat git `registry/index.json` IS the registry until ~5k entries (`registry-as-protocol-not-product.md` §5: git-repo registries don't scale past ~10k; queryability is the trigger). **Validate** the Terraform two-endpoint shape (`GET /:id/versions`, `GET /:id/:version/download` redirecting to the npm-CDN source) and keep it spec-compatible, but **defer building `scripts/registry-server.ts` to Phase 6+/optional** — build only when entry count or queryability demands it.
**Trade-off:** Deferring avoids running and securing an HTTP service for an ecosystem that a static file serves perfectly; the cost is that large-scale search requires a full index clone until the server is built. Spec-compatibility keeps it a drop-in later. Recorded trigger: ~5k entries. Source: `registry-as-protocol-not-product.md` §2,§5.

### Gap 4 — Org-baseline `extends` URL pinned by content hash
**Decision (adopt suggestions default):** Pin the org baseline by content hash in the per-scope lockfile: `extends: { url, sha256, resolved_at }` (Section 1.4). On install, the fetched baseline's sha256 MUST match the lockfile; on divergence the install **fails closed** unless `--update` is passed (which re-resolves and rewrites the pin).
**Fail-closed behavior (exact):** `install.ts` computes sha256 of the fetched `extends` body; if a lockfile `extends.sha256` exists and differs and `mode != 'update'` → abort non-zero with `ERROR: org baseline at <url> changed (lock <old> vs fetched <new>); re-run with --update to accept`. If no prior pin exists, record it. This reuses the same checksum machinery as artifact verification.
**Trade-off:** Fail-closed prevents a silently mutated org baseline from changing every project's resolved config (supply-chain integrity), at the cost of an explicit `--update` step when the org legitimately revises the baseline. Accepted — matches the MED supply-chain risk in suggestions. Source: suggestions Gap 4 + `multi-scope-install-config-cascade.md` §5.

### Gap 5 — Capability check: advisory-warn vs hard-block
**Decision (adopt suggestions default):** **Advisory-warn by default, hard-block opt-in.** The capability checker (Section 4 P3) warns loudly at install time on a `requires.*` mismatch and exits 0; a scope-level `strict_capabilities: true` (Section 1.3) escalates the mismatch to a non-zero hard block.
**Trade-off:** Long-tail local models (Ollama/vLLM) frequently under-report params in static tables; a default hard block would break legitimate setups (the LOW false-negative risk in suggestions). Default-warn keeps those setups working while surfacing the risk; teams that need guarantees opt into `strict_capabilities`. Cost: a genuinely incapable model may pass install with only a warning unless strict mode is enabled. Accepted. Source: suggestions Gap 5 + `multi-llm-provider-abstraction.md` §3,§7.

---

## Changelog

- 2026-06-07 — workflow-planner created migration.md from the agreed `extension-ecosystem-design` research. 7 phases (P0–P6). All 5 gaps resolved (adopted suggestions defaults; no overrides). Core glue budget 730 LOC; ~1010 incl. optional `registry-server.ts` + `pack-mcpb.ts`. canonical_roi = qualitative-only.
