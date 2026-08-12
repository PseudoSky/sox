# sox-ingest — Ingest an external source into sox-ecosystem

**Skill id:** `sox-ingest`
**Type:** `skill`
**Status:** active — first declarative skill extension; exercises [dod.1] and [dod.13]

---

## When to use this skill

Use this when an agent is told "ingest `<source>` into sox" — port an external repo, file, or
directory into sox-ecosystem as one or more born-conformant extensions. Load this skill and run
the flow below. No bespoke prompts are needed; per-type and per-operation specifics are delegated
to `references/`.

---

## Invocation guidance

**Input:** a source identifier — a file path, directory path, or repo URL describing the external
content to ingest.

**Output:** one or more born-conformant extensions under `extensions/<type>/<id>/`, a rebuilt
`registry/index.json`, and zero regressions in `nx run-many -t build,lint,test`.

**Call convention:** load this skill file, follow the flow step by step, and consult
`references/by-type.md` and `references/by-operation.md` for per-type scaffolding and per-phase
specifics. Never skip a step; each step gates the next.

---

## The ingestion flow

### Step 1 — Initialize (discover + classify)

Before writing any code, establish ground truth:

1. Read `DOD.md`, `docs/guidelines/`, and the per-type guideline for the target type (see
   `references/by-type.md` for which guideline covers which source shape).
2. Walk the source and inventory every candidate: name, source path, runtime
   (node/shell/python/declarative-markdown), external deps, and resources touched
   (fs/network/socket) — this drives the future `permissions` block.
3. Map each candidate to one of the 7 extension types (`agent`, `skill`, `mcp-server`, `prompt`,
   `hook`, `command`, `bundle`). Flag decision points (type is ambiguous, composition is
   unresolved) before proceeding — see `references/by-type.md` for the decision heuristics.
4. Find a working reference extension of the same type already in `extensions/` and note its
   layout, `extension.json` shape, and how it declares `permissions`. Mirror it exactly.

Gate: every candidate is mapped to a type (or explicitly marked `decision-needed`).

### Step 2 — Generalize + author (scaffold born-conformant)

For each candidate:

1. Scaffold with the generator — never hand-roll the layout:

   ```
   node bin/soxe init <type> <id>
   ```

   or, when the generator's `--content` / `--from` option is available:

   ```
   node bin/soxe init <type> <id> --content @<source-file>
   node bin/soxe init skill <id> --from @<source-dir>
   ```

   The generator is the single scaffolder (`libs/authoring`); born-conformance is not optional.
   See `references/by-operation.md` §scaffold for flags and layout expectations per type.

2. Port the logic / content into the scaffolded entrypoint:
   - Code types (`hook`, `command`, `mcp-server`, code `agent`): move behavior verbatim into the
     entrypoint; adapt to the ecosystem's event/adapter contract (per the type guideline).
   - Declarative types (`skill`, declarative `agent`): carry frontmatter + body verbatim; map
     frontmatter fields to manifest fields; preserve instructions byte-for-byte.

3. Declare permissions in `extension.json` — every fs/network/socket resource the extension
   actually touches; undeclared access is DENIED at runtime. See `references/by-type.md` for
   the minimum permission set per type and `references/by-operation.md` §permissions for
   how to declare them. Be minimal and exact.

Gate: the scaffolded extension matches the reference extension's shape; `validate` exits 0.

### Step 3 — Validate

Run the manifest + entrypoint validator:

```
node bin/soxe validate
```

Fix any errors before proceeding. The validator enforces: required manifest fields, `entrypoint`
presence (built-type extensions), `lifecycle` prohibition on `skill` and `agent`, and `permissions`
block shape. See `references/by-operation.md` §validate for error taxonomy.

Gate: `node bin/soxe validate` exits 0 with no warnings.

### Step 4 — Publish (build + registry)

For built-type extensions (`hook`, `command`, `mcp-server`, code `agent`):

```
./node_modules/.bin/nx run <project>:build
```

Rebuild the registry after any extension source change:

```
npx tsx scripts/build-index.ts
```

(`npx nx run registry:sync-index` runs the same script but triggers a full build sweep and does
NOT forward extra flags — use the direct script for a declarative-only change.)

**Dirty-tree reality (BL-390):** `build-index` REFUSES to run against a dirty working tree —
a checksum computed from uncommitted state is not reproducible from any commit. In a shared
checkout with other agents' in-flight work, commit your own extension files first, then rebuild;
only if the remaining dirt is provably checksum-irrelevant (`docs/`, `.claude/`, `.opencode/`,
`.worktrees/`, `.nx/`, root-level `*.md`) may you use the documented escape hatch
`npx tsx scripts/build-index.ts --allow-dirty` (stamps every entry `provisional: true`).

`registry/index.json` must be current before install. See `references/by-operation.md` §build
for type-specific build notes.

Gate: `nx run <project>:build` exits 0; `registry/index.json` includes the new extension.

### Step 5 — Install & replace in place

**Replace-in-place rule:** if the target host already has an install of the same id — a previous
version, a stale copy, a partial migration — **uninstall it FIRST, then install from the registry.**
Install is additive (`cpSync force`): it overwrites matching files but leaves stale/orphan files
behind, so an in-place overwrite silently ships a polluted host directory. Uninstall removes the
whole discovery dir; the fresh install then writes exactly the extension's files.

**`--dry-run` IS honored (declarative host path):** `soxe install <id> --host=<h> --scope=<s> --dry-run`
prints the would-place targets and writes NOTHING — no files, no ledger, no ownership index, no
lockfile. Use it to preview a placement (including `SOX_SANDBOX_ROOT` rerooting) before the real
install. Not supported on the no-host config/lockfile resolver path.

For declarative types (`skill`, `agent`, `command`), place the extension at the host's
discovery path using the `--host` flag:

```
# 1. If an install of this id already exists at the target host, remove it first:
node bin/soxe uninstall <id> --host claude --scope user
node bin/soxe uninstall <id> --host opencode --scope user

# 2. Sandboxed install into a temp dir (validates the path before touching real config)
T=$(mktemp -d)
node bin/soxe install <id> --host claude --scope project --root "$T"
node bin/soxe install <id> --host opencode --scope project --root "$T"
# Verify the file landed:
find "$T" -name "SKILL.md"   # or AGENT.md / command file, per type

# 3. Real installs (writes into ~/.claude/ and ~/.config/opencode/)
node bin/soxe install <id> --host claude --scope user
node bin/soxe install <id> --host opencode --scope user
```

For process-managed types (`mcp-server`, `hook`, `command` with side-effects), use the
config/lockfile resolver path (no `--host`):

```
node bin/soxe install <id> -s project
```

**Verify replace-in-place (declarative types):** compare the installed directory against the
extension directory — every extension file present and byte-identical, and ZERO leftover files
at the target (any extra file means a stale install survived; remove it or document why it stays).
See `references/by-operation.md` §install for details.

Gate: install exits 0; target byte-identical to the extension dir for all extension files;
no leftover files at the target.

### Step 5.5 — Exercise the install (per-host load test)

File placement is not proof the host can use the skill. For declarative types, prove discovery
and loading in a FRESH host process — never the session that ran the install:

```
# opencode (discovers ~/.config/opencode/skills/<id>/SKILL.md)
cd "$(mktemp -d)"
opencode run "Use the skill tool to load the skill '<id>'. Report its version line and
whether scripts/<companion> resolves in its base directory. Do NOT execute it."

# claude (discovers ~/.claude/skills/<id>/SKILL.md)
cd "$(mktemp -d)"
claude -p "Load the skill '<id>' installed at user scope. Report its version line and the
first sentence of its primary section. Do NOT execute it."
```

Assert: each host's fresh process loads the installed artifact and reports the version /
frontmatter that matches the extension's `SKILL.md` — i.e. the bytes the host loaded ARE the
extension bytes. (Claude's sandbox may deny reads outside the project dir; in that case the
loaded SKILL.md content is the assertion and file presence is confirmed with `ls` directly.)
If a skill body references its own install path (e.g. a companion script), confirm that path
resolves on the host it was loaded from — this is where a host-specific absolute path in the
body shows up as a defect.

Gate: every target host's fresh-process probe loads the installed artifact and reports the
extension's version.

### Step 6 — Enable

For process-managed extensions (`mcp-server`, `hook`):

```
node bin/soxe start <id>
```

Confirm the runtime reports RUNNING (`soxe list` shows the pid/state). For declarative types,
install IS enablement — no start step needed; the enablement proof is Step 5.5 (fresh-process
load test), not file placement. See `references/by-type.md` §enable per type.

Gate: runtime state is RUNNING (process types) or the host's fresh process loads the artifact
(declarative types, Step 5.5).

### Step 7 — Remove old / clean up (preserve-then-clean)

After validating the new extension:

1. **Preserve before deleting — never delete the only copy of a file.** Superseded/legacy files
   (old versions, orphaned siblings in host install dirs, pre-migration artifacts) are copied
   into a committed archive first — e.g. `docs/research/<id>/` for skill history, or the source
   repo if it is already versioned — plus a scratch backup (`cp -R <dir> /tmp/<id>-migration-backup`).
   Only then remove the originals from the live install dirs (via `soxe uninstall` + fresh
   install, per Step 5 — never ad-hoc `rm` of host dirs).
2. Verify no regression: `./node_modules/.bin/nx run-many -t build,lint,test` stays green.
3. Confirm zero orphan processes: `node bin/soxe stop <id>` leaves no lingering pids.

Gate: superseded files exist in a committed archive; live install dirs contain ONLY the
extension's files (verified in Step 5); `nx run-many -t build,lint,test` exits 0;
`soxe stop` leaves zero orphans.

---

## Input contract

| Field | Type | Description |
|-------|------|-------------|
| `source` | `string` | Path or URL to the external content (file, directory, or repo). |
| `type` | `string \| "auto"` | Target extension type; `"auto"` triggers Step 1 classification. |
| `id` | `string` | Proposed extension id (kebab-case); may be refined after Step 1. |
| `scope` | `"org" \| "user" \| "project" \| "local"` | Install scope; default `project`. |

---

## Output contract

| Field | Type | Description |
|-------|------|-------------|
| `extensions` | `string[]` | Paths of created extension directories. |
| `registry_rebuilt` | `boolean` | Whether `registry/index.json` was regenerated. |
| `deleted_sources` | `string[]` | Source files removed after migration (if any). |
| `evidence` | `Record<string, string>` | Captured output per lifecycle stage. |

---

## Failure modes

| Symptom | Likely cause | Resolution |
|---------|-------------|------------|
| `validate` rejects manifest | Missing required field; wrong type for a field | Read the per-type guideline and mirror the reference extension's `extension.json` exactly |
| Build exits non-zero | TypeScript error or missing dependency | Fix the TS error; check the reference extension's `tsconfig.json` |
| Install denied at runtime | Undeclared `permissions` | Declare the exact resource path(s) in `extension.json`; re-run install |
| `soxe list` shows no extension | Registry not rebuilt after source change | Run `npx tsx scripts/build-index.ts`; re-install |
| Decision point blocked | Type mapping is ambiguous | Read `references/by-type.md` §decision-points; stop and report if product-level |
| Lint fails after migration | New files violate ESLint config | Check the project ESLint config; adjust only the new files |

---

## Performance characteristics

- Steps 1-3 (initialize to validate): typically less than 5 minutes for a single extension.
- Step 4 (build): depends on `nx` cache; incremental builds are fast.
- Full batch ingest (multiple extensions + all types): run in waves of 3-5 per type; full suite
  `nx run-many -t build,lint,test` after each wave.

---

## References

Per-type scaffolding heuristics and decision points:
-> [`references/by-type.md`](./references/by-type.md)

Per-operation command details (scaffold, validate, build, install, permissions):
-> [`references/by-operation.md`](./references/by-operation.md)
