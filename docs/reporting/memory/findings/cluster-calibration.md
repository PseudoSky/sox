# Cluster threshold calibration — BL-328, measured

> **Status:** measurement complete, 2026-07-31. Resolves P0.5 of [`PLAN.md`](../PLAN.md) and
> §3.2 / open question 2 of [`README.md`](../sandbox/README.md).
> **Method:** real `bge-base-en-v1.5` embeddings and the production clustering primitive
> throughout. No `DeterministicTestProvider`, no inference, no estimates.
> **Probe scripts (reproducible):** `~/.adhd/sox-ecosystem/memory/bl328-*.mjs`

## Headline

**The premise of BL-328 as filed is wrong, and the error is in the opposite direction from the
one suspected.** τ = 0.82 is not too *high* for naturally-worded prose. At the scale the live
store actually operates at, it is too **low** — it collapses 68% of the corpus into a single
cluster. And no fixed threshold fixes that, because the correct value is a function of corpus
size, which grows.

Separately: **a real-content G4 cohort is viable.** Evidence in §6.

---

## 1. Two claims in BL-328 that the measurements contradict

BL-328 states, as its driver:

> *"intra-group cosine similarity for topically-related but differently-worded episodes is
> **0.67–0.70**. At the production default of 0.82 a 24-episode / 3-topic corpus produced
> **zero** clusters."*

Both are false for the corpus it cites.

**Intra-group cosine on that corpus is 0.7321–0.9013, mean 0.8087** — not 0.67–0.70. Measured
independently and reproducing the numbers already documented in the test file's own header
comment to four decimal places:

| group | mean | min | max |
|---|---|---|---|
| db-migrations | 0.8174 | 0.7572 | 0.8916 |
| react-hooks | 0.7947 | 0.7428 | 0.8495 |
| coffee-brewing | 0.8141 | 0.7321 | 0.9013 |
| inter-group (all 3 pairs) | 0.4742 | 0.3650 | **0.5652** |

That exact agreement is the control that validates the whole measurement pipeline used below.

**At τ = 0.82 that corpus produces 4 clusters covering 21 of 24 episodes, not zero.** Confirmed
two independent ways:

- Standalone probe against the production `cluster()` primitive: 4 communities, 21 clustered.
- The live `clustering-e2e.test.ts` run itself, step 3.5 (`npx nx test memory-server --skip-nx-cache -- --run clustering-e2e.test.ts`, 18/18 passed):
  ```json
  { "phase": "3.5-production-default-threshold", "default_threshold": 0.82,
    "clusters_at_default": 4, "cluster_count_at_default": 4,
    "total_clustered_at_default": 21 }
  ```

The "zero clusters" observation in BL-328 is not reproducible against the corpus it cites.

---

## 2. Method

- **Source.** A read-only copy of `~/.memory/memory.db` **plus its `-wal`**, copied together
  (BL-330 — a `.db` without its WAL is stale). The live store was never opened for write and the
  memory service was never stopped. Probes refuse any path under `~/.memory`.
- **Input text.** Raw `node.content`. This is exactly what the write path embeds
  (`libs/memory-core/src/write.ts:464` `text: content` → `:501` `embed(pending.text)`).
- **Embedder.** `createEmbeddingProvider({type:'fastembed', model:'bge-base-en-v1.5'})` from
  `libs/data/embed/embedding-provider/dist/index.js`. Reported metadata:
  `{"modelId":"bge-base-en-v1.5","dimensions":768,"maxTokens":512,"isRemote":false}`.
- **Clustering.** The shipped primitive `cluster()` from `@adhd/sox-analysis`
  (`libs/data/analysis/analysis/src/index.ts:143`), not a reimplementation. Note it is **DBSCAN**
  with `epsilon = 1 − τ`, `minPts = minClusterSize = 2`, cosine distance — reached from
  `libs/memory-core/src/cluster.ts:176`. With `minPts = 2` this behaves as single-linkage, which
  is what makes §4 happen.
- **Degenerate guard.** Replayed faithfully from `cluster.ts:465-484`: while
  `max_cluster / total > 0.5`, retry at `τ + 0.05`, up to 3 retries.
- **Contention.** The live embedding host was running throughout (the run logged the BL-331
  warning naming pid 25484). Embedding throughput measured **2.25–2.60/s** and is **CONTENDED —
  not a baseline, and deliberately not used as one.** Cosine geometry is unaffected by
  contention.

### Cohorts

| id | what | n |
|---|---|---|
| **S** | the synthetic control — `clustering-e2e.test.ts`'s 3 hand-written groups | 24 |
| **A** | 3 **semantically distinct** real topics × 8 (`legal-ai-sanctions`, `vector-stores`, `ai-sdr-virtual-sales-agents`) | 24 |
| **B** | 3 **adjacent** real topics × 8 (`multi-agent-dispatch-optimization`, `multi-agent-orchestration`, `dag-scheduling-optimization`) | 24 |
| **C** | stratified general sample — the §3.1 dangerous shapes (>2000 chars, empty tags, <120 chars, non-ASCII) plus an evenly-spaced random tail; 67 distinct topics | 288 |
| **D** | the largest single real topic (`tool-catalog`), full-size | 40 |
| **P** | **the live store's own `vec_node` vectors** — production geometry at production scale, no re-embedding | 1616 |

Cohort P is the important one. `vec_node` holds 1667 rows against 4841 eligible episodes; 1616
join to a live episode with content ≥ 50 chars. These are the actual vectors the write path
produced.

---

## 3. Distributions

Mean / min / p50 / p95 / max, and the fraction of pairs that clear each candidate τ.

| cohort | intra mean | intra min | intra p50 | intra p95 | inter mean | inter max | ≥0.82 (intra) | clean window? |
|---|---|---|---|---|---|---|---|---|
| **S** (synthetic) | 0.8087 | 0.7321 | 0.8095 | 0.8747 | 0.4742 | 0.5652 | 0.345 | **yes** (0.5652, 0.7321] |
| **A** (distinct, real) | 0.8144 | 0.6657 | 0.8146 | 0.9422 | 0.6384 | 0.7580 | 0.452 | no |
| **B** (adjacent, real) | 0.8495 | 0.6203 | 0.8669 | 0.9479 | 0.6803 | 0.8292 | 0.679 | no |
| **C** (general, real) | 0.5971 | 0.3901 | 0.5843 | 0.7640 | **0.6125** | 0.8903 | 0.021 | no |
| **D** (one topic) | 0.6687 | 0.5075 | 0.6484 | 0.8370 | — | — | 0.063 | — |

Three things fall out of this table.

**Real content clusters at least as tightly as the synthetic corpus.** Cohorts A and B have
*higher* intra-group means (0.8144, 0.8495) than the hand-written corpus (0.8087). The premise
that naturally-worded rows "will likely fall below" the synthetic bar does not hold for this
store.

**What is genuinely different is the floor, not the ceiling.** Real inter-group similarity is
0.6384 / 0.6803, against 0.4742 for the synthetic corpus. Everything in a real store is somewhat
similar to everything else. The synthetic corpus is the only cohort with a **clean separation
window** — a τ that puts every intra pair in and every inter pair out. No real cohort has one:
`intra_min < inter_max` in every case. The separation-window methodology documented in
`clustering-e2e.test.ts`'s header does not generalize off that fixture.

**In the general population, the `topic` label carries no pairwise cosine signal at all.** Cohort
C: intra-topic mean **0.5971**, inter-topic mean **0.6125**. Inter is *higher* than intra. Two
episodes sharing a topic are, on average, no more similar than two that do not. `topic` is
per-write enrichment, not a semantic partition, and it must not be used as clustering ground
truth on an arbitrary sample. (Cohorts A/B work only because their topics were *selected* for
distinctness/adjacency — that is a curated cohort, which is exactly what §3.2 calls for.)

---

## 4. The threshold sweep — and why τ is not a constant

### 4.1 On the production corpus (cohort P, 1616 real vectors)

| τ | clusters | clustered | frac | largest | largest ratio | topic purity | degenerate? |
|---|---|---|---|---|---|---|---|
| 0.65 | 2 | 1616 | 1.000 | 1580 | 0.9777 | 0.410 | **YES** |
| 0.70 | 3 | 1598 | 0.989 | 1560 | 0.9653 | 0.607 | **YES** |
| 0.75 | 14 | 1526 | 0.944 | 1459 | 0.9028 | 0.845 | **YES** |
| 0.78 | 38 | 1457 | 0.902 | 1307 | 0.8088 | 0.821 | **YES** |
| 0.80 | 48 | 1402 | 0.868 | 1185 | 0.7333 | 0.809 | **YES** |
| **0.82** | 55 | 1353 | 0.837 | 1105 | **0.6838** | 0.864 | **YES** |
| 0.84 | 74 | 1279 | 0.791 | 888 | 0.5495 | 0.919 | **YES** |
| 0.85 | 94 | 1230 | 0.761 | 594 | 0.3676 | 0.939 | |
| 0.87 | 128 | 1052 | 0.651 | 335 | 0.2073 | 0.943 | |
| 0.90 | 157 | 722 | 0.447 | 36 | 0.0223 | 0.968 | |
| 0.92 | 125 | 501 | 0.310 | 36 | 0.0223 | 0.982 | |
| 0.95 | 66 | 267 | 0.165 | 36 | 0.0223 | 0.984 | |

Answers to the questions as asked:

- **At τ = 0.82, what fraction of a real corpus clusters at all?** 83.7% — but that number is
  worthless on its own, because **68.4% of the entire store is one single cluster**. The
  degenerate guard fires: it retries once at 0.87 and lands on 128 clusters / 20.7% largest /
  0.943 purity. The guard is the only reason production clustering is not one giant blob.
- **τ = 0.65 — the value `clustering-e2e.test.ts` uses as "measured-safe" — is catastrophic on
  real content.** 2 clusters, one of them 97.8% of the store, purity 0.410. It is safe on the
  synthetic fixture and nowhere else. It should never be proposed as a production default.

### 4.2 τ cannot be calibrated on a sample — the chaining measurement

Sub-sampling cohort P at increasing N, fixed τ, deterministic even spacing:

| N | τ=0.82 largest ratio | τ=0.87 largest ratio |
|---|---|---|
| 24 | 0.0000 | 0.0000 |
| 50 | 0.0400 | 0.0400 |
| 100 | 0.0400 | 0.0200 |
| 200 | 0.0850 | 0.0300 |
| 400 | 0.2225 | 0.0275 |
| 800 | 0.4587 | 0.0475 |
| 1200 | **0.5950** | 0.1850 |
| 1616 | **0.6838** | 0.2073 |

The same τ on the same content is healthy at N=200 and degenerate at N=1200. This is
single-linkage chaining: a threshold fixes the *edge probability*, so mean node degree grows
**linearly with N**, and above degree ≈1 the graph percolates into a giant component.

Measured edge probability, projected forward to the full store (4841 eligible episodes — `vec_node`
currently covers only 1616 of them, so density will roughly triple as embed coverage completes):

| τ | P(edge) | mean degree @1616 | mean degree @4841 |
|---|---|---|---|
| 0.80 | 0.01055 | 17.0 | 51.1 |
| 0.82 | 0.00673 | 10.9 | 32.6 |
| 0.85 | 0.00373 | 6.0 | 18.0 |
| 0.87 | 0.00262 | 4.2 | 12.7 |
| 0.90 | 0.00186 | 3.0 | 9.0 |
| 0.95 | 0.00122 | 2.0 | 5.9 |

**Every candidate τ, including 0.95, sits above the percolation threshold at full store size.**
The projection assumes a homogeneous random graph, which the real graph is not — degrees are
heterogeneous and high-τ edges concentrate on near-duplicate chunks — so treat the exact degrees
as an upper bound on the trend, not a prediction. The *direction* is not a projection: it is
measured in the N-sweep above, where 0.82 crossed from 0.22 to 0.68 largest-ratio as N grew 400 →
1616.

This is the same structural problem BL-350 names ("clusters are not constant-time splits and do
not self-reorganize"), reached from the threshold side. It is filed as **BL-356**.

### 4.3 Small-cohort behaviour (what G4 will actually see)

A G4 sandbox store contains *only* the cohort, so §4.2's density effect does not apply — the
N=24 column is the relevant one.

| τ | S (synthetic) | A (distinct real) | B (adjacent real) |
|---|---|---|---|
| 0.65 | 3 clusters, 100% clustered, purity 1.0 | **1 cluster, 100%, purity 0.333** | **1 cluster, 100%, purity 0.333** |
| 0.80 | 3 clusters, 95.8%, purity 1.0 | 3 clusters, 95.8%, purity 1.0 | 2 clusters, 95.8%, purity 0.767 |
| **0.82** | 4 clusters, 87.5%, purity 1.0 | **5 clusters, 95.8%, purity 1.0** | 2 clusters, 95.8%, purity 0.767 |
| 0.85 | 2 clusters, 37.5%, purity 1.0 | 4 clusters, 79.2%, purity 1.0 | 4 clusters, 95.8%, purity 1.0 |
| 0.90 | 1 cluster, 8.3% | 4 clusters, 50%, purity 1.0 | 5 clusters, 79.2%, purity 1.0 |

Note the synthetic fixture is the **most fragile** of the three at the production default: by
τ=0.85 it has collapsed to 37.5% coverage, while real cohort A still holds 79.2%. The hand-written
corpus is tuned for τ=0.65 and degrades fast above it.

---

## 5. Recommendation on τ

**Do not lower it. Raise the floor, and stop treating it as a constant.**

1. **Keep 0.82 as the nominal default; it is defensible and the evidence for lowering it does not
   exist.** Every argument for 0.65 traces to the synthetic fixture, which is the only corpus in
   this study with a clean separation window.
2. **The scale-robust value on today's real store is 0.87** — the value the degenerate guard
   already discovers on its own (128 clusters, 65.1% coverage, 0.943 topic purity, 20.7%
   largest). Setting the default to 0.85–0.87 would mean the guard rarely has to fire, which is
   strictly better: the guard is a 3-retry backstop, not a calibrator, and §4.3 cohort B shows it
   can exhaust its retries and *accept a still-degenerate result* (starting from 0.65 it lands at
   0.80 with largest-ratio 0.625 > 0.5, having run out of attempts).
3. **A fixed τ is the wrong shape for this problem and will fail again as the store grows.** The
   permanent fix is density-aware: target a cluster-size distribution or a mean-degree budget
   rather than a cosine constant, and drop single-linkage (`minPts = 2`) which is what makes
   chaining possible in the first place. Filed as **BL-356**; it is the concrete instance of
   BL-350.
4. **Whatever is chosen, the guard must not be the mechanism.** Today the production default is
   effectively "0.82, plus whatever the guard escalates to" — an undocumented, corpus-dependent
   number that no test asserts and no status surface reports. If 0.87 is the operating value, ship
   0.87.

---

## 6. Is a real-content G4 cohort viable? — **Yes.**

**Cohort A is a working G4 fixture and is better than the synthetic corpus at the production
default.** Group → community mapping at τ = 0.82, cohort A (24 real episodes, 3 selected topics):

```
5 communities, 23/24 clustered
  size=2  {legal-ai-sanctions: 2}
  size=2  {legal-ai-sanctions: 2}
  size=3  {legal-ai-sanctions: 3}
  size=8  {vector-stores: 8}
  size=8  {ai-sdr-virtual-sales-agents: 8}
```

**Every community is 100% pure. Zero cross-group contamination.** Two of three groups map to
exactly one community holding all 8 members; the third splits into three pure sub-communities.

The synthetic corpus at the same τ is *worse*: 4 communities, 21/24 clustered, `db-migrations`
loses a member and `react-hooks` splits 4+2 with two members dropped.

Cohort A composition (reproducible from any store copy — `bl328-extract.mjs`):

| group | topic | n | uid range |
|---|---|---|---|
| distinct-1 | `legal-ai-sanctions` | 8 | `01KW2YK3…` … `01KW2YMKN…` |
| distinct-2 | `vector-stores` | 8 | `01KW2WCEB…` … `01KW2WGDH…` |
| distinct-3 | `ai-sdr-virtual-sales-agents` | 8 | `01KW3EHZ3…` … `01KW3EKNT…` |

### Conditions the G4 cohort must satisfy

1. **Topics must be *selected* for distinctness, not sampled.** §3 shows an arbitrary topic-labelled
   sample has inter-similarity ≥ intra-similarity. Cohort B (adjacent topics) merges two of its
   three groups into one community at τ=0.82 — realistic, but it makes a purity assertion fail
   for a correct reason, which is the false-red §3.2 warns about. Use distinct topics for the
   assertion cohort; keep B as an explicitly-informational probe.
2. **Assert purity and dominance, not "one community per group."** No corpus in this study —
   synthetic included — puts every group in exactly one community at the production default. The
   sound assertions are: `cluster_count > 0`, `total_clustered > 0`, coverage > 0, **every
   community is 100% single-group**, and **each group's dominant community holds a stated
   minimum**. Cohort A satisfies all of these at τ=0.82 with the minimum at 3/8.
3. **The cohort must be the whole sandbox store.** §4.2 is only inapplicable because N=24. If G4
   ever ingests the cohort alongside other gates' rows, re-derive τ.
4. **Content is carried, intelligence is regenerated** (§3 of the spec) — this cohort carries only
   `content` / `topic` / `tags` / timestamps; every vector above was recomputed from raw content.

### One caveat, stated plainly

This store's real content is dominated by **chunked research-report output** — cohort A/B rows are
document fragments beginning `## Sub-question`, `## Sources`, `### LanceDB`. That is genuinely
this user's real memory content, and it is what the sandbox should be tested against. But it is
more self-similar and more templated than free-form prose, and it is a large part of why the
similarity floor is 0.61 rather than 0.47. A store with a different content mix would need this
measurement re-run. The G4 fixture should pin the specific uids so the cohort is stable.

---

## 7. Follow-ups filed

- **BL-328** — rewritten with these measurements; its two driver claims were corrected and its
  acceptance criterion reframed (a calibration test must assert non-degeneracy at production
  scale, not just coverage on 24 rows).
- **BL-356** — *(new)* a fixed global cosine threshold is not calibratable: single-linkage chaining
  makes the correct τ a function of corpus size, and the degenerate guard is a 3-retry backstop
  that can exhaust and accept a degenerate result.

## 8. Reproducing

```bash
cp ~/.memory/memory.db      $TMP/corpus.db      # copy the WAL too — BL-330
cp ~/.memory/memory.db-wal  $TMP/corpus.db-wal
D=~/.adhd/sox-ecosystem/memory
node $D/bl328-extract.mjs     $TMP/corpus.db $TMP/cohorts.json
node $D/bl328-embed.mjs       $TMP/cohorts.json $TMP/vectors.json   # ~3 min, contended
node $D/bl328-analyze.mjs     $TMP/vectors.json
node $D/bl328-store-sweep.mjs $TMP/corpus.db     # production-vector sweep
node $D/bl328-scale.mjs       $TMP/corpus.db 0.82
node $D/bl328-degree.mjs      $TMP/corpus.db
node $D/bl328-g4-detail.mjs   $TMP/vectors.json A 0.82 0.85
```

The probes are read-only and refuse any path under `~/.memory`.

## 9. Notes on the run

- **The live memory service was not stopped and `~/.memory` was never written.**
- Embedding throughput (2.25–2.60/s) was gathered **contended** against the live embed host and is
  recorded here only to be explicit that it is not a baseline.
- `npx nx test memory-server` transitively rebuilt the `embedding-provider`, `store-adapter` and
  `memory-core` library dists (both runs compiled clean). No extension bundle artifact was rebuilt,
  so `registry/index.json` checksums are unaffected.
- **Memory recall was degraded, as warned.** Two `memory_recall` calls on clustering/threshold terms
  returned only unrelated `claude-metadata` episodes from a different project. Vector scores were
  ~0.005 across the board and `bm25` was `0` on most rows; the two rows with a non-zero `bm25`
  component were still topically irrelevant. **Neither vector nor keyword recall surfaced any prior
  internal work on clustering or threshold calibration** — consistent with BL-347. The DRY check was
  performed and found nothing; that is a recall failure, not evidence that no prior work exists.
