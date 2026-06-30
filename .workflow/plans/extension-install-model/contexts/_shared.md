<!-- markdownlint-disable MD013 MD033 -->
# Shared context — Extension Install & Reinjection Model

> **Single source of truth for definitions.** Every work-state context references entries here
> by name (`[def:…]` / `[inv:…]` / `[shape:…]` / `[ref:…]`) instead of restating them. Change a
> definition once, here — never copy it into a context file. When an in-place amendment changes a
> shared definition, this is the only file that needs editing, and every referencing context
> inherits the change.
>
> **Spec sources** for every fact below: `docs/plans/extension-install-and-reinjection-model.md`
> (§2 roles, §3 model, §4 Claude matrix, §4b Codex matrix, §8 wrapper, Appendix A generator
> options) and `docs/decisions/0002-extension-install-model.md` (the accepted ADR).

---

## Glossary

Terms used across contexts. Reference as **[def:term]** from any context file.

- **[def:role-a]** — *Runtime host.* soxe loads / spawns / supervises / enforces / invokes the
  extension (`service`, `mcp-server` in sox-run mode, in-process code). soxe owns the whole stack.
  Spec §2.
- **[def:role-b]** — *Package manager + reinjector.* The **foreign host** (Claude Code, Codex)
  executes; soxe only **materializes + versions + scopes + diffs** content into the host's own
  discovery locations. Execution is deferred to the host. Spec §2. See **[inv:boundary]**.
- **[def:capability]** — A generic, idempotent installer operation implementing
  **apply / reverse / update(diff) / verify**, scope- and host-aware. The six: `file-drop`,
  `config-merge` (json|toml), `array-merge`, `bin-link`, `run-service`, `materialize`. Spec §3.2.
  Lives in `libs/install-engine/src/capabilities/`.
- **[def:profile]** — An *install-layer* preset over *(capability + transport + host-target +
  config)* — e.g. mcp `standalone` (Claude spawns its own stdio copy) vs `shared` (sox `run-service`
  sse). `--profile` selects it at install. Distinct from a **type**, which is the *build-layer*
  preset. Spec §3.3, §8.
- **[def:serves]** — The transports an mcp extension implements (`stdio`, `sse`, `http`); derived
  from building on `@adhd/sox-mcp-runtime`. `profiles ⊆ serves` is a validate-time invariant. Spec §8.
- **[def:host-registry]** — Pluggable per-host module `{ host, detect(), scopePaths(scope),
  surfaces{} }` in `libs/host-registry/`. Holds the verified location matrix, the scope→path
  resolver, and the install-time host detector. Ships two modules: `claude.ts`, `codex.ts`. Spec
  §3.5, §4, §4b.
- **[def:ledger]** — Per-scope provenance file `<scope-root>/.sox/ledger.json` recording every
  shared-file write as an action `{ cap, file, keyPath[, values | appliedHash] }` keyed by
  `(ext, host, scope)`. The **project** ledger is committed + portable (repo-relative paths /
  keyPaths / hashes only — no absolute or user paths); machine-specific actions
  (e.g. `materialize` into `~/.sox/`) go in the **gitignored user ledger** at `~/.sox/`. Drives
  `diff`/`uninstall`. Spec §3.4, ADR resolved #3. Implemented in `libs/install-engine/src/ledger.ts`.
- **[def:install-descriptor]** — The **hybrid** install block on a manifest: `type` + chosen
  `profiles`/`hosts` + per-host overrides. The engine fills target defaults from the host registry
  at install time. Replaces the old single-string `install-target`. Spec §3.1, ADR resolved #2.
- **[def:source-provenance]** — When `--content @path` / `--from @dir` is used at `init`, the
  manifest records `source: <path>` so `update` can re-pull from origin. This is what makes `init`
  the ingestion primitive. Spec Appendix A, ADR decision #8.
- **[def:policy-env]** — The C6 contract: declared permissions are serialized to the spawned
  process environment via `toEnv` (in `libs/host-runtime/src/policy.ts`) and re-read by the server
  via `compilePolicyFromEnv`, enforced at the resource sink before the OS resource. Reused
  unchanged by `@adhd/sox-mcp-runtime`. Spec §8, ADR decision #6. See **[inv:c6-holds]**,
  **[ref:policy-env-enforce]**.
- **[def:managed-tier]** — The Claude **managed** settings tier (org/enterprise policy). sox
  **never** writes it. Spec §4 scope mapping. See **[inv:never-managed]**.
- **[def:project-forbidden-keys]** — Codex keys that cannot be set at project scope:
  `model_providers`, `notify`, `profile`, `otel`, base-URLs; project config also no-ops until
  `trust_level = "trusted"`. The registry encodes these per host. Spec §4b. See
  **[inv:never-managed]**.
- **[def:born-conformant]** — Generator output validates clean immediately and is **byte-identical**
  between `soxe init` and the `@adhd/sox-nx` generator; `libs/authoring` is the single scaffolder (no
  hand-rolled layout). The existing DoD A1/B1 gate. See **[ref:born-conformant-scaffold]**.

---

## Cross-cutting invariants

Contracts every state must preserve throughout the migration — not just at the end. A state's
context lists only the *additional* invariants specific to it, and references these by ID. These
are the README "Design invariants"; the canonical definitions live here.

- **[inv:boundary]** — Role B reinjection ends at *"the right bytes are at the host's discovery
  path for the right scope."* soxe never asserts the host *ran* the content. **Check:** no
  capability `verify()` and no audit check asserts execution by the foreign host; verification tops
  out at present + valid at target. Spec §2.
- **[inv:ledger-reversible]** — Every shared-file write (`config-merge` / `array-merge`) is recorded
  in the per-scope ledger and reversible to the exact key/value; uninstall reverses ONLY sox-owned
  entries and never touches foreign keys in the shared file. **Check:** apply→reverse round-trip
  restores the file byte-for-byte except sox's own entries; a foreign key present before apply is
  present after reverse. See **[ref:ledger-reversible]**.
- **[inv:host-agnostic-type]** — The TYPE is host-agnostic; capability + target are host-specific
  and resolved from the registry. The same type maps to different capabilities per host (an `agent`
  is `file-drop` on Claude, `config-merge [agents.x]` on Codex). **Check:** no literal host
  discovery path appears outside `libs/host-registry`. See **[ref:host-keyed-target]**. Spec §4b
  divergence note.
- **[inv:format-aware-merge]** — `config-merge` handles JSON **and** TOML; no json-only assumption.
  Codex `config.toml` round-trips through the same capability. **Check:** a toml apply→read→reverse
  round-trip preserves the table. See **[ref:config-merge-format]**. Spec §3.2, §4b.
- **[inv:never-managed]** — soxe never writes the Claude managed tier (**[def:managed-tier]**) nor
  Codex **[def:project-forbidden-keys]** at project scope. **Check:** `validate` refuses a
  descriptor targeting a managed/forbidden key; the engine has no code path that writes them. Spec
  §4, §4b.
- **[inv:c6-holds]** — `@adhd/sox-mcp-runtime` enforces declared permissions from **[def:policy-env]** in
  **every** spawn path (claude-stdio + sox-service); no unenforced path is introduced. **Check:**
  the C6 negative reality test (an undeclared access is denied) passes for both transports. See
  **[ref:policy-env-enforce]**. Spec §8.
- **[inv:no-regress]** — `nx run-many build,lint,test`, the C6 e2e, and `memory-*` install/run
  behavior stay green throughout. **Check:** `./node_modules/.bin/nx run-many -t build,lint,test`
  exits 0; `host-runtime:test-e2e` and `memory-server:test` exit 0.

---

## Shared fixtures and sample data

Golden files, sample inputs, and fixture helpers referenced by multiple guards or audit checks.

- **[fix:ingest-source]** — `swarm-cost` — the real source ingested end-to-end at `audit-final`,
  driven solely by the `sox-ingest` skill, to prove **[dod.13]** and exercise **[dod.1]**. Spec
  §10 P7, ADR consequences.
- **[fix:c6-e2e]** — `host-runtime:test-e2e` (`tools/test-e2e-lifecycle.js`) — the existing C6
  lifecycle/negative-permission e2e the migration must keep green (**[inv:no-regress]**,
  **[inv:c6-holds]**).

---

## Type and config shapes

Type signatures and config formats referenced by more than one state. Define once here; contexts
point at **[shape:name]** rather than repeating the signature.

```text
[shape:install-descriptor]
  manifest.install = {
    type:     <build type, host-agnostic>,        // L1 identity
    hosts:    ["claude" | "codex", ...],          // chosen host targets
    profiles: { <name>: { ... } },                // install-layer presets (mcp: standalone|shared)
    serves:   ["stdio" | "sse" | "http", ...],    // mcp only; profiles ⊆ serves
    source:   "<path>" | undefined,               // provenance when --content @ / --from used
    overrides:{ <host>: { <surface/key overrides> } }
  }
  // engine fills per-host target defaults from libs/host-registry at install time.
```

```text
[shape:capability]
  interface Capability {
    apply(ctx: {host, scope, target, payload, ledger}): Promise<void>;   // idempotent
    reverse(ctx): Promise<void>;                                          // exact inverse via ledger
    update(ctx): Promise<Diff>;                                           // desired vs ledger → delta
    verify(ctx): Promise<VerifyResult>;                                   // present + valid at target
  }
  // config-merge & array-merge MUST write a ledger action on apply (see [inv:ledger-reversible]).
  // config-merge is format-aware: json AND toml (see [inv:format-aware-merge]).
```

```text
[shape:ledger-action]
  { cap: "config-merge" | "array-merge" | "materialize" | "file-drop" | "bin-link",
    file: "<repo-relative path for project ledger | ~/.sox/... for user ledger>",
    keyPath: "<dot/array path within the shared file>",
    values?: [...],            // array-merge: the exact values soxe appended (deny-wins)
    appliedHash?: "sha256:…"   // config-merge: hash of the value soxe set
  }
```

```text
[shape:mcp-tool]
  // Authors write tools only; the wrapper owns transport/protocol/health/shutdown/enforcement.
  serve(defineTool({
    name, description, inputSchema,
    handler: async (args, ctx) => { /* ctx exposes policy accessors; sink is C6-enforced */ }
  }));
  // serve() selects transport (stdio | sse/http) from a flag/env set by the install profile.
```

---

## Reference-pattern fallbacks

> These are the `discovered_via: "manual"` fallbacks for `references.json` (no GitNexus index).
> Each `shared_ref` in `references.json` points here; each is verified once by its
> `audit_check` (`[audit-final.ref-<slug>]`) in `scripts/audit_eim.py --phase final`. **Cite
> `[ref:<slug>]` from a work state — never restate the rule.**

- **[ref:ledger-reversible]** — Every `config-merge` / `array-merge` write records a per-scope
  ledger action keyed by `(file, keyPath[, values])`; `uninstall` reverses ONLY sox-owned entries
  and never touches foreign keys in the shared file. Anchor: `libs/install-engine/src/ledger.ts`.
  Verified by `[audit-final.ref-ledger-reversible]`.
- **[ref:host-keyed-target]** — Capability targets resolve from `libs/host-registry`; no literal
  host-discovery path (`~/.claude`, `.claude/`, `~/.codex`, `.codex/`) appears outside
  `libs/host-registry` — the TYPE is host-agnostic, the target is registry-resolved. Verified by
  `[audit-final.ref-host-keyed-target]`.
- **[ref:config-merge-format]** — Host config files (`settings.json` / `.mcp.json` /
  `~/.claude.json` / `config.toml`) are read+written ONLY via the `config-merge` capability (json
  AND toml); no ad-hoc `JSON.parse` / `writeFileSync` or toml write of a host config elsewhere.
  Verified by `[audit-final.ref-config-merge-format]`.
- **[ref:policy-env-enforce]** — Every mcp spawn path injects policy-env (`toEnv`) and every
  `@adhd/sox-mcp-runtime` server self-enforces via `compilePolicyFromEnv` at the resource sink before the
  OS resource — no unenforced spawn path (claude-stdio or sox-service). Verified by
  `[audit-final.ref-policy-env-enforce]`.
- **[ref:born-conformant-scaffold]** — Generator output validates clean and is byte-identical
  between `soxe init` and the `@adhd/sox-nx` generator; the `libs/authoring` core is the single
  scaffolder (no hand-rolled layout). Verified by `[audit-final.ref-born-conformant-scaffold]`.
