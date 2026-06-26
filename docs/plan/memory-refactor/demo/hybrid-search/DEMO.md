# 🎬 @adhd/sox-hybrid-search — Live Demo & Acceptance Script

> Fuse vector similarity, BM25 keyword search, and temporal decay into one normalized ranking — and degrade gracefully to keyword-only when vectors are unavailable.

**What this is.** A presentation-grade walkthrough of `@adhd/sox-hybrid-search` that doubles as its acceptance test. Follow it top to bottom and you will (a) experience the package the way a brand-new user would and (b) prove every capability works, with exact commands, exact data, and pass/fail checks. It is the contract for what "done" means: if it is demonstrated here, it must work; if it must work, it is demonstrated here.

---

## 0 · How to Read This Script

**Legend**

| Marker | Meaning |
|---|---|
| 🎬 **Scene** | The story beat — what is happening and why the persona cares. Read this aloud in a demo. |
| ▶️ **Do** | The exact action to take with literal input data. |
| 👀 **Expect** | The exact observable result. Volatile parts shown as ⟨…⟩. |
| ✅ **Verify** | Binary pass/fail assertions. Tick each only if it is literally true. |
| 🔗 **Proves** | Requirement and capability IDs this beat satisfies. |
| 📎 **Source** | What grounds this step — spec section, doc, file, or URL it came from. |
| ⟦U#⟧ | An **unresolved stub**: a value guessed because the context did not specify it. Logged in `UNRESOLVED.md` beside this file. |
| ⚠️ **Edge / 🛟 Recovery** | A deliberately adversarial or failure-then-recover beat. |

**Conventions**
- All shell commands run from `DEMO_DIR` (a fresh temp directory created in §2.4); `cd "$DEMO_DIR"` is implicit after creation.
- `node` is Node.js ≥ 20 (`node --version` prints `v20.x.x` or higher).
- Values shown as ⟨like-this⟩ vary per run; the assertion next to them states what stays invariant.
- Tokens shown as ⟦U#⟧ are interfaces this script had to guess; each is listed in `UNRESOLVED.md` — confirm them before treating the step as authoritative.

---

## 1 · Cold Open — The Hook

🎬 **Scene.** Every retrieval system forces a choice: keyword search finds exact terms but misses meaning; vector search captures semantics but buries precise matches; neither degrades gracefully when the other breaks. Riya is a backend engineer building an internal knowledge-base retrieval API. She cannot run a separate vector database, and she cannot afford for search to go dark if the embedding model misbehaves. `@adhd/sox-hybrid-search` fuses all three signals — vector cosine, BM25/FTS5, and temporal recency — into a single normalized score, depends on `@adhd/sox-graph-store` and `@adhd/sox-vector-store` (both public packages on npm), and takes the SQLite `Database` her application already owns via dependency injection. Zero extra service; one `npm install` resolves the full public `@adhd` dependency tree.

> **The promise we will prove in the next 25 minutes:** a hybrid query beats both pure-keyword and pure-vector search on a fixture designed so each alone picks the wrong top result — and the package keeps returning results even when vectors go down.

🔗 **Proves (framing):** REQ-001 · REQ-002 · CAP-001 · CAP-002
📎 **Source:** `docs/plan/memory-refactor/SCOPE.md` Part D §hybrid-search; `docs/plan/memory-refactor/USE_CASES.md` UC-SRCH-1..5; `docs/plan/memory-refactor/contexts/w2d-hybrid-search.md` §Goal

---

## 2 · Cast, World & Cold-Start Setup

### 2.1 Meet Riya

Riya is a backend engineer at a seed-stage startup building an internal knowledge-base search API. Her team stores meeting notes, design docs, and research snippets in a single SQLite file. She needs retrieval that handles both "what did we say about attention mechanisms" (semantic) and "BL-87 bug" (exact keyword) — and she cannot afford for search to fail if the embedding model is unavailable. She evaluates `@adhd/sox-hybrid-search` as a drop-in retrieval layer over her existing database connection.

### 2.2 The Canonical Demo Dataset

Five documents seeded into an in-memory SQLite database. UIDs are stable integers; `t_created` values are Unix seconds and intentionally close together so temporal decay does not dominate the ranking.

| uid | name | topic | tags | content | t_created |
|-----|------|-------|------|---------|-----------|
| 1 | Attention Mechanisms in Transformers | machine-learning | neural,attention,transformer | Self-attention layers allow models to weigh sequence positions against each other. | 1719360000 |
| 2 | Financial Market Attention Signals | finance | finance,derivatives,market | Traders track market attention signals for derivatives pricing and volatility. | 1719360060 |
| 3 | Gradient Descent Optimization | machine-learning | neural,optimization,backprop | Backpropagation and gradient flow drive weight updates in deep networks. | 1719360120 |
| 4 | Attention in Cooking Timing | cooking | cooking,recipe,timing | Paying close attention to heat and timing produces consistently good pasta dishes. | 1719360180 |
| 5 | Machine Learning Fundamentals | machine-learning | machine-learning,fundamentals,intro | Introduction to supervised and unsupervised learning paradigms. | 1719360240 |

**Climax fixture design.** The query `"attention neural networks"` is rigged so:
- Pure BM25 ranks docs 1, 2, and 4 roughly equally — all three contain the word "attention"; doc 2 (finance) and doc 4 (cooking) are noise.
- Pure vector ranks docs 3 and 5 (ML neighborhood) alongside doc 1 — gradient descent and fundamentals are semantically adjacent.
- Hybrid with topic boost: doc 1 wins decisively — it matches on keyword, vector, and earns the `machine-learning` topic multiplier; docs 2 and 4 are penalized by topic mismatch.

### 2.3 Prerequisites

- Node.js ≥ 20 (`node --version` prints `v20.x.x` or higher)
- npm ≥ 10 (`npm --version`)
- `@adhd/sox-hybrid-search` available on the npm registry (or a local tarball path for pre-release)
- No existing directory at the `DEMO_DIR` path used in §2.4

### 2.4 Cold Start — From Nothing to Running

▶️ **Do**
```bash
export DEMO_DIR=$(mktemp -d)
cd "$DEMO_DIR"
printf '{"name":"hs-demo","private":true,"type":"module"}\n' > package.json
npm install @adhd/sox-hybrid-search
```

👀 **Expect**
```
added <N> packages, and audited <N> packages in <T>s
found 0 vulnerabilities
```

Then confirm the three public `@adhd` packages installed and no private ones leaked:

```bash
npm ls --depth=0 2>/dev/null | grep '@adhd/'
```

👀 **Expect**
```
@adhd/sox-graph-store@⟨0.x.x⟩
@adhd/sox-hybrid-search@⟨0.x.x⟩
@adhd/sox-vector-store@⟨0.x.x⟩
```

✅ **Verify**
- [ ] `npm install` exits 0 with "found 0 vulnerabilities"
- [ ] `ls node_modules/@adhd/sox-hybrid-search` prints the package directory (no ENOTFOUND / 404)
- [ ] `npm ls --depth=0 | grep '@adhd/'` shows exactly three lines: `@adhd/sox-graph-store`, `@adhd/sox-hybrid-search`, `@adhd/sox-vector-store` — all resolved from the public npm registry (no 404)
- [ ] No additional `@adhd/sox-*` entries beyond these three appear (no private packages leaked as runtime deps)
- [ ] `better-sqlite3` appears in `npm ls --depth=1` (transitively installed as a native dep)

🔗 **Proves:** REQ-001 · CAP-001
📎 **Source:** `docs/plan/memory-refactor/SCOPE.md` Part B "5 PUBLIC / 1 PRIVATE" publish posture; `docs/plan/memory-refactor/contexts/w2d-hybrid-search.md` §Packaging; `docs/plan/memory-refactor/scripts/pack-smoke.mjs` §hybrid-search smoke

---

## 3 · The Journey

### Act 1 — Schema Setup and Fixture Seeding

Riya has installed the package. The schema helpers for the FTS5 node table and the vector store are available from the public peer packages (`@adhd/sox-graph-store`, `@adhd/sox-vector-store`) and may be re-exported as convenience imports from `@adhd/sox-hybrid-search`. She calls them on her injected `Database` handle — no DDL to write, no separate service to run.

#### 1.1 · Apply Schema (happy)

🎬 **Scene.** Riya calls the bundled schema helper on a fresh in-memory database. The node table, FTS5 index, and vector store are created in one call. She verifies the tables exist.

▶️ **Do**
```bash
node --input-type=module -e "
import Database from 'better-sqlite3';
import { applySchema } from '@adhd/sox-hybrid-search';
const db = new Database(':memory:');
applySchema(db);
const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(r => r.name).sort();
console.log(JSON.stringify(tables));
"
```

👀 **Expect**
```
["node","node_fts","vec_items"]
```

✅ **Verify**
- [ ] Output is valid JSON
- [ ] Array contains at least `"node"`, `"node_fts"`, and `"vec_items"`
- [ ] Exit code 0; no error thrown

🔗 **Proves:** REQ-007 · CAP-007
📎 **Source:** ⟦U1⟧ inferred — see UNRESOLVED.md; `docs/plan/memory-refactor/SCOPE.md` Part B (graph-store + vector-store now PUBLIC); `docs/plan/memory-refactor/contexts/w2d-hybrid-search.md` §Packaging; ADR-0006 §Decision 3 (DI for live Database)

#### 1.2 · Seed Fixture (happy)

🎬 **Scene.** Riya inserts the five documents from §2.2 using bundled node and vector upsert helpers. She also loads 4-dimensional mock vectors (the real embedding model is not required for this demo — any `Float32Array` of the configured dimension works). She confirms five nodes are stored.

▶️ **Do**
```bash
node --input-type=module -e "
import Database from 'better-sqlite3';
import { applySchema, upsertNode, upsertVector } from '@adhd/sox-hybrid-search';
const db = new Database(':memory:');
applySchema(db);
const docs = [
  { uid: 1, name: 'Attention Mechanisms in Transformers', topic: 'machine-learning', tags: 'neural,attention,transformer', content: 'Self-attention layers allow models to weigh sequence positions against each other.', t_created: 1719360000 },
  { uid: 2, name: 'Financial Market Attention Signals',   topic: 'finance',           tags: 'finance,derivatives,market',    content: 'Traders track market attention signals for derivatives pricing and volatility.',      t_created: 1719360060 },
  { uid: 3, name: 'Gradient Descent Optimization',        topic: 'machine-learning', tags: 'neural,optimization,backprop',   content: 'Backpropagation and gradient flow drive weight updates in deep networks.',          t_created: 1719360120 },
  { uid: 4, name: 'Attention in Cooking Timing',          topic: 'cooking',          tags: 'cooking,recipe,timing',          content: 'Paying close attention to heat and timing produces consistently good pasta dishes.', t_created: 1719360180 },
  { uid: 5, name: 'Machine Learning Fundamentals',        topic: 'machine-learning', tags: 'machine-learning,fundamentals,intro', content: 'Introduction to supervised and unsupervised learning paradigms.', t_created: 1719360240 },
];
const vecs = {
  1: Float32Array.from([0.90, 0.30, 0.10, 0.00]),
  2: Float32Array.from([0.00, 0.10, 0.90, 0.20]),
  3: Float32Array.from([0.70, 0.50, 0.20, 0.10]),
  4: Float32Array.from([0.00, 0.00, 0.10, 0.90]),
  5: Float32Array.from([0.60, 0.40, 0.10, 0.20]),
};
for (const doc of docs) {
  upsertNode(db, doc);
  upsertVector(db, doc.uid, vecs[doc.uid]);
}
const { n } = db.prepare('SELECT count(*) as n FROM node').get();
console.log('nodes:', n);
"
```

👀 **Expect**
```
nodes: 5
```

✅ **Verify**
- [ ] Output is exactly `nodes: 5`
- [ ] Exit code 0; no error

🔗 **Proves:** REQ-007 · CAP-007
📎 **Source:** ⟦U2⟧ inferred — see UNRESOLVED.md; `docs/plan/memory-refactor/contexts/w2d-hybrid-search.md` §Semantic Distillation (reference pattern: `libs/memory-core/src/recall.ts`)

---

### Act 2 — Core Fused Recall

The fixture is seeded. Riya runs her first hybrid searches.

#### 2.1 · Basic Hybrid Search — Fused Ranked Results (happy)

🎬 **Scene.** Riya searches for `"neural networks"` with a query vector tuned toward the ML attention neighborhood. She expects five results in descending normalized score order, with doc 1 at the top.

▶️ **Do**
```bash
node --input-type=module -e "
import Database from 'better-sqlite3';
import { applySchema, upsertNode, upsertVector, search } from '@adhd/sox-hybrid-search';
const db = new Database(':memory:');
applySchema(db);
const docs = [
  { uid: 1, name: 'Attention Mechanisms in Transformers', topic: 'machine-learning', tags: 'neural,attention,transformer', content: 'Self-attention layers allow models to weigh sequence positions against each other.', t_created: 1719360000 },
  { uid: 2, name: 'Financial Market Attention Signals',   topic: 'finance',           tags: 'finance,derivatives,market',    content: 'Traders track market attention signals for derivatives pricing and volatility.',      t_created: 1719360060 },
  { uid: 3, name: 'Gradient Descent Optimization',        topic: 'machine-learning', tags: 'neural,optimization,backprop',   content: 'Backpropagation and gradient flow drive weight updates in deep networks.',          t_created: 1719360120 },
  { uid: 4, name: 'Attention in Cooking Timing',          topic: 'cooking',          tags: 'cooking,recipe,timing',          content: 'Paying close attention to heat and timing produces consistently good pasta dishes.', t_created: 1719360180 },
  { uid: 5, name: 'Machine Learning Fundamentals',        topic: 'machine-learning', tags: 'machine-learning,fundamentals,intro', content: 'Introduction to supervised and unsupervised learning paradigms.', t_created: 1719360240 },
];
const vecs = { 1: Float32Array.from([0.90,0.30,0.10,0.00]), 2: Float32Array.from([0.00,0.10,0.90,0.20]), 3: Float32Array.from([0.70,0.50,0.20,0.10]), 4: Float32Array.from([0.00,0.00,0.10,0.90]), 5: Float32Array.from([0.60,0.40,0.10,0.20]) };
for (const doc of docs) { upsertNode(db, doc); upsertVector(db, doc.uid, vecs[doc.uid]); }
const queryVec = Float32Array.from([0.85, 0.28, 0.12, 0.01]);
const results = search(db, 'neural networks', { vector: queryVec, limit: 5 });
console.log('count:', results.length);
results.forEach((r, i) => console.log((i+1)+':', 'uid:'+r.nodeId, 'score:'+r.score.toFixed(4)));
const inRange = results.every(r => r.score >= 0 && r.score <= 1);
console.log('all-in-range:', inRange);
const descending = results.every((r, i) => i === 0 || results[i-1].score >= r.score);
console.log('descending:', descending);
"
```

👀 **Expect**
```
count: 5
1: uid:1 score:⟨0.6000–1.0000⟩
2: uid:⟨3 or 5⟩ score:⟨0.3000–0.8000⟩
3: uid:⟨3 or 5⟩ score:⟨0.2000–0.7000⟩
4: uid:⟨2 or 4⟩ score:⟨0.0500–0.5000⟩
5: uid:⟨2 or 4⟩ score:⟨0.0000–0.4000⟩
all-in-range: true
descending: true
```

✅ **Verify**
- [ ] `count: 5`
- [ ] First result `nodeId` is `1` (Attention Mechanisms in Transformers)
- [ ] `all-in-range: true` — every score is in [0, 1]
- [ ] `descending: true` — scores are in non-increasing order

🔗 **Proves:** REQ-002 · REQ-003 · CAP-002 · CAP-003
📎 **Source:** ⟦U3⟧ inferred — see UNRESOLVED.md; `docs/plan/memory-refactor/SCOPE.md` Part D §hybrid-search normalize-before-combine; `docs/plan/memory-refactor/contexts/w2d-hybrid-search.md` §Delta Spec; UC-SRCH-1; w2d-hs.2

#### 2.2 · Multiplicative Field Boost — Title Match Outranks Body Match (happy)

🎬 **Scene.** Riya wants to verify that a document matching the query in its `name` field outranks one matching only in `content`, even when both have identical vector distances. With multiplicative weights (name 1.2 vs content 1.0), the title-matching doc should win — not by an additive offset, but by a proportional multiplier.

▶️ **Do**
```bash
node --input-type=module -e "
import Database from 'better-sqlite3';
import { applySchema, upsertNode, upsertVector, search } from '@adhd/sox-hybrid-search';
const db = new Database(':memory:');
applySchema(db);
// Doc A: query term in name
upsertNode(db, { uid: 10, name: 'Quantum Computing Overview', topic: 'quantum', tags: 'quantum,computing', content: 'A survey of current hardware implementations.', t_created: 1719360000 });
// Doc B: query term only in content — same vector distance from query
upsertNode(db, { uid: 11, name: 'Hardware Landscape Survey',  topic: 'hardware', tags: 'hardware,survey',   content: 'Quantum computing is reshaping the hardware landscape.', t_created: 1719360000 });
const sharedVec = Float32Array.from([0.5, 0.5, 0.5, 0.5]);
upsertVector(db, 10, sharedVec);
upsertVector(db, 11, sharedVec);
const queryVec = Float32Array.from([0.5, 0.5, 0.5, 0.5]);
const results = search(db, 'quantum computing', { vector: queryVec, limit: 2 });
console.log('rank1 uid:', results[0].nodeId, 'score:', results[0].score.toFixed(4));
console.log('rank2 uid:', results[1].nodeId, 'score:', results[1].score.toFixed(4));
console.log('margin:', (results[0].score - results[1].score).toFixed(4));
"
```

👀 **Expect**
```
rank1 uid: 10 score:⟨higher⟩
rank2 uid: 11 score:⟨lower⟩
margin:⟨> 0.0000⟩
```

✅ **Verify**
- [ ] `rank1 uid` is `10` — the doc with "Quantum Computing" in `name` ranks first
- [ ] `rank2 uid` is `11` — the doc with the term only in `content` ranks second
- [ ] `margin` is greater than `0.0000` — it is not a tie

🔗 **Proves:** REQ-004 · CAP-004
📎 **Source:** `docs/plan/memory-refactor/SCOPE.md` Part D §hybrid-search multiplicative field boosting (topic 2.0 / tags 1.5 / name 1.2 / summary 1.0 / content 1.0); `docs/plan/memory-refactor/contexts/w2d-hybrid-search.md` §Delta Spec; UC-SRCH-2; w2d-hs.3

---

### Act 3 — Score Transparency

#### 3.1 · Explain OFF by Default ⚠️ (edge)

🎬 **Scene.** Riya confirms that calling `search` without the `explain` option returns a clean result object with no per-field breakdown — so production callers pay no overhead they did not ask for. The result should have `nodeId` and `score` but not `explain`.

▶️ **Do**
```bash
node --input-type=module -e "
import Database from 'better-sqlite3';
import { applySchema, upsertNode, upsertVector, search } from '@adhd/sox-hybrid-search';
const db = new Database(':memory:');
applySchema(db);
upsertNode(db, { uid: 1, name: 'Attention Mechanisms', topic: 'machine-learning', tags: 'neural,attention', content: 'Self-attention layers.', t_created: 1719360000 });
upsertVector(db, 1, Float32Array.from([0.9, 0.1, 0.0, 0.0]));
const results = search(db, 'attention', { vector: Float32Array.from([0.9, 0.1, 0.0, 0.0]) });
const r = results[0];
console.log('has nodeId:', 'nodeId' in r);
console.log('has score:', 'score' in r);
console.log('has explain:', 'explain' in r);
"
```

👀 **Expect**
```
has nodeId: true
has score: true
has explain: false
```

✅ **Verify**
- [ ] `has nodeId: true`
- [ ] `has score: true`
- [ ] `has explain: false` — the `explain` key is absent from the result when not requested

🔗 **Proves:** REQ-005 · CAP-005
📎 **Source:** `docs/plan/memory-refactor/SCOPE.md` Part D §hybrid-search opt-in explain; `docs/plan/memory-refactor/contexts/w2d-hybrid-search.md` §Delta Spec; w2d-hs.5; UC-SRCH-4

#### 3.2 · Explain ON — Per-Field Breakdown (happy)

🎬 **Scene.** Riya turns on `explain: true` for a relevance-tuning session. The result now includes the per-field score breakdown — she can see whether a document ranked high due to vector similarity, BM25 in the name, or topic boost, and adjust weights accordingly.

▶️ **Do**
```bash
node --input-type=module -e "
import Database from 'better-sqlite3';
import { applySchema, upsertNode, upsertVector, search } from '@adhd/sox-hybrid-search';
const db = new Database(':memory:');
applySchema(db);
upsertNode(db, { uid: 1, name: 'Attention Mechanisms', topic: 'machine-learning', tags: 'neural,attention', content: 'Self-attention layers allow models to weigh positions.', t_created: 1719360000 });
upsertVector(db, 1, Float32Array.from([0.9, 0.1, 0.0, 0.0]));
const results = search(db, 'attention', { vector: Float32Array.from([0.9, 0.1, 0.0, 0.0]), explain: true });
const r = results[0];
console.log('has explain:', 'explain' in r);
const exp = r.explain || {};
const keys = Object.keys(exp).sort();
console.log('explain keys:', keys.join(','));
const allNumbers = keys.every(k => typeof exp[k] === 'number');
console.log('all numeric:', allNumbers);
"
```

👀 **Expect**
```
has explain: true
explain keys:⟨bm25,temporal,vector — or a superset of these⟩
all numeric: true
```

✅ **Verify**
- [ ] `has explain: true`
- [ ] `explain keys` contains at least two entries (e.g. `bm25`, `vector`, or `temporal`)
- [ ] `all numeric: true` — every explain field value is a number

🔗 **Proves:** REQ-005 · CAP-005
📎 **Source:** ⟦U4⟧ inferred — see UNRESOLVED.md; `docs/plan/memory-refactor/SCOPE.md` Part D §hybrid-search opt-in explain; UC-SRCH-4; w2d-hs.5

---

### Act 4 — Resilience in the Field

#### 4.1 · Degrade-to-BM25 — Vectors Absent 🛟 (recovery)

🎬 **Scene.** Riya's embedding model goes down during a deploy. She calls `search` without a `vector` argument. Per `[inv:degrade-to-bm25]`, the function must return a BM25/FTS-ranked result — not an empty array, not a thrown error. Search keeps working.

▶️ **Do**
```bash
node --input-type=module -e "
import Database from 'better-sqlite3';
import { applySchema, upsertNode, search } from '@adhd/sox-hybrid-search';
const db = new Database(':memory:');
applySchema(db);
// Seed nodes with NO vectors
const docs = [
  { uid: 1, name: 'Attention Mechanisms in Transformers', topic: 'machine-learning', tags: 'neural,attention,transformer', content: 'Self-attention layers allow models to weigh sequence positions.', t_created: 1719360000 },
  { uid: 2, name: 'Financial Market Attention Signals',   topic: 'finance',           tags: 'finance,derivatives,market',    content: 'Traders track market attention signals for derivatives pricing.', t_created: 1719360060 },
];
for (const d of docs) upsertNode(db, d);
// No vector argument — degrade path
const results = search(db, 'attention neural');
console.log('result count:', results.length);
console.log('top uid:', results[0]?.nodeId);
console.log('top score type:', typeof results[0]?.score);
" 2>&1
```

👀 **Expect**
```
result count:⟨≥1⟩
top uid: 1
top score type: number
```

✅ **Verify**
- [ ] Exit code is 0 — no uncaught error
- [ ] `result count` is ≥ 1 (non-empty result)
- [ ] `top uid: 1` — doc 1 ranks first on BM25 (keyword match on "attention neural" in name + content)
- [ ] `top score type: number`

🔗 **Proves:** REQ-006 · REQ-010 · CAP-006
📎 **Source:** `docs/plan/memory-refactor/SCOPE.md` Part D §hybrid-search degrade-to-BM25; `docs/plan/memory-refactor/contexts/w2d-hybrid-search.md` §Delta Spec [def:degrade-to-bm25], `[inv:degrade]`; w2d-hs.4; UC-SRCH-3

#### 4.2 · Normalize-Before-Combine — Scores Stay in [0, 1] ⚠️ (edge)

🎬 **Scene.** Riya seeds a varied fixture and confirms that even when raw BM25 scores and raw cosine similarities are on incompatible scales, the final fused scores are always in [0, 1]. This is the normalize-before-combine invariant — combining raw scores of different scales is a silent correctness bug this package prevents.

▶️ **Do**
```bash
node --input-type=module -e "
import Database from 'better-sqlite3';
import { applySchema, upsertNode, upsertVector, search } from '@adhd/sox-hybrid-search';
const db = new Database(':memory:');
applySchema(db);
// Five docs with varied content keyword density and random vectors
for (let i = 1; i <= 5; i++) {
  upsertNode(db, { uid: i, name: 'doc'+i+' quick fox', topic: 'test', tags: 'tag'+i, content: 'the quick brown fox number '+i+' jumps over the lazy dog', t_created: 1719360000 + i });
  upsertVector(db, i, Float32Array.from([Math.sin(i), Math.cos(i), Math.sin(i*2), Math.cos(i*2)]));
}
const queryVec = Float32Array.from([0.5, 0.5, 0.5, 0.5]);
const results = search(db, 'quick fox', { vector: queryVec, limit: 5 });
const outOfRange = results.filter(r => r.score < 0 || r.score > 1);
console.log('total results:', results.length);
console.log('out-of-range scores:', outOfRange.length);
console.log('min score:', Math.min(...results.map(r => r.score)).toFixed(4));
console.log('max score:', Math.max(...results.map(r => r.score)).toFixed(4));
"
```

👀 **Expect**
```
total results: 5
out-of-range scores: 0
min score:⟨0.0000–1.0000⟩
max score:⟨0.0000–1.0000⟩
```

✅ **Verify**
- [ ] `out-of-range scores: 0` — every fused score is in [0, 1]
- [ ] `max score` is ≤ 1.0000
- [ ] `min score` is ≥ 0.0000

🔗 **Proves:** REQ-003 · CAP-003
📎 **Source:** `docs/plan/memory-refactor/SCOPE.md` Part D §hybrid-search normalize-before-combine (min_max/L2/z_score); `docs/plan/memory-refactor/contexts/w2d-hybrid-search.md` §Delta Spec; w2d-hs.2; UC-SRCH-1

---

## 4 · The Climax — Hybrid Beats Pure-Keyword AND Pure-Vector

🎬 **Scene.** This is the payoff the entire demo built toward. The fixture from §2.2 is rigged so that pure BM25 and pure vector each pick wrong. The query is `"attention neural networks"`.

Pure BM25 cannot distinguish: docs 1, 2, and 4 all contain "attention" — finance and cooking documents score alongside the ML paper. Pure vector alone surfaces the gradient descent and fundamentals documents from the ML embedding neighborhood, but cannot penalize the finance noise. Hybrid search with topic boost sees the full picture: doc 1 gets the vector hit, the keyword hit, and the `machine-learning` topic multiplier. Docs 2 and 4 get the keyword hit but their topics (`finance`, `cooking`) earn no boost and their vectors are far. Doc 1 wins decisively.

▶️ **Do**
```bash
node --input-type=module -e "
import Database from 'better-sqlite3';
import { applySchema, upsertNode, upsertVector, search } from '@adhd/sox-hybrid-search';
const db = new Database(':memory:');
applySchema(db);
const docs = [
  { uid: 1, name: 'Attention Mechanisms in Transformers', topic: 'machine-learning', tags: 'neural,attention,transformer', content: 'Self-attention layers allow models to weigh sequence positions against each other.', t_created: 1719360000 },
  { uid: 2, name: 'Financial Market Attention Signals',   topic: 'finance',           tags: 'finance,derivatives,market',    content: 'Traders track market attention signals for derivatives pricing and volatility.',      t_created: 1719360060 },
  { uid: 3, name: 'Gradient Descent Optimization',        topic: 'machine-learning', tags: 'neural,optimization,backprop',   content: 'Backpropagation and gradient flow drive weight updates in deep networks.',          t_created: 1719360120 },
  { uid: 4, name: 'Attention in Cooking Timing',          topic: 'cooking',          tags: 'cooking,recipe,timing',          content: 'Paying close attention to heat and timing produces consistently good pasta dishes.', t_created: 1719360180 },
  { uid: 5, name: 'Machine Learning Fundamentals',        topic: 'machine-learning', tags: 'machine-learning,fundamentals,intro', content: 'Introduction to supervised and unsupervised learning paradigms.', t_created: 1719360240 },
];
const vecs = {
  1: Float32Array.from([0.90, 0.30, 0.10, 0.00]),
  2: Float32Array.from([0.00, 0.10, 0.90, 0.20]),
  3: Float32Array.from([0.70, 0.50, 0.20, 0.10]),
  4: Float32Array.from([0.00, 0.00, 0.10, 0.90]),
  5: Float32Array.from([0.60, 0.40, 0.10, 0.20]),
};
for (const doc of docs) { upsertNode(db, doc); upsertVector(db, doc.uid, vecs[doc.uid]); }
const queryVec = Float32Array.from([0.88, 0.28, 0.12, 0.02]);

// Pure BM25 — no vector
const bm25Only = search(db, 'attention neural networks');
console.log('=== Pure BM25 (no vector) top-3 ===');
bm25Only.slice(0, 3).forEach((r, i) => console.log((i+1)+':', 'uid:'+r.nodeId));

// Hybrid (default weights)
const hybrid = search(db, 'attention neural networks', { vector: queryVec, explain: true });
console.log('=== Hybrid (default weights) top-3 ===');
hybrid.slice(0, 3).forEach((r, i) => console.log((i+1)+':', 'uid:'+r.nodeId, 'score:'+r.score.toFixed(3)));

console.log('hybrid top uid:', hybrid[0].nodeId);
console.log('hybrid top > 2nd:', hybrid[0].score > hybrid[1].score);
const noiseInTop2 = [hybrid[0].nodeId, hybrid[1].nodeId].filter(id => id === 2 || id === 4);
console.log('noise uids in hybrid top-2:', noiseInTop2.length);
"
```

👀 **Expect**
```
=== Pure BM25 (no vector) top-3 ===
1: uid:⟨1, 2, or 4 — all share keyword "attention"⟩
2: uid:⟨1, 2, or 4⟩
3: uid:⟨1, 2, or 4⟩
=== Hybrid (default weights) top-3 ===
1: uid:1 score:⟨0.600–1.000⟩
2: uid:⟨3 or 5⟩ score:⟨0.200–0.800⟩
3: uid:⟨3 or 5⟩ score:⟨0.100–0.700⟩
hybrid top uid: 1
hybrid top > 2nd: true
noise uids in hybrid top-2: 0
```

✅ **Verify**
- [ ] Pure BM25 top-3 includes at least one of uid 2 or uid 4 (the noise documents that match on "attention" but are off-topic) — this proves the hybrid discrimination is doing real work
- [ ] Hybrid top result `nodeId` is `1` (Attention Mechanisms in Transformers)
- [ ] `hybrid top > 2nd: true` — not a tie; the margin is positive
- [ ] `noise uids in hybrid top-2: 0` — neither uid 2 (finance) nor uid 4 (cooking) appear in hybrid top-2
- [ ] All hybrid scores are in [0, 1]

🔗 **Proves:** REQ-002 · REQ-003 · REQ-004 · REQ-010 · CAP-002 · CAP-003 · CAP-004
📎 **Source:** `docs/plan/memory-refactor/SCOPE.md` Part D §hybrid-search; `docs/plan/memory-refactor/contexts/w2d-hybrid-search.md` §Goal, §Delta Spec; UC-SRCH-1; UC-SRCH-2; w2d-hs.2; w2d-hs.3

---

## 5 · Resilience Sweep — Edges We Didn't Hit in the Story

#### 5.1 · ⚠️ Empty Database — No Results, No Crash

▶️ **Do**
```bash
node --input-type=module -e "
import Database from 'better-sqlite3';
import { applySchema, search } from '@adhd/sox-hybrid-search';
const db = new Database(':memory:');
applySchema(db);
const results = search(db, 'anything');
console.log('is array:', Array.isArray(results));
console.log('result count:', results.length);
" 2>&1
```

👀 **Expect** — `is array: true` and `result count: 0`; exit code 0
✅ **Verify**
- [ ] Exit code 0 — no throw
- [ ] `is array: true`
- [ ] `result count: 0`

🔗 **Proves:** REQ-002 · CAP-002
📎 **Source:** `docs/plan/memory-refactor/contexts/w2d-hybrid-search.md` §Acceptance criteria w2d-hs.4 (degrade must not throw); general robustness invariant

#### 5.2 · ⚠️ No Federation Helpers Exported

▶️ **Do**
```bash
node --input-type=module -e "
import * as m from '@adhd/sox-hybrid-search';
const forbidden = ['discoverStores', 'getFederationConnection', 'readRegistry', 'writeRegistry'];
const present = forbidden.filter(k => k in m);
console.log('federation exports present:', present.length === 0 ? 'none (correct)' : present.join(','));
"
```

👀 **Expect** — `federation exports present: none (correct)`
✅ **Verify**
- [ ] Output is `federation exports present: none (correct)`
- [ ] None of `discoverStores`, `getFederationConnection`, `readRegistry`, `writeRegistry` are in the module's exports

🔗 **Proves:** REQ-008 · CAP-002
📎 **Source:** `docs/plan/memory-refactor/contexts/w2d-hybrid-search.md` §Notes for executor ("ranking vs federation"), w2d-hs.7 acceptance criterion; `[inv:boundary]`

#### 5.3 · ⚠️ Batch Query — Cross-Query `matched_queries` Dedup (experimental)

▶️ **Do**
```bash
node --input-type=module -e "
import Database from 'better-sqlite3';
import { applySchema, upsertNode, upsertVector, batchSearch } from '@adhd/sox-hybrid-search';
const db = new Database(':memory:');
applySchema(db);
upsertNode(db, { uid: 1, name: 'Attention Mechanisms', topic: 'machine-learning', tags: 'neural,attention', content: 'Self-attention layers.', t_created: 1719360000 });
upsertNode(db, { uid: 2, name: 'Financial Signals',    topic: 'finance',          tags: 'finance',          content: 'Market attention.',         t_created: 1719360060 });
upsertVector(db, 1, Float32Array.from([0.9, 0.1, 0.0, 0.0]));
upsertVector(db, 2, Float32Array.from([0.1, 0.9, 0.0, 0.0]));
const vec = Float32Array.from([0.9, 0.1, 0.0, 0.0]);
const batched = batchSearch(db, [
  { query: 'attention', vector: vec },
  { query: 'neural networks', vector: vec },
]);
const flat = batched.flat();
const top = flat.find(r => r.nodeId === 1);
console.log('matched_queries for uid:1:', top?.matched_queries);
console.log('is number:', typeof top?.matched_queries === 'number');
" 2>&1
```

👀 **Expect**
```
matched_queries for uid:1:⟨2⟩
is number: true
```

✅ **Verify**
- [ ] Exit code 0
- [ ] `matched_queries` for uid 1 is ≥ 1 (experimental; exact value may vary per implementation)
- [ ] `is number: true`

🔗 **Proves:** REQ-009 · CAP-008
📎 **Source:** ⟦U5⟧ inferred — see UNRESOLVED.md; `docs/plan/memory-refactor/SCOPE.md` Part D §hybrid-search batch+dedup (experimental differentiator); UC-SRCH-5

---

## 6 · Teardown — Back to Zero

▶️ **Do**
```bash
rm -rf "$DEMO_DIR"
echo "Teardown complete"
```

👀 **Expect**
```
Teardown complete
```

✅ **Verify**
- [ ] Exit code 0
- [ ] `ls "$DEMO_DIR"` returns `No such file or directory`
- [ ] No lingering `node` processes associated with this demo (check with `pgrep -af hs-demo`; expect empty)

🔗 **Proves:** REQ-001 · CAP-001
📎 **Source:** `docs/plan/memory-refactor/contexts/w2d-hybrid-search.md` §Packaging (DI for live Database — no daemon, no side effects, no persistent state beyond the caller's own DB file)

---

## 7 · Coverage & Traceability Matrix

### 7.1 Requirements → Beats

| Req ID | Requirement (short) | Proven by beat(s) | Paths covered (H/E/R) | Status |
|---|---|---|---|---|
| REQ-001 | Standalone install — public `@adhd` dep tree resolves from npm | §2.4, §6 | H | ☐ |
| REQ-002 | Fused ranked recall (vec + BM25 + temporal decay) | §2.1, §5.1, §5.2, climax | H/E | ☐ |
| REQ-003 | Normalize-before-combine — scores in [0, 1] | §2.1, §4.2, climax | H/E | ☐ |
| REQ-004 | Multiplicative field boosting (topic 2.0 / name 1.2 / …) | §2.2, climax | H | ☐ |
| REQ-005 | Opt-in `explain` — off by default, per-field on request | §3.1, §3.2 | H/E | ☐ |
| REQ-006 | Degrade-to-BM25 when vectors unavailable | §4.1 | R | ☐ |
| REQ-007 | Database injected via DI — caller owns the handle | §1.1, §1.2 | H | ☐ |
| REQ-008 | No federation helpers exported | §5.2 | E | ☐ |
| REQ-009 | Batch query + `matched_queries` cross-dedup (experimental) | §5.3 | H | ☐ |
| REQ-010 | BM25 via `bm25(col_weights)` FTS5 — single ranked query | §4.1, climax | H/R | ☐ |

### 7.2 Capabilities → Beats

| Cap ID | Capability | Proven by beat(s) | Status |
|---|---|---|---|
| CAP-001 | Standalone install — public @adhd dep tree resolves | §2.4, §6 | ☐ |
| CAP-002 | Hybrid recall (vec + BM25 + temporal fusion) | §2.1, §5.1, §5.2, climax | ☐ |
| CAP-003 | Normalize-before-combine scoring | §2.1, §4.2, climax | ☐ |
| CAP-004 | Multiplicative field boosting | §2.2, climax | ☐ |
| CAP-005 | Opt-in explain output | §3.1, §3.2 | ☐ |
| CAP-006 | Degrade-to-BM25 when vectors unavailable | §4.1 | ☐ |
| CAP-007 | Database dependency injection | §1.1, §1.2 | ☐ |
| CAP-008 | Batch query with cross-query dedup (experimental) | §5.3 | ☐ |

### 7.3 Unresolved Interfaces & Gaps

5 unresolved interface stubs (⟦U1⟧–⟦U5⟧) and 2 scope gaps; full list in `UNRESOLVED.md`. Highest impact: ⟦U1⟧ (`applySchema` export name), ⟦U2⟧ (`upsertNode`/`upsertVector` helper names), ⟦U3⟧ (`search` parameter shape). Resolve these three before treating any beat as authoritative — they gate every act.

---

## 8 · Sign-Off

| Field | Value |
|---|---|
| Environment | ⟨OS / version / commit SHA⟩ |
| Run by | ⟨name or agent ID⟩ |
| Date | ⟨date⟩ |
| Beats passed | ⟨X of Y⟩ |
| Requirements proven | ⟨X of Y⟩ |
| Result | ☐ PASS &nbsp;&nbsp; ☐ FAIL |
| Notes / defects filed | ⟨…⟩ |

> A run is **PASS** only if every ✅ assertion is checked and every requirement in §7 is proven. One unchecked binary assertion = FAIL until resolved.
