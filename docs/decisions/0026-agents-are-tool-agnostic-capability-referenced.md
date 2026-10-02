# ADR-0026 — Agents reference capabilities, never third-party tool names

**Status:** Accepted (2026-10-02).
**Owner:** pseudosky (authored by the agent-manager agent).
**Relates to:** ADR-0002 (extension install model), ADR-0003 (extension identity is
content-addressed), ADR-0011 (backlog tool write destination), ADR-0013 (feature switches are
typed config, not env vars), ADR-0017 (present-but-empty filter scope selects nothing).
**Does NOT authorize:** editing `@adhd/backlog` or any external tool package; adding a resolution
verb to `soxe`; storing a per-agent binding file.

## Context

An agent body is written once and installed to many projects. A body that names a concrete tool
(`backlog_create`, `memory_recall`, `gitnexus_impact`, `mcp__backlog__*`, the `adhd-backlog` CLI)
is therefore wrong in any project where a *different* tool satisfies the same need — and the user's
directive is explicit that this is the normal case: *"tools can be different project to project."*
The user's standing requirement: *"Backlog needs to be a generic concept when referenced in these
agents … we need to write agents in a way that they are agnostic to 3rd party tools but clearly
stear the processes to a point where they would intuitively use the correct one."*

The boundary this ADR enforces **already exists and is bypassed**. The `backlog` skill
(`~/.claude/skills/backlog/SKILL.md`, name `backlog-usage`) declares itself *"the ONLY place the
command surface and calling convention are documented — `AGENTS.md`/`CLAUDE.md` carry just a
pointer to it."* The concrete-name home is a lazily-loaded skill; the agent bodies were supposed to
point at it, not restate its contents.

**The bypass, measured fresh (2026-10-02):** 68 matches for the pattern
`backlog_|memory_|gitnexus_|mcp__|adhd-backlog|memory-server_` across `extensions/agents/**`, in
**12 agent bodies**: `debug/debug.md` (6), `doc-evangelist` (2), `doc-steward` (2), `architect`
(3), `typescript` (4), `researcher/agent.md` (22), `doc-cartographer` (2), `doc-reviewer` (1),
`org-agent` (3), `agent-manager` (3), `performance` (4), `product` (3). Precedents: two agents

One body already carries the correct shape — `researcher/agent.md:53,60` instructs the agent to
reference memory tools *"by their logical names … Never hardcode a specific prefix."* Three
(`product`, `typescript`, `performance`) carry a hedged half-measure ("confirm the exact tool name
against your own available tools"). The rest hardcode. The failure this has already produced is
filed: a global instruction file invented a backlog field that did not exist (`fdc16986`), and a
tool-starved agent fabricated 22 item ids rather than failing (`b5670d03`, ~19M tokens).

## Decision

### D1 — Agent bodies reference capabilities, never tool names

A capability is a stable, host-neutral *name for a need*: `backlog`, `memory`, `code-intel`. An
agent body says *"record this in the backlog"*, never *"call `backlog_create`"*. No host-qualified
prefix (`tools["…"].…`, `mcp__…`), no bare `*_` verb, no tool CLI name, appears in any agent body.

### D2 — The binding is a `## Capabilities` section in the project's instruction file

The capability → tool mapping is **project state**, written once per project in `AGENTS.md` (and
`CLAUDE.md` where it is not a symlink to `AGENTS.md`). No stored JSON, no `.adhd/**` binding file,
no inference from the host's MCP declaration. The canonical section:

```markdown
## Capabilities

Concrete bindings for the capability names agents use. Change these per project; agent
bodies never name a tool. An absent row = the capability is unavailable here.

| capability | tool | usage |
|---|---|---|
| backlog    | backlog | `backlog` skill |
| memory     | memory-server | `memory-usage` skill |
| code-intel | gitnexus | `gitnexus-guide` skill |
```

- **capability** — the abstract key an agent body references.
- **tool** — the **logical server id**, unprefixed. The host prefixes it
  (`tools["memory-server"].memory_recall` on opencode, `mcp__memory-server__memory_recall` on
  Claude); the body never writes a prefix.
- **usage** — the lazily-loaded skill documenting the verbs and calling convention.

The `project-setup` skill (extension, `hosts: [claude, opencode]`) produces and refreshes this
section: it detects candidate bindings from the project's host config (`opencode.json` `mcp` block,
`.mcp.json`), writes the section into both instruction files, replaces any existing section
wholesale, and verifies the tool ids and usage skills resolve.

### D3 — Steering is process-first; the usage skill is the only verb surface

The body states the **need and the process step**; the project's Capabilities section states the
**which tool**; the usage skill states the **how**. This is how the agent "intuitively uses the
correct one" without naming it: the process text leads to the need, the binding resolves the need,
the skill supplies the verb.

### D4 — A guard fails any agent body carrying a raw tool reference

`tools/check-agent-capability-refs.mjs`, registered in `tools/guards-manifest.mjs` with
`watch: ['extensions/agents/']`, fails any agent **body** (the manifest's entrypoint — never
`CHANGELOG.md`/`README.md`/`extension.json`) containing a raw `backlog_*` / `memory_*` /
`gitnexus_*` / `mcp__*` / `adhd-backlog` / `memory-server_*` token. Severity: **block** — this is
an authoring invariant, not a style note. The guard is a detector, so it embeds a self-test
negative control (a pre-fix snippet that must match) and is proven red against today's hardcodes
before it is proven green by the rewrites (BL-225).

### D5 — Per-project variation is the section, and only the section

Because the binding lives in the project file, two projects can bind `backlog` to two different
tools with no change to any agent body. A project with no `## Capabilities` section is a project
whose agents have no bound capabilities — which is defined below.

### D6 — Absent means unavailable; present-but-empty means not applicable

- **Row absent → the capability is unavailable in this project.** The agent surfaces the gap and
  stops. It must never substitute a different tool and never invent a surface (`b5670d03`).
- **Row present with an empty `tool` → the capability does not apply here.** The agent proceeds
  without it. This is ADR-0017's present-but-empty scope: a decided "nothing here", never a missing
  one.

## Consequences

- Agent bodies become portable: one definition installs to every project; the projects differ only
  in their Capabilities section.
- The tool-name surface shrinks to two homes — the project binding section and the lazily-loaded
  usage skill — both of which are meant to name tools. The always-loaded agent body carries none.
- The guard turns the invariant into a build gate, closing the declaration→enforcement gap: a body
  that hardcodes a tool cannot be committed.
- A capability whose tool is renamed has exactly one place to update per project.
- The rewrite removes 68 raw references from 12 bodies, including three that were "hedged" and are
  now made consistent with the already-correct `researcher` pattern.

## Alternatives considered

1. **Hardcode tool names in bodies (status quo).** Rejected — D1: it drifts (`fdc16986` invented a
   backlog field that did not exist) and cannot satisfy per-project variation (`m0209`).
2. **Abstract to nothing — "use an appropriate tool".** Rejected — the user requires the agent to
   *intuitively use the correct one*; a capability with no binding loses the steering.
3. **A new resolution service or `soxe` verb.** Rejected — the integration already exists; the user
   directed conformance to it, not a new surface (`m0226`).
4. **A bespoke `.sox/capabilities.json`.** Rejected — superseded by `m0244` (declare the format in
   `AGENTS.md`/`CLAUDE.md`).
5. **An agent-managed per-agent JSON at `.adhd/sox/agents/*.json`.** Rejected — superseded by
   `m0244`; a stored artifact the agent edits is a second state to drift, where a declared section
   is read by every agent already.
6. **Infer the binding from the host MCP declaration.** Rejected — the declaration names servers,
   not the abstract capability keys a body uses; a project may enable a server without adopting it
   as the capability's tool, and the mapping would be invisible to a reader of the instruction file.

## Open questions (not decided here)

1. **Capability-key vocabulary.** This ADR fixes `backlog`, `memory`, `code-intel` for the bindings
   that exist today; whether a project may mint additional keys, and any naming rule for them, is
   left to `project-setup` and future cases.
2. **Per-agent scoping.** Whether the section should support an optional per-agent column (the same
   capability bound differently for one agent) is not decided; today the binding is project-wide.
3. **Non-MCP tools.** The format assumes the bound tool is addressable as a server id; a
   capability satisfied by a CLI invoked through Bash is not yet covered.

## Acceptance tests (shipped)

- `tools/check-agent-capability-refs.mjs` — detector with a built-in self-test arm; red against the
  pre-rewrite bodies, green after.
- Guard registration in `tools/guards-manifest.mjs` (`watch: ['extensions/agents/']`), verified by
  `node tools/run-guards.mjs --tier1` on a staged agent-body diff.
- `extensions/skills/project-setup/` — the producing skill (SKILL.md, extension.json, package.json,
  README.md, CHANGELOG.md), installed to both hosts and host-load verified.
- A fresh-agent probe: give one rewritten body a task needing the capability with (a) no binding
  section → it surfaces and stops; (b) an empty `tool` → it proceeds without; (c) a bound row → it
  resolves the tool and loads the usage skill.

## Risks

- **Guard false positives on legitimate prose.** A body may need to *explain* the indirection
  without naming a tool; the guard's token set is deliberately narrow (`*_` verbs, `mcp__*`, the
  CLI name) and the fix is to phrase the prose in capability terms — the guard is the constraint
  that forces that phrasing, not an obstacle to it.
- **A vacuous binding.** A project could declare `backlog → backlog` and never install the tool;
  the `project-setup` step 4 verification (tool id in host config, usage skill present) is the
  mitigation.

## The gate

`node tools/run-guards.mjs --tier1` must pass with the new guard applicable to any agent-body
change: a staged change to `extensions/agents/**` that introduces a raw tool reference fails the
commit; removing it passes.

## Acceptance for this ADR itself

This ADR is satisfied when: (1) the guard exists, is registered, and is proven red→green; (2) all
12 hardcoding bodies are rewritten to capability references and the guard is green on `main`; (3)
`extensions/skills/project-setup/` exists, validates, and installs to both hosts; (4) this repo's
`AGENTS.md` carries the `## Capabilities` section binding `backlog`/`memory`/`code-intel`.
