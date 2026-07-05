# Module Resolution & Bundling Standard

> Canonical reference for how Sox extensions and libraries resolve modules.
> Written to close BL-168 — the same class of bug kept recurring because the
> rules were implicit and scattered. This document makes them explicit and
> binding.

---

## §1 The Build Model: esbuild Self-Contained Bundling

Every **bundled extension** (hook, mcp-server, service, agent, skill, command)
is compiled by `tools/bundle-extension.cjs` into a **single, self-contained CJS
bundle** under the extension's `dist/` directory.

Key properties of the output bundle:

- **Format:** CommonJS (`format: 'cjs'`) — required for Node.js `require()` loading
  via the host runtime's extension loader.
- **Inline:** every `@adhd/sox-*` workspace package is statically inlined at build
  time via the `soxAliasPlugin`. There are no `@adhd` runtime dependencies in the
  output artifact (ADR-0006).
- **External:** only true third-party native addons (`better-sqlite3`, `sqlite-vec`,
  …) are declared `--external`. They are resolved at runtime via a lazy-require stub
  that walks `node_modules/` up from the bundle file location.
- **No typecheck at build:** esbuild transpiles TypeScript by stripping types — it
  does **not** run `tsc --noEmit`. **Tests are the typecheck gate.** Always run
  `npx nx test <project>` before shipping.

Build invocation example (from `memory-flush/project.json`):

```sh
node tools/bundle-extension.cjs \
  --entry extensions/bundles/sox-memory-bundle/members/memory-flush/src/index.ts \
  --outdir extensions/bundles/sox-memory-bundle/members/memory-flush/dist \
  --tsconfig extensions/bundles/sox-memory-bundle/members/memory-flush/tsconfig.json \
  --external better-sqlite3 \
  --external sqlite-vec
```

Always build through the nx target: `npx nx build <project>` — never invoke
`bundle-extension.cjs` directly outside of a target.

---

## §2 No Cross-Extension Reach-In (C7)

Extensions **must not** import from another extension's `dist/` output or source
directory. This includes:

- `import ... from '../../memory-server/dist/...'`
- `import ... from '../../memory-server/src/...'`

The correct pattern is: shared logic lives in a `libs/*` workspace package that is
inlined by each consumer's bundle independently. Duplicated stateless code across
bundles is acceptable (ADR-0006 §2). Shared **live** objects (open DB connections,
provider instances) cross boundaries only via dependency injection, never by
importing from another extension's bundle.

Enforcement: `@nx/enforce-module-boundaries` rule in `eslint.config.js`.
`require.resolve('<pkg>')` for a static path value triggers the "lazy load" heuristic
and must be suppressed with a line-level `eslint-disable` comment — this is a known
false-positive class (BL-168) until the ESLint rule is updated.

---

## §3 `import.meta.url` in CJS Bundles

esbuild replaces `import.meta` with `{}` in CJS output. Any code that uses
`import.meta.url` (e.g. to compute `__dirname` for sibling-file resolution) will
receive `undefined` at runtime in the bundle — causing a crash on module load.

**The fix** is already applied in `tools/bundle-extension.cjs` (BL-155):

```js
banner: {
  js: `const __soxImportMetaUrl = require('url').pathToFileURL(__filename).href;`,
},
define: {
  'import.meta.url': '__soxImportMetaUrl',
},
```

This points `import.meta.url` to the bundle file's own URL, so `__dirname`-style
sibling resolution finds co-located artifacts.

**Do not** add `import.meta.url` usages in new extension source expecting ESM
semantics — always verify behavior through the bundle, not via the vitest/tsc path
(which runs the un-bundled TypeScript source where `import.meta.url` is defined
natively).

---

## §4 Worker File Resolution

Worker threads (`new Worker(path)`) use **runtime string paths** that esbuild cannot
trace statically. If an extension uses worker threads:

1. The worker entry file **must** be passed to `bundle-extension.cjs` explicitly via
   `--worker <file.ts>`.
2. The bundler emits it as a separate self-contained CJS bundle at
   `<outdir>/<basename>.js` (same output directory as the main bundle).
3. The **runtime path** in source must resolve relative to `__dirname` of the bundle
   file:

   ```ts
   // libs/data/embed/embedding-provider/src/fastembed.ts
   const __dirname = dirname(fileURLToPath(import.meta.url)); // resolved via §3 shim
   const workerPath = join(__dirname, 'embedWorker.js');      // finds dist/embedWorker.js
   ```

Never hardcode relative paths like `'../../../../embed/.../dist/embedWorker.js'` —
these are fragile across src / dist / bundle locations and will silently break in
bundled deployments (BL-166 root cause class).

---

## §5 Stale `dist/` Hazard — Delete Source, Delete Its Dist

When an extension's **source is deleted**, its **built artifacts must be deleted
at the same time**. Leaving `dist/` and `bundle/` artifacts behind after source
deletion creates several hazards:

- E2E test fixtures that probe `existsSync(distPath)` will pass against stale
  artifacts while the source is gone, masking the breakage.
- The host runtime's extension loader may load a stale bundle, silently running
  code from a removed extension.
- The `.gitignore` entry for the extension's `bundle/` remains and must also be
  removed (it documents a path that no longer exists).

**Motivating incidents:**

- **BL-181 / BL-192 (2026-07-04):** `memory-daemon` source was deleted in S9
  (BL-162), but `dist/index.js`, `bundle/index.js`, `bundle/embedWorker.js`, and
  `tsconfig.tsbuildinfo` persisted in the main working tree. `tools/test-e2e-lifecycle.js`
  line ~1099 probes `existsSync(memory-daemon/dist/index.js)` — once the stale
  artifact is removed, this test fails loudly at its `existsSync` guard, which is
  the **desired behavior** (the fixture must be updated to a living extension).

**Rule:** before merging any branch that deletes an extension package, run:

```sh
find extensions/bundles/<bundle>/members/<ext>/ -name "dist" -o -name "bundle" | xargs ls 2>/dev/null
```

Confirm the directories are empty or absent. Remove them if not.

---

## §6 Vitest / Vite Resolution of Workspace Packages

`vitest` (via Vite) cannot resolve the ESM-only `exports` map of `@adhd/sox-*` data
packages directly. Each consumer's `vitest.config.ts` must declare a `resolve.alias`
mapping the package name to a concrete entry file:

```ts
// vitest.config.ts
resolve: {
  alias: {
    '@adhd/sox-memory-core': new URL('../../../libs/memory-core/src/index.ts', import.meta.url).pathname,
  },
},
```

This is not a bug in the packages — it is a known Vite limitation with dual-condition
`exports` maps. Until the data packages ship dual `import`/`require` conditions (a
pending BL-168 follow-up), each consumer needs the alias. Document it in each
extension's `vitest.config.ts` with a comment referencing BL-168.

---

## §7 Quick Decision Reference

| Situation | Correct pattern |
|---|---|
| Extension needs `@adhd/sox-*` at runtime | Inline via `bundle-extension.cjs` (no `--external`) |
| Extension needs `better-sqlite3` / `sqlite-vec` | `--external better-sqlite3 --external sqlite-vec` |
| Need `__dirname` in bundled CJS code | Use the `import.meta.url` shim (§3) — already applied |
| Need a worker thread | Pass `--worker <file.ts>` to bundler; resolve path via `join(__dirname, '<file>.js')` |
| Delete an extension source | Also delete its `dist/`, `bundle/`, `*.tsbuildinfo`, and the `.gitignore` entry |
| Vitest can't resolve `@adhd/sox-*` | Add `resolve.alias` to `vitest.config.ts` (§6) |
| Cross-extension import | Refactor shared logic into a `libs/*` package |

---

*Authored 2026-07-04 to close BL-168. For bundler internals see
`tools/bundle-extension.cjs`. For public vs. private package bundling rules see
[ADR-0006](../decisions/0006-public-bundles-private-and-di-for-live-objects.md).*
