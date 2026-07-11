# Extension Bundling Contract

> Canonical reference for **what `tools/bundle-extension.cjs` produces and guarantees** — the
> extension/bundle half of the build substrate. Written to close BL-265: the mechanism existed
> only in bundler source comments and three `project.json` `--worker` flags; nothing said "a
> runtime-spawned sibling file must be emitted by every consuming bundle" until an author (`3916afd`)
> changed a runtime process topology and shipped a ~5h embeddings outage (BL-262) because no
> document told them the rule existed.
>
> For the **library** half of the build substrate (flat `dist/index.*`, `rootDir` pinning, worker
> path resolution, the `import.meta.url` shim itself, vitest resolution) see
> [`module-resolution.md`](./module-resolution.md) — this document assumes that one and does not
> repeat it. This document is BUNDLE-SURFACE specific: the esbuild driver, sidecars, atomic staging,
> and the verification gates around them.
>
> **Status as of this writing (BL-265): describes the CURRENT hand-rolled implementation
> (`tools/bundle-extension.cjs`).** BL-266 is a live effort to migrate parts of this substrate to
> standardized tooling (`@nx/esbuild`, `publint`, `@arethetypeswrong/cli`, nx dependency-derived
> inputs) while preserving every invariant documented here. If you are reading this after that
> migration lands, check the "Post-migration reality" section near the end — Phase 2 of BL-266
> updates it in place rather than leaving two contradictory documents.

---

## §1 What a bundle is

Every **bundled extension** (mcp-server, service, hook, agent, skill, command — anything under
`extensions/` or `apps/sox` that ships to a consumer outside the monorepo) is compiled by
`tools/bundle-extension.cjs` into a **self-contained CommonJS bundle**:

- **One file per entry point** (`index.js` for the main entry, one file per declared worker/sidecar),
  each independently `require()`-able with no other file in the bundle's `dist/` required to make it
  run, other than its own sourcemap and the `package.json` sidecar (§2).
- **Format: CJS** (`format: 'cjs'`), **platform: node**, **target: node18** — chosen because the host
  runtime's extension loader `require()`s bundles directly; there is no ESM loader in that path.
- **Every `@adhd/sox-*` workspace package is statically inlined**, resolved via the bundler's
  `soxAliasPlugin` to each package's pre-built `dist/index.js` (an explicit `SOX_ALIASES` map in
  `tools/bundle-extension.cjs` — see BL-266 for why this hand-maintained map is a targeted migration
  candidate). The published/shipped artifact carries **zero `@adhd` runtime dependencies** (ADR-0006).
- **Only true third-party native addons are `--external`** (`better-sqlite3`, `sqlite-vec`,
  `fastembed`, `onnxruntime-node`) — see §3.
- **Sourcemaps**: `sourcemap: 'linked'` — a `.map` sidecar next to every emitted `.js`, picked up by
  Node automatically under `--enable-source-maps`.

### §1a The `type: commonjs` sidecar

The bundler writes a `package.json` containing only `{ "type": "commonjs" }` into every emitted
`dist/`. This is not decorative: the **repo root** `package.json` has no `"type"` field set (Node's
default is CJS, but any ancestor `package.json` with `"type": "module"` would flip it), and more
importantly a bundle's *own* directory must declare its module system independently of wherever it
gets copied to at install time (a scope's content store, a user's `~/.sox/ext/<id>/`, etc.) — those
install roots are not guaranteed to be CJS by default in every host. Without this sidecar, Node
rejects `module.exports` in the `.js` files with `ReferenceError: module is not defined in ES module
scope` the moment the bundle lands under an ESM-rooted ancestor.

### §1b The `import.meta.url` banner shim

esbuild replaces `import.meta` with `{}` in CJS output, so any source using `import.meta.url` —
typically to compute `__dirname`-equivalent for sibling-file resolution — receives `undefined` at
bundle runtime and crashes on load (this is BL-155, and it is genuinely correct, not a workaround to
be removed by a future migration — see the prior-research note in §6). The bundler injects:

```js
banner: {
  js: `const __soxImportMetaUrl = require('url').pathToFileURL(__filename).href;`,
},
define: {
  'import.meta.url': '__soxImportMetaUrl',
},
```

into every `esbuild.build()` call (main entry, every worker, every sidecar — the shim is per-file,
not per-bundle, because each emitted file is its own top-level module). This makes
`fileURLToPath(import.meta.url)`-based `__dirname` resolution in source work identically whether the
code runs un-bundled (real ESM `import.meta.url`) or bundled (the shim's stand-in) — see
`module-resolution.md` §3 and §4 for how source is written to make that transparent.

---

## §2 Externals policy: native addons, lazy-loaded

Only genuine third-party **native** dependencies are passed `--external` — never `@adhd/sox-*` code
(§1), and never a pure-JS third-party dependency unless it specifically cannot be bundled (e.g. it
does dynamic `require()` in a way esbuild cannot trace).

An external package is not merely left unresolved — the bundler's `lazyExternalPlugin` intercepts its
resolution and replaces the import with:

```js
"use strict";
var _cr = require('module').createRequire(typeof __filename !== 'undefined' ? __filename : __dirname + '/index.js');
module.exports = _cr(<pkg>);
```

Two properties fall out of this, both load-bearing:

1. **Lazy at the call site, eager at require-time.** The real `require(<pkg>)` runs the instant the
   bundle's module graph touches the external import — same timing as an un-bundled `require`, no
   deferred Proxy. What's deferred is *resolution location*, not *load timing*: `createRequire`
   resolves relative to the **bundle file itself**, walking `node_modules/` up from wherever the
   bundle physically lives (a scope's content store, a monorepo checkout, `~/.sox/ext/<id>/`) — not
   from `tools/bundle-extension.cjs`'s own location. This is what lets one bundle artifact run
   correctly whether it's sitting inside the monorepo during development or copied standalone into an
   install scope: `better-sqlite3`'s native `.node` binary is found via ordinary Node module
   resolution from the bundle's new home, never copied or hardcoded.
2. **No infinite recursion.** `require('module')` itself stays untouched by esbuild's CJS require-
   rewriting (`__require`) because it's a Node built-in resolved on the `'node'` platform — only the
   *external package name* passed to `createRequire(...)(pkg)` is a runtime string, which esbuild
   cannot (and must not) statically rewrite.

**Do not** hardcode a relative path to a native `.node` file, and do not pass a dynamically computed
variable to `require.resolve()` inside bundled source expecting it to survive — esbuild can only leave
a `require.resolve('literal-string')` call as-is in the output; a computed argument is not guaranteed
to resolve correctly post-bundle. (Cross-referenced against the ecosystem convention for native/WASM
asset resolution in bundled packages — externalize + `require.resolve`, never bundle binaries — which
independently confirms this is the correct pattern, not a sox-specific hack.)

---

## §3 The sidecar contract

**A sidecar is a runtime-spawned sibling `.js` file** — a `worker_threads.Worker` or a forked child
process — located at runtime via a **string path**, typically `path.join(__dirname, '<name>.js')`.
esbuild traces static `import`/`require` graphs; it cannot trace a runtime string handed to
`new Worker(...)` or `child_process.fork(...)`. A sidecar that is not explicitly emitted into the same
`dist/` directory is therefore **silently absent** — the fork/spawn fails at runtime, typically with
no error visible until the first call that needs it, because module *loading* succeeded fine (the main
bundle has no static reference to the missing file to fail on).

This has shipped three times under three different mechanisms, each strictly better than the last:

- **BL-87/BL-89** (original bug): `embedWorker.js` was never emitted by any bundle at all — no
  mechanism existed to emit workers automatically.
- **Fix 1 — explicit `--worker` flags**: every `project.json` build target names every worker file by
  hand. This works but does not scale: BL-259 shipped anyway, because the fastembed child-process
  host (added by `3916afd`, see §6) was a *new* sidecar that had to be added to **every consumer's**
  `--worker` list by hand, and it wasn't — the live memory-server lost real embeddings for ~5 hours
  before anyone noticed the silent fallback... except there was no fallback left to notice (BL-250
  deleted the hash backend), so the actual symptom was a stranded embed backlog and loud
  `ResolutionError`s at the next cold provider init.
- **Fix 2 — auto-discovery + fail-closed verification (BL-262, current state)**: hand-listing every
  sidecar in every consumer is the disease. Instead:
  1. **The OWNING package declares its sidecars once**, in its own `package.json`:
     ```json
     "sox": {
       "sidecars": ["src/embedWorker.ts", "src/fastembedProcessHost.ts", "src/sharedOnnxWorker.ts"],
       "sidecarExternals": ["fastembed", "onnxruntime-node"]
     }
     ```
     (this is the live declaration in `libs/data/embed/embedding-provider/package.json` today).
  2. After the main entry builds with `metafile: true`, `discoverSidecars()` walks every **input
     file** esbuild actually inlined, finds the nearest owning `package.json` for each (skipping
     `dist/`-copy package.json files and any `.staging-`/`.prev-` in-flight directories — those are
     build-output artifacts, not source package roots, and their relative sidecar paths would resolve
     to nonexistent `dist/src/...` locations), and unions every declared sidecar of every package
     actually pulled into the bundle. **A consuming bundle never lists a sidecar by name** — if it
     transitively inlines a package that declares one, that sidecar is bundled automatically, with
     that package's declared `sidecarExternals` unioned into the `--external` list for that one
     sidecar build.
  3. **`verifySidecarReferences()` then scans every emitted `.js` for a `__dirname`-sibling `.js`
     string reference** (`/__dirname[^;\n]{0,160}?['"]([A-Za-z0-9][\w.-]*\.js)['"]/g`) and **fails the
     build** — before the atomic commit in §4, so the previous working artifact is untouched — if any
     referenced name was not emitted into the staged output. This is the safety net beneath the
     safety net: even an sidecar some future author forgets to declare in `sox.sidecars` cannot ship
     silently, because the reference-scan doesn't care whether the sidecar was *declared* — only
     whether it was *emitted*.

**Practical rule for anyone changing a runtime process topology** (adding a worker, a forked child
process, or any `path.join(__dirname, ...)`-addressed sibling): declare it in the *owning* package's
`sox.sidecars` (with its own native deps in `sox.sidecarExternals`), then run
`npx nx build <every consumer>` and confirm `bundle-extension: sidecar  <name>.js (auto-discovered
from ...)` appears in the log for each. If it doesn't appear and your code still references
`path.join(__dirname, '<name>.js')`, the build will fail at the `verifySidecarReferences` gate — that
failure IS the fix working, not a bug to route around.

Explicit `--worker <file>` (Fix 1) still exists and still wins over auto-discovery when both name the
same output basename — it is not deprecated, just no longer the only mechanism, and no longer
required for anything the owning package's own `sox.sidecars` already covers.

---

## §4 Atomic staging and commit-by-rename (BL-235)

The bundler **never** does `rm -rf <outdir>` before it knows the build will succeed. The prior
contract was exactly that — `project.json` deleted `dist/` and then invoked the bundler — and a failed
build (broken source, a concurrent agent mid-edit, an untyped error the type-erasing bundler doesn't
catch) left `<outdir>` **empty and unrecoverable**, because the only way back was a successful build,
which was precisely what had just failed. This destroyed the live memory-server bundle twice in one
day, once from an agent running a build purely to *see* an error message.

The actual sequence, in `bundle-extension.cjs`'s `main()`:

1. Bundle into a **fresh staging directory** (`<outdir>.staging-<pid>`), never `<outdir>` itself.
2. Every entry point, every worker, every auto-discovered sidecar, and the `package.json` sidecar
   (§1a) are written into staging.
3. `verifySidecarReferences()` (§3) runs against the **staged** output. On failure: `rm -rf` the
   staging dir only, print the missing-sidecar diagnostic, `process.exit(1)` — `<outdir>` was never
   touched.
4. **Commit**: if `<outdir>` exists, rename it to `<outdir>.prev-<pid>`; rename staging to `<outdir>`.
   If either rename throws, roll back — rename `.prev-` back to `<outdir>` if it's missing — before
   exiting non-zero. The only window in which `<outdir>` is not a valid artifact is bounded by two
   `fs.renameSync` calls within one directory, not a bundle's worth of compilation time.
5. Delete the `.prev-` directory only after the swap has fully succeeded.

**Corollary for anyone invoking `npx nx build <project>` diagnostically**: a build against
non-compiling source is a **destructive operation on every OTHER build target** in the same repo
whose `project.json` still does `rm -rf` before invoking a tool that does not itself stage atomically
(the atomic-staging guarantee above is bundler-internal; it does not retroactively protect a target
built by, say, `@adhd/sox-nx:atomic-tsc`, which has its own separate atomic-rename implementation for
the same BL-235 reason — read that executor's source before assuming any two "atomic" build targets
share a mechanism). See `AGENTS.md`'s "A DIAGNOSTIC `nx build` IS A DESTRUCTIVE OPERATION" constraint.

---

## §5 Registry checksum interplay

`registry/index.json` embeds a checksum of every registered extension's `dist/` (or `bundle/`, for
targets that keep a `compile` step separate from a `bundle`/`build` step — see tokenguard's
`project.json`, which runs `atomic-tsc` for `dist/` and the esbuild bundler for a separate `bundle/`).
**Any rebuild of a shipped bundle invalidates that checksum**, even a byte-for-byte no-op rebuild that
merely re-runs esbuild with a fresh `--pid`-suffixed staging dir (source maps embed absolute paths
that can differ run-to-run; §7 below covers when this specific case is provably stable vs. not).

The mandatory sequence after touching bundled source:

```
npx nx lint <project>
npx nx build <project>
npx nx run registry:sync-index   # rebuilds + regenerates registry/index.json checksums
```

`scripts/smoke-test.mjs` fails with `CHECKSUM MISMATCH` if this step is skipped — it is not optional,
and it is not idempotent-safe to skip "because I didn't change the checksummed content," because the
checksum is computed over the actual bytes on disk, not over source diffs.

---

## §6 The tests-bypass-artifact trap

**`npx nx test <project>` proves nothing about the shipped bundle.** Vitest (via the workspace's
`vitest.config.ts` `resolve.alias` entries — see `module-resolution.md` §6) resolves `@adhd/sox-*`
packages and local source directly from TypeScript, with real `import.meta.url`, real ESM semantics,
and no `--external`/lazy-require indirection. Two real incidents shipped a fully green `nx test` suite
alongside a broken bundle:

- **BL-248**: esbuild strips TypeScript types without checking them (`tsc --noEmit` is a *separate*
  `typecheck` target — see `AGENTS.md`'s `typecheck` constraint). `memory-server` shipped **15 real
  TypeScript errors**, two of them live bugs, under a gate that ran `build,lint,test` and had no
  `typecheck` target on any project at all.
- **BL-262**: `3916afd` added a new sidecar (`fastembedProcessHost.ts`) whose owning package,
  `embedding-provider`, has its own passing test suite that exercises the process-host logic directly
  against source — that suite never bundles anything, so it could not and did not catch that three
  *other* projects' bundles didn't emit the new sidecar file.

The rule this establishes (already stated in `module-resolution.md` §3/§4b, restated here because it
is the single most important operational habit for anyone touching bundled code): **verify behavior
through the actual built bundle, not through the vitest/tsc source path.** Concretely: after a build,
either run the smoke test (which exercises real installed bundles end-to-end) or manually
`node <dist>/index.js` (or spawn it exactly as the host runtime would) before considering a change to
sidecar-producing or externals-touching code complete. A green `nx test` is necessary; it has never
been sufficient for this class of change.

---

## §7 Prior research grounding (do not re-litigate without new evidence)

The externals-via-`require.resolve` + lazy-load pattern, the `import.meta.url` banner shim, and the
verify-through-the-bundle rule (§6) are not sox-specific inventions to be "cleaned up" by a future
migration — a 2026-07-10 research sweep (recorded in the shared memory store, `~/.memory/memory.db`)
cross-referenced esbuild's own documentation, the esbuild/sharp platform-binary convention, and
Node.js's `exports` encapsulation docs, and confirmed all three as the accepted ecosystem convention
for esbuild-bundled packages carrying native addons. See BL-266's migration fix note for the full
citation trail. **A migration to a different bundler driver must preserve these three specific
behaviors**, even if it replaces `tools/bundle-extension.cjs`'s hand-rolled driver itself.

---

## Post-migration reality (BL-266)

*(Updated as Phase 2 of BL-266 lands. As of this writing, describes what changed vs. §1–§6 above; if
this section is empty or says "no migration has landed yet," everything above is still exactly what
ships.)*

See the end of this document for the current state once BL-266 Phase 2 has made its determination.
