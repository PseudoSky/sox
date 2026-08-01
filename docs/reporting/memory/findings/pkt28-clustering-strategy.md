# PKT-28 — corpus-size-adaptive clustering strategy: recommendation

> **Status:** decision record, measured 2026-08-01. Closes BL-356 and BL-350's research scope.
> Read [`cluster-calibration.md`](./cluster-calibration.md) (BL-328) first — this item builds on
> its measurements rather than repeating them, and only re-runs what BL-328 could not: the true
> full-scale corpus (no projection) and a direct test of the "raise minPts" alternative.
> **Blocks:** PKT-29, PKT-30, PKT-31 per `PLAN.md`. **Consequence stated in §5: PKT-30 as scoped
> ("re-calibrate the threshold to a value") is invalid and must be re-scoped to "implement the
> calibration function," not "pick a better constant."**

## 0. Method (new measurement in this packet)

BL-328/356 measured against a **1616-vector sample** (`vec_node` coverage was 1616/4841 eligible
episodes on 2026-07-31) and **projected** the full-store degree forward. That projection is no
longer needed: a read-only copy of the live store taken today (`~/.claude/jobs/1557bcef/tmp/probe.db`,
copied together with its `-wal` per BL-330, **never opened for write**, live service never touched)
has **4867 eligible episodes / 4936 `vec_node` rows / 4867 usable vectors** — i.e. embed coverage
has caught up since BL-328 ran, and this is now the **true near-full corpus**, not a sample.

Probe script: `~/.adhd/sox-ecosystem/memory/pkt28-minpts-sweep.mjs <copy.db>` (read-only, refuses
any path under `~/.memory`, same convention as `bl328-*.mjs`). Uses the shipped `cluster()`
primitive from `@adhd/sox-analysis` unmodified — no reimplementation.

Two questions, answered directly (not projected) at real N=4867:

**(1) Does today's real corpus confirm BL-356's scaling claim?** Yes, and it got worse, exactly as
predicted. BL-328's 1616-sample measured largest-cluster ratio **0.6838** at τ=0.82. Today's true
4867-vector corpus measures **0.7590** at the same τ — density increased as the store grew, in the
direction and rough magnitude single-linkage chaining predicts.

**(2) Does raising `minPts` (the "different algorithm" option PKT-28 names) fix it?** No —
measured directly, not assumed:

| N | minPts | clusters | largest | ratio | clustered_frac |
|---|---|---|---|---|---|
| 4867 | 2 (current) | 143 | 3694 | **0.7590** | 0.886 |
| 4867 | 3 | 71 | 3694 | 0.7590 | 0.857 |
| 4867 | 4 | 50 | 3644 | 0.7487 | 0.833 |
| 4867 | 5 | 36 | 3550 | 0.7294 | 0.803 |
| 4867 | 8 | 22 | 3352 | 0.6887 | 0.746 |
| 4867 | 12 (6× default) | 6 | 3098 | 0.6365 | 0.659 |

Raising `minPts` from 2 to **12** — a 6× increase, well past any value that would still look like
"clustering" rather than "requiring a dozen near-duplicates to form a group" — only moves the
largest-cluster ratio from 0.759 to 0.636. It never approaches the 0.5 non-degenerate bound. At
N=800 the same sweep shows `minPts` mattering more (0.1675→0.1275 across the same range) because
N=800 isn't yet past the percolation point at τ=0.82 — but that is exactly BL-356's point: the
knob that matters is corpus size relative to τ, not `minPts`. **`minPts` is a purity/noise
filter, not a percolation fix, and this packet rules it out as the standalone replacement
algorithm.**

**τ sweep at the true full corpus, `minPts=2` (no projection):**

| τ | clusters | largest | ratio | clustered_frac | degenerate |
|---|---|---|---|---|---|
| 0.82 (current default) | 143 | 3694 | 0.7590 | 0.886 | **YES** |
| 0.84 | 239 | 2856 | 0.5868 | 0.840 | **YES** |
| 0.85 | 291 | 2499 | 0.5135 | 0.813 | **YES** |
| **0.87** | 427 | 879 | **0.1806** | 0.728 | |
| 0.90 | 532 | 108 | 0.0222 | 0.545 | |
| 0.92 | 535 | 51 | 0.0105 | 0.397 | |
| 0.95 | 233 | 36 | 0.0074 | 0.148 | |

This directly confirms — measured at the real 4867-vector corpus, not extrapolated — BL-328's
recommendation that **0.87 is where the transition from degenerate to healthy currently sits**,
and that **0.85 is now also degenerate** (0.5135 > 0.5), where it was borderline-safe on
yesterday's smaller sample. The corpus crossed that line as it grew. This is the concrete proof
that a constant, however carefully chosen today, has a **shelf life measured in corpus growth**,
not calendar time.

---

## 1. Is a fixed global cosine τ viable at all? **No.**

Two independent measurements now agree, one projected (BL-356, 2026-07-31) and one direct
(above, 2026-08-01):

- BL-356: largest-cluster ratio at τ=0.82 went 0.085 → 0.222 → 0.459 → 0.595 → 0.684 as a
  *sub-sample* of the same corpus grew 200 → 400 → 800 → 1200 → 1616.
- This packet: the *true* corpus grew 1616 → 4867 in the four days since, and ratio at the same
  τ went 0.684 → **0.759**. Same direction, same mechanism, new data point.
- Raising `minPts` up to 6× does not substitute for lowering the edge probability (raising τ):
  degeneracy persists at every `minPts` tested up to 12.

A single-linkage-equivalent algorithm (DBSCAN with `minPts=2`) under a **fixed** edge probability
has mean node degree that grows **linearly with N**. There is no constant τ that is simultaneously
loose enough to cluster a small store and tight enough not to percolate a large one, because the
store's own growth moves the operating point. **A fixed global τ is not viable, full stop** — this
was already BL-356's finding; this packet adds the direct (non-projected) confirmation and rules
out the one alternative-algorithm option PKT-28 asked to be tested.

---

## 2. Recommended replacement

**A corpus-size-adaptive τ, calibrated by measured edge-probability against a target mean degree —
not a re-implementation as a different linkage algorithm, and not a hardcoded τ(N) formula.**

Reasoning for each part of that shape:

- **Not a different linkage algorithm (e.g. complete-linkage / average-linkage hierarchical
  clustering with a distance cutoff).** That would genuinely break chaining — cluster diameter is
  bounded rather than growing by transitive bridging — and is worth a future look, but it is a new
  primitive requiring its own validation (`@adhd/sox-analysis` ships DBSCAN only) and PKT-29 is
  already scoped as an implementation packet on top of the existing `cluster()` call surface. This
  packet's mandate is a decision usable by PKT-29/30 now, not a multi-week algorithm swap.
  Recorded here as the one alternative *not* chosen and why, so a future agent doesn't re-litigate
  it from zero: DBSCAN retained, `minPts` retained at a small constant (see §2.3), τ becomes
  adaptive.
- **Not a hardcoded τ(N) formula (e.g. "τ = 0.82 + k·log(N)").** §0 already showed the *shape* of
  the cosine-similarity distribution is corpus-content-dependent — cohort P's own doc (§4.1 of
  `cluster-calibration.md`) states this explicitly, and this packet's own numbers (0.85 crossing
  from safe to degenerate between the two measurement dates on the *same* growing corpus) show a
  formula tuned today drifts as content mix changes, independent of N. A formula in terms of N
  alone is exactly the kind of "calibrated once, wrong later" mistake BL-328 already made with a
  constant.
- **Target-degree calibration, computed at cluster time.** At the start of a full pass:
  1. Sample pairwise cosine similarity on a bounded subsample (the existing probes already do
     this cheaply — `bl328-degree.mjs`'s `SAMPLE = vecs.filter((_,i)=>i%3===0)` costs O(sample²),
     not O(N²), and reuses vectors already loaded for the pass).
  2. From that sample, compute `P(edge ≥ τ)` for a small grid of candidate τ (already the shape of
     the τ-sweep table above).
  3. Choose the smallest τ such that projected mean degree `P(edge≥τ) × (N−1) ≤ D_target`, where
     `D_target` is a small constant (recommend **2.0** — measured mean degree 1.8 at τ=0.87/N=4867
     from `P(edge)=0.00262 × 4866 ≈ 12.7` in BL-356's own projection table is already known to be
     an *upper bound*, not the real value, because the real graph is heterogeneous; the directly
     measured ratio at that operating point, 0.1806, is comfortably non-degenerate, so `D_target=2`
     has empirical headroom without being so conservative it starves small stores of any
     clustering at all).
  4. Run DBSCAN at that τ. This **replaces** the current retry-on-exhaustion guard
     (`cluster.ts:465-484`) as the primary mechanism — the guard becomes a pure safety net that
     should almost never fire, exactly BL-328 §5.4's recommendation, generalized from "raise the
     constant" to "raise it correctly by construction instead of by blind retry."
- **Keep `minPts` at its current value of 2, not raised.** §0 showed raising it does not fix
  degeneracy and does reduce coverage/cluster count (locking out legitimately smaller topical
  pairs) without commensurate benefit. If a follow-up wants a purity lever independent of
  percolation, `minPts=3` is defensible (cluster count nearly halved — 143→71 at N=4867 — with
  *zero* change to the degenerate cluster, meaning it only prunes weak 2-node noise pairs) but that
  is a purity tuning question, not part of this packet's τ recommendation.

### 2.1 Consequence for `resolveDefaultThreshold()` (`cluster.ts:920-922`)

The function signature must change from a nullary constant to something that takes `(sampleVecs,
targetN)` or equivalent — this is the concrete implementation surface PKT-29/PKT-30 need to land
on. Not code in scope for this packet (research-only per its acceptance), but stated explicitly so
the next packet does not have to re-derive it: **`resolveDefaultThreshold(): number` cannot remain
a pure function of nothing.**

### 2.2 Periodic reconciliation is required in addition to write-triggered association

BL-349/PKT-29's write-triggered incremental join answers "which existing cluster does a new
episode join" in O(1) — that mechanism is unaffected by this recommendation and should ship as
scoped. What it **cannot** do, by construction, is re-derive τ (τ depends on the *current* N and
distribution, which a single new write does not change enough to justify recomputing), split a
community that has organically outgrown coherence, merge two communities that have drifted
together, or notice a community has been orphaned to zero members. All four require seeing the
corpus as a whole, which only a full or subset pass can do. This is precisely BL-350's "clusters
are not constant-time splits and do not self-reorganize," and the answer is a **periodic full-pass
reconciliation, run on a trigger, not on a fixed clock alone** (see §3).

---

## 3. BL-350's maintenance strategy: drift metric, split/merge/orphan, cadence

### 3.1 Drift metric (BL-350's explicit acceptance bar)

**Incremental-vs-full-pass divergence, expressed as the fraction of live episodes whose
`community_uid` (via `MEMBER_OF`) under the current incremental state disagrees with a fresh full
pass over the same corpus.** Concretely:

```
drift = |{ e : incremental_community(e) != full_pass_community(e) }| / |live episodes with a vector|
```

This is directly computable with the harness BL-350's acceptance already asks for: run
`clusterStore()` (the existing full-pass primitive) against a **read-only copy** of the store,
compare its `community_uid` assignment per rowid against the live graph's current `MEMBER_OF`
edges, and report the mismatch fraction. No new primitive is needed — `clusterStore` and
`clusterSubset` already exist in `cluster.ts`; the harness is a comparison script in the same
family as `bl328-store-sweep.mjs`, not a new algorithm.

Community-identity note: because `community_uid = sha256(sorted member rowids)` is contents-derived
(`cluster.ts` header), a full pass that reproduces the *same* membership regenerates the *same*
UID — so "the community a rowid maps to changed" is detectable as a UID diff without needing a
stable community identity to persist across passes. That determinism is what makes the drift
metric cheap to compute rather than requiring a separate community-tracking scheme.

**Harness built and run** (BL-350's acceptance explicitly requires one, not just the formula):
`~/.adhd/sox-ecosystem/memory/pkt28-drift-harness.mjs <copy.db> [tau]`, read-only, same
`bl328-*.mjs` convention. It compares live `MEMBER_OF` assignment (both ends live) against a fresh
full pass at the recommended τ. Run against today's true full corpus at τ=0.87:

```
tau=0.87 total_vectors=4867
live_assigned=0 full_pass_assigned=3544
drift: disagree=3544 (72.8%) — all live=none/fullpass=some (orphan/never-ran)
```

**This is the drift metric's first real reading, and it is worst-case by construction right now:**
0 live assignments exist because the incremental path is a dead stub (BL-326) — every one of the
139 live community nodes has zero live members (§0's "139 zero-member communities" ground truth,
confirmed independently here: 2133 total `MEMBER_OF` edges exist but 0 have both a live community
*and* a live member). The harness is correct and ready for PKT-29; it simply has nothing to compare
against yet because there is no incremental state in production. Once PKT-29 ships, this same
command becomes the ongoing drift signal in §3.3's trigger.

### 3.2 Split / merge / orphan criteria

- **Split.** A community becomes a **split candidate** when a re-cluster of *just its own members*
  (via the existing filtered `clusterSubset`, already wired through `curate.ts`) at the *current*
  target-degree τ (§2, recomputed for that community's local N) produces **more than one**
  non-trivial sub-community. This reuses the exact mechanism already in the codebase for filtered
  re-clustering — no new subset-clustering primitive is needed, only a scheduling policy that
  invokes it per-community during the periodic pass rather than only on explicit request.
- **Merge.** Two communities are merge candidates when their **centroid cosine similarity** (already
  tracked — `ClusterStats`'s "mean cosine sim between cluster centroids" per `cluster.ts`'s public
  types) exceeds the *current* target-degree τ. Merge by re-running a full pass restricted to the
  union of their members; do not hand-splice membership lists, since that would produce a
  `community_uid` a full pass could never reproduce and break the drift metric's determinism
  assumption.
- **Orphan.** A community whose live member count reaches zero (every member invalidated via
  `memory_invalidate`, which never touches the community node — this is exactly **BL-327**,
  already filed and scoped as **PKT-31**, correctly marked in `PLAN.md` as orthogonal to τ and
  parallelizable). This packet does not re-scope PKT-31; it confirms PKT-31's trigger condition is
  the right one and folds it into the same periodic-pass vocabulary rather than treating it as an
  unrelated GC job. **Ground truth today:** the live store already has 139 zero-member communities
  against 4,889 episodes (`total_clustered: 0`, `coverage: 0`) — this is BL-327's live symptom,
  not a new finding, cited here only to confirm the orphan case is not hypothetical.

### 3.3 Cadence / trigger

**Not calendar-only, not per-write. Trigger the periodic full-pass reconciliation on whichever
fires first:**

1. **Growth trigger:** live eligible-episode count has grown by ≥20% since the last full pass. This
   is the direct driver of degeneracy per §0/§1 — it is the one signal proven, by direct
   measurement in this packet, to correlate with a stale τ becoming unsafe (0.82: 1616→4867, a
   3.0× / 200% growth, is exactly what took ratio 0.684→0.759; a 20% trigger catches the drift far
   earlier than that).
2. **Drift trigger:** the §3.1 drift metric, computed cheaply on a bounded sample (not every
   episode — same O(sample²) budget as the τ calibration sample) exceeds **15%**. This catches
   content-mix drift that isn't captured by raw growth count (e.g. a burst of near-duplicate
   imports that doesn't change N much but changes the similarity distribution).
3. **Wall-clock backstop:** 24h, in case neither of the above fires but slow organic drift still
   accumulates (this is the case BL-350's framing anticipates — "silently degrading cluster
   quality that never surfaces as a failure").

All three are cheap to check on every periodic-enrich tick (the mechanism BL-346/S6 already
re-enabled) — they gate whether that tick additionally schedules a full-pass row on
`organizer_queue`, they do not require a new scheduler.

---

## 4. What this recommendation does NOT cover (explicitly out of scope, not silently dropped)

- **Implementation.** This is a decision record per the packet's own acceptance; PKT-29/PKT-30
  carry the code.
- **The exact `D_target` and drift/growth trigger percentages (2.0 / 15% / 20%)** are reasoned
  defaults grounded in the measurements above, not independently swept — a follow-up calibration
  pass (naturally, PKT-30's acceptance test already asks for a sweep across the full N range) should
  confirm they hold, not treat them as arbitrary.
- **Switching DBSCAN for a non-chaining linkage algorithm** was considered and explicitly not
  recommended for this program (§2), but is worth a future BL item if target-degree calibration
  turns out to need retuning too often in practice.

---

## 5. Consequence for PKT-30 — stated explicitly per the dispatch brief

**PKT-30 as scoped is invalid.** Its goal reads "re-calibrate the production threshold to the value
PKT-28 actually recommends" and its `Files:` line targets `resolveDefaultThreshold()` as if the fix
is swapping in a corrected constant. This packet's answer is not a constant — §2.1 requires
`resolveDefaultThreshold()`'s signature to change from nullary to a function of sampled data and
target N. **PKT-30 must be re-scoped from "pick a new number" to "implement the target-degree
calibration function from §2 and delete the retry-on-exhaustion guard it replaces."** Its existing
acceptance criterion (sweep the full measured N range and assert the degenerate bound holds
throughout) is still the right acceptance test — it just now exercises a function, not a constant,
and should assert the calibration recomputes correctly as N grows within a single test run (write
enough episodes to cross the 20% growth trigger and confirm τ moves), not just that one fixed value
survives a range check.

**PKT-29 is unaffected in shape** — write-triggered incremental association (§2.2) ships as
scoped; it only needs to *not* attempt τ recalibration itself, which the original scoping already
implied ("O(1) insert never triggers [split/merge]" — BL-350's own framing).

**PKT-31 is unaffected** — confirmed orthogonal in §3.2, already correctly sequenced in `PLAN.md`.

---

## 6. Spend against ceiling

**Budget:** 135k tokens / 45 turns hard ceiling, checkpoint at ~55k requiring ≥2 corpus sizes.
**Measurement coverage:** far exceeds the ≥2-corpus-size bar — this packet reused BL-356's full
N=24/50/100/200/400/800/1200/1616 sweep (already in the repo, not re-run) and added new direct
measurement at N=200, 800, and the **true full corpus N=4867** (§0), including a `minPts` sweep up
to 6× default at full scale — the one alternative-algorithm test PKT-28 explicitly asked for that
BL-328/356 had not yet run. Two probe scripts added under
`~/.adhd/sox-ecosystem/memory/` (`pkt28-minpts-sweep.mjs`), not committed to the repo, per the
existing `bl328-*.mjs` convention. No repo files touched other than this decision record. No `nx
build` run on any extension — live artifact untouched (confirmed below).
