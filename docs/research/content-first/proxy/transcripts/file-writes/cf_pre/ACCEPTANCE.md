1: # Acceptance Criteria — BUG-WORKSPACE-GEN-006
2: 
3: **Feature:** `@adhd/workspace-codegen-nx` plugin generator must scaffold convention-correct packages
4: **Source:** `FEATURE.md` (BUG-WORKSPACE-GEN-006, OPEN, MEDIUM)
5: **Repo:** PseudoSky/adhd — worktree `arm-cf-manual-20260803` (gitdir: `BUG-WORKSPACE-GEN-006-manual1`)
6: **Author:** product (Acceptance Criteria stage)
7: **Date:** 2026-08-03
8: 
9: ## 1. Problem statement
10: 
11: `npx nx g @adhd/workspace-codegen-nx:plugin --name ir-cache --group apigen --nxLayer logic --platform node`
12: scaffolds a package whose build/verify/test configuration is broken until manually repaired.
13: Three stale artifacts were demonstrated (FEATURE.md:11-17), root-caused to shared
14: scaffolding code that every tier delegates through (`packages/workspace/workspace-codegen-nx/src/generators/shared/generator.ts`):
15: 
16: 1. `vite.config.ts` imports `externalizeRealDeps` from `tools/vite-external-deps.mjs`, which **does not exist**;
17:    the real helper is `tools/vite-plugins/externalize.mjs` (injected at `shared/generator.ts:163`).
18: 2. Build emits to the **pre-migration workspace-root dist** (`dist/packages/...`); the repo migrated to
19:    **in-tree dist** (`{projectRoot}/dist`). The injected `assets` / `verify-dist-load` targets read
20:    `{projectRoot}/dist` and therefore fail (`assets: no dist ... (build first)`).
21: 3. `project.json` has **no `test` target**; the generated `vite.config.ts` carries a `test` block but nothing
22:    invokes it via nx.
23: 
24: Additionally, the generator's own spec suite **codifies the stale path**
25: (`base/generator.spec.ts:44` asserts the nonexistent `tools/vite-external-deps.mjs` import), so the
26: regression guard currently asserts the bug.
27: 
28: ## 2. Success outcome
29: 
30: After this fix, any package scaffolded with the plugin generator is immediately a functioning member of the
31: repo's build → test → assets → verify-dist-load pipeline **with zero hand repair**, matching the conventions
32: of the reference package `packages/apigen/apigen-plugin-batch` (project.json + vite.config.ts).
33: 
34: ## 3. Acceptance criteria
35: 
36: Each criterion is binary-pass/fail, verified by the stated check, and evidenced (command output + exit code,
37: or generator-spec assertion). "Generated package" below means the output of the plugin generator for a
38: `platform:node` plugin (e.g. `--name acme --group apigen --nxLayer logic --platform node`).
39: 
40: ### AC-1 — Correct `externalizeRealDeps` import path
41: - **Check:** the generated `vite.config.ts` contains exactly
42:   `import { externalizeRealDeps } from '../../../tools/vite-plugins/externalize.mjs';`
43:   and contains **no** occurrence of `vite-external-deps`.
44: - **Pass:** both hold. The import target `tools/vite-plugins/externalize.mjs` exists (verified present).
45: - **Fail:** either the old `tools/vite-external-deps.mjs` path appears, or the import is absent.
46: - **Reference:** `apigen-plugin-batch/vite.config.ts:6`; stale injection at `shared/generator.ts:163`;
47:   helper exists at `tools/vite-plugins/externalize.mjs`.
48: 
49: ### AC-2 — `vitestPoolOptions` wired into the generated `test` block
50: - **Check:** the generated `vite.config.ts` contains
51:   `import { vitestPoolOptions } from '../../../tools/vite-plugins/vitest-pool-defaults.mjs';`
52:   and a `test` block with `poolOptions: vitestPoolOptions` (repo-wide CPU-oversubscription guard,
53:   DEBT-TEST-CPU-OVERSUBSCRIBED-001).
54: - **Pass:** both present.
55: - **Reference:** `apigen-plugin-batch/vite.config.ts:8,44`; `tools/vite-plugins/vitest-pool-defaults.mjs`.
56: 
57: ### AC-3 — In-tree dist: `project.json`
58: - **Check:** generated `project.json` `targets.build.options.outputPath` equals `{projectRoot}/dist`
59:   (e.g. `packages/apigen/apigen-plugin-acme/dist`) with `emptyOutDir: true`, and contains **no**
60:   `dist/packages/` path anywhere.
61: - **Pass:** outputPath is in-tree and no workspace-root dist path remains.
62: - **Fail:** `dist/packages/...` outputPath (the pre-migration layout).
63: - **Reference:** `apigen-plugin-batch/project.json:26`; in-tree convention per
64:   `tools/nx-plugins/assets/executors/copy/impl.js` ("In-tree ({projectRoot}/dist), never the old
65:   workspace-root dist/{projectRoot}").
66: 
67: ### AC-4 — In-tree dist + node environment: `vite.config.ts`
68: - **Check:** the generated `vite.config.ts` sets `root: __dirname`, `build.outDir: 'dist'` (never
69:   `../../../dist/`), `build.emptyOutDir: true`, `cacheDir` under `../../../node_modules/.vite/`, and a
70:   `test` block with `environment: 'node'`, `globals: true`, `cache.dir` under `../../../node_modules/.vitest`,
71:   `include` covering `src/**/*.{test,spec}.*`, and `coverage.reportsDirectory` under
72:   `../../../coverage/packages/<group>/...`.
73: - **Pass:** all keys present with repo-convention values; no `../../../dist/` outDir.
74: - **Reference:** `apigen-plugin-batch/vite.config.ts:10-11,21-24,43-56`.
75: 
76: ### AC-4b — Source `package.json` consumer entries point at the in-tree dist
77: - **Check:** the generated package's own `package.json` has `main: "./dist/index.js"`, `module: "./dist/index.mjs"`, `types: "./dist/index.d.ts"` (repo `types` field, no stale `typings` key), and `files: ["dist"]` — mirroring `apigen-plugin-batch/package.json`. (Same stale-migration family as AC-3/AC-4: `@nx/js:library` emits `main: "./index.js"` at the package root, a file that does not exist there. Added during implementation; enforced by the plugin-tier spec.)
78: - **Pass:** all four fields present with the in-tree values.
79: - **Fail:** any entry points at the package root (`./index.js`) rather than `./dist/index.js`, or a `typings` key remains.
80: 
81: ### AC-5 — Explicit `test` target in `project.json`
82: - **Check:** generated `project.json` `targets.test` exists with executor `@nx/vite:test` and
83:   `options.configFile` pointing at the package's own `vite.config.ts` (mirroring the reference).
84: - **Pass:** target present; consequence is that `npx nx test <pkg>` actually runs the package's vite test
85:   block (verified in AC-6).
86: - **Fail:** no `test` target (the demonstrated bug).
87: - **Reference:** `apigen-plugin-batch/project.json:30-38`.
88: 
89: ### AC-6 — End-to-end: scaffolded package builds, tests, and verifies without repair
90: - **Where:** an isolated scratch location (a throwaway git worktree under `.worktrees/`, or `tmp/`) — never
91:   committed to a working branch; artifacts cleaned up afterward (repo `tmp/` convention).
92: - **Checks** (each gated on the runner's **exit code**, never stdout greps — repo §7.4), in order, with no
93:   manual repair between them:
94:   1. `npx nx build <pkg>` → exit 0; `dist/` emitted at `{projectRoot}/dist`.
95:   2. `npx nx run <pkg>:assets` → exit 0 (the documented failure `assets: no dist ... (build first)` must
96:      **not** appear — `tools/nx-plugins/assets/executors/copy/impl.js` reads `{projectRoot}/dist`).
97:   3. `npx nx run <pkg>:verify-dist-load` → exit 0 (built entry loads as a real consumer — the documented
98:      default-failure mode of the bug).
99:   4. `npx nx test <pkg>` → exit 0, with ≥ 1 real test executed (the generated package's own spec file
100:      must exist and run).
101: - **Pass:** all four exit 0 against the freshly scaffolded package.
102: - **Fail:** any of the four fails or emits the stale-dist error.
103: 
104: ### AC-7 — Generator spec suite updated, with teeth
105: - **Check:**
106:   - `base/generator.spec.ts:44`'s assertion is updated from the stale `../../../tools/vite-external-deps.mjs`
107:     to the correct `../../../tools/vite-plugins/externalize.mjs` (otherwise `nx test workspace-codegen-nx`
108:     fails against the fixed generator); the doc comment at `base/generator.spec.ts:11` is updated to match.
109:   - A plugin-tier spec (e.g. `src/generators/plugin/generator.spec.ts`) drives the **plugin** generator on an
110:     in-memory Tree (same pattern as `base/generator.spec.ts:19-29`) and asserts the AC-1, AC-3, AC-4, AC-5
111:     output shape on the generated files — content assertions, not "ran without throwing".
112:   - **Teeth proof (repo §7.2):** with the generator's patches reverted to pre-fix behavior, the updated/added
113:     assertions fail. Demonstrated once (negative control) or structurally guaranteed by the assertions
114:     targeting strings the old output does not contain.
115: - **Pass:** suite green on fixed code, red on reverted code.
116: - **Fail:** suite stays green when the generator is broken (no teeth), or suite is red on the fixed code.
117: 
118: ### AC-8 — No regression across tiers and platforms
119: - **Check:**
120:   - `base` tier: `platform:node` and `platform:shared` scaffolds still wire
121:     `external: externalizeRealDeps(__dirname)`; `platform:browser` still leaves `external: []`
122:     (existing cases at `base/generator.spec.ts:31-80`, with the import-path assertion updated per AC-7).
123:   - `npx nx run workspace-codegen-nx:lint` → exit 0 (touched files lint-clean, no rule disabled without
124:     justification).
125:   - `npx nx build workspace-codegen-nx` → exit 0; `npx nx test workspace-codegen-nx` → exit 0 (all suites).
126: - **Pass:** all three green.
127: - **Fail:** any regression in another tier/platform, or the generator package itself failing to build/test/lint.
128: 
129: ### AC-9 — No stale path in generator output or generator package docs
130: - **Check:** `rg -n "vite-external-deps" packages/workspace/workspace-codegen-nx` returns zero hits in
131:   **generator source, templates, README, and any file whose content becomes generated output**. Explicitly
132:   **excluded** (deliberate, required by other ACs): (a) the plugin-tier spec's negative-control assertions
133:   (`expect(viteConfig).not.toContain('vite-external-deps')` — the teeth guard mandated by AC-7, which must
134:   name the stale string to detect it) and (b) historical mentions in `CHANGELOG.md`/`BACKLOG.md`, which are
135:   legitimate records.
136: - **Pass:** zero hits outside the two excluded categories.
137: - **Fail:** the stale path appears in source/templates/README or in anything the generator writes to disk.
138: 
139: ## 4. Out of scope (explicitly deferred — see §6)
140: 
141: - The 16 **comment-only** stale `tools/vite-external-deps.mjs` references in existing apigen
142:   `vite.config.ts` files (e.g. `apigen-plugin-mcp/vite.config.ts:36`, `apigen-core-client/vite.config.ts:38`).
143:   Cosmetic (they are comments, not imports), same stale-path family, **not** produced by the generator's
144:   current output. Tracked as a follow-up item.
145: - Backlog registration of BUG-WORKSPACE-GEN-006 in `BACKLOG.md`: the repo's authoritative backlog is the
146:   `@adhd/backlog` graph managed via the `backlog` CLI; this chain is tooled to not call that CLI, and
147:   hand-edits to the generated `BACKLOG.md` projection are rejected by the repo's parity gate. The bug is the
148:   chain's work item via `FEATURE.md` and the `BUG-WORKSPACE-GEN-006-manual1` worktree; closing it should
149:   transition the item through the proper backlog workflow at Final Review (stage 5).
150: - Publishing/release of the fixed generator (version bump, `nx release publish`) — out of scope for the
151:   fix itself; CI release-pipeline gates (`verify-dist-load`, `dist-manifest`, `publish-hygiene`) already run
152:   by default via `nx.json` `targetDefaults.nx-release-publish` (nx.json:157-166).
153: 
154: ## 5. Verification protocol (how the evidence must be produced)
155: 
156: Per repo AGENTS.md §7 (proving features work):
157: 
158: 1. **Real components, not mocks.** The generator spec drives the actual generator functions against a real
159:    `Tree`; AC-6 drives real nx targets (`build`/`assets`/`verify-dist-load`/`test`) against a real scaffold.
160:    No mocked generator output.
161: 2. **Assertions with teeth.** AC-7 negative control must be demonstrated or structurally guaranteed.
162: 3. **Deterministic.** No sleeps/wall-clock; generator specs are synchronous Tree assertions.
163: 4. **Exit codes, not stdout.** Every AC-6 check keys on the runner's exit status.
164: 5. **Default-running.** The generator specs run unflagged in the normal `nx test workspace-codegen-nx` suite;
165:    nothing is env-gated (no paid external service involved).
166: 6. **Cleanup.** Scratch scaffolds live under `tmp/` or a throwaway `.worktrees/` worktree and are removed;
167:    nothing ephemeral is committed.
168: 
169: ## 6. Follow-up items (logged for backlog, not blocking)
170: 
171: | ID | Item | Evidence | Priority |
172: |---|---|---|---|
173: | BL-1 | Update the 16 comment-only stale `tools/vite-external-deps.mjs` references in existing apigen `vite.config.ts` files to `tools/vite-plugins/externalize.mjs` (comments only; no behavior change) | grep hits listed in §4 | LOW |
174: | BL-2 | Register BUG-WORKSPACE-GEN-006 close-out through the repo `backlog` CLI workflow (this chain does not call the CLI; hand-editing the generated `BACKLOG.md` is parity-gate-rejected) | `FEATURE.md`; AGENTS.md "Backlog" rule | MEDIUM |
175: 
176: ## 7. References
177: 
178: - `FEATURE.md` (BUG-WORKSPACE-GEN-006 body, lines 11-17)
179: - `packages/workspace/workspace-codegen-nx/src/generators/shared/generator.ts:126-170` (`patchViteConfig`, stale import at line 163)
180: - `packages/workspace/workspace-codegen-nx/src/generators/base/generator.spec.ts:44` (assertion codifying the stale path), `:11` (stale doc comment), `:19-29` (Tree-driven test pattern)
181: - `packages/apigen/apigen-plugin-batch/project.json:21-55` (reference: in-tree `outputPath` :26, `test` target :30-38)
182: - `packages/apigen/apigen-plugin-batch/vite.config.ts:6,8` (correct imports), `:10-24` (root/cacheDir/outDir), `:43-56` (test block)
183: - `tools/vite-plugins/externalize.mjs` (exists; `externalizeRealDeps`)
184: - `tools/vite-plugins/vitest-pool-defaults.mjs` (exists; `vitestPoolOptions`)
185: - `tools/vite-external-deps.mjs` (verified **absent**)
186: - `tools/nx-plugins/assets/executors/copy/impl.js` ("In-tree ({projectRoot}/dist)..." + `assets: no dist ... (build first)`)
187: - `tools/nx-plugins/verify-dist-load/plugin.js` (`verify-dist-load` inferred for every buildable project; reads `{projectRoot}/dist`)
188: - `nx.json:26-32` (sharedGlobals reference `tools/vite-plugins/externalize.mjs`), `:157-166` (`nx-release-publish` targetDefault gates)
189: - Repo `AGENTS.md` §7 (verification standard), `tmp/` convention §10

(End of file - total 189 lines)