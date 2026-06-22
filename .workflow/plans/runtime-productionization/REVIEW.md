# REVIEW — CLI User-Testing Notes

**Recorded:** 2026-06-15  
**Source:** first real manual test of the sox CLI by the project owner  
**Branch:** feat/nx-migration  

Items marked **[BUG]** are defects. Items marked **[DESIGN]** are architectural/UX questions
that need a decision before fixing. Items marked **[CLEANUP]** are housekeeping.

---

## `sox list`

**[BUG]** Shows both project-scope and user-scope items with no indication of which is which,
despite being invoked with `--scope=user`. Should only show extensions for the requested scope.

**[BUG]** No filter flags — cannot filter by status (RUNNING / INACTIVE) or by extension id.
Should support at minimum `--status=running` and a positional `<id>` filter.

**[BUG]** `source` field in output shows `file://` prefix and truncates the path. Should
display the path cleanly (no scheme prefix, no truncation, or a deliberate short form with
`--verbose` for the full path).

---

## `sox start`

**[DESIGN]** No way to selectively start a single extension — `sox start` always boots
everything in the lockfile for the scope. `sox stop --id=<ext>` already supports selective
stop, so `sox start --id=<ext>` should be symmetric. Decide: is selective start a first-class
operation or does it stay scope-level only?

**[DESIGN]** No `--daemon` flag. Starting the runtime occupies the terminal with no indication
of where output goes. Expected behaviour: `--daemon` (or default) detaches and prints the log
file path so the user knows where to follow output. A foreground `--follow` mode for debugging
would pair with this.

**[BUG]** No log path shown at start — user has no way to know where runtime output goes after
calling `sox start`. At minimum the startup message should print the log file path.

---

## `sox install`

**[BUG]** `sox install sox-ingest --scope=project` installs sox-ingest but also re-resolves and
lists the full memory bundle alongside it. This is correct behaviour (the bundle is in
`extensions.json` and is re-resolved on every install) but it looks like the bundle is being
installed as a side effect of installing sox-ingest. The output should clearly distinguish
between "newly added" and "already present / refreshed" entries.

**[BUG / DESIGN]** `--update` help text implies it only refreshes hashes, but the expectation
is that it re-resolves to the latest available version. Clarify: does `sox install --update`
bump versions or only rehash? If only rehash, it needs a `sox update` or `--bump-version` flag
for actual upgrades.

---

## `sox uninstall`

**[OBSERVATION]** `sox uninstall sox-ingest --scope=project` correctly removed only sox-ingest
without touching the memory bundle. Selective uninstall works as expected.

---

## `sox search`

**[BUG]** Description is truncated too aggressively. Should show more of the description, or
use a two-line layout with full description on the second line.

**[BUG]** Extension type (`mcp-server`, `agent`, `bundle`, etc.) is not shown in search
results. Should be a visible column or tag.

---

## `sox exec`

**[BUG]** `sox exec --help` does not display help text — exits silently or falls through to
the wrong path. Every verb must respond to `--help`.

**[BUG]** `sox exec` with no arguments (or wrong arguments) does not show the list of
extension IDs that are available to exec. The error should include something like:
"Available extensions in runtime: memory-server, memory-organizer, ..."

**[BUG — CRITICAL]** `sox exec --id memory-server --tool list` crashes with:
```
ReferenceError: module is not defined in ES module scope
    at file:///Users/nix/dev/ai/sox-ecosystem/.sox/ext/memory-server/index.js:42540:1
```
Root cause: the memory-server bundle at `.sox/ext/memory-server/index.js` is built as
CommonJS (esbuild `module.exports` output) but Node.js v24 treats it as ESM because the
repo's root `package.json` contains `"type": "module"`. The bundled file needs either:
- A sibling `package.json` with `{"type":"commonjs"}` in the extraction directory, OR
- The esbuild target changed to ESM format (`--format=esm`), OR
- The file renamed to `.cjs` at bundle time.
This is a showstopper — `sox exec` cannot call any tool on memory-server in the current state.

**[BUG]** Stack traces from bundled extensions (e.g. `index.js:42540`) are useless without
source maps — line 42540 of a minified bundle tells you nothing. All extension bundles must
be built with source maps enabled (`--sourcemap` in esbuild, or equivalent) so that Node.js
crash output and debugger sessions resolve back to the original TypeScript source locations.
This applies to every code-type extension (`mcp-server`, `service`, `command`) that goes
through the esbuild bundle pipeline.

---

## Stale / Junk Extensions in the Registry

**[CLEANUP]** The following four extensions are scaffolding debris that survived from type-conformance
testing and were never given real content. All should be deleted from disk and the registry
rebuilt programmatically (not by hand-editing `registry/index.json`).

| id | directory | problem |
|----|-----------|---------|
| `dep-inject` | `extensions/commands/di-command` | Empty scaffold stub. `src/index.ts` does `echo "Command di-command: …"`. No real DI logic. Directory name doesn't match id. |
| `dep-injector` | `extensions/skills/di-skill` | Empty scaffold stub. `SKILL.md` is the unfilled `sox init` template. Duplicate concept with `dep-inject` (same keyword, different type). Directory name doesn't match id. |
| `di-codex` | `extensions/skills/di-codex-skill` | Same empty scaffold as `dep-injector`, targeting Codex. Directory name doesn't match id. |
| `forbidden-access` | `extensions/skills/forbidden-skill` | **Keep, but relocate.** This is an intentional permission-enforcement test fixture used by the e2e suite. It should be moved to `extensions/fixtures/` or `tests/fixtures/` and excluded from the public registry so it doesn't appear in `sox search` or `sox install`. |

**[DESIGN]** The registry is currently rebuilt by running `npx tsx scripts/build-index.ts` by
hand after any extension is added or removed. This should be:
- A pre-commit hook that auto-rebuilds whenever anything under `extensions/` changes, OR
- A CI gate that fails if `registry/index.json` is out of sync with disk, OR
- Both. The current state where the registry can silently drift from the filesystem is what
  caused `test-runner` to linger after its directory was deleted in a prior session.

---

## Conceptual / Architectural

**[DESIGN] sox CLI itself not findable or installable.**  
The sox CLI (`apps/sox`) is the host runtime's own binary but it does not appear in `sox search`
and cannot be installed via `sox install`. For a self-hosting ecosystem the CLI should be
discoverable and version-pinnable like any other extension.

**[DESIGN] Bundle vs subpackage surfacing.**  
All memory bundle subpackages (`memory-server`, `memory-organizer`, `memory-flush`, `memory-cli`)
appear as independently searchable, installable, and startable extensions. Users should only
need to interact with `sox-memory-bundle`. The individual pieces imply they are separately
usable services, which they are not (they are co-dependent subsystems).

Proposed model:
- An `installable: false` / `visibility: internal` flag on subpackages that hides them from
  `sox search` and `sox install` unless `--include-internal` is passed.
- `sox search` shows a bundle entry that lists the types it includes
  (e.g. `[bundle] sox-memory-bundle — includes: mcp-server, hook, command, agent`).
- `sox start` and `sox stop` on a bundle operate on all its members atomically.
- Direct install/start of a bundle member shows a helpful error:
  "memory-server is part of sox-memory-bundle — install the bundle instead."

---

---

## Implementation Groups

Synthesized from all notes above. Ordered by dependency and risk — earlier groups unblock later ones.

---

### Group 1 — Catalog & Registry Integrity
*Pure cleanup + automation. No design decisions required. Safe to do immediately.*

- Delete `dep-inject` (`extensions/commands/di-command`), `dep-injector` (`extensions/skills/di-skill`), `di-codex` (`extensions/skills/di-codex-skill`) — empty scaffold debris
- Relocate `forbidden-access` (`extensions/skills/forbidden-skill`) to `extensions/fixtures/` and exclude it from the public registry and `sox search`
- Add a CI gate (or pre-commit hook) that fails if `registry/index.json` is out of sync with the actual `extensions/` tree — the hand-rebuild step that allowed `test-runner` to linger must be automated

---

### Group 2 — Build Pipeline: ESM/CJS Fix + Source Maps
*Unblocks `sox exec` entirely. The critical crash is here.*

- Fix the CommonJS/ESM packaging mismatch for extracted extension bundles: bundles built with `module.exports` land under `.sox/ext/` where the root `package.json` `"type":"module"` causes Node.js to reject them. Fix: emit a `{"type":"commonjs"}` `package.json` sidecar at extraction time, or switch the esbuild target to ESM
- Enable source maps for all code-type extension bundles (`mcp-server`, `service`, `command`) — `--sourcemap=linked` in esbuild so `.js.map` sidecars are generated and copied alongside the bundle into `.sox/ext/`
- Ensure the extraction step copies both the bundle and its `.map` file

---

### Group 3 — `sox exec` Polish
*Depends on Group 2 (exec must not crash before UX can be evaluated).*

- Fix `sox exec --help` — currently exits silently instead of printing help text
- On argument errors, print the list of extension IDs currently in the runtime record ("Available: memory-server, memory-organizer, …") so the user knows what they can target
- Validate `--tool` against the extension's declared tools list and suggest valid tool names on mismatch

---

### Group 4 — CLI Output Quality: `list`, `search`, `install`
*Pure display changes. No design decisions, no behavior changes. Low risk, high user-facing impact.*

- `sox list`: honour `--scope` filter (currently shows all scopes), add `--status=running` filter, strip `file://` from source paths, no truncation (or `--verbose` for full path)
- `sox search`: show extension type as a column or tag, expand description to two lines or increase width, exclude `visibility: internal` extensions (after Group 1 adds that flag)
- `sox install`: distinguish "newly added" from "already present / re-verified" in output so re-resolving the bundle doesn't look like a side-effect install; clarify `--update` semantics in help text (hash-pin refresh vs version bump are different operations)

---

### Group 5 — Process Management UX: `start`, `stop`, logs
*Partially depends on the runtime-productionization SCOPE.md design (daemon mode, log files). The log path display is a quick win that can ship before the full daemon design is done.*

- Print the log file path in `sox start` output immediately — even if logs currently go to terminal, state where they will go or that they follow stdout
- Add `--daemon` flag to detach the process and print the log path; pair with `sox logs --id=<ext> [--follow]`
- Add `--id=<ext>` to `sox start` for selective start, symmetric with `sox stop --id=<ext>`

---

### Group 6 — Bundle Visibility Model
*Design-first. Requires a decision on the `visibility`/`installable` field before any code. Touches install-engine, search, start/stop, and the registry schema. Highest cross-cutting impact.*

- Define `visibility: internal | public` (or `installable: false`) in the extension schema
- Mark all bundle member extensions (`memory-server`, `memory-organizer`, `memory-flush`, `memory-cli`) as `visibility: internal`
- `sox search` shows only public extensions by default; `--all` includes internal
- `sox install <member-id>` blocks with "this extension is part of <bundle-id> — install the bundle instead"
- `sox start <bundle-id>` and `sox stop <bundle-id>` operate on all members atomically
- `sox search` bundle entries list their member types inline
- Register the sox CLI itself (`apps/sox`) as a discoverable extension in the registry

---

## Items Fixed This Session

| Item | Status |
|------|--------|
| `hello-world` stale lockfile entry (project-scope + user-scope) | ✅ removed |
| `test-runner` extension deleted from disk + registry rebuilt (11 entries) | ✅ removed |
| `sox install <id> --scope=<s>` silently ignored the id — now writes it to `extensions.json` first | ✅ fixed in `bin/sox` |
| `sox install sox-ingest --scope=project` → install + uninstall verified end-to-end | ✅ verified |
