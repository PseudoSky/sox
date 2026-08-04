# Turso Library Publish-Readiness Assessment

> **Goal being assessed (repo owner, verbatim):** *"We need to get the libraries to a stable+published
> point so I can start migrating other packages to turso."*
>
> **Status: NOT READY.** One hard install-breaking blocker (B1), one process blocker that makes the
> release pipeline a no-op (B2), and one data-safety blocker on the migration on-ramp itself (B3).
> B1 and B2 are cheap. B3 is not.
>
> **Scope:** assessment only. Nothing was published, versioned, tagged, released, rebuilt, or
> registry-synced in producing this document. No service was touched. No backlog item was created or
> edited.
>
> **Measured:** 2026-08-04, branch `wip/turso-live-metrics`, HEAD `643afd5`.
> This tree is shared with concurrent agents; where a finding depends on uncommitted work, that is
> stated explicitly.

---

## §0 The one-paragraph answer

The libraries are **already published** — `@adhd/sox-store-adapter@0.1.0`, `@adhd/sox-graph-store@0.5.0`,
`@adhd/sox-memory-core@0.4.0` and six others went to npm on **2026-07-27**. The problem is not
"getting them published," it is that **npm is 91 library commits stale**, and the next publish is
currently *guaranteed to ship a broken install*: both `store-adapter` and `memory-core` acquired a hard
runtime dependency on `@adhd/sox-telemetry`, which **does not exist on npm** (404). Separately, the
Changesets ledger is empty, so the release pipeline on `main` today publishes **nothing at all**.
Those two are hours of work. The genuine engineering blocker is that the *migration path* a new
consumer would take — `migrateStore()` — has no backup, no idempotency, and no default verification,
and the graph store's node-type vocabulary is still closed, so "migrating other packages" means
either forking the library or laundering domain types through `kind:'generic'`.

---

## §1 Library-by-library publish-readiness verdict

Surface scoped from `libs/data/CLAUDE.md` §"Package listing" plus an executor/manifest sweep of
`libs/`, `packages/`, `apps/`, `extensions/`. **28 `@adhd/sox-*` packages are publishable**
(`check-publishable` output, §5.1).

| Package | npm today | Source drift since publish | Verdict |
|---|---|---|---|
| `@adhd/sox-store-adapter` | `0.1.0` (2026-07-27) | **19 src commits** | ⛔ **BLOCKED** — B1, B3, B6, B7, B8 |
| `@adhd/sox-graph-store` | `0.5.0` (2026-07-27) | 1 src commit | ⚠️ **SHIPPABLE BUT NOT STABLE** — B5 is a known one-way door |
| `@adhd/sox-memory-core` | `0.4.0` (2026-07-27) | **64 src commits** | ⛔ **BLOCKED** — B1, plus mid-incident churn |
| `@adhd/sox-telemetry` | **NOT PUBLISHED (404)** | 3 src commits | ⛔ **BLOCKING EVERYTHING ELSE** — B1 |
| `@adhd/sox-vector-store` | `0.3.0` | 2 src commits | ⚠️ no Turso path at all — B9 |
| `@adhd/sox-hybrid-search` | `0.3.0` (2026-07-23) | 1 src commit | ✅ not on the adapter seam; unaffected |
| `@adhd/sox-analysis` / `-ingest` / `-embedding-provider` / `-task-queue` / `-blob-store` / `-claim-verification` | published | low | ✅ / ⚠️ (README gaps, B10) |

**Commands / files behind this table**

```
$ npm view @adhd/sox-telemetry
npm error code E404 … '@adhd/sox-telemetry@*' could not be found
$ npm view @adhd/sox-store-adapter@0.1.0 dependencies
{ "better-sqlite3": "^12.10.0" }          ← telemetry absent: 0.1.0 predates the dep
$ npm view @adhd/sox-graph-store@0.5.0 dependencies
{ "@adhd/sox-store-adapter": "0.1.0" }
$ git log --oneline --since="2026-07-27T06:11:00Z" -- libs/ | wc -l
91
```

Per-package drift, same window: `store-adapter` 19, `memory-core` 64, `sox-telemetry` 3,
`vector-store` 2, `graph-store` 1, `hybrid-search` 1 (`git log --oneline --since=… -- <dir>/src`).

### Test evidence (run this session, `--exclude-task-dependencies` so no build was triggered)

```
$ npx nx run-many -t test --projects=store-adapter,graph-store \
    --exclude-task-dependencies --skip-nx-cache
store-adapter   13 files, 307 tests passed
graph-store      1 file,   46 tests passed
```

The `store-adapter` suite's Turso half **genuinely executed** — `@tursodatabase/database@0.7.1` resolves
(`node_modules/.pnpm/@tursodatabase+database@0.7.1/…/dist/promise.js`), and the `hasTurso` guards here are
*synchronous* `require.resolve` IIFEs evaluated at collection time
(`src/__tests__/turso-readonly-fts.bl391.test.ts:38-47`), so they are **not** subject to
`DEBT-TEST-VITEST-FROZEN-SKIP-TURSO-001`'s frozen-`{skip}` defect — that item's failure mode is specific
to the memory-server suites, which set `hasTurso` in an async `beforeAll`. Zero tests reported skipped.
This is the strongest single piece of evidence *for* store-adapter's readiness, and it is why B1/B2/B3
— not correctness of the adapter itself — are what stand in the way.

`graph-store`, a `0.5.0` public package carrying bitemporal validity, FTS5 sync, supersession chains,
namespace isolation and traversal, has **46 tests in a single file**. That is thin for the semver
commitment it is about to take on, but no failure was observed.

---

## §2 Blocking defects, ranked

### B1 — ⛔ CRITICAL: publishing today 404s every consumer's install (`@adhd/sox-telemetry` is not on npm)

**Reproduction (three independent confirmations):**

```
$ npm view @adhd/sox-telemetry            → E404, not found
$ /usr/bin/grep -rn "@adhd/sox-telemetry" libs/data/store/store-adapter/dist/retry.js
2:import { log } from '@adhd/sox-telemetry';
$ /usr/bin/grep -rn "@adhd/sox-telemetry" libs/memory-core/dist/telemetry.js
89:const sox_telemetry_1 = require("@adhd/sox-telemetry");
```

Both `libs/data/store/store-adapter/package.json` and `libs/memory-core/package.json` declare
`"@adhd/sox-telemetry": "workspace:*"` in **`dependencies`** (not dev). Changesets rewrites
`workspace:*` to a concrete version at publish time (`updateInternalDependencies: "patch"`,
`.changeset/config.json`), so the next `store-adapter` and `memory-core` tarballs will pin
`@adhd/sox-telemetry@0.1.x` — a package that does not exist. This is exactly the BL-42/BL-43
dependency-404 class the repo already has a gate for.

**Why the gate misses it.** `scripts/check-publishable.ts:67-76` builds its "published" set from
*workspace* manifests (`if (j.private !== true) publishedNames.add(j.name)`) and then checks
`workspace:*` deps against that set (`:98`). `sox-telemetry` is non-private, so the check passes —
it has never consulted the registry. It ran clean this session:

```
$ pnpm run check-publishable
check-publishable: WARN libs/data/store/store-adapter/package.json: missing engines.node (recommend ">=20").
check-publishable: OK — 28 published @adhd packages have a fresh-machine-safe dependency shape.
```

`store-adapter`'s telemetry usage is real and load-bearing, not incidental —
`libs/data/store/store-adapter/src/retry.ts:3,9` ("BL-401: this is store-adapter's first consumer of
`@adhd/sox-telemetry`").

**Cost:** ~1h. Publish `sox-telemetry` in the same Changesets run (it is already correctly shaped:
`private` unset, `publishConfig.access: public`, `engines.node: ">=20"`, zero `@adhd` deps). Then
~2h to harden `check-publishable.ts` with a registry existence probe so this class cannot regress.

---

### B2 — ⛔ CRITICAL: the release pipeline is currently a no-op; 91 commits are unversioned

```
$ ls -1 .changeset/*.md
NONE                                  ← only config.json exists
```

`release.yml` runs `changesets/action@v1` with `publish: pnpm release:prepared`. With an empty
changeset ledger, that action creates no "Version Packages" PR and publishes nothing. Every one of
the 91 library commits since 2026-07-27 — including the entire Turso go-live, BL-373 stale-`tshm`
recovery, BL-391 readonly-FTS, BL-385 `backupTo`, BL-352 open-time integrity — is invisible to the
release machinery.

This also forces a **semver decision that nobody has made**: `openDb()` went sync → async
(`DEBT-MEMORYCORE-OPENDB-MISSING-AWAIT-TESTS-001` records ~19 spec files and ~267 test failures from
exactly this migration), and `StoreAdapter`'s entire surface is `Promise`-returning. For `0.x`
packages a minor bump is technically sufficient, but publishing a breaking async conversion as
`0.1.0 → 0.2.0` with no changeset prose is precisely how a downstream adopter gets surprised.

**Cost:** ~3h to author changesets across 6+ packages with honest breaking-change notes, plus a
decision from the owner on whether the adapter seam goes `1.0.0` (see §3, ordering constraint OC-4).

---

### B3 — ⛔ CRITICAL: `migrateStore()` is the on-ramp for this exact goal, and it is unsafe

`BUG-STOREADAPTER-MIGRATE-UNSAFE-001` (CRITICAL, OPEN). I re-read the cited source; the item
reproduces on every point:

- `libs/data/store/store-adapter/src/migration.ts:444-531` — per-table copy in its own
  `try/catch`; on error it records `errored: true` and **continues to the next table**.
- `:567-613` — the `vec_node` phase does the same.
- `:615-621` — `_adapter_meta.migrated_from` / `migrated_at` are stamped **regardless** of prior errors.
- `scripts/migrate-store-to-turso.mjs:274-288` — `ok` is `verify ? verifyOk : (result.totalRows > 0)`;
  `result.tables[*].errored` is **never inspected**, and `--verify` is opt-in and off in every
  `--help` example.
- `:218-224` — `--mode in-place` opens the Turso *target* on the same path as the source, with no
  snapshot. `/usr/bin/grep -rn backup libs/data/store/store-adapter/src/` → **zero hits**; the working
  `backupStore()` (`libs/memory-core/src/backup.ts`) is never called.

This is not a hypothetical. The item was filed *because* the live store landed post-migration with
4241/4410 missing vectors and contradictory queue counters. **The first external package the owner
migrates to Turso will run this script against its own only copy of its data.** Publishing
`store-adapter` while this ships is the single highest-consequence item in this document.

**Cost:** 2–3 days. Mandatory pre-migration snapshot; `MigrationResult.ok` derived from
`tables[*].errored`; CLI honoring it; `--verify` default-on and extended past row counts; idempotency
(`INSERT OR IGNORE` or refuse-on-`migrated_from`-without-`--force`); plus the red→green test the item
already specifies.

---

### B4 — 🔴 HIGH: `typecheck` is a gate in no pipeline, and 9 of 12 public data libs cannot be typechecked at all

`.github/workflows/ci.yml:61-84` runs `nx affected -t build`, `-t lint`, `-t test`,
`validate-manifests`, registry drift. **No `typecheck`.** `.github/workflows/release.yml:60-64` runs
`npx nx run-many -t build` then `check-publishable` then publishes — **no lint, no test, no typecheck
on the release path at all.**

Target inventory (`jq '.targets | keys' <project.json>`):

| has `typecheck` | `store-adapter`, `memory-core`, `sox-telemetry` |
|---|---|
| **no `typecheck`** | `graph-store`, `vector-store`, `hybrid-search`, `analysis`, `ingest`, `embedding-provider`, `task-queue`, `blob-store`, `claim-verification` |

So even if CI added `-t typecheck` tomorrow, nine public packages would be silently skipped by
`nx affected`. This is verbatim the BL-248 gap class (15 real type errors shipped through a green
`build,lint,test` sweep) — and `DEBT-MEMORYCORE-NO-TYPECHECK-TARGET-001` already records it for
memory-core, which has since been fixed.

**It is not theoretical right now.** Running the gate this session:

```
$ npx nx run-many -t typecheck --projects=store-adapter,memory-core,sox-telemetry --skip-nx-cache
memory-core:typecheck    ✔
sox-telemetry:typecheck  ✔
store-adapter:typecheck  ✖  libs/data/store/store-adapter/src/integrity.ts:1087:5 - error TS2322:
    Type 'Record<string, unknown> | null' is not assignable to type 'Record<string, unknown> | undefined'.
```

**Attribution:** `git diff --stat` shows `integrity.ts` is `+246` lines uncommitted, and line 1087
falls inside that added hunk (a BL-342 `json_column_valid` probe). This is a **concurrent agent's
in-flight work, not HEAD** — I did not author it and have not touched it. It is reported here because
it is exactly what a release-path typecheck gate exists to catch, and today nothing would.

**Cost:** ~4h. Add `typecheck` targets to the nine packages (copy store-adapter's `nx:run-commands`
+ `tsc -p … --noEmit` convention verbatim — do not invent a new one), add `-t typecheck` to `ci.yml`,
and make `release.yml` run `lint,test,typecheck` before it publishes.

---

### B5 — 🔴 HIGH: `graph-store`'s closed `kind`/`rel` vocabulary is a one-way door for third-party adoption

`BUG-SOXGRAPH-TYPED-NODES-001` (HIGH, OPEN). The core complaint reproduces:

- `libs/data/graph/graph-store/src/index.ts:19` — `kind TEXT NOT NULL CHECK (kind IN
  ('episode','entity','claim','community','session','generic'))`
- `:51` — `rel TEXT NOT NULL CHECK (rel IN ('MENTIONS',…,'DEPENDS_ON'))`
- `:787-795` — `writeNode()` validates against `DEFAULT_NODE_KINDS` and throws `ConstraintError` with
  an explicit steer: *"Non-memory reuse … should write kind:'generic' and carry a sub-kind in
  tags/metadata instead of registering a new kind."*
- The same steer is enshrined as a published *invariant* in
  `libs/data/graph/graph-store/package.json` → `sox.concerns` / `sox.invariants`.

This sits squarely in the path of "migrate other packages": a new consumer's domain types must either
patch the dependency's `CHECK` or launder through `generic`.

**One correction to the backlog item, load-bearing for how it gets fixed.** The item's central
argument is *"`kind` is not indexed at all … there is no `ix_node_kind`, so the closed enum buys zero
query-plan advantage."* **That is stale.** `ix_node_kind` exists twice at HEAD:

```
src/index.ts:62   CREATE INDEX IF NOT EXISTS ix_node_kind ON node(kind);
src/index.ts:150  CREATE INDEX IF NOT EXISTS "ix_node_kind" ON "node" ("kind");   (drizzle path)
```

The *asymmetry* survives and is the real argument: blessed kinds are indexed, `generic`+tag consumers
scan unindexed JSON. But whoever picks this up must not build the case on "there is no index."

**Sequencing:** do **not** reopen the `CHECK` first — `BL-313` was a CRITICAL data-loss incident from
a `CHECK`-constraint rebuild on this shared populated store. `FEAT-SOXGRAPH-SUBKIND-INDEX-001` (HIGH,
OPEN) is the correctly-scoped additive increment and explicitly forbids touching `kind`/`rel`.

**Cost:** increment ~3 days; full rearchitecture ~2 weeks + a migration design that survives BL-313.

---

### B6 — 🔴 HIGH: `multiprocess_wal` ships **on by default**, contradicting the feature's own constraint

`libs/data/store/store-adapter/src/turso-adapter.ts:228-234`:

```ts
const experiments: string[] = ['index_method'];
if (opts.experimental?.multiprocessWal !== false) {
  experiments.push('multiprocess_wal');
}
```

`FEAT-SOX-001`'s own constraint list says *"Multi-process WAL must be opt-in (experimental, not
default)."* At HEAD it is **opt-out**, and `capabilities.multiprocessWrite` defaults `true`
(`turso-adapter.ts:310`). The README documents the default candidly (`README.md:202-207`) but
documenting a risky default is not the same as not shipping it.

The risk is measured, not speculative: `BL-373` — a stale `-tshm` sidecar makes the store
**permanently unopenable** after an ordinary restart, crash-looping the backend, and required a
bespoke recovery path (`turso-adapter.ts:262-298`). `.tshm` is a versioned on-disk coordination format
whose stability is explicitly disclaimed upstream (`docs/spec/sox-executor.md:582,613`), and it is
mutually exclusive with MVCC (`:778`). Turning it on by default for every third-party consumer means
their first Turso outage is one we chose for them.

**Cost:** ~2h to flip the default and update README + capability docs. This is a **breaking behavior
change**, so it must land **before** the version bump, not after (OC-3).

---

### B7 — 🟠 MEDIUM: `StoreAdapter.exec()`'s DDL contract is not true on Turso

`BUG-TURSO-ADAPTER-EXEC-DDL-SILENT-NOOP-001` (MEDIUM, OPEN). Confirmed:
`turso-adapter.ts:246-261` documents that `DROP TABLE`/`DROP TRIGGER` against fts5/vec0 objects
"succeed" while the object **remains in `sqlite_master`**. The interface
(`src/types.ts:245` — `exec(sql: string): Promise<void>`) carries no such caveat, and the only guard
anywhere is caller-side in one consumer (`libs/memory-core/src/db.ts` —
`dropVec0ViaBetterSqlite3()`, `dropFts5ResidueViaBetterSqlite3()`). `graph-store`, `vector-store`,
`blob-store` and `task-queue` all call `exec()` and all publish independently. The dialect layer knows
(`src/types.ts:127-139` warns on `dropLegacyDDL`) — the adapter itself does not enforce.

**Cost:** ~1 day for an adapter-level `verifyDropped`/`dropTableVerified` + the interface-doc caveat.

---

### B8 — 🟠 MEDIUM: the read-only + `fts_match` limitation is undocumented for consumers

The limitation is real and correctly *handled*: Turso's native read-only connect blocks
`fts_match`/`fts_score` outright (`Resource is read-only`), so `allowFtsInReadonly` opens the driver
writable and enforces read-only in JS via `_assertWritable()` (`turso-adapter.ts:203-213, 400-410`;
`types.ts:204-211`). There is a green regression test
(`__tests__/turso-readonly-fts.bl391.test.ts`).

It is documented in **source comments and the type definition only**. The 488-line consumer-facing
`README.md` never mentions it:

```
$ /usr/bin/grep -n "readonly\|read-only\|allowFtsInReadonly\|BL-391" \
    libs/data/store/store-adapter/README.md
73:  readonly config: …          ← interface listing
74:  readonly capabilities: …    ← interface listing
240:  readonly?: boolean;         ← config listing, no prose
331:| new Database(path,{readonly:true}) | createSqliteAdapter({…readonly:true}) |
```

`README.md:409` "Configuration reference" does not cover it either. A consumer building a read-only
fan-out — the obvious federated-recall shape — will hit `Resource is read-only` and have no path from
the error to `allowFtsInReadonly` except reading `.d.ts`. Same gap for the peer dependency:
`README.md:6` says `pnpm add @adhd/sox-store-adapter`, `createStoreAdapter()` defaults to **Turso**
(`src/factory.ts:24`), and `@tursodatabase/database` is an **optional** peer — so the documented quick
start does not install the default backend. (Mitigated: the driver is loaded by dynamic `import` with
an actionable message — `turso-adapter.ts:181-187` — so the failure is loud, not silent.)

**Cost:** ~3h of README work. Cheapest high-value item in this document.

---

### B9 — 🟠 MEDIUM: there is no Turso-native vector path

`libs/data/vectors/vector-store/src/index.ts:104-113` — `SqliteVectorBackend` **rejects** a
Turso-shaped adapter outright (BL-380), because `sqlite-vec`/`vec0` is a synchronous SQLite-only
mechanism and `TursoAdapter.unwrap()` returns an async handle that "silently compiles and then crashes
at runtime." The error directs callers to `LanceDbVectorBackend`. `FEAT-SOX-003` (Migrate memory bundle
vector store to Turso native vector search) is OPEN.

Consequence for the goal: a package migrating to Turso gets `store-adapter` + `graph-store`, and must
run vectors in a **separate LanceDB store**. That is a legitimate architecture, but it is not what
"migrate to Turso" implies and it should be stated up front rather than discovered.

---

### B10 — 🟡 LOW: metadata and documentation hygiene

- `store-adapter` is the **only** publishable package missing `engines.node`
  (`check-publishable` WARN) and the only one missing `publishConfig.access`. The latter is **not** a
  blocker — `.changeset/config.json` sets `"access": "public"` globally, and `0.1.0` published fine —
  but it makes the package the odd one out under any non-Changesets publish path.
- **No README at all:** `memory-core`, `sox-telemetry`, `blob-store`, `claim-verification`.
- **Stub READMEs (18–30 lines)** on `graph-store` (0.5.0), `vector-store` (0.3.0),
  `hybrid-search` (0.3.0), `analysis`, `ingest`, `embedding-provider`. Only `store-adapter` (488) and
  `task-queue` (119) are genuinely documented.
- `sox-telemetry` emits a startup warning when a consumer forgets `initTelemetry()` — *"records are
  being silently dropped … this process's telemetry is a permanent no-op (BL-404)"* — observed in the
  store-adapter test run. A package about to be published for the first time should carry that in a
  README, not only in a runtime warning.

Package shape itself is clean: `node tools/verify-exports-publint-attw.mjs` → **OK, publint 30
package(s); attw 23 package(s)**.

---

## §3 Claims that do NOT reproduce at HEAD

Four items from the briefing were checked and could not be confirmed. Recording them so nobody
spends the time again.

**"`nx release` has no changed-only baseline."** There is no `nx release` in this repo. `nx.json`
has **no `release` key** (`node -e "console.log(require('./nx.json').release)"` → `undefined`).
Releases run entirely through **Changesets** (`.changeset/config.json`, `release.yml`). The only
surviving reference is a stale comment at `ci.yml:14-16` pointing at a "ci-release guard," which is a
one-shot plan-execution guard script from a June 2026 nx-migration
(`.workflow/plans/nx-migration/dag.json:132`), not a workflow — `.github/workflows/` contains exactly
`ci.yml`, `release.yml`, `validate.yml`. **The real form of this problem is B2** (empty changeset
ledger ⇒ no-op release), and it is worse than a missing baseline: today the release publishes nothing
rather than everything.

**"CI's Publish job does not use `nx release` — it calls vestigial versioning scripts."** Half true,
and the half that is true is not the defect. `release.yml:66-84` uses `changesets/action@v1` with
`publish: pnpm release:prepared` → `build-index:publish && nx build sox && changeset publish`. That
ordering is *deliberate* and documented in the workflow — it is what makes the shipped CLI embed a
registry with zero `file://` sources. Not vestigial. **The actual defect is B4**: that job runs
`nx run-many -t build` and `check-publishable` and then publishes, with **no lint, test, or typecheck
anywhere on the release path**.

**"3 `@nx/js:tsc` packages declare a `package.json` `module` (ESM) entry their build does not
produce."** No project in this repo uses `@nx/js:tsc`. Full executor inventory across
`libs/ packages/ apps/`: `nx:run-commands` ×38, `@nx/eslint:lint` ×24, `@adhd/sox-nx:atomic-tsc` ×24
— that is all of them. And **no** `package.json` declares a `module` field
(`jq -r '.module' <pkg>` → `none` on every candidate; the `"module"` grep hits are all `"type":
"module"`). `nx.json:20` does carry a dead `@nx/js:tsc` `targetDefaults` entry — harmless residue from
the same nx-migration, worth deleting for clarity. `publint` + `attw` pass across the whole surface,
which is the direct check for this class.

**"Composite tsc project-reference builds can race under nx parallelism on a cold cache."** No
`tsconfig*.json` under `libs/`, `packages/`, or `apps/` declares `composite` **or** `references`
(`/usr/bin/grep -rln` → zero hits for both), and `tsconfig.base.json` has `composite: null`. There is
no composite graph to race. Ordering comes from nx's own `dependsOn: ["^build"]`
(`nx.json:30-39`).

One more, unasked: `BUG-DB-TURSO-WIRING-UNCOMMITTED-001` (CRITICAL, OPEN) — *"db.ts's Turso wiring
exists in NO commit"* — **is fixed but still open**. `git show HEAD:libs/memory-core/src/db.ts | grep -c
-i turso` → **46**, and `git log -- libs/memory-core/src/db.ts` shows `5460c63`, `c3151f5`. The item
should be closed.

---

## §4 Sequenced plan to "stable + published"

Ordering constraints are stated as **OC-n** where the sequence is forced rather than merely preferred.

### Wave 0 — Unblock the pipeline (≈1 day, no library code changes)

| # | Action | Why here |
|---|---|---|
| 0.1 | **Publish `@adhd/sox-telemetry@0.1.0`.** | **OC-1: nothing else can publish until this does.** Two packages hard-`require` it; every downstream `npm i` 404s otherwise (B1). It is already correctly shaped and has zero `@adhd` deps, so it has no predecessor of its own. |
| 0.2 | Add `engines.node: ">=20"` + `publishConfig.access: public` to `store-adapter`. | Clears the sole `check-publishable` WARN; must precede any bump so the fix ships *with* the version, not after (B10). |
| 0.3 | Harden `check-publishable.ts` with a registry existence probe for every `workspace:*` runtime dep. | The gate structurally could not catch B1 (`:67-76`). Landing this after 0.1 means it goes green immediately and locks the class shut. |
| 0.4 | Delete the dead `@nx/js:tsc` `targetDefaults` block (`nx.json:20-29`) and the stale `ci-release` comment (`ci.yml:14-16`). | Both actively misled this assessment. Zero risk. |

### Wave 1 — Make the gate real (≈1 day) — **OC-2: must precede any publish**

| # | Action |
|---|---|
| 1.1 | Add a `typecheck` target to the 9 public data libs lacking one, copying `store-adapter`'s `project.json` convention **verbatim**. |
| 1.2 | Add `nx affected -t typecheck` to `ci.yml` between lint and test. |
| 1.3 | Add `lint,test,typecheck` to `release.yml` **before** the publish step. Today it builds, shape-checks, and publishes. |
| 1.4 | Resolve the live `store-adapter:typecheck` failure at `integrity.ts:1087` **with its author** — it is uncommitted concurrent work, not yours to rewrite. |

*Why before publishing:* publishing under a gate that has never typechecked 9 of 12 packages is
re-running BL-248 with an external audience. Wave 1 is cheap and its whole value is that it runs
*before* the bump.

### Wave 2 — Fix what a new adopter touches first (≈3 days) — **OC-3: before the version bump**

| # | Action |
|---|---|
| 2.1 | **B3 — make `migrateStore()` safe.** Mandatory snapshot; `MigrationResult.ok` derived from `tables[*].errored`; CLI honors it; `--verify` default-on and extended past row counts; idempotency. Red→green test per the item's own acceptance criteria. |
| 2.2 | **B6 — flip `multiprocess_wal` to opt-in.** Behavior-breaking ⇒ must land *before* the bump so the semver record is honest. |
| 2.3 | **B8 — README: read-only + `fts_match` / `allowFtsInReadonly`, and the `@tursodatabase/database` peer.** Cheapest item here; do it in the same PR as 2.2 since both change documented defaults. |
| 2.4 | **B7 — adapter-level verified-drop helper** + the caveat on `StoreAdapter.exec()`'s own interface doc. |

*Ordering rationale:* 2.1–2.4 are all **contract-visible**. Anything that changes an interface, a
default, or a documented guarantee must be inside the version being cut, or the first published
semver commitment is one the maintainers already intend to break.

### Wave 3 — Cut the release (≈half a day) — **OC-4: owner decision required, do not proceed without it**

| # | Action |
|---|---|
| 3.1 | **Owner decides:** does the `DbAdapter`/`StoreAdapter` seam go `1.0.0`? See §5 — my recommendation is **no, go `0.2.0`**. |
| 3.2 | Author changesets for all 6 drifted packages with honest breaking-change prose (sync→async `openDb`, `multiprocess_wal` default flip, verified-drop). |
| 3.3 | Merge to `main`; let `release.yml` cut the "Version Packages" PR; merge that; verify each tarball's `dependencies` against npm reality before announcing. |

### Wave 4 — Unblock third-party domain modeling (≈3 days, can run in parallel with Wave 3)

| # | Action |
|---|---|
| 4.1 | **B5 increment — `FEAT-SOXGRAPH-SUBKIND-INDEX-001`.** Indexed, consumer-declarable extension node types, **without** touching `kind`/`rel` `CHECK`. |
| 4.2 | Correct `BUG-SOXGRAPH-TYPED-NODES-001`'s stale "`kind` is not indexed" premise (`ix_node_kind` exists at `src/index.ts:62,150`) so the rearchitecture is argued from the real asymmetry. |

**OC-5: 4.1 must not reopen the `CHECK` constraints.** `BL-313` was a CRITICAL data-loss incident
from a `CHECK` rebuild on this shared populated store, and `graph-store` backs the live memory server.
The full rearchitecture (`BUG-SOXGRAPH-TYPED-NODES-001`) needs a migration design that survives that,
and is post-`1.0` work.

### Deliberately deferred

`B9` (Turso-native vectors, `FEAT-SOX-003`) — a real gap, but LanceDB is a working answer today and
this is a multi-week engine swap. Document the split-store reality in Wave 2.3; do not gate the
release on it.

---

## §5 What is NOT ready, and what breaks if published today

**Publish `main` right now and one of two things happens, both bad:**

1. **Most likely: nothing publishes.** The changeset ledger is empty (B2). `changesets/action` opens
   no PR, `changeset publish` finds nothing to ship, and 91 commits of Turso work stay off npm while
   the pipeline reports success.

2. **If someone forces versions through:** `@adhd/sox-store-adapter` and `@adhd/sox-memory-core` ship
   with `@adhd/sox-telemetry@0.1.x` in `dependencies`, which **does not exist on npm**. Every
   downstream `npm i` / `pnpm add` fails with a 404 (B1). `@adhd/sox-graph-store` depends on
   `store-adapter`, so it 404s transitively too — that is the entire Turso surface the owner wants
   other packages to adopt, dead on install. `check-publishable` reports OK throughout.

**Beyond install, the contract is not one I would ask a third party to depend on yet:**

- **The migration script is the product** for "migrate other packages to Turso," and it can silently
  half-migrate a store, stamp it as migrated, exit 0, and — in `--mode in-place` — do so against the
  consumer's only copy (B3).
- **`exec()` does not mean what its signature says** on Turso for fts5/vec0 DDL, guarded in exactly
  one consumer that is not the published library (B7).
- **An experimental, pre-1.0, format-versioned, MVCC-incompatible WAL mode is on by default** (B6),
  with a documented failure mode that renders a store permanently unopenable (BL-373).
- **`graph-store` cannot represent a consumer's domain types** without a fork or a `generic`+tag
  laundering the library itself recommends in a thrown error string (B5).
- **Nine of twelve public packages have never been typechecked by any gate**, and the release path
  runs no tests at all (B4).

**On the `DbAdapter` seam's semver stability — the direct question asked.** The *shape* is good: 307
green tests with real Turso coverage, capability flags instead of `instanceof`, duck-typed portable
error helpers, an explicit `unwrap()` escape hatch, and `sox.invariants` in the manifest. But three of
its surfaces are known-wrong and scheduled to change (`exec()` DDL semantics, the `multiprocess_wal`
default, `migrateStore()`'s result contract), and a fourth — `AdapterConfig.experimental` — is an
**object** at the public boundary (`types.ts:217`) that translates to Turso's **array** form internally
(`turso-adapter.ts:227-243`), which is correct today but couples the public type to a pre-1.0
upstream shape.

**Recommendation: publish the seam as `0.2.0`, not `1.0.0`.** `0.x` is the honest signal for "adopt
it, wire against it, expect one more breaking pass." Take `1.0.0` after Wave 2 has soaked against a
second real consumer — which is precisely the migration the owner is about to start, and the best
possible evidence for whether this contract holds.

---

## §6 Provenance

Every claim above traces to a command run or a file read in this session. Nothing was inferred from a
grep hit alone.

**Commands run:** `npm view` (×5 packages + dependency/time queries) · `pnpm run check-publishable` ·
`node tools/verify-exports-publint-attw.mjs` · `npx nx run-many -t typecheck --projects=store-adapter,memory-core,sox-telemetry --skip-nx-cache` ·
`npx nx run-many -t test --projects=store-adapter,graph-store --exclude-task-dependencies --skip-nx-cache` ·
`git log/diff/show/status` · `jq` over 28 manifests and 24 `project.json` files · `/usr/bin/grep`
throughout (per the NUL-byte rule) for every absence claim.

**Files read in full or in cited part:** `docs/reporting/memory/README.md` ·
`docs/standards/extension-bundling.md` · `docs/decisions/0006-…md` · `libs/data/CLAUDE.md` ·
`libs/data/store/store-adapter/{package.json,project.json,README.md,src/types.ts,src/factory.ts,src/turso-adapter.ts,src/__tests__/turso-readonly-fts.bl391.test.ts}` ·
`libs/data/graph/graph-store/{package.json,src/index.ts}` ·
`libs/data/vectors/vector-store/src/index.ts` · `libs/memory-core/{package.json,project.json}` ·
`libs/observability/sox-telemetry/package.json` · `scripts/check-publishable.ts` · `nx.json` ·
`.changeset/config.json` · `.github/workflows/{ci,release,validate}.yml`.

**Backlog items read (not modified):** `BUG-SOXGRAPH-TYPED-NODES-001`,
`FEAT-SOXGRAPH-SUBKIND-INDEX-001`, `BUG-STOREADAPTER-MIGRATE-UNSAFE-001`,
`BUG-TURSO-ADAPTER-EXEC-DDL-SILENT-NOOP-001`, `DEBT-MEMORYCORE-NO-TYPECHECK-TARGET-001`,
`DEBT-TEST-VITEST-FROZEN-SKIP-TURSO-001`, `DEBT-MEMORYCORE-OPENDB-MISSING-AWAIT-TESTS-001`,
`BUG-DB-TURSO-WIRING-UNCOMMITTED-001`, `FEAT-SOX-001`, `FEAT-SOX-003`.

**Constraints honored:** no publish, no `nx release`, no version bump, no tag, no push. No
`npx nx build` of any kind. No `registry:sync-index`. No service restarted, redeployed, or enabled.
No write to `~/.memory/*`. No backlog item created, edited, or resolved; no edit to `BACKLOG.md`,
`CHANGELOG.md`, `PLAN.md`, or `STATE.md`. No `git add -A`, no `git stash`, no `git reset --hard`. All
build/test/typecheck ran through nx targets. The only file this session created is this one.
