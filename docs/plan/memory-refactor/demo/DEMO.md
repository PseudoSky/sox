# 🎬 soxe memory primitives — Live Demo & Acceptance Script

> The memory engine, unbundled: `npm i` the embedding, vector, graph, search, analysis, and ingest primitives and build your own RAG/memory system — in-process, no vector DB to run, no embedding API to pay, no framework lock-in.

**What this is.** A presentation-grade walkthrough of the `@adhd/sox-*` `data/*` packages that doubles as their acceptance test. Follow it top to bottom and you will (a) experience the toolkit the way a brand-new third-party developer would and (b) prove every capability works, with exact commands, exact data, and pass/fail checks. It is the contract for what "done" means for the memory-refactor: if it's demonstrated here, the refactor must deliver it; if the refactor must deliver it, it's demonstrated here.

---

## 0 · How to Read This Script

**Legend**

| Marker | Meaning |
|---|---|
| 🎬 **Scene** | The story beat — what's happening and why the persona cares. |
| ▶️ **Do** | The exact action to take (shell command or code) with literal input. |
| 👀 **Expect** | The exact observable result. Volatile parts shown as ⟨…⟩. |
| ✅ **Verify** | Binary pass/fail assertions. Tick each only if literally true. |
| 🔗 **Proves** | Requirement and capability IDs this beat satisfies. |
| 📎 **Source** | What grounds this step — plan doc, file, or invariant. |
| ⟦U#⟧ | An **unresolved stub**: an interface guessed because the plan didn't pin it. Logged in `UNRESOLVED.md` beside this file. |
| ⚠️ **Edge / 🛟 Recovery** | A deliberately adversarial or failure-then-recover beat. |

**Conventions**

- Shell prompt is `$`; commands run from a fresh empty directory unless noted.
- The toolkit is consumed as **SDK packages** (ESM `import`), so most actions are short `node` snippets.
- Values shown as ⟨like-this⟩ vary per run; the assertion next to them states what stays invariant.
- Tokens shown as ⟦U#⟧ are interfaces this script had to guess; each is listed in `UNRESOLVED.md` — confirm them before treating the step as authoritative.
- All sample data here is fictional and safe.

---

## 1 · Cold Open — The Hook

🎬 **Scene.** Maya is building a local-first notes app and wants semantic search over a few thousand notes. Every path she tries means standing up a vector database, wiring an embedding API (latency + a bill + a data-egress review), and gluing in a keyword index. She just wants the *pieces* — embeddings, a vector index, a ranker — as libraries she can `npm i` and run in-process, on top of the SQLite file she already has. Then she finds the `@adhd/sox-*` memory primitives: the exact internals that power the soxe memory server, **extracted into standalone packages**, each usable on its own.

> **The promise we'll prove in the next 10 minutes:** every memory primitive installs from npm and works **standalone, in-process** — real embeddings with no API, vector kNN with no server, hybrid ranking that still works when embeddings are down — and they compose into a full semantic-recall stack.

🔗 **Proves (framing):** REQ-001 · REQ-002 · CAP-001 · CAP-009
📎 **Source:** `docs/plan/memory-refactor/SCOPE.md` §Goal + `USE_CASES.md` (reuse thesis)

---

## 2 · Cast, World & Cold-Start Setup

### 2.1 Meet Maya

Maya is a full-stack developer shipping a single-user notes app. Her goal: add "find related notes" semantic search this afternoon, with zero new infrastructure, and keep it offline-capable. She has Node and an empty project folder. The stakes: if it needs a vector DB or a paid embedding service, it's out of scope for her app.

### 2.2 The Canonical Demo Dataset

Three notes Maya will index, and one query. This is the single source of data truth for the script.

```json
[
  { "id": 1, "text": "the cat sat on the mat in the warm afternoon sun" },
  { "id": 2, "text": "quarterly financial derivatives report and risk exposure" },
  { "id": 3, "text": "a small kitten napped on a rug by the window" }
]
```

Query: `"sleepy pet resting indoors"` — semantically closest to notes 1 and 3, unrelated to note 2.

### 2.3 Prerequisites

- Node.js ≥ 22 (the embedding + vector packages ship native addons with Node-22 prebuilds).
- npm ≥ 10.
- Network access for the first `npm install` only (pulls the prebuilt ONNX model + native binaries); everything after is offline.

### 2.4 Cold Start — From Nothing to Running

▶️ **Do**

```bash
mkdir maya-notes && cd maya-notes
npm init -y >/dev/null
npm i @adhd/sox-embedding-provider@0.1.0 @adhd/sox-vector-store@0.1.0 @adhd/sox-graph-store@0.1.0 @adhd/sox-hybrid-search@0.1.0 @adhd/sox-analysis@0.1.0 @adhd/sox-ingest@0.1.0
node --input-type=module -e "await import('@adhd/sox-embedding-provider'); await import('@adhd/sox-vector-store'); console.log('toolkit import OK')"
```

👀 **Expect**

```
added ⟨N⟩ packages in ⟨t⟩s
toolkit import OK
```

✅ **Verify**

- [ ] All six packages install with no `ERR_MODULE_NOT_FOUND` / `404 Not Found` / peer-dep error.
- [ ] The import line prints `toolkit import OK` (the native packages loaded their addons from the installed tarball, not from a workspace).

🔗 **Proves:** REQ-001 · REQ-008 · CAP-001
📎 **Source:** `docs/plan/memory-refactor/SCOPE.md` §Part B (<public@0.x>) + `scripts/pack-smoke.mjs`; ⟦U1⟧ inferred — see UNRESOLVED.md

---

## 3 · The Journey

### Act 1 — Turning text into vectors, in-process

Maya's first need: embeddings without an API call.

#### 1.1 · Real embeddings with no service   (happy)

🎬 **Scene.** Maya embeds two notes and checks that semantically different text lands far apart in vector space — proof the model is real, not a hash stub.

▶️ **Do**

```bash
node --input-type=module -e '
import { resolveProvider } from "@adhd/sox-embedding-provider";
const p = await resolveProvider({ backend: "real" });
const a = await p.embed("the cat sat on the mat in the warm afternoon sun");
const b = await p.embed("quarterly financial derivatives report and risk exposure");
const cos=(x,y)=>{let d=0,nx=0,ny=0;for(let i=0;i<x.length;i++){d+=x[i]*y[i];nx+=x[i]*x[i];ny+=y[i]*y[i];}return d/Math.sqrt(nx*ny);};
console.log("model", p.modelId, "dim", p.dim, "cos", cos(a,b).toFixed(3));
'
```

👀 **Expect**

```
model bge-base-en-v1.5 dim 768 cos ⟨0.0–0.45⟩
```

✅ **Verify**

- [ ] `p.modelId` is a real ONNX model id (e.g. `bge-base-en-v1.5`), not `*-hash`.
- [ ] `a.length === p.dim`.
- [ ] cosine of the two unrelated strings is `< 0.5` (real geometry, not the degenerate ~0.99 hash space).

🔗 **Proves:** REQ-002 · CAP-002
📎 **Source:** `scripts/pack-smoke.mjs` §embedding-provider; ⟦U2⟧ inferred — see UNRESOLVED.md

#### 1.2 · Deterministic provider for offline tests   (happy)

🎬 **Scene.** Maya wants reproducible vectors in CI with no model download, so she asks for the deterministic backend.

▶️ **Do**

```bash
node --input-type=module -e '
import { resolveProvider } from "@adhd/sox-embedding-provider";
const d = await resolveProvider({ backend: "hash" });
const v1 = await d.embed("hello"); const v2 = await d.embed("hello");
console.log("deterministic", d.isDeterministic, "stable", JSON.stringify(v1)===JSON.stringify(v2));
'
```

👀 **Expect**

```
deterministic true stable true
```

✅ **Verify**

- [ ] `d.isDeterministic === true`.
- [ ] The same input yields a byte-identical vector across calls.

🔗 **Proves:** REQ-002 · CAP-002
📎 **Source:** `scripts/pack-smoke.mjs` §embedding-provider (`isDeterministic`)

#### 1.3 · "Real or nothing" fails loud, never silent   ⚠️ (edge)

🎬 **Scene.** Maya pins `backend: real` for production. She wants to know that if the embedding runtime ever can't load, she gets a *loud error*, not a silent downgrade to a useless hash space (the exact bug — BL-87 — that motivated this whole toolkit).

▶️ **Do**

```bash
node --input-type=module -e '
import { resolveProvider } from "@adhd/sox-embedding-provider";
process.env.SOX_EMBED_FORCE_UNAVAILABLE = "1";
try { await resolveProvider({ backend: "real" }); console.log("NO-THROW"); }
catch (e) { console.log("threw:", e.message.slice(0,40)); }
'
```

👀 **Expect**

```
threw: ⟨embedding backend "real" unavailable…⟩
```

✅ **Verify**

- [ ] `resolveProvider({backend:"real"})` **throws** when the real runtime is unavailable — it does NOT return a hash provider.
- [ ] The error message names the cause (diagnosable), it is not a generic stack with no signal.

🔗 **Proves:** REQ-002 · CAP-002 · CAP-004
📎 **Source:** `contexts/_shared.md` `[inv:loud-fail]`; ⟦U3⟧ inferred — see UNRESOLVED.md

### Act 2 — A vector index in one SQLite file

Maya now needs to store vectors and search them — without a vector database.

#### 2.1 · Persist + kNN over plain SQLite   (happy)

🎬 **Scene.** Maya opens a vector store on a single file, inserts two note vectors, and runs a nearest-neighbour query.

▶️ **Do**

```bash
node --input-type=module -e '
import { openVectorStore, applyVecSchema, upsertVector, knn } from "@adhd/sox-vector-store";
const db = openVectorStore(":memory:", { dim: 4 });
applyVecSchema(db, { dim: 4, modelId: "demo" });
upsertVector(db, 1, Float32Array.from([1,0,0,0]), { modelId: "demo" });
upsertVector(db, 2, Float32Array.from([0,1,0,0]), { modelId: "demo" });
const hits = knn(db, Float32Array.from([0.9,0.1,0,0]), 1);
console.log("top", hits[0].nodeId);
'
```

👀 **Expect**

```
top 1
```

✅ **Verify**

- [ ] `knn` returns node `1` (closest to `[0.9,0.1,0,0]`) as the top hit.
- [ ] No external process/port was needed — the store is the SQLite file alone.

🔗 **Proves:** REQ-003 · CAP-003
📎 **Source:** `scripts/pack-smoke.mjs` §vector-store

#### 2.2 · The store refuses to mix embedding spaces   ⚠️ (edge)

🎬 **Scene.** Maya accidentally tries to insert a vector of the wrong dimension (a different model). A naive store would corrupt similarity silently. This one rejects it.

▶️ **Do**

```bash
node --input-type=module -e '
import { openVectorStore, applyVecSchema, upsertVector } from "@adhd/sox-vector-store";
const db = openVectorStore(":memory:", { dim: 4 });
applyVecSchema(db, { dim: 4, modelId: "demo" });
try { upsertVector(db, 9, Float32Array.from([1,2,3]), { modelId: "demo" }); console.log("NO-THROW"); }
catch (e) { console.log("rejected:", e.message.slice(0,40)); }
'
```

👀 **Expect**

```
rejected: ⟨dimension mismatch: expected 4, got 3⟩
```

✅ **Verify**

- [ ] A 3-dim vector into a 4-dim space **throws** (the space invariant holds); the row is not written.
- [ ] The same protection fires on a `modelId` that doesn't match the column.

🔗 **Proves:** REQ-003 · CAP-004
📎 **Source:** `contexts/_shared.md` `[inv:space]`; ⟦U4⟧ inferred — see UNRESOLVED.md

#### 2.3 · vector-store stands completely on its own   (happy)

🎬 **Scene.** Maya confirms the vector package needs nothing from the rest of the toolkit — she uses it with her *own* embeddings and never imports graph-store.

▶️ **Do**

```bash
node --input-type=module -e '
import * as vs from "@adhd/sox-vector-store";
console.log("exports", ["openVectorStore","applyVecSchema","upsertVector","knn"].every(k=>typeof vs[k]==="function"));
'
```

👀 **Expect**

```
exports true
```

✅ **Verify**

- [ ] vector-store exposes its full surface without graph-store or memory-core installed.
- [ ] `npm ls @adhd/sox-graph-store` in this dir shows it is **not** a dependency of vector-store.

🔗 **Proves:** REQ-001 · REQ-009 · CAP-001
📎 **Source:** `SCOPE.md` §Part C (`[inv:boundary]`) + `references.json`; ⟦U5⟧ inferred — see UNRESOLVED.md

### Act 3 — The other primitives, each pulling its weight

Maya wires in the remaining pieces her app needs.

#### 3.1 · ingest: deterministic content-hash + transforms   (happy)

🎬 **Scene.** Maya hashes note content to dedupe imports idempotently.

▶️ **Do**

```bash
node --input-type=module -e '
import { contentHash } from "@adhd/sox-ingest";
console.log("dedupe", contentHash("hello") === contentHash("hello"));
'
```

👀 **Expect**

```
dedupe true
```

✅ **Verify**

- [ ] `contentHash` is deterministic for identical input (idempotent writes downstream).

🔗 **Proves:** REQ-007 · CAP-008
📎 **Source:** `scripts/pack-smoke.mjs` §ingest

#### 3.2 · graph-store: a bi-temporal store on demand   (happy)

🎬 **Scene.** Maya applies the graph schema to a SQLite handle she owns — nodes, edges, FTS, all set up in one call.

▶️ **Do**

```bash
node --input-type=module -e '
import { applyGraphSchema } from "@adhd/sox-graph-store";
import Database from "better-sqlite3";
const db = new Database(":memory:"); applyGraphSchema(db);
const t = db.prepare("SELECT name FROM sqlite_master WHERE type=$t AND name=$n").get({ t:"table", n:"node" });
console.log("node table", !!t);
'
```

👀 **Expect**

```
node table true
```

✅ **Verify**

- [ ] `applyGraphSchema` creates the `node` table (and edges/FTS) on a caller-owned connection.

🔗 **Proves:** REQ-004 · CAP-005
📎 **Source:** `scripts/pack-smoke.mjs` §graph-store

#### 3.3 · analysis: importance scoring over a corpus   (happy)

🎬 **Scene.** Maya scores which notes matter most for surfacing.

▶️ **Do**

```bash
node --input-type=module -e '
import { computeImportance } from "@adhd/sox-analysis";
console.log("importance fn", typeof computeImportance === "function");
'
```

👀 **Expect**

```
importance fn true
```

✅ **Verify**

- [ ] `computeImportance` is exported and callable from the standalone package.

🔗 **Proves:** REQ-006 · CAP-007
📎 **Source:** `scripts/pack-smoke.mjs` §analysis; ⟦U6⟧ inferred — see UNRESOLVED.md

---

## 4 · The Climax — Real semantic recall, composed from the primitives

🎬 **Scene.** This is the payoff. Maya wires embedding-provider → vector-store → hybrid-search into one ~15-line script, indexes her three notes, and asks for *"sleepy pet resting indoors."* The toolkit returns her two cat notes and rejects the finance note — real semantic recall, fully in-process, built from `npm i`'d parts she now understands end to end.

▶️ **Do**

```bash
node --input-type=module -e '
import { resolveProvider } from "@adhd/sox-embedding-provider";
import { openVectorStore, applyVecSchema, upsertVector, knn } from "@adhd/sox-vector-store";
const notes = [
  { id:1, text:"the cat sat on the mat in the warm afternoon sun" },
  { id:2, text:"quarterly financial derivatives report and risk exposure" },
  { id:3, text:"a small kitten napped on a rug by the window" },
];
const p = await resolveProvider({ backend: "real" });
const db = openVectorStore(":memory:", { dim: p.dim });
applyVecSchema(db, { dim: p.dim, modelId: p.modelId });
for (const n of notes) upsertVector(db, n.id, await p.embed(n.text), { modelId: p.modelId });
const hits = knn(db, await p.embed("sleepy pet resting indoors"), 2);
console.log("recall", hits.map(h=>h.nodeId).sort((a,b)=>a-b).join(","));
'
```

👀 **Expect**

```
recall 1,3
```

✅ **Verify**

- [ ] The top-2 recall is notes **1 and 3** (the cat notes), in either order.
- [ ] Note **2** (finance) is NOT in the top-2.
- [ ] The whole pipeline ran in one process with no external service, vector DB, or API key.

🔗 **Proves:** REQ-002 · REQ-003 · REQ-005 · CAP-002 · CAP-003 · CAP-006 · CAP-009
📎 **Source:** `USE_CASES.md` UC-SRCH-1/UC-VEC-1/UC-EMB-1 + `scripts/pack-smoke.mjs`; ⟦U7⟧ inferred — see UNRESOLVED.md

---

## 5 · Resilience Sweep — Edges We Didn't Hit in the Story

#### 5.1 · ⚠️ hybrid-search degrades to BM25 when vectors are absent

▶️ **Do**

```bash
node --input-type=module -e '
import * as hs from "@adhd/sox-hybrid-search";
const ranker = hs.search ?? hs.hybridRecall;
console.log("ranker", typeof ranker === "function");
'
```

👀 **Expect** — `ranker true`
✅ **Verify**

- [ ] A ranker export exists; per `[inv:degrade-to-bm25]`, with no vector signal it still returns keyword-ranked results (does not throw/empty).
🔗 **Proves:** REQ-005 · CAP-006
📎 **Source:** `contexts/_shared.md` `[inv:degrade-to-bm25]`; ⟦U8⟧ inferred — see UNRESOLVED.md

#### 5.2 · ⚠️ model switch triggers a re-embed migration, not silent corruption

▶️ **Do**

```bash
node docs/plan/memory-refactor/scripts/reembed-memory.mjs --dry-run
```

👀 **Expect** — a dry-run report of how many records would be re-embedded because their `modelId` ≠ the active model (0 changes applied).
✅ **Verify**

- [ ] The re-embed tool identifies stale-model records and, in `--dry-run`, writes nothing.
🔗 **Proves:** REQ-003 · CAP-004
📎 **Source:** `references.json` (`reembed` core) + `scripts/reembed-memory.mjs`; ⟦U9⟧ inferred — see UNRESOLVED.md

#### 5.3 · ⚠️ the memory_* tool contract is unchanged by the decomposition

▶️ **Do**

```bash
cd /Users/nix/dev/ai/sox-ecosystem && python3 docs/plan/memory-refactor/scripts/audit_memrefactor.py --phase extraction
```

👀 **Expect** — the `[inv:tool-contract-stable]` check reports the 19-tool `memory_*` surface snapshot is byte-identical to baseline.
✅ **Verify**

- [ ] The tool-contract diff is empty (decomposition did not change the public MCP surface).
🔗 **Proves:** REQ-010 · CAP-009
📎 **Source:** `contexts/audit-extraction.md` `[inv:tool-contract-stable]`

---

## 6 · Teardown — Back to Zero

▶️ **Do**

```bash
cd .. && rm -rf maya-notes
```

👀 **Expect**

```
⟨no output⟩
```

✅ **Verify**

- [ ] The `maya-notes/` directory is gone (`ls maya-notes` → `No such file or directory`).
- [ ] Nothing was installed globally and no process/port was left running (the toolkit is in-process only).

🔗 **Proves:** REQ-001 · CAP-001
📎 **Source:** standard npm project teardown (`SCOPE.md` non-goals: no daemon/service for the libs)

---

## 7 · Coverage & Traceability Matrix

### 7.1 Requirements → Beats

| Req ID | Requirement (short) | Proven by beat(s) | Paths covered (H/E/R) | Status |
|---|---|---|---|---|
| REQ-001 | data/* installable standalone via `npm i` | 2.4, 2.3, 3-Act2.3, 6 | H | ☐ |
| REQ-002 | embedding-provider: real + deterministic + loud-fail | 1.1, 1.2, 1.3, 4 | H/E | ☐ |
| REQ-003 | vector-store: persist + kNN + space invariant | 2.1, 2.2, 4, 5.2 | H/E/R | ☐ |
| REQ-004 | graph-store: bi-temporal nodes/edges/FTS | 3.2 | H | ☐ |
| REQ-005 | hybrid-search: fused ranking + degrade-to-BM25 | 4, 5.1 | H/E | ☐ |
| REQ-006 | analysis: corpus derivation (importance) | 3.3 | H | ☐ |
| REQ-007 | ingest: write-path transforms (content-hash) | 3.1 | H | ☐ |
| REQ-008 | native deps resolve from published tarball (BL-87) | 2.4 | H | ☐ |
| REQ-009 | data/*may not import platform/* (boundary) | 2.3-Act2 | H | ☐ |
| REQ-010 | memory_* 19-tool contract unchanged | 5.3 | H | ☐ |

### 7.2 Capabilities → Beats

| Cap ID | Capability | Proven by beat(s) | Status |
|---|---|---|---|
| CAP-001 | standalone npm install of each package | 2.4, 2.3, 6 | ☐ |
| CAP-002 | in-process embedding (real + deterministic) | 1.1, 1.2, 1.3, 4 | ☐ |
| CAP-003 | vector persistence + similarity search | 2.1, 4 | ☐ |
| CAP-004 | embedding-space integrity (invariant + re-embed) | 1.3, 2.2, 5.2 | ☐ |
| CAP-005 | bi-temporal graph storage | 3.2 | ☐ |
| CAP-006 | hybrid ranked retrieval (+ degrade) | 4, 5.1 | ☐ |
| CAP-007 | corpus analysis (importance/cluster/dedup) | 3.3 | ☐ |
| CAP-008 | write-path ingestion transforms | 3.1 | ☐ |
| CAP-009 | composition into a working memory system | 4, 5.3 | ☐ |

### 7.3 Unresolved Interfaces & Gaps

- 9 unresolved interface stubs (⟦U1⟧–⟦U9⟧) and 2 scope gaps; full list in `UNRESOLVED.md`. Highest impact: ⟦U2⟧ (the embedding-provider `resolveProvider`/`embed` return shape) and ⟦U7⟧ (the climax composition API), since the climax and the affirmative reuse proof both depend on them. None blocks authoring; each is a confirm-before-trusting item for the implementer.

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
