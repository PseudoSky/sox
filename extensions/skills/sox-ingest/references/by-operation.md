# sox-ingest references — by operation

> Delegated from `SKILL.md`. This file answers: "for each step in the ingestion flow, what
> exactly do I run, what flags are available, what does the output look like, and what errors
> am I likely to see?" One section per operation.

---

## §scaffold — Scaffolding born-conformant extensions

**Principle:** the scaffolder produces the conformant skeleton; you fill in logic, you do not
invent structure. Born-conformance is enforced at init time.

**CLI:**

```bash
node bin/soxe init <type> <id>              # basic scaffold
node bin/soxe init <type> <id> --content @<source-file>   # pull body from source (hook/command/agent)
node bin/soxe init skill <id> --from @<source-dir>        # dir-shaped source (SKILL.md + siblings)
```

- `nx` is NOT on PATH; use `./node_modules/.bin/nx`
- The CLI is `node bin/sox` from the repo root
- Use kebab-case ids (e.g. `swarm-cost`, `workflow-researcher`, `sox-ingest`)
- The scaffold lands under `extensions/<type-dir>/<id>/`; confirm it matches the reference
  extension's shape before filling in logic

**Type directory mapping:**

| Type | Directory |
|---|---|
| `agent` | `extensions/agents/<id>/` |
| `skill` | `extensions/skills/<id>/` |
| `mcp-server` | `extensions/mcp-servers/<id>/` |
| `prompt` | `extensions/prompts/<id>/` |
| `hook` | `extensions/hooks/<id>/` |
| `command` | `extensions/commands/<id>/` |
| `bundle` | `extensions/bundles/<id>/` |

**`--content @<path>` / `--from @<dir>` (generator P5 primitive):** when available, this pulls
the source content directly into the scaffold and records `source: <path>` provenance in the
manifest so `soxe update` can re-pull from origin. Until P5 lands, scaffold plain, then paste the
body manually. The invariant is the same: never hand-roll the directory layout.

**Post-scaffold checklist:**

- [ ] Extension directory exists under `extensions/<type-dir>/<id>/`
- [ ] `extension.json` has all required fields (id, version, type, title, description,
      compatibility, license)
- [ ] Shape matches the reference extension of the same type
- [ ] For built types: `src/index.ts` (or equivalent) exists
- [ ] For skill type: `SKILL.md` exists

---

## §validate — Running the manifest validator

```bash
node bin/soxe validate            # validate all extensions
node bin/soxe validate --strict   # stricter checks (if available)
```

**What the validator checks:**

- Required manifest fields: `id`, `version`, `type`, `title`, `description`, `compatibility`,
  `license`
- `entrypoint` present for built-type extensions (`hook`, `command`, `mcp-server`, code `agent`)
- `lifecycle` block is PROHIBITED on `skill` and `agent` types
- `permissions` block shape conforms to the schema
- `members` array present on `bundle` type

**Common errors and fixes:**

| Error | Fix |
|---|---|
| `missing required field "entrypoint"` | Add `"entrypoint": "dist/index.js"` for built types; omit entirely for declarative types |
| `lifecycle block not allowed on type 'skill'` | Remove the `lifecycle` key from `extension.json` |
| `invalid permissions shape` | Verify `fs.read`, `fs.write` are string arrays; `socket.paths` is a string array; `network.outbound` is a string array |
| `type field mismatch` | Ensure `"type"` matches the directory the extension lives in (e.g. skill in `skills/`) |
| `id mismatch` | `"id"` must match the directory name exactly |

---

## §permissions — Declaring resource access

Permissions are declared in `extension.json` under the `"permissions"` key. Undeclared access
is DENIED at runtime — C6 enforcement applies at the resource sink before the OS resource.

**Shape:**

```json
{
  "permissions": {
    "fs": {
      "read":  ["~/.memory/**", "~/dev/ai/claude-agents/**"],
      "write": ["~/.memory/**"]
    },
    "socket": {
      "paths": ["~/.memory/memoryd.sock"]
    },
    "network": {
      "outbound": ["api.anthropic.com", "${EXTERNAL_API_HOST}"]
    }
  }
}
```

**Guidelines:**

- Use `~/<relative>` globs for home-relative paths (the schema accepts this form)
- Use `${ENV_VAR}` refs for dynamic hosts/paths set via environment
- Prefer the narrowest glob that covers real access — `~/dev/ai/**` not `/**`
- A pure declarative skill with no resource side effects may use `"permissions": {}`
- For a security tool (e.g. tokenguard, policy-enforcer), be exhaustive — its fs/network/socket
  footprint must be declared precisely; an incorrect block either breaks it or hides its footprint
- `permissions.socket.paths` covers Unix domain sockets; TCP ports go in `network.outbound`

**Per-type minimum:**

| Type | Minimum permissions |
|---|---|
| `hook` (code) | Every file glob read/written + every socket path connected; no network unless the hook calls out |
| `skill` (declarative) | Empty `{}` for pure instruction skills; populate only if the skill body directs the model to read/write specific paths |
| `agent` (declarative) | Map `tools` list to `capabilities`; add `permissions` only if the prompt implies concrete resource access |
| `mcp-server` | All socket/port bindings + every client connection; all fs paths the server reads/writes |
| `command` | Argv-driven; declare the fs paths the command reads/writes at runtime |
| `bundle` | Members carry their own permissions; bundle manifest may use `"permissions": {}` |

---

## §build — Building compiled extensions

Only built-type extensions need a build step: `hook`, `command`, `mcp-server`, code `agent`.
Declarative types (`skill`, declarative `agent`, `bundle`) have no build step.

```bash
./node_modules/.bin/nx run <project-name>:build
```

where `<project-name>` matches the `name` field in `project.json` (usually the extension id).

**TypeScript configuration:** mirror the reference extension's `tsconfig.json`. Do not emit JS
files under `src/` — the build outputs to `dist/` only.

**nx cache:** builds are cached; use `--skip-nx-cache` to force a rebuild:

```bash
./node_modules/.bin/nx run <project>:build --skip-nx-cache
```

**Registering a new extension in the registry:** see
[AGENTS.md § registry is release-only](../../../../AGENTS.md#registry-is-release-only) and §registry
below.

**Build errors:**

| Error | Fix |
|---|---|
| `tsc: error TS2307: Cannot find module '@adhd/sox-...'` | Check `package.json` `dependencies`; run `pnpm install` if a new dep was added |
| `dist/index.js: no such file` | Build did not run or TSConfig emitDeclarationOnly is set; check `tsconfig.json` |
| `nx: project not found` | Confirm `project.json` exists in the extension root and `"name"` matches the id |

---

## §install — Installing extensions

Two install paths depending on extension type:

### Declarative types: `skill`, `agent`, `command`, `rules`

Use `--host` to place the extension at the host's discovery path (file-drop):

```bash
# 0. REPLACE-IN-PLACE: if an install of this id already exists, uninstall it first.
#    Install is additive (cpSync force) — it overwrites matching files but leaves stale
#    orphans behind. Uninstall removes the whole discovery dir; fresh install writes exactly
#    the extension's files. Never overwrite a live install in place.
node bin/soxe uninstall <id> --host claude --scope user
node bin/soxe uninstall <id> --host opencode --scope user

# Sandboxed install into a temp dir (avoids polluting real project config)
T=$(mktemp -d)
node bin/soxe install <id> --host claude --scope project --root "$T"
node bin/soxe install <id> --host opencode --scope project --root "$T"

# Verify the file landed on disk:
find "$T/.claude" -type f
find "$T/.opencode" -type f

# Real user-scope installs (writes into ~/.claude/ and ~/.config/opencode/)
node bin/soxe install <id> --host claude --scope user
node bin/soxe install <id> --host opencode --scope user
```

**`--dry-run` IS honored on the declarative host path** (`--host` present): prints the would-place
targets and writes NOTHING (no files, no ledger, no ownership, no lockfile). Use it to preview a
placement before the real install; combine with `--root <dir>` / `SOX_SANDBOX_ROOT` to see sandboxed
paths. Not supported on the no-host config/lockfile resolver path.

**Flags for declarative path (`--host` present):**

| Flag | Meaning |
|---|---|
| `<id>` | Positional — extension id (required) |
| `--host <name>` | Host to install on: `claude`, `codex`, `opencode` |
| `--scope <scope>` | Install scope: `project` (default), `user` |
| `--root <dir>` | Override workspace root (for sandboxed testing) |
| `--profile <name>` | Profile variant to apply (optional) |

**Verification after declarative install:**

- **Byte parity:** every file in the extension dir exists at the target AND is byte-identical
  (`cmp`/`diff`), and the target has ZERO leftover files beyond the extension's set. Any extra
  file means a stale install survived — uninstall + reinstall, or document why it stays.
- File is at the host-discovery target on disk (e.g.
  `$T/.claude/skills/<id>/SKILL.md` for project-scoped skills,
  `~/.claude/agents/<id>.md` for user-scoped agents)
- **Load test (declarative types):** prove the host actually discovers + loads the artifact in a
  FRESH process — `opencode run "Use the skill tool to load the skill '<id>' ..."` and
  `claude -p "Load the skill '<id>' ..."` from a scratch dir. The probe must report the
  version/frontmatter that matches the extension's entrypoint. File presence alone is not proof.
- No `soxe list` entry is created — declarative types activate at the host level,
  not via the soxe process registry

### Process-managed types: `mcp-server`, `hook`

Use the config/lockfile resolver path (no `--host`):

```bash
# Project scope (writes to .extensions/extensions.json)
node bin/soxe install <id> -s project

# User scope
node bin/soxe install <id> -s user
```

**After install — registry.** See [AGENTS.md § registry is release-only](../../../../AGENTS.md#registry-is-release-only)
and §registry below — an unregistered extension still installs fine from its local dir (no
checksum gate); register it only per that rule.

---

## §lifecycle — Reality-verifying the full lifecycle

"Done" for an ingested extension means it actually runs the full lifecycle with captured output:

```
init -> build -> validate -> install -> start -> (observed behavior) -> stop
```

For declarative types the lifecycle is:

```
init -> validate -> install (= enable) -> (files verified on disk) -> uninstall
```

**Capturing evidence per stage:**

1. `nx run <project>:build` output — "0 errors, 0 warnings"
2. `soxe validate` output — "OK" or clean exit
3. `soxe install ...` output — "installed at scope"
4. `soxe list` output — extension present with correct state
5. For process types: `soxe start <id>` output + PID; for declarative types: `ls` of
   the host-discovery target showing the file present
6. For process types: trigger the observable behavior and capture real output (not a
   self-written log); for hook types: confirm the hook fires on its declared event
7. `soxe stop <id>` output; `ps` or equivalent showing zero orphans

**Non-negotiable principle:** a passing unit test is NOT acceptance. Derive the contract from
this repo's ground truth (`DOD.md`, `docs/guidelines/`, the manifest schema); prove done against
reality, not tests.

---

## §registry — Registering an extension in the registry index

A new/harvested extension needs **no registry step**. An extension with no `registry/index.json`
row installs straight from its local dir (`findLocalExtension`, no checksum gate —
`libs/install-engine/src/install.ts:733-740`). See
[AGENTS.md § registry is release-only](../../../../AGENTS.md#registry-is-release-only) for what may
write `registry/index.json` and when — a local `dist` rebuild never touches it, and `build-index`/
`registry:sync-index` are not part of ingesting a new extension.

**Batch gate:** after every wave of ingestions (no registry step needed), run:

```bash
./node_modules/.bin/nx run-many -t build,lint,test
./node_modules/.bin/nx run host-runtime:test-e2e
```

Both must exit 0 before the next wave starts.

---

## §operating-principles — Cross-cutting rules

These apply at every phase of every ingestion. They are not optional.

1. **Ground truth over memory.** Derive every contract from this repo's `DOD.md`,
   `docs/guidelines/`, the manifest schema, and a working reference extension of the same
   type — never from assumption.

2. **Reality-verify, don't trust tests.** "Done" for an extension = it actually
   `init -> build -> validate -> install -> start -> runs -> stops cleanly`, with captured output.
   A green unit test is not acceptance.

3. **Born-conformant only.** Always scaffold via the generator; never hand-roll layout. If the
   generator can't produce a conformant skeleton for a case, that's a generator gap to fix in
   sox-ecosystem first — not a thing to paper over per-extension.

4. **Declare permissions (C6).** Every ingested extension declares the exact fs/network/socket it
   uses; undeclared access is denied at runtime. Under-declaring breaks the extension at run time.

5. **No regression.** After every batch, `./node_modules/.bin/nx run-many -t build,lint,test`
   stays green and the lifecycle e2e (`./node_modules/.bin/nx run host-runtime:test-e2e`) passes.

6. **One source of bookkeeping.** Track per-extension status in a catalog table (not in prose
   scattered across commits).

7. **If reality contradicts the guideline, STOP and report.** Never guess or paper over a
   discrepancy between docs and what a reference extension actually does.
