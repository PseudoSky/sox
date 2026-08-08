# SPEC — BUG-MEMORY-003: memory_recall pads results with null-content entity nodes

Author: architect stage. Worktree: `.worktrees/bug-memory-003-recall-null-rows`, branch
`feat/bug-memory-003-recall-null-rows`.

## 1. Root cause (two independent entry points — both must be fixed)

`memory_recall`'s query path (`memoryRecall()` in `libs/memory-core/src/recall.ts`) builds its
candidate rowid set from three channels and one post-hoc expansion. **Two of those four admit any
`node.kind`, not just `kind='episode'`:**

### 1a. Temporal channel — no kind restriction at all

`libs/memory-core/src/recall.ts:623-628`:

```ts
const temporalSql = `SELECT n.rowid, n.t_created FROM node n
     WHERE ${validityPred} ${agentFilter} ${filterSql}
     ORDER BY n.t_created DESC LIMIT ?`;
```

`validityPred` (line 500-502) only checks `t_invalid`/`t_valid`; `filterSql` (built at line 386-473)
only ever adds `topic`/`tags`/`importance`/`project_path`/time-range clauses — nothing constrains
`n.kind`. Every live node in the store — episode, entity, community, session, generic — is a
candidate here, ordered by recency. The resulting `temporalRanks` map (line 630-631) feeds directly
into `allRowids` (line 634-638), the candidate set that gets scored and (subject to `limit`/
`token_budget`) returned.

Contrast with the **vec** channel (line 508-535) and **FTS/BM25** channel (line 541-619): neither
needs a kind restriction to reproduce today's bug, because `vec_node` and the FTS index are only
ever populated for episode writes — confirmed by reading the entity-creation path,
`libs/memory-core/src/write.ts:365-390`, which does `INSERT INTO node (uid, kind, name, t_created,
t_valid) VALUES (?, 'entity', ?, ?, ?)` (`write.ts:383`) and **nothing else** — no `vec_node` insert,
no FTS row. This is exactly why every reported specimen scored `vec: 0, bm25: 0` and ranked on
`temporal` alone (per the item's own evidence) — confirmed, not merely suspected: entity nodes are
*structurally* unreachable by the vec/FTS channels and *structurally* reachable by the temporal
channel, because only the temporal channel's SQL omits a kind predicate.

### 1b. Graph depth-1 expansion — neighbor fetch has no kind restriction either

`libs/memory-core/src/recall.ts:808-838`. `DEFAULT_DEPTH = 1` (line 300), so this runs on every
default-parameter call. After the top-`limit` episodes are chosen, their depth-1 graph neighbors are
pulled in via `edge` (line 816-821) and fetched with:

```ts
const expResult = await adapter.executeAll<NodeRow>(
  `SELECT rowid, uid, content, name, summary, importance, t_created, t_valid, t_invalid, agent_id, content_hash, session_id
   FROM node WHERE rowid IN (${expandedNew.join(',')}) AND ${nodeValidPred}`,   // recall.ts:834-838
);
```

again no kind predicate. Every tagged episode has a live `MENTIONS` edge to the entity node(s) its
tags created (`write.ts:365-390`), so **any top-ranked tagged episode's own entity nodes are its
depth-1 neighbors** and get pulled in here, then pushed through `addResult()` (line 887-897) with
`provenance: ['graph']`. This path is *independent* of 1a — fixing only the temporal channel leaves
this one live, and it is the more commonly hit path in practice (it fires whenever any returned
episode has tags, not only when an entity happens to out-rank real episodes on recency).

Both `content: null` and the near-zero-score shape reported in the item are explained: 1a rows carry
a real (if tiny) `temporal` score component; 1b rows carry `score_breakdown: {vec:0,bm25:0,temporal:0}`
by construction (`graphBreakdown` at line 895) — a second null-content signature the item's four
captured specimens don't happen to include, but which reproduces from the very same corpus the moment
depth defaults to 1 (which it always does unless the caller overrides it).

### What is confirmed NOT the bug

`libs/memory-core/src/recall.ts:646,649,1091,1094` and the sibling no-query **listing** branch,
`extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts:1487-1495`, already hard-code
`n.kind = 'episode'` (or `WHERE n.kind = 'episode'` — count queries). The listing branch is correct
today and is explicitly **out of scope** — see §2.

## 2. The change — file by file

### `libs/memory-core/src/recall.ts` (in scope, primary fix)

1. **New optional filter key `kinds`.** `RecallParams.filters` is an untyped
   `Record<string, unknown>` (line 125) already special-cased per-key in the loop at lines 395-425
   (`project_path`, `tags_match_all`, `t_created_after`, `t_created_before` are handled outside the
   generic `buildFilterClause` call). Add `kinds` there the same way — **do not** route it through
   `buildFilterClause`/`NodeFilter` in `libs/data/search/hybrid-search/src/filter-utils.ts`. That file
   is out of scope (see §3, decision D3) and is shared by `memory_curate recluster`'s filter
   vocabulary — widening its `NodeFilter` type to carry `kinds` would ripple into a consumer nobody
   asked you to touch.

2. **Compute `kindClause`/`kindParams` unconditionally**, not gated behind `if (filters && …)`
   (the existing gate around `filterSql`/`filterParams` construction, line 388). The bug reproduces
   with **zero filters supplied** — the exclusion must be the default, always-on behavior, not
   something that only activates when a caller already passed some other filter.
   ```ts
   const kinds = (filters && Array.isArray((filters as Record<string, unknown>)['kinds'])
     ? (filters as Record<string, unknown>)['kinds'] as string[]
     : ['episode']);
   const kindClause = kinds.length > 0 ? ` AND n.kind IN (${kinds.map(() => '?').join(',')})` : '';
   const kindParams: unknown[] = kinds;
   ```
   No validation against `ontology.ts`'s `MEMORY_NODE_KINDS` — parameterized pass-through only (same
   trust level as `tags`/`topic` already get). An unknown kind string just matches nothing; that is
   an acceptable, non-silent outcome (an empty/short result set, not corrupted data).

3. **Apply `kindClause`/`kindParams` at all three candidate-admission SQL statements**, in the same
   position `filterSql`/`filterParams` are already threaded (append kind params *after* filter
   params, matching where the clause text lands):
   - Temporal SQL, line 623-628: add `${kindClause}` into the WHERE, `...kindParams` into
     `temporalParams` before `knnLimit`.
   - Vec KNN `filterClauses`, line 516: `[validityPred, agentFilter, filterSql, kindClause]`; add
     `...kindParams` into `vecParams` after `...filterParams`, before `knnLimit`.
   - FTS, both branches (line 573-605): SQLite shadow-table branch adds `${kindClause}` into its
     WHERE and `...kindParams` into the bind array before `ftsLimit`; Turso branch does the same but
     through `kindClause.replace(/\bn\./g, '')` (mirrors the existing `validityPred.replace(...)` /
     `agentFilter.replace(...)` / `filterSql.replace(...)` treatment two lines above it, because the
     Turso branch queries `node` directly with no `n` alias).

4. **Apply the same `kinds`-derived predicate to the graph-expansion neighbor fetch**, line 834-838
   (§1b). This query has no `n` alias (`FROM node WHERE rowid IN (...) AND ${nodeValidPred}`), so use
   the un-aliased form directly: `AND kind IN (${kinds.map(() => '?').join(',')})`, params appended
   after the existing bind list. This is the fix for the second entry point — omitting it leaves the
   bug reproducible via depth-1 expansion alone, RED even after fixing 1a.

5. **`RecallParams` type / doc comment**: no new top-level field — `kinds` lives inside the existing
   `filters?: Record<string, unknown>` bag, so no interface change is needed there. Add a doc comment
   above the `filters` field (or near `ScoreBreakdown`/`RecallResult`) stating the new default:
   entity/community/session/generic nodes are excluded from recall results unless
   `filters.kinds` explicitly includes them.

6. **Do not touch**: the no-query listing branch is in `index.ts`, not `recall.ts` — nothing to do
   here for it. Do not touch `federatedRecall`/`recallFromOpenDb` (line 1284-1333) — they call
   `memoryRecall()` internally and inherit the fix for free; no separate kind-filter plumbing needed
   there.

### `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts` — `memory_recall` handler (`case 'memory_recall':`, currently lines 1440-1624; **re-confirm exact boundaries before editing, this file is contended** — the case block runs from the `case 'memory_recall': {` line up to (not including) the next `case 'memory_search_entities': {` line)

1. **Tool schema** (`filters.properties`, around line 422-439): add
   ```ts
   kinds: {
     type: 'array',
     items: { type: 'string' },
     description: 'Node kinds to include in results (default: ["episode"]). Entity/community/session/generic nodes carry no readable content and are excluded by default; pass e.g. ["episode","entity"] to opt in.',
   },
   ```
2. **Filter-forwarding loop** (currently lines 1544-1567): add a `kinds` branch identical in shape
   to the existing `tags`/`t_created_after` branches:
   ```ts
   const ki = filters['kinds'];
   if (ki !== undefined) recallFilters['kinds'] = ki;
   ```
   This is the step that is easiest to silently skip — the loop only forwards keys it explicitly
   knows about, so a tool-schema addition with no matching branch here is a schema field that looks
   accepted but is silently dropped before reaching `recall.ts`. The MCP-seam test in §4 exists
   specifically to catch exactly this failure mode.
3. **Do not** add a `content !== null` filter anywhere in this handler (in the `enrichedResults`
   map, currently 1580-1601, or the `filteredResults` post-filter, currently 1606-1619) as a
   belt-and-suspenders guard. See §3 D8 — ruled against.
4. **Do not** touch the no-query listing branch (currently lines 1446-1541) — it already hard-codes
   `n.kind = 'episode'` at line 1491 and is not broken.

### Out of bounds — do not touch, and why

- `libs/data/store/store-adapter/**`, `libs/memory-core/src/telemetry.ts` — BUG-MEMORY-001's packet.
- `memory_invalidate` handler (~:1756+ pre-edit numbering), `memory_write`'s tool-description string
  (~:334 pre-edit numbering), any `SKILL.md` — BUG-MEMORY-002/004's packet.
- `libs/data/search/hybrid-search/src/filter-utils.ts` (`buildFilterClause`/`NodeFilter`) — shared by
  `memory_curate recluster`'s filter vocabulary (`index.ts:706`); widening its type is unrequired
  scope creep with a blast radius outside this bug. `kinds` is handled entirely inside `recall.ts`'s
  own special-cased filter-parsing loop instead (§2, decision confirmed in §3 D3).
- The no-query listing branch in `index.ts` (~1446-1541) — already correct, not part of this bug.

## 3. Decisions, ruled

**D1 — Fix layer: SQL candidate-admission, not post-hoc JS filtering on the assembled result list.**
Ruled: fix at the SQL layer (§2). Losing alternative: filter `results` for `content !== null` right
before returning (either in `recall.ts`'s `addResult`/final assembly, or as a guard in `index.ts`).
This loses because it doesn't fix the actual defect described in the item — "it silently shrinks the
effective result set." `knnLimit`/`ftsLimit` default to 20 (`DEFAULT_KNN_LIMIT`/`DEFAULT_FTS_LIMIT`,
recall.ts:301-302); if entity rows occupy slots in the temporal candidate window (`ORDER BY
t_created DESC LIMIT 20`), they can crowd out real episodes from ever entering `allRowids` at all,
independent of any downstream filtering. A JS-level filter applied after assembly cannot undo a
candidate window that never contained the excluded episode in the first place. The item's own hint
("worth checking whether they should be candidates at all") already points at this — confirmed
correct by reading the code.

**D2 — Default behavior change, not opt-in-only.** Ruled: episode-only is the new default; entity
inclusion is opt-in via `filters.kinds`. This is the item's own suggested fix direction and is stated
as a ruling requirement, not a choice — quoting the item: "exclude non-episode node kinds from
`memory_recall` by default, or expose a `kinds` filter with episode-only as the default." Both
options describe the same behavior; there is no live alternative here since the item pre-selected
"episode-only default" in both variants.

**D3 — `kinds` lives inside `filters`, handled locally in `recall.ts`, not routed through
`buildFilterClause`/`NodeFilter`.** Ruled in §2. Losing alternative: add `kind`/`kinds` to the shared
`NodeFilter` type in `libs/data/search/hybrid-search/src/filter-utils.ts` so every `buildFilterClause`
caller gets it uniformly. Loses because (a) it is out of the granted scope fence for this packet, (b)
`memory_curate recluster`'s filter vocabulary is documented as sharing the same shape
(`index.ts:706`, "Same filter vocabulary as memory_recall") — widening the shared type changes that
tool's accepted input surface too, an unrequested and unreviewed side effect, (c) `recall.ts` already
has an established local pattern for filter keys that don't map to a generic node column
(`project_path` object-vs-string, `tags_match_all`, `t_created_after/before`, lines 395-425) — `kinds`
fits that pattern exactly and needs no shared-type change to work.

**D4 — No validation of `kinds` values against the `MEMORY_NODE_KINDS` enum.** Ruled: pass through as
parameterized values, no throw on unknown kind strings. Losing alternative: validate and throw
`E_INVALID_KIND` (or similar) on an unrecognized value. Loses because no other `filters` key in this
handler validates its values today (`topic`/`tags`/`project_path` all silently no-op on values that
match nothing) — introducing validation only for `kinds` is an inconsistent, unrequested new error
surface, and the item does not ask for it. Revisit only if a future item specifically wants it.

**D5 — Graph-expansion neighbor fetch (§1b) is in scope and REQUIRED, not optional hardening.**
Ruled: this is root cause, not defense-in-depth — see §1b for why it reproduces independently of the
temporal-channel fix (`DEFAULT_DEPTH = 1`, and MENTIONS edges make every tagged episode's own entity
nodes its own depth-1 neighbors). A fix that only touches the temporal SQL (§1a) will pass a
depth:0-only test and fail the default-depth test in §4 — that gap is exactly what §4's two-arm test
design (D9 below) exists to catch.

**D6 — Vec/FTS channels get the same `kindClause` too, for symmetry and future-proofing, even though
today they cannot admit entity rows.** Ruled: apply uniformly (§2 point 3). This is not required to
fix the reported bug (confirmed in §1a: `vec_node`/FTS index are never populated for entity nodes
today, by reading `write.ts:365-390`), but omitting it here would leave three near-identical SQL
statements with an inconsistent contract — if a future feature ever embeds/FTS-indexes non-episode
nodes, only the vec/FTS channels would silently regress back into this exact bug while the temporal
and graph-expansion channels stayed fixed. Losing alternative: touch only the temporal SQL and the
graph-expansion fetch, leave vec/FTS untouched — loses because it re-opens the same defect class the
moment those channels' data population assumptions change, for the cost of two trivial extra clauses
in code paths already being edited.

**D7 — No-query listing branch is out of scope, left untouched.** Ruled in §2. It already hard-codes
`kind = 'episode'` (`index.ts:1491`) with no way for a caller to opt into entities at all — this is an
inconsistency with the query path post-fix (which gains an opt-in), but it is not broken, is not part
of the reported defect, and extending it is unrequested scope creep into a working code path in a
contended shared file. If a future item wants listing-mode kind opt-in, file it separately.

**D8 — No redundant `content !== null` guard added anywhere downstream of `recall.ts`.** Ruled
against, in §2 and here. A second filtering layer that silently drops null-content rows would mask
any future regression in the SQL-layer fix rather than surfacing it as a visible failure — the same
"looks complete over a degraded reality" shape the item explicitly compares this bug to (BL-167/
BL-319/BL-469). One source of truth: `recall.ts`'s candidate-admission SQL.

**D9 — Test structure: split the primary regression test into two arms isolating the two entry
points, plus a third opt-in-still-works arm and a token-budget arm.** Ruled — see §4 for the exact
four cases required. Losing alternative: one combined test with default params only. Loses because a
partial fix (only §1a OR only §1b) would still pass a single combined test in some corpus shapes
(e.g., if the one entity that would have leaked via graph-expansion also happens to rank within the
temporal-channel-fixed candidate window for unrelated reasons) — split arms make a partial fix
observably RED on the arm it didn't fix, which is the entire point of a regression test naming a
specific mechanism.

**D10 — Regression tests for the `recall.ts`/candidate-admission logic go in
`libs/memory-core/src/recall.spec.ts`** (existing file, new `describe` blocks), not a new spec file.
Ruled: this file already contains the closely-related BL-117 and BL-167 candidate/scoring-layer
regression tests (confirmed by reading it, lines 68-90 and the BL-167 comment at line 376) and uses
the exact `openDb`+`memoryWrite`+`memoryRecall` harness this bug needs — no new file, no new harness.
Losing alternative: a new `recall-bug-memory-003.spec.ts` mirroring `recall-live-incident.spec.ts`'s
naming. Not wrong, but unnecessary file proliferation for a fix that belongs beside its nearest
sibling tests; low-stakes, ruled for consistency with the nearer precedent.

**D11 — A second, separate test proves the MCP-handler wiring (`filters.kinds` schema field →
`index.ts`'s manual forwarding loop → `recall.ts`), because that translation layer can silently drop
an accepted-looking schema field.** Ruled: add a new memory-server-package test file
`extensions/bundles/sox-memory-bundle/members/memory-server/recall-bug-memory-003.test.ts`, modeled
on `clustering-e2e.test.ts`'s pattern (`handleToolCall('memory_write', {...})` /
`handleToolCall('memory_recall', {...})` against a real scratch SQLite DB via `openDb`, no mocks) —
confirmed this pattern already exists and is exactly what's needed by reading
`clustering-e2e.test.ts:60-70,150-181`. This is the literal "real MCP seam" the acceptance criteria
names: a `memory-core`-level test alone (D10) proves `memoryRecall()` is fixed but does NOT prove the
`filters.kinds` MCP tool-schema field survives `index.ts`'s hand-written per-key forwarding loop —
that loop is a distinct place this exact bug class ("field looks accepted, silently dropped") can
recur, and only a handler-level test can catch it.

**D12 — Publication surface: a changeset for `@adhd/sox-memory-core`, plus a hand-authored
CHANGELOG.md/package.json bump for the `memory-server` bundle extension.** Ruled: `@adhd/sox-memory-core`
is published at `0.6.0` (confirmed: `libs/memory-core/package.json`) and this is a behavioral default
change to a published function's output — add `.changeset/bug-memory-003-recall-kind-filter.md`,
bump type **patch** (this is a bug fix — the previous behavior was defective, not an intentional
capability being widened; the new `filters.kinds` capability is incidental to fixing the defect, not
the headline). Follow the exact frontmatter/prose convention already in
`.changeset/conn-recycle-sox-store-adapter.md` (read in full during spec drafting) — package name in
frontmatter, prose body naming the defect and the fix, "Additive" callout for the new optional
`filters.kinds` field. Separately, `extensions/bundles/sox-memory-bundle/members/memory-server` is
versioned by hand (`package.json` currently `1.3.0`, `CHANGELOG.md` hand-maintained, confirmed no
`.changeset/*.md` entry references `@adhd/sox-extension-memory-server` anywhere in the repo today) —
bump `package.json` to `1.3.1` (patch: bug fix + additive opt-in filter field, matching the
memory-core changeset's own patch classification) and add a `## 1.3.1` section to `CHANGELOG.md`
above the existing `## 1.3.0` section, in the same "### Patch Changes" style already used elsewhere in
that file, describing the null-content padding fix and the new `filters.kinds` opt-in. Do **not** run
`npx nx build memory-server` as part of this — see §5 risk R2.

## 4. Acceptance criteria (BUG-MEMORY-003) — each with its RED arm

All four live in test files per D10/D11. Every assertion below is `results.every(r => r.content !==
null)` or stronger — never merely "the expected episode is present" (the item is explicit that the
weaker assertion is exactly what let this ship).

**AC1 — Temporal-channel entry point closed (`libs/memory-core/src/recall.spec.ts`, `depth: 0`).**
Write 2-3 tagged episodes via real `memoryWrite()` (tags create real entity nodes via the real
`write.ts:365-390` path — do not hand-insert `kind='entity'` rows). Call `memoryRecall(db, 'project',
{ query: <text matching the episodes>, depth: 0, limit: 10 })`. Assert:
- `response.results.every(r => r.content !== null)`
- `response.results.length` equals the number of episodes written (not padded by entity rows)
- **RED arm**: with `recall.ts`'s temporal SQL (§1a) unfixed, this fails because at least one
  `result.content === null` appears — reproduce it by temporarily reverting only the temporal-SQL
  hunk and re-running; must observe an actual `content: null` row in the failure output, not an
  assumed one.

**AC2 — Graph-expansion entry point closed (`libs/memory-core/src/recall.spec.ts`, default `depth`,
i.e. omit the param so `DEFAULT_DEPTH = 1` applies).** Same corpus as AC1, call `memoryRecall` with no
`depth` override. Assert the same two conditions as AC1.
- **RED arm**: with §1a fixed but §1b (graph-expansion neighbor fetch) unfixed, this test must still
  fail — verify by applying only the §1a hunk and confirming AC2 is still RED before applying the
  §1b hunk, then GREEN after. This is the split that proves both entry points were independently
  necessary (D5, D9).

**AC3 — Opt-in still works (`libs/memory-core/src/recall.spec.ts`).** Same corpus, call
`memoryRecall(db, 'project', { query: ..., filters: { kinds: ['episode', 'entity'] }, limit: 20 })`.
Assert `response.results.some(r => r.content === null)` — i.e. entity rows ARE present when
explicitly requested. This proves the change is a filter, not a deletion of entity-recall capability.
- **RED arm before the feature exists at all** (pre-any-fix baseline): this assertion trivially passes
  today (everything is unfiltered) — that is expected and fine; AC3's real RED arm is checked
  *against the fixed default* — i.e. run AC3 immediately after AC1+AC2 pass with the default-kind
  fix in place, confirm `filters.kinds` demonstrably re-admits entities where the default now
  excludes them (AC1/AC2's own corpus with default params must show zero null rows in the same test
  run's setup, immediately before this assertion, to prove it's the `filters.kinds` override doing
  the work, not corpus luck).

**AC4 — Token budget spent on usable rows
(`libs/memory-core/src/recall.spec.ts`).** Write one episode with enough content to consume a known,
sizeable token estimate (use `estimateTokens`'s documented `Math.ceil(text.length/4)` formula to size
the fixture precisely) and tags that create entity nodes. Set `token_budget` to a value large enough
for exactly one real episode's tokens but too small for two. Call `memoryRecall` with default
`depth`. Assert:
- `response.results.length === 1`
- that one result's `content !== null`
- **RED arm**: with either §1a or §1b unfixed, an entity candidate can consume a slot inside the
  `addResult()` token-budget accounting (`recall.ts:842-874`) before the real episode is reached in
  `ranked` order, or displace it from the top-`limit` window before expansion runs — reproduce by
  reverting the fix and re-running; must observe either zero results, a null-content result, or the
  real episode's content missing, not merely infer it.

**AC5 — MCP-seam wiring
(`extensions/bundles/sox-memory-bundle/members/memory-server/recall-bug-memory-003.test.ts`, per
D11).** Via `handleToolCall('memory_write', {...})` write 2+ tagged episodes to a scratch SQLite DB
(model the harness on `clustering-e2e.test.ts:60-70,150-181` exactly — real `db_path`, real
`project_path`, no mocked adapter). Call `handleToolCall('memory_recall', { db_path, query: ...,
limit: 10 })` (no `filters` — default path) and parse the JSON response body. Assert:
- every entry in `body.results` has `content !== null`
- a second call with `filters: { kinds: ['episode', 'entity'] }` on the same DB shows at least one
  `content === null` entry, proving `index.ts`'s filter-forwarding loop (§2, point 2) actually
  threads `kinds` through to `recall.ts` instead of silently dropping it.
- **RED arm**: with the `index.ts` filter-forwarding branch for `kinds` absent (i.e. `recall.ts`
  fixed but `index.ts` NOT updated to forward `filters.kinds`), the first assertion still passes
  (default is fixed at the `recall.ts` layer regardless) but the SECOND assertion fails — the opt-in
  request silently returns zero null rows because `kinds` was dropped before reaching `recall.ts` and
  the default (`['episode']`) applied instead. This is the exact "field looks accepted, silently
  dropped" failure mode named in §2/D11 — verify it actually reproduces that way before shipping the
  `index.ts` hunk (comment out just the forwarding branch, confirm AC5's second assertion goes RED,
  then restore it).

## 5. Risks

- **R1 — Shared contended file.** `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts`
  has a sibling packet (BUG-MEMORY-001/002/004) editing other regions concurrently. Stay strictly
  inside the `memory_recall` tool-schema block (~412-439) and the `case 'memory_recall':` block
  (~1440 to the line immediately before `case 'memory_search_entities':`). Re-read the file
  immediately before editing to get current line numbers — they drift. Commit only the exact lines
  touched (`git commit <path> -m ...`), never `git add -A`/bare `git commit`.
- **R2 — `nx build`/`nx test` are destructive/rebuild hazards (BL-235/BL-456).** Do not run
  `npx nx build memory-core` or `npx nx build memory-server` speculatively — only after source is
  believed correct, and never to "see the error." Every `npx nx test` invocation rebuilds the
  project's transitive `^build` dependency set from whatever is currently on disk, which may include
  a concurrent sibling packet's in-flight edit to the same shared `index.ts` — report
  `node tools/check-suite-tree-state.mjs --project memory-core` (and, separately, `--project
  memory-server` if that project has its own target — confirm target existence first) alongside any
  test result so it is attributable.
- **R3 — Live store safety.** Never open `~/.memory/*` for writing. All fixtures in this spec use
  `fs.mkdtempSync` + `openDb()`/`handleToolCall({db_path: <tmp>})` scratch stores, matching the
  existing `recall.spec.ts`/`clustering-e2e.test.ts` pattern exactly — no exception needed or
  granted.
- **R4 — Parameter-order bugs in the four edited SQL statements.** Each of the four touched queries
  (temporal, vec, FTS×2 branches, graph-expansion) binds params positionally; inserting `kindParams`
  in the wrong position relative to existing `filterParams`/`knnLimit`/`ftsLimit` produces a
  runtime SQLite bind-count mismatch or, worse, a silently wrong bind (e.g. a kind string bound where
  a limit integer was expected) that could pass on SQLite (loose typing) and fail cryptically on
  Turso. §2 point 3 specifies the exact position for each; **verify param count arithmetic by hand
  against the finished SQL string** before treating any of the four as done — do not just runtime-test
  and assume it working means the order was right (a length-4 array bound to 4 placeholders can still
  be silently transposed rather than mismatched).

## 6. The gate — nx targets to run, in order

1. `npx nx lint memory-core` and `npx nx lint memory-server` (extension project name — confirm via
   `nx show projects` or the project's own `project.json` if the target name differs from the
   directory name; do not guess).
2. `npx nx typecheck memory-core` and (if it has its own target — confirm first per the repo's own
   "typecheck is not optional" rule) `npx nx typecheck memory-server`.
3. `npx nx test memory-core -- recall.spec.ts` first, scoped, while iterating on AC1-AC4. Report
   `node tools/check-suite-tree-state.mjs --project memory-core` with the result.
4. Full `npx nx test memory-core` (unscoped) once AC1-AC4 are green, to confirm no other
   `recall.spec.ts`/`recall-live-incident.spec.ts`/`recall-federation.bl391.spec.ts` case regressed.
5. `npx nx test memory-server -- recall-bug-memory-003.test.ts` scoped, for AC5. Report
   `node tools/check-suite-tree-state.mjs --project memory-server` with the result (confirm this
   target/project name is correct first — do not assume without checking `project.json`).
6. Do **not** run `npx nx build memory-core` or `npx nx build memory-server` as part of routine
   iteration (R2) — `nx test`'s `dependsOn: ["^build"]` already rebuilds what's needed for the test
   run itself.
7. **Never pass `--skip-nx-cache`.**
8. RED→GREEN evidence required per BL-225 for every AC in §4 before any backlog transition: capture
   the failing run (fix hunk reverted) and the passing run (fix restored) for AC1, AC2 (both arms
   independently, per D5/D9), AC4, and AC5's second assertion (per its own RED-arm description). AC3
   does not have a meaningful RED arm before the fix exists (see AC3's own note) — that is expected,
   not a gap.

## 7. Commit

Pathspec-only commits (`git commit libs/memory-core/src/recall.ts libs/memory-core/src/recall.spec.ts
-m "..."`, etc. — never `git add -A`/bare `git commit`). Conventional-commit, lowercase subject,
scope `memory-core` (and a separate commit scoped `extensions` for the `index.ts`/schema/CHANGELOG/
package.json hunks, since they're a different project). Suggested subjects:
- `fix(memory-core): exclude non-episode node kinds from memory_recall candidates by default (BUG-MEMORY-003)`
- `fix(extensions): thread filters.kinds through memory_recall MCP handler (BUG-MEMORY-003)`

Do not resolve `BUG-MEMORY-003` in the backlog graph from this stage — that happens after reviewer
sign-off per the pipeline (architect → implementer → reviewer → implementer → reviewer).
