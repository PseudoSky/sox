# Spec — Cross-Platform Install Rendering (IR + per-host typed config + render-at-install)

**Status:** Draft for review (revision 3 — incorporates two blind adversarial review passes)
**Builds on:** ADR-0002 (extension install model), `docs/research/cross-host-registry-gap-analysis.md` (G1 — "per-host artifact rendering" MISSING), `libs/manifest/src/schema.json` (manifest v2), `libs/host-registry/src/{claude,codex,opencode}.ts`.
**Supersedes:** **FEAT-SOX-004** ("Per-host content overlay … `install.frontmatter`") — this spec is the architect pass that item's own note said it still needed. The frontmatter-overlay design is the narrow predecessor; this spec generalizes it into IR + typed per-host config and additionally solves the two things FEAT-SOX-004 explicitly left out of scope: the **tool-name prose duplication** (§5.3) and the **codex TOML agent shape** (§5.4).

---

## 1. Problem

The same logical extension — an **agent** — must currently be authored as a
separate artifact per host, because each host's *frontmatter / config header* is a
different schema and the install engine performs a **byte-for-byte file-drop** with
no rendering step. The platform specifics are **baked into source**, so:

- one host's header is invisible or invalid to another host;
- the prose body duplicates host-specific tool names (a hand-maintained "tool
  naming" section that drifts);
- per-host `.md` copies fork and orphan (dead files nobody references).

The gap-analysis already names this as the highest-leverage gap:

> G1 — **Per-host artifact rendering**: one authored artifact → claude/opencode/codex
> formats. **MISSING.** … renderers live behind the `HostModule` interface (new
> optional `render(type, manifest, content)` surface).

This spec promotes that design sketch into a concrete contract. It does **not**
change what the engine already does for `mcp-server` (the per-host `McpConfig`
builder is the one existing renderer and stays as-is); it generalizes that same
"per-host value builder" pattern to **agents** and — by the same mechanism — to
every declarative content type whose header shape differs per host.

---

## 2. Current state — the concrete evidence (researcher agent)

Three divergent definitions of the *same* agent exist today:

| Artifact | Header schema | Tool names in prose | Notes |
|---|---|---|---|
| `extensions/agents/researcher/researcher.md` | **opencode**: `name`, `description`, `mode: all`, `temperature: 0.4`, `permission: {…}` | `tools.search.*`, `tools["memory-server"].*` | `entrypoint` in `extension.json` |
| `extensions/agents/researcher/researcher-claude.md` | **claude**: `name`, `description`, `tools: Read, Bash, …, mcp__search__*, mcp__memory-server__*, mcp__backlog__*`, `model: sonnet`, `version: v1.0.1` | `mcp__search__*`, `mcp__memory-server__*` + an extra "Resolve names from your ACTUAL tool list" block | **orphan** — referenced by nothing (`rg researcher-claude` → 0 hits outside this dir) |
| `~/dev/ai/claude-agents/categories/10-research-analysis/researcher.md` | **claude**: same as above but fully-expanded tool names (`mcp__search__agent_browser_search_mcp_source_search`, …) | same expanded names | referenced by `extension.json` `install.source` |

Concrete divergences measured (2026-08-29):

1. **Header** — three incompatible schemas for one concept:
   - opencode: `mode` / `temperature` / `permission` (nested pattern→action map)
   - claude: `tools` (comma list + `mcp__*` globs) / `model` / `version`
   - codex: **no frontmatter at all** — `[agents.<name>]` in TOML `config.toml`
2. **Prose tool-naming** — the "Tool naming — read this before your first call"
   section hardcodes `tools.search.agent_search` (opencode) vs
   `mcp__search__agent_browser_search_mcp_source_search` (claude), and the two
   files also diverge on the memory fallback path (`docs/research/fallback/` vs
   `.research-fallback/`).
3. **`extension.json` self-contradiction** — `install.source` points at the
   claude-agents repo copy, but `entrypoint` resolves to the opencode-format
   `researcher.md`. The bytes that land depend on *which* resolution path fires;
   the two are different files with different headers.
4. **Manifest schema dual-source drift (BL-623)** — `extension.json` declares
   `install.hosts: ["claude","codex","opencode"]`; the runtime validator accepts
   it (the inlined `ManifestSchema` and `KNOWN_HOSTS` in
   `libs/manifest/src/index.ts` already enumerate three hosts), but the on-disk
   `libs/manifest/src/schema.json` has drifted to `["claude","codex"]` (and
   `install.additionalProperties` `false` vs `true`) with no parity test. The
   runtime does **not** reject opencode today; the JSON "source of truth" is
   simply one commit stale. Tracked as **BL-623**.

This whole divergence is tracked as **BUG-027**.

**What is "actively installed in claude":** `~/.claude/agents/` contains
symlinks into the claude-agents repo. `researcher.md` is **not** among them — the
researcher agent is not installed as a Claude agent via either symlink or the
soxe engine today. The "claude version" the user remembers is the claude-agents
repo copy; the "opencode version" is the sox-ecosystem copy. They are not the
same file and never have been.

The engine does **not** render any of this: `declarativeInstall()` (in
`libs/install-engine/src/install.ts`) resolves the agent surface, then
`file-drop` copies the resolved entrypoint `.md` **verbatim** to
`<host>/agents/<id>.md`. There is an unowned-file guard (`install.ts` ~line
1751) that refuses to clobber an existing file the extension does not own — added
after a live incident where "a working opencode agent was replaced by a divergent
extension copy and opencode rejected it." (The code comment cites "BL-569" for
this guard, but BL-569 is actually the resolved pnpm-publish exact-pin issue —
a wrong citation, tracked as **BUG-028**.) That incident is *this* bug class; the
guard band-aids the symptom, the spec removes the cause.

---

## 3. Design goals

1. **Author once, install everywhere.** One host-agnostic artifact per extension;
   per-host headers synthesized at install time.
2. **No host-specific text baked into prose.** Tool names, header fields, and
   fallback paths are rendered, not handwritten per host.
3. **Either IR *or* typed per-host config — both supported.** A common IR for the
   shared 90%, and typed per-host override blocks for the genuinely divergent
   10% (e.g. claude gets `mcp__backlog__*`, opencode gets `task`).
4. **Deterministic + reversible.** Rendered output is a pure function of
   (manifest IR + host module + host-module data + relative render tokens). The
   existing ledger/ownership/index machinery records the *rendered* bytes, so
   update/uninstall/`doctor` keep working unchanged.
5. **Validate at install and at authoring.** `soxe validate` renders for every
   declared host and proves the output is well-formed for that host (frontmatter
   parses for claude/opencode, TOML parses for codex).
6. **Backward compatible.** An agent without the new IR/render blocks continues
   to file-drop verbatim (raw passthrough) exactly as today.
7. **No new capability id.** Rendering is a *pre-step* that feeds the existing
   `file-drop` / `config-merge` capabilities (§5.1) — the reversible machinery
   is reused unchanged.

---

## 4. The Intermediate Representation (IR)

### 4.1 Split the artifact into prose + config

An `agent` extension becomes two inputs:

- **`agent.md`** (or the manifest `entrypoint`) — the **prose body only**, no
  frontmatter. Host-agnostic. References tools by **logical name**
  (`SEARCH(...)`, `memory_recall(...)`, `list_providers()`), never by a
  host-prefixed concrete name.
- **`extension.json`** — carries the host-agnostic **IR** plus optional per-host
  typed overrides (below). This is where "what kind of agent" and "which model /
  which tools / which permissions" live.

### 4.2 `agent` IR block (host-agnostic)

```jsonc
{
  "id": "researcher",
  "type": "agent",
  "entrypoint": "agent.md",              // prose only, no frontmatter
  "agent": {
    "name": "researcher",
    "description": "Discovery researcher …",   // shared one-liner (both hosts)
    "model": "sonnet",                         // logical model id; host may remap
    "temperature": 0.4,
    "mode": "all",                             // opencode: all|primary|subagent; claude ignores
    "tools": [
      "read", "bash", "write", "edit", "webfetch", "websearch",
      { "logical": "search", "server": "search" },
      { "logical": "memory", "server": "memory-server" },
      { "logical": "backlog", "server": "backlog" }
    ],
    "permission": {                             // opencode: action | (pattern→action)
      "read": "allow", "edit": "allow", "websearch": "deny", "task": "allow",
      "memory_*": "allow",
      "bash": { "*": "allow", "git stash*": "deny", "git reset --hard*": "deny",
                "rm -rf *": "deny" }
    }
  }
}
```

`tools` entries are **symbolic**: a plain string names a built-in/session tool
common to most hosts (`read`, `bash`, `webfetch`, …); an object form names an
MCP-backed tool group by its logical `server`. The host renderer expands both to
concrete callables (§5.3).

**`permission` (singular)** carries opencode's real frontmatter shape — each key
maps to either a scalar `action` (`"read": "allow"`, `"websearch": "deny"`) or a
`pattern → action` map (`"bash": { "*": "allow", "git stash*": "deny" }`) — a
union the IR models as `action | (pattern → action)`. It is **distinct** from the
pre-existing top-level manifest key `permissions` (`libs/manifest/src/schema.json`
lines 354–401, the `fs.read/write` / `network.outbound` / `socket.paths` shape
used for the capability engine). That top-level key is unaffected; the agent IR
does not reuse its name. (Claude permissions go through the existing
`settings.json` `array-merge` surface, not agent frontmatter; codex through TOML
— both out of scope here.)

### 4.3 Per-host typed overrides (`render.<host>`)

For the 10% that genuinely diverges, an explicit per-host block **merges over**
the IR (typed, schema-validated per host):

```jsonc
"render": {
  "claude": {
    "model": "sonnet",
    "tools": ["Read", "Bash", "Write", "Edit", "WebFetch", "WebSearch",
              "mcp__search__*", "mcp__memory-server__*", "mcp__backlog__*"],
    "version": "v1.0.1"                    // claude agent-frontmatter DISPLAY field
  },
  "opencode": {
    "mode": "all",
    "temperature": 0.4,
    "permission": { "bash": { "*": "allow", "git stash*": "deny" } }
  },
  "codex": {
    "model": "gpt-5.1-codex",
    "description": "…"                     // codex TOML phrasing, if different
  }
}
```

Two authoring modes, both first-class (this is the user's explicit "either/or",
resolved as **both**, because they serve different needs):

- **IR-only** — author the shared block; the host renderer fills everything it
  can. Best when the agent is genuinely host-portable.
- **IR + typed overrides** — author the shared block *and* hand-write the
  host-specific header for hosts that need exact control. The override is
  **validated against a per-host JSON schema** so a typo can't silently produce
  an invalid header.

> **Boundary vs `install.overrides`.** The manifest already has an
> `install.overrides` map keyed by host name (`libs/manifest/src/schema.json`
> `install.overrides`), which scopes **config-file keys** (settings.json /
> config.toml). `render.<host>` scopes **artifact header/frontmatter fields** — a
> different surface. The two never overlap: a field that lives in a host's config
> file goes in `install.overrides`; a field that lives in the agent's own header
> goes in `render.<host>`.

> **Naming note.** `render.claude.version` (claude's agent-frontmatter display
> string) is **unrelated** to the top-level manifest `version` (a derived human
> label, not identity — identity is content-addressed per ADR-0003). They are two
> different axes; the renderer treats them independently and no sync between them
> is implied.

### 4.4 Which fields belong in the IR vs the render blocks

| Field | IR (shared) | Per-host override | Rationale |
|---|---|---|---|
| `name` / `description` | ✓ | optional | shared; codex may rephrase |
| `model` | ✓ (logical) | ✓ (host model id) | "sonnet" ≠ "claude-sonnet" ≠ "gpt-5" |
| `temperature` | ✓ | ✓ | opencode-only today; harmless no-op elsewhere |
| `mode` | ✓ | ✓ | opencode `mode`; claude has no equivalent |
| `tools` (logical) | ✓ | ✓ (concrete) | see §5.3 tool-name mapping |
| `permission` | ✓ | ✓ | opencode-specific; claude/codex use config surfaces |
| `version` (display) | — | ✓ | claude display field; meaningless to others |

---

## 5. Rendering pipeline

### 5.1 Render is a pre-step, not a new capability

No new `CapabilityId` is introduced. Rendering happens **before** the existing
capability dispatch and produces only the *source bytes* (or config value) that
the existing capability then places:

- `agent` on `claude`/`opencode`: render → **`file-drop`** (unchanged). The
  renderer materializes its `file-body` string to a deterministic scratch file,
  and that file is handed to the existing file-drop as `srcPath`. The file-drop
  path itself — dest-path resolution, ledger recording, ownership entry,
  unowned-file guard, dry-run planning, and hash-idempotency — is untouched; only
  *which bytes* it copies differ (rendered vs raw). Because the rendered bytes
  are deterministic (§5.2), the scratch file's content-hash is stable and
  file-drop's existing src-vs-dest hash idempotency behaves identically.
- `agent` on `codex`: render → **`config-merge`** (unchanged). The renderer
  produces the `[agents.<name>]` TOML value; the existing config-merge writes it.

This is deliberate: a genuinely *new* `render-drop` capability would force a new
case into `CapabilityId` (`host-registry/internal.ts`), `ledger.ts`, `diff.ts`,
`lifecycle.ts`, and `ownership.ts` for zero functional gain, and would contradict
goal 4/7 (reuse the existing reversible machinery unchanged). The reviewer's
"render as pre-step" reading is the intended one.

### 5.2 `HostModule` gains a `render` surface

```ts
type RenderedArtifact =
  | { kind: 'file-body'; content: string }      // claude/opencode: full .md
  | { kind: 'config-value'; value: unknown }    // codex: [agents.<name>] TOML table

interface HostRenderer {
  // Host-specific header FIELDS (bare, no fences) for an agent IR.
  renderHeader(ir: AgentIr, overrides: AgentOverride | undefined): Record<string, unknown>;
  // Host-specific "resolved tool names" block (§5.3), or null when none.
  renderToolNames(ir: AgentIr, overrides: AgentOverride | undefined): string | null;
  // Compose header + prose + tool-names into the host's concrete artifact.
  render(ir: AgentIr, prose: string, overrides: AgentOverride | undefined): RenderedArtifact;
}

interface HostModule {
  host: string;
  detect(ws: string): boolean;
  scopePaths(scope: HostScope): ScopePathMap;
  surfaces: SurfaceMap;
  render?: HostRenderer;      // NEW — optional, additive
  toolNaming?: ToolNamingMap; // NEW — host naming RULE only (see 5.3)
}
```

**Delimiter contract.** `renderHeader()` returns *bare fields* (a
`Record<string, unknown>`), never a fenced block. The host's `render()` owns the
fence: frontmatter hosts emit `---\n<yaml fields>\n---\n<prose>\n<toolNames>`;
codex emits a TOML fragment. No caller composes a `---` separator by hand, so
there is no doubled/missing-fence ambiguity.

**Serialization mandate.** Header assembly MUST go through a real serializer
(`js-yaml` for frontmatter, `@iarna/toml` or equivalent for TOML), never
hand-concatenated strings — IR string fields (`name`, `description`) are
untrusted content that could otherwise break a YAML fence (`:` / newline) or
inject a TOML key. `validate` additionally asserts IR header fields are
header-safe (no raw newlines in single-line fields).

Renderers are **pure functions of (IR, override, host, host-module data, relative
render tokens)** so the rendered bytes are deterministic — a precondition for the
existing content-addressed ledger/checksum machinery to keep working unchanged.

### 5.3 Tool-name mapping (the "tool naming" section, rendered not handwritten)

This is the subtle half the gap-analysis did not cover. The prose must never name
a host-prefixed tool. Instead the renderer maps **logical** tool references to
**concrete** callables in three layers, only one of which is host-owned:

1. **Prose** references logical names only (`SEARCH`, `memory_recall`,
   `list_providers`; built-ins `read`/`bash`/`webfetch`).
2. **Host naming rule (host module owns).** Each host contributes only the
   *structural* convention, never server-specific strings:
   - claude: MCP callable = `mcp__<serverKey>__<toolName>` (underscore-joined,
     snake_cased); built-ins capitalized (`Read`, `Bash`, `Write`, `Edit`,
     `WebFetch`, `WebSearch`).
   - opencode: MCP callable = `tools["<serverKey>"].<toolName>` (or
     `tools.<serverKey>.<toolName>`); built-ins lowercase (`read`, `bash`).
   - codex: tool access via the TOML `[agents.<name>]` tool list, not callable
     prefixes; built-ins by codex's own tool names.
   This is the analogue of the existing `McpConfig.keyPath()` per-host builder.
3. **Server-specific prefix (data, not host code).** The concrete server key —
   e.g. claude's `agent_browser_search_mcp_source` for the search server, or
   `memory-server` — is **not derivable from (host, logicalName)**. It is the
   MCP server's own registration identity, supplied as **data**: the manifest's
   per-host override (`render.<host>.toolMap`). Never a hardcoded string in the
   host module — hardcoding `agent_browser_search_mcp_source` there would
   reintroduce exactly the baked-in host-specific name this spec removes.

   For determinism, the override is the **sole render-time source**: the renderer
   reads no external mutable state (no other MCP manifests, no live server
   registry). An authoring convenience may *populate* `toolMap` from a server's
   own manifest at `soxe init` time, but the resolved keys are then **pinned into
   the committed manifest** so the §7.3 CI diff stays machine-independent.

`renderToolNames()` emits a **short, generated** "resolved tool names" block
injected into the rendered artifact, listing logical → concrete for *that* host.
It replaces the hand-maintained section. The agent's memory-fallback path is
similarly rendered from a **logical token** (`render.<host>.fallbackPath`) — see
§7 determinism note.

### 5.4 Install-time composition

`declarativeInstall()` for `type: "agent"` becomes a render-then-dispatch:

```
artifact = host.render.render(ir, prose, overrides)   // RenderedArtifact
if artifact.kind === 'file-body':
    scratch = write(artifact.content)                 // deterministic scratch file
    file-drop(srcPath = scratch → <host>/agents/<id>.md)   // claude / opencode
else:  // 'config-value'
    config-merge(artifact.value → codex [agents.<name>])   // codex
```

- **claude / opencode (file-body):** the renderer emits the complete `.md`
  (fenced frontmatter + prose + generated tool-names block); the rendered string
  is materialized to a deterministic scratch file and the existing file-drop
  places it. Downstream machinery (ledger, ownership, unowned-file guard, dry-run
  planning, hash idempotency) is untouched — only the source bytes differ.
- **codex (config-value):** the renderer emits the `[agents.<name>]` TOML table;
  the prose body lands in the table's prompt/instructions field
  (**`instructions`** — or the confirmed field per §10.4), and
  `description`/`model`/tool list populate the other table keys. The existing
  config-merge writes it.

---

## 6. Manifest schema changes (`libs/manifest/src/schema.json`)

1. **Fix the dual-source drift (BL-623), not a missing enum.** `opencode` is
   already accepted by the runtime (inlined `ManifestSchema` + `KNOWN_HOSTS`).
   The real fix is a **parity test** asserting `schema.json` deep-equals the
   inlined `ManifestSchema` (or generating one from the other at build time), then
   reconciling the two copies (three hosts; one `install.additionalProperties`
   posture). No "add opencode to the enum" change is needed — it is already there
   in the authoritative copy.
2. Add the **`agent`** IR object (`name`, `description`, `model`, `temperature`,
   `mode`, `tools` (string | symbolic-object), `permission` (`action |
   pattern→action` union)).
3. Add the **`render`** map: keys = host name; each value validated by a
   **per-host subschema** (`render.claude` → claude-agent-header.schema.json,
   `render.opencode` → opencode-agent-header.schema.json, `render.codex` →
   codex-agent-toml.schema.json). These are the "typed config formats" the user
   asked for — a machine-checkable spec of each host's header, owned by the host
   module, so a new host ships its own header schema with its renderer.
4. `entrypoint` for `agent` now points at the **prose-only** body; a manifest with
   `agent`/`render` blocks must NOT carry frontmatter in its entrypoint
   (validate-time invariant, cross-checked in §7).

---

## 7. Validation (authoring + install + CI)

1. **`soxe validate <id>`** — renders the agent for every host in `install.hosts`
   and asserts:
   - opencode/claude: frontmatter parses as YAML and required keys are present;
   - codex: the produced TOML fragment parses and is a valid `[agents.<name>]`;
   - rendered bytes are **identical across two runs** (determinism);
   - IR header fields are **header-safe** (§5.2 serialization mandate).
2. **Install-time** — a renderer that throws, or whose output fails the host's
   parse check, aborts the install **before** writing (mirrors the existing
   `.mcp.json` denial-before-write ordering).
3. **CI gate** — extend the existing registry drift gate to render every
   registered agent for every declared host and diff against the committed
   artifact; a host whose committed `.md` no longer matches `render(ir)` fails,
   catching exactly the researcher-class drift (three copies, none canonical).
4. **Determinism vs machine-specific paths.** Any path folded into the rendered
   output (e.g. `fallbackPath`) MUST be a **relative logical token** — never an
   absolute path — otherwise the committed-artifact CI diff (§7.3) becomes
   machine-dependent and reintroduces the drift this spec removes. Absolute
   paths, where a host genuinely needs them, are resolved at install time and
   never persisted in the rendered artifact.

---

## 8. Backward compatibility & migration

- **Raw passthrough.** An `agent` manifest with neither an `agent` IR block nor a
  `render` block keeps today's verbatim file-drop. No existing extension breaks.
- **`researcher` first.** Migrate the researcher agent as the reference
  implementation: author `agent.md` (prose, logical names), put the IR in
  `extension.json`, drop `researcher.md` + `researcher-claude.md`, delete the
  claude-agents `install.source` reference. Prove `soxe install researcher
  --host=claude` and `--host=opencode` each produce a header the host accepts
  (live probe, per CONTRIBUTING §4). Closes **BUG-027**.
- **codex parity** (gap-analysis G5) falls out of the same renderer — the codex
  TOML renderer is the first non-frontmatter renderer and the proof that the
  abstraction isn't Claude/opencode-shaped.
- **FEAT-SOX-004** — superseded by this spec. Its `install.frontmatter` overlay is
  the narrow special case: `render.<host>` **is** `install.frontmatter` plus the
  tool-name and codex-Toml machinery that item explicitly deferred. (Transition
  FEAT-SOX-004 to SUPERSEDED/CLOSED on acceptance of this spec, not before.)

---

## 9. Non-goals (explicit)

- Not changing the `mcp-server` `McpConfig` builder path (§1).
- Not adding the `provider` type (gap-analysis G2) — separate decision.
- Not reconciling the two registries (G4) or publishing `soxe` to npm (G3).
- Not introducing a templating engine (handlebars/jinja). Rendering is
  **structural string assembly** (via real YAML/TOML serializers, §5.2), not
  template interpolation — the IR/override merge is a shallow typed merge,
  deliberately not a general template language, to keep determinism and
  auditability.
- Not introducing a new `CapabilityId` (§5.1).

---

## 10. Open questions for the reader

1. Should the **logical tool map** live in the host module (for sox-owned MCP
   servers) *and* the manifest (for third-party servers), or should there be a
   single source of truth? (§5.3 — leaning: host module owns the *rule*, the
   concrete server key is data pinned in the manifest.)
2. Does `temperature`/`mode` belong in the shared IR when only opencode consumes
   them, or should they be opencode-only overrides? (Leaning: IR, ignored by
   hosts that don't support them — §4.4.)
3. Should `render-drop` also apply to **skills** (gap-analysis G7 — validate
   skill frontmatter per host), or is skill a pure shared-SKILL.md file-drop that
   stays untouched? (Leaning: skills stay file-drop; only *validation* is added.)
4. **Exact codex agent TOML field name** for the prompt/instructions body
   (`instructions` vs `prompt` vs `system_prompt`) — to be confirmed against the
   codex agent schema at implementation time (§5.4).

---

## Appendix — Usability features to weigh (seed list, non-exhaustive)

Candidate features the rendering layer makes cheap and which a reviewer should
stress-test:

- `soxe render <id> --host=claude` — print the rendered agent without installing
  (debug/audit).
- `soxe validate --all-hosts` — matrix view of "which hosts does this extension
  render cleanly for".
- Round-trip import: `soxe init agent --from @claude-agents/researcher.md`
  reverse-renders an existing host-authored `.md` into IR + prose (closes G4 for
  agents).
- Per-host `description`/`model` drift warning when a render override disagrees
  with the IR.
- `render.<host>.version` ↔ registry `version` reconciliation report (the two
  independent version axes surfaced in §4.3 naming note).
