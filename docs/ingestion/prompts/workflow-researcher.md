# Hand-off prompt — `workflow-researcher` agent

| | |
|---|---|
| **Source** | `~/dev/ai/claude-agents/categories/workflow/agents/workflow-researcher.md` |
| **Target type** | `agent` |
| **Proposed id** | `workflow-researcher` |
| **Status** | drafted — source not yet read by prompt author |

> Agents are **declarative** (a markdown definition: frontmatter — name/description/tools/model —
> plus a system prompt). Enforcement for declarative/in-process types is SOFT. "Run" for an agent
> means it installs to its host-discovery target (e.g. `~/.claude/agents/`) and is invocable.

---

```text
You are building a new extension for the "sox-ecosystem" project — an LLM-extension
ecosystem monorepo (7 types: agent, skill, mcp-server, prompt, hook, command, bundle) with a
CLI (`bin/sox`) and an nx build, at:

    /Users/nix/dev/ai/sox-ecosystem        (work on branch: feat/nx-migration)

YOUR TASK
Port this agent definition into a born-conformant sox-ecosystem extension of type `agent`:

    SOURCE: ~/dev/ai/claude-agents/categories/workflow/agents/workflow-researcher.md

It must go init → build → validate → install → run (= install to its host-discovery target and be
invocable) with ZERO manual conformance work, preserving the agent's definition exactly.

STEP 1 — GROUND TRUTH FIRST (read before writing anything; do not assume conventions)
  a. `/Users/nix/dev/ai/sox-ecosystem/DOD.md` — the bar.
  b. `/Users/nix/dev/ai/sox-ecosystem/docs/guidelines/` — read the `agent` guideline in full
     (esp. the install-target / host-discovery placement, e.g. `~/.claude/agents/<id>.md`, and the
     manifest fields an agent uses).
  c. A WORKING REFERENCE AGENT — CAUTION, the `agent` type is overloaded: `memory-organizer` (the
     existing agent) is a CODE agent (`runtime: node`, an `entrypoint` exporting a function —
     `function-export` invocation), which is a DIFFERENT shape from a DECLARATIVE markdown agent.
     workflow-researcher is a declarative markdown agent (frontmatter + system prompt, installs to a
     host-discovery target like `~/.claude/agents/`, `runtime: declarative`, no entrypoint). So study
     memory-organizer only for manifest conventions, but for the actual shape follow the `agent`
     GUIDELINE's declarative path + the install-target flex in `libs/manifest`. If no declarative
     agent exists yet in `extensions/`, you may be the first — flag that so the founder can confirm
     the guideline/generator cover the declarative-agent shape. Do NOT give this agent a `lifecycle`
     block: the runtime ignores agent lifecycle (it is declared-unimplemented).
  d. `/Users/nix/dev/ai/sox-ecosystem/libs/manifest` — manifest schema incl. install-target +
     `permissions`. Read-only.
  e. `node bin/sox --help` — real CLI surface. `nx` not on PATH; use `./node_modules/.bin/nx`.
  f. The SOURCE: read `workflow-researcher.md` fully — its frontmatter (name, description, the
     `tools` list, model) and its entire system prompt. Note any resources its prompt references.

STEP 2 — SCAFFOLD BORN-CONFORMANT (do not hand-roll the layout)
    node bin/soxe init agent <chosen-id>        # alias: `new`  (id e.g. `workflow-researcher`)
(or the nx generator the guideline names). Confirm it lands in the correct `extensions/<...>/`
location and matches `memory-organizer`'s shape.

STEP 3 — PORT THE DEFINITION
Carry the source's system prompt VERBATIM and map its frontmatter (name/description/tools/model)
to the ecosystem manifest fields. Do not rewrite or summarize the prompt — an agent's behavior IS
its prompt; preserve it byte-for-byte where the format allows.

STEP 4 — PERMISSIONS (declarative = SOFT)
An agent definition typically declares the *tools* it may use (a capability list), not fs/socket
access. Map that to whatever the manifest/guideline expects. Add a `permissions` block only if the
agent's prompt implies concrete resource access; otherwise none. Be honest and minimal.

STEP 5 — PROVE THE LIFECYCLE AGAINST REALITY (not just unit tests)
  1. `./node_modules/.bin/nx run <project>:build`        → builds clean.
  2. `node bin/soxe validate` (--strict if available)     → manifest + entrypoint reachability pass.
  3. Install into a sandboxed scope (temp dir + `-s project --config=... --lockfile=...`), then
     confirm the agent definition is actually placed at its host-discovery target (e.g. appears at
     `~/.claude/agents/<id>.md`) and is discoverable/invocable — verify the real file on disk.
  4. `node bin/soxe uninstall <id> ...` cleanly removes it.
Capture real command output as evidence.

CONSTRAINTS
- Only touch the new extension's files + required registry updates; if you change an extension's
  source, regenerate the registry checksum (find the build-index step). Run nx via
  `./node_modules/.bin/nx`, the CLI via `node bin/sox`. Conventional commits; do not merge to main.
- If reality contradicts the guideline, STOP and report rather than guessing.

DEFINITION OF DONE
- A born-conformant `agent` extension reproducing workflow-researcher's definition (prompt +
  metadata) exists, mirroring memory-organizer's shape.
- It passes init → build → validate → install (placed at host-discovery target, verified on disk)
  → uninstall, each reality-verified with captured output.
- No regression (`./node_modules/.bin/nx run-many -t build,lint,test` green).
- You report: chosen id + path, how frontmatter mapped to the manifest, any permissions declared
  and why, and the evidence per stage.
```
