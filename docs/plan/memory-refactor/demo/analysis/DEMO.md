# `@adhd/sox-analysis` — Live Demo & Acceptance Script

> Deterministic corpus intelligence — clustering, near-duplicate detection, and importance scoring — in pure JS, with no LLM, no paid API, and no external vector database.

**What this is.** A presentation-grade walkthrough of `@adhd/sox-analysis` that doubles as its acceptance test. Follow it top to bottom and you will (a) experience the package the way a brand-new external consumer would and (b) prove every capability works, with exact code, exact data, and pass/fail checks. It is the contract for what "done" means for the `w2d-analysis` extraction: if it is demonstrated here, it must work; if it must work, it is demonstrated here.

---

## 0 · How to Read This Script

**Legend**

| Marker | Meaning |
|---|---|
| 🎬 **Scene** | The story beat — what is happening and why the persona cares. Read this aloud in a demo. |
| ▶️ **Do** | The exact action to take (code to run) with literal input data. |
| 👀 **Expect** | The exact observable result. Volatile parts (timestamps, auto-generated IDs) shown as ⟨…⟩. |
| ✅ **Verify** | Binary pass/fail assertions. Tick each only if it is literally true. |
| 🔗 **Proves** | Requirement and capability IDs this beat satisfies. |
| 📎 **Source** | What grounds this step — spec section, doc, file, or ticket it came from. |
| ⟦U#⟧ | An **unresolved stub**: a value guessed because the context did not specify it. Logged in `UNRESOLVED.md` beside this file. |
| ⚠️ **Edge** | A deliberately adversarial beat. |
| 🛟 **Recovery** | A failure-then-recover beat. |

**Conventions**
- All code runs from a clean temporary directory (no workspace `node_modules` reaching back into libs). `node --version` must be ≥ 18.
- `⟨…⟩` marks values that change between runs; the assertion next to them states what stays invariant.
- Tokens shown as ⟦U#⟧ are interfaces this script had to guess; each is listed in `UNRESOLVED.md` — confirm before treating the step as authoritative.
- All fixture vectors are 4-dimensional and L2-normalised; they represent semantic similarity structure, not real embeddings.

---

## 1 · Cold Open — The Hook

🎬 **Scene.** Riya's on-call rotation starts at 06:00. By 06:15 her monitoring dashboard shows 340 new support tickets filed in the last two hours — all related to a database outage. At least half look like duplicates: the same error, slightly rephrased. Meanwhile the error-log aggregation pipeline has emitted 40+ distinct error codes, but the oncall lead suspects they collapse into three or four root-cause families. Riya needs to (1) deduplicate the incoming ticket flood, (2) group error logs into incident families, and (3) rank which clusters deserve attention first — before assigning engineers. She has a budget of 30 minutes, a single SQLite file, and zero tolerance for a non-deterministic pipeline that gives different answers when replayed from the same snapshot.

> **The promise we will prove in the next 15 minutes:** `npm install @adhd/sox-analysis` and you get deterministic corpus intelligence — near-duplicate detection, community clustering, and importance scoring — with no LLM call, no API key, and no external vector database. Feed the same noisy corpus twice; get the same clusters both times, byte-for-byte.

🔗 **Proves (framing):** REQ-001 · CAP-001
📎 **Source:** `docs/plan/memory-refactor/USE_CASES.md` §UC-ANA-1..5, SYS-6, SYS-7; `docs/plan/memory-refactor/SCOPE.md` Part A

---

## 2 · Cast, World & Cold-Start Setup

### 2.1 Meet Riya

Riya is a backend platform engineer at a B2B SaaS company. Her goal today: build a reproducible incident-triage pipeline that groups incoming error logs into families and flags near-duplicate tickets before they are routed to engineers. She is comfortable with JavaScript and SQLite; she has never used `@adhd/sox-analysis` before. She does not have a GPU, a paid embedding API key, or an external vector database — and she does not want them.

### 2.2 The Canonical Demo Dataset

Eight error-log items across three semantic families, with pre-computed 4-dimensional L2-normalised embedding vectors. These vectors serve as a reproducible proxy for real embeddings: cosine similarity within a family is ≥ 0.998 (well above any reasonable near-dup threshold); cosine similarity across families is 0.0 (orthogonal).

```js
// fixture.mjs — canonical corpus; reused across all beats
export const MODEL_ID = 'demo-v1';   // embedding-space identity recorded on all outputs
export const DIM = 4;
export const THRESHOLD_NEARDUP = 0.95;   // near-dup fires above this
export const THRESHOLD_CLUSTER  = 0.82;  // cluster link fires above this

export const CORPUS = [
  // Family A — connection timeout (3 items; ep-001 / ep-002 are near-dupes)
  { id: 1, uid: 'ep-001', content: 'Connection timeout: upstream service unreachable after 30s retry',          vec: Float32Array.from([1.0000, 0.0000, 0.0000, 0.0000]) },
  { id: 2, uid: 'ep-002', content: 'Connection timeout: DB pool exhausted, upstream retry failed after 30s',    vec: Float32Array.from([0.9998, 0.0200, 0.0000, 0.0000]) },
  { id: 3, uid: 'ep-003', content: 'Connection timeout to cache layer; retry budget exceeded',                  vec: Float32Array.from([0.9980, 0.0632, 0.0000, 0.0000]) },
  // Family B — out of memory (3 items; ep-004 / ep-005 are near-dupes)
  { id: 4, uid: 'ep-004', content: 'Out of memory: heap allocation failed, process killed by OOM killer',       vec: Float32Array.from([0.0000, 1.0000, 0.0000, 0.0000]) },
  { id: 5, uid: 'ep-005', content: 'OOM killer terminated worker: heap limit 512 MB exceeded',                  vec: Float32Array.from([0.0000, 0.9998, 0.0200, 0.0000]) },
  { id: 6, uid: 'ep-006', content: 'Memory allocation failure in allocator; OOM, worker restarting',            vec: Float32Array.from([0.0000, 0.9980, 0.0632, 0.0000]) },
  // Family C — disk I/O (2 items)
  { id: 7, uid: 'ep-007', content: 'Disk I/O error: write failed on /var/log/app, no space left on device',     vec: Float32Array.from([0.0000, 0.0000, 1.0000, 0.0000]) },
  { id: 8, uid: 'ep-008', content: 'I/O error: /var/data/db.sqlite write failed, storage full',                 vec: Float32Array.from([0.0000, 0.0000, 0.9998, 0.0200]) },
];
```

Cosine-similarity invariants for verification:
- `cosine(ep-001, ep-002)` = 0.9998 → near-dup pair (A)
- `cosine(ep-004, ep-005)` = 0.9998 → near-dup pair (B)
- `cosine(ep-001, ep-004)` = 0.0 → different families, never a near-dup

### 2.3 Prerequisites

- Node.js ≥ 18 (ESM support required)
- `npm` ≥ 9
- No existing `node_modules` or workspace in the working directory
- `@adhd/sox-analysis` ≥ 0.1.0 published to npm (this demo is the acceptance contract for that publish)

### 2.4 Cold Start — From Nothing to Running

▶️ **Do**
```bash
mkdir riya-triage && cd riya-triage
npm init -y
npm install @adhd/sox-analysis
```

Then verify no private `@adhd` dep leaked into the installed package:
```bash
node -e "
  const pkg = require('./node_modules/@adhd/sox-analysis/package.json');
  const runtimeDeps = Object.keys(pkg.dependencies ?? {});
  const adhd = runtimeDeps.filter(d => d.startsWith('@adhd/'));
  if (adhd.length) { console.error('FAIL private dep:', adhd); process.exit(1); }
  console.log('OK — no @adhd runtime deps:', runtimeDeps.join(', ') || '(none)');
"
```

Then confirm the exports resolve:
```bash
node --input-type=module <<'EOF'
import {
  computeImportance,
  clusterStore,
  detectNearDup,
  buildAutoLinks,
  runBatchEnrich,
} from '@adhd/sox-analysis';
const all = [computeImportance, clusterStore, detectNearDup, buildAutoLinks, runBatchEnrich];
if (all.some(f => typeof f !== 'function')) throw new Error('export missing');
console.log('OK — all 5 exports are functions');
EOF
```

👀 **Expect**
```
OK — no @adhd runtime deps: better-sqlite3, sqlite-vec
OK — all 5 exports are functions
```

(Runtime deps will include `better-sqlite3`, `sqlite-vec`, and the JS clustering lib; the exact list may vary. The assertion is zero `@adhd/sox-*` entries.)

✅ **Verify**
- [ ] `npm install` exits 0 with no `ERESOLVE` errors
- [ ] Zero `@adhd/` entries in `dependencies` of the installed `package.json`
- [ ] All five named exports (`computeImportance`, `clusterStore`, `detectNearDup`, `buildAutoLinks`, `runBatchEnrich`) resolve as functions

🔗 **Proves:** REQ-001 · REQ-002 · REQ-010 · CAP-001
📎 **Source:** `docs/plan/memory-refactor/scripts/pack-smoke.mjs` §analysis smoke; `docs/decisions/0006-*.md` §Consequences (zero `@adhd` runtime deps); `docs/plan/memory-refactor/contexts/w2d-analysis.md` [w2d-analysis.1]

---

## 3 · The Journey

### Act 1 — Importance Scoring

Riya's first task is simple: before clustering, she wants to score incoming tickets by how much attention they deserve, using only the metadata she already has — word count, link degree (how many related items reference them), access count (how many engineers already looked), and tag count. `computeImportance` is a pure function — no DB, no network — so she can run it in the ingest path at zero marginal cost.

#### 1.1 · Score a High-Traffic Error (happy)

🎬 **Scene.** `ep-001` has been viewed by 8 engineers, linked by 4 related items, and carries 3 tags. Riya scores it to confirm it will surface at the top of the triage queue.

▶️ **Do**
```js
// importance-demo.mjs
import { computeImportance } from '@adhd/sox-analysis';

const score = computeImportance({
  word_count:   12,   // "Connection timeout: upstream service unreachable after 30s retry"
  link_degree:   4,   // 4 related items reference this episode
  access_count:  8,   // 8 engineers have viewed it
  tag_count:     3,   // tagged: timeout, upstream, critical
});

console.log('importance:', score.toFixed(4));
// expected: 4.0*(12/50) + 3.0*(4/5) + 2.0*(8/10) + 1.0*(3/3)
//         = 4.0*0.24   + 3.0*0.80  + 2.0*0.80  + 1.0*1.0
//         = 0.96 + 2.40 + 1.60 + 1.00 = 5.96  → clamped to [1,10] = 5.96
```

👀 **Expect**
```
importance: 5.9600
```

✅ **Verify**
- [ ] Output is `5.9600` (deterministic formula; same inputs → same output on any machine)
- [ ] Value is in [1.0, 10.0]

🔗 **Proves:** REQ-008 · REQ-011 · CAP-004
📎 **Source:** `libs/memory-enrich/src/importance.ts` — `computeImportance` formula documented in header; ImportanceInputs type verified there.

#### 1.2 · Sparse New Error Hits the Floor ⚠️ (edge)

🎬 **Scene.** A brand-new error just appeared — no links, no views, no tags, minimal content. Riya confirms it scores at the minimum floor rather than zero, proving the function is well-bounded even for empty inputs.

▶️ **Do**
```js
import { computeImportance } from '@adhd/sox-analysis';

const floor = computeImportance({ word_count: 0, link_degree: 0, access_count: 0, tag_count: 0 });
console.log('floor score:', floor.toFixed(4));
```

👀 **Expect**
```
floor score: 1.0000
```

✅ **Verify**
- [ ] Score is exactly `1.0` — the formula's `Math.max(1.0, ...)` clamp fires

🔗 **Proves:** REQ-008 · REQ-011 · CAP-004
📎 **Source:** `libs/memory-enrich/src/importance.ts` line 68 — `return Math.max(1.0, Math.min(10.0, raw))`

---

### Act 2 — Near-Duplicate Detection

With importance scoring working, Riya turns to the flood of incoming tickets. She knows most are near-duplicates of `ep-001` — rephrased versions of the same "connection timeout" event filed by different users. She will use `detectNearDup` to identify them before they reach the triage queue.

First, she sets up the in-memory store. `detectNearDup` works over a live DB with the graph + vector schema applied — the same schema that `@adhd/sox-graph-store` and `@adhd/sox-vector-store` (public deps of `@adhd/sox-analysis`) create:

▶️ **Do**
```js
// db-setup.mjs — shared helper for all remaining beats
import Database from 'better-sqlite3';
import { applyGraphSchema } from '@adhd/sox-graph-store';
import { applyVecSchema, upsertVector } from '@adhd/sox-vector-store';

export function buildDb() {
  const db = new Database(':memory:');
  applyGraphSchema(db);
  applyVecSchema(db, { dim: 4, modelId: 'demo-v1' });
  return db;
}

// insertItem: write one corpus item into node + vec_node.
// U1: exact node INSERT columns derived from applyGraphSchema — see UNRESOLVED.md.
export function insertItem(db, { uid, content, modelId = 'demo-v1', vec }) {
  const info = db.prepare(`
    INSERT INTO node (uid, content, source, importance, t_created, t_valid)
    VALUES (?, ?, 'observation', 1.0, datetime('now'), datetime('now'))
  `).run(uid, content);
  upsertVector(db, info.lastInsertRowid, vec, { modelId });
  return info.lastInsertRowid;
}
```

📎 **Source:** `docs/plan/memory-refactor/scripts/pack-smoke.mjs` — `applyGraphSchema`, `applyVecSchema`, `upsertVector` imports grounded there; ⟦U1⟧ on the INSERT column list — see UNRESOLVED.md.

#### 2.1 · Two Near-Identical Timeout Errors — Dup Found (happy)

🎬 **Scene.** `ep-001` and `ep-002` are two phrasings of the same "connection timeout" event (cosine = 0.9998). Riya inserts `ep-001` first, then inserts `ep-002` and calls `detectNearDup` to confirm it is flagged as a duplicate.

▶️ **Do**
```js
import { detectNearDup } from '@adhd/sox-analysis';
import { buildDb, insertItem } from './db-setup.mjs';
import { CORPUS, THRESHOLD_NEARDUP } from './fixture.mjs';

const db  = buildDb();
const r1  = insertItem(db, CORPUS[0]);   // ep-001 — the original
const r2  = insertItem(db, CORPUS[1]);   // ep-002 — the near-duplicate

const result = detectNearDup(db, r2, CORPUS[1].vec, THRESHOLD_NEARDUP);
console.log('existing_uid:     ', result?.existing_uid);
console.log('cosine_sim:       ', result?.cosine_sim.toFixed(4));
console.log('should_invalidate:', result?.should_invalidate);
```

👀 **Expect**
```
existing_uid:      ep-001
cosine_sim:        0.9998
should_invalidate: true
```

✅ **Verify**
- [ ] `result` is non-null (a near-dup was found)
- [ ] `existing_uid` is `'ep-001'`
- [ ] `cosine_sim` is ≥ 0.95 (above the THRESHOLD_NEARDUP)
- [ ] `should_invalidate` is `true`

🔗 **Proves:** REQ-006 · CAP-002
📎 **Source:** `libs/memory-enrich/src/neardup.ts` — `detectNearDup` signature and NearDupResult type; `docs/plan/memory-refactor/USE_CASES.md` UC-ANA-2, SYS-6.

#### 2.2 · Two Clearly Different Errors — No Dup (happy)

🎬 **Scene.** `ep-001` (connection timeout) and `ep-004` (out of memory) are orthogonal in the embedding space (cosine = 0.0). Riya confirms `detectNearDup` correctly returns `null`, so the OOM ticket reaches the queue independently.

▶️ **Do**
```js
import { detectNearDup } from '@adhd/sox-analysis';
import { buildDb, insertItem } from './db-setup.mjs';
import { CORPUS, THRESHOLD_NEARDUP } from './fixture.mjs';

const db  = buildDb();
const r1  = insertItem(db, CORPUS[0]);   // ep-001
const r4  = insertItem(db, CORPUS[3]);   // ep-004 — orthogonal family

const result = detectNearDup(db, r4, CORPUS[3].vec, THRESHOLD_NEARDUP);
console.log('dup result:', result);
```

👀 **Expect**
```
dup result: null
```

✅ **Verify**
- [ ] `result` is `null` — no near-dup found for ep-004 when only ep-001 is in the store

🔗 **Proves:** REQ-006 · CAP-002
📎 **Source:** `libs/memory-enrich/src/neardup.ts` — cosine-based KNN scan with threshold gate; fixture invariant `cosine(ep-001, ep-004) = 0.0`.

#### 2.3 · Threshold at 1.0 — Nothing Ever Fires ⚠️ (edge)

🎬 **Scene.** Riya briefly cranks the threshold to 1.0 (exact-match only) to confirm the near-dup guard is gated strictly: even ep-001 and ep-002 at 0.9998 similarity no longer fire.

▶️ **Do**
```js
import { detectNearDup } from '@adhd/sox-analysis';
import { buildDb, insertItem } from './db-setup.mjs';
import { CORPUS } from './fixture.mjs';

const db  = buildDb();
const r1  = insertItem(db, CORPUS[0]);
const r2  = insertItem(db, CORPUS[1]);

const result = detectNearDup(db, r2, CORPUS[1].vec, 1.0);
console.log('at threshold 1.0:', result);
```

👀 **Expect**
```
at threshold 1.0: null
```

✅ **Verify**
- [ ] `result` is `null` — no exact-match duplicate in a corpus of two near-dup items at cosine 0.9998

🔗 **Proves:** REQ-006 · CAP-002
📎 **Source:** `libs/memory-enrich/src/neardup.ts` line 97 — `if (bestSim < threshold) return null`

---

### Act 3 — Corpus Clustering

Near-dup detection handles the incoming flood one ticket at a time. Now Riya turns to the existing error-log corpus: 8 items she has already ingested. She needs them clustered into incident families so she can assign one engineer per family rather than 8.

#### 3.1 · Cluster the Full Corpus into Incident Families (happy)

🎬 **Scene.** All 8 corpus items are in the DB. Riya calls `clusterStore` with the cluster threshold and expects three communities: "connection timeout", "out of memory", and "disk I/O".

▶️ **Do**
```js
import { clusterStore } from '@adhd/sox-analysis';
import { buildDb, insertItem } from './db-setup.mjs';
import { CORPUS, THRESHOLD_CLUSTER } from './fixture.mjs';

const db = buildDb();
for (const item of CORPUS) insertItem(db, item);

const result = clusterStore(db, { threshold: THRESHOLD_CLUSTER });

console.log('communities:       ', result.clusters.length);
console.log('unclustered:       ', result.unclustered_count);
console.log('full_pass:         ', result.full_pass);

for (const c of result.clusters) {
  console.log(`  [${c.community_uid.slice(0, 8)}] "${c.label}" — ${c.member_rowids.length} members, mean_intra_sim=${c.mean_intra_sim.toFixed(4)}`);
}
```

👀 **Expect**
```
communities:        3
unclustered:        0
full_pass:          true
  [⟨uid-A⟩] "Connection timeout: upstream service unreachable after 30s retry" — 3 members, mean_intra_sim=⟨≥0.9980⟩
  [⟨uid-B⟩] "Out of memory: heap allocation failed, process killed by OOM killer" — 3 members, mean_intra_sim=⟨≥0.9980⟩
  [⟨uid-C⟩] "Disk I/O error: write failed on /var/log/app, no space left on device" — 2 members, mean_intra_sim=⟨≥0.9998⟩
```

(Community UIDs are sha256-derived from sorted member rowids — stable but not human-predictable; label is the centroid-nearest member's content.)

✅ **Verify**
- [ ] `clusters.length` is exactly 3
- [ ] `unclustered_count` is 0
- [ ] `full_pass` is `true`
- [ ] Each cluster has ≥ 2 members (singleton suppression — D1.6)
- [ ] `mean_intra_sim` for each cluster is ≥ 0.95 (tight semantic family)

🔗 **Proves:** REQ-007 · CAP-003
📎 **Source:** `libs/memory-enrich/src/cluster.ts` — ClusterResult, ClusterStoreOptions, ClusterStoreResult; `docs/plan/memory-refactor/contexts/w2d-analysis.md` §Delta Spec; `docs/plan/memory-refactor/USE_CASES.md` UC-ANA-1, SYS-7.

#### 3.2 · Re-Cluster the Same Corpus — Identical community_uids (happy)

🎬 **Scene.** Riya runs the pipeline from the same DB snapshot a second time — this is the replay scenario. She checks that every `community_uid` matches the first run byte-for-byte, proving the pipeline is safe to re-run without producing drift.

▶️ **Do**
```js
import { clusterStore } from '@adhd/sox-analysis';
import { buildDb, insertItem } from './db-setup.mjs';
import { CORPUS, THRESHOLD_CLUSTER } from './fixture.mjs';

const db = buildDb();
for (const item of CORPUS) insertItem(db, item);

const run1 = clusterStore(db, { threshold: THRESHOLD_CLUSTER });
const run2 = clusterStore(db, { threshold: THRESHOLD_CLUSTER });

const uids1 = run1.clusters.map(c => c.community_uid).sort();
const uids2 = run2.clusters.map(c => c.community_uid).sort();

const match = JSON.stringify(uids1) === JSON.stringify(uids2);
console.log('community_uids match:', match);
console.log('run1 UIDs:', uids1.map(u => u.slice(0, 8)));
console.log('run2 UIDs:', uids2.map(u => u.slice(0, 8)));
```

👀 **Expect**
```
community_uids match: true
run1 UIDs: [ '⟨uid-A⟩', '⟨uid-B⟩', '⟨uid-C⟩' ]
run2 UIDs: [ '⟨uid-A⟩', '⟨uid-B⟩', '⟨uid-C⟩' ]
```

(The abbreviated UIDs must be byte-identical across both runs.)

✅ **Verify**
- [ ] `match` is `true`
- [ ] `uids1` and `uids2` are equal arrays (order-independent)

🔗 **Proves:** REQ-003 · CAP-005
📎 **Source:** `libs/memory-enrich/src/cluster.ts` header — "community UID = sha256(sorted member rowids joined by ',').slice(0,32)" — determinism guarantee D1.2/D1.4; `docs/plan/memory-refactor/contexts/w2d-analysis.md` [w2d-analysis.2].

#### 3.3 · Subset Clustering on One Incident Family (happy)

🎬 **Scene.** Riya wants to drill into the "connection timeout" family only — perhaps that sub-corpus changed after a hotfix and she needs to re-cluster just that slice without disturbing the global partition. `clusterSubset` runs a filtered pass.

▶️ **Do**
```js
import { clusterSubset } from '@adhd/sox-analysis';
import { buildDb, insertItem } from './db-setup.mjs';
import { CORPUS, THRESHOLD_CLUSTER } from './fixture.mjs';

const db = buildDb();
for (const item of CORPUS) insertItem(db, item);

// Filter to the three "ep-00[1-3]" items only.
// U2: MemoryFilter shape — see UNRESOLVED.md for exact field names.
const subsetResult = clusterSubset(db, { uid_prefix: 'ep-00' }, { threshold: THRESHOLD_CLUSTER });

console.log('subset communities:', subsetResult.clusters.length);
console.log('subset unclustered:', subsetResult.unclustered_count);
```

👀 **Expect**
```
subset communities: 1
subset unclustered: 0
```

✅ **Verify**
- [ ] `clusters.length` is 1 (the three timeout items form a single community in the subset pass)
- [ ] `unclustered_count` is 0

🔗 **Proves:** REQ-009 · CAP-007
📎 **Source:** `libs/memory-enrich/src/cluster.ts` line 589 — `clusterSubset(db, filter, opts?)` → ClusterSubsetResult; `docs/plan/memory-refactor/contexts/w2d-analysis.md` [w2d-analysis.5]; ⟦U2⟧ on filter shape — see UNRESOLVED.md.

---

## 4 · The Climax — Deterministic Batch Intelligence in One Call

🎬 **Scene.** Riya has proven each primitive individually. Now she runs the full pipeline the way a real observability system would: one call to `runBatchEnrich` on the complete 8-item corpus. In a single transaction it derives communities, updates importance scores for every item, and links related items via shared entity mentions. Then she replays it from the same snapshot. Same corpus in — same counts out. No drift, no phantom communities, no orphaned importance scores. This is what it means to build a deterministic incident-triage pipeline on top of `@adhd/sox-analysis`.

▶️ **Do**
```js
// climax.mjs
import { runBatchEnrich } from '@adhd/sox-analysis';
import { buildDb, insertItem } from './db-setup.mjs';
import { CORPUS, THRESHOLD_CLUSTER, THRESHOLD_NEARDUP } from './fixture.mjs';

const db = buildDb();
for (const item of CORPUS) insertItem(db, item);

console.log('=== Run 1 ===');
const r1 = await runBatchEnrich(db, {
  clusterThreshold:  THRESHOLD_CLUSTER,
  nearDupThreshold:  THRESHOLD_NEARDUP,
});
console.log('communities_upserted:', r1.communities_upserted);
console.log('importance_updated:  ', r1.importance_updated);
console.log('member_of_edges:     ', r1.member_of_edges);

console.log('\n=== Run 2 (replay) ===');
const r2 = await runBatchEnrich(db, {
  clusterThreshold:  THRESHOLD_CLUSTER,
  nearDupThreshold:  THRESHOLD_NEARDUP,
});
console.log('communities_upserted:', r2.communities_upserted);
console.log('importance_updated:  ', r2.importance_updated);
console.log('member_of_edges:     ', r2.member_of_edges);

const stable = ['communities_upserted', 'importance_updated', 'member_of_edges'];
const drifted = stable.filter(k => r1[k] !== r2[k]);
console.log('\ndrifted fields:', drifted.length ? drifted : 'none');
```

👀 **Expect**
```
=== Run 1 ===
communities_upserted: 3
importance_updated:   8
member_of_edges:      8

=== Run 2 (replay) ===
communities_upserted: 3
importance_updated:   8
member_of_edges:      8

drifted fields: none
```

✅ **Verify**
- [ ] `communities_upserted` is 3 (Family A, B, C — matching the clusterStore beat)
- [ ] `importance_updated` is 8 (all corpus items scored)
- [ ] `member_of_edges` is 8 (every clustered item gets a MEMBER_OF edge)
- [ ] `drifted fields` is `none` — Run 1 and Run 2 produce identical counts
- [ ] No exception thrown on either run

🔗 **Proves:** REQ-003 · REQ-005 · REQ-007 · REQ-008 · CAP-003 · CAP-004 · CAP-005
📎 **Source:** `libs/memory-enrich/src/batch.ts` — BatchEnrichOptions, BatchEnrichResult (communities_upserted, importance_updated, member_of_edges confirmed); `docs/plan/memory-refactor/contexts/w2d-analysis.md` §Goal — "batch derivation over a corpus"; `docs/plan/memory-refactor/USE_CASES.md` SYS-6, SYS-7, UC-ANA-4.

---

## 5 · Resilience Sweep — Edges Not Hit in the Story

#### 5.1 · ⚠️ Empty Corpus — Zero Communities, No Crash

▶️ **Do**
```js
import { clusterStore } from '@adhd/sox-analysis';
import { buildDb } from './db-setup.mjs';

const db = buildDb();   // no items inserted
const result = clusterStore(db, { threshold: 0.82 });
console.log('clusters:', result.clusters.length, 'unclustered:', result.unclustered_count);
```
👀 **Expect** — `clusters: 0 unclustered: 0`
✅ **Verify**
- [ ] No exception thrown; `clusters.length` is 0

🔗 **Proves:** REQ-007 · CAP-003
📎 **Source:** `libs/memory-enrich/src/cluster.ts` — clusterStore returns ClusterStoreResult with empty clusters array on zero-row corpus; `docs/plan/memory-refactor/SCOPE.md` Part A (batch, not per-query).

#### 5.2 · ⚠️ computeImportance All-Zeros Hits the Floor

▶️ **Do**
```js
import { computeImportance } from '@adhd/sox-analysis';
const s = computeImportance({ word_count: 0, link_degree: 0, access_count: 0, tag_count: 0 });
console.log('floor:', s);
```
👀 **Expect** — `floor: 1`
✅ **Verify**
- [ ] Returns exactly `1` (the `Math.max(1.0, ...)` clamp; not 0 or negative)

🔗 **Proves:** REQ-008 · CAP-004
📎 **Source:** `libs/memory-enrich/src/importance.ts` line 68 — clamp formula.

#### 5.3 · ⚠️ detectNearDup on a Single-Item Store Returns null

▶️ **Do**
```js
import { detectNearDup } from '@adhd/sox-analysis';
import { buildDb, insertItem } from './db-setup.mjs';
import { CORPUS, THRESHOLD_NEARDUP } from './fixture.mjs';

const db = buildDb();
const r1 = insertItem(db, CORPUS[0]);   // only one item — no neighbour to match against

const result = detectNearDup(db, r1, CORPUS[0].vec, THRESHOLD_NEARDUP);
console.log('single-item store result:', result);
```
👀 **Expect** — `single-item store result: null`
✅ **Verify**
- [ ] `result` is `null` (KNN returns only self; self is excluded; neighbour set is empty)

🔗 **Proves:** REQ-006 · CAP-002
📎 **Source:** `libs/memory-enrich/src/neardup.ts` line 78-82 — `filter(r => r.node_id !== rowid)` + early return on empty knnRows.

#### 5.4 · ⚠️ modelId Provenance Recorded on Cluster Output

🎬 **Scene.** Riya inserts items under `modelId = 'demo-v1'` and checks that the cluster community written to the DB records this model identity so a future model swap is detectable.

▶️ **Do**
```js
import { clusterStore } from '@adhd/sox-analysis';
import { buildDb, insertItem } from './db-setup.mjs';
import { CORPUS, THRESHOLD_CLUSTER } from './fixture.mjs';

const db = buildDb();
for (const item of CORPUS) insertItem(db, item);

clusterStore(db, { threshold: THRESHOLD_CLUSTER });

// Community nodes are written to the node table. The modelId they were
// computed under is recorded per [w2d-analysis.3] / [inv:space].
// U3: exact column name / metadata key for modelId on community nodes — see UNRESOLVED.md.
const communities = db.prepare(
  `SELECT uid, json_extract(meta, '$.model_id') AS model_id FROM node WHERE source = 'community' AND t_invalid IS NULL`
).all();

console.log('community count:', communities.length);
communities.forEach(c => console.log(`  ${c.uid.slice(0, 8)} model_id=${c.model_id}`));
```

👀 **Expect**
```
community count: 3
  ⟨uid-A⟩ model_id=demo-v1
  ⟨uid-B⟩ model_id=demo-v1
  ⟨uid-C⟩ model_id=demo-v1
```

✅ **Verify**
- [ ] `community count` is 3
- [ ] Each community row has `model_id = 'demo-v1'` (matching the MODEL_ID in fixture.mjs)

🔗 **Proves:** REQ-004 · CAP-006
📎 **Source:** `docs/plan/memory-refactor/contexts/w2d-analysis.md` [w2d-analysis.3] — "similarity-derived outputs record the modelId they were computed under"; ⟦U3⟧ on exact meta key name — see UNRESOLVED.md.

---

## 6 · Teardown — Back to Zero

▶️ **Do**
```bash
# In-memory DBs have no persistent state — closing the process is sufficient.
# For a file-based DB, close explicitly:
node --input-type=module <<'EOF'
import Database from 'better-sqlite3';
import { applyGraphSchema } from '@adhd/sox-graph-store';
const db = new Database('/tmp/triage-test.sqlite');
applyGraphSchema(db);
db.close();
import { existsSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
if (existsSync('/tmp/triage-test.sqlite')) unlinkSync('/tmp/triage-test.sqlite');
console.log('DB closed and file removed');
EOF

# Remove the demo install directory
cd .. && rm -rf riya-triage
echo "Teardown complete"
```

👀 **Expect**
```
DB closed and file removed
Teardown complete
```

✅ **Verify**
- [ ] `/tmp/triage-test.sqlite` does not exist after teardown
- [ ] `riya-triage/` directory is gone
- [ ] No background processes left (all beats are synchronous / in-process)

🔗 **Proves:** REQ-001 · CAP-001
📎 **Source:** `docs/plan/memory-refactor/scripts/pack-smoke.mjs` — tmpdir cleanup pattern (fs.rmSync recursive); no persistent daemon in the analysis package.

---

## 7 · Coverage & Traceability Matrix

### 7.1 Requirements → Beats

| Req ID | Requirement (short) | Proven by beat(s) | Paths covered (H/E/R) | Status |
|---|---|---|---|---|
| REQ-001 | Standalone install — no `@adhd` private runtime deps | §2.4 Install, §6 Teardown | H | ☐ |
| REQ-002 | Exports `clusterStore`, `clusterSubset`, `detectNearDup`, `computeImportance`, `buildAutoLinks`, `runBatchEnrich` | §2.4 Install | H | ☐ |
| REQ-003 | Clustering deterministic — same input → same community_uid | §3.2 Re-cluster, §4 Climax | H | ☐ |
| REQ-004 | Similarity outputs record modelId (inv:space) | §5.4 modelId provenance | H | ☐ |
| REQ-005 | Batch-only — no per-query entry point | §4 Climax (runBatchEnrich is the only entry; no per-query fn) | H | ☐ |
| REQ-006 | Near-dup detection returns pair above threshold, null below | §2.1 Dup found, §2.2 No dup, §2.3 Threshold 1.0, §5.3 Single-item | H/E | ☐ |
| REQ-007 | Clustering partitions corpus into communities ≥2 members; singletons suppressed | §3.1 Cluster full corpus, §4 Climax, §5.1 Empty corpus | H/E | ☐ |
| REQ-008 | Importance in [1.0, 10.0], formula: length+link+access+tag blend | §1.1 High-traffic, §1.2 Floor, §5.2 All-zeros | H/E | ☐ |
| REQ-009 | `clusterSubset` + `dropSubsetLens` / `listSubsetLenses` parity | §3.3 Subset clustering | H | ☐ |
| REQ-010 | Bundled `.d.ts` types ship with tarball | §2.4 Install (import resolves with full types) | H | ☐ |
| REQ-011 | `computeImportance` pure function — no DB, no I/O | §1.1, §1.2, §5.2 (no DB argument, no await) | H/E | ☐ |

### 7.2 Capabilities → Beats

| Cap ID | Capability | Proven by beat(s) | Status |
|---|---|---|---|
| CAP-001 | Standalone install — no private `@adhd` transitive deps | §2.4 Install, §6 Teardown | ☐ |
| CAP-002 | Near-duplicate detection | §2.1, §2.2, §2.3, §5.3 | ☐ |
| CAP-003 | Corpus clustering into communities | §3.1, §4 Climax, §5.1 | ☐ |
| CAP-004 | Deterministic importance scoring | §1.1, §1.2, §5.2 | ☐ |
| CAP-005 | Determinism guarantee — byte-identical on re-run | §3.2, §4 Climax | ☐ |
| CAP-006 | modelId provenance on similarity outputs | §5.4 | ☐ |
| CAP-007 | Subset / filtered clustering | §3.3 | ☐ |

### 7.3 Unresolved Interfaces & Gaps

3 interface stubs (⟦U1⟧–⟦U3⟧) and 1 scope gap; full list in `UNRESOLVED.md`. Highest-impact items to resolve before implementation begins:

- **⟦U1⟧** — exact `node` table INSERT columns emitted by `applyGraphSchema` (affects all beats that write corpus items)
- **⟦U2⟧** — `clusterSubset` filter parameter shape (`MemoryFilter` field names)
- **⟦U3⟧** — modelId meta key name in community node rows ([w2d-analysis.3])
- **Scope gap** — `dropSubsetLens` and `listSubsetLenses` are listed in REQ-009 / [w2d-analysis.5] but not exercised by a full beat; only `clusterSubset` is shown. Add beats once ⟦U2⟧ is resolved.

---

## 8 · Sign-Off

| Field | Value |
|---|---|
| Environment | ⟨OS / Node version / commit SHA⟩ |
| Run by | ⟨name or agent ID⟩ |
| Date | ⟨date⟩ |
| Beats passed | ⟨X of Y⟩ |
| Requirements proven | ⟨X of Y⟩ |
| Result | ☐ PASS &nbsp;&nbsp; ☐ FAIL |
| Notes / defects filed | ⟨…⟩ |

> A run is **PASS** only if every ✅ assertion is checked and every requirement in §7 is proven. One unchecked binary assertion = FAIL until resolved.
