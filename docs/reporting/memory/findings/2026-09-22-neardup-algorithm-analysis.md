# Near-dup auto-invalidation: measured loss, root cause, and algorithm recommendation

Read-only analysis against a copy of `~/.memory/memory.db` (133 MB, copied 2026-09-22T11:13, WAL included).
No source edits, no store writes, no builds. All numbers below come from that copy via
`@tursodatabase/database` `connect(path, {readOnly:true})` — the stock `sqlite3` CLI cannot open the store.

---

## 0. Lead: it is still running

The last auto-invalidation happened **today at 2026-09-22T15:02:13Z**. 34 `SAME_AS` merge edges were
created in the last two days (2026-09-21: 15, 2026-09-22: 19). The population is 685 pairs, not 684 —
it grew by one while this analysis was being written.

Nothing in this document is historical cleanup. The pass that produced every defect below is live in
the write path right now (`libs/memory-core/src/enrich.ts:91` threshold, `:103-136` `applyNearDupResult`,
invoked from `embed-pipeline.ts` Phase B).

---

## PART 1 — How much was actually lost

### 1.1 Attribution: all 682 invalidations are the near-dup pass

`applyNearDupResult` stamps the `SAME_AS` edge and the victim's `t_invalid` from the **same** `now`
variable (`enrich.ts:107` and `:130`). That gives an exact attribution rule: a victim whose `t_invalid`
matches its `SAME_AS` edge's `t_created` was killed by this pass.

| | count |
|---|---|
| `SAME_AS` edges in store (all live, none expired) | 685 |
| pairs where a node's `t_invalid` is within 2 s of the edge timestamp | **682** |
| pairs where the invalidation does *not* match the edge time | 0 |
| pairs where neither node was ever invalidated (link-only) | 3 |

So **682 episodes were destroyed by automatic near-dup invalidation**, and the attribution is not a
guess — it is a timestamp identity inherited from the code path.

### 1.2 Structural vs independent

A `DERIVED_FROM` edge between the two members means the pair is a parent document and one of its own
auto-generated chunks.

| class | pairs | share |
|---|---|---|
| **structural** (parent ↔ its own `DERIVED_FROM` chunk) | **263** (261 invalidating) | 38.4 % |
| **independent** episodes | **421** | 61.5 % |
| link-only, no invalidation | 3 | — |

In the structural class the victim is almost always the **parent**: of the 261 structural pairs that
invalidated something, **260 killed the parent and 1 killed the chunk**. The chunker writes the parent first, so the parent is always "older", and the rule
"invalidate the older node" kills the document and keeps a fragment.

**Structural pairs are false positives by construction.** A chunk is *required* to be a near-copy of
its parent — that is what chunking means. `detectNearDup` (`libs/memory-core/src/neardup.ts:46-128`)
has no `DERIVED_FROM` exclusion at all. This is a design omission, not a similarity misjudgment, and
it accounts for 38 % of all invalidations with no judgment call required.

Mitigating nuance, measured: 255 of the 260 killed parents still have **every** chunk live, so the
text survives in fragments; 5 have lost chunks as well. What is unrecoverable in all 260 is the
parent node itself — its topic, its tags, its identity as a single retrievable document, and its edges.

### 1.3 Lexical similarity vs stored cosine — the joint distribution

Token-set Jaccard over `[a-z0-9_./-]+` tokens of the two `content` fields, against the cosine stored
on the `SAME_AS` edge (`weight`), for all 682 attributed pairs:

| percentile | cosine | Jaccard | containment (∩ / min) |
|---|---|---|---|
| min | 0.9501 | 0.045 | 0.00 |
| p10 | 0.9531 | 0.369 | 0.62 |
| p25 | 0.9607 | 0.524 | 0.78 |
| p50 | 0.9726 | 0.696 | 0.98 |
| p75 | 0.9908 | 0.865 | 1.00 |
| p90 | 1.0000 | 0.988 | 1.00 |
| max | 1.0000 | 1.000 | 1.00 |

Pearson r(cosine, Jaccard) on this set = **0.476**. 43 pairs merged at Jaccard < 0.30 — near-disjoint
vocabularies. 141 pairs merged at Jaccard < 0.50.

Only **55 pairs** (8 %) had byte-identical content. (`content_hash` equality is not usable as a signal
here: 347 of 685 pairs have a NULL hash on at least one side.)

Cosine and lexical identity agree only loosely. **But the converse also holds, and it is the finding
that kills the obvious fix:** in the hand-verified sample below, a clear false positive sits at
Jaccard 0.900 (`CONCURRENCY PROBE A` vs `PROBE B`), while several genuine paraphrase duplicates sit at
Jaccard 0.43–0.53. Jaccard is not a usable second gate either. See §3.

### 1.4 Hand-verified sample (24 independent pairs)

24 pairs drawn from the 421 independent pairs and read in full.

**Method caveat, stated plainly:** the draw used a seeded `Array.sort(() => rnd() - 0.5)` comparator
shuffle. That is a *biased* shuffle, not a uniform random sample. Treat it as a pseudorandom selection
with unquantified selection bias, not a probability sample. The per-pair verdicts below are auditable
from the erow ids; the extrapolation from them is the weakest number in this document.

| erow | cos | jac | verdict | reason |
|---|---|---|---|---|
| 178165 | 0.966 | 0.453 | TRUE DUP | two reflections on the same source set, same claims |
| 178263 | 0.990 | 0.863 | TRUE DUP | paraphrase of the same CSS-token technique |
| **203628** | 0.966 | 0.075 | **FALSE POSITIVE** | two `Citations:` lists with disjoint file paths |
| **203629** | 0.951 | 0.051 | **FALSE POSITIVE** | same class, different citation set |
| **185286** | 0.980 | 0.492 | **FALSE POSITIVE** | same paper, different metadata: victim had `citations: 14` and `domain: CROSS_BOUNDARY_DEPENDENCY`; survivor has a `doi` the victim lacked. Neither is a superset. |
| 211472 | 0.972 | 0.531 | TRUE DUP | shorter report of the same packet; survivor is 5983 b vs 3158 b |
| 178268 | 0.976 | 0.756 | TRUE DUP | paraphrase |
| 211473 | 0.973 | 0.450 | TRUE DUP | same packet report, different wording |
| 178266 | 1.000 | 1.000 | TRUE DUP | byte-identical |
| 211634 | 1.000 | 0.887 | TRUE DUP | same `@nxlv/python` package record |
| 178302 | 0.987 | 0.731 | TRUE DUP | paraphrase |
| 178011 | 0.982 | 0.514 | TRUE DUP | paraphrase, minor detail drift |
| 177998 | 0.999 | 0.966 | TRUE DUP | paraphrase |
| 52787 | 0.990 | 0.860 | TRUE DUP | same research-started sub-question list |
| 177977 | 0.962 | 0.426 | TRUE DUP | paraphrase |
| **199784** | 0.990 | **0.900** | **FALSE POSITIVE** | `CONCURRENCY PROBE A` vs `CONCURRENCY PROBE B` — two distinct probes differing in one character |
| **175843** | 0.988 | 0.628 | **FALSE POSITIVE** | `neverthrow` package record; victim 1673 b, survivor 1266 b — the *larger* record was destroyed |
| 178295 | 0.952 | 0.315 | AMBIGUOUS | victim enumerates UC-1…UC-5; survivor states conclusions |
| 1010 | 0.988 | 0.878 | TRUE DUP | same sox-sync lesson |
| 177989 | 0.974 | 0.612 | TRUE DUP | paraphrase |
| **219968** | 0.961 | 0.429 | **FALSE POSITIVE** | ADTK record, victim `kind: algorithm`, survivor `kind: model`, different `task_family` — a real classification distinction destroyed |
| 177970 | 1.000 | 1.000 | TRUE DUP | byte-identical |
| **203425** | 0.963 | 0.269 | **FALSE POSITIVE** | `Citations:` lists, disjoint |
| 178291 | 0.972 | 0.533 | TRUE DUP | paraphrase |

**16 true duplicates / 7 false positives / 1 ambiguous.** Point estimate 7/24 ≈ **29 %** false-positive
rate among independent pairs; a Wilson 95 % interval at n = 24 is roughly **15 %–49 %**, before the
selection-bias caveat above.

### 1.5 Estimated total false positives

Do **not** blend the two classes — their failure modes and confidence levels are different.

| class | n | false-positive rate | FP count |
|---|---|---|---|
| structural (parent ↔ own chunk) | 261 | **100 %, by construction** | 261 |
| independent | 421 | 29 % [15–49 %] | 122 [63–206] |
| **total** | **682** | — | **≈ 383, range 324–467** |

Classification rule for the structural class: presence of a `DERIVED_FROM` edge between the two nodes.
No uncertainty. Classification rule for the independent class: hand reading of both texts, asking
"does the victim assert something about a *different object* than the survivor?" — the discriminator
that actually fired in every one of the 7 verdicts. Uncertainty: sample size 24 and a biased draw.

A purely automated proxy was tried (fraction of victim vocabulary absent from the survivor) and is
reported here only to be **rejected**: it labels 263 of 682 "ambiguous" and misclassifies both
directions of the hand sample. It is not the basis for the numbers above.

### 1.6 What the invalidated nodes actually carried

Over all 682 victims:

| loss | measured |
|---|---|
| victim content bytes removed from live recall | **1,101,023 bytes** (structural 796,314 / independent 304,709) |
| …of which the **survivor is itself now invalidated** — nothing of the pair remains in live recall | **132 pairs**, 79,141 victim bytes, 2,795 uniquely-lost tokens |
| distinct tokens present in victim, absent from survivor | **25,650** (mean 37.6 per victim) |
| victims whose vocabulary is *fully* contained in the survivor (zero loss) | **73** of 682 (10.7 %) |
| victims with ≥ 50 % of their vocabulary absent from the survivor | **76** |
| victims carrying a topic the survivor does not have | **242** |
| victims carrying tags the survivor does not have | **277** |
| non-`SAME_AS` edges attached to victims, now pointing into invalidated nodes | **3,273** across 328 victims |

Fraction of victim vocabulary not present in the survivor: p10 0.000, p25 0.091, **p50 0.230**, p75 0.371, p90 0.519.

Read plainly: **the median destroyed node carried 23 % of its vocabulary uniquely**, and only one in
ten was genuinely redundant at the token level.

### 1.7 Time distribution

Two different clocks matter and the original "2–15 s" report conflated them.

**Delay from the surviving node's write to the invalidation** (how fast the pass fires). The
population is sharply bimodal, and the bimodality is itself the finding, so both halves are given:

| | n | p50 | p95 | max |
|---|---|---|---|---|
| all 682 | 682 | **1,016,713 s** (11.8 d) | 1,036,571 s | 1,043,525 s |
| the 298 genuine write-path cases (≤ 20 s) | 298 | **1.55 s** | 9.86 s | 18.31 s |

Minimum over the whole population is 0.02 s. The all-682 percentiles are dominated by the 2026-07-04
mass event described below, where *both* nodes were already old; they are not a write-path latency.
The 298-case row is the write-path figure, and it matches the reported behaviour and the 1.05 s sample.

**Age of the victim at the moment it was killed** — the number that says what was destroyed:

| | structural (n=261) | independent (n=421) |
|---|---|---|
| min | 0.63 s | 1.05 s |
| p25 | 1.57 s | 11.85 d |
| **p50** | **2.18 s** | **11.91 d** |
| p75 | 4.54 s | 11.99 d |
| p95 | 131.7 s | 12.06 d |
| max | 5.4 h | **46.9 d** |

Bucketed over all 682: `<10s` 237, `10–60s` 40, `1m–1h` 47, `1h–1d` 8, `1–7d` 3, **`7–30d` 346**, `>30d` 1.

The bimodality has a cause. **354 of the 421 independent-pair invalidations happened on a single day,
2026-07-04** (the 21:00 and 22:00 hours carried 216 and 140 `SAME_AS` edges respectively — all-pair counts, structural included). That is a bulk re-embed/backfill pass
running Phase-B `applyEmbedding`, which calls `applyNearDupResult` on every re-embedded node — so it
ran near-dup over the *existing corpus* and killed memories that were on average ~12 days old. It is
not a write-path artifact; it is a mass event. The remaining ~67 independent invalidations are spread
across 19 other days.

### 1.8 Lower bound caveat — quantified

685 `SAME_AS` edges are all live (`t_expired IS NULL`); none have been expired, so no pair has been
pruned by that mechanism. But **hard deletion cascades**: `edge.src/dst REFERENCES node ON DELETE
CASCADE`, so any victim removed by `memory_curate drop-episodes` takes its `SAME_AS` edge with it and
leaves no trace. Those are unrecoverable by this route.

What can be bounded: of **852 invalidated episodes** in the store, 689 appear in a live `SAME_AS`
edge. The other **163** break down as:

- **74** carry a `SUPERSEDES` edge — legitimate explicit supersession, not near-dup.
- **86** carry other edges but no `SAME_AS`.
- **3** carry no edges at all.
- Of those 163, **28** were invalidated **< 20 s after their own creation** — the near-dup signature.
  Those 28 are the strongest candidates for near-dup kills whose edge is gone.

So the honest statement: **682 measured, up to ~28 more suspected from the surviving invalidated set,
and an unknown number of hard-deleted victims that leave no evidence whatsoever.** 682 is a floor.

---

## PART 2 — Is this an algorithm problem?

**PARTLY — and the two example pairs the user supplied are the wrong evidence for it.**

### 2.1 The baseline: 0.95 is NOT a meaningless threshold in this store

Random pairwise cosine over 600 pseudorandomly-selected **live** (`t_invalid IS NULL`) embedded
episodes, 179,700 pairs. (Selection used the same biased `sort(() => Math.random() - 0.5)` comparator
disclosed in §1.4. Tolerable here and nowhere near as load-bearing as in §1.4: the statistic is the
*moments of the pairwise-cosine distribution* over a 600-of-6,794 subset, which a non-uniform draw
perturbs negligibly — and the conclusion turns on an order-of-magnitude gap, 0.61 vs 0.95, not a
percentile boundary.)

| stat | value |
|---|---|
| mean | **0.6127** |
| sd | 0.0710 |
| p50 | 0.6133 |
| p90 | 0.6934 |
| p99 | 0.7686 |
| p99.9 | 0.8516 |
| max | 0.9903 |
| fraction ≥ 0.90 | 0.026 % |
| **fraction ≥ 0.95** | **0.0022 % (4 pairs of 179,700)** |
| fraction ≥ 0.99 | 0.0006 % (1 pair) |

z-score of the 0.95 threshold against this distribution: **+4.75σ**.

This **falsifies the anisotropy / narrow-cone hypothesis for this store.** bge-base-en-v1.5 embeddings
here are not concentrated in a high-cosine band. 0.95 is an extremely selective cut. Whatever produced
0.9916 and 0.9967 on unrelated text is not the generic geometry of the model.

### 2.2 Root cause of the two supplied examples: a degenerate embedding batch, not the model

Store-wide greedy-leader clustering at cosine ≥ 0.99 over all 7,042 embedded episodes finds 25 clusters
of ≥ 3 members, totalling **154 vectors**. They are tightly day-localised:

| cluster | size | days |
|---|---|---|
| #1 | 40 | 2026-06-26 |
| #2 | 15 | 2026-08-15 (14), 2026-08-17 (1) |
| #3 | 12 | 2026-06-26 |
| #4–#12 | 4–8 each | 2026-06-22 / 2026-06-23 |

Inside cluster #1, 16 members are `kind:lesson` texts written between **15:31:18 and 15:39:28 on
2026-06-26** — eight minutes. Their contents are entirely unrelated (npm read-CDN 404 semantics;
parallel agent fan-out lanes; ts-morph extraction regression; escalating a failing model tier). Their
vectors are effectively the same point: **max per-coordinate |a − b| = 0.0057** across 768 dims.

**Both false-positive pairs in the brief are inside this cluster:**
- *"When the published artifact embeds a generated input (registry/index.json)…"* — created 15:31:25.
- *"A subagent/tool reporting 'success' is not proof of effect…"* — created 15:31:18.
- *"When two files must stay byte-for-byte logically identical…"* — created 15:31:38.

Two further properties confirm this is a defect rather than a distribution:
- The degenerate vector is **nearly orthogonal to the store centroid** (cos 0.037), while a typical
  episode sits at cos 0.79 to the centroid. A "mean-vector fallback" would look like the opposite.
- **37 episodes** sit within cosine ≥ 0.99 of that single vector, and **every one of them was created
  on 2026-06-26**. No episode from any other day comes near it.

**Mechanism: conjecture, not measured.** No degraded/stub fallback exists in
`libs/memory-core/src/embed.ts` (searched; `:244` states "Throws on failure for both 'auto' and 'real'
modes (no degraded fallback)"), so the defect is not a designed fallback path. Circumstantial support
for a re-embed run in that window: `~/.memory/memory.db.bak-reembed-2026-06-26T19-13-39-932Z` exists —
a re-embed backup dated the same day. What would discriminate: re-embedding those 16 texts through the
current provider and comparing to the stored vectors. That was not done (read-only scope, and the
current provider is the live one).

**Intersection with the loss:** 39 of the 685 pairs have at least one node still holding a degenerate
vector, all 39 in the independent class. This is a **lower bound** — 528 of 685 pairs have had the
victim's `vec_node` row deleted, so their vectors can no longer be tested.

### 2.3 The genre effect is real, but it is a *different* class

Conditional cosine baselines (samples capped at 350 per group, all pairs within group):

| genre | pool | mean | p50 | p90 | p99 | % ≥ 0.95 |
|---|---|---|---|---|---|---|
| `kind:lesson` (any) | 350 | 0.559 | 0.604 | 0.681 | 0.751 | 0.20 % |
| `kind:lesson` + `Consequence:` template | 81 | 0.455 | 0.612 | 0.703 | **0.997** | 3.70 % |
| **`Citations: [...]` only** | 23 | **0.821** | 0.810 | **0.897** | 0.963 | **2.77 %** |
| everything else | 350 | 0.594 | 0.603 | 0.684 | 0.771 | 0.018 % |

The templated lesson genre is **not** collapsed — its p50/p90 are indistinguishable from the rest of
the store. Its entire ≥ 0.99 mass *is* the degenerate cluster. So the "templated agent lessons are
adversarial for this model" hypothesis is **not supported** by the data.

What **is** supported: **pure-citation episodes** are a genuinely adversarial content type. Mean
cosine 0.82, p90 0.90, and lexically-unrelated pairs (Jaccard < 0.25) still reach 0.9655. These are
lists of file paths and line numbers — almost no semantic content, dominated by shared path vocabulary.
Erows 203628 / 203629 / 203425 (three of the seven hand-verified false positives) are exactly this
class, and no degenerate vector is involved. **Answer to "is the store's content adversarial for this
model": yes, for one narrow content type — reference/citation lists — and no, for agent lessons.**

### 2.4 Normalization / dialect bug: RULED OUT

- Stored vectors are correctly L2-normalised: norms over the pair population range
  0.99999956 – 1.00000040. Dimension 768 as declared.
- Cosine is recomputed locally with explicit norms in `cosineSim`
  (`libs/data/analysis/analysis/src/index.ts:113-124`) and does **not** consume the dialect's
  `distance` column — `neardup.ts:71-84` documents this choice explicitly, because vec0 and Turso
  disagree on the default metric. Both backends are therefore scored identically.
- Empirical check: for the 157 pairs where both vectors still exist, the stored edge `weight` matches
  the cosine recomputed from the current vectors **exactly** in 155 cases (|Δ| = 0 at p50).
- The two exceptions are explainable and are reported rather than hidden: erow 188848 (stored 1.0000,
  now 0.7186) and erow 192864 (stored 0.9500, now 0.9154). Both are consistent with one of the nodes
  having been **re-embedded after** the edge was written, which changes the vector but not the stored
  weight. Neither is a normalization artifact — a normalization bug would shift the whole population.

The arithmetic is correct. The **inputs** were wrong for a bounded set of nodes, and the **policy**
built on the correct arithmetic is wrong for everyone.

### 2.5 Verdict

| question | answer |
|---|---|
| is bge-base-en-v1.5 scoring unrelated text at 0.99+ generically? | **No.** Random-pair p99.9 = 0.85; only 4 of 179,700 pairs reach 0.95. |
| are the user's two example pairs a model failure? | **No.** Both are members of a 2026-06-26 degenerate-vector batch (37 episodes, one vector, max coord Δ 0.0057). |
| is there an algorithm problem? | **Yes, but not the similarity function.** Three separate defects: (a) no `DERIVED_FROM` exclusion → 261 parents killed by their own chunks; (b) an embedding-pipeline defect that mints constant vectors in bursts, with no guard against it; (c) a **policy** that destroys data on an unverified single-scalar signal, with a 29 % error rate even where the vectors are sound. |
| is a threshold change the fix? | **No.** The fix plan's conclusion holds and generalises (see §3). |

---

## PART 3 — Recommendation

Prior-art recall was performed first per repo convention (`memory_recall` on near-duplicate detection
algorithms, MinHash/SimHash/cross-encoder, and on cosine-threshold calibration/anisotropy). **No prior
internal research on this topic exists in the store** — both queries returned unrelated results
(Nx caching, dispatch-cost lessons, a CUSUM anomaly-detection pattern). The recommendations below are
therefore reasoned from the measurements in this document, with external techniques labelled.

### 3.1 No single scalar separates these classes — including the lexical ones

This is the measured core of the recommendation, and it rules out the obvious candidates:

- **Threshold tuning** — dead. Raising to 0.99 keeps 5 of 7 hand-verified false positives (their
  cosines: 0.9916, 0.9967, 0.9985, 0.9989…) and starts discarding true duplicates at 0.96.
- **Jaccard / MinHash / SimHash as a second gate** — dead *on this evidence*. A verified false positive
  sits at Jaccard 0.900 (`PROBE A` vs `PROBE B`); verified true duplicates sit at 0.43–0.53. A
  conjunctive `cos ≥ 0.95 AND jaccard ≥ 0.8` rule would still have merged `PROBE A/B`, `@nxlv/python`,
  and the `neverthrow` record, while sparing none of the citation-list merges only by accident.
- **z-scored / percentile-relative thresholds** — would not have helped here and could make it worse.
  The store's own distribution already puts 0.95 at +4.75σ; the failures are not marginal-σ cases, they
  are degenerate inputs and structural pairs sitting at the very top of the distribution.
- **Centering / whitening for anisotropy** — unnecessary. Measured anisotropy is low (random-pair
  p50 0.61). This would be treating a disease the store does not have.

What actually separated the seven false positives, in every case, is **discrete object identity**:
different file-path lists, `A` vs `B`, `kind: algorithm` vs `kind: model`, present-vs-absent `doi`.
That is not a smooth similarity score. It is a mismatch on extracted identifiers.

### 3.2 Recommended design

**Tier 0 — stop the bleeding (do this first, it is a one-line policy change).**
Make the default action **link-only**: insert the `SAME_AS` edge, never set `t_invalid`. This is
`enrich.ts:127-136`. The 3 link-only pairs already in the store show the surface works without the
UPDATE. Recall can deprioritise or collapse `SAME_AS`-linked neighbours at read time, which is
reversible; invalidation is not.

**I agree with the fix plan's link-only recommendation, and the measurements strengthen it:** even a
perfect similarity function would not have saved the 261 structural kills, because those pairs *are*
similar — the error is in what was done about it.

**Tier 1 — three hard exclusions before any similarity is even scored** (cheap, no new model):
1. Never pair a node with a `DERIVED_FROM` ancestor or descendant. Removes 38 % of all damage.
2. Never act on a vector that is a member of a ≥3-member ≥0.99 cluster, or whose cosine to the store
   centroid is a far outlier. A vector that is identical to 15 other vectors is a defect signal, not a
   duplicate signal. This is a **novel guard**, not a standard technique — label it as such.
3. Gate by content type: exclude episodes that are predominantly reference lists (e.g. content matching
   `^\s*Citations:\s*\[`). Measured mean cosine 0.82 within this class makes similarity meaningless there.

**Tier 2 — two-stage retrieve-then-verify, if automatic merging is wanted at all.**
Stage 1 stays as is (vector KNN as a cheap recall filter). Stage 2 is a **verifier**, not a second
similarity score:
- *Deterministic verifier (recommended first):* extract the discrete identifiers both texts assert —
  file paths, package@version, `key: value` front-matter fields, commit shas, numeric literals — and
  require that the victim asserts **no identifier the survivor does not also assert**. This directly
  encodes what distinguished all 7 hand-verified false positives, is deterministic, costs microseconds,
  and needs no model. It is a subset/containment test, not a similarity test.
- *Cross-encoder rescoring (external technique, conjecture for this data):* a cross-encoder reranker
  (e.g. the MS MARCO MiniLM cross-encoders distributed with sentence-transformers) scores a text pair
  jointly instead of comparing two independent embeddings, and is the standard second stage in
  retrieve-then-rerank pipelines. It is plausible it would separate `PROBE A` from `PROBE B` where a
  bi-encoder cannot. **Unverified on this store** — no cross-encoder was run here. It also does not
  address the structural or degenerate-vector classes at all, so it is strictly Tier 2.

### 3.3 Is any auto-merge safe? — CONDITIONAL, and the safe set is nearly empty

Automatic invalidation is defensible only under **all** of:
1. `content_hash` equality, **or** normalized-text equality after whitespace/punctuation folding; and
2. no `DERIVED_FROM` relation between the nodes; and
3. neither vector is in a degenerate cluster; and
4. the victim's metadata (topic, tags, non-`SAME_AS` edges) is a subset of the survivor's, or is
   migrated to the survivor first; and
5. the victim's asserted identifiers are a subset of the survivor's.

Note what condition 1 means in practice: **the write path already performs exact `content_hash`
dedup**, so the marginal value of an automatic embedding-driven merge is close to zero. Only 55 of 685
pairs (8 %) were byte-identical, and 73 of 682 victims (10.7 %) were fully vocabulary-contained.
The near-dup pass is paying a 383-episode data-loss bill for a benefit the write path already delivers.

Two further requirements regardless of policy:
- **Migrate before destroying.** 3,273 non-`SAME_AS` edges, 242 topics and 277 tag sets were discarded
  with their nodes. Any merge must re-point edges and union metadata onto the survivor first.
- **Prefer the richer node, not the older one.** "Invalidate the older" destroyed the *larger* record
  in the `neverthrow` case and the *parent document* in 260 structural cases. If a survivor must be
  chosen, choose by content superset, not by timestamp.

### 3.4 Cost and latency on the live write path

Reasoning from `neardup.ts:53-99` and `enrich.ts:103-136` — structural, not benchmarked:
- Today the pass is one KNN query (`KNN_FETCH = 21`), one `IN (…)` vector fetch, and ~20 local
  768-dim cosines (`detectNearDupPairs` compares all pairs among 21 vectors — 210 cosines, ~160 k
  multiply-adds), plus an edge INSERT and, on invalidate, an UPDATE and `gcOrphanedCommunityState`.
- **Link-only strictly reduces work** — it removes the UPDATE and the community GC. There is no
  latency argument against Tier 0.
- Tier 1 exclusions are index lookups and a set membership test; negligible.
- The deterministic identifier verifier is regex extraction over two strings already in memory —
  microseconds, and it runs on at most one candidate pair.
- A cross-encoder inside the write transaction is the only expensive option: a second model invocation
  per candidate, in the same transaction that already holds the serial write slot. If pursued, it must
  run **outside** the write path as a deferred review queue, not inline.

---

## Claim inventory: measured vs conjecture

**Measured** (from the store copy, reproducible from §0 method):
- 685 `SAME_AS` pairs, 682 attributed invalidations, 263 structural / 421 independent, 260 parents killed.
- All cosine / Jaccard / containment distributions and the r = 0.476 correlation.
- Random-pair cosine baseline (mean 0.6127, sd 0.0710, 4/179,700 ≥ 0.95) over live embedded episodes.
- Genre-conditional baselines; the 25 degenerate clusters; 154 clustered vectors; the 16-member
  2026-06-26 cluster with max coordinate Δ 0.0057; 37 episodes within 0.99 of that vector, all from
  one day; centroid cosines 0.037 vs 0.79.
- Vector norms ≈ 1.0; 155/157 stored-vs-recomputed cosines identical.
- All loss quantities: 1,101,023 bytes, 25,650 unique tokens, 3,273 orphaned edges, 242 topics, 277 tag sets.
- Time distributions and the 2026-07-04 mass event (354 of 421 independent kills in two hours).
- The 163 invalidated-but-unlinked episodes and their 74/86/3/28 breakdown.
- The 24 hand-read pairs and their verdicts.

**Conjecture / reasoning, explicitly not measured:**
- The *mechanism* of the degenerate embedding batches (provider defect during a re-embed run). Supported
  circumstantially by the same-day re-embed backup file; not reproduced.
- That the 2026-07-04 event was a bulk re-embed pass — inferred from the timestamp clustering and from
  `applyEmbedding` calling `applyNearDupResult`, not from a log.
- That a cross-encoder would separate these classes. External technique; not run on this data.
- Cost/latency statements in §3.4 — read from code structure, not benchmarked.
- The 29 % independent false-positive rate carries both n=24 sampling error and a biased-shuffle
  selection caveat (§1.4).

**Not knowable by this route:** near-dup victims that were later hard-deleted take their `SAME_AS`
edge with them via `ON DELETE CASCADE` and leave no evidence. 682 is a floor, not a total.
