# @adhd/sox-graph-store — Live Demo & Acceptance Script

> A bi-temporal, content-hash-deduplicating graph store on SQLite: install one package, get versioned nodes, typed edges, FTS search, and point-in-time auditability — no cloud, no server.

**What this is.** A presentation-grade walkthrough of `@adhd/sox-graph-store` that doubles as its acceptance test. Follow it top to bottom and you will (a) experience the package the way a brand-new third-party developer would and (b) prove every capability works, with exact commands, exact data, and pass/fail checks. It is the contract for what "done" means: if it is demonstrated here, it must work; if it must work, it is demonstrated here.

---

## 0 · How to Read This Script

**Legend**

| Marker | Meaning |
|---|---|
| 🎬 **Scene** | The story beat — what is happening and why the persona cares. Read this aloud in a demo. |
| ▶️ **Do** | The exact action to take (command or code snippet) with literal input data. |
| 👀 **Expect** | The exact observable result. Volatile parts (UIDs, timestamps) shown as ⟨…⟩. |
| ✅ **Verify** | Binary pass/fail assertions. Tick each only if it is literally true. |
| 🔗 **Proves** | Requirement and capability IDs this beat satisfies (traceability). |
| 📎 **Source** | What grounds this step — spec section, doc, file, or URL it came from. |
| ⟦U#⟧ | An **unresolved stub**: a value guessed because the context did not specify it. Logged in `UNRESOLVED.md` beside this file. |
| ⚠️ **Edge** / 🛟 **Recovery** | A deliberately adversarial or failure-then-recover beat. |

**Conventions**
- All commands run from a fresh working directory `/tmp/gs-demo` (created in §2.4).
- `node --input-type=module -e '...'` is the SDK invocation surface throughout.
- Values shown as ⟨like-this⟩ vary per run; the assertion next to them states what stays invariant.
- Tokens shown as ⟦U#⟧ are interfaces this script had to guess; each is listed in `UNRESOLVED.md` beside this file — confirm them before treating the step as authoritative.
- The demo DB is a file at `/tmp/gs-demo/catalog.db` so state accumulates across beats (each beat re-opens the same DB).

---

## 1 · Cold Open — The Hook

🎬 **Scene.** Alex is building a prompt-segment catalog for an LLM workflow engine. The catalog needs versioned segments, typed composition edges, content-hash dedup so re-ingestion never creates duplicates, FTS keyword search, and the ability to audit exactly what the catalog looked like at any past moment — without a cloud service, without an external DB server, and without adding fragile infrastructure. Alex finds `@adhd/sox-graph-store`: a single `npm i`, a caller-owned `better-sqlite3` connection, one schema-setup call, and the full bi-temporal graph substrate is live.

> **The promise we will prove in the next 25 minutes:** a 3rd-party developer can `npm i @adhd/sox-graph-store`, call `applyGraphSchema(db)` on their own SQLite connection, and immediately store versioned nodes with content-hash dedup, link them with typed edges, search them with FTS5, query any past state, and follow supersession chains — all in pure Node.js with zero cloud dependency.

🔗 **Proves (framing):** REQ-001 · CAP-001
📎 **Source:** `docs/plan/memory-refactor/USE_CASES.md` UC-GRA-1..5, SYS-1; `docs/decisions/0006-public-bundles-private-and-di-for-live-objects.md`

---

## 2 · Cast, World & Cold-Start Setup

### 2.1 Meet Alex

Alex is a senior developer at a small AI consultancy building a reusable prompt-engineering toolkit. The toolkit needs a durable catalog of prompt segments that can be versioned, linked, searched, and audited — and it must ship inside the client's on-premise environment with no outbound network. Alex needs a pure-SQLite solution with real graph semantics, and needs it working today.

### 2.2 The Canonical Demo Dataset

All beats in this script use the following prompt segments. They are fictional but realistic.

| ID (local name) | `name` field | `content` | `topic` |
|---|---|---|---|
| seg-v1 | `seg:reasoning-framework` | `Think step by step. Break the problem into sub-problems. Show your reasoning chain before stating the answer.` | `prompting` |
| seg-v2 | `seg:reasoning-framework-v2` | `Think step by step. Break the problem into sub-problems. Verify each step against the original goal. Show your reasoning chain before stating the answer.` | `prompting` |
| seg-fmt | `seg:format-json` | `Output your response as a valid JSON object matching the schema provided.` | `prompting` |

### 2.3 Prerequisites

- Node.js 20 or later (`node --version` prints `v20.x.x` or higher)
- npm 10 or later (`npm --version` prints `10.x.x` or higher)
- `@adhd/sox-graph-store` published to npm (or available as a local tarball via `npm pack`)
- Write access to `/tmp/`

### 2.4 Cold Start — From Nothing to Running

🎬 **Scene.** Alex creates a clean working directory, installs the package alongside its single peer dep (`better-sqlite3`), and verifies the schema bootstrap.

▶️ **Do**
```bash
mkdir -p /tmp/gs-demo
cd /tmp/gs-demo
npm init -y
npm install @adhd/sox-graph-store better-sqlite3
```

Then verify the install and bootstrap the DB schema:

```bash
node --input-type=module -e "
  import { applyGraphSchema } from '@adhd/sox-graph-store';
  import Database from 'better-sqlite3';
  const db = new Database('/tmp/gs-demo/catalog.db');
  applyGraphSchema(db);
  const r = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='node'\").get();
  console.log('node table:', r ? 'CREATED' : 'MISSING');
  const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all();
  console.log('all tables:', tables.map(t => t.name).join(', '));
  db.close();
"
```

👀 **Expect**
```
node table: CREATED
all tables: edge, fts_node, node, organizer_queue, promotion_queue
```

✅ **Verify**
- [ ] `npm install` exits 0 with no peer-dep warnings referencing any `@adhd/sox-*` package
- [ ] Output contains `node table: CREATED`
- [ ] `all tables:` line includes at least `node`, `edge`, `fts_node`

🔗 **Proves:** REQ-001 · REQ-002 · CAP-001 · CAP-002
📎 **Source:** `docs/plan/memory-refactor/scripts/pack-smoke.mjs` §graph-store (applyGraphSchema + node table creation); `docs/decisions/0006-public-bundles-private-and-di-for-live-objects.md` (no `@adhd` runtime deps); `docs/plan/memory-refactor/contexts/w2b-graph-store.md` acceptance [w2b.1][w2b.2] (exports + table set)

---

## 3 · The Journey

### Act 1 — Schema Bootstrap

Alex has the schema up. Before inserting anything, she wants to confirm two things: the schema is truly idempotent (safe to call on every startup), and she has TypeScript types in her editor.

#### 1.1 · Schema Is Idempotent (calling applyGraphSchema twice is safe)   ⚠️ (edge)

🎬 **Scene.** Alex's app calls `applyGraphSchema(db)` every time it opens the DB — a common "ensure schema is current" pattern. She verifies a second call does not throw, does not duplicate tables, and the node count stays at zero.

▶️ **Do**
```bash
node --input-type=module -e "
  import { applyGraphSchema } from '@adhd/sox-graph-store';
  import Database from 'better-sqlite3';
  const db = new Database('/tmp/gs-demo/catalog.db');
  applyGraphSchema(db);  // first call
  applyGraphSchema(db);  // second call — must be silent no-op
  const tables = db.prepare(\"SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='node'\").get();
  console.log('node table count:', tables.c);
  const rows = db.prepare('SELECT COUNT(*) as c FROM node').get();
  console.log('node row count:', rows.c);
  db.close();
"
```

👀 **Expect**
```
node table count: 1
node row count: 0
```

✅ **Verify**
- [ ] No exception thrown on the second `applyGraphSchema` call
- [ ] `node table count: 1` (not 2 — no duplicate table)
- [ ] `node row count: 0` (clean slate)

🔗 **Proves:** REQ-002 · CAP-002
📎 **Source:** `docs/plan/memory-refactor/contexts/w2b-graph-store.md` acceptance [w2b.2] (applyGraphSchema idempotent — second call is a no-op)

---

### Act 2 — Inserting Nodes & Content-Hash Deduplication

Alex begins populating the catalog with prompt segments.

#### 2.1 · Insert the First Segment   (happy)

🎬 **Scene.** Alex inserts the reasoning-framework segment for the first time. She gets back a UID and a content hash — the package's identity for this content.

▶️ **Do**
```bash
node --input-type=module -e "
  import { applyGraphSchema, insertNode } from '@adhd/sox-graph-store';
  import Database from 'better-sqlite3';
  const db = new Database('/tmp/gs-demo/catalog.db');
  applyGraphSchema(db);
  const seg1 = insertNode(db, {
    name: 'seg:reasoning-framework',
    content: 'Think step by step. Break the problem into sub-problems. Show your reasoning chain before stating the answer.',
    topic: 'prompting'
  });
  console.log('uid:', seg1.uid);
  console.log('contentHash:', seg1.contentHash);
  console.log('existed:', seg1.existed);
  db.close();
"
```

👀 **Expect**
```
uid: ⟨opaque-uid-string⟩
contentHash: ⟨64-char-hex-or-base64⟩
existed: false
```

✅ **Verify**
- [ ] `uid` is a non-empty string
- [ ] `contentHash` is a non-empty string
- [ ] `existed: false` (new insertion)

🔗 **Proves:** REQ-003 · CAP-003
📎 **Source:** ⟦U1⟧ inferred — see UNRESOLVED.md; `docs/plan/memory-refactor/contexts/w2b-graph-store.md` "content-hash insert" helper; `docs/plan/memory-refactor/USE_CASES.md` UC-GRA-2

#### 2.2 · Re-Insert Identical Content — No Duplicate Created   ⚠️ (edge)

🎬 **Scene.** An upstream pipeline re-ingests the same segment. Alex relies on content-hash dedup to guarantee the catalog stays clean — the same bytes must never create a second record.

▶️ **Do**
```bash
node --input-type=module -e "
  import { applyGraphSchema, insertNode } from '@adhd/sox-graph-store';
  import Database from 'better-sqlite3';
  const db = new Database('/tmp/gs-demo/catalog.db');
  applyGraphSchema(db);
  const dup = insertNode(db, {
    name: 'seg:reasoning-framework',
    content: 'Think step by step. Break the problem into sub-problems. Show your reasoning chain before stating the answer.',
    topic: 'prompting'
  });
  console.log('existed:', dup.existed);
  const count = db.prepare('SELECT COUNT(*) as c FROM node').get();
  console.log('node count after re-insert:', count.c);
  db.close();
"
```

👀 **Expect**
```
existed: true
node count after re-insert: 1
```

✅ **Verify**
- [ ] `existed: true` — the existing record was returned, not a new one created
- [ ] `node count after re-insert: 1` — exactly one row in the table

🔗 **Proves:** REQ-003 · CAP-003
📎 **Source:** ⟦U1⟧ inferred — see UNRESOLVED.md; `docs/plan/memory-refactor/USE_CASES.md` UC-GRA-2 ("re-ingesting the same content is a no-op, not a duplicate"); `docs/plan/memory-refactor/contexts/w2b-graph-store.md` [w2b.4]

#### 2.3 · Insert the Format Segment   (happy)

🎬 **Scene.** Alex adds a second segment so the catalog has material for edge and FTS tests.

▶️ **Do**
```bash
node --input-type=module -e "
  import { applyGraphSchema, insertNode } from '@adhd/sox-graph-store';
  import Database from 'better-sqlite3';
  const db = new Database('/tmp/gs-demo/catalog.db');
  applyGraphSchema(db);
  const segFmt = insertNode(db, {
    name: 'seg:format-json',
    content: 'Output your response as a valid JSON object matching the schema provided.',
    topic: 'prompting'
  });
  console.log('uid:', segFmt.uid);
  console.log('existed:', segFmt.existed);
  const count = db.prepare('SELECT COUNT(*) as c FROM node').get();
  console.log('total node count:', count.c);
  db.close();
"
```

👀 **Expect**
```
uid: ⟨opaque-uid-string⟩
existed: false
total node count: 2
```

✅ **Verify**
- [ ] `existed: false`
- [ ] `total node count: 2`

🔗 **Proves:** REQ-003 · CAP-003
📎 **Source:** ⟦U1⟧ inferred — see UNRESOLVED.md; `docs/plan/memory-refactor/contexts/w2b-graph-store.md` [w2b.1]

---

### Act 3 — Typed Edges & Neighbor Traversal

Alex wants to express that the reasoning-framework segment `REQUIRES` the format-json segment when composing a structured-output system prompt.

#### 3.1 · Add a REQUIRES Edge   (happy)

🎬 **Scene.** Alex links the two segments with a typed `REQUIRES` edge — the composition relationship that the prompt-catalog system (SYS-1) uses to assemble system prompts.

▶️ **Do**
```bash
node --input-type=module -e "
  import { applyGraphSchema, insertNode, addEdge } from '@adhd/sox-graph-store';
  import Database from 'better-sqlite3';
  const db = new Database('/tmp/gs-demo/catalog.db');
  applyGraphSchema(db);
  const seg1 = db.prepare(\"SELECT uid FROM node WHERE name='seg:reasoning-framework' AND t_invalid IS NULL\").get();
  const segFmt = db.prepare(\"SELECT uid FROM node WHERE name='seg:format-json' AND t_invalid IS NULL\").get();
  addEdge(db, { srcUid: seg1.uid, dstUid: segFmt.uid, rel: 'REQUIRES' });
  const edgeCount = db.prepare('SELECT COUNT(*) as c FROM edge').get();
  console.log('edge count:', edgeCount.c);
  db.close();
"
```

👀 **Expect**
```
edge count: 1
```

✅ **Verify**
- [ ] `edge count: 1` — the edge row was created

🔗 **Proves:** REQ-006 · CAP-005
📎 **Source:** ⟦U3⟧ inferred — see UNRESOLVED.md; `docs/plan/memory-refactor/USE_CASES.md` UC-GRA-3 ("typed edges RELATES_TO/SUPERSEDES/DERIVED_FROM + neighbor traversal"); `docs/plan/memory-refactor/contexts/w2b-graph-store.md` "supersession edges" helper

#### 3.2 · Traverse Neighbors   (happy)

🎬 **Scene.** Alex's catalog engine needs to fetch all segments that `seg:reasoning-framework` requires before composing a system prompt.

▶️ **Do**
```bash
node --input-type=module -e "
  import { applyGraphSchema, getNeighbors } from '@adhd/sox-graph-store';
  import Database from 'better-sqlite3';
  const db = new Database('/tmp/gs-demo/catalog.db');
  applyGraphSchema(db);
  const seg1 = db.prepare(\"SELECT uid FROM node WHERE name='seg:reasoning-framework' AND t_invalid IS NULL\").get();
  const neighbors = getNeighbors(db, seg1.uid, { rel: 'REQUIRES' });
  console.log('neighbor count:', neighbors.length);
  console.log('neighbor name:', neighbors[0]?.name);
  db.close();
"
```

👀 **Expect**
```
neighbor count: 1
neighbor name: seg:format-json
```

✅ **Verify**
- [ ] `neighbor count: 1`
- [ ] `neighbor name: seg:format-json`

🔗 **Proves:** REQ-006 · CAP-005
📎 **Source:** ⟦U5⟧ inferred — see UNRESOLVED.md; `docs/plan/memory-refactor/USE_CASES.md` UC-GRA-3

---

### Act 4 — Bi-Temporal Invalidation & Point-in-Time Query

Alex discovers the v1 reasoning-framework segment is incomplete. She will supersede it — but the old version must remain auditable.

#### 4.1 · Confirm the Node Is Currently Live   (happy)

🎬 **Scene.** Before invalidating anything, Alex checks that the current node has `t_invalid IS NULL` — it is live.

▶️ **Do**
```bash
node --input-type=module -e "
  import { applyGraphSchema } from '@adhd/sox-graph-store';
  import Database from 'better-sqlite3';
  const db = new Database('/tmp/gs-demo/catalog.db');
  applyGraphSchema(db);
  const seg1 = db.prepare(\"SELECT uid, name, t_invalid FROM node WHERE name='seg:reasoning-framework'\").get();
  console.log('name:', seg1.name);
  console.log('t_invalid:', seg1.t_invalid);
  db.close();
"
```

👀 **Expect**
```
name: seg:reasoning-framework
t_invalid: null
```

✅ **Verify**
- [ ] `t_invalid: null` — the record is live

🔗 **Proves:** REQ-004 · CAP-004
📎 **Source:** `docs/plan/memory-refactor/USE_CASES.md` UC-GRA-1 ("bi-temporal validity via t_valid/t_invalid"); `docs/plan/memory-refactor/contexts/w2b-graph-store.md` acceptance [w2b.4]

#### 4.2 · Invalidate v1 — Row Is Preserved, Not Deleted   ⚠️ (edge)

🎬 **Scene.** Alex invalidates the v1 segment. The bi-temporal model guarantees the row survives — `t_invalid` is stamped, no DELETE is issued.

▶️ **Do**
```bash
node --input-type=module -e "
  import { applyGraphSchema, invalidateNode } from '@adhd/sox-graph-store';
  import Database from 'better-sqlite3';
  const db = new Database('/tmp/gs-demo/catalog.db');
  applyGraphSchema(db);
  const seg1 = db.prepare(\"SELECT uid FROM node WHERE name='seg:reasoning-framework'\").get();
  invalidateNode(db, seg1.uid);
  const after = db.prepare(\"SELECT uid, t_invalid FROM node WHERE uid=?\").get(seg1.uid);
  console.log('row still exists:', after !== undefined);
  console.log('t_invalid set:', after.t_invalid !== null);
  const totalCount = db.prepare('SELECT COUNT(*) as c FROM node').get();
  console.log('total node count (unchanged):', totalCount.c);
  db.close();
"
```

👀 **Expect**
```
row still exists: true
t_invalid set: true
total node count (unchanged): 2
```

✅ **Verify**
- [ ] `row still exists: true` — no DELETE was issued
- [ ] `t_invalid set: true` — the timestamp is non-null
- [ ] `total node count (unchanged): 2` — row count did not decrease

🔗 **Proves:** REQ-004 · CAP-004
📎 **Source:** ⟦U2⟧ inferred — see UNRESOLVED.md; `docs/plan/memory-refactor/contexts/w2b-graph-store.md` "invalidate-sets-t_invalid" helper + acceptance [w2b.4] ("sets t_invalid, never DELETE")

#### 4.3 · Point-in-Time Query Excludes Invalidated Records   🛟 (recovery)

🎬 **Scene.** Alex's current-catalog query must only return live records. She queries "current" nodes — those with `t_invalid IS NULL` — and confirms v1 is gone from the live view while the audit record remains.

▶️ **Do**
```bash
node --input-type=module -e "
  import { applyGraphSchema, queryAt } from '@adhd/sox-graph-store';
  import Database from 'better-sqlite3';
  const db = new Database('/tmp/gs-demo/catalog.db');
  applyGraphSchema(db);
  const current = queryAt(db, { includingInvalidated: false });
  console.log('live node count:', current.length);
  console.log('live names:', current.map(n => n.name).join(', '));
  const audit = queryAt(db, { includingInvalidated: true });
  console.log('all node count (with invalidated):', audit.length);
  db.close();
"
```

👀 **Expect**
```
live node count: 1
live names: seg:format-json
current.length and audit checks show the invalidated v1 is hidden from live view but preserved
all node count (with invalidated): 2
```

✅ **Verify**
- [ ] `live node count: 1` — invalidated v1 is excluded
- [ ] `live names:` does not include `seg:reasoning-framework`
- [ ] `all node count (with invalidated): 2` — audit record still present

🔗 **Proves:** REQ-004 · REQ-005 · CAP-004
📎 **Source:** ⟦U6⟧ inferred — see UNRESOLVED.md; `docs/plan/memory-refactor/USE_CASES.md` UC-GRA-1 ("queries point-in-time state; nothing is ever deleted")

---

### Act 5 — Automatic FTS5 Sync

Alex's catalog UI needs full-text search over segment content. She verifies that inserting a node automatically populates FTS5 — no manual index maintenance.

#### 5.1 · FTS5 Search Returns Live Nodes   (happy)

🎬 **Scene.** Alex searches for "reasoning" to find relevant prompt segments.

▶️ **Do**
```bash
node --input-type=module -e "
  import { applyGraphSchema, ftsSearch } from '@adhd/sox-graph-store';
  import Database from 'better-sqlite3';
  const db = new Database('/tmp/gs-demo/catalog.db');
  applyGraphSchema(db);
  const hits = ftsSearch(db, 'reasoning');
  console.log('hit count:', hits.length);
  hits.forEach(h => console.log('hit:', h.name, '| rank:', h.rank));
  db.close();
"
```

👀 **Expect**
```
hit count: 1
hit: seg:reasoning-framework | rank: ⟨negative-float⟩
```

(The `seg:reasoning-framework` node is still in `fts_node` even after invalidation — FTS tracks insertions; filtering by `t_invalid` is the application's concern. The hit count is 1 because only one segment's content matches "reasoning".)

✅ **Verify**
- [ ] `hit count: 1`
- [ ] Hit name is `seg:reasoning-framework`
- [ ] `rank` is a numeric value (FTS5 BM25 rank)

🔗 **Proves:** REQ-007 · CAP-006
📎 **Source:** ⟦U7⟧ inferred — see UNRESOLVED.md; `docs/plan/memory-refactor/USE_CASES.md` UC-GRA-4 ("FTS5 keyword search kept automatically in lockstep via sync triggers"); `docs/plan/memory-refactor/contexts/w2b-graph-store.md` acceptance [w2b.3]

#### 5.2 · FTS Stays in Sync After a New Insert   (happy)

🎬 **Scene.** Alex inserts the v2 segment and immediately searches. The FTS trigger keeps the index current — no manual `REBUILD` call needed.

▶️ **Do**
```bash
node --input-type=module -e "
  import { applyGraphSchema, insertNode, ftsSearch } from '@adhd/sox-graph-store';
  import Database from 'better-sqlite3';
  const db = new Database('/tmp/gs-demo/catalog.db');
  applyGraphSchema(db);
  insertNode(db, {
    name: 'seg:reasoning-framework-v2',
    content: 'Think step by step. Break the problem into sub-problems. Verify each step against the original goal. Show your reasoning chain before stating the answer.',
    topic: 'prompting'
  });
  const hits = ftsSearch(db, 'reasoning');
  console.log('fts hit count after v2 insert:', hits.length);
  const hasV2 = hits.some(h => h.name === 'seg:reasoning-framework-v2');
  console.log('v2 in fts results:', hasV2);
  db.close();
"
```

👀 **Expect**
```
fts hit count after v2 insert: 2
v2 in fts results: true
```

✅ **Verify**
- [ ] `fts hit count after v2 insert: 2` — the trigger synced v2 immediately
- [ ] `v2 in fts results: true`

🔗 **Proves:** REQ-007 · CAP-006
📎 **Source:** ⟦U7⟧ inferred — see UNRESOLVED.md; `docs/plan/memory-refactor/contexts/w2b-graph-store.md` acceptance [w2b.3] (FTS triggers: inserting a node populates fts_node)

---

## 4 · The Climax — Versioned Prompt-Segment Catalog with Supersession Chain

🎬 **Scene.** The whole demo has built toward this. Alex's catalog has seg-v1 (invalidated), seg-fmt (live), and seg-v2 (just inserted). Now she links v2 as the official supersession of v1 with a `SUPERSEDES` edge, queries the "current" catalog, and follows the chain from any version to its successor — the full proof that `@adhd/sox-graph-store` powers the SYS-1 prompt-segment catalog. A consumer of this catalog can always answer: "what is the latest version of segment X?", "what did version X supersede?", and "what was the catalog at timestamp T?" — from a single `npm i`.

▶️ **Do**
```bash
node --input-type=module -e "
  import { applyGraphSchema, insertNode, addEdge, supersessionChain, queryAt } from '@adhd/sox-graph-store';
  import Database from 'better-sqlite3';
  const db = new Database('/tmp/gs-demo/catalog.db');
  applyGraphSchema(db);

  // Retrieve both versions by name
  const v1 = db.prepare(\"SELECT uid FROM node WHERE name='seg:reasoning-framework'\").get();
  const v2 = db.prepare(\"SELECT uid FROM node WHERE name='seg:reasoning-framework-v2' AND t_invalid IS NULL\").get();

  // Link: v2 SUPERSEDES v1
  addEdge(db, { srcUid: v2.uid, dstUid: v1.uid, rel: 'SUPERSEDES' });

  // Query the live catalog (only non-invalidated nodes)
  const live = queryAt(db, { includingInvalidated: false });
  console.log('live catalog size:', live.length);
  console.log('live names:', live.map(n => n.name).sort().join(', '));

  // Follow the supersession chain from v1
  const chain = supersessionChain(db, v1.uid);
  console.log('chain length:', chain.length);
  chain.forEach((c, i) => console.log('chain[' + i + ']:', c.name, '| supersededBy:', c.supersededBy ?? 'none'));

  // Confirm v2 is the current version
  const current = live.find(n => n.name === 'seg:reasoning-framework-v2');
  console.log('current version:', current ? current.name : 'NOT FOUND');

  db.close();
"
```

👀 **Expect**
```
live catalog size: 2
live names: seg:format-json, seg:reasoning-framework-v2
chain length: 2
chain[0]: seg:reasoning-framework | supersededBy: ⟨uid-of-v2⟩
chain[1]: seg:reasoning-framework-v2 | supersededBy: none
current version: seg:reasoning-framework-v2
```

✅ **Verify**
- [ ] `live catalog size: 2` — invalidated v1 is excluded; v2 and seg-fmt are live
- [ ] `live names:` contains `seg:reasoning-framework-v2` and `seg:format-json`
- [ ] `live names:` does NOT contain `seg:reasoning-framework` (the invalidated v1)
- [ ] `chain length: 2` — both v1 and v2 appear in the supersession chain
- [ ] `chain[0]` is v1 with a non-null `supersededBy` pointing at v2's uid
- [ ] `chain[1]` is v2 with `supersededBy: none` — it is the current tip
- [ ] `current version: seg:reasoning-framework-v2`

🔗 **Proves:** REQ-004 · REQ-005 · REQ-006 · REQ-008 · CAP-004 · CAP-005 · CAP-007 · CAP-008
📎 **Source:** ⟦U3⟧ ⟦U6⟧ ⟦U8⟧ inferred — see UNRESOLVED.md; `docs/plan/memory-refactor/USE_CASES.md` UC-GRA-5 ("follow supersession chains") + SYS-1 ("versioned segments, REQUIRES/SUPERSEDES edges"); `docs/plan/memory-refactor/contexts/w2b-graph-store.md` "supersession edges"

---

## 5 · Resilience Sweep — Edges We Didn't Hit in the Story

#### 5.1 · ⚠️ applyGraphSchema with no tables yet — fresh DB bootstrap

▶️ **Do**
```bash
node --input-type=module -e "
  import { applyGraphSchema } from '@adhd/sox-graph-store';
  import Database from 'better-sqlite3';
  const db = new Database(':memory:');
  applyGraphSchema(db);
  const r = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='node'\").get();
  console.log('fresh DB bootstrap:', r ? 'OK' : 'FAIL');
  db.close();
"
```
👀 **Expect** — `fresh DB bootstrap: OK`
✅ **Verify**
- [ ] No exception; `fresh DB bootstrap: OK`

🔗 **Proves:** REQ-002 · CAP-002
📎 **Source:** `docs/plan/memory-refactor/scripts/pack-smoke.mjs` §graph-store (in-memory DB smoke)

#### 5.2 · ⚠️ Inserting a node with missing optional fields (topic omitted)

▶️ **Do**
```bash
node --input-type=module -e "
  import { applyGraphSchema, insertNode } from '@adhd/sox-graph-store';
  import Database from 'better-sqlite3';
  const db = new Database(':memory:');
  applyGraphSchema(db);
  const n = insertNode(db, { name: 'seg:minimal', content: 'Minimal segment.' });
  console.log('uid set:', n.uid !== undefined && n.uid !== '');
  console.log('existed:', n.existed);
  db.close();
"
```
👀 **Expect** — `uid set: true` and `existed: false`
✅ **Verify**
- [ ] No exception
- [ ] `uid set: true`
- [ ] `existed: false`

🔗 **Proves:** REQ-003 · CAP-003
📎 **Source:** ⟦U1⟧ inferred — see UNRESOLVED.md; `docs/plan/memory-refactor/contexts/w2b-graph-store.md` [w2b.1] (node/edge helpers exported)

#### 5.3 · ⚠️ Standalone install — no private @adhd deps in the tarball

▶️ **Do**
```bash
cd /tmp/gs-demo
node -e "
  const pkg = JSON.parse(require('fs').readFileSync('node_modules/@adhd/sox-graph-store/package.json','utf8'));
  const privateDeps = Object.keys(pkg.dependencies || {}).filter(d => d.startsWith('@adhd/'));
  console.log('private @adhd runtime deps:', privateDeps.length);
  if (privateDeps.length) console.error('VIOLATION:', privateDeps);
"
```
👀 **Expect** — `private @adhd runtime deps: 0`
✅ **Verify**
- [ ] `private @adhd runtime deps: 0` — ADR-0006 compliance confirmed

🔗 **Proves:** REQ-001 · CAP-001
📎 **Source:** `docs/decisions/0006-public-bundles-private-and-di-for-live-objects.md` §Consequences ("no @adhd/sox-* in runtime dependencies"); `docs/plan/memory-refactor/contexts/w2b-graph-store.md` Packaging note

#### 5.5 · ⚠️ Bundled TypeScript types ship in the tarball

▶️ **Do**
```bash
node --input-type=module -e "
  import { readFileSync, existsSync } from 'fs';
  import { join } from 'path';
  const pkgRoot = '/tmp/gs-demo/node_modules/@adhd/sox-graph-store';
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  const typesField = pkg.types || pkg.typings || 'dist/index.d.ts';
  console.log('types field:', typesField);
  console.log('types file exists:', existsSync(join(pkgRoot, typesField)));
"
```
👀 **Expect** — `types field: ⟨path ending in .d.ts⟩` and `types file exists: true`
✅ **Verify**
- [ ] `types file exists: true` — bundled `.d.ts` ships with the tarball (consumers get types without a separate `@types` install)

🔗 **Proves:** REQ-009 · CAP-001
📎 **Source:** `docs/decisions/0006-public-bundles-private-and-di-for-live-objects.md` §4 ("Public libs still ship types — a bundled public library must emit a bundled .d.ts"); `docs/plan/memory-refactor/contexts/w2b-graph-store.md` Packaging note ("ship a bundled .d.ts")

#### 5.4 · ⚠️ graph-store has no vec_node / vector-store imports in its dist

▶️ **Do**
```bash
node -e "
  const s = require('fs').readFileSync('/tmp/gs-demo/node_modules/@adhd/sox-graph-store/dist/index.js','utf8');
  const hasVec = /vec_node|sox-vector-store/.test(s);
  console.log('vector-store contamination:', hasVec ? 'VIOLATION' : 'CLEAN');
"
```
👀 **Expect** — `vector-store contamination: CLEAN`
✅ **Verify**
- [ ] `vector-store contamination: CLEAN`

🔗 **Proves:** REQ-001 · CAP-001
📎 **Source:** `docs/plan/memory-refactor/contexts/w2b-graph-store.md` acceptance [w2b.5] (exact check command)

---

## 6 · Teardown — Back to Zero

▶️ **Do**
```bash
rm -rf /tmp/gs-demo
```

Then confirm no residue:

```bash
node -e "
  const fs = require('fs');
  const exists = fs.existsSync('/tmp/gs-demo');
  console.log('demo dir removed:', !exists);
"
```

👀 **Expect**
```
demo dir removed: true
```

✅ **Verify**
- [ ] `/tmp/gs-demo` directory does not exist
- [ ] No `catalog.db` file remains

🔗 **Proves:** REQ-001 · CAP-001
📎 **Source:** `docs/plan/memory-refactor/SCOPE.md` Part A ("no cloud, caller-owned DB connection"); demo convention (in-memory and file-based SQLite, no daemon)

---

## 7 · Coverage & Traceability Matrix

### 7.1 Requirements → Beats

| Req ID | Requirement (short) | Proven by beat(s) | Paths covered (H/E/R) | Status |
|---|---|---|---|---|
| REQ-001 | Standalone install — only `better-sqlite3` peer; zero private `@adhd` runtime deps | §2.4, 5.3, 5.4, §6 | H, E | ☐ |
| REQ-002 | `applyGraphSchema(db)` bootstraps `node`/`edge`/`fts_node` tables idempotently | §2.4, 1.1, 5.1 | H, E | ☐ |
| REQ-003 | Content-hash dedup — identical content returns existing uid without new row | 2.1, 2.2, 2.3, 5.2 | H, E | ☐ |
| REQ-004 | Invalidation sets `t_invalid`; row is never deleted | 4.1, 4.2, 4.3, §4 | H, E, R | ☐ |
| REQ-005 | Point-in-time queries exclude records with `t_invalid` set before `asOf` | 4.3, §4 | E, R | ☐ |
| REQ-006 | Typed edges (`REQUIRES`/`SUPERSEDES`/`DERIVED_FROM`) + neighbor traversal | 3.1, 3.2, §4 | H | ☐ |
| REQ-007 | FTS5 stays in lockstep with node mutations via triggers | 5.1, 5.2 | H | ☐ |
| REQ-008 | Supersession chain is traversable (what superseded X; what X superseded) | §4 | H | ☐ |
| REQ-009 | Bundled `.d.ts` ships; consumer gets TypeScript types on import | 5.5 | H | ☐ |

### 7.2 Capabilities → Beats

| Cap ID | Capability | Proven by beat(s) | Status |
|---|---|---|---|
| CAP-001 | Standalone npm install (no private `@adhd` runtime deps) | §2.4, 5.3, 5.4, §6 | ☐ |
| CAP-002 | Schema bootstrap — idempotent `applyGraphSchema` | §2.4, 1.1, 5.1 | ☐ |
| CAP-003 | Content-hash deduplication on write | 2.1, 2.2, 2.3, 5.2 | ☐ |
| CAP-004 | Bi-temporal invalidation — `t_invalid` set; row preserved; point-in-time filtering | 4.1, 4.2, 4.3, §4 | ☐ |
| CAP-005 | Typed edge creation + neighbor traversal | 3.1, 3.2, §4 | ☐ |
| CAP-006 | Automatic FTS5 sync via triggers | 5.1, 5.2 | ☐ |
| CAP-007 | Supersession chain traversal | §4 | ☐ |
| CAP-008 | Versioned catalog composition (SYS-1 prompt catalog) | §4 | ☐ |

### 7.3 Unresolved Interfaces & Gaps

8 unresolved interface stubs (⟦U1⟧–⟦U8⟧) and 2 scope gaps; full list in `UNRESOLVED.md`. Highest impact: ⟦U1⟧ (`insertNode` signature — used in nearly every beat), ⟦U6⟧ (`queryAt` — used in the climax and Act 4), ⟦U8⟧ (`supersessionChain` — the climax payoff). Resolve all before treating their beats as authoritative.

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
