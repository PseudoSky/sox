# p1-layout — Layout enablement (consume the generator, establish the boundary)

> **Slug is identity.** `p1-layout` is immutable.

**Phase:** layout · **Depends on:** `audit-baseline` · **Guard:** see dag.json

---

## Goal

Make the [def:area-group] taxonomy and its module boundaries **real** — without
building the generator (a separate team owns that) and without high-blast-radius folder
moves. After this state: the six `data/*` skeletons exist (born `area:data` + `sox.*`
metadata), the three area depConstraints are lint-enforced, the existing libs are tagged
into the taxonomy in place, and a synthetic `data→platform` import fails `nx lint`.

This is the **enabler** for the extraction phase: the new packages must exist and the
boundary must bite before any code is carved into them.

---

## Semantic Distillation

- **Primitive:** RUN the scaffold (or external generator); EDIT `eslint.config.js`;
  TAG existing libs in place. No code carved yet.
- **Reference Pattern:** [ref:scaffold] (`scripts/scaffold-data-packages.mjs` — already
  written, produces the 6 skeletons conformant to [ref:handoff] §2). The current boundary
  rule lives in `eslint.config.js` (two blocks: `*.ts` and `*.js/.mjs/...`), today keyed
  only on `type:*` with a permissive `{ '*': ['*'] }` catch-all. [shape:depconstraints].
- **Delta Spec:**
  1. **Scaffold the data packages.** Prefer `nx g @adhd/sox-nx:library --area data
     --group <g> <name>` **if the external generator has shipped**; otherwise run
     `node scripts/scaffold-data-packages.mjs`. Result: `libs/data/{embed/embedding-provider,
     vectors/vector-store, graph/graph-store, search/hybrid-search, analysis/analysis,
     ingest/ingest}/` each with `area:data` + `group:*` tags + `sox.*` metadata + a
     compiling skeleton. (`store`/`inference` stay reserved — no skeleton.)
  2. **Add the area depConstraints** to BOTH eslint blocks, inserted **before** the
     `{ sourceTag: '*', onlyDependOnLibsWithTags: ['*'] }` catch-all (the catch-all is
     permissive and stays; the new positive `area:data` allowlist is what makes
     `data↛platform` bite regardless of the target's tags):
     ```js
     { sourceTag: 'area:data',     onlyDependOnLibsWithTags: ['area:data','area:shared'] },
     { sourceTag: 'area:platform', onlyDependOnLibsWithTags: ['area:platform','area:shared'] },
     { sourceTag: 'area:shared',   onlyDependOnLibsWithTags: ['area:shared'] },
     ```
  3. **Tag existing libs in place** ([decision-A] — tags only, NO folder move, NO import
     change, NO registry churn):
     - `area:shared` + `group:codec` → `tokenguard-core`.
     - `area:platform` + group → the 8 platform libs: `manifest`(contract),
       `install-engine`+`registry`(distribution), `host-registry`(host),
       `host-runtime`+`service-proxy`(runtime), `mcp-runtime`(protocol),
       `authoring`(authoring), and `sox-nx`(devtools). *(Verified safe: the platform
       subgraph imports neither memory-core nor memory-enrich, so `area:platform` will
       not red-bar a latent cross-area edge. Run `nx graph`/lint to confirm before
       committing; if a latent edge surfaces, flag the orchestrator rather than force a
       red tag.)*
     - **Leave `memory-core` and `memory-enrich` UNTAGGED by area** ([def:domain-composer])
       — they keep `type:lib` only, so the area rules do not constrain the composer.
  4. If the scaffold introduces a new scanned directory the registry/index walker must
     know about, mirror the change in BOTH `build-index.ts` and `check-registry-sync.ts`
     (BL-33 byte-mirror pair). (Libs are not registry extensions, so typically no change.)
- **Invariants added:** [inv:boundary] (now enforced), [inv:name-decoupled],
  [inv:registry-current] (no drift introduced), [inv:no-regress].
- **Validation:** `nx run-many -t build,lint` green + `audit … --phase layout` (which
  runs the [fix:synthetic-boundary] test in a sandbox).

---

## Acceptance criteria

Checked by `audit-layout`.

- [ ] **[p1-layout.1]** All six `data/*` packages exist at
      `libs/data/<group>/<name>/` with `package.json` `name:"@adhd/sox-<name>"`,
      `sox.{area:"data",group}`, and nx tags `["type:lib","area:data","group:<g>"]`.
- [ ] **[p1-layout.2]** Each data skeleton compiles: `nx build <name>` exits 0 for all six.
- [ ] **[p1-layout.3]** The three area depConstraints are present in BOTH eslint blocks,
      positioned before the `*` catch-all.
- [ ] **[p1-layout.4]** `tokenguard-core` is tagged `area:shared`+`group:codec`; the 8
      platform libs are tagged `area:platform`+group; `memory-core`/`memory-enrich` have
      NO `area:` tag.
- [ ] **[p1-layout.5]** [fix:synthetic-boundary]: a `data/*` package with an added
      `import '@adhd/sox-host-runtime'` (a platform lib) FAILS `nx lint`
      (`@nx/enforce-module-boundaries`); removing it passes. (Run in a sandbox copy — the
      synthetic import never lands.)
- [ ] **[p1-layout.6]** `nx run-many -t build,lint` green; `registry:check-sync` green
      (no drift introduced). [inv:no-regress]

---

## Reservations

```text
read_only:  ["scripts/scaffold-data-packages.mjs",
             "docs/plan/memory-refactor/NX-GENERATOR-HANDOFF.md"]
mutates:    ["eslint.config.js",
             "libs/data/**",
             "libs/tokenguard-core/project.json",
             "libs/manifest/project.json", "libs/install-engine/project.json",
             "libs/registry/project.json", "libs/host-registry/project.json",
             "libs/host-runtime/project.json", "libs/service-proxy/project.json",
             "libs/mcp-runtime/project.json", "libs/authoring/project.json",
             "packages/sox-nx/project.json"]
```

---

## Notes for executor

- Tagging is **project.json `tags` only** — do not move folders, do not touch imports or
  `registry/index.json`. The physical relocation into `libs/platform/<group>/` is an
  explicit follow-on, deliberately out of this plan ([decision-A]).
- The boundary becomes real here but nothing is carved yet — the data/* packages are
  empty skeletons. That keeps the extraction states' guards informative (red→green).
- Do NOT add `area:` tags to `memory-core`/`memory-enrich`. If you do, the composer can
  no longer import `data/*` and every extraction state will red-bar on lint.
- Budget: 1 session.
