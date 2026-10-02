# setup — declare the project's capability bindings

The `setup` playbook of the `project` skill (`SKILL.md`). Its one job is the capability binding;
everything else a project needs already lives in its instruction file.

## The binding section (the canonical format)

Insert this section into `AGENTS.md`:

```markdown
## Capabilities

Concrete bindings for the capability names agents use. Change these per project; agent
bodies never name a tool. An absent row = the capability is unavailable here.

| capability    | tool | usage |
|---|---|---|
| backlog       | backlog | `backlog` skill |
| memory        | memory-server | `memory-usage` skill |
| code-intel    | gitnexus | `gitnexus-guide` skill |
| search        | search | — |
| agent-catalog | agent-mcp | — |
```

Columns:

- **capability** — the abstract key an agent body references. Never a tool name. **It must equal
  the `logical` name an installed agent's manifest declares** — the manifests are the source of
  truth for this column, not your own invention.
- **tool** — the `server` id that manifest binds that `logical` to. The host prefixes it
  (`tools["memory-server"].memory_recall` on opencode, `mcp__memory-server__memory_recall` on
  Claude); an agent body never writes a prefix, and this column carries the bare id. (So
  `code-intel` binds to server `gitnexus`; the logical name is the capability, the server id is the
  tool.)
- **usage** — the lazily-loaded skill that documents the verbs and calling convention; `—` when no
  skill documents the surface.

Two absence semantics, both load-bearing:

- **Row absent → the capability is unavailable in this project.** Surface it and stop. Never
  substitute a different tool and never invent a surface. (The tool-starvation failure —
  `b5670d03`: a tool-starved agent fabricated 22 item ids, ~19M tokens.)
- **Row present with an empty `tool` → the capability does not apply here.** Proceed without it.
  This is ADR-0017's present-but-empty scope: selects nothing, decided, not missing.

## Procedure

1. **Derive candidate rows from the installed agents — this is the tie to `soxe install`.**
   Read every installed agent's `extension.json` under the project and collect each
   `agent.tools` entry of the form `{ "logical": <capability>, "server": <tool> }`. The `logical`
   name is the `capability` key; the `server` is the `tool`. `soxe install` renders the same pair
   into the agent body as its resolved tool names, so the section and the installed agents cannot
   disagree. Cross-check each `server` appears in the project's host config (`opencode.json` `mcp`
   block, `.mcp.json`).
2. **Cover the vocabulary, add nothing else.** The section has exactly one row per distinct
   `logical` name the installed agents declare. Do not add a key no manifest declares; do not
   drop a key one does. Ask the user only when a manifest declares a `logical` whose `server` is
   not present in the project's host config.
3. **Write the section** into `AGENTS.md`. If `CLAUDE.md` is a separate file (not a symlink to
   `AGENTS.md`), write the identical section there. Replace an existing `## Capabilities` section
   wholesale — never append a second one; leave every other line of the file untouched.
4. **Verify.** For each row: the `tool` id appears in the project's host config, and the `usage`
   skill exists on the host. Re-read both files and confirm exactly one `## Capabilities` section
   each.

## What this playbook is not

- It does not install tools or skills — it records which existing ones satisfy which capability.
- It does not name tools in agent bodies — that is exactly what the binding exists to avoid.
- It does not invent a capability to fill the table — an absent row is a truthful row.

## Failure modes

- **Guessing a tool the project does not have.** Every `tool` value must be sourced from the
  host config, never from memory of what a tool is "usually" called.
- **Writing the binding into an agent body.** The binding is project state; the body is generic.
- **Duplicating the section.** Replace, never append.
- **A capability key that is not a manifest `logical`.** The section mirrors the installed agents;
  a key with no manifest declaring it is drift, and a manifest `logical` with no row tells agents
  the capability is unavailable when it is not.
