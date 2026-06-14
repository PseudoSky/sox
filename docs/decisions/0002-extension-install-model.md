# ADR-0002 — Extension Install Model: Role A/B Boundary, Capabilities, and Reinjection

- **Status:** **Accepted** — all open items resolved (interactive design, 2026-06).
- **Context doc:** [`docs/plans/extension-install-and-reinjection-model.md`](../plans/extension-install-and-reinjection-model.md) (full detail + phased plan).
- **Builds on:** ADR-0001 (nx + self-hosting); the completed C6 runtime-permission work.

## Context

The schema/generators describe placing declarative content (markdown agents/skills, slash-commands)
into a host's discovery locations, and permit a `lifecycle` block on `agent` — but the tooling never
implemented placement, the runtime honors `lifecycle` only for `mcp-server`, and versioning/update/diff
don't work for declarative content. Root cause: the **standard ran ahead of the tooling**, and sox's
**two distinct roles were never named**, so no one noticed which half each capability needed.

## Decisions (Accepted)

1. **Two roles, named explicitly.**
   - **Role A — runtime host:** sox loads/spawns/supervises/enforces/invokes (`service`, `mcp-server`
     in sox-run mode, in-process code).
   - **Role B — package manager + reinjector:** the *foreign host* (Claude Code, Codex, …) executes;
     sox only **materializes + versions + scopes + diffs** content into the host's own locations.
   - **Boundary:** for Role B, execution is **deferred to the host**; sox's reality-check tops out at
     *"the right bytes are at the host's discovery path for the right scope,"* never *"the host ran it."*

2. **Three layers.** `type` (build identity) · `capabilities` (mechanism) · `injection-targets + config`
   (deploy). The manifest = `type` + an install descriptor; permissions/env are **config carried on a
   built extension**, not types.

3. **Capability composition with named presets** (not single-inheritance). Capabilities:
   `file-drop`, `json-merge`, `array-merge`, `bin-link`, `run-service`, `materialize` — each idempotent
   with **apply / reverse / update(diff) / verify**, scope- and host-aware. **Types** are build-layer
   presets; **profiles** are install-layer presets (capability + transport + host-target + config).
   `service` is the base sox-run type; `mcp-server` is a service that also injects into hosts.

4. **Provenance ledger.** Merge capabilities (`json-merge`/`array-merge`) write into shared host files;
   sox records every write (file, keyPath, applied hash/values) per `(ext, host, scope)`. This is what
   makes uninstall and `diff` correct for shared-file merges.

5. **Host registry.** Per-host module `{ detect(), scopePaths(scope), surfaces{} }` holds the location
   matrix + the install-time host detector + the scope→path resolver. Scope map: project → `.claude/…`
   (+ repo `.mcp.json`), user → `~/.claude/…`, local → `settings.local.json`; **sox never writes the
   managed tier.**

6. **MCP wrapper (`@sox/mcp-runtime`).** A shared lib (C7-clean) the generator scaffolds around:
   authors write tools only; the wrapper provides dual transport (stdio + sse/http, selected by install
   profile), MCP protocol, health, shutdown, and **C6 enforcement read from policy-env — applied
   uniformly whether Claude spawns it (stdio) or sox supervises it (sse).** `serves` becomes a derived,
   reality-tested fact; `memory-server`'s hand-rolled loop + vendored guard collapse into it.

7. **Verified location facts** (real FS, 2026-06) recorded in the context doc §4; corrections noted
   (user MCP → `~/.claude.json`; hooks = dir + settings; plugins via `installed_plugins.json`; project
   `.mcp.json` trust-gated by `enabledMcpjsonServers`). `rules`/`output-styles`/`keybindings` are
   **unverified** and excluded until doc-checked.

8. **`prompt` resolved + `--content` convention.** `prompt` is the **content-injection** type: a piece
   of instruction/template content plus a declared injection target, selected by `--inject`
   (`claude-md` | `rules` | `output-style` | `settings-key`). Additionally, the declarative/content
   types (`agent` declarative, `skill`, `prompt`; and any file-bodied artifact — slash `command`, `hook`
   script, `CLAUDE.md`) accept a **`--content <text | @path>`** option (inline text or `@`-prefixed
   file ref) and **`--from @<dir>`** for directory-shaped artifacts. When `--content @path`/`--from` is
   used, the manifest records `source: <path>` provenance so updates can re-pull from origin. This makes
   `init` the ingestion primitive (extract a plugin file/dir in one command). Full generator schema:
   context doc Appendix A.

## Consequences

- Unblocks declarative ingestion (`docs/ingestion/`) — the original goal.
- Exposes that DoD **B2 "run"** was only verified for code/process types; the declarative half
  (placed + discoverable, updatable across scopes) must be delivered and verified — a first-class
  requirement, added deliberately.
- The implementation is one capability engine + ledger + host registry + MCP wrapper, not bespoke
  per-type logic — `update`/`diff`/`uninstall`/cross-scope fall out per capability.
- Retires duplication (memory-server) and resolves the `install-target`-unimplemented and
  `agent`-lifecycle-vestigial findings.

## Resolved (design session, 2026-06)

1. **Type/preset breadth → keep 8 presets** (agent, skill, mcp-server, service, command, hook, prompt,
   bundle). `rules`/`output-style` are `prompt --inject` targets, **not** types; `statusline` is config
   (a script + settings key). Promote nothing further until a real need *and* verification.
2. **Install descriptor → hybrid.** Manifest stores `type` + chosen `profiles`/`hosts` + overrides; the
   engine fills target defaults from the host registry at install time.
3. **Ledger → one file per scope** (`<scope-root>/.sox/ledger.json`); the **project ledger is committed
   and portable** — repo-relative paths / keyPaths / hashes only, **no** absolute or user paths.
   Machine-specific actions (e.g. `materialize` into `~/.sox/…`) live in the **gitignored user ledger**
   at `~/.sox/`.
4. **`@sox/mcp-runtime` → wrap the official `@modelcontextprotocol/sdk`** (add transport-selection +
   policy-env enforcement + health/shutdown; do not reimplement the protocol).
5. **Verify before relying.** `rules`/`output-styles`/`keybindings` + project `.mcp.json` (Claude), and
   the **full codex surface matrix** (see #6), are verified against live docs/FS before any tooling
   depends on them.
6. **Multi-host → Claude + codex now.** Build the pluggable host registry **and ship two host modules**
   (`claude`, `codex`) to prove the abstraction isn't Claude-shaped; further hosts additive.
