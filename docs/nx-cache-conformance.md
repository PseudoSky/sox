# nx cache conformance — `dependsOn`, `inputs`, and dependency-aware caching

A correctness convention for this monorepo, learned the hard way (BL-44). Read this
before adding or editing any `build`/`test`/`lint` target in a `project.json` or in a
generator that emits one (`libs/authoring/src/templates/**`, `packages/sox-nx`).

## The one-sentence rule

**Cache policy lives in `nx.json` `targetDefaults` — never narrow it in a `project.json`.**
A project-level `inputs` array **replaces** (does not merge with) the targetDefaults; a
narrow override silently drops dependency-awareness, and the cache starts lying.

## Why a task's cache must be dependency-aware

nx caches a task by hashing its **inputs**. For the cache to be *correct*, that hash must
change whenever anything that could change the task's result changes — including the
**source of upstream dependencies**. There are two independent mechanisms, and a target
needs at least one:

1. **`inputs` with a `^` entry** — e.g. `"^production"`. The `^` means "this same named
   input, taken from every project dependency." So `^production` folds every upstream
   project's production source into this task's hash. Change `memory-core/src/x.ts` →
   `memory-server`'s test hash changes → cache invalidates.
2. **`dependsOn: ["^build"]`** — declares the task depends on its dependencies being built
   first. This does two things: (a) the upstream `build` task's hash becomes part of this
   task's hash (dependency-aware by transitivity), **and** (b) it guarantees the upstream
   `dist/` is freshly rebuilt before this task runs.

`(b)` matters here specifically because **tests resolve `@adhd/sox-*` to each dep's built
`dist/index.js`** (a static vitest alias, see BL-4). Without `dependsOn: ["^build"]`, even a
correctly-*invalidated* test re-runs against **stale dist** — the invalidation is hollow.
So `test` needs **both**: `^production` (invalidate) **and** `^build` (run against fresh dist).

## The repo policy (authoritative — `nx.json` `targetDefaults`)

```jsonc
"build": { "cache": true, "dependsOn": ["^build"], "inputs": ["production", "^production"] }
"test":  { "cache": true, "dependsOn": ["^build"], "inputs": ["default",    "^production"] }
"lint":  { "cache": true,                          "inputs": ["default", "{workspaceRoot}/eslint.config.js"] }
```

- `production` excludes specs (`!**/*.spec.ts`) — a build need not bust on a test-only edit.
- `default` = all project files (+ shared globals); `test` uses it so a change to the
  project's own spec, fixture, `vitest.config.ts`, or `vitest.setup.ts` invalidates too.
- `lint` is intentionally **not** dependency-aware — it only reads the project's own files.

## Rules for any `project.json` (and any generator that writes one)

- **Prefer to omit `inputs`/`dependsOn` entirely** on `build`/`test`/`lint` — inherit the
  targetDefaults. That keeps one source of truth and is always correct.
- **If you must add a project-specific input** (e.g. a cross-project parity reach-in that has
  no nx graph edge, like `libs/install-engine` reading `libs/host-runtime/src/data-paths.ts`),
  **append it to the full dep-aware set** — never replace the set with a narrow subset:
  ```jsonc
  "inputs": ["default", "^production", "{workspaceRoot}/libs/host-runtime/src/data-paths.ts"]
  ```
- **Never** write `"inputs": ["{projectRoot}/src/**/*.ts"]` on a cacheable `build`/`test`
  target. It looks like a tidy optimization; it is a correctness bug (the BL-44 footgun).
- A `build` target that overrides `inputs` is *partly* saved by its inherited
  `dependsOn: ["^build"]`, but a `test` target with neither `^`-input nor `^build` is
  **fully dependency-blind**.

## Enforcement

`node tools/check-nx-cache.js` scans every `project.json` and **fails** if a cacheable
`build`/`test` target overrides `inputs` without a `^`-prefixed entry and without
`dependsOn` containing `^build`. Wire it into the same gate as the other reality checks.

## The incident (BL-44)

All 15 `test` targets had hand-narrowed `inputs: ["{projectRoot}/src/**/*.ts", …]`, dropping
`^production` and declaring no `dependsOn`. Proven: changing `memory-core/src` left
`nx test memory-server` a **cache hit** despite the known dependency edge — a stale green.
Fixed by restoring `["default", "^production"]` on every test target and adding
`dependsOn: ["^build"]` to the `test` targetDefault. This doc + `tools/check-nx-cache.js`
exist so it cannot silently come back.
