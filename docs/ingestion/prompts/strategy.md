# Hand-off prompt — `strategy` skill

| | |
|---|---|
| **Source** | `~/dev/ai/claude-agents/tools/skills/strategy/SKILL.md` (+ any sibling files in that dir) |
| **Target type** | `skill` |
| **Proposed id** | `strategy` |
| **Status** | drafted — source not yet read by prompt author |

> Skills are **declarative** (markdown + frontmatter, possibly with resource files). Enforcement
> for declarative/in-process types is SOFT (declare + audit, no OS isolation). "Run" for a skill
> means it installs to its host-discovery target and is discoverable — there is no process to spawn.

---

```text
You are building a new extension for the "sox-ecosystem" project — an LLM-extension
ecosystem monorepo (7 types: agent, skill, mcp-server, prompt, hook, command, bundle) with a
CLI (`bin/sox`) and an nx build, at:

    /Users/nix/dev/ai/sox-ecosystem        (work on branch: feat/nx-migration)

YOUR TASK
Port this skill into a born-conformant sox-ecosystem extension of type `skill`:

    SOURCE: ~/dev/ai/claude-agents/tools/skills/strategy/SKILL.md   (and any sibling files)

It must go init → build → validate → install → run (= install to its host-discovery target and
be discoverable) with ZERO manual conformance work, preserving the skill's content and metadata.

STEP 1 — GROUND TRUTH FIRST (read before writing anything; do not assume conventions)
  a. `/Users/nix/dev/ai/sox-ecosystem/DOD.md` — the bar.
  b. `/Users/nix/dev/ai/sox-ecosystem/docs/guidelines/` — read the `skill` guideline in full
     (especially the install-target / host-discovery placement: where skills install, e.g.
     `~/.claude/skills/<id>/`, and the manifest fields a skill uses).
  c. A WORKING REFERENCE SKILL: find an installed `skill`-type extension under `extensions/`
     and mirror its layout + manifest. IF NONE EXISTS YET (this is the first skill), follow the
     skill guideline strictly and treat the generator's born-conformant output as the template —
     and flag that you are the first skill so the founder can confirm the guideline is complete.
  d. `/Users/nix/dev/ai/sox-ecosystem/libs/manifest` — manifest schema incl. install-target and
     `permissions`. Read-only.
  e. `node bin/sox --help` — the real CLI surface. `nx` is not on PATH; use `./node_modules/.bin/nx`.
  f. The SOURCE: read `strategy/SKILL.md` (its frontmatter + body) AND every sibling file in the
     dir. Note the frontmatter fields (name/description/etc.), any referenced resource files, and
     anything the skill instructs that implies a resource (a path it tells the model to read/write).

STEP 2 — SCAFFOLD BORN-CONFORMANT (do not hand-roll the layout)
    node bin/sox init skill <chosen-id>        # alias: `new`  (id e.g. `strategy`)
(or the nx generator the guideline names). The scaffolder produces the conformant skeleton; you
fill in content, you do not invent structure. Confirm it lands in the correct `extensions/<...>/`
location and matches the reference skill's shape.

STEP 3 — PORT THE CONTENT
Move the SKILL.md body + frontmatter into the scaffolded skill, mapping the source's frontmatter
to the ecosystem manifest fields. Carry over sibling resource files into the layout the guideline
specifies. Preserve the skill's instructions verbatim — do not paraphrase its guidance.

STEP 4 — PERMISSIONS (declarative = SOFT)
If the skill's instructions imply the model will touch specific files/resources, declare a
`permissions` block accordingly; a pure instructional skill with no resource side effects may need
none. Be honest and minimal. Verify against the schema.

STEP 5 — PROVE THE LIFECYCLE AGAINST REALITY (not just unit tests)
  1. `./node_modules/.bin/nx run <project>:build`        → builds clean.
  2. `node bin/sox validate` (--strict if available)     → manifest + any entrypoint reachability pass.
  3. Install into a sandboxed scope (temp dir + `-s project --config=... --lockfile=...`), then
     confirm the skill is actually placed at its host-discovery target (e.g. the files appear under
     `~/.claude/skills/<id>/` or wherever the guideline says) and is discoverable — verify the real
     files on disk, not a log line.
  4. `node bin/sox uninstall <id> ...` cleanly removes the placed files.
Capture real command output as evidence.

CONSTRAINTS
- Only touch the new extension's files + required registry updates; if you change an extension's
  source, regenerate the registry checksum (find the repo's build-index step). Run nx via
  `./node_modules/.bin/nx`, the CLI via `node bin/sox`. Conventional commits; do not merge to main.
- If reality contradicts the guideline, STOP and report rather than guessing.

DEFINITION OF DONE
- A born-conformant `skill` extension reproducing strategy's content + metadata exists.
- It passes init → build → validate → install (placed at host-discovery target, verified on disk)
  → uninstall, each reality-verified with captured output.
- No regression (`./node_modules/.bin/nx run-many -t build,lint,test` green).
- You report: chosen id + path, how frontmatter mapped to the manifest, any permissions declared
  and why, whether this is the first skill (and any guideline gaps found), and the evidence per stage.
```
