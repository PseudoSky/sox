# 🎬 @adhd/sox-vector-store — Live Demo & Acceptance Script

> Sub-millisecond semantic search in a single SQLite file — no vector DB to run, no embedding API bill, no infrastructure to operate.

**What this is.** A presentation-grade walkthrough of `@adhd/sox-vector-store` that doubles as its acceptance test. Follow it top to bottom and you will (a) experience the package exactly as a 3rd-party developer would — from `npm install` to running kNN — and (b) prove every capability works, with exact commands, exact data, and pass/fail checks. It is the contract for what "done" means for the vector-store package: if it's demonstrated here, it must work; if it must work, it's demonstrated here.

---

## 0 · How to Read This Script

**Legend**

| Marker | Meaning |
|---|---|
| 🎬 **Scene** | The story beat — what's happening and why the persona cares. Read this aloud in a demo. |
| ▶️ **Do** | The exact action with literal input data. Copy-paste runnable verbatim. |
| 👀 **Expect** | The exact observable result. Volatile parts shown as ⟨…⟩. |
| ✅ **Verify** | Binary pass/fail assertions. Tick each only if literally true. |
| 🔗 **Proves** | Requirement and capability IDs this beat satisfies. |
| 📎 **Source** | What grounds this step — spec section, file, or URL. |
| ⟦U#⟧ | An **unresolved stub**: a value guessed because the context didn't specify it. Logged in `UNRESOLVED.md` beside this file. |
| ⚠️ **Edge** / 🛟 **Recovery** | A deliberately adversarial or failure-then-recover beat. |

**Conventions**
- All commands run from a fresh `note-search/` working directory created in §2.4.
- Node.js 20+ required. Use `node --input-type=module -e '…'` for inline ESM snippets.
- Fixture vectors are orthogonal unit-vectors: results are deterministic regardless of sqlite-vec build.
- Values shown as ⟨like-this⟩ vary per run; the assertion next to them states the stable invariant.
- `⟦U#⟧` markers appear only on `📎 Source` lines — never inside runnable code. See `UNRESOLVED.md` for each guess.
- `applyVecSchema` is assumed idempotent (CREATE IF NOT EXISTS semantics) — safe to call on an existing store. See UNRESOLVED.md scope gap.

---

## 1 · Cold Open — The Hook

🎬 **Scene.** Alex is building a note-taking desktop app. Her users want "find notes similar to this one" — semantic search, not keyword search. Every solution she's found requires running Postgres with `pgvector`, a hosted vector DB, or an embedding API she'll pay per query. She reads a one-liner: *`@adhd/sox-vector-store` — one SQLite file, brute-force kNN under 1 ms at 50K rows, no server.* She runs `npm install`.

> **The promise we'll prove in the next 20 minutes:** Install one package, open one file, insert your own vectors, and get ranked nearest-neighbor results — with a hard guarantee that mixing embedding models in one store is impossible.

🔗 **Proves (framing):** REQ-004, REQ-007 · CAP-001
📎 **Source:** SCOPE.md Part A `vector-store` bullet; USE_CASES.md UC-VEC-1, UC-VEC-5; docs/decisions/0006-public-bundles-private-and-di-for-live-objects.md §Decision 1

---

## 2 · Cast, World & Cold-Start Setup

### 2.1 Meet Alex

Alex is a full-stack developer building a desktop note app in Node.js. Her immediate goal: add semantic search without adding infrastructure — no separate process, no cloud account, no schema migration tooling. She has a directory of notes she wants to embed and query. She needs to store those vectors alongside her app's existing SQLite database and query nearest neighbors for any input. She also needs to know her search will stay accurate if she ever switches embedding models.

### 2.2 The Canonical Demo Dataset

```
Working directory: note-search/

Store A — ./notes.db
  dim: 384     modelId: bge-small-en-v1.5

  nodeId 1: "Finish quarterly report"
    vec: Float32Array(384) — 1.0 at index 0, 0.0 everywhere else

  nodeId 2: "Make vegetable curry"
    vec: Float32Array(384) — 1.0 at index 1, 0.0 everywhere else

  Query: "Work deadline approaching"
    vec: Float32Array(384) — 0.9 at index 0, 0.1 at index 1, 0.0 everywhere else
    cosine nearest: nodeId 1  (dim-0 component dominates)

Store B — ./notes-1024.db   (Climax §4 only)
  dim: 1024    modelId: e5-large-v2

  nodeId 3: "Budget forecast spreadsheet"
    vec: Float32Array(1024) — 1.0 at index 0, 0.0 everywhere else

  nodeId 4: "Baking sourdough bread"
    vec: Float32Array(1024) — 1.0 at index 1, 0.0 everywhere else

  Query: "Annual financial planning"
    vec: Float32Array(1024) — 0.9 at index 0, 0.1 at index 1, 0.0 everywhere else
    cosine nearest: nodeId 3
```

### 2.3 Prerequisites

- Node.js 20 or later (`node --version` → `v20.x` or higher)
- npm 9 or later (`npm --version`)
- A writable working directory (the script creates `note-search/`)

### 2.4 Cold Start — From Nothing to Running

🎬 **Scene.** Alex creates a fresh project outside any monorepo, installs the package, and verifies the import loads — proving standalone installability with zero `@adhd` workspace dependencies.

▶️ **Do**
```bash
mkdir note-search && cd note-search
npm init -y
npm install @adhd/sox-vector-store
node --input-type=module -e '
  import { openVectorStore } from "@adhd/sox-vector-store";
  const db = openVectorStore(":memory:", { dim: 4 });
  console.log("import ok, db type:", typeof db.prepare);
'
```

👀 **Expect**
```
import ok, db type: function
```

✅ **Verify**
- [ ] `npm install` completes without error — `better-sqlite3` and `sqlite-vec` native addons resolve from the tarball (BL-87 guard)
- [ ] `import ok, db type: function` — the `better-sqlite3` Database handle is accessible; native deps loaded from the package, not from a workspace
- [ ] `ls node_modules | grep @adhd` returns nothing — zero monorepo runtime deps in the install

🔗 **Proves:** REQ-004, REQ-007 · CAP-001
📎 **Source:** pack-smoke.mjs §vector-store smoke block (the ground-truth install + import exercise); USE_CASES.md UC-VEC-1, UC-VEC-5; ADR-0006 §Decision 2

---

## 3 · The Journey

### Act 1 — Initialize the Embedding Space

Alex opens her note database and declares the embedding space: 384 dimensions, model `bge-small-en-v1.5`. From this moment, every vector written to this store is bound to that space.

#### 3.1.1 · Open and Schema a 384-Dim Store   (happy)

🎬 **Scene.** Alex's embedding model produces 384-dimensional vectors. She opens the SQLite file and applies the vec schema. She deliberately chooses dim=384 to prove the package does not silently override it with a hardcoded 768.

▶️ **Do**
```bash
node --input-type=module -e '
  import { openVectorStore, applyVecSchema } from "@adhd/sox-vector-store";
  const db = openVectorStore("./notes.db", { dim: 384 });
  applyVecSchema(db, { dim: 384, modelId: "bge-small-en-v1.5" });
  console.log("store ready: dim=384 modelId=bge-small-en-v1.5");
'
```

👀 **Expect**
```
store ready: dim=384 modelId=bge-small-en-v1.5
```

✅ **Verify**
- [ ] Exit code 0, message printed
- [ ] `ls notes.db` succeeds — the SQLite file was created in `note-search/`
- [ ] No error about an unsupported dim — 384 is accepted (not hardcoded-768-only)

🔗 **Proves:** REQ-006, REQ-007 · CAP-001, CAP-002
📎 **Source:** pack-smoke.mjs §vector-store `openVectorStore` + `applyVecSchema` calls; SCOPE.md Part D "dim parameterization is now MANDATORY… the legacy hard-coded vec0 FLOAT[768] MUST be derived from the active provider's dim"

### Act 2 — Persist and Retrieve

With a live space, Alex loads two notes as vectors and runs her first semantic query.

#### 3.2.1 · Upsert Two Note Vectors   (happy)

🎬 **Scene.** Alex has two notes. She converts them to embeddings (unit-vector stand-ins here) and stores them in the open space.

▶️ **Do**
```bash
node --input-type=module -e '
  import { openVectorStore, applyVecSchema, upsertVector } from "@adhd/sox-vector-store";
  const db = openVectorStore("./notes.db", { dim: 384 });
  applyVecSchema(db, { dim: 384, modelId: "bge-small-en-v1.5" });

  const vec1 = new Float32Array(384); vec1[0] = 1.0;  // "Finish quarterly report"
  const vec2 = new Float32Array(384); vec2[1] = 1.0;  // "Make vegetable curry"

  upsertVector(db, 1, vec1, { modelId: "bge-small-en-v1.5" });
  upsertVector(db, 2, vec2, { modelId: "bge-small-en-v1.5" });
  console.log("upserted 2 note vectors");
'
```

👀 **Expect**
```
upserted 2 note vectors
```

✅ **Verify**
- [ ] Exit code 0 — both upserts accepted matching dim (384) and modelId

🔗 **Proves:** REQ-006 · CAP-003
📎 **Source:** pack-smoke.mjs §vector-store `upsertVector` calls

#### 3.2.2 · kNN Round-Trip — Find the Nearest Note   (happy)

🎬 **Scene.** A user types "Work deadline approaching." The app embeds the query (0.9 in dim-0, 0.1 in dim-1) and calls `knn`. The cosine geometry is deterministic: nodeId 1 must rank first.

▶️ **Do**
```bash
node --input-type=module -e '
  import { openVectorStore, applyVecSchema, upsertVector, knn } from "@adhd/sox-vector-store";
  const db = openVectorStore("./notes.db", { dim: 384 });
  applyVecSchema(db, { dim: 384, modelId: "bge-small-en-v1.5" });

  const vec1 = new Float32Array(384); vec1[0] = 1.0;
  const vec2 = new Float32Array(384); vec2[1] = 1.0;
  upsertVector(db, 1, vec1, { modelId: "bge-small-en-v1.5" });
  upsertVector(db, 2, vec2, { modelId: "bge-small-en-v1.5" });

  const query = new Float32Array(384); query[0] = 0.9; query[1] = 0.1;
  const hits = knn(db, query, 1);

  console.log("top hit nodeId:", hits[0].nodeId);
  if (hits[0].nodeId !== 1) throw new Error("wrong top hit: " + hits[0].nodeId);
  console.log("PASS: nearest note is nodeId=1 (Finish quarterly report)");
'
```

👀 **Expect**
```
top hit nodeId: 1
PASS: nearest note is nodeId=1 (Finish quarterly report)
```

✅ **Verify**
- [ ] `top hit nodeId: 1` — cosine similarity correctly ranks the closer vector first
- [ ] `hits` has exactly 1 element (k=1 respected)
- [ ] Exit code 0

🔗 **Proves:** REQ-005, REQ-007 · CAP-003, CAP-004
📎 **Source:** pack-smoke.mjs §vector-store knn round-trip + `hits[0].nodeId !== 1` guard; USE_CASES.md UC-VEC-1; ⟦U1⟧ — knn result fields beyond `nodeId` (distance, score) inferred — see UNRESOLVED.md

### Act 3 — The Invariant Guard

Alex heard that mixing embedding models in one store is a leading cause of silent search quality degradation. She verifies the store refuses to let it happen before she ships.

#### 3.3.1 · ⚠️ Wrong-Dim Vector Rejected — Space Invariant Enforced   (edge)

🎬 **Scene.** A future colleague accidentally passes a 768-dim vector from a different model into this 384-dim store. Without the invariant, it corrupts the space silently. Alex verifies two things: the store throws immediately, and the failed insert wrote nothing.

▶️ **Do**
```bash
node --input-type=module -e '
  import { openVectorStore, applyVecSchema, upsertVector, knn } from "@adhd/sox-vector-store";
  const db = openVectorStore("./notes.db", { dim: 384 });
  applyVecSchema(db, { dim: 384, modelId: "bge-small-en-v1.5" });

  const vec1 = new Float32Array(384); vec1[0] = 1.0;
  const vec2 = new Float32Array(384); vec2[1] = 1.0;
  upsertVector(db, 1, vec1, { modelId: "bge-small-en-v1.5" });
  upsertVector(db, 2, vec2, { modelId: "bge-small-en-v1.5" });

  const wrongVec = new Float32Array(768); wrongVec[0] = 1.0;
  let threw = false;
  try {
    upsertVector(db, 3, wrongVec, { modelId: "bge-small-en-v1.5" });
  } catch {
    threw = true;
  }

  // prove row NOT written: knn with k=100 should return exactly 2 hits
  const probe = new Float32Array(384); probe[0] = 0.5;
  const allHits = knn(db, probe, 100);

  console.log("threw on wrong dim:", threw);
  console.log("row count after failed insert:", allHits.length);
  if (!threw) throw new Error("space invariant not enforced — no throw on dim mismatch");
  if (allHits.length !== 2) throw new Error("row was written despite throw: found " + allHits.length);
  console.log("PASS: space invariant enforced, row not written");
'
```

👀 **Expect**
```
threw on wrong dim: true
row count after failed insert: 2
PASS: space invariant enforced, row not written
```

✅ **Verify**
- [ ] `threw on wrong dim: true` — store threw on dim mismatch (768 ≠ 384)
- [ ] `row count after failed insert: 2` — no partial write; the failed upsert is atomic
- [ ] Exit code 0

🔗 **Proves:** REQ-001 · CAP-005
📎 **Source:** SCOPE.md Part A "enforces the space invariant (rejects a vector whose dim/modelId ≠ the column's)"; USE_CASES.md UC-VEC-2; ⟦U3⟧ — exact error message/type on invariant violation inferred — see UNRESOLVED.md

### Act 4 — Provenance Audit

Alex's note app has been running for months. A better embedding model ships. She needs to find which notes were embedded under the old model so she can queue them for re-embedding — the BL-88 provenance pattern.

#### 3.4.1 · Query Records by ModelId Provenance   (happy)

🎬 **Scene.** Alex queries the store's provenance index to see how many notes live under `bge-small-en-v1.5`. In production this query drives the re-embed migration: any note under a stale modelId gets queued.

▶️ **Do**
```bash
node --input-type=module -e '
  import { openVectorStore, applyVecSchema, upsertVector } from "@adhd/sox-vector-store";
  const db = openVectorStore("./notes.db", { dim: 384 });
  applyVecSchema(db, { dim: 384, modelId: "bge-small-en-v1.5" });

  const vec1 = new Float32Array(384); vec1[0] = 1.0;
  const vec2 = new Float32Array(384); vec2[1] = 1.0;
  upsertVector(db, 1, vec1, { modelId: "bge-small-en-v1.5" });
  upsertVector(db, 2, vec2, { modelId: "bge-small-en-v1.5" });

  const audit = db.prepare(
    "SELECT model_id, count(*) as count FROM vec_items GROUP BY model_id"
  ).all();
  console.log("provenance audit:", JSON.stringify(audit));
  if (audit[0].model_id !== "bge-small-en-v1.5") throw new Error("wrong modelId in audit: " + audit[0].model_id);
  if (audit[0].count !== 2) throw new Error("wrong count: " + audit[0].count);
  console.log("PASS: 2 records under bge-small-en-v1.5, queryable for re-embed targeting");
'
```

👀 **Expect**
```
provenance audit: [{"model_id":"bge-small-en-v1.5","count":2}]
PASS: 2 records under bge-small-en-v1.5, queryable for re-embed targeting
```

✅ **Verify**
- [ ] `model_id` is `bge-small-en-v1.5` — per-record modelId is persisted in the store
- [ ] `count` is `2` — both notes are accounted for under the correct model
- [ ] Exit code 0

🔗 **Proves:** REQ-002 · CAP-006
📎 **Source:** SCOPE.md Part A "Owns per-record modelId (→ BL-88 provenance)"; USE_CASES.md UC-VEC-4; ⟦U2⟧ — raw SQL table name `vec_items` and column name `model_id` inferred from sqlite-vec convention — see UNRESOLVED.md

---

## 4 · The Climax — Two Models, Two Universes, One API

🎬 **Scene.** A power user asks Alex: "Can your app support `e5-large-v2` embeddings? They're better for technical content." Alex opens a second store — same API, dim=1024. She inserts two technical notes, runs a query, and gets the right answer. The 384-dim `notes.db` is untouched.

This is the payoff: `@adhd/sox-vector-store` is not a 768-dim wrapper. It is a fully parameterized embedding space. `notes.db` (dim=384, bge-small-en-v1.5) and `notes-1024.db` (dim=1024, e5-large-v2) are independent, isolated universes — vectors can never cross, models can never mix — and both deliver sub-millisecond kNN from a file you can `cp` like any other document.

▶️ **Do**
```bash
node --input-type=module -e '
  import { openVectorStore, applyVecSchema, upsertVector, knn } from "@adhd/sox-vector-store";

  const db1024 = openVectorStore("./notes-1024.db", { dim: 1024 });
  applyVecSchema(db1024, { dim: 1024, modelId: "e5-large-v2" });

  const vec3 = new Float32Array(1024); vec3[0] = 1.0;  // "Budget forecast spreadsheet"
  const vec4 = new Float32Array(1024); vec4[1] = 1.0;  // "Baking sourdough bread"

  upsertVector(db1024, 3, vec3, { modelId: "e5-large-v2" });
  upsertVector(db1024, 4, vec4, { modelId: "e5-large-v2" });

  const query1024 = new Float32Array(1024); query1024[0] = 0.9; query1024[1] = 0.1;
  const hits = knn(db1024, query1024, 1);

  console.log("1024-dim top hit nodeId:", hits[0].nodeId);
  if (hits[0].nodeId !== 3) throw new Error("wrong hit: " + hits[0].nodeId);
  console.log("PASS: 1024-dim store correct, dim=1024 is NOT hardcoded");
  console.log("notes.db (dim=384) and notes-1024.db (dim=1024) coexist as isolated spaces");
'
```

👀 **Expect**
```
1024-dim top hit nodeId: 3
PASS: 1024-dim store correct, dim=1024 is NOT hardcoded
notes.db (dim=384) and notes-1024.db (dim=1024) coexist as isolated spaces
```

✅ **Verify**
- [ ] `1024-dim top hit nodeId: 3` — kNN is correct in a 1024-dim space
- [ ] `notes-1024.db` exists in `note-search/` alongside `notes.db`
- [ ] This beat + §3.1.1 together prove dim=384 AND dim=1024 both work — the FLOAT[768] hardcode is definitively gone
- [ ] Exit code 0

🔗 **Proves:** REQ-005, REQ-006, REQ-007 · CAP-001, CAP-002, CAP-003, CAP-004
📎 **Source:** SCOPE.md Part D "dim parameterization is now MANDATORY… with a 384 and a 1024 model in the suite, the legacy hard-coded vec0 FLOAT[768] MUST be derived from the active provider's dim"; USE_CASES.md UC-VEC-5; pack-smoke.mjs §vector-store

---

## 5 · Resilience Sweep — Edges We Didn't Hit in the Story

#### 5.1 · ⚠️ ModelId Mismatch — Correct Dim, Wrong Model

▶️ **Do**
```bash
node --input-type=module -e '
  import { openVectorStore, applyVecSchema, upsertVector } from "@adhd/sox-vector-store";
  const db = openVectorStore(":memory:", { dim: 384 });
  applyVecSchema(db, { dim: 384, modelId: "bge-small-en-v1.5" });

  const vec = new Float32Array(384); vec[0] = 1.0;
  let threw = false;
  try {
    upsertVector(db, 1, vec, { modelId: "e5-large-384" });
  } catch {
    threw = true;
  }
  console.log("threw on modelId mismatch:", threw);
  if (!threw) throw new Error("space invariant not enforced on modelId mismatch");
  console.log("PASS: modelId mismatch rejected even when dim matches");
'
```

👀 **Expect** — `threw on modelId mismatch: true` then `PASS: modelId mismatch rejected even when dim matches`
✅ **Verify**
- [ ] `threw on modelId mismatch: true` — modelId alone is sufficient to trigger the invariant

🔗 **Proves:** REQ-001 · CAP-005
📎 **Source:** SCOPE.md Part A "rejects a vector whose dim/modelId ≠ the column's" (both conditions enforced independently); ⟦U3⟧ — exact error type on modelId mismatch inferred — see UNRESOLVED.md

#### 5.2 · ⚠️ Upsert Before applyVecSchema

▶️ **Do**
```bash
node --input-type=module -e '
  import { openVectorStore, upsertVector } from "@adhd/sox-vector-store";
  const db = openVectorStore(":memory:", { dim: 4 });
  const vec = new Float32Array([1, 0, 0, 0]);
  let threw = false;
  try {
    upsertVector(db, 1, vec, { modelId: "test" });
  } catch {
    threw = true;
  }
  console.log("threw without schema:", threw);
  if (!threw) throw new Error("expected error writing to unschemaed store");
  console.log("PASS: upsert before schema correctly rejected");
'
```

👀 **Expect** — `threw without schema: true` then `PASS: upsert before schema correctly rejected`
✅ **Verify**
- [ ] `threw without schema: true` — writing to an unschemaed store fails fast

🔗 **Proves:** REQ-001 · CAP-005
📎 **Source:** pack-smoke.mjs schema-first pattern (applyVecSchema always precedes upsertVector); SCOPE.md Part A `vector-store` bullet

---

## 6 · Teardown — Back to Zero

▶️ **Do**
```bash
rm -f ./notes.db ./notes-1024.db
[ ! -f ./notes.db ] && [ ! -f ./notes-1024.db ] && echo "PASS: all store files removed, no residue"
```

👀 **Expect**
```
PASS: all store files removed, no residue
```

✅ **Verify**
- [ ] Neither `notes.db` nor `notes-1024.db` exists in `note-search/`
- [ ] No orphaned processes — `@adhd/sox-vector-store` is fully embedded; no server was started

🔗 **Proves:** REQ-007 · —
📎 **Source:** SCOPE.md Part A "Single SQLite file, no server required" — teardown is a single `rm`; USE_CASES.md UC-VEC-1 "no external vector DB"

---

## 7 · Coverage & Traceability Matrix

### 7.1 Requirements → Beats

| Req ID | Requirement (short) | Proven by beat(s) | Paths covered (H/E/R) | Status |
|---|---|---|---|---|
| REQ-001 | Space invariant: dim or modelId mismatch → throw, no row written | §3.3.1, §5.1, §5.2 | E/— | ☐ |
| REQ-002 | Per-record modelId provenance stored and queryable via db handle | §3.4.1 | H/— | ☐ |
| REQ-003 | Pluggable similarity backend seam (brute-force Phase 0; ANN deferred) | — | scope gap | ☐ |
| REQ-004 | Standalone installable, zero @adhd runtime deps, native deps declared | §2.4 | H/— | ☐ |
| REQ-005 | kNN cosine query returns ranked [{nodeId, …}] with at least nodeId | §3.2.2, §4 | H/— | ☐ |
| REQ-006 | dim parameterized: 384 and 1024 both work, not hardcoded to 768 | §3.1.1, §3.2.1, §4 | H/— | ☐ |
| REQ-007 | Single SQLite file, no external server, teardown is rm | §2.4, §3.1.1, §4, §6 | H/— | ☐ |

### 7.2 Capabilities → Beats

| Cap ID | Capability | Proven by beat(s) | Status |
|---|---|---|---|
| CAP-001 | `openVectorStore(path, {dim})` returns a Database handle | §2.4, §3.1.1, §4 | ☐ |
| CAP-002 | `applyVecSchema(db, {dim, modelId})` applies the vec schema | §3.1.1, §4 | ☐ |
| CAP-003 | `upsertVector(db, nodeId, Float32Array, {modelId})` stores the vector | §3.2.1, §3.2.2, §4 | ☐ |
| CAP-004 | `knn(db, Float32Array, k)` returns [{nodeId, …}] ranked by cosine | §3.2.2, §4 | ☐ |
| CAP-005 | Space-invariant enforcement: throw on dim or modelId mismatch | §3.3.1, §5.1, §5.2 | ☐ |
| CAP-006 | Per-record modelId queryable via raw SQL on the caller's db handle | §3.4.1 | ☐ |
| CAP-007 | Pluggable similarity backend (design seam, no exercised API) | — | ☐ |

### 7.3 Unresolved Interfaces & Gaps

3 interface stubs (⟦U1⟧–⟦U3⟧) and 3 scope gaps; full list in `UNRESOLVED.md`. Highest-impact: ⟦U2⟧ (provenance SQL table/column names — if wrong, §3.4.1 fails as written). REQ-003 / CAP-007 (pluggable similarity backend) is a design constraint only — no exercisable API in Phase 0; SCOPE.md Part D explicitly defers ANN. ⟦U1⟧ (knn result shape beyond nodeId) is advisory — the demo asserts only on `nodeId` which is grounded.

---

## 8 · Sign-Off

| Field | Value |
|---|---|
| Environment | ⟨OS / Node version / @adhd/sox-vector-store version / commit SHA⟩ |
| Run by | ⟨name or agent ID⟩ |
| Date | ⟨date⟩ |
| Beats passed | ⟨X of Y⟩ |
| Requirements proven | ⟨X of Y⟩ |
| Result | ☐ PASS &nbsp;&nbsp; ☐ FAIL |
| Notes / defects filed | ⟨…⟩ |

> A run is **PASS** only if every ✅ assertion is checked and every requirement in §7 is proven. One unchecked binary assertion = FAIL until resolved.
