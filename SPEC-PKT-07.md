# SPEC — PKT-07 / BL-389

`LanceDbVectorBackend` constructor typed against a raw `better-sqlite3.Database`, outside the
`StoreAdapter` boundary.

Architect: sonnet. Worktree: `.worktrees/pkt07-lancedb-adapter-boundary`, branch
`feat/pkt07-lancedb-adapter-boundary`. Implementer/reviewer: work only inside this worktree.

---

## 1. Root cause

`libs/data/vectors/vector-store/src/lancedb.ts:3` imports `type Database from 'better-sqlite3'`.
`lancedb.ts:62` declares:

```ts
constructor(config: LanceDbVectorBackendConfig & { db: Database.Database }) {
```

I read the full constructor body (`lancedb.ts:62-73`) and every method in the class
(`lancedb.ts:57-149`). **`config.db` is never referenced anywhere in the class** — not in the
constructor, not in `ensureSpace`, `upsert`, `delete`, `get`, `knn`, or `iter`. Every operation goes
through `getSyncFn()` (a `synckit` bridge into `lancedb-worker.ts`, `lancedb.ts:48-53`), keyed only
by `this.lancedbPath`. The `db` parameter is 100% dead weight — it exists purely to satisfy the
type signature, not because the implementation touches SQLite in any way.

This is not my inference alone: `lancedb.spec.ts:51-52` already carries a comment admitting it —
*"A dummy sqlite handle to satisfy the pinned `{ db: Database.Database }` constructor shape — the
real LanceDB backend does not use it."* The test suite has been hand-feeding a throwaway
`new Database(':memory:')` (`lancedb.spec.ts:53-55`) into every single backend construction for no
functional reason, solely because the type signature demanded *some* `Database.Database`.

`libs/data/vectors/vector-store/src/index.ts:434-438` (`openLanceDbVectorStore`) propagates the
same dead parameter into the package's public factory function.

**Consequence (why BL-389 is real, not cosmetic):** because the constructor is typed against
`better-sqlite3.Database` and not `StoreAdapter`, every caller — regardless of what store backend
they are actually using (SQLite or Turso) — is forced to manufacture or already hold a raw
`better-sqlite3` handle just to call `new LanceDbVectorBackend(...)`, even though the class never
uses it. A Turso-only caller has no such handle at all. That is the literal blocker the backlog item
describes: LanceDB "cannot be wired against a Turso-backed store at all without its own
`unwrap()`-shaped workaround," except in this case the workaround would have to *fabricate* an
unrelated SQLite connection from nothing, which is worse than BL-380's cast-on-an-existing-handle
shape.

## 2. The change, file by file

### 2.1 `libs/data/vectors/vector-store/src/lancedb.ts` — IN BOUNDS, primary fix

- Delete `import type Database from 'better-sqlite3';` (line 3). This is the literal line the lint
  rule (`sox/no-storage-backend-leak`) and BL-389 both cite — it must be gone, not merely unused.
- Add `import type { StoreAdapter } from '@adhd/sox-store-adapter';`. This package already depends
  on `@adhd/sox-store-adapter` (`package.json` `dependencies`, confirmed) and already imports it in
  `index.ts:4` — no new dependency edge, no boundary-lint risk (`area:data` → `area:data` is
  allowed per `libs/data/CLAUDE.md`).
- Change the constructor signature:

  ```ts
  constructor(config: LanceDbVectorBackendConfig & { adapter: StoreAdapter }) {
    requireStoreAdapterShape(config.adapter);
    this.adapter = config.adapter;
    this.lancedbPath = config.lancedbPath;
    this.indexConfig = config.index;
    // ...unchanged from here down...
  }
  ```

- Add a private field `private readonly adapter: StoreAdapter;` next to the existing
  `lancedbPath`/`indexConfig`/`spaces` fields. It is stored, not discarded — see decision D3 below
  for why it is kept even though nothing reads it today.
- Add a small module-level guard function (placed above the class, next to the other private
  helpers):

  ```ts
  function requireStoreAdapterShape(adapter: unknown): asserts adapter is StoreAdapter {
    if (
      adapter === null ||
      typeof adapter !== 'object' ||
      (adapter as { capabilities?: unknown }).capabilities === undefined
    ) {
      throw new TypeError(
        'LanceDbVectorBackend requires a StoreAdapter, not a raw driver handle — ' +
          'construct one via createSqliteAdapter()/createTursoAdapter() (or ' +
          'createStoreAdapter()) from @adhd/sox-store-adapter and pass it as `adapter`.',
      );
    }
  }
  ```

  This mirrors the existing, already-proven pattern in `index.ts:101-118`
  (`requireSqliteHandle`'s duck-type guard) — same package, same lesson (BL-364: an unguarded raw
  handle produces an opaque `TypeError` deep inside a driver call instead of a named error at the
  boundary). Do **not** reuse `index.ts`'s `StorageError` class for this: `index.ts` imports
  `LanceDbVectorBackend` from `lancedb.ts` (`index.ts:429`), so `lancedb.ts` importing anything back
  from `index.ts` creates a circular module dependency. Use a plain `TypeError` instead — no new
  import, no cycle.
- No other line in this file changes. `ensureSpace`, `upsert`, `delete`, `get`, `knn`, `iter`,
  `getSyncFn`, `resolveWorkerPath` are untouched — none of them reference `db` or the sqlite driver
  today and none should start now.

### 2.2 `libs/data/vectors/vector-store/src/index.ts` — IN BOUNDS, one function only

- `openLanceDbVectorStore` (currently `index.ts:434-438`):

  ```ts
  export function openLanceDbVectorStore(
    config: LanceDbVectorBackendConfig & { adapter: StoreAdapter },
  ): LanceDbVectorBackend & VectorBackend {
    return new LanceDbVectorBackend(config);
  }
  ```

  `StoreAdapter` is already imported at `index.ts:4` — no new import needed here.
- **Nothing else in this file changes.** `SqliteVectorBackend`, `requireSqliteHandle`,
  `openVectorStore`, `reembed`, `tableExists`, `cosineSimilarity` are OUT OF BOUNDS — they are
  BL-380 territory (already a separate, open backlog item), not BL-389. Do not touch them even to
  "clean up" a similar pattern; that is scope creep into a different tracked defect and risks
  conflicting with whoever picks up BL-380/PKT-04 in parallel (the plan explicitly notes PKT-04 and
  PKT-07 are "genuinely disjoint, no shared symbols" — keep it that way).

### 2.3 `libs/data/vectors/vector-store/src/lancedb.spec.ts` — IN BOUNDS, construction sites only

This file's ~482 lines are almost entirely behavioral assertions against a constructed backend
(`ensureSpace`, `upsert`, `knn`, `delete`, `iter`, `reembed`). **None of that behavior changes.**
Only the construction plumbing changes:

- Delete `import Database from 'better-sqlite3';` (line 1).
- Delete the `dummyDb()` helper and its comment (lines 51-55) — it existed solely to feed the dead
  `db` parameter; there is nothing left for it to satisfy.
- Add `import { MockAdapter } from '@adhd/sox-store-adapter';` (package dependency already present;
  `MockAdapter` is exported from the package root — confirmed via `store-adapter/src/index.ts:6`
  `export * from './mock-adapter.js'`).
- `makeBackend()` (currently `lancedb.spec.ts:57-65`): replace `db: dummyDb()` with
  `adapter: new MockAdapter()`.
- The one direct call outside `makeBackend()`, `lancedb.spec.ts:353`
  (`openLanceDbVectorStore({ lancedbPath: tmp.dir, db: dummyDb() })`), gets the same treatment:
  `adapter: new MockAdapter()`.
- Every other line in the file (all `describe`/`it` blocks exercising real on-disk LanceDB behavior)
  is untouched.

### 2.4 NEW FILE `libs/data/vectors/vector-store/src/lancedb.bl389-adapter-boundary.spec.ts`

A dedicated file naming BL-389, matching the house convention already used elsewhere in this repo
for backlog-anchored regression tests (e.g.
`libs/data/store/store-adapter/src/__tests__/crash-recovery.bl338.test.ts`). See §4 for exact
required assertions — do not fold these into `lancedb.spec.ts`; a reviewer must be able to find the
BL-389 proof in one file without wading through the full behavioral suite.

### 2.5 Explicitly OUT OF BOUNDS — do not touch, and why

| File | Why it's out of bounds |
|---|---|
| `libs/data/vectors/vector-store/src/lancedb-worker.ts` | Never referenced `db`; nothing here changes shape or behavior. Confirmed via grep — zero hits for `.db` or `config.db` in this file. |
| `libs/data/vectors/vector-store/src/index.ts` — `SqliteVectorBackend`, `requireSqliteHandle`, `openVectorStore` | BL-380 territory, a separate open backlog item (PKT-04) explicitly carved out as disjoint from this one. Touching it risks a merge conflict with whoever lands BL-380 and is not needed to close BL-389. |
| `docs/plan/retrieval-infrastructure/SPEC.md`, `docs/substrate/README.md` | Historical planning docs that quote the OLD `{ db: Database }` shape. They are not the authoritative interface spec for this package (that is `docs/plan/memory-refactor/COMPILED_INTERFACES.md`, per `libs/data/vectors/vector-store/CLAUDE.md`) and are out of scope for a backlog defect fix. If the reviewer wants doc parity, file it as a new backlog item — do not silently rewrite planning history as part of this ticket. |
| `package.json` (vector-store) | `@adhd/sox-store-adapter` is already a listed dependency. `better-sqlite3` stays listed — `index.ts`'s `SqliteVectorBackend`/`requireSqliteHandle`/`openVectorStore` still need it, and it is untouched by this ticket. No manifest edit required. |
| `Turso adapter internals` (`libs/data/store/store-adapter/src/turso-adapter.ts`) | Not part of this fix. Do not touch `needsWriteSerialization`/`concurrentTransactions` on any adapter — standing house rule, and there is no reason this ticket would need to. |

## 3. Every decision, ruled

**D1 — Constructor takes `{ adapter: StoreAdapter }` inside the existing config-object param,
not a second positional arg.**
Losing alternative: mirror `SqliteVectorBackend`'s two-positional-arg shape
(`constructor(adapter: StoreAdapter, similarity?: SimilarityBackend)`). Rejected: `lancedb.ts`'s
config object already carries `lancedbPath` and `index`, which have nothing to do with
`SqliteVectorBackend`'s shape; splitting `adapter` out to a second positional arg is a bigger,
unrelated diff to every call site for no behavioral gain, and the object-shape ADR pattern (ADR-0006,
"live objects cross via DI") is satisfied either way — DI doesn't mandate positional args.

**D2 — Add a `requireStoreAdapterShape` duck-type guard in the constructor.**
Losing alternative: accept `adapter` with no runtime check (TypeScript alone enforces the type at
the call site). Rejected: TypeScript erases at compile time; nothing stops a caller from
`as StoreAdapter`-casting an arbitrary object (including, ironically, a raw `better-sqlite3` handle
— the exact thing this ticket is closing the door on) and getting a confusing failure three calls
later, buried inside `getSyncFn()`. `index.ts:101-118` already had to learn this lesson once
(BL-364) in the sibling `SqliteVectorBackend` class. Do not make the sibling class in the same file
repeat a mistake this package has already paid for and fixed once.

**D3 — Store `config.adapter` on `this.adapter` even though no current method reads it.**
Losing alternative: accept-and-discard (`requireStoreAdapterShape(config.adapter);` then never
assign it to a field). Rejected for two concrete reasons, not aesthetics: (a) a private class field
that is assigned but never *read* is flagged by this repo's `strict` TypeScript config as TS6133
(`'adapter' is declared but its value is never read`) — this is a distinct diagnostic from
`noUnusedLocals`/`noUnusedParameters` (those police locals/parameters, not class fields; the
original text of this decision named the wrong flag — corrected here after the implementer hit the
real TS6133 in practice). Storing-without-reading does not "remove the ambiguity"; it *trips* the
diagnostic. The concrete resolution: add one genuine, non-scope-creep read — the existing
constructor `console.info` (`lancedb.ts:96-99`) reads `this.adapter.config.type` (`sqlite`/`turso`)
alongside the existing `path=` log field. `StoreAdapter.config.type` is a real, already-public field
(`store-adapter/src/types.ts:302`, read the identical way at `fts-dialect.ts:119`,
`migration.ts:375-376`, `integrity.ts:778`) — this is not a fabricated read to silence the compiler,
it's a legitimate diagnostic-log improvement that happens to also satisfy TS6133. (b) The backlog's
own fix sketch names a real future need: *"either accept a StoreAdapter... and route queries through
executeGet/executeAll, or... make that a named, capability-gated StoreAdapter method."* Keeping the
reference on the instance is what makes that future work possible without a second
constructor-signature migration. Do not go further and actually wire any query through
`executeGet`/`executeAll` in this ticket — LanceDB's worker bridge (`getSyncFn`) is the entire,
working, on-disk persistence mechanism today (see `lancedb.ts:24-31`'s own comment: "a real
synchronous call into a real on-disk LanceDB table"); routing through the adapter today would be a
functional rewrite with no defect behind it. That is out of scope for BL-389, which is a
*type-boundary* fix, not a data-path fix.

**D4 — No capability gating (`adapter.capabilities.nativeVectors` etc.) on the `adapter` param.**
Losing alternative: mirror `requireSqliteHandle`'s stricter behavior and reject Turso-backed
adapters (`capabilities.nativeVectors === true`), the same way `SqliteVectorBackend` rejects them.
Rejected: that gate exists in `index.ts` because `SqliteVectorBackend` is fundamentally a
sqlite-vec/vec0 mechanism and cannot function against a Turso handle — the class LITERALLY cannot
work without a synchronous `better-sqlite3` connection. `LanceDbVectorBackend` has no such
constraint: it never touches the adapter's driver at all (see root cause, §1) — it is backend-
agnostic by construction, which is the entire point of this fix (BL-389's stated purpose: unblock
Turso-backed wiring). Adding a capability restriction here would reintroduce the exact blocker this
ticket exists to remove.

**D5 — RED arm is a `tsc` compile failure, not a runtime throw, for the primary construction test.**
Losing alternative: contort a runtime-only test (e.g. `(backend as any)` casts) to "prove" the old
signature is impossible without ever invoking the type checker. Rejected: the old constructor body
never touched `config.db` either (see §1) — a loosely-typed runtime call with a fabricated `adapter`
object *would already succeed* under the pre-fix code, because nothing ever validated `db`'s shape
at runtime. The actual, real barrier the old signature imposes is a **compile-time** one: TypeScript
refuses `new LanceDbVectorBackend({ lancedbPath, adapter })` when the type requires `db`. Since
`npx nx typecheck vector-store` is already a mandated gate for this repo (this package has a real
`typecheck` target — confirmed via `project.json`), demonstrating the RED arm through that gate is
not a stretch — it is the correct, already-required tool for the job. See §4 for the literal
run-before/run-after instructions.

**D6 — `MockAdapter` (not `createSqliteAdapter`, not a live Turso connection) is the test double for
the "not a raw handle" proof.**
Losing alternative: construct a real `SqliteAdapter` via `createSqliteAdapter({ dbPath })` for the
positive test, to make the point more dramatically ("look, a real adapter"). Rejected: it adds a
temp-file + real `better-sqlite3` open/close lifecycle to a test whose only job is to prove the
*type boundary* is `StoreAdapter`, not to prove SQLite interop (LanceDB never touches the adapter's
driver — §1). `MockAdapter` already fully implements `StoreAdapter` (`store-adapter/src/mock-
adapter.ts:168-190`, confirmed read) with real `capabilities`/`config` fields, is already a package
dependency, requires no I/O, and is the lighter, more honest choice: it proves duck-typing against
the interface, not "this happens to also be SQLite." (A raw `better-sqlite3` handle IS used, on
purpose, for the negative/guard test in §4 — that is the one place a real raw handle belongs, to
prove the guard actually rejects it.)

## 4. Acceptance criteria (naming BL-389)

All three land in `libs/data/vectors/vector-store/src/lancedb.bl389-adapter-boundary.spec.ts`
unless noted.

**AC-1 (BL-389, compile-time boundary).** `npx nx typecheck vector-store` must go RED→GREEN across
this change, on the exact new construction call site.
- RED arm: with `lancedb.spec.ts`/the new spec file already rewritten to call
  `new LanceDbVectorBackend({ lancedbPath: dir, adapter: new MockAdapter() })`, but with
  `lancedb.ts`'s constructor signature still `{ db: Database.Database }` (i.e. run this check
  *before* touching `lancedb.ts`/`index.ts`), `npx nx typecheck vector-store` must report a TS error
  at that call site naming the missing/mismatched `db`/`adapter` property (TS2345 or TS2769 class).
  Paste the actual compiler output in the implementation report — do not paraphrase it.
- GREEN arm: after `lancedb.ts` and `index.ts` are updated per §2.1–2.2, the same command reports
  zero errors.

**AC-2 (BL-389, runtime end-to-end).** A test named for BL-389 constructs `LanceDbVectorBackend`
from a `StoreAdapter` (a `MockAdapter` instance — decision D6), calls `ensureSpace`, `upsert`s at
least 2 vectors into a real on-disk LanceDB table (own tmp dir, per the existing pattern in
`lancedb.spec.ts:21-29`), then calls `knn()` and asserts the nearest neighbor's `id` matches the
upserted vector closest to the query — a real query end to end, not a mock return value.
- RED arm: this exact test, run against the pre-fix `lancedb.ts`, does not exist yet because it
  cannot be written — `db: dummyDb()` (a fabricated, functionally-irrelevant SQLite handle) was the
  only way to satisfy the old constructor, which is the whole defect. Do not "prove RED" by running
  the *old* `db`-based test; that test passing is not evidence of anything relevant to BL-389 — it
  never used `db`. The RED evidence for this criterion is AC-1's compiler output, not a second
  runtime failure — see D5.
- GREEN arm: the test passes with real on-disk assertions (reuse `makeTmpLanceDir()`/cleanup from
  `lancedb.spec.ts` or duplicate the ~5-line helper — either is fine, no shared-symbol requirement
  between these two spec files).

**AC-3 (BL-389, guard rejects a raw handle).** A second test in the same new file constructs a real
`better-sqlite3` handle (`new Database(':memory:')`, imported the same way the now-deleted
`dummyDb()` helper did) and passes it as `adapter` (via an `as unknown as StoreAdapter` cast, since
this is deliberately testing the runtime guard against a value TypeScript alone wouldn't catch at
this call site once cast) — asserts `new LanceDbVectorBackend({ lancedbPath: dir, adapter: rawHandle
as unknown as StoreAdapter })` throws, and that the thrown error's message names `StoreAdapter` (not
a generic/opaque error).
- RED arm: on the pre-fix `lancedb.ts`, this exact call **does not throw** — passing a raw
  `better-sqlite3` handle as `db` was literally the *intended*, working call shape before this fix
  (§1: the old code never validated it, and never used it, so it silently "succeeded"). Run this
  assertion against the pre-fix source (with the constructor signature still `{ db }`, adjust the
  test's field name to `db` only for this one RED-arm run) and confirm it does NOT throw — record
  that in the implementation report. This is the concrete behavior change the guard introduces.
- GREEN arm: post-fix, the same call (now using `adapter` and hitting `requireStoreAdapterShape`)
  throws `TypeError` with `StoreAdapter` in the message.

## 5. Risks

- **`npx nx build vector-store` is destructive (BL-235)** — it `rm -rf`s the existing `dist/` before
  knowing the rebuild succeeds. `dist/` currently exists and is a working artifact (confirmed
  present via `ls`). Sequencing: run `typecheck` and `lint` and `test` FIRST (none of them touch
  `dist/`), fix anything red, and only run `build` once, last, when you are confident the source
  compiles. Do not run `build` diagnostically "just to see if it works" — read the source instead if
  you're unsure.
- **Do not run `build` under artificial load** — plain, unthrottled `npx nx build vector-store`.
- **`nx test` rebuilds upstream `^build` dependencies (BL-456)**, not `vector-store` itself (its own
  `test` target has no `dependsOn` override in `project.json`, so it inherits the `nx.json` default
  of `dependsOn: ["^build"]` — dependencies only). This means `npx nx test vector-store` may rebuild
  `@adhd/sox-store-adapter`'s or `@adhd/sox-graph-store`'s `dist/` from whatever is currently on
  disk for those packages. Report tree state with
  `node tools/check-suite-tree-state.mjs --project vector-store` alongside the test result, per
  house rule — if it's dirty, that dirt is in an upstream dependency, not in the files this ticket
  touches, but state it rather than silently omitting it.
- **No data-destruction risk in the runtime sense** — every test in this ticket uses `fs.mkdtempSync`
  scratch directories (`lancedb.spec.ts`'s existing `makeTmpLanceDir()` pattern) and/or in-memory
  `MockAdapter`/`:memory:` SQLite. Nothing here touches `~/.memory/*` or any shared fixture.
- **Circular import risk if the guard reuses `index.ts`'s `StorageError`** — flagged in §2.1; use a
  plain `TypeError` instead. If the implementer is tempted to "clean this up" by extracting a shared
  errors module, that is out of scope — do not do it in this ticket.

## 6. The gate — exact nx targets, in this order

1. `npx nx typecheck vector-store` — run once pre-fix (RED, AC-1) and once post-fix (GREEN, AC-1).
2. `npx nx lint vector-store`
3. `npx nx test vector-store` — run AC-2 and AC-3's GREEN arms here; report
   `node tools/check-suite-tree-state.mjs --project vector-store` alongside the result.
4. `npx nx build vector-store` — once, last, per the sequencing in §5. Confirm it succeeds (this is
   a PUBLIC package per `libs/data/CLAUDE.md`'s package table — its compiled `dist/index.js` +
   `dist/index.d.ts` ship to real consumers).

No `registry:sync-index` step — `vector-store` is a data-layer library, not a registered extension
(`libs/data/vectors/vector-store/CLAUDE.md` states this explicitly).

Commit by explicit pathspec only:
`git commit libs/data/vectors/vector-store/src/lancedb.ts libs/data/vectors/vector-store/src/index.ts libs/data/vectors/vector-store/src/lancedb.spec.ts libs/data/vectors/vector-store/src/lancedb.bl389-adapter-boundary.spec.ts -m "..."`.
Never `git add -A`/`git add .`/bare `git commit`. Lowercase conventional-commit subject, scope
`memory-core` is wrong here — this is a `libs/data` package with no listed scope token in the
project's approved scope list; use no scope prefix or `fix(vector-store): ...` is acceptable as a
descriptive, non-enforced scope (the enforced list in root `CLAUDE.md` covers
memory-core/sox/extensions/scripts/host-runtime/registry/ci/release/manifest/authoring/
install-engine/nx-migration — none of which is this package; do not force-fit one, just don't use
a wrong one either).
