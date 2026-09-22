# Fix plan — automatic near-dup invalidation is lossy, unobservable, and miscalibrated

**Status:** plan draft. No source edited, no store written, no build run.
**Scope:** `applyNearDupResult` invalidation policy (Q1), `is_current` canonical selection (Q2),
remediation of 684 already-merged pairs (Q3), `memory_entity_episodes` count contract (Q4).

## Relationship to existing memory docs (read this first)

This draft **does not open a parallel doc tree**. Per project `CLAUDE.md`, memory-subsystem state
lives in `docs/reporting/memory/`.

- **`NOTES.md:56-86` already documents this defect** ("near-duplicate pass silently invalidates the
  OLDER of any ≥0.95-cosine pair … `reason: null`, no supersession edge, `is_current: true`),
  including a reproduction at `NOTES.md:80` and the desired invariant at `NOTES.md:86`. This plan
  **supersedes that note's remedy sketch** — the note proposes "a merge is a SUPERSEDES/SAME_AS link
  plus a `reason`". Evidence gathered below shows that remedy is insufficient (it makes the loss
  auditable, not absent). Nothing else in the note is contradicted.
- **`SPEC-BUG-MEMORY-002+004.md` is complementary, not overlapping.** It fixed the *caller-facing*
  contract (`already_invalid` idempotency, `E_WRONG_KIND`) for `memoryInvalidate`
  (`libs/memory-core/src/write.ts:786-824`) and correctly diagnosed the near-dup pass as the racing
  mechanism (§1b). It deliberately did **not** change near-dup policy. This plan does.
- On adoption, findings belong in `docs/reporting/memory/findings/`, state in its `STATE.md`, and the
  BL items named in §6 filed through the backlog tool (family `BL`, repo `sox-ecosystem`). This
  draft is the input to that, not a replacement for it.
- **Dependency, stated and not duplicated:** a second investigation covers whether chunks should
  inherit `topic`/`tags`/`project_path` from their parent. Q1-C below removes the parent↔chunk
  invalidation entirely, which removes the *acute* data-loss consequence of chunks having
  `topic:null`/`tags:[]`. It does not fix chunk metadata inheritance and does not depend on it.
  Sequencing note: Q1 can land before or after that work; if inheritance lands first, Q1-C is still
  required (a parent invalidated by its own chunk is wrong regardless of chunk metadata).

---

## 1. Evidence base

### 1.1 Confirmed by the dispatcher (treated as established fact)

- `libs/memory-core/src/enrich.ts:127-135` — bare `UPDATE node SET t_invalid = ? WHERE uid = ? AND
  t_invalid IS NULL`. No reason, no `SUPERSEDES` edge.
- `libs/memory-core/src/enrich.ts:91` — `NEARDUP_THRESHOLD = 0.95`.
- `libs/memory-core/src/supersession-chain.ts:104-118` — an auto-invalidated node reports
  `is_current: true`.
- Chunk ordering: `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts:1729-1766`
  — parent is pushed to `pendings` first, so the later-embedded chunk invalidates the parent.
- `memory_near_duplicates(threshold: 0.95)` → **total: 684** already-merged pairs store-wide.
- `memory_supersession_chain(uid: "01KVTJ2VWZQEHA0R6K39HXHNQT")` → `t_invalid` set 1.05 s after
  `t_created`, `reason: null`, `chain.length: 1`, `is_current: true`.

### 1.2 New findings from this review (each changes a recommendation)

**F1 — `should_invalidate` is degenerate: it is `true` on every non-null result. There is no policy
gate anywhere in the pipeline.**
`libs/data/analysis/analysis/src/index.ts:196-197` assigns `status = 'near_dup'` iff
`cos >= nearDupThreshold`. `libs/memory-core/src/neardup.ts:105-108` selects `bestPair` only from
pairs with `p.status === 'near_dup'`, then `neardup.ts:128` computes
`should_invalidate: bestPair.cosine >= threshold` — a tautology given how `bestPair` was selected.
So the field reads like a policy decision and carries none. *Consequence:* the fix cannot be "make
`should_invalidate` smarter at the call site" — the decision point does not exist yet and must be
created.

**F2 — nothing enforces "the OLDER node". The doc comment
(`libs/memory-core/src/enrich.ts:99-101`, "bi-temporally invalidate the OLDER episode") is an
assumption, not code.**
`enrich.ts:127-131` invalidates `nearDup.existing_uid` — whichever node the KNN happened to match —
with **no `t_created` comparison anywhere in `enrich.ts`, `neardup.ts`, or `embed-pipeline.ts`**. On
the normal write path the neighbour is usually older, so the comment is usually accidentally true.
It is **not** true on the heal paths: `healMissingVectors` (`embed-pipeline.ts:796`) and
`healStaleVectors` (`embed-pipeline.ts:1071-1075`, inside the `embed_stale_apply` enqueue) both route
through the same `applyEmbedding` (`embed-pipeline.ts:423`), whose near-dup pass runs at
`embed-pipeline.ts:466-490`. Re-embedding an **old** node therefore makes its KNN neighbour — which
may be **newer** — the invalidation target. *Consequence for Q3:* **age is not a valid tiebreaker in
remediation.** Any procedure of the form "restore the older one" is unsound.

**F3 — the false positives occupy the TOP of the score range. This is the fact that kills threshold
tuning.**
From a read-only `memory_near_duplicates(threshold: 0.95, limit: 6)` sample:

| cosine | pair | verdict |
|---|---|---|
| 0.98798 | `01KVTJ2WKC…` ↔ `01KVTJ2VWZ…` — previews identical over all 120 chars ("sox sync dry-run ~modify on a DISABLED plugin…"); **full-text identity NOT verified** | probable genuine duplicate |
| 0.99164 | "published artifact embeds a generated input…" ↔ "A subagent/tool reporting 'success' is not proof of effect…" | false positive |
| 0.99666 | "two files required to stay byte-for-byte identical…" ↔ "'make the registry portable' rewrite must only emit npm-package: locators…" | false positive |
| 0.99745 | "Nesting agent git worktrees under the repo root…" ↔ (the `byte-for-byte` node above) | false positive |
| 0.99770 | "Parallel agent fan-out is conflict-free only when…" ↔ (the `worktrees` node above) | false positive |
| 0.99845 | "first publish of a new scoped package, registry CDN can 404…" ↔ (the `fan-out` node above) | false positive |

**The measured claim, which carries the recommendation on its own:** five demonstrably
different-fact pairs sit at **0.9916–0.9985** — the very top of the possible range. Raising
`NEARDUP_THRESHOLD` to 0.99, or 0.995, preserves four of these five merges. Lowering it merges
strictly more. There is no value above 0.95 that excludes them, because false positives are not
clustered near the threshold — they are clustered near 1.0.

*Secondary, weaker observation:* the probable-genuine duplicate is also the **lowest**-scoring pair
in the sample, which suggests the score ordering may be inverted with respect to ground truth. Do
not rest the argument on this — it depends on the 0.98798 pair being byte-identical beyond its
preview, which was not verified. The paragraph above stands without it.

**F4 — the false positives form a CASCADE CHAIN, not isolated pairs.**
`01KW28XPKKB75AJAAJZWTAHSZT` appears in rows 3 and 4; `01KW28YJC8YQ5PSYCNAZAXVYQG` in rows 4 and 5;
`01KW28YT5GTJH3YK0HFR4T3A77` in rows 5 and 6. These are consecutive ULIDs — one session's sequence of
distinct lessons, each write invalidating its predecessor. The failure mode is not "occasionally
merges a dupe"; it is **progressive erasure of a session's lesson set, retaining only the last
written item.** The 684 pairs are therefore an upper bound on distinct incidents and a *lower* bound
on severity.

**F5 — mechanism hypothesis (NOT measured, do not build on it).** The embedder is
bge-small-class with `maxTokens: 512` (`libs/data/embed/embedding-provider/src/fastembedModels.ts:28-42`,
`fastembed.ts:65,86`) and the embedded text is the episode `content`
(`libs/memory-core/src/write.ts:520`, `text: content`). Same-register, same-length, same-author
"lesson" prose plausibly saturates cosine in that space. **I did not measure token lengths of the
merged pairs.** The Q1 recommendation below rests on F3/F4 (direct measurement), not on F5.

**F6 — no un-invalidate path exists.** `rg` over `libs/memory-core/src` and `libs/data/graph` finds a
single `t_invalid = NULL` write, in an unrelated upsert (`libs/data/graph/graph-store/src/index.ts:2677`).
Q3 must therefore build the restore surface, not merely invoke one.

---

## 2. Q1 — Should an automatic pass be permitted to invalidate at all?

### Recommendation: NO. Remove invalidation from the automatic near-dup path entirely.

`applyNearDupResult` emits the `SAME_AS` edge (with cosine, model id, and pair status in meta) and
**stops**. `t_invalid` becomes reachable only from operations carrying user intent:
`memoryInvalidate` (`write.ts:786+`) and `memory_curate merge_duplicates`.

**Rationale**

1. **Destruction requires intent; an automatic pass has none.** A near-dup detector's correct output
   is a *candidate*, not a *verdict*. `SAME_AS` already carries the candidate and is already queried
   by `memory_near_duplicates` (`libs/memory-core/src/near-duplicates.ts`) and
   `memory_curate merge_duplicates`, so the human/agent review surface exists today and loses nothing.
2. **"Reason + SUPERSEDES edge" (the `NOTES.md:86` remedy) is insufficient on its own.** It makes the
   loss *auditable*, not *absent*. A false-positive pair still leaves `t_invalid` set, so the episode
   still drops out of every filtered recall the moment the pass runs. Observability does not restore
   a fact that no user chose to delete. (It is still required — see §2.1 — just not as the primary fix.)
3. **Cosine is not a sound basis for a destructive action.** A sentence-embedding cosine is a
   *retrieval-ranking* signal, calibrated for "would this be a useful result for that query", with no
   calibration whatsoever to *factual identity*. F3 is a direct measurement of that gap in this store:
   the semantically identical pair scores 0.988 and five semantically unrelated pairs score
   0.9916–0.9985. Identity is a propositional property; cosine measures distributional proximity in a
   512-token-truncated projection. They are different quantities, and this store demonstrates they can
   be *anti*-correlated over a working range.
4. **Asymmetric cost.** A missed merge costs one redundant row and a `SAME_AS` edge. A false merge
   costs a fact, silently, with `is_current: true` lying about it (Q2). The default must fail toward
   retention.

### THRESHOLD TUNING ALONE CANNOT FIX THIS — stated explicitly, and I agree.

Per F3, the measured false positives sit at 0.9916–0.9985 — at the ceiling of the score range, not
near the threshold. Raising `NEARDUP_THRESHOLD` to 0.99 preserves four of the five; raising it to
0.995 still preserves three. Lowering it merges strictly more. No value above 0.95 excludes them.
Threshold is a knob on a signal that does not measure the property being acted on; tuning it changes
volume, not correctness.

### Changes

**Q1-A (primary) — `libs/memory-core/src/enrich.ts`, `applyNearDupResult`**
- Delete the `if (nearDup.should_invalidate) { UPDATE … t_invalid … }` block (`enrich.ts:127-135`)
  and its `gcOrphanedCommunityState` call (that GC is correct *given* an invalidation; with no
  invalidation there is no orphaned community state to collect).
- Write the pair's evidence into the `SAME_AS` edge `meta` (currently hardcoded `NULL`,
  `enrich.ts:118-123`): `{ cosine, status: 'near_dup', model: <embed_model>, detected_at,
  detector: 'auto-neardup' }`. `libs/memory-core/src/near-duplicates.ts:103` already reads cosine
  from `edge.weight`; the meta is additive and must not break that read (BL-386 regression risk).
- **Guard:** `gcOrphanedCommunityState` remains exported and used by `memoryInvalidate` and
  `curateMergeDuplicates` — verify with `rg -n "gcOrphanedCommunityState"` before removing any import.

**Q1-B — `libs/memory-core/src/neardup.ts`: make the degenerate field honest (F1)**
Replace `should_invalidate` with `status: 'near_dup' | 'candidate'` on `NearDupResult`
(`neardup.ts:25-29,128`). Leaving a field named `should_invalidate` that is structurally always
`true` on a result that no longer invalidates is a trap for the next reader. Update the three
consumers: `enrich.ts:282`, `embed-pipeline.ts:490`, and the spec at
`neardup-bl381-dialect.spec.ts:103`.

**Q1-C — structural parent↔chunk exemption (defence in depth)**
Even with Q1-A, a parent and its own chunk should never be reported as a *duplicate* pair — they are
a whole and its part, related by `DERIVED_FROM` (written by `linkChunksToParent`,
`memory-server/src/index.ts:1637-1655`). In `detectNearDup` (`neardup.ts:105-118`), after resolving
`neighborId`, skip any neighbour connected to `rowid` by a live `DERIVED_FROM` edge in either
direction, and continue to the next-best pair. This is a *structural* fact about the pair, not a
score, so it is exactly the kind of predicate that belongs in the decision.
Keep this even though Q1-A removes the invalidation: it stops parent↔chunk pairs polluting the
`memory_near_duplicates` review queue and the Q3 triage set.

**Q1-D — option NOT taken, and why:** "keep invalidation but require reason + SUPERSEDES". Rejected
as the primary fix per rationale 2, but its *observability* half is retained: §2.1.

### 2.1 Retained from the rejected option — invalidation must never again be anonymous

Independent of Q1-A, add the invariant that **no code path may set `t_invalid` without writing
`meta.invalidatedReason` and `meta.invalidatedAt`.** The precedent exists and is correct:
`libs/data/graph/graph-store/src/index.ts:2131-2141` (`invalidateInTx`) already does this. The
asymmetry the brief identified is that `enrich.ts` bypasses `invalidateInTx` with raw SQL.

Enforce it with a repo-level test that greps the memory-core/graph-store source for
`t_invalid = ?`/`t_invalid=?` UPDATE statements and asserts every match is inside a function that
also writes `invalidatedReason`, with an explicit allowlist. This is the durable guard; if a future
change reintroduces an automatic invalidation, it will at least be attributable.

### Executor and test — Q1

**Executor:** `backend-developer` (TypeScript, memory-core internals), in an **isolated worktree**
under `.worktrees/` — mandatory, see §7.

**Red→green (Q1-A/Q1-B):** new `libs/memory-core/src/neardup-no-auto-invalidate.spec.ts`, named for
the BL id.
- Seed two episodes with hand-supplied embeddings at cosine ≥ 0.99 (the existing fixture pattern in
  `near-duplicates-bl386-cosine.spec.ts:34,102` calls `applyNearDupResult` directly with a synthetic
  `NearDupResult` — reuse it; do **not** depend on the real ONNX model).
- Assert after the pass: (a) the `SAME_AS` edge exists with `weight === cosine` **and** the new meta
  fields; (b) **both** nodes still have `t_invalid === null`; (c) both are returned by a
  `liveOnly` recall.
- **Red proof:** with the fix reverted (invalidation block restored), assertion (b) fails on the
  neighbour. The executor must *run* both directions and quote both outputs.

**Red→green (Q1-C):** `neardup-derived-from-exemption.spec.ts` — seed a parent and a chunk with a
`DERIVED_FROM` edge and cosine ≥ 0.99; assert `detectNearDup` returns `null` (or the next-best
non-derived neighbour). Red: without the exemption it returns the parent.

**Red→green (§2.1 guard):** `invalidation-always-has-reason.spec.ts` — source-scan test; red when
`enrich.ts`'s raw invalidation is restored.

---

## 3. Q2 — the `is_current: true` lie

### There are TWO bugs at `supersession-chain.ts:104`, not one.

1. **The one named in the brief.** `chain.find(n => n.t_invalid === null) ?? chain[chain.length - 1]`
   — when no `SUPERSEDES` edge exists, the BFS chain is `[self]`, so the `??` fallback returns the
   invalidated node itself and `is_current` (`:117`) is `self === self` → `true`.
2. **A second, independent bug.** `chain` is sorted **oldest-first** (`:97-101`, ascending
   `t_created`), so `chain.find(n => n.t_invalid === null)` returns the **oldest** live node. The
   comment at `:103` says "most recent non-invalidated node". Even on a well-formed multi-node chain
   with SUPERSEDES edges, the canonical is the wrong end whenever two or more members are live.

### Corrected semantics

```
is_current  := (the queried node's own t_invalid === null)      // independent of chain shape
canonical   := last live node in the oldest-first ordering      // i.e. most recent live
               ?? chain[chain.length - 1]                       // nothing live: most recent overall
```

`is_current` must be derived from the queried node's own validity, **not** from
`canonical.uid === uid`. That equality is a proxy that happens to coincide on well-formed chains and
fails exactly in the degenerate single-node case that this defect produces. Keeping `canonical_uid`
as "where to look instead" is correct and useful; conflating it with "am I live" is the bug.

Also add `t_invalid` transparency to the result: the chain links already carry it (`:107-112`), so a
caller can self-serve — but the top-level `is_current` is what agents read.

**BL-505 tie-break must be preserved** (`:93-101` and `extensions.spec.ts:237-270`): ties on
`t_created` break by `rowid` ascending. The "last live in ordering" selection must use the same
comparator, not a separate `reduce` over `t_created`.

### Callers — found, not assumed

`rg -n "memoryGetSupersessionChain|is_current|canonical_uid"` over `libs/` and `extensions/`
(excluding `dist/`, `node_modules/`, `docs/`):

| Site | Nature | Impact of the change |
|---|---|---|
| `libs/memory-core/src/supersession-chain.ts:33,104,115,117` | the implementation | the change itself |
| `libs/memory-core/src/index.ts:398` | re-export | none |
| `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts:61,2326` | MCP tool handler — **pure passthrough**, `JSON.stringify(result)`; no field is read or branched on | none; response shape unchanged |
| `libs/memory-core/src/extensions.spec.ts:219-235` | asserts `canonical_uid === uidA` and `typeof is_current === 'boolean'` on a live, edge-free node | must stay green: live + edge-free → `is_current: true`, `canonical === self`. Unchanged. |
| `libs/memory-core/src/extensions.spec.ts:237-285` (BL-505) | asserts `canonical_uid === 'uid-a'` and `is_current === false` for a query on `uid-b` | **COLLIDES — resolved below (§3.1). Both assertions change.** |
| `extensions/bundles/sox-memory-bundle/members/memory-server/src/memory-tools.spec.ts:563-565` | type-shape only (`typeof … === 'string'/'boolean'`) | none |
| `extensions/.../memory-server/CLAUDE.md:367`, `libs/memory-core/README.md:240-245` | docs of the output shape | update the semantics prose |

**No production consumer branches on `is_current`.** The only behavioral dependents are the two spec
files. This is a low-blast-radius change — the damage is entirely in what agents *read*, which is
precisely why it has gone unnoticed.

### 3.1 The BL-505 fixture collides — read, resolved, and the executor is told exactly what changes

I read `extensions.spec.ts:237-285`. The fixture's own comment is explicit: *"Two live nodes with
IDENTICAL `t_created`, linked B→A (src=2, dst=1 — **B supersedes A**)"*. Neither node has `t_invalid`
set. It then asserts, for a query on `uid-b`:

```ts
expect(r1.canonical_uid).toBe('uid-a');              // :264
expect(r1.chain.map(l => l.uid)).toEqual(['uid-a','uid-b']);
expect(r1.is_current).toBe(false);                   // :267  — comment: "uid-b is superseded"
```

**Both pinned values are semantically backwards, and the fixture's own comment shows it.** `uid-b`
*supersedes* `uid-a` (the edge runs src=uid-b → dst=uid-a). The superseder is the current node. Yet
the test asserts the superseded node is canonical and that the superseder is "superseded". The
`:267` comment ("uid-b is superseded — it is NOT the canonical node") inverts the edge direction it
sits three lines below.

This is not a flaw in BL-505's fix. **BL-505's actual invariant is engine-determinism** — its title
is "t_created ties are broken by rowid — *identical* canonical_uid on sqlite and turso", and its
body runs the same seed and assertions against both engines. It pinned whatever the then-current
comparator produced, in order to freeze it identically across backends. It did not adjudicate which
node *ought* to be canonical.

**Instruction to the executor — do not "preserve" these two assertions:**
- Under the corrected semantics, the oldest-first ordering is `[uid-a, uid-b]` (tie broken by rowid,
  unchanged), the last **live** node in that ordering is `uid-b`, and the queried node `uid-b` has
  `t_invalid === null`. So: `canonical_uid === 'uid-b'` and `is_current === true`.
- Change `:264` to `'uid-b'` and `:267` to `true`, keep `:265` (`['uid-a','uid-b']`) and `:268-270`
  (idempotency) **unchanged**, and keep both engine legs and the `r2 === r1` check **unchanged** —
  those are BL-505's real invariant and they must stay green on both sqlite and turso.
- Record the rationale in the commit and in a comment replacing the inverted one at `:266`: *the
  superseder is canonical; the previous expectation pinned a comparator artefact, not a semantic.*
- **This is a behavioural change to a test named for a BL id** — per the repo's resolution rule it
  requires its own red→green demonstration and its own citation. It must not be edited silently to
  make a suite go green.

**Separate but adjacent — do not conflate:** `isSuperseded` (`libs/memory-core/src/recall.ts:1520-1526`)
counts inbound `SUPERSEDES` edges and is consumed at `entity-episodes.ts:184`, `related.ts:70`,
`memory-server/src/index.ts:1951,2020`. It returns `false` for auto-invalidated nodes for the same
root cause (no edge is emitted). Under Q1-A no automatic invalidation occurs, so it becomes correct
by construction. **Do not** widen `isSuperseded` to mean "invalid" — those are different predicates
and `graph-store`'s `NodeFilter.isSuperseded` (`node-filter-is-superseded.spec.ts:56-90`) depends on
the narrow meaning.

### Executor and test — Q2

**Executor:** `backend-developer`, same worktree as Q1 (both touch memory-core; `depends_on` Q1 to
avoid a shared-file race — Q2 touches only `supersession-chain.ts`, so it may run in parallel if the
dispatcher declares disjoint file sets).

**Red→green:** `libs/memory-core/src/supersession-chain-is-current.spec.ts`
- **Case A (the reported lie):** insert one episode, set `t_invalid` directly, no edges. Assert
  `is_current === false`. **Red:** current code returns `true`.
- **Case B (the second bug):** chain of three with SUPERSEDES edges where the *oldest two* are live.
  Assert `canonical_uid` is the **newer** live node. **Red:** current code returns the oldest.
- **Case C (regression):** live, edge-free node → `is_current: true`, `canonical === self`.
- **Case D (the superseder is canonical):** two live nodes, B SUPERSEDES A, query B → `canonical_uid`
  is B and `is_current === true`. **Red:** current code returns A / `false`. This is the same scenario
  as the BL-505 fixture; per §3.1 that fixture's `:264`/`:267` are updated, while its ordering,
  idempotency, and dual-engine legs stay untouched and must remain green.

---

## 4. Q3 — remediation of the 684

### 4.0 BACKUP FIRST — this is step zero and it is not `cp`

The memory server is a **live, long-running process** and the store is **WAL**. `cp memory.db`
produces a torn snapshot (this exact hazard is why `SPEC-BUG-MEMORY-002+004.md §0` copied both
`memory.db` and `-wal`, and BL-342's bad restore wrote `tags = ''`). Use SQLite's own atomic
snapshot, which is consistent against concurrent writers:

```
mkdir -p ~/.memory/backups
sqlite3 ~/.memory/memory.db ".backup '$HOME/.memory/backups/pre-neardup-remediation-$(date +%Y%m%dT%H%M%SZ).db'"
# or: sqlite3 ~/.memory/memory.db "VACUUM INTO '<path>'"
```

Then **verify the copy before touching anything**:

```
sqlite3 <backup> "PRAGMA integrity_check;"                       # must print: ok
sqlite3 <backup> "SELECT COUNT(*) FROM node;  SELECT COUNT(*) FROM edge;"
sqlite3 <backup> "SELECT COUNT(*) FROM node WHERE t_invalid IS NOT NULL;"
```
Record all four numbers in the remediation record. A remediation that cannot quote its
`integrity_check: ok` and its pre-counts is not authorised to proceed.

**All triage runs against the backup copy, never the live file.**

### 4.1 Can the wrongly-invalidated nodes be restored?

Yes, mechanically: rows are intact, only `t_invalid` is set (F6 confirms no code ever clears it, so
nothing will race a restore). The constraint is *deciding which*, and doing it reversibly.

### 4.2 Distinguishing true duplicates from false positives at scale

**Cosine cannot be the discriminator** — that is Q1's entire finding (F3: the inversion). Use a
**lexical** measure computed on `node.content`, which measures the property actually at issue
(is this the same text?) rather than a projection of it:

- `jaccard` = normalized token-set Jaccard (lowercase, strip punctuation, drop stopwords).
- `lcs_ratio` = normalized longest-common-subsequence / diff ratio.
- `len_ratio` = `min(len_a, len_b) / max(len_a, len_b)`.

Calibration anchors from measured data: the genuine duplicate in F3 has *identical* 120-char previews
(Jaccard ≈ 1.0); the false positives share almost no content tokens (Jaccard ≈ 0.1–0.3) despite
cosine 0.99+. The existing "differs by one char" fixture (`write.spec.ts:635`) is the intended true
positive and also sits at Jaccard ≈ 1.0. The classes separate cleanly on the lexical axis and not at
all on the cosine axis.

**Triage buckets (computed on the backup, emitted as a CSV/JSON report for human review):**

| bucket | rule | action |
|---|---|---|
| **B1 structural** | pair connected by a live `DERIVED_FROM` edge (parent↔own chunk) | **auto-restore.** Never a duplicate by construction. |
| **B2 true dup** | `jaccard >= 0.95` **and** `len_ratio >= 0.9` | leave invalidated; keep `SAME_AS` |
| **B3 false positive** | `jaccard < 0.7` | **restore** |
| **B4 ambiguous** | everything else | **restore** (see default-to-restore below), flagged in the report for eyeball review |

**Default to restore on anything not provably B1/B2.** The costs are asymmetric: restoring a true
duplicate costs one redundant row, discoverable and re-mergeable via its retained `SAME_AS` edge;
leaving a false positive invalidated loses a fact nobody chose to delete, and per F4 possibly an
entire session's chain of them. **Retain every `SAME_AS` edge regardless of bucket** so pairs stay
reviewable via `memory_near_duplicates` afterwards.

**Age is NOT a tiebreaker — anywhere.** Per F2, the heal paths can invalidate the *newer* node, so
"restore the older one" is unsound and any procedure containing that phrase must be rejected in
review.

**Cascade handling (F4).** Triage must operate on connected **components** of the `SAME_AS` graph,
not on isolated pairs, because a single node participates in multiple pairs. Restoring the middle of
a chain while leaving its neighbours invalidated produces an arbitrary survivor set. Compute
components first, bucket per-component, and report component size — a component of size > 2 is
strong prima facie evidence of the cascade failure mode and should default to full restore.

### 4.3 The restore surface — a `memory_curate` op, not an external SQL script

Implement `memory_curate op: 'restore_neardup'` (name it after the BL id in the schema description),
alongside the existing `unpoison` / `drop_lens` / `merge_duplicates` ops
(`libs/memory-core/src/curate.ts`). Reasons this beats a standalone sqlite script:

- routes through the server's `WriteQueue`, so it cannot corrupt a live store or race the enrich tick;
- `dry_run: true` already exists in the curate contract and gives a free, mandatory preview;
- restoration is *recorded* — each restored node gets
  `meta.restoredFrom = { op, bl_id, at, prior_t_invalid, pair_uid, bucket, jaccard }`, which makes the
  action itself reversible (re-invalidating is `UPDATE … t_invalid = meta.prior_t_invalid`) and
  auditable;
- it is testable by the repo's own red→green standard, which an ad-hoc script is not.

Clearing `t_invalid` must also re-establish derived state the invalidation tore down: the
`gcOrphanedCommunityState` call at `enrich.ts:134` ran at merge time. The restore op must either
re-enqueue clustering for restored nodes or explicitly document that community membership is
recomputed on the next periodic enrich tick. **Verify which before shipping** — a restored node that
is live but community-orphaned is a half-fix.

### 4.4 Procedure (ordered, each step gated)

1. **Backup + verify** (§4.0). Quote `integrity_check` and the four counts.
2. **Freeze the source of new casualties.** Ship Q1 first. Remediating before Q1 lands means the
   pipeline re-invalidates restored nodes on the next heal tick (F2 — heal re-embeds, and heal
   reaches the same near-dup pass). **This ordering is non-negotiable.**
3. **Triage report on the backup copy.** Read-only. Emit per-component buckets + metrics. Human
   reviews the B4 list and the components of size > 2.
4. **`dry_run: true`** against the live store. Diff its proposed set against the report from step 3;
   any divergence means new pairs arrived after the backup — stop and re-run step 3.
5. **Apply in batches** (e.g. 50 components), re-verifying counts between batches:
   `SELECT COUNT(*) FROM node WHERE t_invalid IS NOT NULL` must fall by exactly the expected delta.
6. **Post-verify:** re-run `memory_near_duplicates(threshold: 0.95)` — `total` should be unchanged
   (edges retained) while `already_merged` count falls by the restored count. Spot-check
   `memory_supersession_chain` on restored uids → `is_current: true` and now *truthfully* so (Q2
   must be shipped for this check to mean anything).
7. **Record** the batch ids, counts, and backup path in `docs/reporting/memory/findings/`.

### Executor and test — Q3

**Executor:** `backend-developer` for the curate op; the triage/apply run itself must be executed by
a **human-supervised session with explicit approval** — this is production data, and no subagent
should apply it unattended.

**Red→green:** `libs/memory-core/src/curate-restore-neardup.spec.ts`
- Seed a store with (a) a B1 parent↔chunk pair, (b) a B2 byte-identical pair, (c) a B3 pair with
  cosine 0.99 and Jaccard 0.15, all with the older node `t_invalid` set.
- Assert `dry_run` proposes exactly {a, c} and not {b}; assert after apply that a and c are live with
  `meta.restoredFrom` populated, b untouched, and all three `SAME_AS` edges still present.
- **Red:** the op does not exist → the spec fails to resolve it. Once written, the meaningful red is
  bucket mis-assignment: temporarily swap the discriminator to cosine and assert the spec fails (this
  is the test that proves the *lexical* discriminator is load-bearing, not decoration).

---

## 5. Q4 — `memory_entity_episodes` count contract

### Recommendation: filter the edge set BEFORE slicing. Filtering `total` alone is a half-fix.

The bug is not only that the two numbers disagree. **Pagination slices the raw, unfiltered edge
array** (`entity-episodes.ts:126`, `edges.slice(offset, offset + limit)`) and the validity predicate
is applied afterwards at `:162` (`AND t_invalid IS NULL`). So:

- merely changing `total` to a filtered count (`:123`) leaves pages walking the *unfiltered* offsets;
- pages come back **short** (a page of 20 containing 3 invalid edges yields 17 episodes) and a caller
  paging by `offset += limit` cannot tell a short page from the end of the list;
- the offsets themselves shift meaning depending on where invalid rows fall.

**The change:** resolve the MENTIONS edges' source nodes' validity *first*, producing one live-filtered
edge list; derive `total` from it, and slice *it* for the page. Concretely — replace the
`getEdges` → `slice` → `IN (...)` sequence (`:122-168`) with a single SQL join that filters and
paginates in the database:

```sql
SELECT n.rowid, n.uid, n.content, n.summary, n.topic, n.tags, n.project_path,
       n.importance, n.t_created, n.agent_id
  FROM edge e JOIN node n ON n.rowid = e.src
 WHERE e.dst = ? AND e.rel = 'MENTIONS' AND e.t_expired IS NULL
   AND n.kind = 'episode' AND n.t_invalid IS NULL
 ORDER BY n.importance DESC, n.rowid ASC
 LIMIT ? OFFSET ?
```
plus a matching `COUNT(*)` for `total`. This also fixes a second latent defect: the tool's own
description promises results **"ranked by importance"**
(`memory-server/src/index.ts:755`), but the current code paginates in raw `getEdges` row order — which
has no `ORDER BY` (the same class of non-determinism BL-505 fixed in `supersession-chain`). The
executor must confirm the intended ordering against the tool description before pinning it in a test.

**Also surface `invalidated_count`** — optional observability, not the fix. Once `total` and the page
derive from one live set, `invalidated_count` (live MENTIONS edges whose source node is invalid) is a
useful diagnostic and costs one extra `COUNT(*)`. It answers "did my write get auto-merged?" directly.
Under Q1-A this number should trend to zero, which makes it a *useful standing alarm*: a rising
`invalidated_count` after Q1 ships means some other path is invalidating.

### Consumers that paginate on `total` — searched, none found

- `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts:2305-2310` — the MCP
  handler is a **pure passthrough** (`JSON.stringify(result)`); it neither reads `total` nor loops.
- `rg -n "offset.*total|total.*offset"` over `extensions/` and `libs/` (excluding `dist/`) → **zero
  hits**. No in-repo code paginates on this field.
- `libs/memory-core/src/extensions.spec.ts` — the only test-side consumer.
- Documentation only: `extensions/.../memory-server/CLAUDE.md`, `.../memory-usage/SKILL.md:119-124`,
  `libs/memory-core/README.md`, `~/.claude/skills/memory-usage/SKILL.md` (mentions the tool, no
  pagination recipe).

**Therefore the contract change is safe** — the only consumers are agents reading the JSON, and for
them the *current* contract is actively harmful (the brief's exact scenario: nonzero `total`, own
episode missing, concluding the write was lost). State this evidence in the BL item so the executor
does not re-litigate backward compatibility.

### Executor and test — Q4

**Executor:** `backend-developer`. `entity-episodes.ts` is disjoint from Q1/Q2/Q3 files, so this may
run fully in parallel.

**Red→green:** `libs/memory-core/src/entity-episodes-count-contract.spec.ts`
- Seed one entity with 5 MENTIONS edges; invalidate 2 of the source episodes.
- **Case A:** default call → `total === 3` **and** `episodes.length === 3`. **Red:** current code
  returns `total: 5, episodes.length: 3`.
- **Case B (the half-fix detector):** `limit: 2, offset: 0` then `limit: 2, offset: 2` → pages of
  exactly 2 then 1, together covering all 3 live uids with no duplicates and no gaps. **Red:** with
  only `total` filtered, page 1 returns fewer than 2 when an invalid edge falls in the first two
  slots. This is the assertion that proves the fix is the *pre-slice* filter, not a count patch.
- **Case C:** `invalidated_count === 2`.
- **Case D:** ordering — assert the documented `importance DESC` order is stable across two calls.

---

## 6. Backlog items to FILE (named here, not filed — this task is capped at one file)

Dedupe first per the `backlog` skill: search by `applyNearDupResult`, `NEARDUP_THRESHOLD`,
`is_current`, `entity-episodes`, and the string `t_invalid` before filing any of these. `NOTES.md:56-86`
and `SPEC-BUG-MEMORY-002+004.md` may already correspond to an existing item — if so, **enrich it**
rather than filing anew.

| # | Item | Priority |
|---|---|---|
| 1 | Automatic near-dup pass must not invalidate; emit `SAME_AS` only (Q1-A) | CRITICAL — active data loss |
| 2 | `should_invalidate` is structurally always `true` — no policy gate exists (F1, Q1-B) | HIGH |
| 3 | Near-dup invalidation target is not age-checked; heal paths can invalidate the NEWER node (F2) | HIGH |
| 4 | Parent↔own-chunk pairs are not structurally exempt from near-dup (Q1-C) | HIGH |
| 5 | `supersession_chain` reports invalidated nodes as `is_current: true` (Q2 bug 1) | HIGH |
| 6 | `supersession_chain` canonical selects the OLDEST live node, contradicting its own comment; BL-505's fixture pins the superseded node as canonical (Q2 bug 2, §3.1) | MEDIUM |
| 7 | No invariant forbids anonymous `t_invalid` writes (§2.1) | MEDIUM |
| 8 | Remediate 684 auto-merged pairs; add `memory_curate restore_neardup` (Q3) | CRITICAL — depends on #1 |
| 9 | `memory_entity_episodes` `total` counts invalid edges and pagination slices unfiltered (Q4) | HIGH |
| 10 | `memory_entity_episodes` promises importance ranking, paginates in unordered edge order (Q4, latent) | MEDIUM |

Every item must carry a `Citations:` block per the disclosure protocol, using the file:line
references in §1.

---

## 7. Sequencing, executors, and the repo gates that will bite

**Order is load-bearing:** Q1 must land before Q3. Remediating first means the heal tick re-invalidates
restored nodes (F2).

| # | Change | Executor | Parallel with | Gate |
|---|---|---|---|---|
| 1 | Q1-A + Q1-B + Q1-C (`enrich.ts`, `neardup.ts`) | backend-developer | — | `neardup-no-auto-invalidate.spec.ts`, `neardup-derived-from-exemption.spec.ts` |
| 2 | Q2 (`supersession-chain.ts`) | backend-developer | #1 (disjoint files) | `supersession-chain-is-current.spec.ts` + BL-505 regression |
| 3 | Q4 (`entity-episodes.ts`) | backend-developer | #1, #2 (disjoint files) | `entity-episodes-count-contract.spec.ts` |
| 4 | §2.1 anonymous-invalidation guard | backend-developer | after #1 | `invalidation-always-has-reason.spec.ts` |
| 5 | Q3 curate op + triage tooling | backend-developer | **after #1 merged** | `curate-restore-neardup.spec.ts` |
| 6 | Q3 production remediation run | **human-supervised session** | **after #1, #2, #5 deployed** | §4.4 step gates; backup verified first |
| 7 | Docs: `memory-server/CLAUDE.md:367,480`, `libs/memory-core/README.md:240-245`, `memory-usage/SKILL.md` | technical-writer | after #1–#4 | prose review |

### Gates the executor WILL trip if not warned

- **`nx test` is a build (BL-456).** `nx.json` sets `targetDefaults.test.dependsOn = ["^build"]`, so
  every red→green run above rebuilds upstream `dist/` from whatever is on disk — including another
  agent's uncommitted edits. Every test result in this plan must be quoted **alongside**
  `node tools/check-suite-tree-state.mjs --project memory-server` output. A green run without that
  is unattributable and does not satisfy the red→green rule.
- **Builds are destructive (BL-235).** `rm -rf dist` precedes several targets, and `--dry-run` is
  silently ignored. Every executor works in an **isolated worktree under `.worktrees/`**, not the
  shared checkout. The live memory server runs directly out of this worktree
  (`libs/host-runtime/src/loader.ts:491`) — a build here changes production immediately.
- **A revert is not finished until you rebuild.** If Q1 is rolled back, `dist/` still contains the
  invalidating code and will keep invalidating (BUG-028 precedent).
- **Commit by pathspec** (`git commit <path> -m …`), never `git add -A`. Use
  `node tools/commit-mine.mjs --dry-run` for contended files.
- **`registry:sync-index`** after any rebuild of a shipped bundle, committed with the source.
- **Never mark any of §6 resolved without a red→green run** — items 1, 5, 8, 9 are precisely the
  shape of defect that has shipped RESOLVED-while-broken before (BL-88, BL-95, BL-115, BL-167).

---

## 8. Risks

**Q3 remediation (highest risk — production data)**
- **Restoring true duplicates.** Accepted by design; mitigated by retaining `SAME_AS` edges so they
  remain re-mergeable via `merge_duplicates`, and by `meta.restoredFrom` making each restore reversible.
- **Backup is torn.** Mitigated by `.backup`/`VACUUM INTO` (never `cp`) plus `PRAGMA integrity_check`
  and count verification before proceeding. BL-342's `tags = ''` restore is the precedent for what a
  bad restore costs.
- **Re-invalidation after restore.** If Q1 is not deployed *and the running process restarted onto
  the new artifact*, the heal tick re-merges everything. Mitigation: verify the live server's reported
  artifact hash matches the rebuilt file before remediating — process liveness is not verification.
- **Community/cluster state left orphaned.** `gcOrphanedCommunityState` ran at merge time; restoring
  `t_invalid` does not undo it. Must be explicitly handled or documented (§4.3).
- **Cascade components (F4).** Restoring part of a chain produces an arbitrary survivor set. Mitigated
  by component-wise triage.
- **The 684 is a lower bound.** It counts pairs above 0.95 *with live `SAME_AS` edges*. Nodes
  invalidated by paths whose edge was later expired, or by pairs whose edges were pruned, are not in
  the set and are **not recoverable by this procedure**. State this limit in the remediation record
  rather than claiming completeness.

**Q1**
- Removing auto-invalidation grows the live node count and the duplicate rate in recall. This is the
  intended trade (retention over silent deletion) but should be watched via
  `memory_near_duplicates` total.
- `enrich.ts` is shared by the sync (`enrich.ts:282`) and async (`embed-pipeline.ts:490`) paths and by
  `SOX_SYNC_EMBED=1`; the test must exercise at least the async path, which is the default.
- BL-386's cosine read from `edge.weight` (`near-duplicates.ts:103`) must not regress when meta is
  added — `near-duplicates-bl386-cosine.spec.ts` must stay green.

**Q2**
- `extensions.spec.ts:237-285` (BL-505) will go red on two assertions, by design (§3.1). The risk is
  an executor "fixing" it by weakening the corrected semantics instead, or by editing the fixture
  silently. The dual-engine legs and the idempotency check are the real BL-505 invariant and must
  stay green untouched; only `:264` and `:267` move, with a documented rationale.
- The `:266` comment currently asserts an edge direction opposite to the edge in its own seed. A
  reviewer reading the comment rather than the SQL will object to the change; §3.1 pre-empts this.

**Q4**
- Moving pagination into SQL changes result *ordering* from unordered edge order to an explicit
  `ORDER BY`. Agents that cached uid sets from previous calls will see different pages. Acceptable
  (the old order was non-deterministic across backends), but pin it in a test.

---

## 9. Out of scope, observed

- Chunk `topic`/`tags`/`project_path` inheritance — owned by the second debugger (dependency stated in
  the preamble).
- `memory_near_duplicates` has no `uid` filter, so "was my episode auto-merged?" requires a scan.
  `SPEC-BUG-MEMORY-002+004.md §2` explicitly ruled adding one out of scope. Under Q4, entity-episodes'
  `invalidated_count` partially answers the same question; revisit only if that proves insufficient.
- `NEARDUP_THRESHOLD` remains 0.95 and is deliberately **not** tuned (§2). Do not let a reviewer
  "simplify" this plan into a threshold bump.
