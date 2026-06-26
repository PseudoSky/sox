# Handoff packet — sox workspace layout & standards for the nx workspace generator

**To:** the team building the nx workspace generator that hooks all generation + enforces standards.
**From:** plan-orchestrator (memory-refactor engagement).
**Purpose:** fold the sox `area/group` layout + per-package standards into your generator so *all*
library/package generation is born-conformant. This packet is the **spec**; the companion
`scripts/scaffold-data-packages.mjs` is a stopgap that produces the same output until your generator
ships, and should be retired in favor of `nx g @adhd/sox-nx:library --area … --group …`.

## 1. The layout — two-level `area/group/package`
```
libs/<area>/<group>/<package>/        e.g. libs/data/embed/embedding-provider/
```
- **areas:** `platform` · `data` · `shared`
- **groups (by area):**
  - `platform/`: `contract` · `distribution` · `host` · `runtime` · `protocol` · `authoring` · `devtools`
  - `data/`: `embed` · `inference`(reserved, no member yet) · `vectors` · `graph` · `store`(reserved) · `search` · `analysis` · `ingest`
  - `shared/`: `codec`
- Generator flags: `--area <area> --group <group>` (both required for libs). Reject unknown area/group.

## 2. Per-package born-conformance contract (what the generator MUST stamp)
**`package.json`**
- `name`: `@adhd/sox-<package>` — **DECOUPLED from folder path.** A rename/move must NEVER change the
  published name (it's the registry/content-address key — changing it breaks integrity).
- `sox: { area, group, concerns: string[], invariants: string[], entrypoints: string[] }` — structured
  metadata the routing-index generator harvests (see §5). Required on every package.
- esbuild self-contained build conventions: `main`/`exports` → `./dist/index.js`, `files: ["dist"]`,
  `engines: { node: ">=20" }` (native-carrier packages override to `>=22`).
- Publish posture: default **public** (`private:false` + `publishConfig.access:"public"`) for `data/*`
  and `shared/*` (the reuse goal) — but **make this a flag** (`--public`/`--private`); the publish
  *action* stays owner-gated regardless. (Owner decision on data/* public-vs-private is pending; default
  the scaffold to public-ready to match the reuse intent, flip per package as directed.)

**`project.json`**
- nx `tags`: `["area:<area>", "group:<group>", "type:lib"]` (or `type:extension`/`type:app`).
- targets: `build` (esbuild self-contained via the shared bundler — externalize native `.node` deps,
  inline `@adhd/sox-*`), `lint`, `test` — wired to the project's own tsconfig/outDir (never bare tsc).

**Files:** `src/index.ts`, `tsconfig.json`(+`tsconfig.lib.json`), `README.md`, and a `CLAUDE.md` stub
(group-level rules placeholder — the agent-routing layer, §5).

## 3. Module-boundary enforcement (extend `@nx/enforce-module-boundaries`)
Today the rule keys only on `type:lib|app|extension`. Add `area:*`/`group:*` depConstraints:
- `area:data` may depend on `area:data` + `area:shared` — **NOT** `area:platform`.
- `area:platform` may depend on `area:platform` + `area:shared`.
- `area:shared` may depend on **only** `area:shared` (pure, leaf).
- (Optionally tighten intra-area: e.g. `group:search` → `group:vectors`/`group:embed`, not the reverse.)
A synthetic `data→platform` import MUST fail lint — that's the acceptance test.

## 4. Registry / born-conformance hooks the generator must preserve
- Any code-type package that ships a `dist` is checksummed in `registry/index.json` → after generation,
  `npx nx run registry:sync-index` must leave the drift gate green (`check-registry-sync`).
- `build-index.ts` ↔ `check-registry-sync.ts` are a **byte-mirror pair (BL-33)** — if generation adds a
  new scanned dir/type, update BOTH identically.
- Born-conformance for extensions: `dist/index.js` exists + `node --check` passes.

## 5. Routing-index contract (the generator feeds it; a separate target builds it)
- The generator stamps `sox:{area,group,concerns,invariants,entrypoints}` (§2) — that metadata is the
  **source of truth** the routing index is generated from.
- A `map.json` + `INDEX.md` (root + per-area) are **generated** from the nx graph + `sox.*` (with a
  drift gate) — never hand-maintained. The generator's job is only to stamp the metadata; building the
  index is a separate target (in this refactor's Part C).

## 6. The current generator (your starting point)
- `packages/sox-nx/src/generators/{library,extension}` (+ each `schema.json`) — thin adapters over
  `libs/authoring`. Add `--area`/`--group` to the schemas; stamp tags + `sox.*` + path placement.
- Boundary lint lives in `eslint.config.js` (`@nx/enforce-module-boundaries`, currently `type:`-only).
- `libs/authoring` is the portable scaffold core (FileSet) — keep generation logic there; `sox-nx` is
  the nx adapter (this is the `authoring` vs `devtools` split).

## 7. Acceptance for "the generator enforces standards"
1. `nx g sox-nx:library --area data --group vectors my-thing` → package at `libs/data/vectors/my-thing/`
   with name `@adhd/sox-my-thing`, `sox.{area:data,group:vectors}`, tags `area:data`+`group:vectors`,
   esbuild build target, public-ready package.json.
2. `registry:sync-index` green; `check-registry-sync` green.
3. A hand-written `import '@adhd/sox-<a-platform-pkg>'` from a `data/*` package fails boundary lint.
4. The routing-index generator picks up the new package from its `sox.*` metadata with zero hand-editing.
