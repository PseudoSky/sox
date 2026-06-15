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
   node bin/sox init <type> <id>
   ```

   or, when the generator's `--content` / `--from` option is available:

   ```
   node bin/sox init <type> <id> --content @<source-file>
   node bin/sox init skill <id> --from @<source-dir>
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
node bin/sox validate
```

Fix any errors before proceeding. The validator enforces: required manifest fields, `entrypoint`
presence (built-type extensions), `lifecycle` prohibition on `skill` and `agent`, and `permissions`
block shape. See `references/by-operation.md` §validate for error taxonomy.

Gate: `node bin/sox validate` exits 0 with no warnings.

### Step 4 — Publish (build + registry)

For built-type extensions (`hook`, `command`, `mcp-server`, code `agent`):

```
./node_modules/.bin/nx run <project>:build
```

Rebuild the registry after any extension source change:

```
npx tsx scripts/build-index.ts
```

`registry/index.json` must be current before install. See `references/by-operation.md` §build
for type-specific build notes.

Gate: `nx run <project>:build` exits 0; `registry/index.json` includes the new extension.

### Step 5 — Install

For declarative types (`skill`, `agent`, `command`), place the extension at the host's
discovery path using the `--host` flag:

```
# Sandboxed install into a temp dir (avoids polluting real project config)
T=$(mktemp -d)
node bin/sox install <id> --host claude --scope project --root "$T"
# Verify the file landed:
find "$T" -name "SKILL.md"   # or AGENT.md / command file, per type

# Real project install (writes into the current workspace's .claude/)
node bin/sox install <id> --host claude --scope project

# User-scope install (writes into ~/.claude/)
node bin/sox install <id> --host claude --scope user
```

For process-managed types (`mcp-server`, `hook`, `command` with side-effects), use the
config/lockfile resolver path (no `--host`):

```
node bin/sox install <id> -s project
```

Confirm the install target is present on disk (declarative types: file at host-discovery path;
code types: entrypoint accessible). See `references/by-operation.md` §install for details.

Gate: install exits 0; install target verified on disk (use `find` or `ls`).

### Step 6 — Enable

For process-managed extensions (`mcp-server`, `hook`):

```
node bin/sox start <id>
```

Confirm the runtime reports RUNNING (`sox list` shows the pid/state). For declarative types,
install IS enablement — no start step needed. See `references/by-type.md` §enable per type.

Gate: runtime state is RUNNING (process types) or file is at discovery path (declarative types).

### Step 7 — Remove old / clean up

After validating the new extension:

1. If migrating FROM existing docs/prompts: delete the source files once their content is
   captured in the extension and references (this step was performed for `docs/ingestion/`).
2. Verify no regression: `./node_modules/.bin/nx run-many -t build,lint,test` stays green.
3. Confirm zero orphan processes: `node bin/sox stop <id>` leaves no lingering pids.

Gate: `nx run-many -t build,lint,test` exits 0; `sox stop` leaves zero orphans.

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
| `sox list` shows no extension | Registry not rebuilt after source change | Run `npx tsx scripts/build-index.ts`; re-install |
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
