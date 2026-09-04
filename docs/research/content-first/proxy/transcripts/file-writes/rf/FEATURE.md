# BUG-WORKSPACE-GEN-006 — workspace-codegen-nx plugin generator emits stale configs

- **Human ID:** BUG-WORKSPACE-GEN-006
- **Kind:** BUG
- **Priority:** MEDIUM
- **Status:** OPEN
- **Repo:** PseudoSky/adhd

## Body

Discovered 2026-08-02 during FEAT-002 implementation (typescript agent) + confirmed by review: `npx nx g @adhd/workspace-codegen-nx:plugin --name ir-cache --group apigen --nxLayer logic --platform node` (in .worktrees/feat-002-ir-cache, post-pnpm/in-source-dist migration) scaffolded apigen-plugin-ir-cache with THREE stale artifacts, each requiring manual repair to match the repo's actual conventions (mirror apigen-plugin-batch):

1. vite.config.ts imports `externalizeRealDeps` from `tools/vite-external-deps.mjs` — that file DOES NOT EXIST; the real path is `tools/vite-plugins/externalize.mjs` (verified: tools/vite-external-deps.mjs absent, tools/vite-plugins/externalize.mjs present).
2. Build emits to the PRE-MIGRATION workspace-root dist: project.json outputPath `dist/packages/apigen/apigen-plugin-ir-cache` + vite build.outDir `../../../dist/packages/...`. The repo migrated to IN-TREE dist ({projectRoot}/dist, per tools/nx-plugins/assets/executors/copy/impl.js comment and apigen-plugin-batch project.json outputPath packages/apigen/apigen-plugin-batch/dist); the injected `assets`/`verify-dist-load` targets fail (`assets: no dist ... (build first)`) against the stale layout until fixed.
3. project.json has NO `test` target (apigen-plugin-batch has `@nx/vite:test`); the generator's vite.config DOES carry a test block but nothing invokes it via nx.

Impact: every newly scaffolded plugin package ships a broken build/verify config needing hand repair; verify-dist-load fails by default. Fix direction: update the plugin generator's templates to (a) import from tools/vite-plugins/externalize.mjs + vitest-pool-defaults.mjs, (b) in-tree dist (project.json outputPath {projectRoot}/dist, vite outDir dist, environment node), (c) emit a test target.

Citations: packages/apigen/apigen-plugin-ir-cache/vite.config.ts (pre-fix state at commit 79aa19f5^), packages/apigen/apigen-plugin-batch/project.json, tools/nx-plugins/assets/executors/copy/impl.js:28, tools/nx-plugins/build/executors/link/impl.js:12.
