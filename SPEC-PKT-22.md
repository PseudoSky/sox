# SPEC — PKT-22 (BL-392): vec_node never declares an explicit distance_metric

**Architect:** claude/sonnet, 2026-08-06. **Worktree:** `.worktrees/pkt22-vec-distance-metric`,
branch `feat/pkt22-vec-distance-metric`. Toolchain verified: `pnpm install` clean,
`npx nx test store-adapter -- vector-dialect.test.ts` → 30 passed (baseline, pre-fix).

---

## 1. Root cause (file:line citations, all personally opened)

1. `libs/data/store/store-adapter/src/vector-dialect.ts:109-112` —
   `SqliteVecDialect.createTableDDL` builds:
   ```
   CREATE VIRTUAL TABLE IF NOT EXISTS "${table}" USING vec0(node_id INTEGER PRIMARY KEY, ${column} ${colType})
   ```
   with no `distance_metric` column option. sqlite-vec's `vec0` module defaults an unqualified
   column to **L2 (Euclidean)** distance (confirmed via WebSearch against
   `alexgarcia.xyz/sqlite-vec/features/knn.html` and the vec0 column-option docs, 2026-08-06: the
   only way to select cosine is `embedding float[N] distance_metric=cosine` in the column
   definition itself — there is no query-time equivalent).

2. `libs/data/store/store-adapter/src/vector-dialect.ts:128-151` —
   `SqliteVecDialect.topKQuery(table, column, queryVec, k, metric)` receives `metric` as its 5th
   parameter and uses it **only** to pick `ASC`/`DESC` (`vector-dialect.ts:137`,
   `const distanceOrder = metric === 'dot' ? 'DESC' : 'ASC';`). The emitted SQL
   (`vector-dialect.ts:148`) never encodes the metric into the distance computation — it can't:
   vec0's `MATCH` operator always computes whatever the table's own `distance_metric` says
   (currently: L2, since finding 1). So `metric='cosine'` is accepted, does nothing to the actual
   distance value, and the caller has no way to know.

3. **Every real call site already passes `'cosine'` and nothing else, system-wide** — verified by
   grepping every `.topKQuery(` and `createIndexDDL(` call against `vec_node`:
   - `libs/memory-core/src/recall.ts:512-514` — `vectorDialect.topKQuery('vec_node', 'embedding', queryVec, knnLimit, 'cosine')`
   - `libs/memory-core/src/neardup.ts:58-64` — `vectorDialect.topKQuery('vec_node', 'embedding', ..., 'cosine')`
   - `libs/memory-core/src/db.ts:704` — `vectorDialect.createIndexDDL('vec_node', 'embedding', 'cosine')`
   No caller anywhere in `libs/` or the sibling `agent-source` repo ever requests `'l2'` or `'dot'`
   against `vec_node`. The only non-`'cosine'` uses of the parameter are synthetic, in
   `libs/data/store/store-adapter/src/__tests__/vector-dialect.test.ts:161-169`.

4. **`TursoVectorDialect` does this correctly today** — `vector-dialect.ts:179-185`
   (`distanceExpr`) and `vector-dialect.ts:235-240` (`topKQuery`'s `distFn` switch) compute the
   metric explicitly in SQL every query. The sqlite arm is the only one that lies.

5. **Empirically measured impact** (BL-367 attribution,
   `extensions/bundles/sox-memory-bundle/members/memory-server/recall-parity-arm-attribution.test.ts`,
   cited in `BACKLOG.md:1701-1758` under `### BL-392`): on the parity corpus's one non-degenerate
   pair, sqlite (L2) returned `d=1.2364`, Turso (cosine) returned `d=0.7643`, and
   `1.2364² = 2 − 2×0.7643` holds — i.e. sqlite genuinely computes L2 while the code's every call
   site says `'cosine'`. Harmless today only because the test corpus is L2-normalised (L2 is a
   monotonic function of cosine for unit vectors, so rank order survives) — not because the metric
   claim is true.

**Net defect:** the code has claimed cosine distance for the sqlite arm at every call site since
those call sites were written, and computed L2 the entire time. Both gaps are two views of one
fact — the metric was never actually wired to `vec0` — not two independent bugs.

---

## 2. The change — file by file

### 2a. `libs/data/store/store-adapter/src/vector-dialect.ts` — the only file that changes

**A. `SqliteVecDialect.createTableDDL` (currently lines 109-112):**

```diff
   createTableDDL(table: string, column: string, dim: number): string {
     const colType = this.vectorColumnType(dim);
-    return `CREATE VIRTUAL TABLE IF NOT EXISTS "${table}" USING vec0(node_id INTEGER PRIMARY KEY, ${column} ${colType})`;
+    return `CREATE VIRTUAL TABLE IF NOT EXISTS "${table}" USING vec0(node_id INTEGER PRIMARY KEY, ${column} ${colType} distance_metric=cosine)`;
   }
```

Also update the method's doc-comment example (lines 99-108) to show `distance_metric=cosine` in
the sample DDL, and the class-level intro comment if it references the DDL shape.

**Do NOT add a `metric` parameter to `createTableDDL`'s signature.** See ruling 3d below — every
caller passes a hardcoded `'cosine'` everywhere in this codebase; a parameter with one live value
adds surface without a real requirement (YAGNI), and it would force a matching signature change on
`VectorDialect.createTableDDL` in `types.ts`, which `TursoVectorDialect.createTableDDL`
(`vector-dialect.ts:198-201`) does not need — Turso's DDL is metric-agnostic (`distanceExpr`
carries the metric per query, unaffected by this change).

**B. `SqliteVecDialect.topKQuery` (currently lines 128-151):** add a guard as the *first*
statement in the method body, before the existing `vec = new Float32Array(queryVec)` line:

```ts
    // BL-392: vec0's distance metric is bound at CREATE TABLE time
    // (`distance_metric=cosine`, see createTableDDL) — sqlite-vec has no
    // query-time override for MATCH/KNN queries. Every vec_node table this
    // codebase creates now declares cosine, and every call site (recall.ts,
    // neardup.ts) only ever requests 'cosine'. Silently accepting 'l2'/'dot'
    // here would compute cosine distance while claiming a different metric
    // was used — fail loudly instead of lying.
    if (metric !== 'cosine') {
      throw new Error(
        `SqliteVecDialect.topKQuery: metric '${metric}' is not supported. ` +
        `vec0's distance metric is fixed at table-creation time via ` +
        `distance_metric=cosine (see createTableDDL) and cannot be ` +
        `overridden per query — only 'cosine' is valid.`,
      );
    }
```

The rest of the method body is unchanged (it still branches `distanceOrder` on `metric`, which is
now always `'cosine'` → `ASC`; leave that branch as dead-but-harmless rather than simplifying it —
simplifying `topKQuery`'s internal `ASC`/`DESC` selection is out of scope and not required by any
acceptance criterion).

**C. Do not touch `TursoVectorDialect`, `topKQueryCore`, `vecToJson`, `vecToBlob`, or the
`createVectorDialect` factory** in this file. `topKQueryCore` (lines 51-69) is dead code — grepped,
zero callers anywhere in `libs/` or `agent-source` (only its own declaration and the stale
`dist/vector-dialect.d.ts`). It is not reachable from either bug and touching it is scope creep.

### 2b. Out of scope — corrected from the PLAN/BACKLOG file list

**`libs/data/store/store-adapter/src/fts-dialect.ts` is NOT part of this fix and must not be
touched.** The PLAN.md packet header (`docs/reporting/memory/PLAN.md:1543`) lists it alongside
`sqlite-vec-dialect.ts` (which doesn't exist under that name — the real file is
`vector-dialect.ts`), but BL-392's own body (`BACKLOG.md:1701-1758`) cites only
`vector-dialect.ts` and `recall.ts` — nothing about FTS. This is a stale file reference in the
packet header, not a real second file to change. If the implementer finds a reason FTS is
genuinely implicated, that is new information and must come back to an architect before editing —
it is not something this spec authorizes.

**`libs/data/store/store-adapter/src/types.ts` (`VectorDialect` interface) — unchanged.** No
signature changes are needed (ruling above); the interface stays exactly as-is.

**`libs/data/store/store-adapter/src/migration.ts` — unchanged.** `getVecNodeCreateDDL`
(`migration.ts:305-317`) calls `createVectorDialect(targetType).createTableDDL(...)` and
automatically inherits the fix with zero edits. Verified safe: migration only ever writes into a
*target* adapter via `CREATE VIRTUAL TABLE IF NOT EXISTS`, and the copied payload is raw
`Float32Array` bytes (`migration.ts:229-298`) — the distance metric is a query-time
*interpretation* of those bytes, not a stored transformation, so changing it does not require
re-encoding any already-migrated vector.

**`libs/memory-core/src/db.ts`, `recall.ts`, `neardup.ts` — unchanged.** All three already pass
`'cosine'` at every call site (finding 3 above); the guard added in 2a-B validates what they
already do and changes nothing about their behavior.

---

## 3. Every decision, ruled

**3a. Does changing `createTableDDL`'s output risk `rebuildTable`/data loss on an existing
populated `vec_node` (the BL-313 hazard named in the dispatch)?**

**Ruled: No risk, and no `rebuildTable`/migration path is triggered by this change.** Both DDL
call sites are `CREATE VIRTUAL TABLE IF NOT EXISTS`:
- `libs/memory-core/src/db.ts:703` — every store-open.
- `libs/data/store/store-adapter/src/migration.ts:308-311` (`getVecNodeCreateDDL`) — migration
  target creation.

SQLite's `IF NOT EXISTS` is a true no-op when the named table already exists — it does not diff or
alter the existing schema against the new DDL text, and does not invoke anything in `migration.ts`'s
`rebuildTable` path (that path is for regular `CREATE TABLE`/ALTER-shaped mismatches, not a
guarded `CREATE VIRTUAL TABLE IF NOT EXISTS`, and this change doesn't route through it — verified
by grep, `rebuildTable` is not called anywhere near either `vec_node` DDL call site). Net effect:
**every already-created `vec_node` table on disk (including anything under `~/.memory/`) keeps
computing L2, unchanged, forever** — only tables created fresh *after* this fix get
`distance_metric=cosine`. This is the correct, safe scope for a LOW-severity item with no
migration budget: it stops the lie for new stores; retrofitting existing stores (which would
require an actual data migration — rebuild the vec0 table, since `ALTER` cannot add a `vec0`
column option) is explicitly **not** part of this fix and is not implied by the acceptance
criteria below.

**3b. Should the fix instead try to make `topKQuery`'s `metric` argument work per-query (i.e.
"actually respect" arbitrary l2/dot/cosine requests against one table)?**

**Ruled: No — structurally impossible for vec0, confirmed via research, not a judgement call.**
sqlite-vec's `MATCH`/KNN mechanism computes distance using whichever `distance_metric` the column
was declared with; there is no per-query override syntax. The only lever is the table's own DDL.
Any "fix" that pretends otherwise (e.g. rewriting the SQL to compute a manual cosine expression
alongside `MATCH ... k = ?`) would abandon `vec0`'s index/KNN machinery for that query — a much
larger, unrequested change with real performance implications, and not what BL-392 asks for
(BL-392's own fix sketch says "declare `distance_metric=cosine` explicitly … so the code's claim
and the engine's computation agree" — table-level, not query-level). **Losing alternative:** add a
`metric` parameter that silently no-ops for non-'cosine' values, same as today — rejected because
that is precisely the "silently ignored" behavior BL-392 exists to close.

**3c. Given 3b, how does `topKQuery` "stop silently ignoring metric=cosine"?**

**Ruled:** by validating the caller's requested metric against the one and only metric the table
can now compute, and throwing loudly on mismatch, per 2a-B. This is not a cosmetic fix — before
this change, requesting `l2` against a `distance_metric=cosine` table would silently return
cosine-computed values mislabeled as L2 (a live correctness bug for any future caller that ever
passes something other than `'cosine'`); after this change it throws instead. Combined with 2a-A,
`'cosine'` requests now genuinely get cosine-computed distances (they didn't before — finding 5).
**Losing alternative:** make `topKQuery` accept a `distanceMetric` the table was created with as a
constructor argument to `SqliteVecDialect`, threading it through instead of hardcoding `'cosine'`
in the guard — rejected: `createVectorDialect` (`vector-dialect.ts:268-273`) is a stateless factory
called fresh per adapter-open (`libs/memory-core/src/dialect.ts:19-20`) with no notion of "which
table, which metric" at construction time; a dialect instance is shared across every table/column
pair an adapter might query, so per-instance state would be actively wrong the moment a second
table with a different metric existed. Nothing in this codebase needs that generality (finding 3):
hardcoding the one value every real caller sends is correct, not lazy.

**3d. Should `createTableDDL` take a `metric` parameter instead of hardcoding `distance_metric=cosine`?**

**Ruled: No.** Covered in 2a-A. Losing alternative rejected because (i) zero callers ever pass
anything but `'cosine'` for `vec_node` — the only vec0 table this codebase creates — so a
parameter has exactly one live value forever, (ii) it would force `types.ts`'s
`VectorDialect.createTableDDL(table, column, dim)` signature to grow a 4th parameter, which
`TursoVectorDialect.createTableDDL` (metric-agnostic by design — Turso's metric lives in
`distanceExpr`/`topKQuery`, not DDL) would have to accept and ignore, and (iii) `migration.ts`'s
`getVecNodeCreateDDL` would need to know and forward a metric it currently has no reason to carry.
Net: strictly more surface, zero behavior change, for a codebase where the answer is always the
same literal.

**3e. The tiebreak / cross-backend-rowid-agreement half of BL-392 (finding 2 in the backlog body,
`BACKLOG.md:1726-1743`) — in scope?**

**Ruled: Out of scope for this packet.** `docs/reporting/memory/PLAN.md:1543` and `:1548` (the
`### PKT-22` packet's own Files/acceptance lines) name only the `distance_metric` declaration and
the `topKQuery` metric-ignored gap — not the tiebreak/rowid-portability question, which BL-392's
body explicitly defers as "a judgement call for the owner, not something to guess at here"
(`BACKLOG.md:1756-1757`). Do not touch `recall.ts`'s JS-side `node_id` tiebreak
(`recall.ts:521-529`) or attempt a `content_hash`-based tiebreak in this change.

**3f. Does `topKQueryCore` (the dead, unused helper at `vector-dialect.ts:51-69`) need the same
`distance_metric` treatment for consistency?**

**Ruled: No — leave untouched.** It is exported but has zero callers anywhere (grepped `libs/` and
the sibling `agent-source` repo). It does not participate in either bug. Fixing dead code's
internal consistency is not a requirement of BL-392 and is not free — touching an unrelated
exported symbol widens the diff's blast radius for a packet the PLAN scoped at `~8 turns`/haiku
tier (promoted to sonnet for the DDL judgement call, not for scope expansion). If it's ever wired
up, it inherits none of the safety already proven for `topKQuery`, and that's a separate, real
piece of work for whoever wires it up — not this packet.

---

## 4. Acceptance criteria, naming BL-392

### AC-1 (BL-392): `SqliteVecDialect.createTableDDL` declares `distance_metric=cosine`

**Assertion:** `SqliteVecDialect.createTableDDL('foo', 'embedding', 384)` output **contains**
`'distance_metric=cosine'`.

**Where:** update the existing exact-string assertion at
`libs/data/store/store-adapter/src/__tests__/vector-dialect.test.ts:104-109` (`'generates vec0
virtual table DDL'`) to the new full expected string, **and** add a new, separately-named test
(so BL-392 has its own explicit assertion, not just an incidentally-updated pre-existing one) —
e.g.:

```ts
it('BL-392: declares distance_metric=cosine explicitly (vec0 defaults to L2 otherwise)', () => {
  const ddl = dialect.createTableDDL('foo', 'embedding', 384);
  expect(ddl).toContain('distance_metric=cosine');
});
```

**RED today:** run this exact test against the current, unmodified `createTableDDL` — it fails
because the current output is
`'CREATE VIRTUAL TABLE IF NOT EXISTS "foo" USING vec0(node_id INTEGER PRIMARY KEY, embedding FLOAT[384])'`,
which does not contain the substring. Watch this fail before editing `vector-dialect.ts`, then
watch it pass after 2a-A. Do not skip the "watch it fail" step — write the test first if that's
easier to sequence.

### AC-2 (BL-392): `topKQuery` with `metric='cosine'` actually changes the *computed distance*, not just sort order

This is the criterion the dispatch explicitly warns is easy to fake (sort-order-only "fix"). It
must be proven against the **real sqlite-vec extension**, not a string-matched SQL template,
because — per ruling 3b — the SQL text `topKQuery` emits never literally contains the metric; the
metric lives in the table's DDL. An assertion on the SQL string alone cannot distinguish a real fix
from a no-op.

**Test location:** new file
`libs/data/store/store-adapter/src/__tests__/vector-dialect-distance-metric.bl392.test.ts`. Follow
the exact real-sqlite-vec pattern already proven working in
`libs/data/store/store-adapter/src/__tests__/migration.test.ts:15-24` (the `hasVec`/`vecDescribe`
skip-if-unavailable guard) and `:277-300` (`SqliteAdapterImpl` + `.unwrap()` +
`require('sqlite-vec')` + `sqliteVec.load(raw)` + `raw.exec(...)` + `raw.prepare(...)`).

**Test design — use non-normalised vectors so L2 and cosine distance provably diverge in VALUE**
(the BL-392 finding notes the parity corpus's normalised vectors keep L2 and cosine
*rank-order-equivalent*, which is exactly the trap: don't reuse normalised test vectors, or a
value-only assertion could pass by accident of monotonicity). Use e.g.
`a = [1, 0, 0, 0]`, `b = [2, 2, 0, 0]` (a is unit, b is not, and they are not collinear):

- expected Euclidean (L2) distance: `sqrt((1-2)² + (0-2)² + 0 + 0) = sqrt(5) ≈ 2.23606797749979`
- expected cosine distance (`1 - cos_sim`): `cos_sim = (1×2+0×2)/(1 × sqrt(8)) = 2/2.828427... ≈ 0.7071067811865475`, so `1 - cos_sim ≈ 0.2928932188134525`

These two expected values differ by a large margin (~2.24 vs ~0.29) — no float-tolerance ambiguity.

**Steps:**
1. Create a real `SqliteAdapterImpl` against a temp file (pattern from `migration.test.ts:277-284`).
2. Build table A: execute `dialect.createTableDDL('vec_a', 'embedding', 4)` (i.e., the **fixed**
   function, which will emit `distance_metric=cosine` once 2a-A lands) directly via the raw
   better-sqlite3 handle with sqlite-vec loaded.
3. Build table B: execute the **pre-fix DDL literal** by hand — i.e. hardcode
   `CREATE VIRTUAL TABLE IF NOT EXISTS "vec_b" USING vec0(node_id INTEGER PRIMARY KEY, embedding FLOAT[4])`
   (no `distance_metric` clause) — this stands in for "the current default", proving the two
   really do compute differently. (Do not call `dialect.createTableDDL` for table B — after the
   fix lands there is no code path left in this codebase that ever emits the pre-fix DDL, so it
   must be spelled out literally in the test to serve as the control.)
4. Insert `a` as row 1 into both tables; insert `b` (the query vector) is used as the MATCH query
   vector, not inserted.
5. Run `dialect.topKQuery('vec_a', 'embedding', b, 1, 'cosine')` and
   `dialect.topKQuery('vec_b', 'embedding', b, 1, 'cosine')` (same call, same metric argument,
   different table) through the raw handle (strip the `__PLACEHOLDER__`/join-on-`node` bits the
   same way `neardup.ts:65` does: `.replace('__PLACEHOLDER__', '1=1')`, and since there's no `node`
   table needed if you inline just `node_id, distance` — or create a matching stub `node` table
   with `rowid`s to satisfy the `JOIN` the same way `migration.test.ts:297-300` does).
6. Assert:
   - `distance` from table A (fixed DDL) is within float32 tolerance (`toBeCloseTo(0.2928932188134525, 4)` or similar) of the hand-computed cosine distance.
   - `distance` from table B (pre-fix-shaped DDL, i.e. today's committed behavior) is within
     tolerance of the hand-computed L2 distance `2.23606797749979`.
   - The two returned distances differ by more than, say, `1.0` — an explicit assertion that the
     *value* changed, not merely that some ordering changed (there's only one row, so "ordering"
     isn't even in play — this is a pure value assertion by construction, closing the trap named
     in the dispatch).

**RED today:** before 2a-A lands, `dialect.createTableDDL('vec_a', ...)` produces the same DDL as
the hand-written table B — so both tables would return `≈2.236` and step 6's "differ by more than
1.0" assertion fails (both values are the same). Watch it fail on `main`/pre-fix code, then watch
it pass after 2a-A.

**Also add, same file, for the guard (2a-B):**

```ts
it('BL-392: topKQuery rejects a non-cosine metric instead of silently ignoring it', () => {
  const dialect = new SqliteVecDialect();
  expect(() => dialect.topKQuery('vec_node', 'embedding', [1, 0, 0, 0], 5, 'l2')).toThrow();
  expect(() => dialect.topKQuery('vec_node', 'embedding', [1, 0, 0, 0], 5, 'dot')).toThrow();
});
```

**RED today:** both calls currently return normally (metric only picks ASC/DESC) — this test fails
pre-fix because `expect(...).toThrow()` sees no throw. Watch it fail, then pass after 2a-B.

**Existing tests that must be updated, not left red:**
`libs/data/store/store-adapter/src/__tests__/vector-dialect.test.ts:161-169` — `'uses DESC order
for dot metric'` and `'uses ASC order for l2 metric'` currently call
`dialect.topKQuery('t', 'v', [1, 2], 5, 'dot')` / `'l2'` and expect a normal return. After 2a-B
these calls throw. Update both to `expect(() => dialect.topKQuery(...)).toThrow()` — this is
tightening a test to match corrected behavior (the old assertions encoded the "silently accept
anything" bug), not weakening one; BL-225/no-weakening does not forbid replacing an assertion that
was asserting the buggy behavior itself.

---

## 5. Risks

- **Data-loss / `dist/`-destroying risk: none identified for this change**, per ruling 3a — the
  DDL-change hazard the dispatch flagged (BL-313's `rebuildTable` cascade-delete) does not trigger
  here because both call sites use `CREATE VIRTUAL TABLE IF NOT EXISTS` and neither routes through
  `migration.ts`'s `rebuildTable`. Implementer: if you find any code path that DOES call
  `rebuildTable` (or drops/recreates) `vec_node` off the back of this DDL string changing, **stop
  and report** per the dispatch instruction — that would mean this ruling is wrong and needs
  architect re-review before proceeding.
- **`nx build`/`nx test` destructiveness (BL-235/BL-456):** `store-adapter` is a `data` package
  with a real `dist/` (published `@adhd/sox-store-adapter`). Do not run a bare diagnostic
  `npx nx build store-adapter`. Use `npx nx test store-adapter -- <file>` to iterate; that alone
  triggers `^build` for its dependencies (none relevant here — `store-adapter` has no internal
  workspace deps that touch vector logic) but not a destructive rebuild of `store-adapter` itself
  beyond what `test`'s own dependency graph requires.
- **`~/.memory/*` is never touched** by this spec — all tests use `mkdtempSync(tmpdir())`-rooted
  temp files, matching `migration.test.ts`'s own pattern. Do not point any test or manual
  verification at a real `~/.memory/memory.db`.
- **Downstream consumer of `store-adapter`:** `memory-core` imports `createVectorDialect`
  dynamically (`libs/memory-core/src/dialect.ts:19-20`, `libs/memory-core/src/recall.ts:373-374`,
  `libs/memory-core/src/db.ts:324-330`) via `await import('@adhd/sox-store-adapter')` against its
  **built** `dist/`. After this fix, `npx nx build store-adapter` (a real, once-only rebuild — not
  a diagnostic one, since the fix is confirmed working via `nx test` first) must happen before any
  `memory-core`/`memory-server` test run picks up the fix, per the standard
  `libs/data/CLAUDE.md` "before any memory test" rule. This spec's own gate (§6) does not require
  a `memory-server`/`memory-core` rebuild or test run — BL-392's acceptance is fully containable
  inside `store-adapter`'s own test suite (finding 3: the fix doesn't change any `memory-core`
  call-site behavior, since they already pass `'cosine'`) — but if the implementer or reviewer
  wants an end-to-end sanity check, rebuild `store-adapter` first, then `memory-core`, then
  `memory-server`, in that dependency order, and expect zero behavior change in
  `recall-parity.test.ts`'s composite 0.80 bar (this fix does not touch tiebreak logic, per ruling
  3e).

---

## 6. The gate — exactly which nx targets to run

1. `npx nx test store-adapter -- vector-dialect.test.ts` — must show AC-1's new test and the two
   updated `dot`/`l2`-throws tests passing.
2. `npx nx test store-adapter -- vector-dialect-distance-metric.bl392.test.ts` — the new AC-2 file;
   must show the real-sqlite-vec value-divergence test and the guard-throws test passing. Requires
   `sqlite-vec` resolvable (it is a workspace dependency already used by `migration.test.ts` — the
   `hasVec`/`vecDescribe` skip guard exists for environments where it isn't, but this worktree's
   `pnpm install` already confirmed `sqlite-vec-darwin-arm64` present, so this must NOT report
   skipped — if it does, treat that as a real environment failure to report, not a pass).
3. `npx nx test store-adapter` (full project suite) — confirm no other existing test broke.
4. `npx nx lint store-adapter`
5. `npx nx typecheck store-adapter` — mandatory per the repo-wide rule that `build` never implies
   `typecheck`; this package's `esbuild`-free `tsc` build wouldn't strip an error anyway, but run
   it explicitly regardless, per house rule.
6. Before any of the above, and quoted alongside the final result: `node
   ../../tools/check-suite-tree-state.mjs --project store-adapter` (relative to the worktree root;
   absolute: `/Users/nix/dev/ai/sox-ecosystem/.worktrees/pkt22-vec-distance-metric/tools/check-suite-tree-state.mjs`
   — confirm this script exists in the worktree via `git worktree add`'s checkout; it's tracked at
   `tools/check-suite-tree-state.mjs` in `main`). Report its output with the test result per
   BL-456 — a worktree is single-agent by construction so this should read clean, but state it
   rather than assume it.
7. Do **not** run `npx nx build store-adapter` as part of this gate unless you have already
   confirmed 1-5 are green — building only to see an error is the banned BL-235 pattern. If you
   need to sanity-check the built artifact for a downstream consumer (§5's optional end-to-end
   note), that is a deliberate, already-green rebuild, not a diagnostic one.

**Do not mark BL-392 RESOLVED** until AC-1 and AC-2 have each been watched fail (pre-fix) and pass
(post-fix) by the implementer, per BL-225 — this is not satisfied by "the code looks right" or by
only running the suite once, post-fix, in isolation.

---

## 7. Commit hygiene reminder for the implementer

- Pathspec commits only: `git commit libs/data/store/store-adapter/src/vector-dialect.ts libs/data/store/store-adapter/src/__tests__/vector-dialect.test.ts libs/data/store/store-adapter/src/__tests__/vector-dialect-distance-metric.bl392.test.ts -m "fix(store-adapter): declare distance_metric=cosine on vec0 and reject unsupported topKQuery metrics (BL-392)"`
  (adjust file list to what actually changed; never `git add -A`/`.`).
- Scope prefix for this package: use `store-adapter` isn't in the house `CLAUDE.md`'s enumerated
  commit-scope list (`memory-core, sox, extensions, scripts, host-runtime, registry, ci, release,
  manifest, authoring, install-engine, nx-migration`) — the closest fit is none of them exactly;
  use the literal package name `store-adapter` as the scope (conventional-commits scopes aren't
  required to be from a closed enum, and this package has its own identity in `libs/data/`). If
  the reviewer disagrees, that's a fast, cheap fix — not worth blocking on here.
- `pnpm-lock.yaml` — this change adds no new dependency and no new `workspace:*` edge; no relock
  required.
