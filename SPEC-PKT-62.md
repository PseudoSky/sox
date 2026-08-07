# SPEC-PKT-62 — prove the published `@adhd/sox-graph-store` contract through a real npm tarball

**Packet:** PKT-62 · **Closes:** BL-443 (MEDIUM) · **Authorising ADR:**
[`docs/decisions/0010-open-node-and-edge-typing.md`](./docs/decisions/0010-open-node-and-edge-typing.md)
("ADR-0010"), specifically the D1/D2/D4 rulings this packet's fixture exercises through the
*installed* package, and ADR-0010's own §"Drives" line naming PKT-62 as the wave's acceptance gate.
**Prerequisites (all merged on `main`, verified below):** PKT-59/BL-440 (`9ba8ec70` — injected
`TypePolicy`), PKT-58/BL-439 (`ae262a2d` — `node.kind` opens), PKT-74/BL-448 (`b64bc3d8` — `edge.rel`
opens, `EdgeRel` widened), PKT-73/BL-447 (`37863fee` — structural CHECK-presence rebuild gate).
**Worktree:** `/Users/nix/dev/ai/sox-ecosystem/.worktrees/pkt62-tarball-conformance`, branch
`feat/pkt62-tarball-conformance`, branched from `main` at `e1d6d759` (merge commit for PKT-74).
Toolchain verified before any edit: `pnpm install` clean (native `better-sqlite3`/`sqlite-vec`
rebuild succeeded), `npx nx test graph-store` → **5 test files, 67 tests, all passing**, tree state
`CLEAN` per `node tools/check-suite-tree-state.mjs --project graph-store`.

---

## 0. Prerequisite verification (do this first, report if it fails)

```
git log --oneline -6 -- libs/data/graph/graph-store/src/index.ts
```
Must show, most-recent-first: `b64bc3d8` (PKT-74), `ae262a2d` (PKT-58), `9ba8ec70` (PKT-59),
`37863fee` (PKT-73). If your checkout is missing `DEFAULT_TYPE_POLICY`, `TypePolicy`, or
`hasEnumCheckConstraint` in `index.ts`, **stop and report — do not proceed.**

---

## 1. Root cause, in my own words, with citations I opened

`@adhd/sox-graph-store` publishes `dist/index.js` + `dist/index.d.ts` (`libs/data/graph/graph-store/package.json:14-15`,
version `0.5.3`, `"private": false"` at `:6`, `publishConfig.access: "public"` at `:7-9`). Nothing in
this repo's test suite ever resolves the package the way an external consumer does. Two independent
paths both land on raw TypeScript source, never on the published artifact:

1. **The package's own suite imports itself by relative path.** Every spec file in
   `libs/data/graph/graph-store/src/` — `graph-store.spec.ts:1-15`, `open-kind-check.bl439.spec.ts:16-29`,
   `open-rel-check.bl448.spec.ts:17-29`, `type-policy.bl440.spec.ts:16-27`,
   `ensure-check-constraints.bl447.spec.ts` — imports `from './index.js'`. Vitest transforms that TS
   source on the fly (`libs/data/graph/graph-store/vitest.config.ts:1-9`, no build step in the chain).
   This is the same class of blind spot `libs/data/CLAUDE.md` names explicitly for *other* packages
   ("a passing test is not evidence — `tsx`/`vitest` resolve workspace packages via `paths` straight
   to source, bypassing `node_modules` entirely"); graph-store's own suite exhibits the sibling
   failure mode — it never leaves its own `src/` at all.
2. **In-workspace consumers link, they don't install.** `pnpm-workspace.yaml:1-6` makes
   `libs/data/analysis`, `libs/data/search/hybrid-search`, `libs/data/vectors/vector-store`, and
   `libs/memory-core` (each declaring `"@adhd/sox-graph-store": "workspace:*"`) resolve through a
   pnpm symlink into the package directory. That symlink's `package.json` `main`/`types` do point at
   `dist/` (`package.json:14-15`), so a workspace consumer's *runtime* import is closer to real than
   case (1) — but the **npm packaging pipeline itself** (the `files` allowlist at `:23-26`, the
   `exports` map at `:16-22`, `workspace:*` → real-semver rewriting at publish, transitive dependency
   resolution through a real registry) is never exercised by a symlink. `docs/routing` and
   `libs/data/CLAUDE.md` both document the linking mechanism; neither claims it proves the tarball.

**Confirmed by reading, not assumed:** I verified `tsconfig.base.json:31-42` has **no** `paths` entry
for `@adhd/sox-graph-store` at all (unlike `@adhd/sox-manifest`, which maps first to
`libs/manifest/src/index.ts`) — so the specific claim in `BL-443`'s filed text ("every test resolves
it through `tsconfig.base.json` `paths` straight to `src/`") is not literally what the config shows
for *this* package. The real gap is case (1) and (2) above, which is what this packet's acceptance
criteria are built to close; I am not carrying the imprecise claim forward into an assertion.

`git show 0ce39c7 -- libs/data/graph/graph-store/src/index.ts` / `git show 1446028d --stat` (BL-295,
built and reverted in 19 minutes) and `CHANGELOG.md:1986-2040` (BL-313, 40,930 edges cascade-deleted)
are the two live incidents this fixture must not be able to reproduce: neither `pnpm pack` nor
anything this fixture runs may touch `NODE_TABLE_DDL`/`EDGE_TABLE_DDL`, `rebuildTable`, or any
existing `.db` file. Read `index.ts:851-958` (`ensureCheckConstraints`) before touching anything —
this packet does not edit it, but the fixture's negative arm (§4 AC-3) constructs a store that walks
through it, so its behaviour must be understood, not guessed.

---

## 2. The change, file by file

### New files (all created; nothing here already exists)

1. **`tools/graph-store-tarball-conformance.mjs`** — the orchestrator. Plain Node ESM script
   (mirrors `tools/born-conformance.js`'s shape: `spawnSync`, `mkdtempSync`, structured console
   output, explicit exit codes — **not** a vitest file, because it spawns `pnpm pack`, `pnpm install`,
   and `tsc` as real child processes against a real filesystem tree outside the repo, which vitest's
   transform pipeline has no business doing). See §4 for its exact behaviour and exit contract.

2. **`libs/data/graph/graph-store/conformance-fixture/package.json`** — a template manifest for the
   scratch consumer project. Committed to git (reviewable), *copied* into a `mkdtemp` scratch
   directory at run time, never executed in place. `private: true`, `type: "module"`, a `devDependencies`
   block with `"typescript": "6.0.3"` (pinned to the exact version in root `package.json:51`, so a
   `@ts-expect-error` directive's necessity is judged by the same compiler this repo's own CI uses —
   see Decision 5). No `dependencies` key — the orchestrator injects it programmatically (Decision 2).

3. **`libs/data/graph/graph-store/conformance-fixture/tsconfig.json`** — standalone. Does **not**
   `extends` `tsconfig.base.json` or anything else in this repo (Decision 3). `module: "NodeNext"`,
   `moduleResolution: "NodeNext"`, `strict: true`, `target: "ES2022"`, `outDir: "dist"`,
   `rootDir: "src"`, `noEmitOnError: true`.

4. **`libs/data/graph/graph-store/conformance-fixture/src/positive-kind-and-rel.ts`** — AC-1/AC-2
   (kind) + AC-1/AC-2 (rel), §4. Imports `createGraphBackend`, `DEFAULT_TYPE_POLICY`, and the
   `TypePolicy`/`EdgeRel` types **only** from the bare specifier `@adhd/sox-graph-store` (never a
   relative path — that is the entire point) and `SqliteAdapterImpl` from `@adhd/sox-store-adapter`.
   Defines a local permissive `TypePolicy` (novel kind `'component'`, novel rel `'COMPONENT_REL'` —
   same literal choices as the in-repo `open-kind-check.bl439.spec.ts:59-67` and
   `open-rel-check.bl448.spec.ts:68-76`, preserving the cross-file naming convention those files
   already established for a future reader). Against a fresh `:memory:` store (`applySchema()`, no
   pre-existing file): writes a node of the novel kind, reads it back; writes an edge of the novel
   rel between two nodes, reads it back via `getEdges`/`getNeighbors`; runs
   `EXPLAIN QUERY PLAN SELECT * FROM node WHERE kind = 'component'` and asserts a
   `SEARCH ... USING INDEX ix_node_kind` row with no `json_each`; runs the edge-side equivalent and
   asserts `ix_edge_src`/`ix_edge_unique`. Emits one NDJSON line per assertion group to stdout
   (`{"check":"<name>","ok":true|false}`) and a nonzero exit if anything throws.

5. **`libs/data/graph/graph-store/conformance-fixture/src/negative-closed-ddl.ts`** — AC-3 (kind) +
   AC-3 (rel), §4. Builds a store from a **local literal** copy of the pre-open (CHECK-bearing) DDL —
   byte-identical to the blob already embedded in `open-kind-check.bl439.spec.ts:160-207` /
   `open-rel-check.bl448.spec.ts:185-232` (both already carry the *same* full closed-schema text; this
   file reuses it verbatim, cited by provenance in a comment, per those files' own established
   convention of keeping a local copy because the package no longer exports a closed-DDL constant to
   import). Applies the **installed** package's `applySchema()` against that pre-built table (proving
   `ensureCheckConstraints`'s structural gate, reached only through `node_modules`, still correctly
   no-ops rather than rebuilding — see Decision 4), then attempts `writeNode`/`writeEdge` with the
   novel kind/rel using a **permissive** policy (so the SQL layer, not the TS layer, is what's
   proven to reject) and asserts both throw matching `/CHECK constraint failed/i`. Emits the same
   NDJSON contract.

6. **`libs/data/graph/graph-store/conformance-fixture/src/compile-break.ts`** — AC-Type, §4. A
   direct adaptation of `open-rel-check.bl448.spec.ts:358-389`'s `assertNeverRel`/`classifyRel`
   pattern, repointed to import `EdgeRel` from the bare specifier `@adhd/sox-graph-store` instead of
   `./index.js`. Committed with the `@ts-expect-error` directive present. This file's *compiler exit
   code* is the assertion (Decision 5) — no runtime assertions needed beyond the sanity call the
   in-repo file already includes.

### Edited files

7. **`libs/data/graph/graph-store/project.json`** — two new targets, both `executor: "nx:run-commands"`,
   both `cache: false` (Decision 6), both `dependsOn: ["build", "^build"]` (this project's *own*
   build, per the `test`-target convention CLAUDE.md's BL-456 section requires when a suite consumes
   its own build output — `^build` alone is insufficient here because the fixture packs graph-store's
   *own* `dist/`, not just its dependencies'):
   - `"tarball-conformance"` — `"command": "node tools/graph-store-tarball-conformance.mjs"`.
   - `"tarball-conformance-vacuity"` — `"command": "node tools/graph-store-tarball-conformance.mjs --vacuity-guard-demo"`.

### Explicitly OUT OF BOUNDS — do not touch

- **`libs/data/graph/graph-store/src/index.ts`** — this packet proves the existing contract; it does
  not change it. Any edit here is a scope violation and means you have found a *product* defect PKT-62
  was not scoped to fix — stop and report it, do not fix it inline.
- **`libs/data/graph/graph-store/src/*.spec.ts`, `*.bl4*.spec.ts`** — the in-repo suites stay exactly
  as they are. This packet adds a sibling verification layer; it is not a replacement, and BL-443's
  own text is explicit that the in-repo suites remain valuable (they prove the *behaviour*; this
  fixture proves the *packaging*).
- **`libs/data/store/store-adapter/`, `libs/observability/sox-telemetry/`** — read-only. The
  orchestrator packs these two as transitive dependencies (Decision 2) but edits nothing in them.
- **`.changeset/`, any package's `version` field, `CHANGELOG.md`** — that is PKT-63's job, gated on
  this packet being green, not the other way around.
- **`node_modules/` anywhere in this repo** — the entire fixture runs in a `mkdtemp` scratch
  directory under `os.tmpdir()`, physically outside this repo's tree. Never write into this repo's
  own `node_modules`.

---

## 3. Every decision, ruled

### Decision 1 — pack with `pnpm pack`, not literal `npm pack`

BL-443's and PKT-62's own prose both say "npm pack." I am overruling the literal tool name while
keeping the intent (a real npm-style tarball, installed through `node_modules`, never a workspace
symlink). **Reason:** `libs/data/graph/graph-store/package.json:28` declares
`"@adhd/sox-store-adapter": "workspace:*"`, and `store-adapter/package.json:27` declares
`"@adhd/sox-telemetry": "workspace:*"` in turn. `npm pack` does no dependency resolution — it tars
`package.json` byte-for-byte, so the packed manifest would literally contain the string
`"workspace:*"`, which is not a protocol `npm`/`pnpm` outside this workspace can resolve at all
(`ERR_INVALID_ARG_URL`/`EUNSUPPORTEDPROTOCOL` depending on installer). That is not "the way a
consumer actually gets it" — it's an artifact no real consumer could ever install, because it is not
what actually reaches the registry. Confirmed against this repo's real publish path:
`package.json:26-27`'s `"release": "changeset publish"` / `"release:prepared"` script and
`.github/workflows/release.yml`'s `publish: pnpm release:prepared` both run under `pnpm`, and pnpm's
`pack`/`publish` commands rewrite `workspace:*` (and `workspace:^`/`workspace:~`) to the dependency's
*current resolved version* before the tarball is written — this is pnpm's documented behaviour and it
is exactly what actually ships to npm today. `pnpm pack` reproduces the true published artifact;
`npm pack` reproduces an artifact this repo has never actually shipped. The loser (`npm pack`) is
rejected because it fails to satisfy the packet's own goal ("prove the public contract the way a
consumer actually gets it") — it would prove a contract that does not exist.

### Decision 2 — pin the two transitive workspace dependencies to their own local tarballs

`@adhd/sox-graph-store` depends on `@adhd/sox-store-adapter` (`package.json:28`), which depends on
`@adhd/sox-telemetry` (`store-adapter/package.json:27`) — both `workspace:*`, both rewritten by
`pnpm pack` (Decision 1) to a real semver range (e.g. `^0.2.0`) pointing at whatever is *actually*
published on the real npm registry under that name. Two options:

- **(a) Let `pnpm install` in the scratch project resolve those two names against the real registry.**
  **Rejected.** This makes the fixture's pass/fail depend on whatever version of `store-adapter`/
  `telemetry` happens to be live on npm at run time — which may predate the local worktree's changes
  to either package, may not exist yet pre-first-publish, and turns a deterministic conformance gate
  into a network-and-registry-state-dependent one. It also silently stops testing what this wave
  actually built the moment any of the three packages' local source diverges from its last publish.
- **(b) Pack `store-adapter` and `sox-telemetry` too, from the same worktree, and pin the scratch
  project to all three local tarballs — chosen.** The orchestrator (§4) packs all three, and injects
  both a direct `dependencies` entry **and** a `pnpm.overrides` entry (belt-and-suspenders — the
  direct dependency alone should already win via normal hoisting since the rewritten range is
  satisfied by the exact local version, but the override removes any doubt if a future version bump
  desyncs the two) for `@adhd/sox-store-adapter` and `@adhd/sox-telemetry`, each pointing at
  `file:<absolute-path-to-local-tarball>`. This keeps the fixture hermetic and deterministic while
  still being a real `node_modules` install through real npm tarballs — the property that actually
  matters for BL-443. Genuine third-party dependencies (`better-sqlite3`, `@tursodatabase/database`,
  `@opentelemetry/*`, `ulid`) resolve against the real registry normally — that is not a new network
  dependency, `pnpm install --frozen-lockfile` in `release.yml` already assumes registry reachability.

### Decision 3 — the fixture's `tsconfig.json` does not extend `tsconfig.base.json` or anything else in this repo

Even though §1 found no literal `paths` entry for `@adhd/sox-graph-store`, extending the repo's base
config would still inherit its `moduleResolution`/`module` settings and — more importantly — run in a
tsconfig whose `include`/`exclude` and toolchain assumptions are monorepo-shaped. The fixture's
`tsconfig.json` is a **from-scratch, standalone** config, matching what an actual external consumer's
`tsconfig.json` looks like: no awareness this repo exists. This is the direct structural guarantee
against reintroducing the case-(1) blind spot from §1 in a new form.

### Decision 4 — the negative arm proves SQL-layer rejection, not TypeScript-layer rejection

`negative-closed-ddl.ts` must use a **permissive** local `TypePolicy` (accepting the novel kind/rel),
not the installed package's `DEFAULT_TYPE_POLICY`. **Reason:** `DEFAULT_TYPE_POLICY.validateKind`/
`validateRel` (`index.ts:626-641`) already reject an unregistered kind/rel in TypeScript, before any
SQL is ever issued — so a test using the default policy would pass even if the SQL CHECK constraint
had somehow been silently dropped from the legacy DDL, proving nothing about the honest
new-stores-only scope. This mirrors `open-kind-check.bl439.spec.ts:217-219` and
`open-rel-check.bl448.spec.ts:251-253`'s own explicit comments on why AC-3 must use the permissive
policy. The alternative (default policy) is rejected because it collapses two independent guards
(TS-layer, SQL-layer) into an assertion that only proves the stronger one still works, silently
retiring coverage of the weaker one — exactly the BL-167 "guard edited into green" failure shape.

### Decision 5 — the compile-break criterion is proven by `tsc --noEmit` exit code against `dist/*.d.ts`, never by a runtime check

`compile-break.ts` ships with `@ts-expect-error` already in place, exactly as
`open-rel-check.bl448.spec.ts:386` does. If `EdgeRel`'s widening (`(string & {})`, `index.ts:390`)
did not ship in the installed tarball's `.d.ts` — i.e. if `dist/index.d.ts` still declared the closed
ten-literal union — the `default` arm would narrow to `never`, `assertNeverRel(rel)` would compile
with **zero** error, and the `@ts-expect-error` directive would itself become a compile error
("Unused '@ts-expect-error' directive," `noUnusedLocals`-adjacent TS diagnostic 2578, which `strict`
mode surfaces as a real failure). This is the file's entire mechanism: **a clean `tsc --noEmit` exit
0 is the green signal**; a nonzero exit is red. No `console.log`/`process.exit` inside this file at
all — its correctness is compiler-diagnostic-only, which is precisely what proves the `.d.ts`, not
the runtime `.js`, carries the widened type. This is also the direct answer to the packet's demand
that "the tarball's `dist/*.d.ts` matches what the source claims": this file is a live probe of that
claim, not an assumption of it. `typescript` is pinned to `6.0.3` (Decision, §2 item 2) specifically
so this diagnostic's exact wording/behaviour matches what `npx nx typecheck graph-store` already
proved in-repo (`open-rel-check.bl448.spec.ts`'s own docstring at `:364-372` names this exact
mechanism) — a different TS version could in principle change diagnostic numbering or strictness
defaults and produce a false read.

### Decision 6 — both new nx targets are `cache: false`

Unlike `graph-store:test` (deterministic, pure-function, safely cacheable), this fixture performs
real filesystem side effects outside the nx-tracked output graph (a `mkdtemp` scratch directory, a
real `pnpm install` against the live registry for third-party deps). Caching a run whose correctness
partly depends on external, uncached state (registry availability/content for `better-sqlite3` et al.)
risks a stale cache hit reporting "conformance proven" when the underlying registry state has since
changed, or masking a real regression behind a cache key that didn't change. `born-conformance`
(`packages/sox-nx/project.json:61`) sets the same precedent (`"cache": false`) for the same class of
reason — an artifact-reality check, not a pure computation.

### Decision 7 — the vacuity guard renames `dist/`, it never deletes it

The packet's acceptance text says "deleting the built `dist/` must make the fixture fail loudly." I am
implementing this as **rename `dist/` → `dist.vacuity-bak/`, run the check expecting failure, then
restore in a `finally` block regardless of outcome** — never an actual `rm -rf`. **Reason:** BL-235 is
explicit that `nx build` "destroys a working artifact and cannot restore it" when source doesn't
compile, and a literal `rm -rf dist` inside an automated fixture creates exactly that failure mode the
instant any step after the deletion throws unexpectedly (a bug in the orchestrator itself, a crash,
`^C`) — the artifact is gone with no recovery path, in a worktree another stage of this same pipeline
(the implementer, then a reviewer, then a second implementer) needs to keep working. A rename-then-
restore-in-`finally` produces the **identical externally observable proof** (dist absent → pack/install/
run fails loudly, not silently) while remaining trivially recoverable even if the demo script itself
crashes mid-run. This is a deliberate, disclosed strengthening of the acceptance text's literal wording,
not a weakening — the observable behaviour the criterion cares about (loud failure on missing dist) is
unchanged; only the blast radius of a script bug is reduced from "unrecoverable" to "recoverable."
This demo runs only under the separate `tarball-conformance-vacuity` target (§2 item 7) — never as
part of the default `tarball-conformance` run — so a normal green run never touches `dist/` at all.

### Decision 8 — fixture *source* files live under `libs/data/graph/graph-store/conformance-fixture/`, the *orchestrator* lives under `tools/`

Both locations are pre-authorised by PKT-62's own "Files" line ("a new conformance fixture under
`tools/` or `libs/data/graph/graph-store/`"). Splitting rather than choosing one: the orchestrator
(`tools/graph-store-tarball-conformance.mjs`) is generic infrastructure — process orchestration,
`mkdtemp`, `pnpm pack`/`install`/`tsc` invocation — matching `tools/born-conformance.js`'s precedent
exactly (same directory, same shape, same "plain node script wired as an nx target" pattern). The
fixture *content* (what a consumer's project would actually contain) is package-specific and belongs
next to the package it tests, reviewable as real, syntax-highlighted `.ts`/`.json` files rather than
string literals embedded in the orchestrator — the alternative (everything as template strings inside
one `tools/*.mjs` file) is rejected because it is unreviewable and untypecheckable as ordinary source,
the same objection this repo's own `OLD_CHECK_BEARING_INLINE_DDL` convention in `open-kind-check.bl439.spec.ts`
already resolved in favour of real files wherever avoidable.

---

## 4. Acceptance criteria, each naming BL-443, each with its RED arm

All criteria are proven by `node tools/graph-store-tarball-conformance.mjs` (default mode) unless
marked otherwise. The script must print one line per named check below and exit 0 only if every one
reads `PASS` — see §6's three-state contract.

**AC-1 (BL-443) — a consumer installing the tarball can inject a `TypePolicy` and write a novel
`kind`, through `node_modules` resolution only.**
Green: `positive-kind-and-rel.ts`, compiled and run from the installed tarball, writes a node with
`kind: 'component'` under a permissive injected policy and reads it back with `kind === 'component'`.
**RED arm:** run the identical fixture against a tarball packed from a tree at commit `37863fee`
(PKT-73, immediately before PKT-58 landed) — `writeNode` throws `ConstraintError` because
`DEFAULT_NODE_KINDS` still rejects `'component'` in TypeScript, **and** even bypassing that with a
permissive policy the underlying SQL `INSERT` fails `CHECK constraint failed: kind`, because the
pre-PKT-58 fresh DDL still declares the CHECK. Either the registration call's effect is absent or the
type is rejected — the packet's own acceptance wording, reproduced exactly.

**AC-2 (BL-443) — the same, for a novel `rel`, traversed via `getEdges`/`getNeighbors`.**
Green: `positive-kind-and-rel.ts` writes an edge with `rel: 'COMPONENT_REL'` between two nodes and
both `getEdges({rel: 'COMPONENT_REL'})` and `getNeighbors(a, {rel: 'COMPONENT_REL'})` report it.
**RED arm:** identical fixture against a tarball packed pre-PKT-74 (`ae262a2d`, PKT-58 landed,
PKT-74 not yet) — `writeEdge` throws, because `writeEdgeInternal`'s `validateRel` (added by PKT-59,
already present at that commit) still enforces the closed `DEFAULT_EDGE_RELS`, **and** the fresh DDL
still carries `CHECK (rel IN (...))`.

**AC-3 (BL-443) — `EXPLAIN QUERY PLAN` shows the novel kind resolves via `ix_node_kind`, zero
`json_each`.**
Green: the plan for `SELECT * FROM node WHERE kind = 'component'` contains a `SEARCH ... USING INDEX
ix_node_kind` row and no row mentions `json_each`. **RED arm:** the pre-open tree makes AC-1 itself
fail before this query is ever reachable (nothing to plan for a row that was never written) — this
criterion's red arm is therefore AC-1's red arm; it does not need an independent regression case
beyond what `open-kind-check.bl439.spec.ts:130-150`'s in-repo `json_each` contrast already covers for
the *tag-workaround* comparison (out of this packet's scope — that comparison is already proven
in-repo and is not re-proven through the tarball).

**AC-4 (BL-443) — the closed-DDL negative arm: a store built with the pre-open CHECK-bearing schema
still rejects a consumer kind AND a consumer rel, through the installed package.**
Green: `negative-closed-ddl.ts`, using a permissive policy against a hand-built closed-schema store,
throws `/CHECK constraint failed/i` on both `writeNode({kind:'component'})` and
`writeEdge(a, b, 'COMPONENT_REL')`. **RED arm:** run the same fixture against a hypothetical tarball
in which the *fresh* DDL edit (PKT-58/PKT-74) was mistakenly also applied to the legacy-rebuild
target (`NODE_TABLE_DDL`/`EDGE_TABLE_DDL`) or in which `ensureCheckConstraints`'s structural gate
(BL-447) was reverted to the old literal-substring probe — either defect would make this store
silently accept the novel kind/rel (or silently rebuild it away), and the assertion would observe no
throw. This is the direct external-consumer-facing regression guard for exactly the defect class
BL-295/BL-313 already caused once.

**AC-5 (BL-443) — the tarball's `dist/*.d.ts` matches what the source claims: `EdgeRecord.rel` into
an `EdgeRel`-typed exhaustive switch fails to compile.**
Green: `npx tsc --noEmit -p conformance-fixture/tsconfig.json` (materialized copy, run against the
installed `node_modules/@adhd/sox-graph-store/dist/index.d.ts`) exits 0, with `compile-break.ts`'s
`@ts-expect-error` directive judged *necessary* (i.e. it is silently consuming a real type error, not
sitting on dead code). **RED arm:** run the identical fixture against a tarball packed pre-PKT-74 —
`EdgeRel` is still the closed ten-literal union, `assertNeverRel(rel)`'s `default`-arm type is `never`,
the directive becomes unnecessary, and TS diagnostic 2578 ("Unused '@ts-expect-error' directive")
makes `tsc --noEmit` exit nonzero — the compile-break RED arm is a real, distinct compiler failure,
not an inverted assertion.

**AC-6 (BL-443) — the vacuity guard: deleting (renaming away) the built `dist/` makes the fixture
fail loudly, never skip.**
Proven by the separate `tarball-conformance-vacuity` target (Decision 7), not the default run. Green:
with `libs/data/graph/graph-store/dist/` renamed away, the orchestrator's precondition check at Step 0
(§5) detects the missing `dist/index.js`/`dist/index.d.ts` and the script prints an explicit
`FAIL: dist/index.js missing — run npx nx build graph-store first` line and exits 1 — never prints
`SKIP` for this case, and never exits 0. **RED arm (i.e. the guard's own failure mode, which this
criterion exists to catch):** if the precondition check were absent, `pnpm pack` would silently
succeed by packing whatever stale `.d.ts`/`.js` happen to exist elsewhere, or fail with an opaque
`ENOENT` deep inside `tsc`'s module resolution that a human would misread as "the network is down" —
either way, not the named, loud, top-of-output failure this criterion requires.

---

## 5. Risks — anything that could destroy data or a `dist/` artifact, and the sequencing that avoids it

1. **`npx nx build graph-store` is destructive (BL-235).** It runs under `rm -rf dist/` before
   knowing the rebuild will succeed. Sequencing: run it **exactly once**, deliberately, at the start
   of this packet's work (not repeatedly "to check"), after confirming via `git worktree list` /
   `ps` that no other agent is concurrently editing `libs/data/graph/graph-store/src/` in *this*
   worktree (worktrees are physically separate directory trees — `.worktrees/pkt62-tarball-conformance/`
   has its own independent `dist/`, so this cannot destroy another worktree's or the main checkout's
   artifact; the risk is scoped to this worktree's own build only). Never run it under artificial CPU
   load.
2. **The `nx test` → `dependsOn: ["^build"]` chain also rebuilds `store-adapter`/`sox-telemetry`
   dist** the first time either target runs in this worktree — same BL-235 exposure, same mitigation
   (run once, deliberately, not repeatedly).
3. **The vacuity-guard demo (AC-6) touches `dist/` by design.** Decision 7's rename-then-restore
   removes the unrecoverable-deletion risk; the residual risk is the demo script crashing between the
   rename and the `finally` restore. Mitigate with `try { rename; run; } finally { restore; }` at the
   top level of the `--vacuity-guard-demo` code path, and print the restore's own success/failure
   explicitly (a silent restore failure would leave `dist/` renamed away for every subsequent target
   in this worktree, including the reviewer's).
4. **Never touch `~/.memory/*` or any file inside this repo's own `node_modules/`.** Nothing in this
   packet's design does either — the scratch consumer project is `mkdtempSync(os.tmpdir())`, which on
   this machine resolves outside `/Users/nix/dev/ai/sox-ecosystem` entirely. Verify this explicitly in
   the orchestrator with an assertion that the scratch path does not start with the repo root, and
   fail loudly (not silently proceed) if it ever does — a defense against a future `TMPDIR` override
   accidentally pointing inside the repo.
5. **`pnpm pack` writes a `.tgz` file.** Direct it at `--pack-destination <scratch-tarball-dir>`
   (also under `os.tmpdir()`), never at the package directory itself or anywhere inside the repo tree
   — an accidental `graph-store/adhd-sox-graph-store-0.5.3.tgz` committed by a future `git add -A`
   (already banned repo-wide, but defense in depth) would be dead weight at best.
6. **Clean up scratch directories on both success and failure.** Wrap the whole orchestrator body in
   `try { ... } finally { rmSync(scratchRoot, {recursive:true, force:true}); }` — a left-behind
   multi-hundred-MB `node_modules` tree in `/tmp` across repeated CI/local runs is a real disk-fill
   risk over time, not merely untidy.

---

## 6. The gate — exactly which nx targets the implementer must run

In order, after implementation is complete:

1. `npx nx lint graph-store` — the new `conformance-fixture/*.ts` files must pass this repo's eslint
   config (the fixture's own `tsconfig.json` is standalone per Decision 3, but `nx lint` for the
   `graph-store` project still walks its own `src/`-adjacent tree; confirm the lint target's
   `lintFilePatterns` picks up `conformance-fixture/**/*.ts` — if it does not by default, that is an
   expected, in-scope edit to `project.json`'s `lint` target options, not a deviation from this spec).
2. `npx nx build graph-store` — run once, deliberately (Risk 1). This produces the `dist/` the
   conformance target packs.
3. `npx nx typecheck graph-store` — must stay green; this packet adds no source-level type changes to
   `index.ts`, so this is a regression guard, not a new capability.
4. `npx nx test graph-store` — must stay at **5 test files / 67 tests passing** (the baseline recorded
   in this spec's header) or grow only by tests this packet's own scope adds (it adds none to the
   in-repo suite; all new assertions live in the tarball fixture). Any change to the 67-count means an
   unrelated regression — trace it, do not absorb it.
5. `npx nx run graph-store:tarball-conformance` — **the acceptance gate itself.** Must print all six
   AC lines as `PASS` (§4) and exit 0. Report the exact printed output, not a paraphrase.
6. `npx nx run graph-store:tarball-conformance-vacuity` — must print the AC-6 `FAIL: dist/index.js
   missing...` line and exit 0 (the demo's own exit code means "the guard behaved correctly," per
   Decision 7's framing — do not confuse this with the fixture "failing"). Confirm
   `libs/data/graph/graph-store/dist/` is present and intact immediately afterward (`ls`), proving the
   restore ran.
7. `node tools/check-suite-tree-state.mjs --project graph-store` — quote alongside the AC-5 result
   from step 5, per BL-456's requirement that a suite result states the tree state it ran against.
8. Do **not** run `npx nx run registry:sync-index` — `libs/data/graph/graph-store` is a data-layer
   library, not a registered extension (`libs/data/CLAUDE.md`'s own build-rules section says so
   explicitly).
9. Commit by explicit pathspec only: the new/edited files listed in §2, nothing else. If
   `pnpm-lock.yaml` changed (it should not — no new workspace-adjacent dependency edges are added by
   this packet; the fixture's own `typescript` devDependency lives in a scratch project outside the
   workspace and is never installed by the root `pnpm install`), investigate before committing it —
   an unexpected lockfile diff here is a signal something leaked outside the scratch directory.

**Do not proceed to PKT-63 (release train) reporting.** This packet's job ends at a green gate; PKT-63
is a separate stage that must not start publishing until this one is verified, per PKT-62's own
"sequencing" line in the plan.
